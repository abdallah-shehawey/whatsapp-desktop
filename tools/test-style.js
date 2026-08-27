'use strict';

const assert = require('assert');
const style = require('../src/style.js');

const shipped = style.build({ arabicFix: false, fontSize: 16 });
assert.match(shipped, /#main \[data-tab="conversation-panel-body"\]/);
assert.match(shipped, /will-change:\s*scroll-position/);
assert.match(shipped, /transform:\s*translate3d\(0, 0, 0\)/);
assert.doesNotMatch(shipped, /::\-webkit-scrollbar/);
assert.doesNotMatch(shipped, /\*\s*\{\s*font-family/);
assert.doesNotMatch(shipped, /copyable-text/);

const withArabicFix = style.build({ arabicFix: true, fontSize: 16 });
assert.match(withArabicFix, /copyable-text/);
assert.match(withArabicFix, /#main \[data-tab="conversation-panel-body"\]/);

console.log('style checks pass');
