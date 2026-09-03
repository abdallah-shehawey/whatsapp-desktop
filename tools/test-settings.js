'use strict';

/*
 * The client's own windows, pressed without a screen.
 *
 * Every other test here drives a module. These two drive the PAGE -- the script
 * inside src/settings.html and the one inside src/fonts.html -- because each of
 * them is one long top-level block, and a block like that has a failure mode
 * nothing else in this repo has: an edit in the middle of it can carry away a
 * declaration that something further down still reads, and nothing says so. The
 * script still parses, the window still opens, every control still draws, and
 * one of them is dead. That is exactly what shipped once: a rewrite of the font
 * section took two constants with it, so pressing + on a stepper threw
 * ReferenceError into a console nobody was reading and the size never moved.
 *
 * So: a DOM stub with just enough in it to run a script and press things, and
 * an assertion per control that the press reaches `setSetting` with the key the
 * client expects. It is not a rendering test and does not pretend to be -- what
 * it covers is that every control in those windows is still wired to something.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');

/* What the client answers `settings:get` with. One answer for both windows,
   because there is one handler behind them. */
const settings = () => ({
  theme: 'dark', autostart: true, closeToTray: true, minimizeToTray: false,
  notifyEnabled: true, notifySound: true, outgoingSound: false,
  zoom: 1.0, fontSize: 16, font: 'PoetsenOne',
  fonts: {
    desktop: 'PoetsenOne',
    systemArabic: 'Noto Naskh Arabic',
    latin: { inherit: true, family: '', size: 100, bold: false, italic: false },
    arabic: { inherit: true, family: '', size: 100, bold: false, italic: false },
    available: {
      latin: [{ name: 'PoetsenOne', bold: false, italic: false },
              { name: 'DejaVu Sans', bold: true, italic: true }],
      arabic: [{ name: 'Noto Naskh Arabic', bold: true, italic: false },
               { name: 'Vazirmatn', bold: true, italic: false }],
    },
  },
});

/* ------------------------------------------------------------- the stub */

const node = id => ({
  id,
  checked: false, disabled: false, value: '', textContent: '', hidden: false,
  style: {}, dataset: {}, options: [],
  classes: new Set(),
  classList: {
    toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); },
    add(name) { this.owner.classes.add(name); },
    remove(name) { this.owner.classes.delete(name); },
    contains(name) { return this.owner.classes.has(name); },
  },
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  appendChild(child) { this.options.push(child); },
  setAttribute() {}, removeAttribute() {},
  scrollIntoView() { this.scrolled = true; },
  /* Awaited, because every handler in these windows saves over IPC. */
  fire(type) { return Promise.all((this.listeners[type] || []).map(fn => fn())); },
});

/* One window, opened: its markup checked for controls that lead nowhere, its
   script run against the stub, and the presses it took written down. */
const open = async (file, answer) => {
  const html = read(file);

  /* Nothing may be looked up that the markup does not carry, and nothing may be
     carried that nothing looks up -- the second half catches a control that was
     drawn and then never wired at all. */
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...html.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  assert.deepStrictEqual([...used].filter(id => !ids.has(id)), [],
                         file + ': looked up but not in the markup');
  assert.deepStrictEqual([...ids].filter(id => !used.has(id)), [],
                         file + ': in the markup but never wired');

  const nodes = new Map([...ids].map(id => {
    const el = node(id);
    el.classList.owner = el;
    return [id, el];
  }));

  const saved = [];
  const called = [];

  global.document = {
    getElementById: id => nodes.get(id) || null,
    createElement: () => node('created'),
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
  };
  global.window = {
    api: {
      getSettings: async () => answer,
      setSetting: async (key, value) => { saved.push([key, value]); return { ok: true, restart: false }; },
      setTheme: async theme => { called.push(['theme', theme]); return true; },
      setAutostart: async on => { called.push(['autostart', on]); return true; },
      close() { called.push(['close']); },
      restart() { called.push(['restart']); },
      onSettingsChanged() {},
    },
  };

  new Function(html.match(/<script>([\s\S]*?)<\/script>/)[1])();
  /* The window's own load is async and nothing here can await it: one turn of
     the loop is what it gets before a hand reaches a control. */
  await new Promise(resolve => setTimeout(resolve, 20));

  return {
    el: id => nodes.get(id),
    saved, called,
    last: key => {
      const hit = [...saved].reverse().find(([k]) => k === key);
      return hit ? hit[1] : undefined;
    },
  };
};

