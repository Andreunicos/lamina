'use strict';
const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  shell,
  session,
  Notification,
  protocol,
  net,
  clipboard,
  dialog,
} = require('electron');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createStore } = require('./store');
const apps = require('./apps');
const steam = require('./steam');
const clip = require('./clip');
const sysmon = require('./sysmon');
const obsidian = require('./obsidian');
const updater = require('./updater');

const APP_ID = 'com.andreunicos.lamina';
const ASSETS = path.join(__dirname, '..', 'assets');

// Memória: expõe o coletor de lixo do V8 (window.gc) nos processos renderer.
// O renderer da barra chama isso ao recolher para compactar o heap ocioso.
// (O flag só alcança os renderers, que nascem depois daqui; não cria dependência
// nova nem muda o visual.)
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// ---------------------------------------------------------------------------
// Instância única
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

// Imagens das notas ficam em %APPDATA%/Lamina/notes-images e são servidas por lamina-img://img/<arquivo>
protocol.registerSchemesAsPrivileged([
  { scheme: 'lamina-img', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
const IMG_NAME = /^[a-f0-9]{16}\.png$/;
const imagesDir = () => path.join(app.getPath('userData'), 'notes-images');
const imagePath = (name) => (IMG_NAME.test(String(name)) ? path.join(imagesDir(), name) : null);
let dialogOpen = false;

// User agent de Chrome comum: alguns sites (WhatsApp Web, login do Google)
// recusam navegadores que se identificam como Electron.
const CHROME_MAJOR = String(process.versions.chrome || '140').split('.')[0];
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const PARTITIONS = ['persist:whatsapp', 'persist:music', 'persist:chatgpt', 'persist:gemini', 'persist:steam', 'persist:discord'];
const ALLOWED_PERMISSIONS = new Set([
  'notifications',
  'media',
  'clipboard-sanitized-write',
  'clipboard-read',
  'fullscreen',
  'mediaKeySystem',
]);
// Janelas pop-up permitidas (logins). O resto abre no navegador padrão.
const POPUP_HOSTS = /(^|\.)(accounts\.google\.com|auth\.openai\.com|auth0\.openai\.com|login\.live\.com|appleid\.apple\.com|accounts\.youtube\.com)$/i;

const SETTINGS_DEFAULTS = {
  side: 'right',
  shortcut: 'Alt+Quote',
  hoverOpen: false,
  collapseOnBlur: true,
  openAtLogin: true,
  glass: 'auto', // auto | native | simulated
  updateIntervalMin: 30,
  autoInstall: true,
  preloadWhatsApp: true,
  panelWidth: 440,
  immersive: false,
  clipboardHistory: true,
  memorySaver: true,
  bgNotifications: true,
  lastVault: null,
  reducedMotion: false,
  lastVersion: null,
  firstRunDone: false,
};

let settings;
let notes;
let win = null;
let tray = null;
let state = 'collapsed'; // collapsed | expanded | hidden
let pinned = false;
let isQuitting = false;
let animTimer = null;

const PANEL_WIDTH = 440;
const MIN_WIDTH = 340;
const MAX_WIDTH = 1100;
const MARGIN = 12;
const HANDLE = { w: 12, h: 150 };

// ---------------------------------------------------------------------------
// Vidro: nativo (Acrylic do Windows 11) ou simulado
// ---------------------------------------------------------------------------
function windowsBuild() {
  if (process.platform !== 'win32') return 0;
  return parseInt(os.release().split('.')[2] || '0', 10);
}
function nativeGlassSupported() {
  return windowsBuild() >= 22621; // Windows 11 22H2+
}
function glassMode() {
  const g = settings.get('glass');
  if (g === 'simulated') return 'simulated';
  return nativeGlassSupported() ? 'native' : 'simulated';
}

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------
function targetDisplay() {
  return screen.getPrimaryDisplay();
}
function clampWidth(w) {
  const wa = targetDisplay().workArea;
  const max = Math.min(MAX_WIDTH, wa.width - MARGIN * 2 - 40);
  return Math.round(Math.max(MIN_WIDTH, Math.min(max, Number(w) || PANEL_WIDTH)));
}
function expandedBounds(width) {
  const wa = targetDisplay().workArea;
  const w = clampWidth(width || settings.get('panelWidth'));
  const h = wa.height - MARGIN * 2;
  const x = settings.get('side') === 'left' ? wa.x + MARGIN : wa.x + wa.width - w - MARGIN;
  return { x, y: wa.y + MARGIN, width: w, height: h };
}
function collapsedBounds() {
  const wa = targetDisplay().workArea;
  const x = settings.get('side') === 'left' ? wa.x : wa.x + wa.width - HANDLE.w;
  return { x, y: Math.round(wa.y + wa.height / 2 - HANDLE.h / 2), width: HANDLE.w, height: HANDLE.h };
}
function slideOffset() {
  return settings.get('side') === 'left' ? -40 : 40;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------------------------------------------------------------------------
// Memória ociosa: ao recolher, o renderer já descarrega as webviews (fecha os
// processos Chromium, que são o grosso da RAM). Aqui liberamos o que SOBREVIVE a
// isso: os caches HTTP das sessões, que ficam no processo de rede compartilhado.
// Só limpa cache — cookies e login continuam salvos, então nada desloga; só o
// próximo carregamento vem da rede em vez do cache. (O heap do renderer da barra
// é compactado pelo próprio renderer com window.gc ao recolher.)
let freeIdleTimer = null;
function freeIdleMemory() {
  clearTimeout(freeIdleTimer);
  // Espera o renderer terminar de descarregar as webviews antes de limpar.
  freeIdleTimer = setTimeout(() => {
    if (state === 'expanded') return; // reabriu nesse meio tempo
    try {
      session.defaultSession.clearCache();
      for (const p of PARTITIONS) session.fromPartition(p).clearCache();
    } catch {
      /* sessão ocupada */
    }
  }, 2200);
}

// ---------------------------------------------------------------------------
// Animação de abrir/recolher (move a janela + opacidade)
// ---------------------------------------------------------------------------
function animate(target, fromX, fromOpacity, toOpacity, duration, done) {
  clearInterval(animTimer);
  if (settings.get('reducedMotion') || duration <= 0) {
    win.setBounds(target);
    win.setOpacity(toOpacity);
    if (done) done();
    return;
  }
  const start = Date.now();
  win.setBounds({ ...target, x: Math.round(fromX) });
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return clearInterval(animTimer);
    const t = Math.min(1, (Date.now() - start) / duration);
    const e = 1 - Math.pow(1 - t, 3);
    win.setBounds({ ...target, x: Math.round(fromX + (target.x - fromX) * e) });
    win.setOpacity(fromOpacity + (toOpacity - fromOpacity) * e);
    if (t >= 1) {
      clearInterval(animTimer);
      if (done) done();
    }
  }, 10);
}

function expand(view) {
  if (!win) return;
  if (view) send('view:open', view);
  if (state === 'expanded') {
    win.focus();
    return;
  }
  const b = expandedBounds();
  state = 'expanded';
  send('state', state);
  win.setOpacity(0);
  win.setBounds({ ...b, x: b.x + slideOffset() });
  win.show();
  win.focus();
  animate(b, b.x + slideOffset(), 0, 1, 190);
}

let lastCollapseAt = 0;
function collapse() {
  if (!win || state !== 'expanded') return;
  const immersive = settings.get('immersive');
  state = immersive ? 'hidden' : 'collapsed';
  lastCollapseAt = Date.now();
  const b = expandedBounds();
  animate({ ...b, x: b.x + slideOffset() }, b.x, 1, 0, 140, () => {
    send('state', 'collapsed');
    setTimeout(() => {
      if (!win || win.isDestroyed() || state === 'expanded') return;
      if (immersive) {
        win.hide(); // modo imersivo: some de vez, só volta com o atalho
      } else {
        win.setBounds(collapsedBounds());
        win.setOpacity(1);
        win.showInactive();
      }
      updater.notifyIdle();
      freeIdleMemory();
    }, 40);
  });
}

// Liga/desliga o modo imersivo na hora
function applyImmersive(on) {
  if (!win) return;
  if (on && state === 'collapsed') {
    state = 'hidden';
    win.hide();
  } else if (!on && state === 'hidden') {
    state = 'collapsed';
    win.setBounds(collapsedBounds());
    win.setOpacity(1);
    win.showInactive();
  }
  buildTrayMenu();
}

function hideAll() {
  if (!win) return;
  state = 'hidden';
  send('state', 'collapsed');
  win.hide();
  updater.notifyIdle();
  freeIdleMemory();
  buildTrayMenu();
}

function toggle() {
  if (state === 'expanded') collapse();
  // clicar na bandeja tira o foco e já recolhe; não reabrir no mesmo clique
  else if (Date.now() - lastCollapseAt > 350) expand();
}

function reposition() {
  if (!win) return;
  if (state === 'expanded') win.setBounds(expandedBounds());
  else if (state === 'collapsed') win.setBounds(collapsedBounds());
}

// ---------------------------------------------------------------------------
// Janela
// ---------------------------------------------------------------------------
function createWindow() {
  const mode = glassMode();
  const native = mode === 'native';
  win = new BrowserWindow({
    ...collapsedBounds(),
    title: 'Lâmina',
    frame: false,
    show: false,
    // resizable mantém a borda arredondada do Windows 11; o redimensionamento é bloqueado abaixo
    resizable: native,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: native,
    transparent: !native,
    backgroundColor: '#00000000',
    ...(native ? { backgroundMaterial: 'acrylic' } : {}),
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  win.on('will-resize', (e) => e.preventDefault());
  win.on('blur', () => {
    if (state !== 'expanded' || !settings.get('collapseOnBlur') || pinned) return;
    setTimeout(() => {
      // Não recolhe se o foco foi para uma janela do próprio app (ex.: pop-up de login)
      if (BrowserWindow.getFocusedWindow() || dialogOpen) return;
      if (state === 'expanded') collapse();
    }, 60);
  });
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      collapse();
    }
  });

  // Só deixa anexar webviews com as partições e o preload que o app conhece
  win.webContents.on('will-attach-webview', (e, webPreferences, params) => {
    const okPartition = PARTITIONS.includes(params.partition);
    const okUrl = /^https:\/\//i.test(params.src || '');
    if (!okPartition || !okUrl) return e.preventDefault();
    const ourPreload = pathToFileURL(path.join(__dirname, '..', 'preload', 'webview-preload.js')).href;
    if (params.preload && params.preload !== ourPreload) delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), {
    query: { glass: mode, side: settings.get('side') },
  });
  win.once('ready-to-show', () => {
    if (!settings.get('firstRunDone')) {
      settings.set('firstRunDone', true);
      win.showInactive();
      setTimeout(() => expand('home'), 400);
    } else if (settings.get('immersive')) {
      state = 'hidden'; // imersivo: começa invisível, só abre no atalho
    } else {
      win.showInactive();
    }
  });
}

// Login do Google: o Google recusa navegadores "embutidos" baseados em Chromium
// ("Esse navegador ou app pode não ser seguro"). Nas páginas de login do Google o app
// se identifica como Firefox, que o Google aceita; fora delas volta a ser Chrome.
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0';
const GOOGLE_LOGIN = /^https:\/\/accounts\.google\.com\//i;
const SERVICE_RETURN = /(gemini\.google\.com|chatgpt\.com|chat\.openai\.com|steamcommunity\.com|youtube\.com|music\.youtube\.com)$/i;

function applyLoginUserAgent(contents, url) {
  try {
    const want = GOOGLE_LOGIN.test(url) ? FIREFOX_UA : CHROME_UA;
    if (contents.getUserAgent() !== want) contents.setUserAgent(want);
  } catch {
    /* webContents já fechado */
  }
}

function isGoogleServiceSession(contents) {
  try {
    const s = contents.session;
    return s === session.fromPartition('persist:gemini') || s === session.fromPartition('persist:chatgpt') || s === session.fromPartition('persist:music');
  } catch {
    return false;
  }
}

// O Google recusa login dentro de janela embutida. A solução que costuma passar é
// abrir o login numa janela de verdade, separada, usando a mesma sessão da aba — assim
// o cookie da conta volta para a aba e ela fica logada.
let googleLoginWin = null;
function openGoogleLoginWindow(sourceContents, url) {
  if (googleLoginWin && !googleLoginWin.isDestroyed()) {
    googleLoginWin.focus();
    googleLoginWin.loadURL(url, { userAgent: FIREFOX_UA });
    return;
  }
  googleLoginWin = new BrowserWindow({
    width: 520,
    height: 650,
    title: 'Entrar com o Google',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { session: sourceContents.session, nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  googleLoginWin.setMenuBarVisibility(false);
  const wc = googleLoginWin.webContents;
  try {
    wc.setUserAgent(FIREFOX_UA);
  } catch { /* ignora */ }
  const backToService = () => {
    let host = '';
    try {
      host = new URL(wc.getURL()).hostname;
    } catch {
      return;
    }
    if (SERVICE_RETURN.test(host)) {
      if (sourceContents && !sourceContents.isDestroyed()) sourceContents.reload();
      if (googleLoginWin && !googleLoginWin.isDestroyed()) googleLoginWin.close();
    }
  };
  wc.on('did-navigate', backToService);
  googleLoginWin.on('closed', () => {
    googleLoginWin = null;
  });
  googleLoginWin.loadURL(url, { userAgent: FIREFOX_UA });
}

// Webviews: pop-ups de login ficam dentro do app; outros links vão pro navegador
app.on('web-contents-created', (_e, contents) => {
  const type = contents.getType();
  if (type === 'webview' || type === 'window') {
    contents.on('did-start-navigation', (e, legacyUrl, _inPlace, legacyMain) => {
      const url = (e && e.url) || legacyUrl || '';
      const isMain = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : legacyMain;
      if (isMain) applyLoginUserAgent(contents, url);
    });
  }
  if (type !== 'webview') return;
  // Login do Google dentro da aba (ex.: Gemini): tira para uma janela separada
  contents.on('will-navigate', (e, url) => {
    if (GOOGLE_LOGIN.test(url) && isGoogleServiceSession(contents)) {
      e.preventDefault();
      openGoogleLoginWindow(contents, url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return { action: 'deny' };
    }
    if (POPUP_HOSTS.test(host)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 680,
          alwaysOnTop: true,
          autoHideMenuBar: true,
          title: 'Entrar',
          webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
});

function setupSessions() {
  for (const p of PARTITIONS) {
    const ses = session.fromPartition(p);
    ses.setUserAgent(CHROME_UA);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    // Cabeçalhos das páginas de login do Google: Firefox e sem as "client hints" do Chromium
    ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, cb) => {
      const headers = details.requestHeaders;
      for (const k of Object.keys(headers)) {
        if (/^user-agent$/i.test(k) || /^sec-ch-ua/i.test(k)) delete headers[k];
      }
      headers['User-Agent'] = FIREFOX_UA;
      cb({ requestHeaders: headers });
    });
    // Script que tira a "assinatura" do Chromium do navegador nas páginas de login
    const loginPreload = path.join(__dirname, '..', 'preload', 'login-preload.js');
    try {
      if (typeof ses.registerPreloadScript === 'function') {
        ses.registerPreloadScript({ type: 'frame', id: 'lamina-login', filePath: loginPreload });
      } else {
        ses.setPreloads([loginPreload]);
      }
    } catch (err) {
      console.error('[preload login]', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Atalho global, bandeja, inicialização
// ---------------------------------------------------------------------------
// "Alt+Quote" = Alt + tecla de aspas. No teclado ABNT2 essa tecla (ao lado do 1) é a
// mesma posição do ` no teclado americano; no americano as aspas ficam ao lado do Enter.
// Registra as duas para funcionar em qualquer layout.
const SHORTCUT_ALIASES = {
  'Alt+Quote': ['Alt+`', "Alt+'"],
};

function registerShortcut(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return true;
  const list = SHORTCUT_ALIASES[accel] || [accel];
  let ok = false;
  for (const a of list) {
    try {
      if (globalShortcut.register(a, toggle)) ok = true;
    } catch {
      /* acelerador inválido neste sistema */
    }
  }
  return ok;
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: !!settings.get('openAtLogin') });
}

function buildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: state === 'expanded' ? 'Recolher' : 'Abrir', click: toggle },
    {
      label: state === 'hidden' ? 'Mostrar alça na borda' : 'Esconder alça da borda',
      click: () => {
        if (state === 'hidden') {
          state = 'collapsed';
          win.setBounds(collapsedBounds());
          win.showInactive();
        } else hideAll();
        buildTrayMenu();
      },
    },
    { type: 'separator' },
    { label: 'Verificar atualização', click: () => updater.check(true) },
    { label: `Versão ${app.getVersion()}`, enabled: false },
    { type: 'separator' },
    { label: 'Reiniciar', click: restart },
    { label: 'Sair', click: quit },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('Lâmina');
  tray.on('click', () => {
    if (state === 'expanded') collapse();
    else expand();
    buildTrayMenu();
  });
  buildTrayMenu();
}

function beforeQuit() {
  isQuitting = true;
  try {
    settings.flush();
    notes.flush();
  } catch {
    /* ignora */
  }
  globalShortcut.unregisterAll();
  if (tray) tray.destroy();
}

function quit() {
  beforeQuit();
  app.quit();
}

function restart() {
  beforeQuit();
  app.relaunch();
  app.exit(0);
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function noteTitle(body) {
  const first = String(body || '').split('\n').find((l) => l.trim()) || '';
  return first.trim().slice(0, 80);
}

function setupIpc() {
  ipcMain.on('win:expand', (_e, view) => expand(view));
  ipcMain.on('win:collapse', () => collapse());
  ipcMain.on('win:hover', () => {
    if (settings.get('hoverOpen') && state === 'collapsed') expand();
  });
  ipcMain.on('win:pin', (_e, value) => {
    pinned = !!value;
  });
  ipcMain.on('win:hide', () => hideAll());
  // Arrastar a borda interna muda a largura (a borda grudada na tela fica parada)
  ipcMain.on('win:set-width', (_e, width, done) => {
    if (!win || state !== 'expanded') return;
    const b = expandedBounds(clampWidth(width));
    win.setBounds(b);
    if (done) settings.set('panelWidth', b.width);
  });

  // Steam
  ipcMain.handle('steam:list', (_e, refresh) => steam.list(!!refresh));
  ipcMain.handle('steam:launch', (_e, appid) => {
    const ok = steam.launch(appid);
    if (ok) collapse();
    return ok;
  });
  ipcMain.handle('steam:open', (_e, page) => {
    const ok = steam.open(page);
    if (ok) collapse();
    return ok;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    glassMode: glassMode(),
    nativeGlassSupported: nativeGlassSupported(),
    packaged: app.isPackaged,
    webviewPreload: pathToFileURL(path.join(__dirname, '..', 'preload', 'webview-preload.js')).href,
    settings: settings.get(),
    updateStatus: updater.status(),
  }));
  ipcMain.handle('app:restart', () => restart());
  ipcMain.handle('app:quit', () => quit());
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  });

  ipcMain.handle('settings:set', (_e, patch) => {
    const clean = {};
    for (const k of Object.keys(patch || {})) if (k in SETTINGS_DEFAULTS) clean[k] = patch[k];
    const prev = settings.get();
    settings.set(clean);
    const result = { ok: true, settings: settings.get(), restartNeeded: false };
    if ('side' in clean && clean.side !== prev.side) {
      reposition();
      send('side', clean.side);
    }
    if ('shortcut' in clean && clean.shortcut !== prev.shortcut) {
      if (!registerShortcut(clean.shortcut)) {
        settings.set('shortcut', prev.shortcut);
        registerShortcut(prev.shortcut);
        result.ok = false;
        result.error = 'Esse atalho já está em uso por outro programa. Escolha outro.';
        result.settings = settings.get();
      }
    }
    if ('openAtLogin' in clean) applyLoginItem();
    if ('updateIntervalMin' in clean) updater.schedule();
    if ('glass' in clean && clean.glass !== prev.glass) result.restartNeeded = true;
    if ('immersive' in clean && clean.immersive !== prev.immersive) applyImmersive(clean.immersive);
    if ('clipboardHistory' in clean) clip.setEnabled(clean.clipboardHistory);
    return result;
  });

  // Área de transferência
  ipcMain.handle('clip:list', () => clip.list());
  ipcMain.handle('clip:restore', (_e, id) => clip.restore(id));
  ipcMain.handle('clip:remove', (_e, id) => clip.remove(id));
  ipcMain.handle('clip:clear', () => clip.clear());

  // Monitor do PC
  ipcMain.handle('monitor:read', () => sysmon.read());

  // Obsidian
  ipcMain.handle('obsidian:vaults', () => obsidian.vaults());
  ipcMain.handle('obsidian:save', (_e, note) => {
    const res = obsidian.save(note || {});
    if (res.ok && note && note.vaultPath) settings.set('lastVault', note.vaultPath);
    return res;
  });

  // Aviso (usado pelo timer)
  ipcMain.handle('app:notify', (_e, title, body) => {
    if (Notification.isSupported()) new Notification({ title: String(title || 'Lâmina'), body: String(body || '') }).show();
  });

  // Notas
  ipcMain.handle('notes:list', () => notes.get('items'));
  ipcMain.handle('notes:save', (_e, note) => {
    const items = notes.get('items');
    const now = Date.now();
    const body = String(note.body || '').slice(0, 500000);
    const html = typeof note.html === 'string' ? note.html.slice(0, 2000000) : null;
    const images = Array.isArray(note.images) ? note.images.filter((n) => IMG_NAME.test(n)).slice(0, 200) : [];
    const idx = items.findIndex((n) => n.id === note.id);
    const title = noteTitle(body) || (images.length ? (images.length > 1 ? `${images.length} imagens` : 'Imagem') : '');
    const saved = { id: note.id || `n${now.toString(36)}`, body, html, images, title, updated: now };
    if (idx >= 0) items.splice(idx, 1);
    items.unshift(saved);
    notes.set('items', items);
    return saved;
  });
  // Imagens das notas
  ipcMain.handle('notes:image-save', async (_e, bytes) => {
    try {
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      if (img.isEmpty()) return { ok: false, error: 'Esse formato de imagem não é aceito. Use PNG ou JPG.' };
      fs.mkdirSync(imagesDir(), { recursive: true });
      const name = `${crypto.randomBytes(8).toString('hex')}.png`;
      fs.writeFileSync(path.join(imagesDir(), name), img.toPNG());
      const { width, height } = img.getSize();
      return { ok: true, name, width, height };
    } catch (err) {
      return { ok: false, error: 'Não consegui salvar a imagem.' };
    }
  });
  ipcMain.handle('notes:image-copy', (_e, name) => {
    const file = imagePath(name);
    if (!file || !fs.existsSync(file)) return false;
    clipboard.writeImage(nativeImage.createFromPath(file));
    return true;
  });
  ipcMain.handle('notes:image-export', async (_e, name) => {
    const file = imagePath(name);
    if (!file || !fs.existsSync(file)) return false;
    dialogOpen = true;
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const res = await dialog.showSaveDialog(win, {
        title: 'Salvar imagem',
        defaultPath: path.join(app.getPath('pictures'), `lamina-${stamp}.png`),
        filters: [{ name: 'Imagem PNG', extensions: ['png'] }],
      });
      if (res.canceled || !res.filePath) return false;
      fs.copyFileSync(file, res.filePath);
      return true;
    } finally {
      dialogOpen = false;
      if (win && state === 'expanded') win.focus();
    }
  });
  // Arrastar a imagem da nota para outro app (Discord, WhatsApp, pasta, etc.)
  ipcMain.on('notes:image-drag', (e, name) => {
    const file = imagePath(name);
    if (!file || !fs.existsSync(file)) return;
    const icon = nativeImage.createFromPath(file).resize({ width: 96 });
    e.sender.startDrag({ file, icon });
  });

  ipcMain.handle('notes:delete', (_e, id) => {
    notes.set(
      'items',
      notes.get('items').filter((n) => n.id !== id)
    );
    return true;
  });

  // Apps
  ipcMain.handle('apps:list', (_e, refresh) => apps.list(!!refresh));
  ipcMain.handle('apps:icon', (_e, id) => apps.icon(id));
  ipcMain.handle('apps:launch', async (_e, id) => {
    const ok = await apps.launch(id);
    if (ok) collapse();
    return ok;
  });

  // Atualização
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:install', () => updater.installNow());
}

// Apaga imagens que nenhuma nota usa mais (de notas apagadas ou imagens removidas).
// Só roda ao abrir o app, para o Ctrl+Z no editor continuar funcionando durante o uso.
function cleanupImages() {
  try {
    const used = new Set();
    for (const n of notes.get('items')) for (const name of n.images || []) used.add(name);
    const dir = imagesDir();
    if (!fs.existsSync(dir)) return;
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!IMG_NAME.test(f) || used.has(f)) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).mtimeMs < dayAgo) fs.unlinkSync(full);
    }
  } catch (err) {
    console.error('[limpeza de imagens]', err);
  }
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
app.on('second-instance', () => expand());

