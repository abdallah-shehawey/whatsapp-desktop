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
 *
 * There is no switch for this. It was one for a while, and a switch for
 * "should the letters have their tails" is not a preference -- an owner who
 * turns it off gets a bug back, and one who never finds it reads shorn Arabic
 * for ever. The same goes for MESSAGE_BIDI below.
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
 * Which way each line of a message reads, and which margin it sits against.
 *
 * All of this was measured on the live client, on the very messages that were
 * reported. Guessing at it produced three wrong fixes in a row, so the shape of
 * a message body is written down here in full:
 *
 *   div.copyable-text                       -- the message body
 *     div                                   -- direction ltr, text-align start
 *       span.selectable-text[dir=ltr|rtl]   -- INLINE, unicode-bidi isolate,
 *         span   "first line\\n"            white-space pre-wrap. WhatsApp
 *         span   "\\n"                      splits the text at every newline and
 *         span[dir=rtl] "…\\n"              gives each piece a span of its own.
 *         span   "last line, no newline"    Those pieces are display:block --
 *       span[aria-hidden] "6:03 PM"         except the last, which stays inline.
 *
 * Three separate faults, and each needs a different half of the rules below.
 *
 * ONE. WhatsApp marks a line dir="rtl" when it runs the other way from the
 * message -- and then puts `text-align: end` on that very span. On a
 * right-to-left line `end` is the LEFT margin, so every Arabic line inside an
 * English message was flush left while the English lines were flush right. That
 * is the report: "الانجليزي بقي علي اليمين والعربي بقي علي الشمال". The same
 * class lands on the <li> of a bulleted list, with the same result.
 *
 * TWO. A message that is all Arabic has nothing marked at all: the last piece
 * of it is an INLINE span, so the block that lays its lines out is
 * span.selectable-text, which is itself inline -- and the block above THAT is
 * the div, which is left-to-right. So the first line of a wrapping Arabic
 * message filled the width and looked right, and every line after it was flush
 * left. Making span.selectable-text display:block puts the message in a box of
 * its own, whose direction is the one WhatsApp worked out for the message.
 *
 * THREE. The timestamp is an invisible inline span that reserves room at the
 * end of the last line for the real clock, which is drawn over it. "End" in a
 * left-to-right block is the right margin -- which is exactly where a
 * right-to-left last line puts its text, so the clock sat on top of the words:
 * "الساعه لازقه في اخر سطر في الرساله". Once the body is display:block that
 * span is pushed onto a line of its own and cannot collide with anything.
 *
 * `unicode-bidi: plaintext` is what makes a line take its direction from its
 * own first strong character rather than from the message's, so a line that
 * opens with an emoji, a bullet or a bracket still reads the way its words do.
 * It goes on the line spans and NOT on span.selectable-text, and that
 * distinction cost an afternoon: plaintext on an INLINE box makes it an
 * isolate, an isolate contributes no direction to the paragraph around it, and
 * a paragraph with no direction in it falls back to left-to-right. Put
 * plaintext on the body and the last inline line hides the only Arabic in the
 * box from it, so `text-align: start` resolves to left and the fix undoes
 * itself. Measured, both ways round: with `isolate` on the body the lines came
 * back flush right (0px from the right margin), with `plaintext` they were
 * flush left.
 *
 * What plaintext costs, and it is left as it is: a line with NO strong character
 * in it -- one that is nothing but emoji -- has no direction to take, and rules
 * P2/P3 of the bidi algorithm end at left-to-right. So the emoji line at the
 * foot of an Arabic message sits against the left margin while the words above
 * it sit against the right. Measured on both surfaces, so at least they agree:
 * flush left in a bubble and flush left in a community thread. There is no CSS
 * for "plaintext, but fall back to this element's direction", and the
 * alternative is worse -- taking the direction from the message would put a
 * whole English line inside an Arabic one on the right, which is the report
 * this rule exists to answer.
 *
 * !important throughout, and not for emphasis: this sheet is inserted at USER
 * origin, where a normal declaration loses to the page's own. Only an important
 * one at user origin outranks an author rule -- which `text-align: end` is.
 */
