'use strict';
// Atualização automática pelas Releases do GitHub.
// Cada push na branch main gera uma release nova (ver .github/workflows/release.yml).
// O app checa de tempos em tempos, baixa em segundo plano e reinicia sozinho
// quando a barra não está em uso.
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');

let ctx = null; // { send, isBusy, beforeQuit, getSettings }
let timer = null;
let pendingInstall = false;
let waitTimer = null;
let lastStatus = { state: 'idle' };

function emit(status) {
  lastStatus = { ...status, at: Date.now() };
  if (ctx) ctx.send('update:status', lastStatus);
}

function init(context) {
  ctx = context;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => emit({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => emit({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('update-not-available', () => emit({ state: 'latest' }));
  autoUpdater.on('download-progress', (p) =>
    emit({ state: 'downloading', version: lastStatus.version, percent: Math.round(p.percent || 0) })
  );
  autoUpdater.on('error', (err) => emit({ state: 'error', message: friendlyError(err) }));
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'ready', version: info.version });
    if (ctx.getSettings().autoInstall) {
      pendingInstall = true;
      installWhenIdle();
    }
  });

  schedule();
  // Primeira checagem logo depois de abrir
  setTimeout(() => check(), 8000);
}

function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(msg)) return 'Sem conexão com o GitHub. Tento de novo na próxima checagem.';
  if (/404/.test(msg)) return 'Nenhuma versão publicada ainda no GitHub.';
  return msg.split('\n')[0].slice(0, 160) || 'Erro desconhecido ao buscar atualização.';
}

function schedule() {
  clearInterval(timer);
  const minutes = Math.max(5, Number(ctx.getSettings().updateIntervalMin) || 30);
  timer = setInterval(() => check(), minutes * 60 * 1000);
}

async function check(manual = false) {
  if (!app.isPackaged) {
    emit({ state: 'dev', message: 'Modo de desenvolvimento: atualização só funciona no app instalado.' });
    return lastStatus;
  }
  if (lastStatus.state === 'downloading' || lastStatus.state === 'ready') {
    if (manual) emit(lastStatus);
    return lastStatus;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    emit({ state: 'error', message: friendlyError(err) });
  }
  return lastStatus;
}

function installWhenIdle() {
  clearTimeout(waitTimer);
  if (!pendingInstall) return;
  if (ctx.isBusy()) {
    // Barra aberta e em uso: espera recolher (o main chama notifyIdle) ou tenta de novo em 1 min
    waitTimer = setTimeout(installWhenIdle, 60 * 1000);
    return;
  }
  installNow();
}

function notifyIdle() {
  if (pendingInstall) {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(installWhenIdle, 1500);
  }
}

function installNow() {
  if (lastStatus.state !== 'ready') return false;
  emit({ state: 'installing', version: lastStatus.version });
  setTimeout(() => {
    ctx.beforeQuit();
    // silencioso + reabre o app sozinho depois de instalar
    autoUpdater.quitAndInstall(true, true);
  }, 900);
  return true;
}

module.exports = { init, check, schedule, installNow, notifyIdle, status: () => lastStatus };
