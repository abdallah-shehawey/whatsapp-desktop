/*
 * The user stylesheet -- what little of it is left.
 *
 * This file used to impose the desktop font on the whole page with a universal
 * !important rule at user origin. That job moved to fontconfig (src/fonts.js),
 * where it costs nothing per element; what stays here is only what CSS is the
 * right tool for. The `stack()` helper is still exported because the diagnostic
 * probe in debug.js re-applies the old rule to measure what it used to cost.
 */
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
/* Arabic that wraps.
 *
 * WhatsApp marks the SPAN holding the text dir="rtl" and leaves the block around
 * it dir="ltr" with text-align: start -- which, on a left-to-right block,
 * resolves to left. An inline span's direction fixes the order of words within a
 * line and nothing else: alignment belongs to the block. So the first line of an
 * Arabic message looks right because it fills the width, and every line after it
 * is flush against the LEFT margin, which is the report.
 *
 * Measured on a live bubble rather than guessed: the div reads
 * direction "ltr", text-align "start", and the span inside it dir="rtl",
 * direction "rtl".
 *
 * text-align rather than direction, because direction on the block would move
 * the timestamp and the ticks that sit inside the same bubble. :has() asks the
 * only question that matters -- did WhatsApp itself decide this text is
 * right-to-left -- so a Latin message in the same conversation is untouched. */
#main div.copyable-text:not([contenteditable]) > div:has(> span[dir="rtl"]),
#main div.copyable-text:not([contenteditable]) > div:has(> span > span[dir="rtl"]) {
  text-align: right;
}
/* The same thing in a quoted reply and in the chat list, where the preview is a
   span[title] inside a block the page leaves left-to-right. */
#pane-side div:has(> span[title][dir="rtl"]) {
  text-align: right;
}

/* The composer clips the same way. A taller line box here is a trap: WhatsApp
   already sets 1.47em on it, and one pixel of overflow makes the box scrollable,
   so every keystroke scrolled the caret back into view and the text twitched. */
[contenteditable="true"] {
  padding-bottom: 0.35em !important;
  margin-bottom: -0.35em !important;
}`;

/*
 * WhatsApp's conversation is much heavier than the chat list: every wheel tick
 * can expose message bubbles, media previews, reactions and their shadows. That
 * one viewport is put on a compositor layer of its own -- `will-change` is the
 * scroll-position hint, and the flat 3D transform is what actually promotes it
 * on the Linux builds that otherwise leave a nested overflow viewport on the
 * main-thread paint path. A page-wide transform would make the chat list and
 * everything else pay the same cost, so it is scoped to the scroller.
 *
 * Which element that is has to be checked against the live page, not guessed.
 * This build marks it `data-testid`, not `data-tab` -- the data-tab values are
 * bare numbers -- and it is the messages list itself that scrolls, not the panel
 * body around it. A rule aimed at the wrong one does not fail, it silently
 * applies to nothing:
 *
 *   WHATSAPP_DEBUG_EVAL=/tmp/e.js, then
 *   getComputedStyle(document.querySelector('#main [data-testid="conversation-panel-messages"]')).willChange
 *
 * has to answer "scroll-position" and not "auto". Both spellings are matched so
 * that the day WhatsApp renames the marker, the rule degrades to the one that
 * still hits rather than to none.
 *
 * There are deliberately no ::-webkit-scrollbar rules here. A custom scrollbar
 * is painted on the main thread, and these were applied to every scroller on the
 * page.
 */
const CONVERSATION_SCROLL = `
#main [data-testid="conversation-panel-messages"],
#main [data-tab="conversation-panel-messages"] {
  will-change: scroll-position;
  transform: translate3d(0, 0, 0);
  backface-visibility: hidden;
}`;


/*
 * Aliasing, which is how the desktop font is imposed now.
 *
 * Three mechanisms were measured against each other on a live session:
 *
 *   `* { font-family: X !important }` at user origin works, and costs 212ms of
 *   blocked main thread over the same 2100px of scrolling that costs 82ms
 *   without it -- every element of every recycled row has its font resolved
 *   against a rule that matches everything.
 *
 *   fontconfig substitution costs nothing per element, and Chromium only half
 *   honours it. Measured by rendering: an unknown family and the generic both
 *   came out in the desktop font, so the `sans-serif` alias is respected -- and
 *   "Roboto Variable", which WhatsApp asks for by name and which is installed
 *   here, came out as Roboto. Skia takes the explicitly named font it can find
 *   and does not apply the pattern edit.
 *
 *   `@font-face { font-family: <what the page asks for>; src: local(<the
 *   desktop font>) }` costs nothing per element -- there is no selector to
 *   match -- and it is honoured: measured identical to asking for the desktop
 *   font directly. So that is what ships.
 *
 * The families come from the page rather than from a list here, because the
 * stack changes: WhatsApp currently leads with "Roboto Variable", which no list
 * written before it existed would have covered.
 */
const GENERIC = new Set([
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
  'fangsong', 'inherit', 'initial', 'unset', 'revert',
]);

/* Left alone: these are what a script or a symbol the desktop font does not
   cover falls through to, and aliasing them draws blank boxes. */
const KEEP = /emoji|symbol|arabic|hebrew|thai|devanagari|cjk|noto sans (?!$)/i;

const aliasSheet = (stack, family) => {
  if (!stack || !family) return '';

  const wanted = String(stack).split(',')
    .map(name => name.trim().replace(/^["']|["']$/g, ''))
    .filter(name => name && !GENERIC.has(name.toLowerCase()) && !KEEP.test(name))
    .filter(name => name.toLowerCase() !== family.toLowerCase());

  const target = family.replace(/"/g, '');
  const unique = [...new Set(wanted)];

  /* One face per family covering the whole weight range: the desktop font is
     one file, and Chromium synthesises the bold and the oblique from it, which
     is exactly what the universal rule this replaces used to do. */
  return unique.map(name => `@font-face {
  font-family: "${name.replace(/"/g, '')}";
  src: local("${target}");
  font-weight: 1 1000;
  font-style: normal;
}
@font-face {
  font-family: "${name.replace(/"/g, '')}";
  src: local("${target}");
  font-weight: 1 1000;
  font-style: italic;
}`).join('\n');
};

const build = ({ arabicFix, fontSize }) => {
  const rules = [CONVERSATION_SCROLL];

  /* There is no font rule here any more, and that is the point. Forcing the
     desktop font with `* { font-family: X !important }` at user origin works and
     is expensive: every element of every row WhatsApp recycles down a scrolling
     conversation has its font resolved against a rule that matches everything.
     Measured on a live chat, the same 2100px of scrolling blocked the main
     thread for 212ms with that sheet and 82ms without it, and the worst single
     stall went from 82ms to 139ms. The substitution happens in fontconfig now,
     at font lookup -- see src/fonts.js.

     The scrollbar styling that used to be here is gone for the same reason:
     a `::-webkit-scrollbar` rule takes a scroller off Chromium's composited
     scrollbar path and onto the main thread, which is a cosmetic gain paid for
     in the one place this client could least afford it. */

  if (fontSize) rules.push(`html { font-size: ${fontSize}px !important; }`);
  if (arabicFix) rules.push(ARABIC_CLIP);

  return rules.join('\n');
};

module.exports = { build, stack, aliasSheet };
