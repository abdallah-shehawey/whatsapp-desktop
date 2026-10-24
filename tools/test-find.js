'use strict';

/* Ctrl+F -- see src/page/find.js. Replayed against a fake page: no browser,
   no WhatsApp. Every timer is held and run by hand, and the clock with it. */

const assert = require('assert');
const { start } = require('../src/page/find.js');

/* Every node has a box of its own, so elementFromPoint can say which node is
   at a point: the node itself, or whatever the check has laid over it. */
let nodes = 0;
class Node {
  constructor(tag, attrs = {}, kids = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.kids = [];
    this.parent = null;
    this.text = attrs.text || '';
    this.index = ++nodes;
    this.under = null;
    for (const kid of kids) this.add(kid);
  }
  add(kid) { kid.parent = this; this.kids.push(kid); return kid; }
  get textContent() { return this.text; }
  get firstElementChild() { return this.kids[0] || null; }
  *walk() { for (const kid of this.kids) { yield kid; yield* kid.walk(); } }
  contains(other) { for (let n = other; n; n = n.parent) if (n === this) return true; return false; }
  querySelectorAll(selector) { return [...this.walk()].filter(match(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getBoundingClientRect() { return { left: this.index * 200, top: 10, width: 100, height: 30 }; }
}

const ancestor = (node, test) => { for (let n = node.parent; n; n = n.parent) if (test(n)) return true; return false; };
const hasattr = (name, value=true) => n => n.attrs[name] === value;
const testid = id => n => n.attrs['data-testid'] === id;
/* Only the selectors find.js asks with. Anything else throws, so a selector
   changed there cannot quietly match nothing here. */
const SELECTORS = {
  'svg title': n => n.tag === 'title',
  'button, [role="button"]': n => n.tag === 'button' || n.attrs.role === 'button',
  'input[type="text"]': n => n.tag === 'input' && n.attrs.type === 'text',
  '[data-testid="drawer-right"]': testid('drawer-right'),
  '[data-testid="drawer-left"]': testid('drawer-left'),
  '#side': n => n.attrs.id === 'side',
  '#main header': n => n.tag === 'header' && ancestor(n, m => m.attrs.id === 'main'),
  '[data-testid="media-hub-modal"] [aria-label="Search"]': n => testid('media-hub-modal')(n) && ancestor(n, hasattr('aria-label', 'Search'))
};
const match = selector => {
  if (!SELECTORS[selector]) throw new Error('unexpected selector: ' + selector);
  return SELECTORS[selector];
};

const icon = name => new Node('svg', {}, [new Node('title', { text: name })]);

const build = ({ commands = true, answers = true, magnifierOpens = true } = {}) => {
  let clock = 0;
  const timers = [];
  const listeners = [];
  const body = new Node('body');
  const t = { body, focused: null, selected: null, searched: [], pressed: [], logs: [] };

  const box = () => {
    const input = new Node('input', { type: 'text' });
    input.focus = () => { t.focused = input; };
    input.select = () => { t.selected = input; };
    return input;
  };
  const view = {
    document: {
      querySelector: selector => body.querySelector(selector),
      elementFromPoint: x => {
        const node = [body, ...body.walk()].find(n => n.index * 200 + 50 === x);
        return node && (node.under || node);
      },
    },
    setTimeout: (fn, ms) => { timers.push({ at: clock + ms, fn }); },
    addEventListener: (type, fn) => { if (type === 'keydown') listeners.push(fn); },
    require: name => {
      if (!commands) throw new Error('no module ' + name);
      if (name === 'WAWebCmd')
        return { Cmd: { chatSearch: chat => { t.searched.push(chat); if (answers) openPanel(); } } };
      if (name === 'WAWebChatCollection')
        return { ChatCollection: { getActive: () => (t.main ? 'the open chat' : null) } };
      throw new Error('no module ' + name);
    },
  };
  /* The panel arrives a little after it is asked for, the way React commits. */
  const openPanel = () => {
    if (t.panel) return;
    view.setTimeout(() => {
      t.panel = body.add(new Node('div', { 'data-testid': 'drawer-right' },
        [new Node('button', {}, [icon('wds-ic-calendar-search')])]));
      t.panelBox = t.panel.add(box());
    }, 40);
  };
  const press = (element, target) => {
    assert.ok(element.contains(target), 'a press is aimed inside what it presses');
    t.pressed.push(element);
    if (element === t.magnifier && magnifierOpens) openPanel();
  };
  const withClock = fn => {
    const real = Date.now;
    Date.now = () => clock;
    try { return fn(); } finally { Date.now = real; }
  };

  withClock(() => start({ press, log: line => t.logs.push(line), window: view }));

  return Object.assign(t, {
    chatList: () => {
      t.side = body.add(new Node('div', { id: 'side' }));
      t.sideBox = t.side.add(box());
    },
    conversation: ({ magnifier = true } = {}) => {
      t.main = body.add(new Node('div', { id: 'main' }));
      const header = t.main.add(new Node('header'));
      if (magnifier) t.magnifier = header.add(new Node('button', {}, [icon('ic-search')]));
      header.add(new Node('button', {}, [icon('ic-more-vert')]));
    },
    /* A section over the chat list -- Calls, Channels -- with a box of its
       own, and the chat list's box still mounted underneath it. */
    section: ({ withBox = true } = {}) => {
      t.left = body.add(new Node('div', { 'data-testid': 'drawer-left' }));
      if (withBox) t.leftBox = t.left.add(box());
      if (t.sideBox) t.sideBox.under = t.left;
    },
    key: (fields = {}) => {
      const event = Object.assign({ key: 'f', code: 'KeyF', ctrlKey: true, prevented: false,
                                    preventDefault() { this.prevented = true; } }, fields);
      withClock(() => { for (const fn of listeners) fn(event); });
      return event;
    },
    tick: ms => withClock(() => {
      const until = clock + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > until) break;
        const next = timers.shift();
        clock = next.at;
        next.fn();
      }
      clock = until;
    }),
  });
};

/* The chat list, nothing open: its own box. */
{
  const t = build();
  t.chatList();
  const event = t.key();
  assert.ok(event.prevented, 'Ctrl+F is taken when there is something to search');
  assert.equal(t.focused, t.sideBox, 'the chat list box gets the caret');
  assert.equal(t.selected, t.sideBox, 'with the last query selected, to be typed over');
}

/* A conversation: its message search, opened by WhatsApp's own command, and the
   caret put in the box once the panel has arrived -- the command leaves it out. */
{
  const t = build();
  t.chatList();
  t.conversation();
  const event = t.key();
  assert.ok(event.prevented, 'Ctrl+F in a conversation is taken');
  assert.deepEqual(t.searched, ['the open chat'], 'the search is asked of the open chat');
  assert.equal(t.focused, null, 'nothing is focused while the panel is on its way');
  t.tick(100);
  assert.equal(t.focused, t.panelBox, 'the caret lands in the message search box');
  assert.equal(t.selected, t.panelBox, 'with its last query selected');
  assert.deepEqual(t.pressed, [], 'and the magnifier is never pressed');

  /* Again, with the panel up: straight back to its box, nothing asked twice. */
  t.focused = null;
  t.key();
  assert.equal(t.focused, t.panelBox, 'a second Ctrl+F goes back to the open panel\'s box');
  assert.deepEqual(t.searched, ['the open chat'], 'without asking WhatsApp again');
}

/* WhatsApp's command gone with a deploy: the magnifier is pressed instead. */
{
  const t = build({ commands: false });
  t.conversation();
  t.key();
  assert.deepEqual(t.pressed, [t.magnifier], 'no command, so the magnifier is pressed');
  t.tick(100);
  assert.equal(t.focused, t.panelBox, 'and the box still gets the caret');
}

/* The command still there and doing nothing: pressed after a short wait. */
{
  const t = build({ answers: false });
  t.conversation();
  t.key();
  t.tick(200);
  assert.deepEqual(t.pressed, [], 'the command is given its moment first');
  t.tick(200);
  assert.deepEqual(t.pressed, [t.magnifier], 'then the magnifier is pressed');
  t.tick(100);
  assert.equal(t.focused, t.panelBox, 'and the box gets the caret');
  assert.deepEqual(t.logs, [], 'with nothing to report');
}

/* Neither ever opening it: given up on, and said so once. */
{
  const t = build({ answers: false, magnifierOpens: false });
  t.conversation();
  t.key();
  t.tick(2000);
  assert.equal(t.focused, null, 'a panel that never arrives focuses nothing');
  assert.deepEqual(t.logs, ['Ctrl+F: the message search did not open'], 'and is reported once');
}

/* Calls, Channels: the section's box, not the chat list's underneath it. */
{
  const t = build();
  t.chatList();
  t.section();
  t.key();
  assert.equal(t.focused, t.leftBox, 'the section box gets the caret');
}

/* A section with no box of its own (Communities): nothing taken, and the
   chat list's box underneath it is left alone. */
{
  const t = build();
  t.chatList();
  t.section({ withBox: false });
  const event = t.key();
  assert.equal(t.focused, null, 'nothing is focused');
  assert.ok(!event.prevented, 'and the key is left as it came');
}

/* A conversation with no magnifier (a channel): the section's box instead. */
{
  const t = build();
  t.chatList();
  t.section();
  t.conversation({ magnifier: false });
  t.key();
  assert.deepEqual(t.searched, [], 'no message search is asked for');
  assert.equal(t.focused, t.leftBox, 'and the section box gets the caret');
}

/* Something over the whole window -- a photo viewer: nothing behind it moves. */
{
  const t = build();
  t.chatList();
  t.conversation();
  const viewer = t.body.add(new Node('div'));
  t.magnifier.under = viewer;
  t.sideBox.under = viewer;
  const event = t.key();
  assert.deepEqual([t.searched, t.pressed, t.focused, event.prevented], [[], [], null, false],
                   'a covered page is left alone');
}

/* Which keys count. */
{
  const t = build();
  t.chatList();
  for (const [fields, want, what] of [
    [{ shiftKey: true }, false, 'Ctrl+Shift+F is not Ctrl+F'],
    [{ altKey: true }, false, 'nor is Ctrl+Alt+F'],
    [{ ctrlKey: false }, false, 'nor a plain F'],
    [{ repeat: true }, false, 'nor a held one repeating'],
    [{ defaultPrevented: true }, false, 'nor one the page already took'],
    [{ key: 'F' }, true, 'Ctrl+F with caps lock is'],
    [{ key: 'ب' }, true, 'the same key on an Arabic layout is'],
    [{ key: 'u' }, false, 'a Latin layout that puts another letter there is not'],
    [{ ctrlKey: false, metaKey: true }, true, 'Super+F counts as Ctrl+F does in main.js'],
  ]) {
    t.focused = null;
    assert.equal(t.key(fields).prevented, want, what);
  }
}

console.log('find checks pass');
// vim: et ts=2 sw=2 sts=2
