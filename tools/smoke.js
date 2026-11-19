'use strict';
/*
 * Smoke test da interface da Lâmina sob xvfb, sem rede nem o processo principal real.
 * Carrega o index.html + app.js reais com o preload real e um conjunto de handlers
 * IPC fingidos, captura TODO erro de JS do renderer e exercita os fluxos principais:
 * troca de aba, recolher/reabrir, timer contando recolhido, descarte por inatividade,
 * "liberar memória agora", feeds, notas e transferência.
 *
 * Uso: xvfb-run -a ./node_modules/.bin/electron --no-sandbox tools/smoke.js
 * Sai com código 0 se tudo passou; 1 se houve erro de JS ou falha de asserção.
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');
const WEBVIEW_PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'webview-preload.js');

const jsErrors = [];
const failures = [];
const calls = {}; // conta invocações de cada canal IPC fingido
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SETTINGS = {
  side: 'right', shortcut: 'Alt+Quote', hoverOpen: false, collapseOnBlur: true,
  openAtLogin: false, glass: 'simulated', updateIntervalMin: 30, autoInstall: true,
  preloadWhatsApp: true, panelWidth: 440, immersive: false, clipboardHistory: true,
  memorySaver: true, bgNotifications: false, idleUnloadMin: 0.05, efficiencyMode: true,
  lastVault: null, reducedMotion: true, lastVersion: null, firstRunDone: true,
};

function mock(channel, fn) {
  ipcMain.handle(channel, (...a) => {
    calls[channel] = (calls[channel] || 0) + 1;
    return fn ? fn(...a) : null;
  });
}
function mockSend(channel) {
  ipcMain.on(channel, () => {
    calls[channel] = (calls[channel] || 0) + 1;
  });
}

function setupIpc() {
  mock('app:info', () => ({
    version: '0.0.0-smoke', platform: 'win32', glassMode: 'simulated',
    nativeGlassSupported: false, packaged: false, webviewPreload: require('url').pathToFileURL(WEBVIEW_PRELOAD).href,
    settings: SETTINGS, updateStatus: { state: 'idle' },
  }));
  mock('app:restart');
  mock('app:quit');
  mock('open:external');
  mock('steam:list', () => ({ installed: false, games: [] }));
  mock('steam:launch', () => false);
  mock('steam:open', () => false);
  mock('settings:set', (_e, patch) => {
    Object.assign(SETTINGS, patch || {});
    return { ok: true, settings: SETTINGS, restartNeeded: false };
  });
  mock('notes:list', () => []);
  mock('notes:save', (_e, n) => ({ id: n.id || 'nsmoke', body: n.body || '', html: n.html || '', images: n.images || [], title: 'smoke', updated: Date.now() }));
  mock('notes:delete', () => true);
  mock('notes:image-save', () => ({ ok: false, error: 'sem imagem no smoke' }));
  mock('notes:image-copy', () => false);
  mock('notes:image-export', () => false);
  mock('apps:list', () => []);
  mock('apps:icon', () => null);
  mock('apps:launch', () => false);
  mock('update:check', () => ({ state: 'latest', at: Date.now() }));
  mock('update:install', () => true);
  mock('clip:list', () => [{ id: 'c1', type: 'text', text: 'olá do smoke', at: Date.now() }]);
  mock('clip:restore', () => true);
  mock('clip:remove', () => true);
  mock('clip:clear', () => true);
  mock('monitor:read', () => ({ cpu: { percent: 10, cores: 8 }, mem: { usedGB: 8, totalGB: 16, percent: 50 }, gpu: null }));
  mock('mem:free', () => ({ cleared: 7 }));
  mock('obsidian:vaults', () => []);
  mock('obsidian:save', () => ({ ok: false }));
  mock('app:notify');
  for (const ch of ['win:expand', 'win:collapse', 'win:hover', 'win:pin', 'win:hide', 'win:set-width', 'notes:image-drag']) mockSend(ch);
}

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('js-flags', '--expose-gc');

app.whenReady().then(async () => {
  setupIpc();
  const win = new BrowserWindow({
    show: false, width: 440, height: 900,
    webPreferences: {
      preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
      sandbox: true, webviewTag: true, backgroundThrottling: false,
    },
  });

  // Deixa qualquer webview anexar (no app real há uma lista de permissões; aqui o foco
  // é não quebrar a interface). Captura erros de carregamento sem derrubar o teste.
  win.webContents.on('will-attach-webview', (_e, wp) => {
    wp.nodeIntegration = false;
    wp.contextIsolation = true;
  });

  win.webContents.on('console-message', (_e, level, message, line, src) => {
    if (level >= 3) jsErrors.push(`${message} (${src}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => jsErrors.push(`render-process-gone: ${d.reason}`));
  win.webContents.on('preload-error', (_e, p, err) => jsErrors.push(`preload-error: ${err && err.message}`));

  await win.loadFile(RENDERER, { query: { glass: 'simulated', side: 'right' } });
  await sleep(1500); // init() assíncrono

  const run = (js) => win.webContents.executeJavaScript(js, true);

  // 1) Estado expandido
  win.webContents.send('state', 'expanded');
  await sleep(400);
  assert(await run("document.body.classList.contains('is-expanded')"), 'não entrou em is-expanded');

  // 2) Troca por todas as views do rail (sem erro de JS)
  const views = ['apps', 'whatsapp', 'discord', 'music', 'steam', 'chatgpt', 'gemini', 'notes', 'clipboard', 'timer', 'settings', 'home'];
  for (const v of views) {
    await run(`document.querySelector('.rail-btn[data-view="${v}"]').click()`);
    await sleep(180);
  }
  assert((calls['app:info'] || 0) >= 1, 'app:info não foi chamado');

  // 3) Transferência renderizou o item fingido
  await run("document.querySelector('.rail-btn[data-view=\"clipboard\"]').click()");
  await sleep(250);
  assert(await run("document.querySelectorAll('#clipList .clip-item').length >= 1"), 'transferência não renderizou');

  // 4) Timer conta recolhido: começa, recolhe, espera, confere que diminuiu
  await run("document.querySelector('.rail-btn[data-view=\"timer\"]').click()");
  await sleep(150);
  await run("document.querySelectorAll('#view-timer .chip[data-min]')[0].click()"); // 5 min
  await sleep(150);
  const t0 = await run("document.getElementById('timerDisplay').textContent");
  win.webContents.send('state', 'collapsed'); // recolhe: timers ociosos param, Pomodoro/timer continua
  await sleep(2600);
  const t1 = await run("document.getElementById('timerDisplay').textContent");
  assert(t0 !== t1, `timer não avançou recolhido (${t0} -> ${t1})`);
  assert(await run("!document.body.classList.contains('is-expanded')"), 'não recolheu');

  // 5) Reabre e cria uma aba de serviço (music) para o teste de inatividade
  win.webContents.send('state', 'expanded');
  await sleep(400);
  await run("document.querySelector('.rail-btn[data-view=\"music\"]').click()");
  await sleep(600);
  assert(await run("document.querySelectorAll('webview').length >= 1"), 'webview de música não foi criada');
  // volta para o Início: music fica "quente" por idleUnloadMin (0,05 min = 3 s)
  await run("document.querySelector('.rail-btn[data-view=\"home\"]').click()");
  await sleep(500);

  // 6) Botão "Liberar memória agora"
  await run("document.querySelector('.rail-btn[data-view=\"settings\"]').click()");
  await sleep(200);
  await run("document.getElementById('freeMemBtn').click()");
  await sleep(500);
  assert((calls['mem:free'] || 0) >= 1, 'mem:free não foi chamado pelo botão');

  // 7) Descarte por inatividade: espera um ciclo do sweep (30 s) + a janela de 3 s
  await sleep(33000);
  const wvLeft = await run("document.querySelectorAll('webview').length");
  assert(wvLeft === 0, `aba inativa não foi descartada (restaram ${wvLeft} webviews)`);

  // Resultado
  console.log('SMOKE_CALLS ' + JSON.stringify(calls));
  console.log('SMOKE_JS_ERRORS ' + JSON.stringify(jsErrors));
  console.log('SMOKE_FAILURES ' + JSON.stringify(failures));
  const ok = jsErrors.length === 0 && failures.length === 0;
  console.log('SMOKE_RESULT ' + (ok ? 'PASS' : 'FAIL'));
  setTimeout(() => app.exit(ok ? 0 : 1), 200);
});

app.on('window-all-closed', () => {});
