/*
 * Replays the chat list past src/page/inject.js, without WhatsApp and without a
 * browser.
 *
 * Every notification bug this client has had lived in the page-side watcher, and
 * every one of them was found by hand on a live session -- which means waiting
 * for somebody to write to you, and being unable to reproduce what you just saw.
 * The watcher only ever touches the DOM through a handful of selectors, so a few
 * hundred lines of mock element are enough to drive it: build a chat list, move
 * a row the way WhatsApp moves one, and ask the page what arrived.
 *
 * Run it with `make test`. No dependencies, no browser, no account.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const SRC = process.env.WA_INJECT || path.join(__dirname, '..', 'src', 'page', 'inject.js');
const US  = String.fromCharCode(31);      // the unit separator the page answers with

/* ------------------------------------------------------------ the mock DOM */

/* Only the selector forms inject.js actually uses: a tag, an #id, [attr],
   [attr="value"], [attr^="value"], and comma-separated lists of those. */
const parseSel = sel => sel.split(',').map(part => {
  const whole = /^([a-zA-Z]*)((?:#[\w-]+|\[[^\]]+\])*)$/.exec(part.trim());
  if (!whole) throw new Error('unsupported selector: ' + part);
  const tests = [];
  if (whole[1]) tests.push(el => el.tagName.toLowerCase() === whole[1].toLowerCase());
  for (const cond of whole[2].match(/#[\w-]+|\[[^\]]+\]/g) || []) {
    if (cond[0] === '#') {
      const id = cond.slice(1);
      tests.push(el => el.attrs.id === id);
      continue;
    }
    const attr = /^\[([\w-]+)(?:(\^?=)"([^"]*)")?\]$/.exec(cond);
    if (!attr) throw new Error('unsupported condition: ' + cond);
    const [, name, op, want] = attr;
    if (!op) tests.push(el => el.attrs[name] !== undefined);
    else if (op === '=') tests.push(el => el.attrs[name] === want);
    else tests.push(el => String(el.attrs[name] || '').startsWith(want));
  }
  return el => tests.every(test => test(el));
});

class El {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.text = text;
    this.children = [];
    this.parentNode = null;
  }
  append(...kids) {
    for (const kid of kids) { kid.parentNode = this; this.children.push(kid); }
    return this;
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
  }
  /* WhatsApp recycles rows constantly and the watcher checks for it, so the
     mock has to answer honestly: connected means reachable from the root. */
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node.__root === true;
  }
  getAttribute(name) { const v = this.attrs[name]; return v === undefined ? null : v; }
  setAttribute(name, value) { this.attrs[name] = value; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  get innerText() {
    return this.attrs.__innerText !== undefined ? this.attrs.__innerText : this.textContent;
  }
  *walk() { for (const kid of this.children) { yield kid; yield* kid.walk(); } }
  querySelectorAll(sel) {
    const tests = parseSel(sel);
    return [...this.walk()].filter(el => tests.some(test => test(el)));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  /* Pressing a row aims at the middle of it, so there has to be a middle. The
     numbers do not matter to anything: nothing in the page reads them back. */
  getBoundingClientRect() { return { left: 0, top: 0, width: 320, height: 72 }; }
  dispatchEvent(event) { dispatched.push({ on: this, type: event.type }); return true; }
  closest(sel) {
    const tests = parseSel(sel);
    let node = this;
    while (node) { if (tests.some(test => test(node))) return node; node = node.parentNode; }
    return null;
  }
}

const el = (tag, attrs, text) => new El(tag, attrs, text);

/* --------------------------------------------------------- the chat list */

const root = el('div', {});
root.__root = true;
const pane = el('div', { id: 'pane-side' });
/* #main is the conversation pane, and WhatsApp renders it only while a chat is
   open -- measured on the live page by walking eight conversations open and
   shut. Closing the chat here means taking it out. */
let main = el('div', { id: 'main' });
root.append(pane, main);
const closeConversation = () => { main.remove(); };
const openConversation = () => { if (!main.isConnected) root.append(main); };

const two = n => String(n).padStart(2, '0');
/* The clock a row wears. Rows carry the time of their last message, and the
   watcher refuses to call anything older than three minutes an arrival. */
const clock = (backMinutes = 0) => {
  const d = new Date(Date.now() - backMinutes * 60000);
  return (d.getHours() % 12 || 12) + ':' + two(d.getMinutes()) +
         ' ' + (d.getHours() >= 12 ? 'PM' : 'AM');
};

/* A row as WhatsApp draws one: the chat name and the message preview in
   span[title] elements, the unread pill in an aria-label, the sender of a group
   message as its own line followed by a bare ":" line, and the delivery tick as
   an <svg> carrying a <title> -- which is where this build puts it. */
const mkRow = spec => {
  const row = el('div', { role: 'row' });
  if (spec.open) row.attrs['aria-selected'] = 'true';
  /* A group inside a community draws THREE titles: the community, the group and
     then the message. Measured on the live chat list, where every community row
     carried one more than a plain chat does. */
  if (spec.community) row.append(el('span', { title: spec.community }));
  row.append(el('span', { title: spec.name }), el('span', { title: spec.preview }));
  if (spec.badge) row.append(el('div', { 'aria-label': spec.badge + ' unread messages' }));
  if (spec.muted) row.append(el('div', { 'aria-label': 'muted' }));
  if (spec.mention) row.append(el('span', { 'data-icon': 'mention' }));
  if (spec.outgoing) {
    const svg = el('svg', {});
    svg.append(el('title', {}, 'wds-ic-read'));
    row.append(svg);
  }
  row.__spec = spec;
  row.paint = () => {
    const s = row.__spec;
    const titles = row.querySelectorAll('span[title]');
    titles[titles.length - 2].setAttribute('title', s.name);
    titles[titles.length - 1].setAttribute('title', s.preview);
    const pill = row.querySelectorAll('[aria-label]')
                    .find(e => /unread/.test(e.attrs['aria-label'] || ''));
    if (s.badge && pill) pill.setAttribute('aria-label', s.badge + ' unread messages');
    else if (s.badge) row.append(el('div', { 'aria-label': s.badge + ' unread messages' }));
    else if (pill) pill.remove();
    row.attrs.__innerText = [s.community || s.name, s.when]
        .concat(s.sender ? [s.sender, ':'] : [])
        .concat([s.preview]).join('\n');
  };
  row.paint();
  return row;
};
const update = (row, patch) => { Object.assign(row.__spec, patch); row.paint(); };

/* ------------------------------------------------------------ the sandbox */

let pings = 0;                            // arrivals the page nudged the app about
const observers = [];
const logs = [];

const document = {
  querySelector: sel => root.querySelector(sel),
  querySelectorAll: sel => root.querySelectorAll(sel),
  addEventListener() {}, dispatchEvent() {},
  styleSheets: [], body: el('body', {}), activeElement: null,
};

const handlers = new Map();                 // channel -> what the page listens with

let openReports = [];                       // what the page said was on screen
let unreadReports = [];                     // and which chats it said were unread
let countReports = [];                      // and how many messages, for the badge

/* The app side of the bridge the page is given: the nudge that something
   arrived, the log, and the two reports the app withdraws notifications on. */
const send = (channel, payload) => {
  if (channel === 'arrival') pings++;
  else if (channel === 'log') logs.push(String(payload));
  else if (channel === 'open-chat') openReports.push(payload);
  else if (channel === 'unread-chats') unreadReports.push(payload);
  else if (channel === 'unread-count') countReports.push(payload);
};
const on = (channel, fn) => handlers.set(channel, fn);
const push = (channel, payload) => {
  const fn = handlers.get(channel);
  if (fn) fn(payload);
};

/* Whatever the page listens to the window for -- the keystroke and the click
   that mean a message is going out, and the load that starts the watcher. */
const listeners = new Map();
const listen = (type, fn) => {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
};
const fire = (type, event) => { for (const fn of listeners.get(type) || []) fn(event); };

/* Just enough of the two audio interfaces for the mute to have something to
   hook. The page replaces the methods on these prototypes, so what a call proves
   is which way it went. */
let played = [];
class HTMLMediaElement {
  constructor(where) { this.where = where || ''; }
  play() { played.push('audio'); return Promise.resolve(); }
  closest(sel) { return this.where === sel ? {} : null; }
}
class AudioBufferSourceNode {
  start() { played.push('webaudio'); }
  connect() {}
}
/* Enough of WebAudio for the client's own tone to be decoded and played, which
   is what the muting of WhatsApp's arrival tone is conditional on: silencing
   theirs before ours is ready would leave the arrival with no sound at all. */
class AudioContext {
  constructor() { this.state = 'running'; this.destination = {}; }
  decodeAudioData() { return Promise.resolve({ duration: 0.4 }); }
  createBufferSource() { return new AudioBufferSourceNode(); }
  resume() { return Promise.resolve(); }
}

/* Every event the page dispatches at the chat list, in order, with the element
   it was aimed at. */
let dispatched = [];
class MockEvent {
  constructor(type) { this.type = type; }
}

const sandbox = {
  document, console,
  navigator: { userAgent: 'test' },
  location: { host: 'web.whatsapp.com' },
  setTimeout, clearTimeout, clearInterval,
  HTMLMediaElement, AudioBufferSourceNode, AudioContext,
  MouseEvent: MockEvent, PointerEvent: MockEvent,
  atob: text => Buffer.from(text, 'base64').toString('binary'),
  /* watchList is installed on an interval in the page; here it runs once and the
     observer it registers is driven by hand, one pass at a time. */
  setInterval: fn => { fn(); return 0; },
  MutationObserver: class {
    constructor(cb) { this.cb = cb; observers.push(this); }
    observe() {}
  },
  Event: class { constructor(type) { this.type = type; } },
  addEventListener: listen, dispatchEvent() {},
  module: { exports: {} },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
/* A movable Date.now, so the 2.5s the watcher waits for the list to settle does
   not have to be waited out. new Date() stays real: freshness compares a row's
   clock against the wall clock, and the rows above are stamped from it. */
vm.runInContext('var __offset = 0; const __real = Date.now; Date.now = () => __real() + __offset;',
                sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'inject.js' });
sandbox.module.exports.start({ send, on });
/* Notifications off: the shim needs a window.Notification to wrap, and nothing
   in here raises one. The watcher is what this rig drives. */
push('config', { notifications: false, muteSendTone: true });

const setFocus = state => push('focus', state);

const advance = ms => { sandbox.__offset += ms; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
/* One debounced pass of the chat-list watcher, exactly as a DOM change drives
   it: the observer fires, and the scan lands 150ms later. */
const scan = async () => { observers.forEach(o => o.cb()); await sleep(200); };
/* What the app would put on a banner, in one line. */
const describe = async () => {
  const answer = await sandbox.window.__waDescribeUnread();
  if (answer === 'open' || answer === '') return answer;
  const [chat, sender, message] = answer.split(US);
  return sender ? chat + ' | ' + sender + ': ' + message : chat + ' | ' + message;
};

/* -------------------------------------------------------------- the checks */

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

(async () => {
  console.log('driving ' + SRC + '\n');

  const mega = mkRow({ name: 'Mega', preview: 'ون', when: clock(), badge: 0, open: true });
  const pdf  = mkRow({ name: 'Pdf & Assignments', preview: 'تيست', when: clock(1),
                       badge: 1, sender: 'Mega' });
  const joo  = mkRow({ name: 'EL Joo', preview: 'انجز يلا', when: '12:28 AM', badge: 0 });
  pane.append(mega, pdf, joo);

  setFocus(true);
  await scan();                                    // the opening pass seeds the list
  check('a chat left unread from before the client started is not news',
        await describe(), '');

  advance(3000);                                   // the list has settled
  await scan();
  check('and it is still not news a moment later', await describe(), '');

  /* A message to a chat that is not on screen, and then the extra ask that used
     to announce it a second time. The app asks more often than messages land --
     the document title asks on its own count -- and every ask the queue could
     not answer fell through to the topmost unread row. */
  update(pdf, { preview: 'تمام', when: clock(), badge: 2 });
  await scan();
  check('a message to a chat that is not on screen is announced',
        await describe(), 'Pdf & Assignments | Mega: تمام');
  check('the next ask, with nothing queued, stays quiet', await describe(), '');
  await scan();
  check('and stays quiet after another pass of the watcher', await describe(), '');

  update(mega, { preview: 'ز', when: clock() });
  await scan();
  check('a message in the chat on screen is left to WhatsApp', await describe(), 'open');
  check('reading one chat does not re-announce the other', await describe(), '');

  /* Typing. A direct chat leaves "typing..." in the preview, a group leaves
     "Mega is typing..." -- and the second shape used to read as a message. */
  const before = pings;
  update(pdf, { preview: 'Mega is typing...', sender: null });
  await scan();
  check('a group typing raises no arrival at all', pings - before, 0);
  check('and nothing is described for it', await describe(), '');
  update(pdf, { preview: 'تمام', sender: 'Mega' });   // typing stops, message unchanged
  await scan();
  check('typing stopping is not an arrival either', await describe(), '');

  /* And typing that starts in the quarter second between the message landing
     and the app asking about it. */
  update(pdf, { preview: 'يلا بينا', when: clock(), badge: 3, sender: 'Mega' });
  await scan();
  update(pdf, { preview: 'Mega is typing...', sender: null });
  check('a banner carries the message and its sender, never the typing',
        await describe(), 'Pdf & Assignments | Mega: يلا بينا');

  /* The one case the guess exists for: a chat too far down the list to have
     been rendered, moved to the top by a message the watcher never saw arrive. */
  update(pdf, { preview: 'يلا بينا', sender: 'Mega' });
  await scan();
  const deep = mkRow({ name: 'Communication Engineer 4', preview: 'تم',
                       when: clock(), badge: 1, sender: '~Mo farhat' });
  pane.append(deep);
  await scan();
  check('a row that appears at the top unread is still guessed at',
        await describe(), 'Communication Engineer 4 | Mo farhat: تم');
  check('but only once', await describe(), '');

  /* A row that is still unread cannot be the conversation on screen: WhatsApp
     clears that pill the moment it draws a chat in a focused window. Ten
     messages landing in a chat sitting at ten unread were every one of them
     answered "the message is in the chat on screen". */
  update(mega, { badge: 10, preview: 'E', when: clock() });
  await scan();
  check('a chat left at ten unread is not the chat on screen',
        await describe(), 'Mega | E');

  /* And with no conversation pane at all, nothing is on screen. */
  update(mega, { badge: 0, preview: 'ok', when: clock() });
  await scan();
  await describe();
  closeConversation();
  update(mega, { preview: 'tamam', when: clock() });
  await scan();
  check('with no conversation open, nothing is the chat on screen',
        await describe(), 'Mega | tamam');
  openConversation();

  /* An arrival the app never asked about -- the nudge is dropped whenever the
     window is not active in the moment it lands -- must not be announced when
     something else asks a minute later. */
  update(joo, { preview: 'انجز يلا بقى', when: clock(), badge: 1 });
  await scan();                                    // queued, and nobody asks
  advance(20000);
  update(pdf, { preview: 'اوك', when: clock(), badge: 4, sender: 'Mega' });
  await scan();
  check('a queued arrival nobody asked about is not announced later',
        await describe(), 'Pdf & Assignments | Mega: اوك');

  /* Losing focus empties the queue outright: the page owns notifications from
     there, and it announces the same messages itself. The row is left with no
     unread pill so that only the queue can answer for it -- the guess below it
     never speaks for a chat that is caught up. */
  update(joo, { preview: 'يلا', when: clock(), badge: 0 });
  await scan();
  setFocus(false);
  setFocus(true);
  check('the queue does not survive the window going away', await describe(), '');

  /* ------------------------------------------------------- the withdrawals */

  /* What the app takes a notification down on. The unread list is an inference
     that arrives a beat late; the chat on screen is the answer, and it is the one
     that has to be right the instant a chat is opened -- opening a chat while its
     banner was still up used to leave the message in the notification centre for
     good. */
  openReports = [];
  await scan();
  check('the chat on screen is not reported again when nothing has changed',
        openReports.length, 0);

  mega.setAttribute('aria-selected', 'false');
  joo.setAttribute('aria-selected', 'true');
  await scan();
  check('opening another chat reports it', openReports.pop(), 'EL Joo');

  /* A chat that was already open when the window went away is being read the
     moment it comes back, and nothing about the chat itself changes to say so. */
  openReports = [];
  setFocus(false);
  setFocus(true);
  check('and the window coming back says it again', openReports.pop(), 'EL Joo');

  closeConversation();
  await scan();
  check('with no conversation open, nothing is on screen', openReports.pop(), '');

  /* And the slower half of it: the unread list, which is what covers a message
     read on the phone. */
  unreadReports = [];
  update(joo, { badge: 2, preview: 'خلاص؟', when: clock() });
  await scan();
  check('a chat going unread is reported', (unreadReports.pop() || []).includes('EL Joo'), true);
  update(joo, { badge: 0 });
  await scan();
  check('and reported again without it once it has been read',
        (unreadReports.pop() || []).includes('EL Joo'), false);

  /* A sticker or media arrival without a preview title is recognized and announced */
  await describe(); // drain any queued arrival from the unread test above
  update(pdf, { badge: 5, preview: '', sender: 'Mega', when: clock() });
  const stickerIcon = el('span', { 'data-icon': 'ic-sticker' });
  pdf.append(stickerIcon);
  await scan();
  check('a sticker message is announced as a sticker, glyph and all',
        await describe(), 'Pdf & Assignments | Mega: \u{1f3f7} Sticker');
  stickerIcon.remove();


  /* --------------------------------------------- what is not ours to announce */

  /* A message the user sent themselves. The delivery tick is one signal and the
     word WhatsApp writes in front of the preview is the other, and the second is
     what catches a build that has renamed the first -- which is how a banner
     reading "You: ..." ended up over a message the user had just sent. */
  await describe();
  update(pdf, { badge: 0, preview: 'تمام يا معلم', sender: 'You', when: clock() });
  await scan();
  check('a message the user sent is not announced, tick or no tick',
        await describe(), '');

  /* And the same message with somebody else's name on it is. */
  update(pdf, { badge: 1, preview: 'تمام يا معلم', sender: 'Salah', when: clock() });
  await scan();
  check('the same message from somebody else is announced',
        await describe(), 'Pdf & Assignments | Salah: تمام يا معلم');

  /* A reply inside a community thread moves the group to the top of the list
     with the PARENT message still in its preview and a fresh clock on it. Every
     test an arrival has to pass, it passes -- and the banner would name a
     message the user has already been told about. */
  update(pdf, { badge: 2, preview: 'تمام يا معلم', sender: 'Salah', when: clock() });
  await scan();
  check('a thread reply re-surfacing the same message is not announced twice',
        await describe(), '');

  /* Two minutes on, the same words are a new message and are announced again. */
  advance(3 * 60 * 1000);
  update(pdf, { badge: 3, preview: 'تمام يا معلم', sender: 'Salah', when: clock() });
  await scan();
  check('and the same words a quarter of an hour later are a message again',
        await describe(), 'Pdf & Assignments | Salah: تمام يا معلم');

  /* ------------------------------------------------------- muting and mentions */

  const club = mkRow({ name: 'Study Group', preview: 'كلام كتير', when: clock(), badge: 1,
                       sender: 'Ahmed', muted: true });
  pane.append(club);
  await scan();                                   // seen for the first time: not news
  update(club, { badge: 2, preview: 'كلام تاني', when: clock() });
  await scan();
  check('a muted group says nothing', await describe(), '');

  /* Unless the user was named in it, which is the one thing that gets through a
     muted group on the phone as well. */
  update(club, { badge: 3, preview: 'يا عبدالله شوف دا', when: clock(), mention: true });
  club.append(el('span', { 'data-icon': 'mention' }));
  await scan();
  check('a mention gets through the muting',
        await describe(), 'Study Group | Ahmed: يا عبدالله شوف دا');
  club.remove();

  /* ------------------------------------------------------------ kinds of media */

  /* WhatsApp writes "Photo" into the preview itself when it has one, and a
     banner reading Photo is indistinguishable from somebody who typed the word.
     The glyph is what tells them apart, and it is put on the label rather than
     on the message. */
  await describe();
  update(pdf, { badge: 4, preview: 'Photo', sender: 'Mega', when: clock() });
  await scan();
  check('a photo is announced as a photo, not as the word',
        await describe(), 'Pdf & Assignments | Mega: \u{1f4f7} Photo');

  update(pdf, { badge: 5, preview: 'the sticker you sent is great', sender: 'Mega',
                when: clock() });
  await scan();
  check('and a message that merely mentions one is left as it was written',
        await describe(), 'Pdf & Assignments | Mega: the sticker you sent is great');


  /* ------------------------------------------------------ communities */

  /* A group inside a community carries the community's name in front of its own,
     so the message is the LAST title on the row and not the second. Reading the
     second announced the name of the chat as though it were the message. */
  await describe();
  const community = mkRow({ community: 'Graduation Project', name: 'Graduation project',
                            preview: 'اول رساله', when: clock(), badge: 1, sender: 'Salah' });
  pane.append(community);
  await scan();                                    // first sight: not news
  update(community, { badge: 2, preview: 'رايح امتى نروح سوا؟', when: clock() });
  await scan();
  check('a community message is announced with the message, not the group name',
        await describe(), 'Graduation Project | Salah: رايح امتى نروح سوا؟');
  community.remove();

  /* ------------------------------------------------------- voice notes */

  /* A voice note has no words, so WhatsApp puts its LENGTH in the preview: the
     row reads "0:41". A banner saying 0:41 says nothing. */
  await describe();
  update(pdf, { badge: 6, preview: '0:41', sender: 'Mega', when: clock() });
  const voiceIcon = el('span', { 'data-icon': 'ic-keyboard-voice-filled' });
  pdf.append(voiceIcon);
  await scan();
  check('a voice note is announced as one, with its length kept',
        await describe(), 'Pdf & Assignments | Mega: \u{1f3a4} Voice message (0:41)');
  voiceIcon.remove();


  /* ------------------------------------------------------------- the badge */

  /* The number the launcher draws. The document title cannot supply it: it counts
     unread CHATS and leaves muted ones out of even that. Measured on the live
     account, the title read "(3)" while six chats were unread holding eleven
     messages between them. */
  await describe();
  /* The rows the earlier checks left unread would be counted too, and this is a
     check about arithmetic rather than about them. The watcher also remembers a
     chat that has stopped being rendered for a minute, so the clock is moved past
     that before the count is read. */
  for (const row of pane.children) if (row.__spec) update(row, { badge: 0 });
  advance(120000);
  await scan();
  await scan();
  await describe();
  countReports = [];
  const loud  = mkRow({ name: 'Loud Group', preview: 'واحد', when: clock(), badge: 3,
                        sender: 'Ali' });
  const quiet = mkRow({ name: 'Quiet Group', preview: 'اتنين', when: clock(), badge: 7,
                        sender: 'Sara', muted: true });
  pane.append(loud, quiet);
  await scan();
  const counted = countReports.pop();
  check('the badge counts messages, not chats', counted && counted.messages, 3);
  check('and leaves a muted chat out of it', counted && counted.chats, 1);

  /* A mention in a muted group is not muted, and does count. */
  update(quiet, { badge: 8, preview: 'يا عبدالله', when: clock(), mention: true });
  quiet.append(el('span', { 'data-icon': 'mention' }));
  await scan();
  const withMention = countReports.pop();
  check('a mention inside a muted group counts again',
        withMention && withMention.messages, 11);
  loud.remove(); quiet.remove();
  await describe();

  /* ----------------------------------------------- the tone of a message out */

  /* Muted by the moment rather than by name: WhatsApp serves its sounds from
     hashed filenames that change with the build, so the moment is all there is to
     match on. */
  const SEND_TONE_GAP = 2000;        // longer than the beat a send is muted for
  const composer = el('div', { contenteditable: 'true' });
  const sendButton = el('span', { 'data-icon': 'wds-ic-send-filled' });

  played = [];
  new sandbox.HTMLMediaElement('').play();
  check('a sound with no message going out is left alone', played.join(), 'audio');

  played = [];
  fire('keydown', { key: 'Enter', target: composer });
  new sandbox.HTMLMediaElement('').play();
  new sandbox.AudioBufferSourceNode().start();
  check('the tone for a message going out is muted, either way a page plays one',
        played.join(), '');

  advance(SEND_TONE_GAP);            // out of the window the last Enter opened
  played = [];
  fire('pointerdown', { target: sendButton });
  new sandbox.HTMLMediaElement('').play();
  check('and muted for a click on send, which is how a picture goes', played.join(), '');

  played = [];
  fire('keydown', { key: 'Enter', target: composer });
  new sandbox.HTMLMediaElement('#main').play();
  check('a voice note in the conversation still plays', played.join(), 'audio');

  advance(SEND_TONE_GAP);
  played = [];
  fire('keydown', { key: 'Enter', shiftKey: true, target: composer });
  new sandbox.HTMLMediaElement('').play();
  check('Shift+Enter is a newline, not a message going out', played.join(), 'audio');

  played = [];
  fire('keydown', { key: 'Enter', target: composer });
  advance(SEND_TONE_GAP);
  new sandbox.HTMLMediaElement('').play();
  check('and somebody else writing two seconds later still rings', played.join(), 'audio');

  /* ---------------------------------------------- the tone of a message in */

  /* The other half of the same idea. WhatsApp announces an arrival itself only
     while the window is away, and it does it with a tone of its own -- so the
     same message sounded one way in front of the user and another behind them.
     The client plays the desktop's tone for both now, which means this one has
     to go. */
  push('config', { notifications: false, muteSendTone: true, mutePageTone: true });
  advance(SEND_TONE_GAP);

  played = [];
  new sandbox.HTMLMediaElement('').play();
  check('with no tone of its own yet, the client leaves WhatsApp to announce it',
        played.join(), 'audio');

  push('tone', { data: Buffer.from('a tone').toString('base64'), mime: 'audio/ogg' });
  await sleep(0);                                  // decoded on a microtask

  played = [];
  new sandbox.HTMLMediaElement('').play();
  new sandbox.AudioBufferSourceNode().start();
  check('the tone for a message arriving is muted once the client has one',
        played.join(), '');

  played = [];
  push('play-tone', null);
  await sleep(0);
  check("and the client's own tone plays straight through the muting",
        played.join(), 'webaudio');

  played = [];
  const ringing = new sandbox.HTMLMediaElement('');
  ringing.loop = true;
  ringing.play();
  check('a call ringing is never muted, whatever else is', played.join(), 'audio');

  /* ------------------------------------------ opening a chat from a banner */

  /* A banner is a message, and clicking one is asking to read it. The page is
     given the chat by name and presses the row, because that is the only way in
     to a conversation from out here. */
  dispatched = [];
  push('open-chat-request', 'EL Joo');
  check('clicking a banner presses the row for its chat',
        dispatched.map(d => d.type).join(','),
        'pointerdown,mousedown,pointerup,mouseup,click');
  /* Aimed at the name and not at the row: the handler that opens a conversation
     is inside the row, and an event that starts at the row travels away from it.
     That was measured on the live page, and it is the whole reason this presses
     what it presses. */
  check('and it is aimed inside that row and not at the row itself',
        dispatched.length ? dispatched[0].on.getAttribute('title') : '',
        'EL Joo');

  dispatched = [];
  push('open-chat-request', 'Somebody Not In The List');
  check('a chat the list is not showing is left alone rather than guessed at',
        dispatched.length, 0);

  console.log(failures ? '\n' + failures + ' failed' : '\nall checks pass');
  process.exit(failures ? 1 : 0);
})();
