/*
 * A line made only of Arabic-Indic digits has no strong bidi character, so
 * unicode-bidi: plaintext resolves it left-to-right. Mark just those lines;
 * Arabic words already resolve correctly and English text keeps its own side.
 */
'use strict';

const BODY = 'div:not([contenteditable]) > span.selectable-text.copyable-text';
const ARABIC_DIGIT = /[\u0660-\u0669\u06f0-\u06f9]/u;
const LETTER = /[\p{L}\p{M}]/u;
const numeric = text => ARABIC_DIGIT.test(text || '') && !LETTER.test(text || '');

const start = () => {
  if (typeof MutationObserver !== 'function') return;

  const mark = element => {
    const wanted = numeric(element.textContent);
    if (element.hasAttribute('data-wa-arabic-numeric') !== wanted) {
      element.toggleAttribute('data-wa-arabic-numeric', wanted);
    }
  };
  const sync = body => {
    mark(body);
    for (const child of body.children) {
      if (child.tagName === 'SPAN' && !child.classList.contains('selectable-text')) {
        mark(child);
      }
    }
  };

  const attach = () => {
    if (!document.body) return;
    const pending = new Set();
    let timer = null;
    const closestBody = node =>
      (node.nodeType === 1 ? node : node.parentElement)?.closest?.(BODY);
    new MutationObserver(records => {
      for (const record of records) {
        const owner = closestBody(record.target);
        if (owner) pending.add(owner);
        for (const node of record.addedNodes || []) {
          if (node.nodeType !== 1) continue;
          if (node.matches(BODY)) pending.add(node);
          for (const body of node.querySelectorAll(BODY)) pending.add(body);
        }
      }
      if (!pending.size || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        for (const body of pending) if (body.isConnected) sync(body);
        pending.clear();
      }, 0);
    }).observe(document.body, { childList: true, characterData: true, subtree: true });
    for (const body of document.querySelectorAll(BODY)) sync(body);
  };

  if (document.body) attach();
  else addEventListener('DOMContentLoaded', attach, { once: true });
};

module.exports = { start, numeric };
