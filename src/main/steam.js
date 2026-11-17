'use strict';
// Lê os jogos instalados da Steam direto dos arquivos da própria Steam
// (libraryfolders.vdf + appmanifest_*.acf) e abre jogos pelo protocolo steam://.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { shell } = require('electron');

const NOT_GAMES = new Set(['228980', '1070560', '1391110', '1493710', '1628350', '250820', '1826330']);
const NOT_GAMES_NAME = /(redistributable|steamvr|proton|steam linux runtime|soundtrack|dedicated server|\bsdk\b|wallpaper engine)/i;

const PAGES = {
  library: 'steam://open/games',
  store: 'steam://store',
  friends: 'steam://open/friends',
  downloads: 'steam://open/downloads',
  main: 'steam://open/main',
};

// Parser simples de VDF/KeyValues da Valve
function parseVdf(text) {
  let i = 0;
  const n = text.length;
  function skip() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\ufeff') i++;
      else if (c === '/' && text[i + 1] === '/') while (i < n && text[i] !== '\n') i++;
      else break;
    }
  }
  function str() {
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const nx = text[i + 1];
          s += nx === 'n' ? '\n' : nx === 't' ? '\t' : nx;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return s;
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return s;
  }
  function obj() {
    const o = {};
    for (;;) {
      skip();
      if (i >= n) return o;
      if (text[i] === '}') {
        i++;
        return o;
      }
      const key = str();
      skip();
      if (text[i] === '{') {
        i++;
        o[key] = obj();
      } else o[key] = str();
    }
  }
  return obj();
}

const lower = (o) => {
  const out = {};
  for (const k of Object.keys(o || {})) out[k.toLowerCase()] = o[k];
  return out;
};

function readVdf(file) {
  try {
    return parseVdf(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function regSteamPath() {
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(String(out));
      resolve(m ? m[1].trim().replace(/\//g, '\\') : null);
    });
  });
}

async function findSteam() {
  // pasta da Steam em outro lugar (ou para testes)
  if (process.env.LAMINA_STEAM_DIR && fs.existsSync(path.join(process.env.LAMINA_STEAM_DIR, 'steamapps'))) {
    return process.env.LAMINA_STEAM_DIR;
  }
  if (process.platform !== 'win32') return null;
  const candidates = [await regSteamPath(), 'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam', 'D:\\Steam', 'E:\\Steam'];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'steamapps'))) return c;
  }
  return null;
}

function lastPlayedMap(steamRoot) {
  const map = {};
  const userdata = path.join(steamRoot, 'userdata');
  let users = [];
  try {
    users = fs.readdirSync(userdata);
  } catch {
    return map;
  }
  for (const u of users) {
    const v = readVdf(path.join(userdata, u, 'config', 'localconfig.vdf'));
    if (!v) continue;
    try {
      const store = lower(v).userlocalconfigstore;
      const apps = lower(lower(lower(lower(store).software).valve).steam).apps || {};
      for (const id of Object.keys(apps)) {
        const lp = Number(lower(apps[id]).lastplayed || 0);
        if (lp > (map[id] || 0)) map[id] = lp;
      }
    } catch {
      /* formato inesperado */
    }
  }
  return map;
}

let cache = null;

async function list(refresh = false) {
  if (cache && !refresh) return cache;
  const root = await findSteam();
  if (!root) {
    cache = { installed: false, games: [] };
    return cache;
  }
  const libs = new Set([root]);
  const lf = readVdf(path.join(root, 'steamapps', 'libraryfolders.vdf'));
  if (lf) {
    const folders = lower(lf).libraryfolders || {};
    for (const k of Object.keys(folders)) {
      const entry = folders[k];
      const p = typeof entry === 'string' ? entry : lower(entry).path;
      if (p) libs.add(p.replace(/\//g, '\\'));
    }
  }
  const played = lastPlayedMap(root);
  const games = new Map();
  for (const lib of libs) {
    const dir = path.join(lib, 'steamapps');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^appmanifest_\d+\.acf$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const v = readVdf(path.join(dir, f));
      if (!v) continue;
      const st = lower(lower(v).appstate);
      const appid = String(st.appid || '');
      const name = st.name || '';
      if (!appid || !name || NOT_GAMES.has(appid) || NOT_GAMES_NAME.test(name)) continue;
      games.set(appid, {
        appid,
        name,
        lastPlayed: Math.max(Number(st.lastplayed || 0), played[appid] || 0),
        size: Number(st.sizeondisk || 0),
      });
    }
  }
  const arr = Array.from(games.values()).sort((a, b) => b.lastPlayed - a.lastPlayed || a.name.localeCompare(b.name, 'pt-BR'));
  cache = { installed: true, games: arr };
  return cache;
}

function launch(appid) {
  if (!/^\d+$/.test(String(appid))) return false;
  shell.openExternal(`steam://rungameid/${appid}`);
  return true;
}

function open(page) {
  const url = PAGES[page];
  if (!url) return false;
  shell.openExternal(url);
  return true;
}

module.exports = { list, launch, open, parseVdf };
