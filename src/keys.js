/*
 * The key a shortcut was pressed on, whatever the layout says it typed.
 *
 * Chromium hands every key over with two names: `key`, what the active layout
 * types there, and `code`, the physical key. A shortcut read from `key` alone
 * is a shortcut for one layout. With the Arabic layout up, Ctrl+Q arrives as
 * Ctrl+ض, Ctrl+W as Ctrl+ص, Ctrl+R as Ctrl+ق and Ctrl+, as Ctrl+و -- none of
 * them matched, and every key of the window's own went through to the page and
 * did nothing. Read from `code` alone it is a shortcut for the US layout
 * instead, and on Dvorak Ctrl+Alt+P would be the key that says L.
 *
 * So the rule src/page/find.js already reads Ctrl+F by: a Latin character is
 * what it says, and any other character is read off the physical key under it.
 * A named key -- Escape, F5, Insert -- is left as it is, so Ctrl+Insert with
 * Num Lock off stays Ctrl+Insert rather than turning into Ctrl+0.
 */
'use strict';

const PUNCTUATION = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
  Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
  NumpadAdd: '+', NumpadSubtract: '-',
};

const shortcutKey = input => {
  const key = String((input && input.key) || '');
  if ([...key].length !== 1 || /^[\x20-\x7e]$/.test(key)) return key.toLowerCase();

  const code = String((input && input.code) || '');
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
  if (digit) return digit[1];
  return PUNCTUATION[code] || key.toLowerCase();
};

module.exports = { shortcutKey };
