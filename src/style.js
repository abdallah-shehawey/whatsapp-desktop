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
 * A PICTURE'S CAPTION is the same body in a different place, and that is why
 * the rules below are not scoped to #main and not scoped to div.copyable-text
 * either. Measured on the live client, in the conversation and in the viewer
 * that opens when the picture is clicked:
 *
 *   div                                     -- plain, direction ltr
 *     span.selectable-text.copyable-text     -- INLINE, isolate, pre-wrap
 *       span "first line\n" ...              the same line spans as above
 *
 * The class that says "this is a message body" is on the SPAN here and there is
 * no div.copyable-text immediately above it -- the bubble's is three divs up,
 * and the media viewer is mounted outside #main altogether. So the selector
 * that fixed a bubble reached neither of them, and an Arabic caption wrapped
 * the wrong way round in both: "لما حد بعت صوره وبعدها كلام السطر التاني جه
 * شمال مع انه بييجي يمين". Naming the span rather than its ancestors reaches
 * every one of the three, and it was checked against what else carries those
 * classes: 75 of them on a loaded page, 21 message bodies and 54 nested inside
 * one -- a link, a mention, a bold run -- which the child combinator excludes,
 * and the composer, which is a <p> under [contenteditable].
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
/* A message body wherever it is drawn: a bubble, a picture's caption under it,
   and the caption again in the viewer the picture opens into. WhatsApp puts
   both classes on the one span and nests the links, mentions and bold runs
   inside it under spans of their own, which the child combinator leaves alone.
   The composer is a <p>, and [contenteditable] keeps this off it either way. */
const BODY = 'div:not([contenteditable]) > span.selectable-text.copyable-text';

