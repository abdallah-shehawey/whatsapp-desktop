'use strict';

/* The window's own shortcuts -- see src/keys.js. What Chromium reports for a
   key on the US layout and on the Arabic one, and what each must come out as. */

const assert = require('assert');
const { shortcutKey } = require('../src/keys.js');

const cases = [
  // The US layout: the character is the answer.
  [{ key: 'q', code: 'KeyQ' }, 'q'],
  [{ key: 'Q', code: 'KeyQ' }, 'q'],
  [{ key: 'I', code: 'KeyI' }, 'i'],
  [{ key: ',', code: 'Comma' }, ','],
  [{ key: '=', code: 'Equal' }, '='],
  [{ key: '+', code: 'Equal' }, '+'],
  [{ key: '+', code: 'NumpadAdd' }, '+'],
  [{ key: '-', code: 'Minus' }, '-'],
  [{ key: '0', code: 'Digit0' }, '0'],

  // The Arabic layout: the physical key under the character.
  [{ key: 'ض', code: 'KeyQ' }, 'q'],
  [{ key: 'ص', code: 'KeyW' }, 'w'],
  [{ key: 'ق', code: 'KeyR' }, 'r'],
  [{ key: 'و', code: 'Comma' }, ','],
  [{ key: 'ح', code: 'KeyP' }, 'p'],
  [{ key: 'م', code: 'KeyL' }, 'l'],
  [{ key: '÷', code: 'KeyI' }, 'i'],
  [{ key: '٠', code: 'Digit0' }, '0'],

  // Another Latin layout keeps its own letters: Dvorak's P is where US has R.
  [{ key: 'p', code: 'KeyR' }, 'p'],

  // A named key is not a character, and is never read off its position.
  [{ key: 'Insert', code: 'Numpad0' }, 'insert'],
  [{ key: 'Escape', code: 'Escape' }, 'escape'],
  [{ key: 'F5', code: 'F5' }, 'f5'],

  // Nothing to go on.
  [{ key: 'ض', code: '' }, 'ض'],
  [{}, ''],
  [null, ''],
];

for (const [input, wanted] of cases) {
  assert.strictEqual(shortcutKey(input), wanted, `${JSON.stringify(input)} should read as ${JSON.stringify(wanted)}`);
}

console.log('keys: %d cases pass', cases.length);
