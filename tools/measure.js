'use strict';
/*
 * Medição de memória da Lâmina (reprodutível em Linux sob xvfb).
 *
 * Objetivo: medir, de forma honesta, o custo de memória do ciclo de vida das
 * <webview> (que é o grosso da RAM do app) e o efeito das otimizações de
 * "recolhido": destruir as webviews + limpar os caches das sessões + GC.
 *
 * Não depende de rede: as webviews apontam para uma página data: pesada, que
 * cria um processo renderer Chromium de verdade (igual a cada serviço real).
 *
 * Soma o VmRSS de TODA a árvore de processos do app (main + GPU + rede +
 * renderers) lendo /proc/<pid>/status. Números absolutos diferem da máquina
 * Windows do usuário; o que vale é a REDUÇÃO RELATIVA e o comportamento
 * (recolhido -> piso).
 *
 * Uso:
 *   xvfb-run -a ./node_modules/.bin/electron --no-sandbox tools/measure.js [N]
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');

const N = Math.max(1, Number(process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a)) || process.env.N || 4));
const PARTS = Array.from({ length: N }, (_, i) => `persist:measure${i}`);

// ---- leitura de RSS da árvore de processos --------------------------------
function readStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = s.indexOf(')');
    const ppid = Number(s.slice(rp + 2).trim().split(/\s+/)[1]); // 4º campo
    return { ppid };
  } catch {
    return null;
  }
}
function rssKb(pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}
function treeRssMb(root) {
  const pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).map(Number);
  const children = new Map();
  for (const pid of pids) {
    const st = readStat(pid);
    if (!st) continue;
    if (!children.has(st.ppid)) children.set(st.ppid, []);
    children.get(st.ppid).push(pid);
  }
  const tree = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    tree.push(pid);
    for (const c of children.get(pid) || []) stack.push(c);
  }
  let total = 0;
  for (const pid of tree) total += rssKb(pid);
  return { mb: Math.round(total / 1024), procs: tree.length };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Página pesada o suficiente para forçar um renderer com DOM + heap de verdade.
const HEAVY = `data:text/html,${encodeURIComponent(
  `<!doctype html><meta charset=utf8><body><script>
     window.__a = new Float64Array(3*1024*1024);        /* ~24 MB de heap */
     for (let i=0;i<window.__a.length;i+=512) window.__a[i]=Math.random();
     let html=''; for (let i=0;i<4000;i++) html+='<p>linha '+i+' lorem ipsum dolor sit amet consectetur</p>';
     document.body.insertAdjacentHTML('beforeend', html);
   </script></body>`
)}`;

async function measure(label, root) {
  const r = treeRssMb(root);
  console.log(`MEASURE\t${label}\t${r.mb}\tMB\t${r.procs}\tprocs`);
  return r.mb;
}

app.commandLine.appendSwitch('no-sandbox');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 440,
    height: 900,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html,<meta charset=utf8><body></body>');

  const base = await measure('base(sem_webviews)', process.pid);

  // ---- EXPANDIDO: N webviews carregadas -----------------------------------
  await win.webContents.executeJavaScript(`
    window._wvs = [];
    const parts = ${JSON.stringify(PARTS)};
    const loaded = [];
    window._loaded = loaded;
    for (let i = 0; i < ${N}; i++) {
      const wv = document.createElement('webview');
      wv.setAttribute('partition', parts[i]);
      wv.setAttribute('src', ${JSON.stringify(HEAVY)});
      wv.style.cssText = 'width:100%;height:200px;display:block';
      wv.addEventListener('dom-ready', () => loaded.push(i));
      document.body.appendChild(wv);
      window._wvs.push(wv);
    }
    true;
  `);
  // espera carregar (dom-ready de todas ou timeout)
  for (let i = 0; i < 60; i++) {
    const n = await win.webContents.executeJavaScript('window._loaded.length');
    if (n >= N) break;
    await sleep(500);
  }
  await sleep(2500); // estabiliza heap/DOM
  const expanded = await measure(`expandido(${N}_abas)`, process.pid);

  // ---- RECOLHIDO (comportamento ANTIGO): só remove as webviews ------------
  await win.webContents.executeJavaScript('window._wvs.forEach((w) => w.remove()); window._wvs = []; true;');
  await sleep(3500); // deixa os processos renderer morrerem
  const collapsedOld = await measure('recolhido_antigo(remove)', process.pid);

  // ---- RECOLHIDO (comportamento NOVO): remove + clearCache + GC -----------
  for (const p of PARTS) {
    try { await session.fromPartition(p).clearCache(); } catch { /* ignora */ }
  }
  try { await session.defaultSession.clearCache(); } catch { /* ignora */ }
  if (global.gc) { global.gc(); global.gc(); }
  await win.webContents.executeJavaScript('if (window.gc) { window.gc(); window.gc(); } true;').catch(() => {});
  await sleep(2500);
  const collapsedNew = await measure('recolhido_novo(remove+clearCache+gc)', process.pid);

  console.log('\nRESULT_JSON ' + JSON.stringify({
    N,
    base_mb: base,
    expanded_mb: expanded,
    collapsed_old_mb: collapsedOld,
    collapsed_new_mb: collapsedNew,
    per_webview_mb: Math.round((expanded - base) / N),
    drop_expanded_to_collapsed_new_pct: Math.round((1 - collapsedNew / expanded) * 100),
    extra_drop_from_clearcache_gc_mb: collapsedOld - collapsedNew,
  }));

  setTimeout(() => app.quit(), 300);
});

app.on('window-all-closed', () => {});
