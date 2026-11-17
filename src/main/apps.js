'use strict';
// Lista os apps instalados (os mesmos do Menu Iniciar, incluindo apps da Microsoft Store)
// e abre o app escolhido.
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app, shell } = require('electron');

let cache = null;
const iconCache = new Map();

const SKIP = /(uninstall|desinstal|readme|leia-me|leiame|help|ajuda|website|site da web|release notes|manual)/i;

function startMenuDirs() {
  return [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
}

function walk(dir, depth, out) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1, out);
    else if (/\.(lnk|url|appref-ms)$/i.test(e.name)) out.push(full);
  }
}

function scanShortcuts() {
  const files = [];
  for (const d of startMenuDirs()) walk(d, 0, files);
  const map = new Map();
  for (const f of files) {
    const name = path.basename(f).replace(/\.(lnk|url|appref-ms)$/i, '');
    if (SKIP.test(name)) continue;
    const key = name.toLowerCase();
    if (!map.has(key)) map.set(key, f);
  }
  return map;
}

function getStartApps() {
  return new Promise((resolve) => {
    const cmd =
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        try {
          const parsed = JSON.parse(stdout.toString().trim());
          resolve(Array.isArray(parsed) ? parsed : [parsed]);
        } catch {
          resolve([]);
        }
      }
    );
  });
}

async function list(refresh = false) {
  if (cache && !refresh) return cache;
  if (process.platform !== 'win32') {
    cache = [];
    return cache;
  }
  const shortcuts = scanShortcuts();
  const startApps = await getStartApps();
  const result = [];
  const seen = new Set();

  for (const a of startApps) {
    if (!a || !a.Name || SKIP.test(a.Name)) continue;
    const key = a.Name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `app:${a.AppID}`, name: a.Name, lnk: shortcuts.get(key) || null, appId: a.AppID });
  }
  // Atalhos que o Get-StartApps não trouxe (ou se o PowerShell falhou)
  for (const [key, file] of shortcuts) {
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ id: `lnk:${file}`, name: path.basename(file).replace(/\.(lnk|url|appref-ms)$/i, ''), lnk: file, appId: null });
  }
  result.sort((x, y) => x.name.localeCompare(y.name, 'pt-BR'));
  cache = result;
  return cache;
}

async function icon(id) {
  if (iconCache.has(id)) return iconCache.get(id);
  const item = (cache || []).find((a) => a.id === id);
  let dataUrl = null;
  if (item && item.lnk) {
    const candidates = [];
    if (/\.lnk$/i.test(item.lnk)) {
      try {
        const link = shell.readShortcutLink(item.lnk);
        if (link.target) candidates.push(link.target);
        if (link.icon) candidates.push(link.icon);
      } catch {
        /* atalho sem alvo legível */
      }
    }
    candidates.push(item.lnk);
    for (const c of candidates) {
      try {
        const img = await app.getFileIcon(c, { size: 'normal' });
        if (img && !img.isEmpty()) {
          dataUrl = img.toDataURL();
          break;
        }
      } catch {
        /* tenta o próximo */
      }
    }
  }
  iconCache.set(id, dataUrl);
  return dataUrl;
}

async function launch(id) {
  const item = (cache || []).find((a) => a.id === id);
  if (!item) return false;
  if (item.lnk) {
    const err = await shell.openPath(item.lnk);
    if (!err) return true;
  }
  if (item.appId) {
    spawn('explorer.exe', [`shell:AppsFolder\\${item.appId}`], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  return false;
}

module.exports = { list, icon, launch };
