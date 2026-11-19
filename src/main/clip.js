'use strict';
// Histórico da área de transferência: observa o que você copia (texto e imagens),
// guarda os últimos itens e deixa recopiar. Fica tudo só neste computador.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, clipboard, nativeImage } = require('electron');
const { createStore } = require('./store');

const MAX = 60;
const IMG_NAME = /^[a-f0-9]{16}\.png$/;

let store;
let items = [];
let timer = null;
let enabled = true;
let lastSig = '';
let lastImgPre = ''; // "impressão digital" barata da última imagem vista na área
let onChange = null;

const dir = () => path.join(app.getPath('userData'), 'clip-images');
const imgPath = (name) => (IMG_NAME.test(String(name)) ? path.join(dir(), name) : null);
const sha = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

function list() {
  return items.map((i) => ({ id: i.id, type: i.type, text: i.type === 'text' ? i.text : undefined, image: i.image, w: i.w, h: i.h, at: i.at }));
}
function emit() {
  if (onChange) onChange(list());
}
function persist() {
  store.set('items', items.slice(0, MAX));
}

function add(item) {
  items = items.filter((i) => i.sig !== item.sig);
  items.unshift(item);
  const overflow = items.slice(MAX);
  items = items.slice(0, MAX);
  for (const o of overflow) if (o.type === 'image' && o.image) safeUnlink(o.image);
  lastSig = item.sig;
  persist();
  emit();
}
function safeUnlink(name) {
  const p = imgPath(name);
  if (p) try { fs.unlinkSync(p); } catch { /* já apagado */ }
}

function poll() {
  if (!enabled) return;
  try {
    const formats = clipboard.availableFormats();
    if (formats.some((f) => f.startsWith('image/'))) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        // Pré-filtro barato (1 Hz): em vez de reencodar o PNG inteiro toda vez, faz o
        // hash de uma miniatura 16×16 (1 KB). Se a mesma imagem só está parada na área
        // de transferência, o hash bate e saímos sem encodar o PNG nem re-hashear tudo.
        let pre = '';
        try {
          pre = sha(img.resize({ width: 16, height: 16 }).toBitmap());
        } catch {
          /* resize indisponível: cai para o caminho completo */
        }
        if (pre && pre === lastImgPre) return; // imagem idêntica ainda na área: nada a fazer
        const png = img.toPNG();
        const sig = 'i:' + sha(png);
        lastImgPre = pre;
        if (sig !== lastSig) {
          fs.mkdirSync(dir(), { recursive: true });
          const name = `${crypto.randomBytes(8).toString('hex')}.png`;
          fs.writeFileSync(path.join(dir(), name), png);
          const { width, height } = img.getSize();
          add({ id: `c${Date.now().toString(36)}`, type: 'image', image: name, w: width, h: height, at: Date.now(), sig });
        } else {
          lastSig = sig;
        }
        return;
      }
    }
    lastImgPre = ''; // saiu uma imagem da área; a próxima será reavaliada do zero
    const text = clipboard.readText();
    if (text && text.trim()) {
      const sig = 't:' + sha(text);
      if (sig !== lastSig) add({ id: `c${Date.now().toString(36)}`, type: 'text', text: text.slice(0, 20000), at: Date.now(), sig });
    }
  } catch {
    /* clipboard ocupado por outro app */
  }
}

function start(opts) {
  onChange = opts.onChange;
  enabled = opts.enabled !== false;
  store = createStore('clipboard', { items: [] });
  items = (store.get('items') || []).filter((i) => i.type !== 'image' || (i.image && fs.existsSync(imgPath(i.image) || '')));
  lastSig = items[0] ? items[0].sig : '';
  // Não captura o que já estava copiado antes de abrir o app
  try {
    const t = clipboard.readText();
    if (t && t.trim()) lastSig = 't:' + sha(t);
  } catch { /* ignora */ }
  clearInterval(timer);
  timer = setInterval(poll, 1000);
}

function setEnabled(v) {
  enabled = !!v;
}

function restore(id) {
  const it = items.find((i) => i.id === id);
  if (!it) return false;
  if (it.type === 'text') {
    clipboard.writeText(it.text);
  } else {
    const p = imgPath(it.image);
    if (!p || !fs.existsSync(p)) return false;
    clipboard.writeImage(nativeImage.createFromPath(p));
  }
  lastSig = it.sig;
  items = [it, ...items.filter((i) => i.id !== id)];
  persist();
  emit();
  return true;
}

function remove(id) {
  const it = items.find((i) => i.id === id);
  items = items.filter((i) => i.id !== id);
  if (it && it.type === 'image' && it.image) safeUnlink(it.image);
  persist();
  emit();
  return true;
}

function clear() {
  for (const it of items) if (it.type === 'image' && it.image) safeUnlink(it.image);
  items = [];
  lastSig = '';
  persist();
  emit();
  return true;
}

module.exports = { start, setEnabled, list, restore, remove, clear, imgPath };
