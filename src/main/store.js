'use strict';
// Armazenamento simples em JSON dentro da pasta de dados do app (%APPDATA%/Lamina).
// Tudo fica só no computador do usuário.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function createStore(name, defaults) {
  const file = path.join(app.getPath('userData'), `${name}.json`);
  let data;
  try {
    data = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...defaults };
  }

  let timer = null;
  function writeNow() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.error(`[store:${name}]`, err);
    }
  }
  function save() {
    clearTimeout(timer);
    timer = setTimeout(writeNow, 250);
  }

  return {
    get(key) {
      return key ? data[key] : { ...data };
    },
    set(key, value) {
      if (key && typeof key === 'object') Object.assign(data, key);
      else data[key] = value;
      save();
      return { ...data };
    },
    flush() {
      clearTimeout(timer);
      writeNow();
    },
  };
}

module.exports = { createStore };
