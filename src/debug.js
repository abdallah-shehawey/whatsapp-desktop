/*
 * A way into a live session, and unset by default -- deliberately so.
 *
 *   WHATSAPP_DEBUG_EVAL=/tmp/eval.js whatsapp-desktop
 *
 * Whatever lands in that file is evaluated in the page and the result logged.
 * Four words are commands to the app rather than to the page: "#snapshot"
 * writes a PNG of the window, "#hide" and "#show" drive the tray behaviour
 * without a tray to click, and "#state" prints what the window believes.
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
