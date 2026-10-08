'use strict';

const assert = require('assert');
const { start } = require('../src/page/navigation.js');

const rig = ({ reduced = false, rtl = false, registry = true, beforeHtml = false, deferRestore = false, scheduled = false, preparation = false } = {}) => {
  const handlers = {};
  let update, selected, main = null, active = '', last = 'old', cancelled = 0;
  let layers = [], covered = false, back = false;
  let media = false, mediaSearch = false;
  let meList = null;
  let panelNodes = [], bodyReady = true;
  let messageKey = '';
  let animations = [], presses = 0, timers = [], frames = [], restores = 0;
  const restore = { cancelPendingLastActiveChatRestore: () => cancelled++,
    openLastActiveChatIfNotLocked: () => { restores++; return Promise.resolve(); } };
  const animatedElement = name => ({
    name, isConnected: true, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    animate(frames, options) {
      const a = { target: this, frames, options, cancel() { this.cancelled = true; this.playState = 'idle'; } };
      if (preparation) {
        a.playState = 'running';
        a.pause = () => { a.playState = 'paused'; };
        a.play = () => { a.playState = 'running'; a.played = true; };
      }
      animations.push(a); return a;
    },
  });
  const list = animatedElement('list');
  list.firstElementChild = {};
  const sectionContainer = {};
  // Each button closes over its own selected state, just as aria-pressed does.
  const makeButton = icon => {
    const b = {
      getAttribute: () => selected === b ? 'true' : 'false',
      querySelectorAll: () => [{ textContent: icon }],
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 40 }),
      contains: e => e === b,
      closest: () => b,
    };
    return b;
  };
  const chats = makeButton('wds-ic-chat-filled');
  const section = makeButton('wds-ic-communities');
  selected = chats;
  const root = { querySelectorAll: () => [chats, section], contains: e => e === chats || e === section };
  const mediaButton = makeButton('ic-close');
  const mediaPanel = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    getClientRects: () => [1],
    contains: el => el === mediaPanel,
    querySelectorAll: () => [mediaButton],
    querySelector: () => mediaSearch ? {} : null,
  };
  const document = {
    documentElement: beforeHtml ? null : { getAttribute: () => rtl ? 'rtl' : 'ltr' },
    querySelector: selector => selector === '#main' ? main
      : selector === '#pane-side' ? list
      : selector === '[data-testid="media-hub-modal"]' ? (media ? mediaPanel : null)
      : selector.includes('me-tab-drawer') ? meList
      : selector === '[data-testid="chatlist-header"]' ? root
      : selector.includes('drawer-left') && back ? { querySelectorAll: () => [{ textContent: 'ic-arrow-back' }] } : null,
    querySelectorAll: selector => selector.startsWith('[data-testid="drawer-left"]') ? panelNodes : layers,
    elementFromPoint: () => covered ? {} : media ? mediaPanel : chats,
  };
  const view = {
    document,
    matchMedia: () => ({ matches: reduced }),
    addEventListener: (type, cb) => { handlers[type] = cb; },
    setTimeout: cb => timers.push(cb),
    ...(deferRestore || scheduled ? { requestAnimationFrame: cb => frames.push(cb) } : {}),
    MutationObserver: class {
      constructor(cb) { update = cb; }
      observe(target) { assert.equal(target, document, 'startup observes the document before html exists'); }
    },
    require: name => {
      if (!registry) throw new Error('private module renamed');
      if (name === 'WAWebChatCollection') return { ChatCollection: { getActive: () => active ? { id: active } : null } };
      if (name === 'WAWebSideNavButtonsActivityModel') return { setLastActiveChat: value => { last = value; } };
      if (name === 'WAWebOpenLastActiveChatAction') return restore;
      return null;
    },
  };
  start({ window: view, log() {}, press: button => {
    presses++;
    if (button === mediaButton) media = false;
    else selected = chats;
    update();
  } });
  const key = extra => {
    const e = { key: 'Escape', preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    handlers.keydown(e);
    return e;
  };
  return {
    key, update,
    open: (id, replace = false, commit = true) => {
      document.documentElement ||= { getAttribute: () => rtl ? 'rtl' : 'ltr' };
      active = id;
      if (commit) messageKey = id;
      if (!main || replace) {
        const body = animatedElement('body'), messages = animatedElement('messages'), header = animatedElement('header'), footer = animatedElement('footer');
        messages.querySelector = () => ({ getAttribute: () => messageKey });
        main = animatedElement('frame');
        main.querySelector = selector => selector.includes('conversation-panel-body') ? (bodyReady ? body : null)
          : selector.includes('conversation-panel-messages') ? (bodyReady ? messages : null)
          : selector === 'header > div' ? header : selector === 'footer > div' ? footer : null;
      }
      update();
    },
    commitMessages: id => { messageKey = id; update(); },
    close: () => {
      const removed = main; main = null; active = '';
      update([{ type: 'childList', removedNodes: removed ? [removed] : [] }]);
    },
    leave: () => {
      handlers.click({ target: section });
      last = active; main = null; active = '';
      update(); // Native code closes the chat before switching aria-pressed.
      selected = section; update();
    },
    returnByClick: (restoreChat = false) => {
      handlers.click({ target: chats }); selected = chats;
      const pending = restoreChat ? restore.openLastActiveChatIfNotLocked() : null;
      update(); return pending;
    },
    nativeRestore: () => restore.openLastActiveChatIfNotLocked(),
    paint: () => { const pending = frames; frames = []; pending.forEach(cb => cb()); },
    hide: () => { document.visibilityState = 'hidden'; handlers.visibilitychange(); },
    mutate: target => update([{ type: 'childList', target }]),
    selectSection: () => { selected = section; update(); },
    addPanel: (placeholder = false) => {
      const panel = animatedElement('panel');
      panel.closest = () => sectionContainer;
      panel.firstElementChild = animatedElement('panel-content');
      if (placeholder) panel.querySelector = () => ({ matches: () => true });
      panelNodes.unshift(panel); update(); return panel;
    },
    removePanel: panel => { panel.isConnected = false; panelNodes = panelNodes.filter(p => p !== panel); update(); },
    setBodyReady: ready => { bodyReady = ready; update(); },
    setListReady: ready => { list.firstElementChild = ready ? {} : null; update(); },
    setLayer: on => { layers = on ? [{ contains: () => false, getBoundingClientRect: () => ({ width: 20, height: 20 }), getClientRects: () => [1] }] : []; },
    setMedia: on => { media = on; },
    setMediaSearch: on => { mediaSearch = on; },
    setMeList: on => {
      meList = on ? { getBoundingClientRect: () => ({ width: 400, height: 600 }), getClientRects: () => [1] } : null;
      layers = meList ? [meList] : [];
    },
    setCovered: on => { covered = on; },
    setBack: on => { back = on; },
    drain: () => { const pending = timers; timers = []; pending.forEach(cb => cb()); },
    get state() { return { last, cancelled, animations, presses, restores }; },
  };
};

