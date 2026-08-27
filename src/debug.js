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

const install = getWindow => {
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
    if (source === '#scroll') {
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
        window.__waScroller = pick(main) || pick(document.querySelector('#pane-side'));
        window.__waTarget = main && window.__waScroller && main.contains(window.__waScroller)
          ? 'conversation' : 'chat list';
        window.__waFrom = window.__waScroller ? window.__waScroller.scrollTop : -1;
        return window.__waScroller ? window.__waTarget : 'nothing scrollable';
      })()`;
      const REPORT = `(() => {
        window.__waObs?.disconnect();
        const long = window.__waLong || [];
        return JSON.stringify({
          longTasks: long.length,
          blockedMs: long.reduce((a, b) => a + b, 0),
          worstMs: long.length ? Math.max(...long) : 0,
          scrolled: window.__waScroller ? Math.round(window.__waFrom - window.__waScroller.scrollTop) : null,
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
        for (let i = 0; i < 60; i++) {
          win.webContents.sendInputEvent({
            type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120, canScroll: true,
          });
          await new Promise(resolve => setTimeout(resolve, 16));
        }
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

    if (source === '#tone') {
      win.webContents.send('wa:play-tone', null);
      console.log('debug: tone requested');
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
