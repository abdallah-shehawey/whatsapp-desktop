'use strict';

/*
 * The palettes, and the two things about them that are not a matter of taste.
 *
 * WHICH PROPERTIES. WhatsApp moved to a design system -- every colour on the
 * page now comes out of a `--WDS-` token -- and this file went on writing the
 * names it had been written against. Measured on the live page, the palette was
 * reaching #pane-side and #app because those two were painted by hand here, and
 * nothing else: `.two`, the right-hand section, the settings drawer and the
 * tooltips all stayed WhatsApp's own grey. So the test is not "does it produce
 * CSS" but "does it name the tokens the page is actually painted from".
 *
 * AND WHETHER THE DOODLES SURVIVE IT. The chat wallpaper is drawn as a masked
 * overlay whose colour is a token tuned against WhatsApp's own #161717 ground.
 * Forcing the ground to black and leaving that token alone put the doodles at
 * level 7 of 255 -- which is the report that started this. The arithmetic is
 * below, because "it looks fine here" is not a thing a test can say.
 */
const assert = require('assert');
const themes = require('../src/themes.js');

const ok = what => console.log('  ok   %s', what);

/* ------------------------------------------------- the three that are not palettes */

for (const plain of ['system', 'dark', 'light']) {
  assert.strictEqual(themes.getWebThemeCss(plain), '',
                     plain + ' leaves the page to WhatsApp');
}
ok('system, dark and light write nothing into the page');

/* ...unless the desktop has an accent of its own, which is a colour and not a
   theme: it needs no ground to sit on and does not imply one. */