(async () => {

  /* ----------------------------------------------------------- settings */

  {
    const w = await open('settings.html', settings());

    assert.strictEqual(w.el('zoomVal').textContent, '100%');
    await w.el('zoomIn').fire('click');
    assert.strictEqual(w.last('view.zoom'), 1.1);
    assert.strictEqual(w.el('zoomVal').textContent, '110%', 'and the window says so');
    await w.el('zoomOut').fire('click');
    assert.strictEqual(w.last('view.zoom'), 1);

    /* The switches, each with the key the client reads it back from. */
    const switches = [
      ['closeToTrayToggle', 'behaviour.close-to-tray'],
      ['minimizeToTrayToggle', 'behaviour.minimize-to-tray'],
      ['notifyToggle', 'notifications.enabled'],
      ['notifySoundToggle', 'notifications.sound'],
      ['outgoingSoundToggle', 'notifications.outgoing-sound'],
    ];
    for (const [id, key] of switches) {
      w.el(id).checked = false;
      await w.el(id).fire('change');
      assert.strictEqual(w.last(key), false, id + ' saves ' + key);
    }

    /* The theme lives here and only here: it came out of the tray menu, so this
       is the one way to it and it had better work. */
    await w.el('themeLight').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['theme', 'light']);
    assert.ok(w.el('themeLight').classList.contains('active'), 'and the button says so');
    assert.ok(!w.el('themeDark').classList.contains('active'), 'one at a time');

    w.el('autostartToggle').checked = false;
    await w.el('autostartToggle').fire('change');
    assert.deepStrictEqual(w.called.pop(), ['autostart', false]);
  }

  /* Nothing in this window sizes a conversation any more. `view.chat-font-size`
     was a percentage that belonged to neither script, sitting under the zoom
     where the two per-script sizes in the Fonts window could not be compared
     with it, and it came out on 2026-09-03. */
  {
    const html = read('settings.html');
    assert.doesNotMatch(html, /chat-font-size|chatFont/, 'no key and no control for it');
    assert.doesNotMatch(read('fonts.html'), /chat-font-size|chatFont/,
                        'and it did not follow the fonts into their window');
  }

  /* -------------------------------------------------------------- fonts */

  {
    const w = await open('fonts.html', settings());

    /* Locked until the switch says otherwise -- and the lock is on the group,
       not on the window: turning Arabic loose must leave Latin exactly as it
       was. That is the whole point of there being two of them. */
    assert.ok(w.el('latinControls').classList.contains('locked'), 'Latin starts locked');
    assert.ok(w.el('arabicControls').classList.contains('locked'), 'Arabic starts locked');
    assert.strictEqual(w.el('arabicFamily').disabled, true);

    w.el('arabicInherit').checked = false;
    await w.el('arabicInherit').fire('change');
    assert.strictEqual(w.last('fonts.arabic-inherit'), false);
    assert.ok(!w.el('arabicControls').classList.contains('locked'), 'Arabic is loose now');
    assert.ok(w.el('latinControls').classList.contains('locked'), 'and Latin is untouched');
    assert.strictEqual(w.el('latinFamily').disabled, true);

    w.el('arabicFamily').value = 'Vazirmatn';
    await w.el('arabicFamily').fire('change');
    assert.strictEqual(w.last('fonts.arabic-family'), 'Vazirmatn');

    await w.el('arabicSizeIn').fire('click');
    assert.strictEqual(w.last('fonts.arabic-size'), 105);
    assert.strictEqual(w.el('arabicSizeVal').textContent, '105%');

    /* Vazirmatn has a bold face in the catalogue above and no italic one. The
       bold button saves; the italic button is disabled and must save nothing --
       a face a font has not got cannot be turned on. */
    await w.el('arabicBold').fire('click');
    assert.strictEqual(w.last('fonts.arabic-bold'), true);
    const before = w.saved.length;
    await w.el('arabicItalic').fire('click');
    assert.strictEqual(w.saved.length, before, 'a disabled face button saves nothing');
    assert.strictEqual(w.el('arabicItalic').disabled, true);

    /* Latin is the same window in the other script, and it saves its own keys. */
    w.el('latinInherit').checked = false;
    await w.el('latinInherit').fire('change');
    await w.el('latinSizeOut').fire('click');
    assert.strictEqual(w.last('fonts.latin-size'), 95);

    /* And the pickers were filled from what the client said is installed: the
       two families, plus the entry that hands the script back to the system. */
    assert.strictEqual(w.el('arabicFamily').options.length, 3);
    assert.strictEqual(w.el('latinFamily').options.length, 3);

    /* The two ways out of this window. */
    w.el('restartBtn').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['restart']);
    w.el('closeBtn').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['close']);
  }

  /* A client too old to know about any of this -- which is what a reloaded
     window in a client that has not been restarted is talking to. The controls
     go away and the window says why, rather than standing there saving
     nowhere. */
  {
    const answer = settings();
    delete answer.fonts;
    const w = await open('fonts.html', answer);
    assert.strictEqual(w.el('fontsSection').hidden, true, 'no catalogue, no controls');
    assert.strictEqual(w.el('noCatalogue').hidden, false, 'and it says so');
  }

  console.log('settings and fonts window checks pass');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
