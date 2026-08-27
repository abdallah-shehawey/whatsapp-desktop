/*
 * The user stylesheet.
 *
 * WhatsApp Web names its own font stack in CSS, so telling Chromium which
 * default families to use is not enough to change what is actually drawn on the
 * page -- a sheet is. It goes in at USER origin, which is the one level whose
 * !important beats the page's own !important, and is exactly what a browser set
 * to ignore page fonts does.
 */
'use strict';

/* Emoji and Arabic have to be named in the stack even though the desktop font is
   the point. A display face like PoetsenOne carries no Arabic and no emoji at
   all, and a character its first family lacks is resolved down the list. */
const FALLBACKS = [
  'system-ui',
  '"Noto Sans Arabic"',
  '"Noto Color Emoji"',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
  'sans-serif',
];

const quote = family => `"${String(family).replace(/"/g, '')}"`;
/* `lead` is put in front and dropped from the tail, so naming the Arabic face
   first for right-to-left text does not leave it named twice. */
const stack = (family, lead) => {
  const wanted = [quote(family), ...FALLBACKS];
  const list = lead ? [quote(lead), ...wanted.filter(f => f !== quote(lead))] : wanted;
  return list.join(', ');
};

/* Arabic descenders against WhatsApp's line boxes.
 *
 * WhatsApp draws its list rows and its bubbles into boxes it clips with
 * overflow:hidden, sized for Latin. The bowl of a final ن or ي hangs further
 * below the baseline than that leaves room for, so the tails were shorn off and
 * "يعني" could read as "يعن ،".
 *
 * The fix is a wider CLIP, never a taller line. Padding grows the box that
 * overflow:hidden cuts against and a negative margin hands the space straight
 * back, so every row keeps the height WhatsApp Web gave it. Raising line-height
 * instead does fix the tails, and it moves every Arabic line off the rhythm the
 * page was designed on -- and in a bubble it lands on a span inside a div pinned
 * at 19px, which shears five pixels off every line. That version shipped once
 * from the GTK client and came straight back out.
 */
const ARABIC_CLIP = `
/* The clipping box in a bubble is the div directly under .copyable-text. */
#main div.copyable-text:not([contenteditable]) > div {
  padding-bottom: 0.2em !important;
  margin-bottom: -0.2em !important;
}
/* The chat list is deliberately NOT touched. WebKit sized a line box from the
   primary font alone, so Arabic arriving as a fallback was measured against a
   face that has none of it and fell outside the box; Chromium measures the line
   against every font actually used in it, so the rows size themselves. If Arabic
   ever does get shorn in the list here, the rule that belongs is this same clip
   widening on "#pane-side div:has(> span[title])" -- never a line-height, which
   in the GTK client shifted every Arabic line off the page's own rhythm. */
/* The composer clips the same way. A taller line box here is a trap: WhatsApp
   already sets 1.47em on it, and one pixel of overflow makes the box scrollable,
   so every keystroke scrolled the caret back into view and the text twitched. */
[contenteditable="true"] {
  padding-bottom: 0.35em !important;
  margin-bottom: -0.35em !important;
}`;

/*
 * Chromium's own scrollbars are a wide grey slab that WhatsApp does not expect;
 * the page is quieter with the thin overlay the rest of the desktop draws.
 */
const SCROLLBARS = `
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(134, 150, 160, 0.35);
  border-radius: 10px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background-color: rgba(134, 150, 160, 0.6); background-clip: content-box; }
::-webkit-scrollbar-corner { background: transparent; }`;

const build = ({ family, forceFont, arabicFix, fontSize }) => {
  const rules = [];

  if (forceFont && family) {
    /* One family, everywhere -- bubbles, previews and controls alike. A separate
       reading face for chat text was tried in the GTK client and removed: the
       browser this is meant to be indistinguishable from draws the lot in the
       one family. */
    rules.push(`* { font-family: ${stack(family)} !important; }`);
    /* Right-to-left text leads with the Arabic face. A line box is measured from
       the primary font, so Arabic arriving as a fallback is measured against a
       face that has none of it. */
    rules.push(`:dir(rtl) { font-family: ${stack(family, 'Noto Sans Arabic')} !important; }`);
  }

  if (fontSize) rules.push(`html { font-size: ${fontSize}px !important; }`);
  if (arabicFix) rules.push(ARABIC_CLIP);
  rules.push(SCROLLBARS);

  return rules.join('\n');
};

module.exports = { build, stack };
