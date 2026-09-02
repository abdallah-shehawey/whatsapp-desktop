/*
 * What the tray's one item says, and what it does when it is clicked.
 *
 * Every check here is a way the item has been wrong on somebody's screen. The
 * icon itself cannot be tested -- it needs a session bus, a status icon host and
 * a hand to click it -- but the decision behind it is ordinary code and this is
 * all of it: which word the item wears, which of show and hide a click runs, and
 * what happens to both while the desktop is drawing the menu.
 *
 * The item is driven here the way a host drives it: `opened`, then the question
 * the popup asks (AboutToShow, which is refreshToggle), then `clicked`, then
 * `closed`.
 */
'use strict';

/* The class asks Electron for an icon in its constructor and nothing else, so a
   stub with a size and no pixels is the whole of what it needs. */
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true, children: [], paths: [],
  exports: {
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        toBitmap: () => Buffer.alloc(0),
      }),
    },
  },
};

const { SniTray, ID } = require('../src/tray-sni.js');

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* A tray with a window behind it that this test moves about, and handlers that
   only write down that they ran. */
const build = () => {
  const window = { inFront: false };
  const ran = [];
  const tray = new SniTray({
    normal: '/nonexistent.png',
    onShow: () => ran.push('show'),
    onHide: () => ran.push('hide'),
    onToggle: () => ran.push('toggle'),
    onQuit: () => ran.push('quit'),
    onSettings: () => ran.push('settings'),
    getTheme: () => 'system',
    getInFront: () => window.inFront,
  });
  /* The item is told where the window is as the window moves, exactly as
     main.js tells it. */
  window.moveTo = where => { window.inFront = where; tray.setInFront(where); };
  /* One open of the menu, and what the item said while it was open. */
  const openMenu = () => { tray.handle(ID.ROOT, 'opened'); tray.refreshToggle(); return label(); };
  const closeMenu = () => tray.handle(ID.ROOT, 'closed');
  const click = () => tray.handle(ID.TOGGLE, 'clicked');
  const label = () => tray.itemProps(ID.TOGGLE, ['label'])[0][1][1];
  return { window, ran, tray, openMenu, closeMenu, click, label };
};

/* --------------------------------------------------------- the two states */

{
  const t = build();
  t.window.moveTo(true);
  check('a window the owner is looking at is offered to the tray',
        t.openMenu(), 'Minimize to Tray');
  t.click();
  check('and clicking that puts it there', t.ran.join(), 'hide');
}

{
  const t = build();
  t.window.moveTo(false);
  check('a window that is away is offered back',
        t.openMenu(), 'Open WhatsApp');
  t.click();
  check('and clicking that fetches it', t.ran.join(), 'show');
}

/* ------------------------------------------------- up, but behind something */

/* The report this last round answers: the window was on screen the whole time,
   which is why the item used to offer to hide it -- but it was behind the
   editor, and what the owner wanted was to be shown it. */
{
  const t = build();
  t.window.moveTo(false);          // on screen, not in front: main.js's answer
  check('a window standing behind another one is fetched, not put away',
        t.openMenu(), 'Open WhatsApp');
  t.click();
  check('and its click opens rather than hides', t.ran.join(), 'show');
}

/* ------------------------------------------- while the desktop is drawing it */

/*
 * Opening a status icon menu on GNOME takes the keyboard off the window, so the
 * window blurs a moment after the popup appears. main.js holds that back for a
 * grace, and when the grace runs out it says so -- which lands while the owner
 * is still reading the menu. The word must not move under their hand, and the
 * click that follows must do what the word said.
 */
{
  const t = build();
  t.window.moveTo(true);
  const drawn = t.openMenu();
  t.window.moveTo(false);          // the grace running out, mid-popup
  check('the word does not change under an open menu', t.label(), drawn);
  t.click();
  check('and the click does what the word said', t.ran.join(), 'hide');
}

/* And once the popup is gone the item catches up with the window, so that the
   next popup is drawn from a cache that is right. */
{
  const t = build();
  t.window.moveTo(true);
  t.openMenu();
  t.window.moveTo(false);
  t.closeMenu();
  check('a closed menu reads the window again', t.label(), 'Open WhatsApp');
}

/* ------------------------------------------------------ the reported bug */

/*
 * Hide from the tray, open the tray again: the item used to still say "Minimize
 * to Tray", and clicking it did nothing at all -- it hid a window that was
 * already hidden. The second open said "Open WhatsApp", one open too late.
 */
{
  const t = build();
  t.window.moveTo(true);
  t.openMenu();
  t.click();                        // hide, as the word said
  t.window.moveTo(false);           // the window goes, and says so
  t.closeMenu();
  check('after hiding from the tray the item offers the window back',
        t.openMenu(), 'Open WhatsApp');
  t.ran.length = 0;
  t.click();
  check('and that click opens it rather than hiding it again', t.ran.join(), 'show');
}

/* ------------------------------------------------------------ the numbers */

/*
 * The ids are the reason this file exists at all: Electron's tray renumbered
 * every item whenever the menu changed, gnome-shell went on drawing the popup it
 * had cached, and the click carried an id nobody answered to. Nothing about a
 * word changing may move a number.
 */
{
  const t = build();
  const ids = () => {
    const walk = ([id, , children]) => [id, ...children.flatMap(c => walk(c[1]))];
    return walk(t.tray.layout(ID.ROOT, -1, [])).join();
  };
  t.window.moveTo(true);
  const before = ids();
  t.window.moveTo(false);
  check('the menu keeps its numbers when its word changes', ids(), before);
  check('and the item a host clicks is the one that was drawn', before.split(',')[1], '1');
}

console.log(failures ? `\n${failures} failed` : '\ntray checks pass');
process.exit(failures ? 1 : 0);