const MESSAGE_BIDI = `
/* The body of a message: a box of its own, aligned to the start of the
   direction WhatsApp worked out for it. */
${BODY} {
  display: block !important;
  unicode-bidi: isolate !important;
  text-align: start !important;
}
/* Each line in it: its own direction, from its own first strong character, and
   the start margin of that direction. Arabic right, English left, whatever
   either of them happens to begin with. */
${BODY} > span,
${BODY} ul,
${BODY} li {
  unicode-bidi: plaintext !important;
  text-align: start !important;
}
/* A bulleted list, and the side its bullets need room on.
 *
 * A line that begins "• " is not text to WhatsApp: it builds a real
 * <ul dir="ltr"> of <li dir="auto">, draws the bullet as a ::before rather than
 * a marker (list-style-type is none), and lays the gutter out to the left --
 * the list carries an inline-start margin and each item a padding-left, both of
 * which are the LEFT under the dir="ltr" it puts on the list. An Arabic item
 * resolves right-to-left from its own text, so its bullet is drawn at the RIGHT
 * margin, where nothing reserved it any room. Measured on the reported message:
 * every list line started 3.96px OUTSIDE the bubble's clipping box -- the width
 * of the 4px gap the ::before carries as margin-right -- and overflow:hidden
 * sheared the bullet and the first letter off each of them. That is the report,
 * "العربي اول كذا حرف من كذا سطر بيتاكل": only the bulleted lines, and only in a
 * message long enough for the bubble to reach its full width, because a bubble
 * narrower than that simply grew by the 4px instead.
 *
 * So the list is turned round -- direction, rather than a margin of our own,
 * because the indent WhatsApp puts on it is a logical one and flipping the
 * direction moves it to the side the items read from without this file having
 * to know how wide it is. The item's own gutter is physical and has to be
 * named: 12px, which is what WhatsApp asks for on the other side. Measured
 * after: 16px of slack inside the box, bullets drawn, nothing sheared.
 *
 * :dir() is what keeps this off an English list -- it matches the direction
 * the item actually resolved to, which for dir="auto" is the only place that
 * answer exists. An ordered list is deliberately not included: its numbers are
 * real ::markers and it was measured NOT to overflow when its items run
 * right-to-left. */
${BODY} ul:has(> li:dir(rtl)) {
  direction: rtl !important;
}
${BODY} li:dir(rtl) {
  padding-left: 0 !important;
  padding-right: 12px !important;
}
/* And the gap between a bullet and its words, which WhatsApp writes as
   margin-right -- the far side of the bullet once the line reads the other
   way. The logical form is the same 4px in a left-to-right list. */
${BODY} li::before {
  margin-right: 0 !important;
  margin-inline-end: 4px !important;
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
/* The chat list, which is a left-to-right list and stays one.
 *
 * A conversation is the words themselves and they are laid out the way they
 * read; the list beside it is furniture -- a column of rows with a picture at
 * one end, a name at the top and a time at the other end -- and that column is
 * drawn left-to-right whatever the names in it happen to be. Arabic names were
 * hanging off the right margin while the English ones started at the left, so
 * there was no column at all: "خلي مكان الاسماء في نفس مكان الانجليزي ... بس
 * يكون مكتوب صح".
 *
 * MEASURED on the live list, 2026-09-03, because the shape is not what a first
 * guess says it is:
 *
 *   span[title][dir="auto"]   the NAME. display: BLOCK, so it fills the row and
 *                             places its own text; direction resolves per name,
 *                             rtl for an Arabic one. WhatsApp aligns it to the
 *                             START of that direction, which on an Arabic name
 *                             is the RIGHT margin. There is no dir="rtl" anywhere
 *                             in this pane -- a rule written for one matches
 *                             nothing, which is what the rule this replaced did.
 *   span[title] with NO dir   the PREVIEW. A flex box the page leaves ltr, with
 *                             the message wrapped in explicit bidi controls, so
 *                             it already starts at the left and needs nothing.
 *
 * Text extents, before -- Range.selectNodeContents on each name, against its own
 * box: every Arabic name sat 0px off the RIGHT edge (28, 80, 180, 221, 244px of
 * empty box to its left), every Latin one 0px off the left.
 *
 * So the box is left-aligned and NOTHING is said about direction: the span keeps
 * the direction WhatsApp worked out, the words are still ordered right to left
 * and still shaped, and a name too long for the row still fills it and is cut
 * at its own end. Alignment is where the text sits in the box; direction is
 * what the letters do. Only the first is being answered here.
 *
 * !important because this sheet is at user origin, where a normal declaration
 * loses to the page's own -- and the alignment being corrected here is the
 * page's own. */
#pane-side span[title][dir] {
  text-align: left !important;
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
 * A placeholder avatar that is drawn bigger than the hole it is drawn in.
 *
 * WhatsApp gives every one of these icons the presentational attributes
 * `width="212" height="212"` and relies on a stylesheet to size it down. For the
 * `-refreshed` icons that stylesheet exists; for the plain `default-group` the
 * group-invite dialog uses, it does not -- measured on the live page, side by
 * side in one report: `default-group-refreshed` came out 31x31 in its 31x31 box,
 * and `default-group` came out 212x212 in a 104x104 box whose overflow is
 * hidden. So a fifth of the icon is drawn and the rest is cut away, which is a
 * group avatar as an off-centre grey blob -- and it is WhatsApp's own, not this
 * client's: nothing here has ever styled an svg.
 *
 * The rule is `max-` and not `width`, deliberately. It can only ever shrink an
 * icon that does not fit, so every icon that WhatsApp does size correctly is
 * left exactly as it was -- verified across the six on that page, wordmark and
 * lock and key included, all unchanged to the pixel. The viewBox and
 * `preserveAspectRatio="xMidYMid meet"` that come with each icon are what put
 * the shrunk one back in the middle, in shape.
 */
const ICON_FIT = `
span[data-icon] > svg {
  max-width: 100%;
  max-height: 100%;
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
 * The reply bar over the composer, and the one thing this sheet does for it.
 *
 * Clicking Reply mounts [data-testid="popup_panel"] into a footer with the
 * quoted message inside it. Its entrance and its exit are both taken over in
 * src/page/inject.js -- why, and against what measurements, is written out
 * there -- and all that needs from CSS is the moment it arrives.
 *
 * That is what this is: a one-millisecond animation that changes nothing and
 * raises `animationstart` on every mount, in every chat, group and community,
 * with no observer walking the page to find the panel.
 *
 * It is the drawer's case turned round, which is the only reason a mount event
 * works here at all. That panel is never unmounted, so an animation of ours on
 * it would play once and never again; this one is removed from the DOM every
 * time the bar is dismissed -- measured, the node is gone about 300ms after the
 * close begins -- and a fresh element gets a fresh animation.
 *
 * `!important` because the sheet is at user origin, where a normal declaration
 * loses to the page's own. Overriding an animation is what the drawer's note
 * above warns against, and there is nothing here to override: WhatsApp declares
 * no animation on this panel -- computed animation-name: none, measured -- and
 * springs the bar open from JavaScript instead.
 */
const PANEL_MOUNT = `
footer [data-testid="popup_panel"] {
  animation: whatsapp-desktop-panel 1ms !important;
}
@keyframes whatsapp-desktop-panel { from { opacity: 1; } to { opacity: 1; } }`;

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

/*
 * Two scripts, one family name.
 *
 * "A font for English and a font for Arabic" cannot be a selector: there is no
 * way in CSS to say "the Arabic words in this paragraph", and even if there
 * were, a rule matching text rather than elements is exactly the per-element
 * cost this file exists to avoid. What CAN say it is `unicode-range` -- a
 * descriptor on the @font-face itself, resolved by the font engine per
 * character, for nothing.
 *
 * So each family the page names is given two faces: one with no range, which
 * covers everything, and one whose range is the Arabic blocks. Both match an
 * Arabic character, both have the same weight and style, and CSS breaks that
 * tie by declaration order -- the LAST rule wins. That is why the Arabic face
 * is written second, and why moving it is a bug rather than a tidy-up.
 *
 * The same descriptor is what carries the rest of it. `size-adjust` scales the
 * glyphs and the metrics of one face, so Arabic can be drawn a size up from
 * the Latin beside it in the same line, and `src: local(<the family's bold
 * face>)` is what "bold Arabic" means -- see src/fonts.js, where the face is
 * chosen. A family with no bold face cannot be made bold and the settings
 * window says so rather than offering a switch that does nothing.
 */
const ARABIC_RANGE = [
  'U+060C-06FF',          /* Arabic, from the comma: the Latin punctuation
                             before it is better left with the Latin font */
  'U+0750-077F',          /* Arabic Supplement */
  'U+0870-08FF',          /* Arabic Extended-A and -B */
  'U+FB50-FDFF',          /* Presentation Forms-A */
  'U+FE70-FEFF',          /* Presentation Forms-B */
  'U+10E60-10E7E',        /* Rumi numerals */
  'U+1EE00-1EEFF',        /* Arabic Mathematical Alphabetic Symbols */
].join(', ');

/* The family the client names when it wants its own choice by name -- the two
   scripts under one roof, for the one rule at the foot of this sheet that has
   to name a family rather than redefine one the page already names. */
const UI_FAMILY = 'WhatsApp Desktop';

const local = names => names.map(name => `local("${String(name).replace(/"/g, '')}")`).join(', ');

const face = (family, src, { italic, range, size }) => `@font-face {
  font-family: "${family.replace(/"/g, '')}";
  src: ${local(src)};
  font-weight: 1 1000;
  font-style: ${italic ? 'italic' : 'normal'};${range ? `\n  unicode-range: ${range};` : ''}${size ? `\n  size-adjust: ${size}%;` : ''}
}`;

/* One face per family covering the whole weight range: the chosen font is one
   file, and Chromium synthesises what it has to from it, which is exactly what
   the universal rule this replaced used to do. */
const facesFor = (name, script, range) => [
  face(name, script.normal, { italic: false, range, size: script.size }),
  face(name, script.italic, { italic: true, range, size: script.size }),
];

const fontFaces = (stack, chosen) => {
  if (!chosen || !chosen.latin) return '';

  const wanted = String(stack || '').split(',')
    .map(name => name.trim().replace(/^["']|["']$/g, ''))
    .filter(name => name && !GENERIC.has(name.toLowerCase()) && !KEEP.test(name))
    .filter(name => name.toLowerCase() !== chosen.latin.family.toLowerCase());

  const names = [...new Set(wanted)];
  /* While the fonts are inherited from the desktop this is the sheet it has
     always been: the page's own families, pointed at one file, and nothing
     else. The name of our own is only needed by the rule below it. */
  if (!chosen.inherit) names.push(UI_FAMILY);
  if (!names.length) return '';

  const rules = names.flatMap(name => [
    ...facesFor(name, chosen.latin, ''),
    /* Second, and that is the whole mechanism: same family, same weight, same
       style, and a range that Arabic falls inside -- so for an Arabic
       character the later rule wins, and for every other character it was
       never a candidate. */
    ...(chosen.arabic ? facesFor(name, chosen.arabic, ARABIC_RANGE) : []),
  ]);

  /* And the text the page names no family for at all.
   *
   * fontconfig answers that one -- it is what the `sans-serif` alias in
   * src/fonts.js is for -- but fontconfig is read once, at startup, so a font
   * chosen from Settings would not reach it until the next launch. This rule
   * reaches it now, and it is deliberately NOT !important: a normal
   * declaration at user origin loses to the page's own, so it applies exactly
   * where WhatsApp has said nothing and nowhere else. One element, inherited,
   * with no selector to match per row.
   *
   * The emoji families are named after it because a font chosen for words has
   * no emoji in it, and the generic last because a script neither font covers
   * has to land somewhere. */
  const belt = chosen.inherit ? '' : `
html {
  font-family: "${UI_FAMILY}", "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif;
}`;

  return rules.join('\n') + belt;
};

/*
 * Every rule in this sheet is unconditional now, so nothing has to be written
 * back out to undo it -- which is what the second argument used to be for.
 *
 * It is kept, and it is not dead weight: a sheet inserted at user origin cannot
 * be taken out of the page again (measured -- insertCSS returns a key,
 * removeInsertedCSS resolves for it, and the rules are still applied), so the
 * day a rule here becomes a switch again, "off" has to be a rule that
 * contradicts it by name and this is where the last sheet's options arrive.
 * That was the whole shape of the conversation-text size that lived here until
 * 2026-09-03, when it came out of the settings for good.
 */
const build = ({ fontSize }, before) => {
  const rules = [CONVERSATION_SCROLL, DRAWER_MOTION, PANEL_MOUNT, ARABIC_CLIP, MESSAGE_BIDI, ICON_FIT];

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

  return rules.join('\n');
};

module.exports = { build, stack, fontFaces };