const MESSAGE_BIDI = `
/* The body of a message: a box of its own, aligned to the start of the
   direction WhatsApp worked out for it. */
#main div.copyable-text:not([contenteditable]) > div > span.selectable-text {
  display: block !important;
  unicode-bidi: isolate !important;
  text-align: start !important;
}
/* Each line in it: its own direction, from its own first strong character, and
   the start margin of that direction. Arabic right, English left, whatever
   either of them happens to begin with. */
#main div.copyable-text:not([contenteditable]) > div > span.selectable-text > span,
#main div.copyable-text:not([contenteditable]) > div > span.selectable-text ul,
#main div.copyable-text:not([contenteditable]) > div > span.selectable-text li {
  unicode-bidi: plaintext !important;
  text-align: start !important;
}
/* A community thread -- the panel behind "6 replies" -- and why none of the
   above reaches it. It is mounted OUTSIDE #main, in a [role="dialog"], and it
   holds no div.copyable-text at all: measured on the live panel, 43 message
   bodies inside #main and none outside it. So every rule so far missed it and
   its Arabic sat flush left while the same message in the conversation behind
   it sat flush right.

   Its shape is not a bubble's:

     div[data-testid="comment-row"]      -- one reply
       div[data-testid="group-chat-profile-picture"]
       div ... span  "Youssef"  "+20 …"  "11:44 AM"   -- the sender line
       div                               -- block, direction ltr, text-align start
         span[data-testid=selectable-text][dir=auto]  -- INLINE, isolate,
                                            white-space: PRE-LINE, and the whole
                                            message in it, newlines and all.

   WhatsApp does NOT split a thread reply into a span per line the way it splits
   a bubble -- measured: 6 reply texts, 0 nested spans, the newlines still in the
   text node. So there are no line spans to hang plaintext on, and it goes on
   the block itself, where pre-line has already made each newline a forced break
   and therefore a bidi paragraph of its own. That is the OPPOSITE of the rule
   above, where plaintext on the body undoes the fix, and the difference is the
   pre-line span: measured, three ways round, on a box widened to leave slack on
   both sides, so that a flush line reads in either direction --

     the line              as shipped   isolate   plaintext
     "سطر عربي"                left       right     right
     "وسطر تاني اقصر"          left       right     right
     "Hello world here"        left       left      left
     "مرحبا بالعالم"           left       left      RIGHT   <- the only one that
     "and english again"       left       left      left       gets all three
     "(emoji) مرحبا بك"        left       right     right
     "(emoji) welcome"         left       RIGHT     left
     "https://example.com/x"   left       left      left
     "الرابط ده مهم"           left       left      right

   isolate gets the all-Arabic reply right and nothing else: the span carries
   dir="auto", so ONE direction is worked out for the whole message from its
   first strong character, and every line of a mixed one is dragged to that
   side. The timestamp needs nothing here -- it is drawn in the sender line
   above, not reserved at the end of the last one.

   The descender clip is not repeated for this panel and does not need to be:
   every box from the text up to the scroller is overflow: visible, so there is
   nothing here to shear a final ن against. */
[data-testid="comment-row"] span[data-testid="selectable-text"] {
  display: block !important;
  unicode-bidi: plaintext !important;
  text-align: start !important;
}
/* A quoted reply and the chat list, where the preview is a span[title] inside a
   block the page leaves left-to-right. */
#pane-side div:has(> span[title][dir="rtl"]) {
  text-align: right;
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
 * The right-hand drawer -- Message info, contact info, in-chat search -- and
 * why opening one stutters.
 *
 * Measured on the live page: its entrance is
 *
 *   @keyframes x1h4ohyg-B { 0% { flex-basis: 0%; } 100% { flex-basis: 30%; } }
 *
 * run for 0.2s on the drawer itself, which is a flex item beside the
 * conversation. flex-basis is a LAYOUT property, so every frame of that
 * animation re-lays out the whole app: the conversation narrows a few pixels,
 * every bubble in it re-wraps, and the drawer's own contents are laid out again
 * on top. Frame intervals through the open, sampled with requestAnimationFrame:
 * 12, 30, 42, 54, 66ms where the rest of the session runs at one frame. It is
 * WhatsApp's own doing and not this client's -- the same numbers came back with
 * the user stylesheet removed altogether, which is the first thing that was
 * checked.
 *
 * So the animation is made instant here -- the width is taken in one layout --
 * and the motion is put back in the page, on the compositor, by
 * `slideTheDrawer` in src/page/inject.js. The duration and NOT `animation:
 * none`: the keyframes are filled `forwards` and END at the width, so cancelling
 * them mounts the drawer nought pixels wide and Message info stops opening at
 * all. That shipped once.
 *
 * The motion cannot live here either, and that is worth writing down. The panel
 * is NOT unmounted when the drawer closes -- measured: it stays in the DOM at
 * flex-basis 0% -- so a CSS animation of ours on it or on its child plays once,
 * at mount, and every open after the first is a snap with no motion. Overriding
 * `animation-name` to point WhatsApp's own trigger at our keyframes has the same
 * fault for the same reason: the name then never changes, so nothing ever
 * re-starts. What DOES happen on every open is WhatsApp starting its animation
 * again -- two opens, two `animationstart` events -- and that is an event a
 * listener can hang a Web Animations slide on, which is what inject.js does.
 */
const DRAWER_MOTION = `
#app [data-testid="drawer-right"] {
  animation-duration: 1ms !important;
  animation-delay: 0s !important;
}`;

/*
 * The size of the text in a conversation, on its own.
 *
 * WhatsApp Web draws a message at 0.888rem -- 14.2px against the 16px root this
 * client sets -- in a line box of 19px, and the composer at 15px in a box of
 * 1.47em. `view.font-size` already scales all of that, and everything else with
 * it: the chat list, the headers, the menus. This is the other knob, the one the
 * phone has: bigger words in the conversation and a chat list left where it was.
 *
 * In rem rather than px, so it still follows `view.font-size`, and as one
 * absolute value rather than a multiplier on the way down: these classes NEST --
 * 45 of the 72 in a live conversation sit inside another -- and an `em` factor
 * on each of them would compound to a different size per level of nesting.
 *
 * The line box has to be reset with the size or the taller text is drawn into
 * the 19px box WhatsApp pinned it to. It is set on the same elements that carry
 * the size, which is what the Arabic clip below could not do -- there the size
 * stays as it is, and raising the line box alone shears the line.
 *
 * The composer gets the size and NOT the line box: its own is set in em, so it
 * follows on its own, and a line box pinned there is what made every keystroke
 * scroll the caret back into view.
 *
 * A community thread counts as a conversation here. Its panel is outside #main,
 * so it was left at WhatsApp's own 14.2px while the chat behind it was drawn at
 * the asked-for size -- measured with view.chat-font-size at 110: 15.6px in the
 * conversation, 15.0px in the reply box beneath it, 14.2px in the replies. It is
 * the same words in the same conversation, so it follows the same knob. The
 * panel is found by the rows it holds rather than by its own marker, which is
 * the thoroughly generic `confirm-popup`.
 *
 * Nothing at all is emitted at 100%, so the default page is the page WhatsApp
 * drew.
 */
const MESSAGE_TEXT_REM = 0.888;   // WhatsApp's own: 14.2px against a 16px root

const THREAD = '[data-testid="popup-contents"]:has([data-testid="comment-row"])';

const CHAT_TEXT_SELECTORS = `
#main [data-testid="conversation-panel-messages"] .copyable-text,
#main [data-testid="conversation-panel-messages"] .selectable-text,
#main [data-tab="conversation-panel-messages"] .copyable-text,
#main [data-tab="conversation-panel-messages"] .selectable-text,
[data-testid="comment-row"] .selectable-text`;

const COMPOSER_SELECTORS = `
#main [contenteditable="true"],
#main [contenteditable="true"] p,
${THREAD} [contenteditable="true"],
${THREAD} [contenteditable="true"] p`;

const scaled = value => {
  const factor = Number(value) / 100;
  return Number.isFinite(factor) && Math.abs(factor - 1) >= 0.005 ? factor : 0;
};

const chatText = scale => {
  const factor = scaled(scale);
  if (!factor) return '';
  const size = `calc(${MESSAGE_TEXT_REM}rem * ${factor.toFixed(2)})`;
  return `${CHAT_TEXT_SELECTORS} {
  font-size: ${size} !important;
  line-height: 1.35 !important;
}
${COMPOSER_SELECTORS} {
  font-size: ${size} !important;
}`;
};

/* Putting a size back is not the same as never having set one.
 *
 * A user stylesheet cannot be taken out of the page again. Measured on the live
 * client: insertCSS at user origin returns a key, removeInsertedCSS resolves for
 * that key without complaint, and the rules are STILL applied afterwards --
 * checked by computed style, twice, with the conversation reopened in between.
 * So every sheet this client has ever inserted is still in the cascade, and the
 * newest one only wins because it is the newest.
 *
 * Which is why "back to 100%" cannot be expressed by leaving the rule out: the
 * sheet that said 110% is still there and still says it. It has to be overruled
 * by name, and `revert` is what says "whatever WhatsApp itself asked for" --
 * per element, so a quoted reply and a caption keep the sizes of their own that
 * one flat value would have flattened.
 *
 * Emitted only when the last sheet did set a size, so a client that has never
 * been asked for one carries no rule at all. */
const chatTextRevert = () => `${CHAT_TEXT_SELECTORS},${COMPOSER_SELECTORS} {
  font-size: revert !important;
  line-height: revert !important;
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

/* `before` is what the last sheet was built from, and it is not bookkeeping for
   its own sake: see chatTextRevert -- a sheet that is in the page is in it for
   good, so anything that was switched on has to be switched off by name. */
const build = ({ fontSize, chatScale }, before) => {
  /* ARABIC_CLIP and MESSAGE_BIDI are unconditional, so nothing here has to be
     written back out to undo them -- which is the whole reason `before` exists
     for the rules that are not. */
  const rules = [CONVERSATION_SCROLL, DRAWER_MOTION, ARABIC_CLIP, MESSAGE_BIDI];

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

  const chat = chatText(chatScale);
  if (chat) rules.push(chat);
  else if (before && scaled(before.chatScale)) rules.push(chatTextRevert());

  return rules.join('\n');
};

module.exports = { build, stack, aliasSheet };
