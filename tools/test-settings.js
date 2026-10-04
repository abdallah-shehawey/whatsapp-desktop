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
  chatCards: false,
  /* The client sends the palettes themselves so the window can draw each swatch
     in the colours it would apply. dark and light are deliberately NOT among
     them -- they are two of the three modes above the row. */
  palettes: {
    oled: { name: 'OLED Black', bg: '#000000', text: '#f5f5f5', accent: '#00a884' },
    nord: { name: 'Nord', bg: '#2e3440', text: '#eceff4', accent: '#88c0d0' },
  },
  spellcheck: true,
  spellcheckLanguages: 'en-US',
  /* What Chromium answers with on the machine this is read from -- three of
     its own, and deliberately no ar: it ships no Arabic dictionary, and the
     window has to say so rather than offer one. */
  spellcheckAvailable: ['en-US', 'en-GB', 'fr'],
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
  selected: false,
  /* A <select multiple> answers with the options that are picked, and the
     spelling list reads exactly that -- so the stub has to have it, or a
     control that is wired to nothing would still pass. */
  get selectedOptions() { return this.options.filter(option => option.selected); },
  /* Assigning className is how a built element gets its classes, and the row
     below reads them back. */
  set className(value) { this.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
  get className() { return [...this.classes].join(' '); },
  classList: {
    toggle(name, on) { on ? this.owner.classes.add(name) : this.owner.classes.delete(name); },
    add(name) { this.owner.classes.add(name); },
    remove(name) { this.owner.classes.delete(name); },
    contains(name) { return this.owner.classes.has(name); },
  },
  listeners: {},
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
  appendChild(child) { this.options.push(child); },
  /* The palette row builds its swatches and then asks for them back to mark
     the chosen one, so the children that were appended are what this answers
     with -- a stub that always returned nothing would let a selector that
     matches none of them pass. */
  querySelectorAll(selector) {
    const wanted = selector.replace(/^\./, '');
    return this.options.filter(child => child.classes && child.classes.has(wanted));
  },
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
    /* Built elements get their classList wired up like the ones above, because
       the palette row builds its swatches and then has them marked active --
       a stub that left `owner` off would throw the moment a theme was picked. */
    createElement: () => {
      const el = node('created');
      el.classList.owner = el;
      return el;
    },
    /* The swatches carry their name as a text node. Nothing reads it back, but
       a document without this throws inside drawPalettes, and that throw is
       swallowed by the window's own try/catch -- so the symptom is every
       control BELOW the palettes silently never being set up. */
    createTextNode: text => ({ text }),
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

    /*
     * The way back from a palette.
     *
     * Choosing a palette leaves all three buttons above unlit -- correctly,
     * none of them is in force -- and that reads as "nothing is selected"
     * rather than "a palette has taken over", so there was no visible way back
     * to WhatsApp's own colours at all. The first swatch in the row is it.
     */
    const swatches = () => w.el('paletteRow').options;
    const swatch = key => swatches().find(b => b.dataset.theme === key);
    const lit = () => swatches().filter(b => b.classes.has('active')).map(b => b.dataset.theme);

    assert.deepStrictEqual(swatches().map(b => b.dataset.theme), ['default', 'oled', 'nord'],
                           'Default leads the row, then the palettes the client sent');
    /* The window opened on `dark`, which is a mode and not a palette. */
    assert.deepStrictEqual(lit(), ['default'], 'with no palette on, Default is what is lit');

    await swatch('oled').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['theme', 'oled']);
    assert.deepStrictEqual(lit(), ['oled'], 'and Default goes out when a palette comes on');
    for (const id of ['themeSystem', 'themeDark', 'themeLight']) {
      assert.ok(!w.el(id).classList.contains('active'),
                id + ' is not in force while a palette is -- which is what Default is for');
    }

    await swatch('default').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['theme', 'system'], 'Default takes the palette off');
    assert.deepStrictEqual(lit(), ['default']);
    assert.ok(w.el('themeSystem').classList.contains('active'), 'and the modes are back in force');

    /* Pressing it again does nothing. It is a way BACK and not a fourth mode:
       an owner sitting on Dark who presses it should not be moved to System. */
    await w.el('themeDark').fire('click');
    assert.deepStrictEqual(w.called.pop(), ['theme', 'dark']);
    const quiet = w.called.length;
    await swatch('default').fire('click');
    assert.strictEqual(w.called.length, quiet, 'already default: nothing was asked of the client');
    assert.ok(w.el('themeDark').classList.contains('active'), 'and Dark is left exactly as it was');

    /* The chat list as cards. The rule is only in the sheet while this is on --
       see CHAT_CARDS in src/style.js -- so the switch has to reach the client
       rather than toggle a class in the page. */
    w.el('chatCardsToggle').checked = true;
    await w.el('chatCardsToggle').fire('change');
    assert.strictEqual(w.last('view.chat-cards'), true);

    /* The spell checker, which had a config key from 1.7.0 and no control at
       all until now -- the only way to turn it off was to edit the file. */
    w.el('spellcheckToggle').checked = false;
    await w.el('spellcheckToggle').fire('change');
    assert.strictEqual(w.last('behaviour.spellcheck'), false);

    /* The list is Chromium's, not one written into the window: three offered,
       the one in the config picked. */
    const offered = w.el('spellLangs').options;
    assert.deepStrictEqual(offered.map(o => o.value), ['en-US', 'en-GB', 'fr'],
                           'every dictionary the client was told about, and no others');
    assert.deepStrictEqual(offered.filter(o => o.selected).map(o => o.value), ['en-US'],
                           'and the one being checked in is the one that is picked');
    assert.match(offered[0].textContent, /en-US/, 'named by its code');
    assert.match(offered[0].textContent, /English/, 'and in words, because a code is not a language');

    offered.find(o => o.value === 'fr').selected = true;
    await w.el('spellLangs').fire('change');
    assert.strictEqual(w.last('behaviour.spellcheck-languages'), 'en-US,fr');

    /* Unpicking the last one is refused rather than saved: an empty list turns
       the checker off entirely, which is what the switch above is for, and
       would leave this control looking as though it had broken. */
    const before = w.saved.length;
    offered.forEach(o => { o.selected = false; });
    await w.el('spellLangs').fire('change');
    assert.strictEqual(w.saved.length, before, 'nothing was saved');
    assert.deepStrictEqual(w.el('spellLangs').options.filter(o => o.selected).map(o => o.value),
                           ['en-US', 'fr'], 'and the languages are put back');
  }

  /* A machine with no dictionaries at all: the list is not drawn, rather than
     drawn empty beside a description of how to use it. */
  {
    const w = await open('settings.html', { ...settings(), spellcheckAvailable: [] });
    assert.strictEqual(w.el('spellLangs').options.length, 0);
    assert.strictEqual(w.el('spellLangRow').style.display, 'none');
  }

  /* And a language in the config that this machine has no dictionary for is
     said here, in the window, rather than only in a log nobody reads --
     setSpellCheckerLanguages drops the whole list over one name it does not
     know, so "ar" silently means nothing is checked at all. */
  {
    const w = await open('settings.html', { ...settings(), spellcheckLanguages: 'en-US,ar' });
    assert.match(w.el('spellLangDesc').textContent, /No dictionary here for ar/);
    assert.deepStrictEqual(w.el('spellLangs').options.filter(o => o.selected).map(o => o.value),
                           ['en-US'], 'and what it can check in is still picked');
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