const r = rig();
r.open('a');
assert.deepEqual(r.state.animations.map(a => a.target.name), ['messages', 'header', 'footer'], 'the first opening keeps its lateral entrance without moving the frame or wallpaper');
r.update();
assert.equal(r.state.animations.length, 3, 'messages and timestamps do not replay entrance motion');
r.open('b');
assert.deepEqual(r.state.animations.slice(3).map(a => a.target.name), ['messages', 'header'], 'switching reuses the scroll layer and identity, keeping the body, frame and composer fixed');
assert.ok(r.state.animations.slice(0, 3).every(a => a.cancelled), 'rapid switches cancel the first entrance');
r.open('b');
assert.equal(r.state.animations.length, 5, 'clicking the current chat does not replay its animation');
r.open('c', true);
assert.equal(r.state.animations.length, 7, 'a replacement #main uses the same quiet swap as a reused #main');
assert.ok(r.state.animations.slice(3, 5).every(a => a.cancelled), 'a rapid swap cancels the previous content reveal');
r.leave();
assert.equal(r.state.last, 'c', 'leaving Chats preserves the still-open chat');
r.drain();
assert.equal(r.state.last, 'c', 'settling another tab preserves its return target');
let e = r.key({ defaultPrevented: true });
assert.ok(e.prevented && e.stopped && r.state.presses === 1, 'one Escape returns even when native code prevented it');
r.open('b');
r.close();
assert.equal(r.state.last, null, 'manual close clears the restore target');
assert.ok(r.state.cancelled >= 2, 'manual close cancels an asynchronous restore');
r.selectSection();
r.key();
assert.equal(r.state.last, null, 'Escape does not revive a closed chat');
r.selectSection();
r.returnByClick();
assert.equal(r.state.last, null, 'clicking Chats also respects manual close');
r.selectSection();
for (const guard of ['setLayer', 'setCovered', 'setBack']) {
  r[guard](true);
  const before = r.state.presses;
  assert.ok(!r.key().stopped && r.state.presses === before, guard + ' keeps Escape with the foreground layer');
  r[guard](false);
}
for (const modifiers of [{ repeat: true }, { isComposing: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }])
  assert.ok(!r.key(modifiers).stopped, 'modified/repeated Escape does not navigate');
