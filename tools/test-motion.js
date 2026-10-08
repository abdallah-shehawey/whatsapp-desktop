'use strict';

const assert = require('assert');
const { create } = require('../src/page/motion.js');
let timers = new Set();
const motion = create({
  later: cb => { timers.add(cb); return cb; },
  cancelLater: cb => timers.delete(cb),
});
const animations = [];
const element = {
  style: { transform: '', transition: 'opacity 100ms', opacity: '0.9' },
  get offsetHeight() { throw new Error('motion forced layout'); },
  animate(frames, options) {
    const animation = { frames, options, cancel() { this.cancelled = true; } };
    animations.push(animation);
    return animation;
  },
};
const original = { ...element.style };
motion.park(element, 55);
const arrivalClaim = element.__waMove;
motion.letGo(element, 220, 'ease-out');
assert.notEqual(element.__waMove, arrivalClaim, 'releasing takes ownership from a reply handover');
assert.equal(animations[0].frames[0].transform, 'translate3d(0, 55px, 0)');
assert.deepEqual(element.style, original, 'underlying styles settle immediately even if the window stops drawing');
const firstFinish = animations[0].onfinish;
motion.park(element, 28);
assert.ok(animations[0].cancelled, 'a new arrival cancels the previous glide');
motion.letGo(element, 140, 'ease-out');
firstFinish();
assert.ok(!animations[1].cancelled, 'an old completion cannot end a newer glide');
assert.equal(timers.size, 1, 'rapid arrivals retain only one cleanup timer');
animations[1].onfinish();
assert.ok(animations[1].cancelled, 'completion releases the compositor effect');
assert.equal(timers.size, 0);
assert.deepEqual(element.style, original);
motion.park(element, 67, true);
motion.letGo(element, 180, 'ease-out', true);
assert.equal(animations[2].frames[0].opacity, '0');
assert.equal(animations[2].frames[1].opacity, '0.9', 'reply content returns to its original opacity');
for (const callback of [...timers]) callback();
assert.deepEqual(element.style, original, 'the cleanup backstop restores a hidden window');
motion.park(element, 40, true);
motion.letGo(element, 180, 'ease-out', true);
const interrupted = animations[3];
motion.stop(element);
element.style.opacity = '0';
interrupted.onfinish();
assert.equal(element.style.opacity, '0', 'a dismissed reply entrance cannot overwrite its exit');
assert.ok(interrupted.cancelled);
assert.equal(timers.size, 0);
const unsupported = { style: { transform: '', transition: '', opacity: '' } };
motion.park(unsupported, 55, true);
motion.letGo(unsupported, 220, 'ease-out', true);
assert.deepEqual(unsupported.style, { transform: '', transition: '', opacity: '' },
  'a missing Web Animations API leaves content visible at rest');
console.log('motion checks pass');
