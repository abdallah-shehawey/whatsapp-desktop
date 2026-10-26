/*
 * A notification click must bring the window back, without taking an already
 * arriving window down again. Replay the real controller from main.js against
 * window events and a virtual clock: no Electron process, account or desktop.
 * The compositor can refuse focus requests here, which is the case a test
 * window that always focuses itself would never exercise.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const start = main.indexOf('const clampToScreen =');
const end = main.indexOf('const toggleWindow =', start);
if (start < 0 || end < 0) throw new Error('Could not find the window controller in main.js');
const controller = main.slice(start, end);

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

const build = ({ wayland = true, strategy = 'auto', values = {} } = {}) => {
  let now = 10000;
  let saves = 0;
  let nextTimer = 0;
  const timers = new Map();
  const calls = [];
  const state = { visible: false, minimized: false, focused: false, destroyed: false, maximized: false };
  const win = new EventEmitter();
  Object.assign(win, {
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    isFocused: () => state.focused,
    isDestroyed: () => state.destroyed,
    isMaximized: () => state.maximized,
    isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 958, height: 1047 }),
    hide() {
      calls.push('hide');
      state.visible = false;
      state.focused = false;
      win.emit('hide');
    },
    show() {
      calls.push('show');
      state.visible = true;
      win.emit('show');
    },
    maximize() {
      calls.push('maximize');
      state.visible = true;
      win.emit('show');
    },
    setSize(width, height) { calls.push(`setSize ${width}x${height}`); },
    getNativeWindowHandle: () => { const handle = Buffer.alloc(8); handle.writeUInt32LE(0x400004, 0); return handle; },
    restore() {
      calls.push('restore');
      state.minimized = false;
      win.emit('restore');
    },
    /* A request is not a grant. Only the test's focus event grants it. */
    focus() { calls.push('focus'); },
    /* Throttled, as on the connection page: the window goes up at once. The
       draw before going up, with throttling off, waits on a real page. */
    webContents: { send() {}, getZoomFactor: () => 1, getBackgroundThrottling: () => true,
                   capturePage: () => new Promise(() => {}) },
  });
  const context = vm.createContext({
    win,
    onWayland: wayland,
    config: {
      get: key => key === 'behaviour.raise' ? strategy : values[key],
      set: (key, value) => { values[key] = value; },
      save: () => saves++,
    },
    tray: null,
    lock: { recordActivity() {} },
    shield: { setWindowFocus() {} },
    applyShield() {},
    withdrawOpen() {},
    withdrawRinging() {},
    debug: { trace() {} },
    console: { log() {} },
    electronScreen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
                      getDisplayMatching: () => ({ scaleFactor: 1 }) },
    /* The size told to mutter from a connection of its own, which the window
       itself never hears about. */
    x11: { sizeToUnmaximiseTo(xid, width, height) {
      calls.push(`x11 ${xid.toString(16)} ${width}x${height}`);
      return Promise.resolve('sent');
    } },
    Date: { now: () => now },
    setTimeout(fn, delay) {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(controller + '\ntraceWindowState();\n' +
    'globalThis.controls = { show: showWindow, click: showWindowForClick, hide: hideWindow,\n' +
    '  leftMaximized: () => { openMaximized = true; }, keepSoon, note: noteNormalSize };',
  context, { filename: 'main.js (window controller)' });

  const tick = duration => {
    const until = now + duration;
    let turns = 0;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      if (++turns > 10000) throw new Error('Window controller kept scheduling immediate work');
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = until;
  };
  const show = () => { state.visible = true; win.emit('show'); };
  const focus = () => { state.focused = true; win.emit('focus'); };
  const blur = () => { state.focused = false; win.emit('blur'); };
  const minimize = () => { state.minimized = true; state.focused = false; win.emit('minimize'); };
  return { ...context.controls, state, calls, tick, showEvent: show, focus, blur, minimize,
           values, saves: () => saves };
};

{
  const t = build();
  t.showEvent();
  t.focus();
  t.click('notification while reading');
  t.tick(5000);
  check('a notification in the focused window never remaps it',
        t.calls.filter(call => call === 'hide' || call === 'show'), []);
}

{
  const t = build();
  t.showEvent();
  t.focus();
  t.blur();
  t.tick(50);
  t.click('notification just after shell took focus');
  check('the tray blur grace does not trigger a native focus request', t.calls, []);
  t.tick(2200);
  check('recently blurred does not count as a successful notification activation',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.showEvent();
  t.click('notification while the shell is handing over');
  t.tick(1200);
  t.focus();
  t.tick(4000);
  check('a delayed shell activation keeps the existing window mapped', t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification followed by a quick switch to another application');
  t.tick(1250);
  t.focus();
  t.tick(10);
  t.blur();
  t.tick(5000);
  check('a real focus event completes the click even if the user immediately leaves',
        t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(1500);
  t.click('the page asked for the focus');
  t.tick(700);
  check('the page focus request cannot restart the notification fallback deadline',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.click('notification while hidden and shell still owns the keyboard');
  check('a hidden Wayland window is mapped immediately',
        t.calls.slice(0, 2), ['hide', 'show']);
  t.tick(500);
  check('the shell grab does not trigger a second raise after 250ms',
        t.calls.filter(call => call === 'show').length, 1);
  t.focus();
  t.tick(2500);
  check('focus arriving after the grab does not cause another remap',
        t.calls.filter(call => call === 'hide').length, 1);
}

{
  const t = build();
  t.showEvent();
  t.minimize();
  t.click('notification while minimized');
  check('a minimized Wayland window is restored while hidden before it is shown',
        t.calls.slice(0, 3), ['hide', 'restore', 'show']);
}

{
  const t = build();
  /* A non-notification raise can learn activate while a menu holds the focus.
     That observation must not strand the next notification on Wayland. */
  t.show('an earlier tray click');
  t.tick(1000);
  t.calls.length = 0;
  t.click('a later notification while behind another window');
  t.tick(5000);
  check('a failed learned activation does not leave a notification without a remap',
        t.calls.includes('hide'), true);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(500);
  t.hide();
  /* A later show need not mean the user wants focus: the pending notification
     must have been cancelled, not merely waiting to see a visible window. */
  t.showEvent();
  t.calls.length = 0;
  t.tick(5000);
  check('an explicit hide cancels a notification even if the window is shown later',
        t.calls, []);
}

{
  const t = build();
  t.showEvent();
  t.click('notification');
  t.tick(500);
  t.minimize();
  t.showEvent();
  t.state.minimized = false;
  t.calls.length = 0;
  t.tick(5000);
  check('a user minimize cancels the pending notification activation', t.calls, []);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification under X11');
  check('X11 requests focus immediately on a notification click',
        t.calls.slice(0, 2), ['show', 'focus']);
  t.tick(900);
  check('X11 first asks for activation without hiding the window',
        t.calls.includes('hide'), false);
  t.focus();
  t.tick(4000);
  check('a granted X11 activation needs no remap', t.calls.includes('hide'), false);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification whose ordinary activation is refused');
  t.tick(7000);
  /* Every 500ms over the primary and recovery windows: 0, 0.5 ... 3.5s. */
  check('a refused X11 activation is asked for again until the click runs out',
        t.calls.filter(call => call === 'focus').length, 8);
  /* The window the shell is still holding the keyboard from is on the screen
     already: taking it down and putting it back up is the window closing and
     reopening itself, and it cannot take the focus through the grab either. */
  check('a refused X11 activation never takes the window down',
        t.calls.includes('hide'), false);
  const finished = t.calls.slice();
  t.tick(20000);
  check('rejected activation attempts stop instead of asking forever', t.calls, finished);
}

{
  const t = build({ wayland: false });
  t.click('notification centre click while the client is in the tray');
  t.tick(2500);
  /* show() on a window already up is part of an ask and maps nothing; only a
     hide would take it down. */
  check('a window mapped behind a shell grab stays up on X11', t.state.visible, true);
  check('and is never taken down while it waits', t.calls.includes('hide'), false);
  const asked = t.calls.filter(call => call === 'focus').length;
  t.focus();
  t.tick(5000);
  check('focus arriving when the grab is released finishes the click',
        t.calls.filter(call => call === 'focus').length, asked);
}

{
  const t = build({ wayland: false });
  t.showEvent();
  t.click('notification centre click, window behind another app, menu held open');
  t.tick(3100);
  /* The menu closes and the focus goes back where it was: the next ask is the
     one that is granted. */
  const before = t.calls.filter(call => call === 'focus').length;
  t.tick(500);
  check('an X11 window left unfocused after the grab is asked again within 500ms',
        t.calls.filter(call => call === 'focus').length, before + 1);
  t.focus();
  t.tick(5000);
  check('and is left alone once it has the focus',
        t.calls.filter(call => call === 'focus').length, before + 1);
  check('and was never taken down', t.calls.includes('hide'), false);
}

{
  const t = build();
  t.click('notification on Wayland while hidden, refused throughout');
  t.tick(10000);
  /* A refused ask on Wayland is "WhatsApp is ready" in the shell; asking on a
     timer would post it again and again. One re-map, one ask, done. */
  check('Wayland never repeats an unanswered ask',
        t.calls.filter(call => call === 'focus').length, 2);
}

{
  const t = build();
  t.showEvent();
  t.click('notification on Wayland, shell never activates');
  t.tick(2100);
  check('Wayland still re-maps a window the shell left behind',
        t.calls.filter(call => call === 'hide').length, 1);
  t.tick(5000);
  check('and recovers from a failed re-map by asking, once',
        t.calls.filter(call => call === 'hide').length, 1);
}

{
  const t = build({ strategy: 'activate' });
  t.showEvent();
  t.click('notification with an explicit activation strategy');
  t.tick(10000);
  check('an explicit activate preference is not overridden with a remap',
        t.calls.includes('hide'), false);
}

{
  const calls = [];
  const window = { focus: () => calls.push('native-focus') };
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  vm.runInNewContext(preload, {
    window,
    location: { href: 'https://web.whatsapp.com/' },
    __dirname: path.join(__dirname, '../src'),
    process: { argv: [] },
    require(name) {
      if (name === 'url' || name === 'path') return require(name);
      if (name === 'electron') return {
        ipcRenderer: { send: channel => calls.push(channel), sendSync: () => null, on() {} },
      };
      if (name === './page/inject.js') return { start() {} };
      if (name === './page/font-faces.js') return require('../src/page/font-faces.js');
      throw new Error('Unexpected preload dependency: ' + name);
    },
  }, { filename: 'preload.js' });
  window.focus();
  check('page focus goes through the activation controller exactly once',
        calls, ['wa:focus-request']);
}

/* What a close writes back. A tiling window manager picks the size, and a
   config kept in git sees that write as a change on every close -- so with
   remember-size off the size must not be touched, and the zoom still must.
   And only a change is written: the window's state is kept as it changes now,
   so most of these calls find the file already right. The zoom is the one the
   keys chose, never the page's: a page not yet given its zoom answers 1. */
{
  const close = ({ remember = true, maximized = false, noted = true, visible = true,
                   was = {}, chosen = null, page = 1 } = {}) => {
    const values = Object.assign({ 'window.remember-size': remember, 'window.maximized': false,
                                   'window.width': 1200, 'window.height': 800, 'view.zoom': 1 }, was);
    let saves = 0;
    const context = vm.createContext({
      config: { get: key => values[key], set: (key, value) => { values[key] = value; }, save: () => saves++ },
      debug: { trace() {} },
      win: {
        isDestroyed: () => false,
        isVisible: () => visible,
        isMaximized: () => maximized,
        isMinimized: () => false,
        isFullScreen: () => false,
        getBounds: () => maximized ? { x: 0, y: 0, width: 2560, height: 1373 }
                                   : { x: 0, y: 0, width: 958, height: 1047 },
        /* What X11 answers: the maximised size, not the one it goes back to. */
        getNormalBounds: () => ({ x: 0, y: 0, width: 2560, height: 1373 }),
        webContents: { getZoomFactor: () => page },
      },
      electronScreen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }),
                      getDisplayMatching: () => ({ scaleFactor: 1 }) },
    /* The size told to mutter from a connection of its own, which the window
       itself never hears about. */
    x11: { sizeToUnmaximiseTo(xid, width, height) {
      calls.push(`x11 ${xid.toString(16)} ${width}x${height}`);
      return Promise.resolve('sent');
    } },
    });
    vm.runInContext(controller + '\nglobalThis.keep = keepWindowState;' +
                    '\nglobalThis.note = noteNormalSize;' +
                    '\nglobalThis.choose = zoom => { zoomChosen = zoom; };', context,
                    { filename: 'main.js (window controller)' });
    if (chosen !== null) context.choose(chosen);
    /* The window at its own size, then maximised by the window manager: the
       resize that maximises it is not noted. */
    if (noted) {
      const was = maximized;
      maximized = false; context.note();
      maximized = was; context.note();
    }
    context.keep();
    return { size: [values['window.width'], values['window.height']],
             maximized: values['window.maximized'], zoom: values['view.zoom'], saves };
  };
  check('a close writes the size the window manager gave it, by default',
        close({ chosen: 1.1 }), { size: [958, 1047], maximized: false, zoom: 1.1, saves: 1 });
  check('a maximised window is written down as maximised, with the size it un-maximises to',
        close({ maximized: true, chosen: 1.1 }), { size: [958, 1047], maximized: true, zoom: 1.1, saves: 1 });
  check('with remember-size off, the size in the file is left as it was',
        close({ remember: false, chosen: 1.1 }), { size: [1200, 800], maximized: false, zoom: 1.1, saves: 1 });
  check('and so is whether it was maximised',
        close({ remember: false, maximized: true, chosen: 1.1 }),
        { size: [1200, 800], maximized: false, zoom: 1.1, saves: 1 });
  /* A client the session started into the tray was never shown, so it is not
     maximised -- and that is not the window as it was left. */
  check('a window in the tray keeps the state it had when it was last up',
        close({ visible: false, chosen: 1.1,
                was: { 'window.maximized': true, 'window.width': 958, 'window.height': 1047 } }),
        { size: [958, 1047], maximized: true, zoom: 1.1, saves: 1 });
  check('a window already written down as it is writes nothing',
        close({ maximized: true, chosen: 1.1, was: { 'window.maximized': true, 'window.width': 958,
                                                     'window.height': 1047, 'view.zoom': 1.1 } }),
        { size: [958, 1047], maximized: true, zoom: 1.1, saves: 0 });
  /* The launch: the window settles and is written down before WhatsApp's page
     has been given the configured zoom, and the page answers 1 meanwhile. */
  check('a zoom the keys have not chosen is left as the file has it',
        close({ page: 1, was: { 'view.zoom': 1.4 } }),
        { size: [958, 1047], maximized: false, zoom: 1.4, saves: 1 });
  check('and a window with nothing else to write writes nothing for it',
        close({ page: 1, was: { 'view.zoom': 1.4, 'window.width': 958, 'window.height': 1047 } }),
        { size: [958, 1047], maximized: false, zoom: 1.4, saves: 0 });
}

/* Kept as it changes, not only on close: the session going down stops the
   client with a SIGTERM, and `close` never runs. A drag is a stream of
   resizes, and the state is written once, after it settles. */
{
  const t = build({ values: { 'window.width': 1200, 'window.height': 800, 'view.zoom': 1 } });
  t.showEvent();
  for (let i = 0; i < 20; i++) { t.keepSoon(); t.tick(20); }
  check('a stream of changes is not written while it is still coming',
        t.saves(), 0);
  t.tick(600);
  check('and is written once it has settled', [t.saves(), t.values['window.width']], [1, 958]);
}

/* Put away, a window keeps its size -- maximised or not, X11 or Wayland: a
   window resized while it is down comes back drawn at that size inside a
   window mutter has maximised, which is the small page in the corner. */
for (const [wayland, maximized] of [[false, true], [true, true], [false, false]]) {
  const t = build({ wayland });
  t.showEvent();
  t.note();
  t.state.maximized = maximized;
  t.calls.length = 0;
  t.hide();
  const name = `${wayland ? 'Wayland' : 'X11'}: a ${maximized ? 'maximised' : 'plain'} window`;
  check(`${name} put away is left at its size`, t.calls, ['hide']);
  t.show('the tray was asked for it');
  t.focus();
  t.tick(1000);
  /* And mutter, which maps it as a window it has never met, is told what size
     it un-maximises to once it is up -- on X11, and only for one that went
     away maximised. */
  check(`${name} back from the tray ` +
        (!wayland && maximized ? 'tells mutter its own size' : 'tells mutter nothing'),
        t.calls.filter(call => call.startsWith('x11')),
        !wayland && maximized ? ['x11 400004 958x1047'] : []);
}

/* The same on the way back from a re-map, which takes the window down too. */
{
  const t = build({ wayland: false, strategy: 'remap' });
  t.showEvent();
  t.note();
  t.state.maximized = true;
  t.calls.length = 0;
  t.show('a second copy was started');
  check('X11: a maximised window re-mapped is told its own size once it is up',
        t.calls, ['hide', 'show', 'x11 400004 958x1047', 'focus']);
}

/* A window in the tray is mapped by either way up, so a raise of one is not
   the measurement of which way works: the first open after a --hidden start
   waits on the page, and taking that wait for a refusal took the window down
   and put it up again in front of the owner. */
for (const wayland of [false, true]) {
  const t = build({ wayland });
  t.show('the tray was asked for it');
  t.tick(1500);
  t.focus();
  t.tick(1000);
  check(`${wayland ? 'Wayland' : 'X11'}: a window opened from the tray is not taken down when the focus is slow`,
        t.calls.filter(call => call === 'hide' || call === 'show'), wayland ? ['hide', 'show'] : ['show']);
}

/* Opened the way it was left: the first show of a window left maximised is a
   maximize(), which maps it maximised in one go, and only the first -- a window
   the owner has since un-maximised is shown as it is. */
for (const wayland of [false, true]) {
  const t = build({ wayland });
  /* The size it was made with, from the config. */
  t.note();
  t.leftMaximized();
  t.show('the client started');
  t.focus();
  t.tick(1000);
  check(`${wayland ? 'Wayland' : 'X11'}: the first show of a window left maximised maximises it`,
        t.calls.filter(call => call === 'maximize' || call === 'show'), ['maximize']);
  check(`${wayland ? 'Wayland' : 'X11'}: and ` +
        (wayland ? 'mutter is told nothing' : 'mutter is told its own size once it is up'),
        t.calls.filter(call => call.startsWith('x11')), wayland ? [] : ['x11 400004 958x1047']);
  t.hide();
  t.calls.length = 0;
  t.show('the tray was asked for it');
  t.focus();
  t.tick(1000);
  check(`${wayland ? 'Wayland' : 'X11'}: and a later show is a plain show`,
        t.calls.filter(call => call === 'maximize' || call === 'show'), ['show']);
}

console.log(failures ? `\n${failures} window check(s) failed` : '\nwindow checks pass');
process.exitCode = failures ? 1 : 0;