const accentOnly = themes.getWebThemeCss('system', '#ff6600');
assert.match(accentOnly, /--WDS-accent:\s*#ff6600/);
assert.doesNotMatch(accentOnly, /--WDS-surface-default/,
                    'an accent is not a palette and does not repaint the surfaces');
ok('a desktop accent reaches the page without one');

/* ------------------------------------------------------------- the palette */

const oled = themes.getWebThemeCss('oled');

/*
 * Every token below was read off the live page as the one that paints a region
 * the palette was reported not to reach. They are listed with the region rather
 * than as a bare list, because the next time WhatsApp renames one, the thing
 * worth knowing is what goes grey.
 */
const PAINTS = [
  ['--WDS-surface-default', 'the chat list and the settings drawer'],
  ['--WDS-surface-emphasized', 'the .two container behind the whole window'],
  ['--WDS-background-elevated-wash-inset', 'the right-hand pane'],
  ['--WDS-surface-elevated-default', 'the panels'],
  ['--WDS-components-surface-nav-bar', 'the nav rail'],
  ['--WDS-surface-inverse', 'the tooltip beside the rail'],
  ['--WDS-systems-bubble-surface-incoming', 'a received bubble'],
  ['--WDS-systems-bubble-surface-outgoing', 'a sent one'],
  ['--WDS-systems-chat-surface-composer', 'the message box'],
  ['--WDS-lines-divider', 'the lines between rows'],
  ['--WDS-content-default', 'the words'],
  ['--WDS-accent', 'everything green'],
];
for (const [token, region] of PAINTS) {
  assert.ok(oled.includes(token + ':'), token + ' is written -- it paints ' + region);
}
ok('every token the page is actually painted from is written');

/* User origin, so a normal declaration loses to WhatsApp's own: without this
   the whole sheet is decoration. */
for (const [token] of PAINTS) {
  const written = new RegExp(token.replace(/[-]/g, '\\-') + ':[^;]+!important');
  assert.match(oled, written, token + ' is !important');
}
ok('and each of them beats the page, which at user origin needs saying');

/*
 * The chat ground is set on #main and NOT on :root, and that is not a style
 * choice. WhatsApp puts the chat theme on #main itself -- the element carries a
 * generated class whose rule writes both wallpaper tokens -- so a declaration
 * on :root is overridden for the whole conversation and reaches nothing.
 */
const mainRule = oled.slice(oled.indexOf('#main {'), oled.indexOf('}', oled.indexOf('#main {')));
assert.match(mainRule, /--WDS-systems-chat-background-wallpaper/);
assert.match(mainRule, /--WDS-systems-chat-foreground-wallpaper/);
const rootRule = oled.slice(oled.indexOf(':root {'), oled.indexOf('}', oled.indexOf(':root {')));
assert.doesNotMatch(rootRule, /chat-background-wallpaper/,
                    'on :root it would be overridden by the chat theme on #main');
ok('the chat wallpaper is set where the chat theme is, on #main');

/*
 * And the ground is set through that token rather than painted onto #main.
 * `#main { background-color }` is what flattened the doodles: it paints over
 * nothing -- the overlay is a child -- but it fixes the ground at a colour the
 * overlay's own token was never tuned against.
 */
assert.doesNotMatch(mainRule, /background-color/,
                    'the wallpaper system draws the ground, so an image works too');
ok('and not painted over, so doodles and an image wallpaper both still draw');

/* ------------------------------------------------- what came out, and why */

/*
 * Two descendant selectors, evaluated against every bubble of every chat as it
 * is recycled down a scrolling conversation -- for classes this build of
 * WhatsApp does not put on the page at all. Measured on the live client: 0
 * `.message-in` and 0 `.message-out`, against 33 `.copyable-text`. They were
 * cost with no effect, and the bubbles are tokens now.
 */
assert.doesNotMatch(oled, /\.message-in|\.message-out/,
                    'the bubbles are tokens, not a selector matched per bubble');
assert.doesNotMatch(oled, /\.copyable-text/);
ok('nothing in the sheet is matched per message');

/* One element rule is left, and it is body -- the ground behind whatever the
   page leaves transparent, and what is on screen before the page has drawn. */
const selectors = oled.split('\n')
  .filter(line => /^\s{2}\S.*\{\s*$/.test(line))
  .map(line => line.trim().replace(/\s*\{$/, ''));
assert.deepStrictEqual(selectors,
                       [':root[data-wa-theme="oled"]',
                        ':root[data-wa-theme="oled"] #main',
                        ':root[data-wa-theme="oled"] body'],
                       'three rules, each on one element');
ok('and the whole sheet is three rules: :root, #main and body');

/*
 * And every one of them is hung off the mark, which is what makes Default work.
 *
 * A sheet inserted at user origin cannot be taken out of the page again --
 * measured, see src/style.js -- so swapping one palette for another works only
 * because the newer declaration contradicts the older one by name. Choosing
 * Default writes nothing at all, and nothing cannot beat a declaration that is
 * still there: the client went on wearing the palette it had been told to take
 * off. Reported, and confirmed on the live page -- the config said `system`
 * while the page still answered #2e3440 for --WDS-surface-default.
 */
for (const selector of selectors) {
  assert.ok(selector.startsWith(':root[data-wa-theme="oled"]'),
            selector + ' must be reachable only while the page says it is on');
}
/* Named by the palette, not just marked. With the key in the selector, which
   palette is in force is a fact about the page rather than about which sheet
   happened to be inserted last. */
assert.ok(!themes.getWebThemeCss('nord').includes('data-wa-theme="oled"'));
assert.ok(themes.getWebThemeCss('nord').includes('data-wa-theme="nord"'));
ok('every rule names the palette the page must be marked with');

/* And the marks the client is to write. Default clears both, which is the fix. */
assert.deepStrictEqual(themes.markFor('oled'), { theme: 'oled', accent: null });
assert.deepStrictEqual(themes.markFor('nord', '#ff6600'), { theme: 'nord', accent: null });
assert.deepStrictEqual(themes.markFor('system'), { theme: null, accent: null },
                       'Default clears the mark, and every stale palette stops matching');
assert.deepStrictEqual(themes.markFor('dark'), { theme: null, accent: null });
assert.deepStrictEqual(themes.markFor('system', '#ff6600'), { theme: null, accent: 'on' },
                       'an accent with no palette has a mark of its own to be taken off by');
ok('and Default clears it, which is what takes a stale palette off');

/* The accent-only sheet is marked too, or turning the desktop accent off would
   leave the page wearing the last colour pywal happened to have written. */
assert.match(accentOnly, /:root\[data-wa-accent\] \{/);
ok('the desktop accent is switchable the same way');

/* ---------------------------------------------------------- the doodles */

/*
 * What actually lands on screen. WhatsApp draws the overlay at opacity 0.6
 * through a mask whose thin antialiased strokes never reach full coverage;
 * fitted against a sweep on the live window -- alpha .22 on black measured 28
 * -- the factor is 0.51.
 *
 *   level = alpha * 0.51 * (distance from the ground to the overlay colour)
 *
 * WhatsApp's own is alpha .1 over its #161717, which comes to 14. Over black it
 * comes to 7, and 7 of 255 on an OLED panel is nothing at all.
 */
const drawn = (background, declaration) => {
  const overlay = /rgba\(255/.test(declaration) ? 255 : 0;
  const alpha = Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(declaration)[1]);
  const level = themes.luma(background);
  return alpha * 0.51 * Math.abs(overlay - level);
};

assert.ok(drawn('#161717', 'rgba(255,255,255,0.1)') < 15,
          'WhatsApp\'s own alpha is 14 levels, which is the number to beat');

const { THEMES } = themes;
for (const [key, palette] of Object.entries(THEMES)) {
  const declaration = themes.doodle(palette.bg);
  const level = drawn(palette.bg, declaration);
  assert.ok(level >= 18, key + ': the doodles come out at ' + level.toFixed(1) +
                         ' levels, which is not enough to see');
  assert.ok(level <= 30, key + ': the doodles come out at ' + level.toFixed(1) +
                         ' levels, which is louder than the messages over them');
}
ok('every palette draws the doodles between 18 and 30 levels off its ground');

/* The direction matters as much as the amount: there is no quantity of white
   that draws anything on #f0f2f5, which is what the light palette is. */
assert.match(themes.doodle('#000000'), /rgba\(255, 255, 255/, 'white over a dark ground');
assert.match(themes.doodle('#f0f2f5'), /rgba\(0, 0, 0/, 'and black over a light one');
ok('and over a light palette it darkens instead of lightening');

/* The black ground is the one that started this, so it is checked by name. */
const black = drawn('#000000', themes.doodle('#000000'));
assert.ok(black > 18, 'on OLED black the doodles are at ' + black.toFixed(1) + ', not 7');
ok('on OLED black they are at ' + black.toFixed(1) + ' rather than the 7 that was reported');

/* ------------------------------------------------------- the accent wins */

const withDesktop = themes.getWebThemeCss('nord', '#ff6600');
assert.match(withDesktop, /--WDS-accent:\s*#ff6600/);
assert.doesNotMatch(withDesktop, new RegExp('--WDS-accent:\\s*' + THEMES.nord.accent));
assert.ok(withDesktop.includes(THEMES.nord.bg), 'but the palette still provides the ground');
ok('a desktop accent beats the palette\'s own, and only the accent');

/* -------------------------------------------------------------- helpers */

assert.strictEqual(themes.mix('#000000', '#ffffff', 0.5), '#808080');
assert.strictEqual(themes.mix('#000000', '#ffffff', 0), '#000000');
assert.strictEqual(Math.round(themes.luma('#ffffff')), 255);
assert.strictEqual(Math.round(themes.luma('#000000')), 0);
/* Rec. 709 and not an average, which is what "is this dark" needs: a plain mean
   calls pure blue light at 85 and picks the wrong overlay for it. */
assert.ok(themes.luma('#0000ff') < 128, 'blue is dark, whatever the mean says');
ok('the colour helpers do what the palettes are derived with');

/* Rubbish in is not a crash: a palette file edited by hand is a file that can
   be edited wrong, and a bad colour should cost that colour and not the app. */
assert.doesNotThrow(() => themes.doodle('not a colour'));
assert.doesNotThrow(() => themes.mix('#zzz', '#fff', 0.5));
assert.strictEqual(themes.luma('nonsense'), 0);
ok('and a colour that is not one costs that colour, not the window');

console.log('\npalette checks pass');
