'use strict';

const assert = require('assert');
const style = require('../src/style.js');

const shipped = style.build({ arabicFix: false, fontSize: 16 });
/* The element this build actually scrolls. It was checked on the live page: the
   panel body is not the scroller, and this build spells the marker data-testid,
   so the rule as first written applied to nothing at all. */
assert.match(shipped, /#main \[data-testid="conversation-panel-messages"\]/);
assert.doesNotMatch(shipped, /conversation-panel-body/);
assert.match(shipped, /will-change:\s*scroll-position/);
assert.match(shipped, /transform:\s*translate3d\(0, 0, 0\)/);
assert.doesNotMatch(shipped, /::\-webkit-scrollbar/);
assert.doesNotMatch(shipped, /\*\s*\{\s*font-family/);
assert.doesNotMatch(shipped, /copyable-text/);

const withArabicFix = style.build({ arabicFix: true, fontSize: 16 });
assert.match(withArabicFix, /copyable-text/);
assert.match(withArabicFix, /#main \[data-testid="conversation-panel-messages"\]/);

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
assert.strictEqual(style.build({ arabicFix: false, fontSize: 16, chatScale: 100 }), shipped);
assert.strictEqual(style.build({ arabicFix: false, fontSize: 16, chatScale: 'nonsense' }), shipped);

const bigger = style.build({ arabicFix: false, fontSize: 16, chatScale: 130 });
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
/* The chat list is not the conversation: nothing here reaches #pane-side. */
assert.doesNotMatch(bigger, /pane-side/);

/* Back to 100 per cent after a bigger size. A user stylesheet cannot be taken
   out of the page again -- measured -- so "no rule" leaves the old sheet saying
   110%, and the way back has to be written down. */
const backToNormal = style.build({ arabicFix: false, fontSize: 16, chatScale: 100 },
                                 { arabicFix: false, fontSize: 16, chatScale: 110 });
assert.match(backToNormal, /font-size: revert !important/);
assert.match(backToNormal, /line-height: revert !important/);
/* And nothing of the kind for a client that was never asked for a size. */
assert.strictEqual(style.build({ arabicFix: false, fontSize: 16, chatScale: 100 },
                               { arabicFix: false, fontSize: 16, chatScale: 100 }), shipped);

/* The same for the Arabic clip, which had the same one-way switch. */
const arabicOff = style.build({ arabicFix: false, fontSize: 16 }, { arabicFix: true, fontSize: 16 });
assert.match(arabicOff, /padding-bottom: revert !important/);
assert.match(arabicOff, /text-align: revert !important/);
assert.strictEqual(style.build({ arabicFix: false, fontSize: 16 },
                               { arabicFix: false, fontSize: 16 }), shipped);

console.log('style checks pass');
