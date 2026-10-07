'use strict';

/* @font-face uses the author's font set. Aliases at user origin lose to
 * WhatsApp's downloaded Roboto Variable face even though user !important
 * declarations win for ordinary CSS properties. Keep a replaceable author
 * sheet after the page's sheets, without a font selector on every element. */
const apply = (document, css) => {
  const root = document.documentElement;
  if (!root) return false;
  let sheet = document.getElementById('wa-font-faces');
  if (!css) { if (sheet) sheet.remove(); return true; }
  if (!sheet) { sheet = document.createElement('style'); sheet.id = 'wa-font-faces'; }
  sheet.textContent = css;
  root.appendChild(sheet);
  return true;
};

module.exports = { apply };
