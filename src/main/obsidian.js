'use strict';
// Notas rápidas para o Obsidian: lê os cofres que o Obsidian já conhece
// (em %APPDATA%/obsidian/obsidian.json) e escreve um arquivo .md dentro do cofre escolhido.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function configFile() {
  return path.join(app.getPath('appData'), 'obsidian', 'obsidian.json');
}

function vaults() {
  try {
    const data = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const out = [];
    for (const [id, v] of Object.entries(data.vaults || {})) {
      if (v && v.path && fs.existsSync(v.path)) out.push({ id, path: v.path, name: path.basename(v.path), open: !!v.open });
    }
    // o cofre aberto por último primeiro
    out.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || a.name.localeCompare(b.name, 'pt-BR'));
    return out;
  } catch {
    return [];
  }
}

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function uniquePath(dir, base) {
  let file = path.join(dir, `${base}.md`);
  let i = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${base} ${i++}.md`);
  return file;
}

// Só deixa escrever dentro de um cofre que o Obsidian já conhece
function save({ vaultPath, title, body }) {
  const known = vaults().some((v) => v.path === vaultPath);
  if (!known) return { ok: false, error: 'Cofre não encontrado.' };
  try {
    const text = String(body || '');
    const firstLine = text.split('\n').find((l) => l.trim()) || '';
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
    const base = sanitize(title) || sanitize(firstLine) || `Nota rápida ${stamp}`;
    // Pasta Inbox se existir, senão a raiz do cofre
    const inbox = path.join(vaultPath, 'Inbox');
    const dir = fs.existsSync(inbox) && fs.statSync(inbox).isDirectory() ? inbox : vaultPath;
    const file = uniquePath(dir, base);
    const stampLine = now.toLocaleString('pt-BR');
    fs.writeFileSync(file, `${text.trim()}\n\n> Criada pela Lâmina em ${stampLine}\n`);
    return { ok: true, file: path.basename(file), vault: path.basename(vaultPath) };
  } catch (err) {
    return { ok: false, error: 'Não consegui escrever no cofre.' };
  }
}

module.exports = { vaults, save };
