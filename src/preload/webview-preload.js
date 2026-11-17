'use strict';
// Roda dentro do webview do WhatsApp Web. Copia cada notificação que o site cria
// e manda para a barra (a notificação original do Windows continua aparecendo).
const { ipcRenderer, webFrame } = require('electron');

const HOOK = `(() => {
  if (window.__laminaHooked) return;
  window.__laminaHooked = true;
  const forward = (title, opts) => {
    try {
      window.postMessage({ __lamina: 'notification', title: String(title || ''), body: String((opts && opts.body) || '') }, '*');
    } catch (e) {}
  };
  const Native = window.Notification;
  if (Native) {
    const Wrapped = function (title, opts) { forward(title, opts); return new Native(title, opts); };
    Wrapped.prototype = Native.prototype;
    Object.defineProperty(Wrapped, 'permission', { get: () => Native.permission });
    Wrapped.requestPermission = Native.requestPermission.bind(Native);
    window.Notification = Wrapped;
  }
  if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
    const original = ServiceWorkerRegistration.prototype.showNotification;
    ServiceWorkerRegistration.prototype.showNotification = function (title, opts) {
      forward(title, opts);
      return original.call(this, title, opts);
    };
  }
})();`;

function hook() {
  webFrame.executeJavaScript(HOOK).catch(() => {});
}
hook();
window.addEventListener('DOMContentLoaded', hook);

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.__lamina !== 'notification') return;
  ipcRenderer.sendToHost('notification', {
    title: event.data.title.slice(0, 120),
    body: event.data.body.slice(0, 400),
    at: Date.now(),
  });
});