app.whenReady().then(() => {
  settings = createStore('settings', SETTINGS_DEFAULTS);
  notes = createStore('notes', { items: [] });

  protocol.handle('lamina-img', (req) => {
    let file = null;
    try {
      const u = new URL(req.url);
      if (u.hostname === 'img') file = imagePath(u.pathname.replace(/^\//, ''));
      else if (u.hostname === 'clip') file = clip.imgPath(u.pathname.replace(/^\//, ''));
    } catch {
      /* URL inválida */
    }
    if (!file || !fs.existsSync(file)) return new Response('Imagem não encontrada', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  cleanupImages();

  clip.start({
    enabled: settings.get('clipboardHistory'),
    onChange: (listData) => send('clip:changed', listData),
  });

  setupSessions();
  setupIpc();
  createWindow();
  createTray();
  if (!registerShortcut(settings.get('shortcut'))) registerShortcut(SETTINGS_DEFAULTS.shortcut);
  applyLoginItem();

  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);

  updater.init({
    send,
    getSettings: () => settings.get(),
    isBusy: () => state === 'expanded' && win && win.isFocused(),
    beforeQuit,
  });

  // Aviso depois de uma atualização
  const version = app.getVersion();
  const last = settings.get('lastVersion');
  if (last && last !== version && Notification.isSupported()) {
    new Notification({ title: 'Lâmina atualizada', body: `Agora na versão ${version}.`, silent: true }).show();
    setTimeout(() => send('toast', `Atualizada para a versão ${version}`), 1500);
  }
  settings.set('lastVersion', version);
});

app.on('window-all-closed', (e) => {
  if (!isQuitting) e.preventDefault();
});
app.on('before-quit', () => {
  isQuitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
