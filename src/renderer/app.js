'use strict';
/* global lamina */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const api = window.lamina;

  const params = new URLSearchParams(location.search);
  document.body.classList.add(`glass-${params.get('glass') || 'simulated'}`, `side-${params.get('side') || 'right'}`);

  let info = null;
  let settings = {};
  let currentView = 'home';

  const SERVICES = {
    whatsapp: { url: 'https://web.whatsapp.com/', partition: 'persist:whatsapp', title: 'WhatsApp', preload: true },
    music: { url: 'https://music.youtube.com/', partition: 'persist:music', title: 'YouTube Music' },
    chatgpt: { url: 'https://chatgpt.com/', partition: 'persist:chatgpt', title: 'ChatGPT' },
    gemini: { url: 'https://gemini.google.com/app', partition: 'persist:gemini', title: 'Gemini' },
    steamchat: { url: 'https://steamcommunity.com/chat', partition: 'persist:steam', title: 'chat da Steam', frame: '#steamFriendsPane .web-frame' },
  };
  const VIEW_ORDER = ['home', 'apps', 'whatsapp', 'music', 'steam', 'chatgpt', 'gemini', 'notes', 'clipboard', 'timer'];
  const webviews = {};
  const ready = {};

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ aviso
  let toastTimer;
  function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ------------------------------------------------------------------ estado da janela
  function setState(s) {
    document.body.classList.toggle('is-collapsed', s !== 'expanded');
    document.body.classList.toggle('is-expanded', s === 'expanded');
    if (s === 'expanded') {
      requestAnimationFrame(() => {
        rememberSize();
        if (currentView === 'home') $('#omni').focus();
      });
    }
    updateMonitor();
  }
  api.onState(setState);

  api.onSide((side) => {
    document.body.classList.remove('side-left', 'side-right');
    document.body.classList.add(`side-${side}`);
  });
  api.onOpenView((v) => v && openView(v));
  api.onToast((m) => toast(m, 4000));

  const handle = $('#handle');
  handle.addEventListener('click', () => api.expand());
  handle.addEventListener('mouseenter', () => api.hover());

  $('#collapseBtn').addEventListener('click', () => api.collapse());
  const pinBtn = $('#pinBtn');
  pinBtn.addEventListener('click', () => {
    const on = pinBtn.getAttribute('aria-pressed') !== 'true';
    pinBtn.setAttribute('aria-pressed', String(on));
    pinBtn.title = on ? 'Fixada: não recolhe ao clicar fora' : 'Manter aberta ao clicar fora';
    api.pin(on);
  });

  // ------------------------------------------------------------------ navegação
  function openView(view) {
    if (!document.getElementById(`view-${view}`)) return;
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
    $$('.rail-btn[data-view]').forEach((b) => {
      const sel = b.dataset.view === view;
      b.setAttribute('aria-selected', String(sel));
      b.tabIndex = sel ? 0 : -1;
    });
    if (SERVICES[view]) ensureWebview(view);
    if (view === 'apps') loadApps().then(() => $('#appsFilter').focus());
    if (view === 'notes') renderNoteList();
    if (view === 'clipboard') renderClip();
    updateMonitor();
    if (view === 'steam') loadSteam().then(() => $('#steamFilter').focus());
    if (view === 'home') {
      renderHomeNotes();
      if (steamData) renderHomeGames();
      updateMonitor();
      setTimeout(() => $('#omni').focus(), 30);
    }
    if (view === 'music') setTimeout(() => $('#musicQuery').focus(), 30);
  }

  $$('.rail-btn[data-view]').forEach((b) => b.addEventListener('click', () => openView(b.dataset.view)));
  $('.rail').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const btns = $$('.rail-btn');
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = btns[(i + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length];
    next.focus();
  });
  $$('[data-go]').forEach((b) => b.addEventListener('click', () => openView(b.dataset.go)));

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && /^[1-9]$/.test(e.key)) {
      e.preventDefault();
      openView(VIEW_ORDER[Number(e.key) - 1]);
    } else if (e.key === 'Escape') {
      if (!$('#omniResults').hidden) {
        clearOmni();
      } else if (currentView === 'notes' && !$('#noteEditorPane').hidden) {
        closeEditor();
      } else {
        api.collapse();
      }
    } else if (e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      openView('notes');
      newNote();
    }
  });

  // ------------------------------------------------------------------ relógio
  function tick() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    $('#date').textContent = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  }
  tick();
  setInterval(tick, 5000);

  // ------------------------------------------------------------------ webviews
  function frameOf(key) {
    return $(SERVICES[key].frame || `#view-${key} .web-frame`);
  }

  function showWebMessage(key, title, text, retry = true) {
    const frame = frameOf(key);
    let box = $('.web-msg', frame);
    if (!box) {
      box = document.createElement('div');
      box.className = 'web-msg';
      frame.appendChild(box);
    }
    box.innerHTML = `<strong>${esc(title)}</strong><p>${esc(text)}</p>${retry ? '<button class="btn" type="button">Tentar de novo</button>' : ''}`;
    const b = $('button', box);
    if (b) b.addEventListener('click', () => { box.remove(); webviews[key].reload(); });
  }
  function clearWebMessage(key) {
    const box = $('.web-msg', frameOf(key));
    if (box) box.remove();
  }

  function ensureWebview(key, src) {
    if (webviews[key]) {
      if (src) webviews[key].loadURL(src);
      return webviews[key];
    }
    const cfg = SERVICES[key];
    const wv = document.createElement('webview');
    wv.setAttribute('partition', cfg.partition);
    wv.setAttribute('allowpopups', '');
    wv.setAttribute('webpreferences', 'contextIsolation=yes, spellcheck=yes');
    if (cfg.preload && info && info.webviewPreload) wv.setAttribute('preload', info.webviewPreload);
    wv.setAttribute('src', src || cfg.url);
    const frame = frameOf(key);
    frame.appendChild(wv);
    webviews[key] = wv;
    ready[key] = false;

    let failed = false;
    wv.addEventListener('did-start-loading', () => {
      failed = false;
      frame.classList.remove('done');
      frame.classList.add('loading');
    });
    wv.addEventListener('did-stop-loading', () => {
      frame.classList.remove('loading');
      frame.classList.add('done');
    });
    wv.addEventListener('dom-ready', () => {
      if (failed) return; // a página de erro do Chromium também dispara dom-ready
      ready[key] = true;
      try { wv.setZoomFactor(getZoom(key)); } catch { /* ainda anexando */ }
      clearWebMessage(key);
    });
    wv.addEventListener('did-fail-load', (e) => {
      if (!e.isMainFrame || e.errorCode === -3) return; // -3 = navegação cancelada
      failed = true;
      ready[key] = false;
      showWebMessage(key, `Não deu para abrir o ${cfg.title}`, 'Confira a internet e tente de novo.');
    });
    wv.addEventListener('render-process-gone', () => {
      ready[key] = false;
      showWebMessage(key, `O ${cfg.title} parou de responder`, 'Recarregue para continuar de onde parou.');
    });

    if (key === 'whatsapp') {
      wv.addEventListener('ipc-message', (e) => {
        if (e.channel === 'notification') addWaMessage(e.args[0]);
      });
      wv.addEventListener('page-title-updated', (e) => setUnread(e.title));
    }
    return wv;
  }

  async function whenReady(key, timeout = 20000) {
    const start = Date.now();
    while (!ready[key] && Date.now() - start < timeout) await sleep(150);
    return ready[key];
  }

  $$('[data-service]').forEach((section) => {
    const key = section.dataset.service;
    section.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const wv = ensureWebview(key);
      if (btn.dataset.act === 'reload') wv.reload();
      if (btn.dataset.act === 'zoom-in' || btn.dataset.act === 'zoom-out') {
        const z = Math.round((getZoom(key) + (btn.dataset.act === 'zoom-in' ? 0.1 : -0.1)) * 10) / 10;
        setZoom(key, Math.max(0.5, Math.min(1.5, z)));
      }
      if (btn.dataset.act === 'external') {
        let url = SERVICES[key].url;
        try { url = wv.getURL() || url; } catch { /* ainda carregando */ }
        api.openExternal(url);
      }
    });
  });

  // ------------------------------------------------------------------ zoom das páginas
  function getZoom(key) {
    try {
      return Number(JSON.parse(localStorage.getItem('zoom') || '{}')[key]) || 1;
    } catch {
      return 1;
    }
  }
  function setZoom(key, z) {
    try {
      const all = JSON.parse(localStorage.getItem('zoom') || '{}');
      all[key] = z;
      localStorage.setItem('zoom', JSON.stringify(all));
    } catch { /* sem armazenamento */ }
    if (webviews[key] && ready[key]) webviews[key].setZoomFactor(z);
    toast(`Tamanho da página: ${Math.round(z * 100)}%`, 1400);
  }

  // ------------------------------------------------------------------ largura (arrastar a borda)
  function rememberSize() {
    if (window.innerHeight > 300) document.documentElement.style.setProperty('--panel-h', `${window.innerHeight}px`);
    if (window.innerWidth > 300) document.documentElement.style.setProperty('--panel-w', `${window.innerWidth}px`);
  }
  window.addEventListener('resize', () => {
    if (document.body.classList.contains('is-expanded')) rememberSize();
  });
  const grip = $('#resizeGrip');
  let drag = null;
  let rafId = 0;
  let pendingW = 0;
  const sideIsLeft = () => document.body.classList.contains('side-left');
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    drag = { x: e.screenX, w: window.innerWidth };
    document.body.classList.add('resizing');
    api.pin(true);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x;
    pendingW = sideIsLeft() ? drag.w + dx : drag.w - dx;
    if (!rafId) {
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        api.setWidth(pendingW, false);
      });
    }
  });
  const endDrag = (e) => {
    if (!drag) return;
    try { grip.releasePointerCapture(e.pointerId); } catch { /* já solto */ }
    drag = null;
    document.body.classList.remove('resizing');
    api.setWidth(pendingW || window.innerWidth, true);
    api.pin($('#pinBtn').getAttribute('aria-pressed') === 'true');
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('dblclick', () => {
    pendingW = 440;
    api.setWidth(440, true);
  });

  // ------------------------------------------------------------------ Steam
  let steamData = null;
  const coverUrls = (id) => [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/library_600x900.jpg`,
    `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/library_600x900.jpg`,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
  ];
  function gameTile(g) {
    return `<button type="button" class="game" data-appid="${esc(g.appid)}" title="${esc(g.name)}" aria-label="Jogar ${esc(g.name)}">
      <span class="g-ph" aria-hidden="true">${esc(g.name)}</span>
      <img alt="" loading="lazy" data-try="0" src="${coverUrls(g.appid)[0]}" />
      <span class="g-name">${esc(g.name)}</span></button>`;
  }
  // capa: tenta a vertical em dois servidores, depois a horizontal, depois só o nome
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.closest('.game')) return;
    const tile = img.closest('.game');
    const next = Number(img.dataset.try) + 1;
    const urls = coverUrls(tile.dataset.appid);
    if (next < urls.length) {
      img.dataset.try = String(next);
      if (next === urls.length - 1) img.classList.add('wide');
      img.src = urls[next];
    } else {
      img.remove();
      tile.classList.add('no-art');
    }
  }, true);

  async function loadSteam(refresh = false) {
    if (steamData && !refresh) {
      renderSteam();
      return steamData;
    }
    $('#steamInfo').textContent = 'Lendo a biblioteca da Steam…';
    try {
      steamData = await api.steam.list(refresh);
    } catch {
      steamData = { installed: false, games: [] };
    }
    renderSteam();
    renderHomeGames();
    return steamData;
  }
  function renderSteam() {
    const info = $('#steamInfo');
    const empty = $('#steamEmpty');
    const ul = $('#steamGames');
    if (!steamData || !steamData.installed) {
      info.textContent = '';
      ul.innerHTML = '';
      empty.hidden = false;
      empty.textContent = 'Não encontrei a Steam neste computador.';
      return;
    }
    const q = norm($('#steamFilter').value.trim());
    const list = steamData.games.filter((g) => !q || norm(g.name).includes(q));
    info.textContent = `${steamData.games.length} jogos instalados, os jogados por último primeiro.`;
    ul.innerHTML = list.map((g) => `<li>${gameTile(g)}</li>`).join('');
    empty.hidden = list.length > 0;
    empty.textContent = steamData.games.length ? 'Nenhum jogo com esse nome.' : 'Nenhum jogo instalado na Steam.';
  }
  function renderHomeGames() {
    const games = (steamData && steamData.games ? steamData.games : []).filter((g) => g.lastPlayed > 0).slice(0, 4);
    $('#homeGamesBlock').hidden = games.length === 0;
    $('#homeGames').innerHTML = games.map(gameTile).join('');
  }
  async function playGame(appid) {
    const g = steamData && steamData.games.find((x) => x.appid === appid);
    const ok = await api.steam.launch(appid);
    if (ok && g) toast(`Abrindo ${g.name}`);
  }
  document.addEventListener('click', (e) => {
    const tile = e.target.closest('.game[data-appid]');
    if (tile) playGame(tile.dataset.appid);
    const chip = e.target.closest('[data-steam]');
    if (chip) api.steam.open(chip.dataset.steam);
  });
  $('#steamFilter').addEventListener('input', renderSteam);
  $('#steamFilter').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('#steamGames .game');
      if (first) playGame(first.dataset.appid);
    }
  });
  $('#steamRefresh').addEventListener('click', () => loadSteam(true));
  function steamTab(which) {
    const friends = which === 'friends';
    $('#steamTabGames').setAttribute('aria-selected', String(!friends));
    $('#steamTabFriends').setAttribute('aria-selected', String(friends));
    $('#steamGamesPane').hidden = friends;
    $('#steamFriendsPane').hidden = !friends;
    $('#steamRefresh').hidden = friends;
    if (friends) ensureWebview('steamchat');
    else $('#steamFilter').focus();
  }
  $('#steamTabGames').addEventListener('click', () => steamTab('games'));
  $('#steamTabFriends').addEventListener('click', () => steamTab('friends'));

  // ------------------------------------------------------------------ WhatsApp
  const waMessages = []; // só em memória: nada de conversa salvo em disco
  function setUnread(title) {
    const m = /\((\d+)\)/.exec(title || '');
    const n = m ? Number(m[1]) : 0;
    const badge = $('.rail-btn[data-view="whatsapp"] .count');
    badge.hidden = n === 0;
    badge.textContent = n > 99 ? '99+' : String(n);
    $('.rail-btn[data-view="whatsapp"]').setAttribute('aria-label', n ? `WhatsApp, ${n} não lidas` : 'WhatsApp');
    handle.classList.toggle('unread', n > 0);
    handle.setAttribute('aria-label', n ? `Abrir a Lâmina: ${n} mensagens não lidas` : 'Abrir a Lâmina');
  }
  function addWaMessage(msg) {
    if (!msg || !msg.title) return;
    waMessages.unshift(msg);
    waMessages.length = Math.min(waMessages.length, 20);
    renderWaFeed();
  }
  function timeAgo(ts) {
    const d = Math.round((Date.now() - ts) / 60000);
    if (d < 1) return 'agora';
    if (d < 60) return `${d} min`;
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function renderWaFeed() {
    const ul = $('#waFeed');
    ul.innerHTML = waMessages
      .slice(0, 5)
      .map(
        (m) => `<li><button type="button" data-go-wa>
          <div class="who"><span>${esc(m.title)}</span><time>${timeAgo(m.at)}</time></div>
          <div class="msg">${esc(m.body)}</div></button></li>`
      )
      .join('');
    $('#waEmpty').hidden = waMessages.length > 0;
    $$('[data-go-wa]', ul).forEach((b) => b.addEventListener('click', () => openView('whatsapp')));
  }
  setInterval(renderWaFeed, 60000);

  // ------------------------------------------------------------------ música
  const MUSIC_STATE_JS = `(() => {
    const v = document.querySelector('video');
    const bar = document.querySelector('ytmusic-player-bar');
    if (!v || !bar) return null;
    const title = (bar.querySelector('.title') || {}).textContent || '';
    const by = (bar.querySelector('.byline') || {}).textContent || '';
    if (!title.trim()) return null;
    return { title: title.trim(), artist: by.split('•')[0].trim(), playing: !v.paused };
  })()`;
  const AUTOPLAY_JS = `(async () => {
    const pick = () =>
      document.querySelector('ytmusic-card-shelf-renderer ytmusic-play-button-renderer') ||
      document.querySelector('ytmusic-shelf-renderer ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer') ||
      document.querySelector('ytmusic-responsive-list-item-renderer ytmusic-play-button-renderer');
    for (let i = 0; i < 50; i++) {
      const el = pick();
      if (el) { el.click(); return true; }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })()`;

  async function playMusic(query) {
    const q = String(query || '').trim();
    if (!q) return;
    const url = `https://music.youtube.com/search?q=${encodeURIComponent(q)}`;
    ready.music = false;
    const wv = ensureWebview('music', url);
    toast(`Procurando “${q}”…`);
    if (!(await whenReady('music'))) return;
    await sleep(600);
    try {
      const ok = await wv.executeJavaScript(AUTOPLAY_JS);
      if (!ok) toast('Não achei um botão de tocar. Escolha na lista.', 3200);
    } catch {
      /* página mudou no meio */
    }
  }

  $('#musicForm').addEventListener('submit', (e) => {
    e.preventDefault();
    playMusic($('#musicQuery').value);
    $('#musicQuery').select();
  });

  async function musicCmd(js) {
    const wv = webviews.music;
    if (!wv || !ready.music) return;
    try {
      await wv.executeJavaScript(js);
      setTimeout(pollMusic, 300);
    } catch { /* ignora */ }
  }
  $('#npToggle').addEventListener('click', () =>
    musicCmd(`(() => { const v = document.querySelector('video'); if (v) v.paused ? v.play() : v.pause(); })()`)
  );
  $('#npNext').addEventListener('click', () => musicCmd(`document.querySelector('.next-button')?.click()`));
  $('#npPrev').addEventListener('click', () => musicCmd(`document.querySelector('.previous-button')?.click()`));

  async function pollMusic() {
    const wv = webviews.music;
    const box = $('#nowPlaying');
    if (!wv || !ready.music) {
      box.hidden = true;
      return;
    }
    try {
      const st = await wv.executeJavaScript(MUSIC_STATE_JS);
      if (!st) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      $('#npTitle').textContent = st.title;
      $('#npArtist').textContent = st.artist;
      const t = $('#npToggle');
      t.setAttribute('aria-label', st.playing ? 'Pausar' : 'Tocar');
      $('use', t).setAttribute('href', st.playing ? '#i-pause' : '#i-play');
    } catch {
      box.hidden = true;
    }
  }
  setInterval(pollMusic, 2500);

  // ------------------------------------------------------------------ ChatGPT / Gemini
  function askChatGPT(q) {
    openView('chatgpt');
    ready.chatgpt = false;
    ensureWebview('chatgpt', `https://chatgpt.com/?q=${encodeURIComponent(q)}`);
  }

  const geminiFill = (q) => `(async (q) => {
    const sel = 'rich-textarea .ql-editor, div.ql-editor[contenteditable="true"], div[contenteditable="true"][role="textbox"]';
    for (let i = 0; i < 60; i++) {
      const ed = document.querySelector(sel);
      if (ed) {
        ed.focus();
        document.execCommand('selectAll', false);
        document.execCommand('insertText', false, q);
        await new Promise((r) => setTimeout(r, 350));
        const btn = document.querySelector('button.send-button, button[aria-label*="Enviar"], button[aria-label*="Send"]');
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') btn.click();
        else ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        return true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  })(${JSON.stringify(q)})`;

  async function askGemini(q) {
    openView('gemini');
    const existed = !!webviews.gemini;
    const wv = ensureWebview('gemini');
    if (existed) {
      ready.gemini = false;
      wv.loadURL('https://gemini.google.com/app');
    }
    if (!(await whenReady('gemini'))) return;
    await sleep(800);
    try {
      const ok = await wv.executeJavaScript(geminiFill(q));
      if (!ok) toast('Entre na sua conta do Gemini e tente de novo.', 3500);
    } catch { /* ignora */ }
  }

  // ------------------------------------------------------------------ apps
  let appList = [];
  let appsLoaded = false;
  async function loadApps(refresh = false) {
    if (appsLoaded && !refresh) return appList;
    $('#appsEmpty').hidden = false;
    $('#appsEmpty').textContent = 'Carregando apps…';
    try {
      appList = await api.apps.list(refresh);
    } catch {
      appList = [];
    }
    appsLoaded = true;
    renderApps();
    renderRecent();
    return appList;
  }

  function scoreApp(name, q) {
    const n = norm(name);
    if (!q) return 1;
    if (n === q) return 100;
    if (n.startsWith(q)) return 80;
    if (n.split(/[\s\-_.]+/).some((w) => w.startsWith(q))) return 60;
    if (n.includes(q)) return 40;
    // iniciais: "vsc" → "Visual Studio Code"
    const initials = n.split(/[\s\-_.]+/).map((w) => w[0]).join('');
    if (initials.startsWith(q)) return 30;
    return 0;
  }
  function matchApps(query, limit) {
    const q = norm(query.trim());
    return appList
      .map((a) => ({ a, s: scoreApp(a.name, q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.name.localeCompare(y.a.name, 'pt-BR'))
      .slice(0, limit)
      .map((x) => x.a);
  }

  const iconObserver = new IntersectionObserver((entries) => {
    entries.forEach(async (en) => {
      if (!en.isIntersecting) return;
      const el = en.target;
      iconObserver.unobserve(el);
      try {
        const url = await api.apps.icon(el.dataset.appId);
        if (url) el.innerHTML = `<img src="${url}" alt="" />`;
      } catch { /* fica a inicial */ }
    });
  });
  function appIcon(a) {
    return `<span class="r-icon" data-app-id="${esc(a.id)}" aria-hidden="true">${esc((a.name[0] || '?').toUpperCase())}</span>`;
  }
  function observeIcons(root) {
    $$('.r-icon[data-app-id]', root).forEach((el) => iconObserver.observe(el));
  }

  let appSel = 0;
  function renderApps() {
    const list = matchApps($('#appsFilter').value, 200);
    const ul = $('#appList');
    appSel = Math.min(appSel, Math.max(0, list.length - 1));
    ul.innerHTML = list
      .map((a, i) => `<li class="app-item" role="option" aria-selected="${i === appSel}" data-id="${esc(a.id)}">${appIcon(a)}<span class="name">${esc(a.name)}</span></li>`)
      .join('');
    observeIcons(ul);
    const empty = $('#appsEmpty');
    if (info && info.platform !== 'win32') {
      empty.hidden = false;
      empty.textContent = 'A lista de apps funciona no Windows.';
    } else if (!list.length) {
      empty.hidden = false;
      empty.textContent = appList.length ? 'Nenhum app com esse nome.' : 'Nenhum app encontrado. Toque em atualizar lista.';
    } else empty.hidden = true;
  }
  $('#appsFilter').addEventListener('input', () => {
    appSel = 0;
    renderApps();
  });
  $('#appsFilter').addEventListener('keydown', (e) => {
    const items = $$('#appList .app-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      appSel = Math.max(0, Math.min(items.length - 1, appSel + (e.key === 'ArrowDown' ? 1 : -1)));
      items.forEach((it, i) => it.setAttribute('aria-selected', String(i === appSel)));
      if (items[appSel]) items[appSel].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items[appSel]) {
      launchApp(items[appSel].dataset.id);
    }
  });
  $('#appList').addEventListener('click', (e) => {
    const it = e.target.closest('.app-item');
    if (it) launchApp(it.dataset.id);
  });
  $('#appsRefresh').addEventListener('click', () => loadApps(true));

  function getRecent() {
    try {
      return JSON.parse(localStorage.getItem('recentApps') || '[]');
    } catch {
      return [];
    }
  }
  function renderRecent() {
    const items = getRecent()
      .map((id) => appList.find((a) => a.id === id))
      .filter(Boolean)
      .slice(0, 8);
    $('#recentBlock').hidden = items.length === 0;
    const box = $('#recentApps');
    box.innerHTML = items
      .map((a) => `<button type="button" data-id="${esc(a.id)}" title="${esc(a.name)}">${appIcon(a)}<span class="name">${esc(a.name)}</span></button>`)
      .join('');
    observeIcons(box);
  }
  $('#recentApps').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) launchApp(b.dataset.id);
  });

  async function launchApp(id) {
    const a = appList.find((x) => x.id === id);
    const ok = await api.apps.launch(id);
    if (!ok) return toast(`Não consegui abrir ${a ? a.name : 'o app'}.`);
    try {
      const list = [id, ...getRecent().filter((x) => x !== id)].slice(0, 8);
      localStorage.setItem('recentApps', JSON.stringify(list));
    } catch { /* sem armazenamento */ }
    renderRecent();
  }

  // ------------------------------------------------------------------ busca do início
  const omni = $('#omni');
  const results = $('#omniResults');
  let omniItems = [];
  let omniSel = 0;

  function buildOmni(raw) {
    const text = raw.trim();
    if (!text) return [];
    const m = /^(gpt|chat|chatgpt|gem|gemini|tocar|toca|play|m|nota|n)\s+(.+)$/i.exec(text);
    const cmd = m ? m[1].toLowerCase() : null;
    const body = m ? m[2] : text;

    const actions = {
      music: { kind: 'music', label: `Tocar “${body}”`, sub: 'YouTube Music', icon: '#i-music' },
      gpt: { kind: 'gpt', label: 'Perguntar ao ChatGPT', sub: body, icon: '#i-orbit' },
      gemini: { kind: 'gemini', label: 'Perguntar ao Gemini', sub: body, icon: '#i-prism' },
      note: { kind: 'note', label: 'Salvar como nota', sub: body, icon: '#i-note' },
    };
    const appsFound = cmd ? [] : matchApps(text, 5).map((a) => ({ kind: 'app', app: a, label: a.name, sub: 'Abrir app' }));
    const qn = norm(text);
    const gamesFound = cmd || !steamData ? [] : steamData.games
      .filter((g) => norm(g.name).includes(qn))
      .slice(0, 3)
      .map((g) => ({ kind: 'game', game: g, label: g.name, sub: 'Jogar na Steam', icon: '#i-pad' }));

    let order;
    if (cmd === 'gpt' || cmd === 'chat' || cmd === 'chatgpt') order = ['gpt', 'gemini', 'music', 'note'];
    else if (cmd === 'gem' || cmd === 'gemini') order = ['gemini', 'gpt', 'music', 'note'];
    else if (cmd === 'tocar' || cmd === 'toca' || cmd === 'play' || cmd === 'm') order = ['music', 'gpt', 'gemini', 'note'];
    else if (cmd === 'nota' || cmd === 'n') order = ['note', 'gpt', 'gemini', 'music'];
    else order = ['gpt', 'gemini', 'music', 'note'];

    return [...gamesFound, ...appsFound, ...order.map((k) => ({ ...actions[k], text: body }))];
  }

  function renderOmni() {
    results.hidden = omniItems.length === 0;
    $('#homeBlocks').hidden = omniItems.length > 0;
    results.innerHTML = omniItems
      .map((it, i) => {
        const icon = it.kind === 'app' ? appIcon(it.app) : `<span class="r-icon" aria-hidden="true"><svg><use href="${it.icon}"/></svg></span>`;
        return `<li class="result" role="option" id="omni-${i}" aria-selected="${i === omniSel}" data-i="${i}">
          ${icon}<div class="r-text"><div class="r-label">${esc(it.label)}</div><div class="r-sub">${esc(it.sub)}</div></div>
          ${i === omniSel ? '<span class="r-key">Enter</span>' : ''}</li>`;
      })
      .join('');
    omni.setAttribute('aria-activedescendant', omniItems.length ? `omni-${omniSel}` : '');
    observeIcons(results);
  }
  function clearOmni() {
    omni.value = '';
    omniItems = [];
    renderOmni();
  }
  async function runOmni(it) {
    if (!it) return;
    clearOmni();
    if (it.kind === 'app') return launchApp(it.app.id);
    if (it.kind === 'game') return playGame(it.game.appid);
    if (it.kind === 'gpt') return askChatGPT(it.text);
    if (it.kind === 'gemini') return askGemini(it.text);
    if (it.kind === 'music') {
      openView('music');
      $('#musicQuery').value = it.text;
      return playMusic(it.text);
    }
    if (it.kind === 'note') {
      await api.notes.save({ body: it.text });
      toast('Nota salva');
      renderHomeNotes();
    }
  }

  omni.addEventListener('focus', () => loadApps());
  omni.addEventListener('input', () => {
    omniSel = 0;
    omniItems = buildOmni(omni.value);
    renderOmni();
  });
  omni.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!omniItems.length) return;
      e.preventDefault();
      omniSel = (omniSel + (e.key === 'ArrowDown' ? 1 : -1) + omniItems.length) % omniItems.length;
      renderOmni();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runOmni(omniItems[omniSel]);
    }
  });
  results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('.result');
    if (!li) return;
    e.preventDefault();
    runOmni(omniItems[Number(li.dataset.i)]);
  });

  // ------------------------------------------------------------------ notas
  let notes = [];
  let editing = null;
  let saveTimer = null;
  const editor = $('#noteBody');
  const IMG_SRC = /^lamina-img:\/\/img\/([a-f0-9]{16}\.png)$/;
  const imgUrl = (name) => `lamina-img://img/${name}`;
  const imgName = (img) => {
    const m = IMG_SRC.exec(img.getAttribute('src') || '');
    return m ? m[1] : null;
  };

  const fmtDate = (ts) => {
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `hoje, ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    return d.toLocaleDateString('pt-BR', { day: 'numeric', month: 'short' });
  };
  const preview = (n) => (n.body || '').split('\n').slice(1).join(' ').trim().slice(0, 90);
  const thumb = (n) => (n.images && n.images.length ? `<img class="thumb" alt="" src="${imgUrl(n.images[0])}" />` : '');

  // Só texto, quebras de linha e as imagens do próprio app sobrevivem
  function cleanHtml(html) {
    const doc = new DOMParser().parseFromString(`<div>${html || ''}</div>`, 'text/html');
    const out = document.createElement('div');
    const walk = (src, dst) => {
      for (const node of Array.from(src.childNodes)) {
        if (node.nodeType === 3) dst.appendChild(document.createTextNode(node.textContent));
        else if (node.nodeType !== 1) continue;
        else if (node.tagName === 'BR') dst.appendChild(document.createElement('br'));
        else if (node.tagName === 'IMG') {
          const name = imgName(node);
          if (name) dst.appendChild(makeImg(name));
        } else if (node.tagName === 'DIV' || node.tagName === 'P') {
          const d = document.createElement('div');
          walk(node, d);
          dst.appendChild(d);
        } else walk(node, dst);
      }
    };
    walk(doc.body.firstChild, out);
    return out.innerHTML;
  }
  function makeImg(name) {
    const img = document.createElement('img');
    img.src = imgUrl(name);
    img.className = 'note-img';
    img.alt = 'Imagem colada';
    img.draggable = true;
    return img;
  }
  const textToHtml = (t) => esc(t || '').replace(/\n/g, '<br>');

  async function refreshNotes() {
    notes = (await api.notes.list()) || [];
    return notes;
  }
  async function renderNoteList() {
    await refreshNotes();
    $('#noteList').innerHTML = notes
      .map((n) => `<li><button type="button" data-id="${esc(n.id)}"><div class="row"><div><div class="t">${esc(n.title || 'Sem título')}</div>${preview(n) ? `<div class="p">${esc(preview(n))}</div>` : ''}<div class="d">${fmtDate(n.updated)}</div></div>${thumb(n)}</div></button></li>`)
      .join('');
    $('#notesEmpty').hidden = notes.length > 0;
  }
  async function renderHomeNotes() {
    await refreshNotes();
    $('#homeNotes').innerHTML = notes
      .slice(0, 3)
      .map((n) => `<li><button type="button" data-id="${esc(n.id)}"><div class="row"><div><div class="t">${esc(n.title || 'Sem título')}</div><div class="d">${fmtDate(n.updated)}</div></div>${thumb(n)}</div></button></li>`)
      .join('');
    $('#homeNotesEmpty').hidden = notes.length > 0;
  }

  function openEditor(note) {
    editing = note ? { ...note } : { id: null, body: '', html: '' };
    $('#notesListPane').hidden = true;
    $('#noteEditorPane').hidden = false;
    editor.innerHTML = editing.html != null && editing.html !== '' ? cleanHtml(editing.html) : textToHtml(editing.body);
    editing.html = editor.innerHTML;
    hideImgTools();
    $('#noteSaved').textContent = note ? `Editada ${fmtDate(note.updated)}` : 'Nova nota';
    editor.focus();
    // cursor no fim
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  function editorState() {
    const html = cleanHtml(editor.innerHTML);
    const body = editor.innerText.replace(/\n{3,}/g, '\n\n');
    const images = $$('img', editor).map(imgName).filter(Boolean);
    return { html, body, images };
  }
  async function closeEditor() {
    await flushNote();
    if (editing && editing.id) {
      const st = editorState();
      if (!st.body.trim() && !st.images.length) await api.notes.remove(editing.id);
    }
    editing = null;
    hideImgTools();
    $('#noteEditorPane').hidden = true;
    $('#notesListPane').hidden = false;
    renderNoteList();
    renderHomeNotes();
  }
  function newNote() {
    openEditor(null);
  }
  async function flushNote() {
    clearTimeout(saveTimer);
    if (!editing) return;
    const st = editorState();
    if (st.html === editing.html && editing.id) return;
    if (!st.body.trim() && !st.images.length && !editing.id) return;
    const saved = await api.notes.save({ id: editing.id, ...st });
    if (editing) {
      editing = { ...saved };
      $('#noteSaved').textContent = 'Salva';
    }
  }
  function scheduleSave() {
    $('#noteSaved').textContent = 'Salvando…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNote, 450);
  }
  editor.addEventListener('input', scheduleSave);

  // Colar: imagem vira imagem salva; qualquer outra coisa entra como texto puro
  async function storeImage(file) {
    if (file.size > 40 * 1024 * 1024) {
      toast('Imagem grande demais (máximo 40 MB).');
      return null;
    }
    const res = await api.notes.saveImage(new Uint8Array(await file.arrayBuffer()));
    if (!res || !res.ok) {
      toast((res && res.error) || 'Não consegui salvar a imagem.', 3500);
      return null;
    }
    return res.name;
  }
  async function insertImages(files) {
    const range = getSelection().rangeCount ? getSelection().getRangeAt(0).cloneRange() : null;
    let html = '';
    for (const f of files) {
      const name = await storeImage(f);
      if (name) html += `<img src="${imgUrl(name)}" class="note-img" alt="Imagem colada"><br>`;
    }
    if (!html) return;
    editor.focus();
    if (range && editor.contains(range.startContainer)) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand('insertHTML', false, html);
    $$('img', editor).forEach((img) => (img.draggable = true));
    scheduleSave();
  }
  const imageFiles = (dt) =>
    Array.from((dt && dt.items) || [])
      .filter((i) => i.kind === 'file' && /^image\//.test(i.type))
      .map((i) => i.getAsFile())
      .filter(Boolean);
  editor.addEventListener('paste', (e) => {
    const files = imageFiles(e.clipboardData);
    e.preventDefault();
    if (files.length) return insertImages(files);
    const text = e.clipboardData.getData('text/plain');
    if (text) document.execCommand('insertText', false, text);
  });
  editor.addEventListener('dragover', (e) => {
    if (Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  });
  editor.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files || []).filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    e.preventDefault();
    const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (pos) {
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(pos);
    }
    insertImages(files);
  });

  // Copiar: se a seleção é só uma imagem, vai a imagem de verdade para a área de transferência
  editor.addEventListener('copy', (e) => {
    const sel = getSelection();
    if (!sel.rangeCount) return;
    const frag = sel.getRangeAt(0).cloneContents();
    const imgs = frag.querySelectorAll('img');
    if (imgs.length === 1 && !frag.textContent.trim()) {
      e.preventDefault();
      copyImage(imgName(imgs[0]));
    }
  });
  async function copyImage(name) {
    if (name && (await api.notes.copyImage(name))) toast('Imagem copiada. Cole onde quiser com Ctrl+V.');
  }

  // Barrinha que aparece em cima da imagem: Copiar / Salvar… / Tirar
  const tools = $('#imgTools');
  let toolsImg = null;
  let hideTimer = null;
  function showImgTools(img) {
    clearTimeout(hideTimer);
    if (toolsImg && toolsImg !== img) toolsImg.classList.remove('picked');
    toolsImg = img;
    const box = $('#noteEditorPane').getBoundingClientRect();
    const r = img.getBoundingClientRect();
    tools.hidden = false;
    const top = Math.max(r.top, editor.getBoundingClientRect().top) - box.top + 8;
    tools.style.top = `${top}px`;
    tools.style.left = `${Math.max(8, r.right - box.left - tools.offsetWidth - 8)}px`;
  }
  function hideImgTools() {
    clearTimeout(hideTimer);
    tools.hidden = true;
    if (toolsImg) toolsImg.classList.remove('picked');
    toolsImg = null;
  }
  const hideSoon = () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!(toolsImg && toolsImg.classList.contains('picked'))) hideImgTools();
    }, 350);
  };
  editor.addEventListener('mouseover', (e) => {
    if (e.target.tagName === 'IMG') showImgTools(e.target);
  });
  editor.addEventListener('mouseout', (e) => {
    if (e.target.tagName === 'IMG') hideSoon();
  });
  tools.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tools.addEventListener('mouseleave', hideSoon);
  editor.addEventListener('scroll', hideImgTools);
  // clicar na imagem seleciona ela (aí Ctrl+C copia a imagem)
  editor.addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') {
      if (toolsImg) hideImgTools();
      return;
    }
    const img = e.target;
    const r = document.createRange();
    r.selectNode(img);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    showImgTools(img);
    img.classList.add('picked');
  });
  editor.addEventListener('dragstart', (e) => {
    if (e.target.tagName !== 'IMG') return;
    const name = imgName(e.target);
    if (!name) return;
    e.preventDefault();
    api.notes.dragImage(name);
  });
  tools.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-img]');
    if (!b || !toolsImg) return;
    const name = imgName(toolsImg);
    if (b.dataset.img === 'copy') copyImage(name);
    if (b.dataset.img === 'export') {
      if (await api.notes.exportImage(name)) toast('Imagem salva');
    }
    if (b.dataset.img === 'remove') {
      const img = toolsImg;
      hideImgTools();
      const next = img.nextSibling;
      if (next && next.nodeName === 'BR') next.remove();
      img.remove();
      scheduleSave();
    }
  });

  $('#noteBack').addEventListener('click', closeEditor);
  $('#noteDelete').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    if (editing && editing.id) await api.notes.remove(editing.id);
    editing = null;
    hideImgTools();
    $('#noteEditorPane').hidden = true;
    $('#notesListPane').hidden = false;
    toast('Nota apagada');
    renderNoteList();
    renderHomeNotes();
  });
  $('#newNoteBtn').addEventListener('click', newNote);
  $('#homeNewNote').addEventListener('click', () => {
    openView('notes');
    newNote();
  });
  const openNoteById = (id) => {
    const n = notes.find((x) => x.id === id);
    if (n) openEditor(n);
  };
  $('#noteList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (b) openNoteById(b.dataset.id);
  });
  $('#homeNotes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    openView('notes');
    openNoteById(b.dataset.id);
  });
  window.addEventListener('beforeunload', () => flushNote());

  // Colar uma imagem na busca do Início já guarda ela numa nota nova
  omni.addEventListener('paste', async (e) => {
    const files = imageFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    const names = [];
    for (const f of files) {
      const n = await storeImage(f);
      if (n) names.push(n);
    }
    if (!names.length) return;
    await api.notes.save({ html: names.map((n) => `<img src="${imgUrl(n)}" class="note-img" alt="Imagem colada"><br>`).join(''), body: '', images: names });
    toast('Imagem guardada em Notas');
    renderHomeNotes();
  });

  // ------------------------------------------------------------------ transferência
  let clipItems = [];
  function renderClip(listData) {
    if (listData) clipItems = listData;
    const disabled = settings ? !settings.clipboardHistory : false;
    $('#clipOff').hidden = !disabled;
    const ul = $('#clipList');
    if (disabled) {
      ul.innerHTML = '';
      $('#clipEmpty').hidden = true;
      return;
    }
    ul.innerHTML = clipItems
      .map((it) => {
        const body =
          it.type === 'image'
            ? `<img class="clip-thumb" alt="" src="lamina-img://clip/${esc(it.image)}" /><span class="clip-meta">Imagem ${it.w}×${it.h}</span>`
            : `<span class="clip-text">${esc((it.text || '').slice(0, 240))}</span>`;
        return `<li class="clip-item"><button class="clip-main" type="button" data-copy="${esc(it.id)}">${body}</button><button class="icon-btn clip-x" data-del="${esc(it.id)}" aria-label="Remover"><svg><use href="#i-trash"/></svg></button></li>`;
      })
      .join('');
    $('#clipEmpty').hidden = clipItems.length > 0;
  }
  async function loadClip() {
    clipItems = (await api.clipboard.list()) || [];
    renderClip();
  }
  api.onClipboard((listData) => {
    clipItems = listData || [];
    if (currentView === 'clipboard') renderClip();
  });
  $('#clipList').addEventListener('click', async (e) => {
    const copy = e.target.closest('[data-copy]');
    const del = e.target.closest('[data-del]');
    if (copy) {
      if (await api.clipboard.restore(copy.dataset.copy)) toast('Copiado. Cole onde quiser com Ctrl+V.');
    } else if (del) {
      await api.clipboard.remove(del.dataset.del);
      loadClip();
    }
  });
  $('#clipClear').addEventListener('click', async () => {
    await api.clipboard.clear();
    loadClip();
  });

  // ------------------------------------------------------------------ monitor do PC
  let monTimer = null;
  const monIcons = { cpu: '#i-cpu', mem: '#i-apps', gpu: '#i-prism' };
  function meter(key, label, percent, sub) {
    const pct = percent == null ? null : Math.round(percent);
    return `<div class="meter">
      <span class="m-ico"><svg><use href="${monIcons[key]}"/></svg></span>
      <div class="m-bar"><div class="m-fill" style="width:${pct == null ? 0 : pct}%"></div></div>
      <span class="m-val">${pct == null ? '—' : pct + '%'}</span>
      <span class="m-sub">${esc(label)}${sub ? ' · ' + esc(sub) : ''}</span>
    </div>`;
  }
  async function pollMonitor() {
    try {
      const m = await api.monitor.read();
      const rows = [
        meter('cpu', 'CPU', m.cpu.percent, m.cpu.cores ? `${m.cpu.cores} núcleos` : ''),
        meter('mem', 'Memória', m.mem.percent, `${m.mem.usedGB} de ${m.mem.totalGB} GB`),
      ];
      if (m.gpu) {
        const vram = m.gpu.vramTotalMB ? `${(m.gpu.vramUsedMB / 1024).toFixed(1)}/${(m.gpu.vramTotalMB / 1024).toFixed(1)} GB` : '';
        const sub = [m.gpu.name, m.gpu.tempC ? `${m.gpu.tempC}°C` : '', vram].filter(Boolean).join(' · ');
        rows.push(meter('gpu', 'GPU', m.gpu.percent, sub));
      }
      $('#sysMeters').innerHTML = rows.join('');
      $('#sysBlock').hidden = false;
    } catch {
      $('#sysBlock').hidden = true;
    }
  }
  function updateMonitor() {
    const active = currentView === 'home' && document.body.classList.contains('is-expanded') && info && info.platform === 'win32';
    if (active && !monTimer) {
      pollMonitor();
      monTimer = setInterval(pollMonitor, 2000);
    } else if (!active && monTimer) {
      clearInterval(monTimer);
      monTimer = null;
    }
  }

  // ------------------------------------------------------------------ timer e pomodoro
  const T = {
    remaining: 25 * 60,
    total: 25 * 60,
    running: false,
    endAt: 0,
    tick: null,
    pomo: false,
    phase: 'focus', // focus | short | long
    focusCount: 0,
    label: 'Pronto',
  };
  const PHASE = { focus: { min: 25, name: 'Foco' }, short: { min: 5, name: 'Pausa curta' }, long: { min: 15, name: 'Pausa longa' } };
  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    const mm = T.total >= 3600 ? String(Math.floor(sec / 60)).padStart(2, '0') : String(m).padStart(2, '0');
    return `${mm}:${String(s).padStart(2, '0')}`;
  }
  function paintTimer() {
    $('#timerDisplay').textContent = fmt(T.remaining);
    $('#timerDisplay').classList.toggle('ending', T.running && T.remaining <= 10);
    $('#timerSub').textContent = T.pomo ? `Pomodoro — ${PHASE[T.phase].name}` : T.label;
    const t = $('#timerToggle');
    t.setAttribute('aria-label', T.running ? 'Pausar' : 'Começar');
    $('use', t).setAttribute('href', T.running ? '#i-pause' : '#i-play');
    const badge = $('.rail-btn[data-view="timer"] .count');
    if (T.running) {
      badge.hidden = false;
      badge.textContent = T.remaining >= 60 ? `${Math.ceil(T.remaining / 60)}` : `${Math.ceil(T.remaining)}s`;
    } else badge.hidden = true;
    if (T.pomo) $('#pomoToggle').textContent = 'Parar Pomodoro';
    else $('#pomoToggle').textContent = 'Iniciar Pomodoro';
    $('#pomoStatus').textContent = T.pomo ? `Focos concluídos: ${T.focusCount}` : '';
  }
  function setTimer(min, label) {
    stopTick();
    T.total = Math.round(min * 60);
    T.remaining = T.total;
    T.running = false;
    T.pomo = false;
    T.label = label || `${min} min`;
    paintTimer();
  }
  function stopTick() {
    clearInterval(T.tick);
    T.tick = null;
    T.running = false;
  }
  function startTick() {
    if (T.remaining <= 0) return;
    T.running = true;
    T.endAt = Date.now() + T.remaining * 1000;
    clearInterval(T.tick);
    T.tick = setInterval(() => {
      T.remaining = (T.endAt - Date.now()) / 1000;
      if (T.remaining <= 0) {
        T.remaining = 0;
        finishTimer();
      }
      paintTimer();
    }, 250);
    paintTimer();
  }
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const notes = [880, 1174];
      notes.forEach((f, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        o.type = 'sine';
        o.connect(g);
        g.connect(ctx.destination);
        const t0 = ctx.currentTime + i * 0.22;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.start(t0);
        o.stop(t0 + 0.22);
      });
      setTimeout(() => ctx.close(), 800);
    } catch { /* sem áudio */ }
  }
  function finishTimer() {
    stopTick();
    beep();
    api.expand('timer');
    if (T.pomo) {
      const wasFocus = T.phase === 'focus';
      if (wasFocus) T.focusCount += 1;
      const done = wasFocus ? 'Foco concluído!' : 'Pausa encerrada!';
      api.notify('Lâmina — Pomodoro', wasFocus ? 'Hora da pausa.' : 'De volta ao foco.');
      toast(done, 4000);
      T.phase = wasFocus ? (T.focusCount % 4 === 0 ? 'long' : 'short') : 'focus';
      T.total = PHASE[T.phase].min * 60;
      T.remaining = T.total;
      paintTimer();
      startTick();
    } else {
      api.notify('Lâmina', `${T.label} — tempo esgotado.`);
      toast(`${T.label}: tempo esgotado`, 4000);
      T.remaining = T.total;
      paintTimer();
    }
  }
  $('#timerToggle').addEventListener('click', () => {
    if (T.running) {
      stopTick();
      paintTimer();
    } else {
      if (T.remaining <= 0) T.remaining = T.total;
      startTick();
    }
  });
  $('#timerReset').addEventListener('click', () => {
    stopTick();
    T.remaining = T.total;
    paintTimer();
  });
  $('#timerStop').addEventListener('click', () => {
    T.pomo = false;
    setTimer(25, 'Pronto');
  });
  $$('#view-timer .chip[data-min]').forEach((c) =>
    c.addEventListener('click', () => {
      setTimer(Number(c.dataset.min));
      startTick();
    })
  );
  $('#timerCustomForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const min = Math.max(1, Math.min(600, Number($('#timerCustom').value) || 0));
    if (!min) return;
    setTimer(min);
    startTick();
  });
  $('#pomoToggle').addEventListener('click', () => {
    if (T.pomo) {
      T.pomo = false;
      setTimer(25, 'Pronto');
      return;
    }
    T.pomo = true;
    T.phase = 'focus';
    T.focusCount = 0;
    T.total = PHASE.focus.min * 60;
    T.remaining = T.total;
    startTick();
  });

  // ------------------------------------------------------------------ ajustes
  function applySettingsToForm() {
    $$('input[name="side"]').forEach((r) => (r.checked = r.value === settings.side));
    $('#setShortcut').value = settings.shortcut;
    $('#setGlass').value = settings.glass;
    $('#setInterval').value = String(settings.updateIntervalMin);
    $$('[data-setting]').forEach((el) => (el.checked = !!settings[el.dataset.setting]));
    document.body.classList.toggle('reduce-motion', !!settings.reducedMotion);
    const hint = $('#glassHint');
    hint.textContent = info.nativeGlassSupported
      ? 'O fosco do Windows 11 desfoca o que está atrás da barra. O simulado usa um vidro escuro sem desfoque.'
      : 'Este Windows não tem o desfoque nativo (precisa do Windows 11 22H2 ou mais novo), então a barra usa o vidro simulado.';
  }

  async function save(patch) {
    const res = await api.setSettings(patch);
    settings = res.settings;
    applySettingsToForm();
    if (!res.ok && res.error) toast(res.error, 4000);
    if (res.restartNeeded) $('#restartBtn').hidden = false;
    return res;
  }
  $$('input[name="side"]').forEach((r) => r.addEventListener('change', () => r.checked && save({ side: r.value })));
  $('#setShortcut').addEventListener('change', async (e) => {
    const res = await save({ shortcut: e.target.value });
    if (res.ok) toast(`Atalho: ${e.target.selectedOptions[0].textContent}`);
  });
  $('#setGlass').addEventListener('change', (e) => save({ glass: e.target.value }));
  $('#setInterval').addEventListener('change', (e) => save({ updateIntervalMin: Number(e.target.value) }));
  $$('[data-setting]').forEach((el) => el.addEventListener('change', () => save({ [el.dataset.setting]: el.checked })));
  $('#restartBtn').addEventListener('click', () => api.restart());
  $('#quitBtn').addEventListener('click', () => api.quit());

  // ------------------------------------------------------------------ atualização
  function renderUpdate(st) {
    const el = $('#updStatus');
    const install = $('#installUpdate');
    const check = $('#checkUpdate');
    el.className = 'upd-status';
    install.hidden = true;
    check.disabled = false;
    switch (st && st.state) {
      case 'checking':
        el.textContent = 'Procurando atualização…';
        check.disabled = true;
        break;
      case 'latest':
        el.textContent = `Você está na versão mais nova. Última checagem às ${new Date(st.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`;
        el.classList.add('ok');
        break;
      case 'downloading':
        el.textContent = `Baixando a versão ${st.version || 'nova'}… ${st.percent || 0}%`;
        check.disabled = true;
        break;
      case 'ready':
        el.textContent = settings.autoInstall
          ? `Versão ${st.version} pronta. Instala sozinha quando a barra recolher.`
          : `Versão ${st.version} pronta para instalar.`;
        el.classList.add('ok');
        install.hidden = false;
        break;
      case 'installing':
        el.textContent = `Instalando a versão ${st.version}. A Lâmina volta em instantes.`;
        check.disabled = true;
        break;
      case 'error':
        el.textContent = st.message;
        el.classList.add('warn');
        break;
      case 'dev':
        el.textContent = st.message;
        break;
      default:
        el.textContent = 'Ainda não procurou atualização nesta sessão.';
    }
  }
  api.onUpdateStatus((st) => {
    renderUpdate(st);
    if (st.state === 'installing') {
      api.expand();
      toast(`Atualizando para a versão ${st.version}…`, 5000);
    }
  });
  $('#checkUpdate').addEventListener('click', async () => renderUpdate(await api.update.check()));
  $('#installUpdate').addEventListener('click', () => api.update.install());

  // ------------------------------------------------------------------ início
  (async function init() {
    info = await api.info();
    settings = info.settings;
    document.body.classList.remove('glass-native', 'glass-simulated');
    document.body.classList.add(`glass-${info.glassMode}`);
    $('#appVersion').textContent = info.version;
    applySettingsToForm();
    renderUpdate(info.updateStatus);
    paintTimer();
    openView('home');
    renderWaFeed();
    loadClip();
    if (settings.preloadWhatsApp) ensureWebview('whatsapp');
    if (info.platform === 'win32') {
      loadApps();
      loadSteam();
    }
  })();
})();
