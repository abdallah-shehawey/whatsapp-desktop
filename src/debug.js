/*
 * A way into a live session, and unset by default -- deliberately so.
 *
 *   WHATSAPP_DEBUG_EVAL=/tmp/eval.js whatsapp-desktop
 *
 * Whatever lands in that file is evaluated in the page and the result logged.
 * Some words are commands to the app rather than to the page. "#snapshot"
 * writes a PNG of the window. "#hide", "#show", "#minimize" and "#unfocus" put
 * the window in each of the states the tray has to tell apart, and "#focus"
 * asks for it back the plain way -- between them they drive the tray without a
 * tray to click, which matters because the states differ and only one of them
 * can be reached by hiding. "#state" prints what the window believes. "#gpu"
 * prints which of Chromium's pipelines are hardware accelerated -- the answer to
 * "why does scrolling lag when the browser does not" -- and "#scroll" measures a
 * real one, sixty wheel events with the page's frame intervals sampled around
 * them. "#tone" plays the notification sound the client uses for its own
 * banners.
 *
 * Devtools are a Ctrl+Shift+I away here, which is what the GTK client could not
 * offer -- WebKitGTK's remote inspector never answered on its port. This stays
 * because the questions worth asking are about a window nobody is sitting in
 * front of, and because a GNOME Wayland session will not hand a screenshot of
 * this process to anything outside it. capturePage is inside it.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SNAPSHOT = path.join(os.tmpdir(), 'whatsapp-desktop-snapshot.png');

/* Running commentary, on only when the rig is. Window state changes are the
   thing worth narrating: they are what the tray reads, they arrive from the
   compositor rather than from this program, and on a bad day they do not
   arrive at all. */
const trace = (...args) => {
  if (!process.env.WHATSAPP_DEBUG_EVAL) return;
  /* Stamped, because the questions asked of this are about order: which of two
     things the compositor did first. */
  const [first, ...rest] = args;
  console.log('%s ' + first, new Date().toISOString().slice(11, 23), ...rest);
};