const reduced = rig({ reduced: true });
reduced.open('a');
assert.equal(reduced.state.animations.length, 0, 'reduced motion disables chat entrance');
reduced.selectSection();
assert.ok(reduced.key().stopped, 'reduced motion still allows navigation');
const rtl = rig({ rtl: true });
rtl.open('a');
assert.equal(rtl.state.animations[0].frames[0].transform, 'translate3d(-14px, 0, 0)', 'Arabic entrance follows the interface direction');
const fallback = rig({ registry: false });
fallback.open('a'); fallback.close(); fallback.selectSection();
assert.ok(fallback.key().stopped, 'navigation still works if private WhatsApp modules disappear');
const modal = rig();
modal.setMedia(true);
assert.ok(modal.key({ defaultPrevented: true }).stopped, 'Media closes on its first Escape while Chats remains selected');
assert.equal(modal.state.presses, 1);
modal.setMedia(true); modal.setLayer(true);
assert.ok(!modal.key().stopped, 'a menu in Media receives Escape before the modal');
modal.setLayer(false); modal.setMediaSearch(true);
assert.ok(!modal.key().stopped, 'search in Media receives Escape before the modal');
const me = rig();
me.selectSection(); me.setMeList(true);
assert.ok(me.key().stopped, 'the permanent You list is a section, not a popup layer');
const early = rig({ beforeHtml: true });
early.open('a');
assert.equal(early.state.animations.length, 3, 'the first chat animates after document-start without an html root');
const delayed = rig();
delayed.setBodyReady(false); delayed.open('a');
assert.equal(delayed.state.animations.length, 0, 'an incomplete mount does not animate an empty frame');
delayed.setBodyReady(true);
assert.equal(delayed.state.animations.length, 3, 'motion starts when the conversation content commits');
delayed.close(); delayed.setBodyReady(false); delayed.open('b'); delayed.close(); delayed.setBodyReady(true);
assert.equal(delayed.state.animations.length, 3, 'closing a pending chat cannot replay a stale entrance');
const sections = rig();
sections.selectSection();
const firstPanel = sections.addPanel();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'active');
assert.equal(sections.state.animations.at(-1).target, firstPanel.firstElementChild, 'one animation owns the section content, leaving the native outer wrapper steady');
sections.update();
assert.equal(sections.state.animations.length, 1, 'section content mutations do not replay its entrance');
const profilePanel = sections.addPanel();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'inactive', 'a nested page retires the prior wrapper even with the same rail selection');
assert.equal(profilePanel.attributes['data-wa-navigation-panel'], 'active', 'the nested page gets its own reveal');
sections.key();
assert.equal(firstPanel.attributes['data-wa-navigation-panel'], 'inactive', 'returning to Chats hides the retiring section before native unmount');
assert.ok(sections.state.animations[0].cancelled, 'returning during a section reveal cancels it');
sections.selectSection();
const secondPanel = sections.addPanel();
assert.equal(secondPanel.attributes['data-wa-navigation-panel'], 'active', 'reopening a section gets a fresh reveal');
const secondAnimation = sections.state.animations.at(-1);
sections.removePanel(secondPanel);
assert.ok(secondAnimation.cancelled, 'removing an animated section cancels its motion');
assert.equal(profilePanel.attributes['data-wa-navigation-panel'], 'active', 'a retained page becomes visible again when returning from a nested page');
const returning = rig({ deferRestore: true });
returning.open('a'); returning.paint(); returning.leave(); returning.paint();
returning.returnByClick(true);
assert.equal(returning.state.restores, 0, 'conversation rebuilding waits for the tab to paint');
returning.paint();
assert.equal(returning.state.animations.at(-1).options.duration, 220, 'Chats uses the same duration as the other sections');
assert.equal(returning.state.animations.at(-1).frames[0].opacity, 0, 'Chats gets the full section reveal');
returning.paint();
assert.equal(returning.state.restores, 0, 'restore runs in a task after the first paint');
returning.drain();
assert.equal(returning.state.restores, 1, 'native lock and restore checks run once after painting');
returning.leave(); returning.paint(); returning.returnByClick(true); returning.leave(); returning.paint(); returning.drain();
assert.equal(returning.state.restores, 1, 'a rapid departure cancels a deferred restore');
const lateList = rig();
lateList.setListReady(false); lateList.selectSection(); lateList.returnByClick();
assert.equal(lateList.state.animations.length, 0, 'a loading list does not consume the return animation');
lateList.setListReady(true);
assert.equal(lateList.state.animations.length, 1, 'Chats reveals when its content is ready');
lateList.mutate({ closest: () => ({}) });
assert.equal(lateList.state.animations.length, 1, 'a preview update does not restart navigation');
const batched = rig({ scheduled: true });
batched.open('a'); batched.open('b'); batched.update();
assert.equal(batched.state.animations.length, 0, 'separate commits wait for a single paint');
batched.paint();
assert.equal(batched.state.animations.length, 3, 'only the final conversation gets an entrance');
batched.open('c'); batched.close(); batched.paint();
assert.equal(batched.state.animations.length, 3, 'closing before paint cancels a pending entrance');
batched.selectSection(); batched.addPanel(); batched.returnByClick(); batched.paint();
assert.equal(batched.state.animations.filter(a => a.target.name === 'panel-content').length, 0,
  'a section abandoned before paint never animates over Chats');
