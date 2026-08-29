/*
 * A way into a live session, and unset by default -- deliberately so.
 *
 *   WHATSAPP_DEBUG_EVAL=/tmp/eval.js whatsapp-desktop
 *
 * Whatever lands in that file is evaluated in the page and the result logged.
 * Four words are commands to the app rather than to the page: "#snapshot"
 * writes a PNG of the window, "#hide" and "#show" drive the tray behaviour
 * without a tray to click, "#state" prints what the window believes, and "#gpu"
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

const install = (getWindow, getBanners) => {
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
        ['\u062A\u0645\u0627\u0645 \u064A\u0627 \u0645\u0639\u0644\u0645', '\u21A9\uFE0F '],
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

    if (source === '#hide') { win.hide(); console.log('debug: hidden'); return; }
    if (source === '#show') { win.show(); win.focus(); console.log('debug: shown'); return; }
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

module.exports = { install, SNAPSHOT };
