'use strict';

/*
 * A font for English and a font for Arabic, checked where it can be checked
 * without a browser: what comes out of src/fonts.js and src/style.js.
 *
 * The part that cannot be checked here is whether Chromium honours it, and
 * that was measured on the live client instead -- see the notes in style.js.
 * What this file is for is the shape of what is emitted, and above all the
 * ORDER of it: the whole mechanism is two faces of one family and the later
 * one winning for the characters both of them cover.
 */
const assert = require('assert');
const fonts = require('../src/fonts.js');
const style = require('../src/style.js');

const STACK = 'Roboto Variable, Segoe UI, Helvetica, sans-serif';

/* ------------------------------------------------ inheriting the desktop font */

const inherited = fonts.resolve({ inherit: true, latin: { family: 'PoetsenOne' } });
assert.strictEqual(inherited.arabic, null, 'no second script until it is asked for');

const before = style.fontFaces(STACK, inherited);
/* The sheet this client has always carried: the page's own families, pointed at
   one file, and nothing else. A default install must not start paying for a
   feature nobody turned on. */
assert.match(before, /font-family: "Roboto Variable";/);
assert.match(before, /src: local\("PoetsenOne"\);/);
assert.doesNotMatch(before, /unicode-range/);
assert.doesNotMatch(before, /size-adjust/);
assert.doesNotMatch(before, /^html \{/m);
/* And nothing at all when the page has not said what it asks for yet. */
assert.strictEqual(style.fontFaces('', inherited), '');
/* The generics are fontconfig's job and a family the page never names is
   nobody's: neither belongs in this sheet. */
assert.doesNotMatch(before, /font-family: "sans-serif"/);

/* ------------------------------------------------------- two scripts, one line */

const both = fonts.resolve({
  inherit: false,
  latin: { family: 'DejaVu Sans', size: 100, bold: false, italic: false },
  arabic: { family: 'Vazirmatn', size: 120, bold: false, italic: false },
});
const sheet = style.fontFaces(STACK, both);

/* Both faces are declared under the SAME family name -- that is what makes one
   of them reachable at all, since CSS has no way to say "the Arabic words". */
const roboto = sheet.split('@font-face').filter(rule => /"Roboto Variable"/.test(rule));
assert.strictEqual(roboto.length, 4, 'upright and italic, for each of the two scripts');

/* The order is the mechanism, not a matter of taste. An Arabic character
   matches both faces -- same family, same weight, same style -- and CSS breaks
   that tie by taking the one declared LAST. Latin first, Arabic second. */
const latinAt = sheet.indexOf('local("DejaVu Sans")');
const arabicAt = sheet.indexOf('local("Vazirmatn")');
assert.ok(latinAt >= 0 && arabicAt > latinAt, 'the Arabic face has to come second');

/* Only the Arabic face carries a range, and it starts at the Arabic comma:
   the Latin punctuation below it reads better in the font the words around it
   are set in. */
assert.match(sheet, /unicode-range: U\+060C-06FF,/);
/* Three families from the page and the client's own name for its choice, an
   upright and an italic face each: eight Arabic faces and eight ranges, and
   not one on a Latin face. */
assert.strictEqual(sheet.split('unicode-range').length - 1, 8,
                   'one range per Arabic face, and none on a Latin one');

/* A size for one script and not the other, which is the whole point of having
   two: `size-adjust` is a descriptor on the face, so it costs nothing per
   element and it applies inside a line that has both scripts in it. */
assert.match(sheet, /size-adjust: 120%;/);
assert.doesNotMatch(sheet, /size-adjust: 100%;/);
const dejavu = sheet.split('@font-face').filter(rule => /local\("DejaVu Sans"\)/.test(rule));
assert.ok(dejavu.every(rule => !/size-adjust/.test(rule)), 'nothing at all at 100 per cent');

/* The text the page names no family for. fontconfig answers it too, but only
   from the next launch -- this rule answers it now, and it is deliberately not
   !important, so it applies where WhatsApp said nothing and nowhere else. */
assert.match(sheet, /\nhtml \{\n  font-family: "WhatsApp Desktop", "Noto Color Emoji"/);
assert.doesNotMatch(sheet, /html \{[^}]*!important/);

/* ------------------------------------------------------------ bold and italic */

/* "Bold Arabic" is a different FILE -- the family's own bold face, named in
   local(). Nothing here synthesises one, and a family that ships no bold face
   says so rather than offering a switch that does nothing. */
const bold = fonts.resolve({
  inherit: false,
  latin: { family: 'DejaVu Sans', size: 100, bold: true, italic: false },
  arabic: { family: 'Vazirmatn', size: 100, bold: false, italic: false },
});
if (bold.latin.hasBold) {
  assert.match(bold.latin.normal[0], /Bold/,
               'the upright face of a bold Latin is the bold file');
  assert.match(style.fontFaces(STACK, bold), /src: local\("DejaVu Sans Bold"\)/);
}

/* A face that was asked for and does not exist: the family comes back, the
   sheet is still valid, and `hasBold` is what the settings window greys the
   button from. */
const missing = fonts.resolve({
  inherit: false,
  latin: { family: 'PoetsenOne', size: 100, bold: true, italic: true },
  arabic: { family: '', size: 100, bold: false, italic: false },
});
assert.ok(missing.latin.normal.length, 'a family with no bold face still draws');
assert.strictEqual(missing.latin.wantedBold, true);

/* An Arabic size with no Arabic family named still needs a family to hang on,
   or the knob would silently do nothing -- so the system's own answer for
   Arabic is used. */
const sizeOnly = fonts.resolve({
  inherit: false,
  latin: { family: 'PoetsenOne', size: 100 },
  arabic: { family: '', size: 130 },
});
if (fonts.defaultFor('ar')) {
  assert.ok(sizeOnly.arabic && sizeOnly.arabic.family, 'a size needs a face to sit on');
  assert.match(style.fontFaces(STACK, sizeOnly), /size-adjust: 130%;/);
}

/* --------------------------------------------------------------- the catalogue */

const installed = fonts.installed();
assert.ok(Array.isArray(installed.latin) && Array.isArray(installed.arabic));
if (installed.arabic.length) {
  /* Only the families that can actually draw the script are offered for it --
     asked of fontconfig by language, not guessed at from names. */
  assert.ok(installed.arabic.length <= installed.latin.length + installed.arabic.length);
  assert.ok(installed.arabic.every(font => typeof font.name === 'string' &&
                                           typeof font.bold === 'boolean' &&
                                           typeof font.italic === 'boolean'));
}

console.log('font checks pass');
