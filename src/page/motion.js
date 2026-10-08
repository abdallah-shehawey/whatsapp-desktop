'use strict';

/* Explicit keyframes let ResizeObserver start a compositor glide without the
 * synchronous offsetHeight read that a CSS transition needs between writes.
 * Each element has one owner, shared by arrivals and the reply bar. */
const create = ({ later = setTimeout, cancelLater = clearTimeout } = {}) => {
  const moving = new WeakMap();
  let generation = 0;
  const restore = (element, record) => {
    for (const key of ['transform', 'transition', 'opacity'])
      element.style[key] = record.base[key];
  };
  const park = (element, at, dim) => {
    let record = moving.get(element);
    if (!record) {
      record = { base: {}, animation: null, timer: null };
      for (const key of ['transform', 'transition', 'opacity'])
        record.base[key] = element.style[key];
      moving.set(element, record);
    }
    cancelLater(record.timer);
    element.__waMove = ++generation;
    element.style.transition = 'none';
    element.style.transform = `translate3d(0, ${at}px, 0)`;
    if (dim) element.style.opacity = '0';
    if (record.animation) { record.animation.cancel(); record.animation = null; }
  };
  const letGo = (element, duration, easing, dim) => {
    const record = moving.get(element);
    if (!record) return;
    const mine = element.__waMove = ++generation;
    const from = { transform: element.style.transform };
    const to = { transform: record.base.transform || 'none' };
    if (dim) { from.opacity = element.style.opacity; to.opacity = record.base.opacity || '1'; }
    const finish = () => {
      if (element.__waMove !== mine || moving.get(element) !== record) return;
      cancelLater(record.timer);
      if (record.animation) record.animation.cancel();
      restore(element, record);
      moving.delete(element);
    };
    try {
      record.animation = element.animate([from, to], { duration, easing, fill: 'both' });
      /* The keyframes now own the offset. The underlying style is already the
         destination, so completion, cancellation and a hidden window all settle. */
      restore(element, record);
      record.animation.onfinish = finish;
      record.timer = later(finish, duration + 100);
    } catch (err) {
      finish();
    }
  };
  const stop = element => {
    const record = moving.get(element);
    if (!record) return;
    element.__waMove = ++generation;
    cancelLater(record.timer);
    if (record.animation) record.animation.cancel();
    restore(element, record);
    moving.delete(element);
  };
  return { park, letGo, stop };
};

module.exports = { create };
