'use strict';
// Roda em todas as páginas das abas web, mas só age no login do Google:
// esconde os sinais de Chromium para combinar com o user agent de Firefox
// que o app usa nessas páginas (ver main.js).
const { webFrame } = require('electron');

if (location.hostname === 'accounts.google.com') {
  webFrame
    .executeJavaScript(
      `(() => {
        const hide = (obj, prop, value) => {
          try { Object.defineProperty(obj, prop, { get: () => value, configurable: true }); } catch (e) {}
        };
        hide(Navigator.prototype, 'userAgentData', undefined);
        hide(Navigator.prototype, 'vendor', '');
        hide(Navigator.prototype, 'webdriver', false);
        try { delete window.chrome; } catch (e) {}
      })();`
    )
    .catch(() => {});
}