const prepared = rig({ scheduled: true, preparation: true });
prepared.open('a'); prepared.paint();
assert.ok(prepared.state.animations.every(a => a.playState === 'paused'), 'the first layout prepares the scroll layer before starting the reveal');
prepared.paint();
assert.ok(prepared.state.animations.every(a => a.played), 'the reveal starts after its prepared frame');
prepared.open('b'); prepared.paint(); prepared.hide(); prepared.paint();
assert.ok(prepared.state.animations.slice(3).every(a => a.cancelled && !a.played),
  'hiding during preparation settles content instead of replaying a stale reveal on return');
const staged = rig();
staged.open('a'); staged.open('b', false, false);
assert.equal(staged.state.animations.length, 3, 'an early active-model change cannot animate the old messages');
staged.commitMessages('b');
assert.equal(staged.state.animations.length, 5, 'the newly committed conversation gets exactly one reveal');
staged.open('b', true);
assert.equal(staged.state.animations.length, 5, 'a second DOM mount for the same chat does not replay the reveal');
staged.open('c', false, false); staged.close(); staged.commitMessages('c');
assert.equal(staged.state.animations.length, 5, 'closing between model selection and message commit cancels the reveal');
const background = rig();
background.selectSection(); background.addPanel(true);
assert.equal(background.state.animations.length, 0, 'a full-size welcome background is never promoted for a tab reveal');
const rapidClose = rig({ scheduled: true });
rapidClose.open('a'); rapidClose.paint(); rapidClose.close();
assert.equal(rapidClose.state.last, null, 'a closed chat is forgotten before visual reconciliation paints');
rapidClose.leave(); rapidClose.returnByClick(); rapidClose.paint();
assert.ok(!rapidClose.state.last, 'closing then changing tabs before paint cannot revive the conversation');
console.log('navigation checks pass');
