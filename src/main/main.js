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
} = require('electron');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createStore } = require('./store');
const apps = require('./apps');
const updater = require('./updater');

const APP_ID = 'com.andreunicos.lamina';
const ASSETS = path.join(__dirname, '..', 'assets');

// ---------------------------------------------------------------------------
// Instância única
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

// User agent de Chrome comum: alguns sites (WhatsApp Web, login do Google)
// recusam navegadores que se identificam como Electron.
const CHROME_MAJOR = String(process.versions.chrome || '140').split('.')[0];
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
app.userAgentFallback = CHROME_UA;

const PARTITIONS = ['persist:whatsapp', 'persist:music', 'persist:chatgpt', 'persist:gemini'];
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
  shortcut: 'Control+Alt+Space',
  hoverOpen: false,
  collapseOnBlur: true,
  openAtLogin: true,
  glass: 'auto', // auto | native | simulated
  updateIntervalMin: 30,
  autoInstall: true,
  preloadWhatsApp: true,
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

const PANEL_WIDTH = 400;
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
function expandedBounds() {
  const wa = targetDisplay().workArea;
  const h = wa.height - MARGIN * 2;
  const x = settings.get('side') === 'left' ? wa.x + MARGIN : wa.x + wa.width - PANEL_WIDTH - MARGIN;
  return { x, y: wa.y + MARGIN, width: PANEL_WIDTH, height: h };
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
  state = 'collapsed';
  lastCollapseAt = Date.now();
  const b = expandedBounds();
  animate({ ...b, x: b.x + slideOffset() }, b.x, 1, 0, 140, () => {
    send('state', state);
    setTimeout(() => {
      if (!win || win.isDestroyed() || state !== 'collapsed') return;
      win.setBounds(collapsedBounds());
      win.setOpacity(1);
      win.showInactive();
      updater.notifyIdle();
    }, 40);
  });
}

function hideAll() {
  if (!win) return;
  state = 'hidden';
  send('state', 'collapsed');
  win.hide();
  updater.notifyIdle();
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
      if (BrowserWindow.getFocusedWindow()) return;
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
    win.showInactive();
    if (!settings.get('firstRunDone')) {
      settings.set('firstRunDone', true);
      setTimeout(() => expand('home'), 400);
    }
  });
}

// Webviews: pop-ups de login ficam dentro do app; outros links vão pro navegador
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
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
  }
}

// ---------------------------------------------------------------------------
// Atalho global, bandeja, inicialização
// ---------------------------------------------------------------------------
function registerShortcut(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return true;
  try {
    return globalShortcut.register(accel, toggle);
  } catch {
    return false;
  }
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
    if (state === 'hidden') {
      state = 'collapsed';
      win.setBounds(collapsedBounds());
      win.showInactive();
    }
    toggle();
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
    return result;
  });

  // Notas
  ipcMain.handle('notes:list', () => notes.get('items'));
  ipcMain.handle('notes:save', (_e, note) => {
    const items = notes.get('items');
    const now = Date.now();
    const body = String(note.body || '');
    const idx = items.findIndex((n) => n.id === note.id);
    const saved = { id: note.id || `n${now.toString(36)}`, body, title: noteTitle(body), updated: now };
    if (idx >= 0) items.splice(idx, 1);
    items.unshift(saved);
    notes.set('items', items);
    return saved;
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

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------
app.on('second-instance', () => expand());

app.whenReady().then(() => {
  settings = createStore('settings', SETTINGS_DEFAULTS);
  notes = createStore('notes', { items: [] });

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
