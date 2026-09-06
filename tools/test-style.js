'use strict';

const assert = require('assert');
const style = require('../src/style.js');

const shipped = style.build({ fontSize: 16 });
/* The element this build actually scrolls. It was checked on the live page: the
   panel body is not the scroller, and this build spells the marker data-testid,
   so the rule as first written applied to nothing at all. */
assert.match(shipped, /#main \[data-testid="conversation-panel-messages"\]/);
assert.doesNotMatch(shipped, /conversation-panel-body/);
assert.match(shipped, /will-change:\s*scroll-position/);
assert.match(shipped, /transform:\s*translate3d\(0, 0, 0\)/);
assert.doesNotMatch(shipped, /::\-webkit-scrollbar/);
assert.doesNotMatch(shipped, /\*\s*\{\s*font-family/);

/* The Arabic clip and the bidi rules are not switchable and never were worth
   being: every build carries them. */
assert.match(shipped, /padding-bottom: 0\.2em !important/);
assert.match(shipped, /\[contenteditable="true"\][\s\S]*padding-bottom: 0\.35em !important/);

/* Which way a line of a message reads. The body is a block of its own so that a
   wrapping Arabic message aligns to the right and the timestamp is pushed off
   the last line; the lines inside it take their direction from their own first
   strong character. `isolate` on the body and `plaintext` on the lines, never
   the other way round -- plaintext on an inline box hides the only Arabic in it
   from the paragraph around it, and text-align: start then resolves to left. */
const body = shipped.slice(shipped.indexOf('span.selectable-text.copyable-text {'));
assert.match(body, /display: block !important/);
assert.match(body, /unicode-bidi: isolate !important/);
assert.doesNotMatch(body.slice(0, body.indexOf('}')), /plaintext/);
/* And it is the SPAN that is named, with no #main and no div.copyable-text in
   front of it. A picture's caption is the same body under three plain divs, and
   its viewer is mounted outside #main -- the scoped selector this replaced
   reached neither, so an Arabic caption wrapped flush left in both. */
assert.doesNotMatch(body.slice(0, body.indexOf('{')), /#main|div\.copyable-text/);
const lines = shipped.slice(shipped.indexOf('span.selectable-text.copyable-text > span'));
assert.match(lines, /unicode-bidi: plaintext !important/);
/* text-align: start, never `right` -- an English line inside an Arabic message
   belongs on the left, which is the whole point of doing this per line. */
assert.match(lines, /text-align: start !important/);
/* User origin: a normal declaration there loses to the page's own, and
   WhatsApp writes `text-align: end` on exactly the lines this has to correct. */
assert.doesNotMatch(shipped.slice(shipped.indexOf('span.selectable-text')),
                    /text-align: (start|end)(?! !important)/);

/* A community thread. Its panel is outside #main and holds no copyable-text, so
   a rule scoped to either reaches none of it -- which is how thread replies came
   out flush left with the conversation behind them flush right. */
const thread = shipped.slice(shipped.indexOf('[data-testid="comment-row"] span'));
assert.match(shipped, /\n\[data-testid="comment-row"\] span\[data-testid="selectable-text"\] \{/);
assert.match(thread, /display: block !important/);
assert.match(thread, /text-align: start !important/);
/* plaintext HERE and isolate above, and the two are not interchangeable: a
   reply is one span with white-space: pre-line and the newlines still in it, so
   the block IS the thing whose paragraphs need a direction each. Measured with
   isolate instead: an English line inside an Arabic reply went flush right. */
assert.match(thread.slice(0, thread.indexOf('}')), /unicode-bidi: plaintext !important/);
assert.doesNotMatch(thread.slice(0, thread.indexOf('}')), /isolate/);

/* The drawer's own entrance animates flex-basis, which lays the whole app out
   again on every frame of it. Here it is made instant; the motion it loses is
   put back on the compositor by slideTheDrawer() in src/page/inject.js.

   Never `animation: none`: the keyframes END at the width, so cancelling them
   leaves the drawer nought pixels wide and Message info stops opening. */
assert.match(shipped, /\[data-testid="drawer-right"\][\s\S]*animation-duration: 1ms !important/);
assert.doesNotMatch(shipped, /animation: none/);
/* And no motion of our own on THAT panel: a CSS animation on it plays once,
   because it is never unmounted. The slide is inject.js's, on animationstart. */
const drawer = shipped.slice(shipped.indexOf('[data-testid="drawer-right"]'));
assert.doesNotMatch(drawer.slice(0, drawer.indexOf('}')), /animation-name|@keyframes/);

/* The reply bar over the composer is the case turned round -- its panel IS
   unmounted every time, so keyframes on it fire on every mount and that is the
   event inject.js hangs its own entrance and exit on. The rule carries no
   motion itself; it exists to be started. */
assert.match(shipped, /footer \[data-testid="popup_panel"\] \{\n  animation: whatsapp-desktop-panel 1ms !important;/);
assert.match(shipped, /@keyframes whatsapp-desktop-panel/);
/* Not scoped to #main: a community thread draws its composer in a panel of its
   own, outside #main, and a reply written there deserves the same motion. */
assert.doesNotMatch(shipped, /#main footer \[data-testid="popup_panel"\]/);

/* A list of names is a column drawn one way round, and every name in it starts
   where the column does: an Arabic name sits where an English name sits, and
   only the words inside it read right to left.

   The name is the span that carries a dir attribute -- measured on the live
   list, every one of them says dir="auto" and NOT dir="rtl", so a rule written
   for the latter matches nothing at all. That is what the rule this replaced
   did, and it is why the names went on hanging off the right margin. */
const list = shipped.slice(shipped.indexOf('#pane-side span[title][dir]'));
assert.match(list, /text-align: left !important/);
assert.doesNotMatch(list.slice(0, list.indexOf('}')), /text-align: right/);
assert.doesNotMatch(shipped, /#pane-side[^{]*dir="rtl"/);
/* And which way round the column is drawn is WhatsApp's answer, not a constant:
   an Arabic interface puts <html dir="rtl">, the list on the right of the
   window and the picture at the right of every row, and a hard `left` there is
   the whole column pinned to the far side from the pictures. So the second half
   of the rule aligns the names to the right when the pane resolves rtl. */
assert.match(shipped, /#pane-side:dir\(rtl\) span\[title\]\[dir\]/);
assert.match(list.slice(list.indexOf(':dir(rtl)')), /text-align: right !important;/);
/* On the PANE, never on the name. `:dir()` against the span itself is the
   original bug written a second way -- dir="auto" resolves per name, so the
   Arabic ones would go right and the English ones left, which is exactly the
   report both halves of this rule exist to answer. */
assert.doesNotMatch(shipped, /span\[title\]\[dir\]:dir\(/);
/* And neither rule says anything about direction. Alignment is where the text
   sits in its box; `direction` or `unicode-bidi` on a name would be this client
   deciding which way a name reads, which is WhatsApp's answer to give. */
assert.doesNotMatch(list.slice(0, list.indexOf('}')), /direction:|unicode-bidi:/);
assert.doesNotMatch(list.slice(list.indexOf(':dir(rtl)')), /direction:|unicode-bidi:/);

/* The chat list is only one of those columns. The same names are listed again
   in the forward picker, on the Status tab, under New chat and in the search
   results, and each of those is a panel `#pane-side` cannot see -- so the scope
   is the row, which names itself `cell-frame-*` in every one of them. */
assert.match(shipped, /\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]/);
assert.match(shipped, /\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]/);
/* A PREFIX, and not `cell-frame-title`. A community's name above a group's is
   `cell-frame-label` -- 5 of the 76 names in the live chat list -- so a rule
   aimed at the title alone would drop them out of the column it claims to be
   generalising. `cell-frame-secondary`, the line underneath, comes with it and
   is meant to: it is furniture in the same row. */
assert.doesNotMatch(shipped, /\[data-testid="cell-frame-title"\] span\[title\]/);
/* Both halves of the pane rule stay, or neither does. `#pane-side` carries an
   id, so the plain one (1,2,1) outranks the general `:dir(rtl)` rule (0,4,1);
   drop `#pane-side:dir(rtl)` alone and an Arabic interface pins the chat list
   back to the left, which is the bug the pane rules were written to fix. */
assert.strictEqual(/#pane-side span\[title\]\[dir\]/.test(shipped),
                   /#pane-side:dir\(rtl\) span\[title\]\[dir\]/.test(shipped));

/* And the bio travels with the name it sits under -- "يبقي مع ال bio كمان يعني
   نحركهم الاتنين". A contact's About wears selectable-text and copyable-text on
   a plain div, so BODY above claims it as a message body at (0,3,2) and beats
   the row rule's (0,3,1); the name moved and the bio stayed against the right
   margin. Naming the class lifts the row rule over it. */
assert.match(shipped, /\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]\.selectable-text/);
assert.match(shipped, /\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]\.selectable-text/);
/* Both directions, or the bio is pinned left in an Arabic interface -- the same
   trap as the pane pair, one rule further down. */
assert.strictEqual(
  (shipped.match(/\[data-testid\^="cell-frame-"\] span\[title\]\[dir\]\.selectable-text/g) || []).length,
  (shipped.match(/\[data-testid\^="cell-frame-"\]:dir\(rtl\) span\[title\]\[dir\]\.selectable-text/g) || []).length);
/* The lift is specificity, not a second declaration: the class is named on the
   SAME rule, so a bio and the name above it can never disagree. */
const rowRule = shipped.slice(shipped.indexOf('#pane-side span[title][dir]'));
assert.match(rowRule.slice(0, rowRule.indexOf('}')), /\.selectable-text[\s\S]*text-align: left/);

/* There is no size knob for the conversation's own text any more. It was
   `view.chat-font-size`, it was a percentage that belonged to neither script
   beside the two per-script sizes in the Fonts window, and it came out of the
   client on 2026-09-03. What must not come back is a sheet that quietly
   re-sizes messages. */
assert.doesNotMatch(shipped, /0\.888rem/);
assert.doesNotMatch(shipped, /font-size: calc/);
/* An option the sheet no longer knows is not an option: an old config file
   still carrying the key changes nothing. */
assert.strictEqual(style.build({ fontSize: 16, chatScale: 130 }), shipped);
assert.strictEqual(style.build({ fontSize: 16 }, { fontSize: 16, chatScale: 110 }), shipped);

/* Nothing reverts the Arabic rules any more, because nothing turns them off.
   A sheet that is in the page is in it for good -- see style.js -- so a `revert`
   left over from the switch would be the newest rule and would undo them. */
assert.doesNotMatch(shipped, /revert/);

/* The placeholder avatar in the group-invite dialog, which WhatsApp draws at
   212px inside a 104px box. `max-` and not `width` is the whole point: the rule
   has to shrink the one icon that does not fit and leave every icon that does
   exactly where it was, so a plain `width: 100%` here would be the bug. */
assert.match(shipped, /span\[data-icon\] > svg \{[^}]*max-width: 100%/);
assert.match(shipped, /span\[data-icon\] > svg \{[^}]*max-height: 100%/);
assert.doesNotMatch(shipped, /span\[data-icon\] > svg \{[^}]*[^-]width: 100%/);

console.log('style checks pass');
