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
const body = shipped.slice(shipped.indexOf('> div > span.selectable-text {'));
assert.match(body, /display: block !important/);
assert.match(body, /unicode-bidi: isolate !important/);
assert.doesNotMatch(body.slice(0, body.indexOf('}')), /plaintext/);
const lines = shipped.slice(shipped.indexOf('> div > span.selectable-text > span'));
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
/* And no keyframes of our own here: a CSS animation on that panel plays once,
   because it is never unmounted. The slide is inject.js's, on animationstart. */
assert.doesNotMatch(shipped, /@keyframes/);

/* The conversation's own text size. 100 per cent is the page WhatsApp drew, so
   it emits nothing at all -- which is what keeps the default sheet as cheap as
   it was measured to be. */
assert.strictEqual(style.build({ fontSize: 16, chatScale: 100 }), shipped);
assert.strictEqual(style.build({ fontSize: 16, chatScale: 'nonsense' }), shipped);

const bigger = style.build({ fontSize: 16, chatScale: 130 });
assert.match(bigger, /font-size: calc\(0\.888rem \* 1\.30\) !important/);
/* In rem, so it still follows view.font-size, and never in em: these classes
   nest, and a multiplier would compound one level to the next. */
assert.doesNotMatch(bigger, /\dem \*/);
/* The line box moves with the size, or the taller text is drawn into the 19px
   box WhatsApp pinned it to -- and the composer keeps its own, which is set in
   em and follows on its own. */
assert.match(bigger, /line-height: 1\.35 !important/);
const composer = bigger.slice(bigger.indexOf('#main [contenteditable="true"]'));
assert.doesNotMatch(composer, /line-height/);
/* The chat list is not the conversation: what a size ADDS to the sheet reaches
   nothing in #pane-side. */
assert.ok(bigger.startsWith(shipped));
assert.doesNotMatch(bigger.slice(shipped.length), /pane-side/);
/* A community thread is a conversation, and its replies and its reply box move
   with the same knob. Left out, they stayed at WhatsApp's own 14.2px inside a
   client drawing every other message at the asked-for size. */
const added = bigger.slice(shipped.length);
assert.match(added, /\[data-testid="comment-row"\] \.selectable-text/);
assert.match(added, /popup-contents"\]:has\(\[data-testid="comment-row"\]\) \[contenteditable="true"\]/);

/* Back to 100 per cent after a bigger size. A user stylesheet cannot be taken
   out of the page again -- measured -- so "no rule" leaves the old sheet saying
   110%, and the way back has to be written down. */
const backToNormal = style.build({ fontSize: 16, chatScale: 100 },
                                 { fontSize: 16, chatScale: 110 });
assert.match(backToNormal, /font-size: revert !important/);
assert.match(backToNormal, /line-height: revert !important/);
/* And nothing of the kind for a client that was never asked for a size. */
assert.strictEqual(style.build({ fontSize: 16, chatScale: 100 },
                               { fontSize: 16, chatScale: 100 }), shipped);

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
