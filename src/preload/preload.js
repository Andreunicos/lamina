'use strict';
// Ponte segura entre a interface e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('lamina', {
  info: () => ipcRenderer.invoke('app:info'),
  restart: () => ipcRenderer.invoke('app:restart'),
  quit: () => ipcRenderer.invoke('app:quit'),
  openExternal: (url) => ipcRenderer.invoke('open:external', url),

  expand: (view) => ipcRenderer.send('win:expand', view),
  collapse: () => ipcRenderer.send('win:collapse'),
  hover: () => ipcRenderer.send('win:hover'),
  pin: (value) => ipcRenderer.send('win:pin', value),
  hide: () => ipcRenderer.send('win:hide'),

  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    save: (note) => ipcRenderer.invoke('notes:save', note),
    remove: (id) => ipcRenderer.invoke('notes:delete', id),
  },
  apps: {
    list: (refresh) => ipcRenderer.invoke('apps:list', refresh),
    icon: (id) => ipcRenderer.invoke('apps:icon', id),
    launch: (id) => ipcRenderer.invoke('apps:launch', id),
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
  },

  onState: on('state'),
  onSide: on('side'),
  onOpenView: on('view:open'),
  onUpdateStatus: on('update:status'),
  onToast: on('toast'),
});