const install = (getWindow, getBanners, actions = {}) => {
  const file = process.env.WHATSAPP_DEBUG_EVAL;
  if (!file) return;

  const run = async () => {
    let source = '';
    try { source = fs.readFileSync(file, 'utf8').trim(); } catch (e) { return; }
    if (!source) return;

    const win = getWindow();
    if (!win || win.isDestroyed()) return;

    /* A real scroll, measured. Wheel events are sent as input rather than by
       setting scrollTop, because only the first goes down Chromium's compositor
       path -- the one a browser scrolls a long chat on -- and that path is the
       whole question. The page samples its own frame intervals around it. */
    if (source === '#scroll' || source.startsWith('#scroll ')) {
      /* Which scroller, named outright when it matters. The pick below is a
         heuristic over every div on the page, and a heuristic that chooses wrong
         does not fail -- it measures the element it chose while the wheel turns
         over the one under the pointer, and answers "nothing moved, no long
         tasks" for a scroll that was never sent anywhere near it. Two runs
         against the same conversation picked two different elements. */
      const wanted = source.slice('#scroll'.length).trim();
      /* Frame intervals were the obvious metric and they are the wrong one: a
         window that is not being composited runs requestAnimationFrame free of
         vsync, so "6 ms a frame" reads as excellent when it means the page was
         not on screen at all. What actually makes a scroll feel bad is the main
         thread being busy when the wheel turns, and that is measured directly --
         long tasks, and how far the conversation actually moved. */
      const SAMPLE = `(() => {
        window.__waLong = [];
        window.__waObs?.disconnect();
        window.__waObs = new PerformanceObserver(list => {
          for (const e of list.getEntries()) window.__waLong.push(Math.round(e.duration));
        });
        window.__waObs.observe({ entryTypes: ['longtask'] });
        /* The chat list's scroller is #pane-side itself, not a div inside it, so
           the root has to be in the candidate set. */
        const pick = root => [...(root ? [root, ...root.querySelectorAll('div')] : [])]
          .filter(el => el.scrollHeight > el.clientHeight + 400 && el.clientHeight > 200)
          .sort((a, b) => b.clientHeight - a.clientHeight)[0] || null;
        /* The conversation when one is open, the chat list otherwise -- both are
           long virtualised scrollers and both are what the complaint is about.
           Nothing is clicked to open a chat: that would mark it read. */
        const main = document.querySelector('#main');
        const named = ${JSON.stringify(wanted)} ? document.querySelector(${JSON.stringify(wanted)}) : null;
        window.__waScroller = named || pick(main) || pick(document.querySelector('#pane-side'));
        window.__waTarget = named ? ${JSON.stringify(wanted || '')}
          : main && window.__waScroller && main.contains(window.__waScroller)
          ? 'conversation' : 'chat list';
        window.__waFrom = window.__waScroller ? window.__waScroller.scrollTop : -1;
        /* The selector is kept, not just the node. WhatsApp re-renders the
           conversation while it is being scrolled and replaces this element, and
           a report that reads the old detached one answers "it did not move, and
           it cost nothing" for a scroll that moved seven thousand pixels. */
        window.__waSelector = ${JSON.stringify(wanted || '')};
        return window.__waScroller ? window.__waTarget : 'nothing scrollable';
      })()`;
      const REPORT = `(() => {
        window.__waObs?.disconnect();
        const long = window.__waLong || [];
        if (window.__waSelector) {
          const live = document.querySelector(window.__waSelector);
          if (live) window.__waScroller = live;
        }
        return JSON.stringify({
          longTasks: long.length,
          blockedMs: long.reduce((a, b) => a + b, 0),
          worstMs: long.length ? Math.max(...long) : 0,
          scrolled: window.__waScroller ? Math.round(window.__waFrom - window.__waScroller.scrollTop) : null,
          /* Said outright, because a scroll that did not happen used to read as a
             scroll that cost nothing. */
          moved: window.__waScroller ? window.__waFrom !== window.__waScroller.scrollTop : false,
          target: window.__waTarget,
        });
      })()`;

      try {
        /* A window that is not on screen does not paint, and a probe that
           measured that would be measuring nothing. */
        win.show();
        win.focus();
        await new Promise(resolve => setTimeout(resolve, 500));
        console.log('debug: scroll probe %s',
          await win.webContents.executeJavaScript(SAMPLE, true));

        const bounds = win.getContentBounds();
        const where = await win.webContents.executeJavaScript(
          `(() => { const r = window.__waScroller?.getBoundingClientRect();
             return r ? JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) : ''; })()`, true);
        /* getBoundingClientRect answers in the page's own CSS pixels, which the
           zoom factor scales; sendInputEvent wants window coordinates. */
        const zoom = win.webContents.getZoomFactor();
        const point = where ? JSON.parse(where) : null;
        const x = point ? Math.round(point.x * zoom) : Math.round(bounds.width * 0.65);
        const y = point ? Math.round(point.y * zoom) : Math.round(bounds.height * 0.5);
        /* In phases, the way a mouse sends them. Chromium latches a scroll to
           the element the gesture began over, and a stream of wheel events that
           never says it began is a stream it is free to route elsewhere. */
        for (let i = 0; i < 60; i++) {
          win.webContents.sendInputEvent({
            type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120, canScroll: true,
            phase: i === 0 ? 'began' : 'changed',
          });
          await new Promise(resolve => setTimeout(resolve, 16));
        }
        win.webContents.sendInputEvent({
          type: 'mouseWheel', x, y, deltaX: 0, deltaY: 0, canScroll: true, phase: 'ended',
        });
        await new Promise(resolve => setTimeout(resolve, 300));
        console.log('debug: scroll %s', await win.webContents.executeJavaScript(REPORT, true));
      } catch (e) {
        console.warn('debug: scroll probe failed: %s', e.message);
      }
      return;
    }

    /* Two knobs the scroll probe is used against: the zoom level, and the user
       stylesheet. Both are the app's own doing, and both are prime suspects for
       a frame budget that a browser on the same page does not blow. */
    if (source.startsWith('#zoom')) {
      const level = Number(source.split(/\s+/)[1]) || 1;
      win.webContents.setZoomFactor(level);
      console.log('debug: zoom %s', win.webContents.getZoomFactor());
      return;
    }
    if (source.startsWith('#css-')&& source !== '#css-off') {
      const style = require('./style.js');
      const family = require('./desktop.js').interfaceFont();
      const which = source.slice(5);
      const pieces = {
        font: `* { font-family: ${style.stack(family)} !important; }`,
        size: 'html { font-size: 16px !important; }',
        full: `* { font-family: ${style.stack(family)} !important; }\nhtml { font-size: 16px !important; }`,
        shipped: style.build({ arabicFix: false, fontSize: 16 }),
      };
      await require('./main-css.js').set(pieces[which] || '');
      console.log('debug: stylesheet -> %s', which);
      return;
    }
    if (source === '#css-off') {
      const removed = await require('./main-css.js').drop();
      console.log('debug: user stylesheet %s', removed ? 'removed' : 'was not applied');
      return;
    }

    /* A real key, sent the way the compositor would send one. The page cannot
       make one: a KeyboardEvent it constructs is untrusted, and the handlers
       this is aimed at ignore those. Escape is the one worth having here --
       whether it closes the emoji panel is a question only a trusted key can
       answer. */
    if (source === '#esc' || source.startsWith('#key ')) {
      const key = source === '#esc' ? 'Escape' : source.slice(5).trim();
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
      win.webContents.sendInputEvent({ type: 'char', keyCode: key });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
      console.log('debug: sent %s as a real key', key);
      return;
    }

    /* Text typed into whatever has the caret. The page cannot do this either:
       WhatsApp's composer is a Lexical editor, it listens for beforeinput, and
       execCommand('insertText') from an evaluated script leaves it empty --
       measured. insertText goes in through the same path a keyboard does. */
    if (source.startsWith('#type ')) {
      win.webContents.focus();
      win.webContents.insertText(source.slice(6));
      console.log('debug: typed %d character(s)', source.length - 6);
      return;
    }

    /* One banner per kind of message, raised through the very path a real one
       takes -- Banners.show, the same glyphs the page writes, the same bidi. The
       question these answer is the only one that cannot be answered from a test:
       what the glyph actually LOOKS like once fontconfig, Pango and the shell
       have each had their turn at it. */
    if (source === '#notify' || source.startsWith('#notify ')) {
      const banners = getBanners && getBanners();
      if (!banners) { console.log('debug: no banners to raise'); return; }
      const bidi = require('./bidi.js');
      const wording = require('./wording.js');
      const kinds = [
        ['\u{1F49F} Sticker', ''],
        ['\u{1F4F7} Photo', ''],
        ['\u{1F3A5} Video', ''],
        ['\u{1F3A4} Voice message (0:12)', ''],
        ['\u{1F39E}\uFE0F GIF', ''],
        ['\u{1F4C4} Document', ''],
        ['\u{1F4CD} Location', ''],
        ['\u{1F5BC}\uFE0F Album', ''],
        ['\u0631\u0633\u0627\u0644\u0629 \u0639\u0631\u0628\u064A \u0637\u0648\u064A\u0644\u0629 ' +
         '\u0639\u0634\u0627\u0646 \u0646\u0634\u0648\u0641 \u0627\u0644\u0633\u0637\u0631 ' +
         '\u0627\u0644\u062A\u0627\u0646\u064A \u0628\u064A\u0628\u062F\u0623 \u0645\u0646 ' +
         '\u0641\u064A\u0646', ''],
        ['\u062A\u0645\u0627\u0645 \u064A\u0627 \u0645\u0639\u0644\u0645', wording.REPLY_MARK + '\n'],
      ];
      let n = 0;
      for (const [message, mark] of kinds) {
        banners.show({
          identity: 'debug' + Date.now() + (n++),
          key: '__debug__',
          title: bidi.paragraph('WhatsApp \u2014 test'),
          body: mark + bidi.line('Ahmed', message),
        });
      }
      console.log('debug: raised %d banners, one per kind', n);
      return;
    }

    /* The whole of an incoming call, without one.
     *
     * The banner for a call goes up, two ordinary ones are announced while it is
     * still ringing, and then the ringing stops: the first is withdrawn and the
     * call that was missed goes up in its place. What is being checked is the
     * part no unit test can reach -- that a banner announcing something still
     * happening survives in the notification centre until it is over, that the
     * two raised during it arrive like any others, and that the withdrawal takes
     * the right one down. Each rehearsal of the real thing costs somebody a
     * telephone call, which is why this exists. */
    if (source === '#ring' || source.startsWith('#ring ')) {
      const banners = getBanners && getBanners();
      if (!banners) { console.log('debug: no banners to raise'); return; }
      const bidi = require('./bidi.js');
      const wording = require('./wording.js');
      const mark = wording.RINGING.voice;
      /* Long enough to push the banner away, walk to the notification centre and
         look for it, because that is one of the things being checked. A real
         call rings for something like forty seconds. */
      const seconds = Math.max(3, Number(source.slice(5).trim()) || 25);
      banners.show({
        identity: 'debug-ring' + Date.now(), msgId: 'debug-ring', key: '__ring__',
        ongoing: true, title: bidi.paragraph('Mega'), body: bidi.line('', mark),
      });
      console.log('debug: ringing; two messages behind it, and it stops in %ds', seconds);

      /* One from somebody else and one from the very person who is ringing. The
         second is the case worth rehearsing: a caller who writes while the
         telephone is still ringing is owed that message like anybody else, and
         the banner for their own call must not take it down with it. */
      const held = [
        { who: 'Ahmed', key: '__held__',
          said: '\u0627\u0648\u0644 \u0631\u0633\u0627\u0644\u0629 \u0648\u0642\u062A \u0627\u0644\u0631\u0646\u064A\u0646' },
        { who: 'Mega', key: '__ring__',
          said: '\u0631\u0633\u0627\u0644\u0629 \u0645\u0646 \u0627\u0644\u0644\u064A \u0628\u064A\u0631\u0646 \u0646\u0641\u0633\u0647' },
      ];
      let n = 0;
      for (const one of held) {
        const at = ++n;
        setTimeout(() => banners.show({
          identity: 'debug-held' + Date.now() + at, msgId: 'debug-held' + at,
          key: one.key, title: bidi.paragraph(one.who),
          body: bidi.line(one.who, one.said),
        }), at * 1000);
      }
      /* The ringing stopping: the banner for the call goes, wherever it had got
         to -- on the screen, or waiting in the notification centre -- and the
         call that was missed goes up in its place. The same call twice over is
         not what the centre is for. */
      setTimeout(() => {
        console.log('debug: %d ringing banner(s) taken down', banners.closeMessage('debug-ring'));
        banners.show({
          identity: 'debug-missed' + Date.now(), msgId: 'debug-missed', key: '__ring__',
          title: bidi.paragraph('Mega'), body: bidi.line('', wording.MISSED.voice),
        });
        console.log('debug: and the missed call in its place');
      }, seconds * 1000);
      return;
    }

    /* What a full collection actually reclaims, which is the only way to know
       whether asking for one is worth wiring up. HeapProfiler.collectGarbage
       goes through the devtools protocol, so it needs neither --expose-gc nor
       anything from the page. */
    if (source === '#gc') {
      const heap = () => win.webContents.executeJavaScript(
        '(performance.memory||{}).usedJSHeapSize|0', true);
      const rss = () => {
        try { return require('fs').readFileSync('/proc/self/statm', 'utf8'); } catch (e) { return ''; }
      };
      const before = await heap();
      let attached = false;
      try {
        if (!win.webContents.debugger.isAttached()) { win.webContents.debugger.attach('1.3'); attached = true; }
        await win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');
      } catch (err) {
        console.log('debug: could not collect: %s', err.message);
      } finally {
        if (attached) { try { win.webContents.debugger.detach(); } catch (e) {} }
      }
      const after = await heap();
      console.log('debug: js heap %d MB -> %d MB (browser statm %s)',
                  Math.round(before / 1048576), Math.round(after / 1048576), rss().trim());
      return;
    }

    /* Who is listening for a key, and where. It was written for the Escape that
       closes a normal chat and not a community one, and the answer came from the
       page instead -- three listeners of inject.js's own, one at each point of
       the dispatch: in a community subgroup the key arrives at window's capture
       phase with defaultPrevented already true and never reaches the bubble
       phase, so something the community view mounts eats it and closes nothing.
       This stays for the next key that behaves oddly, because guessing which
       element from the outside is how an afternoon goes. DOMDebugger
       .getEventListeners answers it directly, and it needs the devtools protocol,
       which is already attached here for #gc. */
    if (source === '#listeners' || source.startsWith('#listeners ')) {
      const what = source.length > 11 ? source.slice(11).trim() : 'window';
      let attached = false;
      try {
        if (!win.webContents.debugger.isAttached()) { win.webContents.debugger.attach('1.3'); attached = true; }
        const { result } = await win.webContents.debugger.sendCommand('Runtime.evaluate', {
          expression: what, returnByValue: false,
        });
        const { listeners } = await win.webContents.debugger.sendCommand(
          'DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 1 });
        const keys = (listeners || []).filter(l => /^key/.test(l.type));
        console.log('debug: %s has %d listener(s), %d for keys: %s', what,
                    (listeners || []).length, keys.length,
                    JSON.stringify(keys.map(l => ({ type: l.type, capture: l.useCapture,
                                                    at: l.scriptId + ':' + l.lineNumber }))));
      } catch (err) {
        console.log('debug: could not read listeners: %s', err.message);
      } finally {
        if (attached) { try { win.webContents.debugger.detach(); } catch (e) {} }
      }
      return;
    }

    /* Escape with the caret taken out of the composer first, in one go rather
       than in two evaluations a page-focus restore apart. It answered its
       question -- where the caret is makes no difference to the key a community
       subgroup swallows -- and is kept only as a probe. */
    if (source === '#esc-outside') {
      await win.webContents.executeJavaScript(
        '(() => { const b = document.querySelector(\'[contenteditable="true"]\');' +
        ' if (b) b.blur(); const p = document.querySelector("#pane-side");' +
        ' if (p) { p.setAttribute("tabindex", "-1"); p.focus(); }' +
        ' return document.activeElement && document.activeElement.id; })()', true);
      for (const type of ['keyDown', 'char', 'keyUp'])
        win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
      console.log('debug: sent Escape with the caret out of the composer');
      return;
    }

    /* Open a conversation by name, through the very path a clicked notification
       takes. Synthetic clicks from an evaluated script do not open one -- React
       ignores them -- so this is the only way to put the client into a given
       conversation from outside it. */
    if (source.startsWith('#open ')) {
      win.webContents.send('wa:open-chat-request', { name: source.slice(6).trim() });
      console.log('debug: asked the page to open a conversation');
      return;
    }

    if (source === '#tone') {
      win.webContents.send('wa:play-tone', null);
      console.log('debug: tone requested');
      return;
    }

    /* What the screen-share handler would be choosing between. On Wayland the
       compositor's own portal is what actually picks, and this is the call that
       asks it -- so an answer here means the path from getDisplayMedia to the
       compositor is whole, and a hang means the portal is waiting for the user. */
    if (source === '#screens' || source.startsWith('#screens ')) {
      const { desktopCapturer } = require('electron');
      const types = source.length > 8 ? source.slice(9).trim().split(/\s+/) : ['screen', 'window'];
      try {
        const sources = await Promise.race([
          desktopCapturer.getSources({ types, fetchWindowIcons: false }),
          new Promise(resolve => setTimeout(() => resolve('timed out after 8s'), 8000)),
        ]);
        console.log('debug: [%s] %s', types.join(','), typeof sources === 'string' ? sources :
          JSON.stringify(sources.map(s => ({ id: s.id, name: s.name }))));
      } catch (e) {
        console.warn('debug: screen sources failed: %s', e.message);
      }
      return;
    }

    if (source === '#gpu') {
      const { app } = require('electron');
      console.log('debug: %s', JSON.stringify(app.getGPUFeatureStatus()));
      return;
    }

    /* Down the app's own path rather than by signal.
       A change to the page half needs no restart at all: inject.js and what it
       requires are a preload, and a reload re-reads them from disk -- measured,
       by marking the file and reloading. A change to main.js, notify.js or the
       tray does need one, and this is that restart. It is the quit the tray menu
       and Ctrl+Q call, which lets Chromium close its storage on the way out
       rather than being cut off mid-write by a signal. */
    if (source === '#quit') {
      console.log('debug: quitting');
      const { app } = require('electron');
      app.quit();
      return;
    }

    /* Minimised to the dock: the state the tray read wrong, and the one that
       cannot be reached by hiding the window. What isMinimized() makes of it
       afterwards is the point of asking. */
    if (source === '#minimize') {
      win.minimize();
      await new Promise(resolve => setTimeout(resolve, 900));
      console.log('debug: minimized -> %s', JSON.stringify({
        visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }));
      return;
    }

    /* Asking for the focus and nothing else -- no show, no re-map. What the
       compositor is willing to do for the asking, on its own. */
    if (source === '#focus') {
      win.focus();
      await new Promise(resolve => setTimeout(resolve, 1200));
      console.log('debug: focus -> %s', JSON.stringify({
        visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }));
      return;
    }

    /* Visible, and not where the user is looking -- the state the tray's Open has
       to deal with and the one a hidden window does not reproduce. */
    if (source === '#unfocus') {
      win.show(); win.blur();
      console.log('debug: shown and blurred');
      return;
    }

    /* Any switch the settings window has, from here -- the window itself cannot
       be clicked by a rig, and half the questions worth asking about a setting
       are about what it does to a page that is already open. Goes through the
       very handler the window's own IPC call lands in.

         #set view.chat-font-size 130
         #set view.arabic-fix false
    */
    if (source.startsWith('#set ')) {
      const [key, ...rest] = source.slice(5).trim().split(/\s+/);
      const raw = rest.join(' ');
      const value = /^(true|false)$/i.test(raw) ? /^true$/i.test(raw)
        : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
      if (!actions.set) { console.log('debug: nothing here can change a setting'); return; }
      actions.set(key, value);
      console.log('debug: %s = %s (%s)', key, JSON.stringify(value), typeof value);
      return;
    }

    /* The settings window, which nothing else here can reach: it is opened by a
       keystroke with a modifier and by a tray item, and neither is available to
       a rig driving the client from outside. What is worth reading back is the
       size it actually got -- the panel is sized to its own content and clamped
       to the work area, so a short screen is meant to give a shorter window. */
    if (source === '#settings') {
      if (!actions.settings) { console.log('debug: no settings window to open'); return; }
      const panel = actions.settings();
      await new Promise(resolve => setTimeout(resolve, 600));
      console.log('debug: settings %s', panel && !panel.isDestroyed()
        ? JSON.stringify(panel.getBounds()) : 'did not open');
      return;
    }

    if (source === '#hide') { win.hide(); console.log('debug: hidden'); return; }
    /* Through the app's own path, not a copy of it: what is being checked here
       is whether that path actually brings the window to the user. */
    if (source === '#show') {
      if (actions.show) actions.show(); else { win.show(); win.focus(); }
      await new Promise(resolve => setTimeout(resolve, 900));
      console.log('debug: shown -> %s', JSON.stringify({
        visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized() }));
      return;
    }
    if (source === '#state') {
      console.log('debug: %s', JSON.stringify({
        visible: win.isVisible(), focused: win.isFocused(),
        minimized: win.isMinimized(), zoom: win.webContents.getZoomFactor(),
      }));
      return;
    }

    if (source === '#snapshot') {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(SNAPSHOT, image.toPNG());
        console.log('debug: wrote %s', SNAPSHOT);
      } catch (e) {
        console.warn('debug: could not take a snapshot: %s', e.message);
      }
      return;
    }

    try {
      const result = await win.webContents.executeJavaScript(source, true);
      console.log('debug: %s', typeof result === 'string' ? result : JSON.stringify(result));
    } catch (e) {
      console.warn('debug: %s', e.message);
    }
  };

  /* Polled rather than watched: an editor writing the file atomically replaces
     the inode, and a watch on the old one hears nothing after the first save. */
  try { fs.writeFileSync(file, fs.existsSync(file) ? fs.readFileSync(file) : ''); } catch (e) {}
  fs.watchFile(file, { interval: 300 }, (now, before) => {
    if (now.mtimeMs !== before.mtimeMs) run();
  });
  console.log('debug: watching %s', file);
};

module.exports = { install, trace, SNAPSHOT };
