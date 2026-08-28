/*
 * The tray icon.
 *
 * Electron talks StatusNotifierItem over DBus here, which on GNOME needs the
 * AppIndicator extension (appindicatorsupport@rgcjonas.gmail.com) to have a
 * host listening. The GTK client had to speak that protocol by hand over GDBus
 * -- GTK4 has no tray at all and libayatana-appindicator is packaged for
 * GTK2/GTK3 only -- and this is the one part of it Electron simply provides.
 *
 * What Electron does not provide is waiting for that host. It asks once, when
 * the Tray is constructed, and if org.kde.StatusNotifierWatcher has no owner at
 * that instant there is no icon, no error, and no second attempt. That is
 * exactly what a login looks like: /etc/xdg/autostart started this client two
 * seconds after gnome-shell, the extension had not claimed the name yet, and
 * the client owned no StatusNotifierItem for the rest of the session -- checked
 * on the bus, where the watcher listed Telegram, which retries, and nobody
 * else. So the name is watched here, the icon is built when a host is there,
 * and it is built again if the host restarts: an extension toggled off and on,
 * or a shell replaced, takes every registration with it.
 *
 * Click is not delivered on Linux: SNI hosts open the menu instead. So every
 * action lives in the menu, including the one that shows the window.
 */
'use strict';

const { Tray, Menu, nativeImage } = require('electron');
const { execFile, spawn } = require('child_process');

const WATCHER = 'org.kde.StatusNotifierWatcher';
const DBUS = ['--session', '--dest', 'org.freedesktop.DBus',
              '--object-path', '/org/freedesktop/DBus'];

/* Half a second of margin between the name appearing and the icon registering
   into it. Nothing measured says a host answers late, but a registration lost
   in that gap would be silent and would last the whole session, and at login
   nobody sees the delay. */
const SETTLE_MS = 500;

const OWNER_CHANGED =
  new RegExp(`NameOwnerChanged \\('${WATCHER.replace(/\./g, '\\.')}', '[^']*', '([^']*)'\\)`);

/* Is a host listening right now? null means the question could not be asked --
   no gdbus on the system -- and the caller should go ahead and try anyway. */
const hostPresent = cb => {
  execFile('gdbus', ['call', ...DBUS, '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER],
    (err, stdout) => cb(err ? null : String(stdout).includes('true')));
};

/* gdbus ships with glib, which Electron already links, so this needs nothing
   installed. `monitor` prints one line per signal; the bus driver's
   NameOwnerChanged carries (name, old owner, new owner), and an empty new owner
   is the host going away. */
const watchHost = onChange => {
  let seen = false;
  let monitor = null;

  hostPresent(present => {
    /* The monitor can report an arrival before this answer comes back, and the
       answer is older than the report. */
    if (seen) return;
    seen = true;
    onChange(present === null ? true : present);
  });

  try {
    monitor = spawn('gdbus', ['monitor', ...DBUS], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return () => {};
  }
  monitor.on('error', () => {});        // no gdbus: the check above already said "try anyway"

  let rest = '';
  monitor.stdout.setEncoding('utf8');
  monitor.stdout.on('data', chunk => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    for (const line of lines) {
      const owner = OWNER_CHANGED.exec(line);
      if (!owner) continue;
      seen = true;
      onChange(owner[1] !== '');
    }
  });

  /* Left running, this outlives the client the way the leaked network service
     processes did, so quitting kills it. */
  return () => { try { monitor.kill(); } catch (e) {} };
};

class TrayIcon {
  constructor({ normal, attention, onShow, onHide, onQuit, title = 'WhatsApp' }) {
    this.icons = {
      normal: nativeImage.createFromPath(normal),
      attention: nativeImage.createFromPath(attention || normal),
    };
    this.handlers = { onShow, onHide, onQuit };
    this.title = title;
    this.unread = false;
    this.windowVisible = false;

    this.tray = null;
    this.pending = null;
    this.hosted = null;
    this.stopWatching = watchHost(hosted => {
      if (hosted === this.hosted) return;
      this.hosted = hosted;
      console.log(hosted
        ? 'tray: a status icon host is listening'
        : 'tray: no status icon host yet; the icon appears when one arrives');
      if (hosted) this.attach(); else this.detach();
    });
  }

  attach() {
    if (this.tray || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      try {
        this.tray = new Tray(this.icons.normal);
        this.tray.on('click', () => this.handlers.onShow && this.handlers.onShow());
      } catch (e) {
        console.log(`tray: could not be created (${e.message})`);
        this.tray = null;
        return;
      }
      this.render();
    }, SETTLE_MS);
  }

  detach() {
    if (this.pending) { clearTimeout(this.pending); this.pending = null; }
    if (!this.tray) return;
    try { this.tray.destroy(); } catch (e) {}
    this.tray = null;
  }

  render() {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: this.windowVisible ? 'Hide WhatsApp' : 'Open WhatsApp',
        click: () => (this.windowVisible ? this.handlers.onHide : this.handlers.onShow)(),
      },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => this.handlers.onQuit && this.handlers.onQuit() },
    ]));
    this.tray.setToolTip(this.unread ? `${this.title} — unread messages` : this.title);
    this.tray.setImage(this.unread ? this.icons.attention : this.icons.normal);
  }

  /* Marked, never counted: WhatsApp's own title counts unread CHATS, not
     messages, so a number drawn from it would be wrong for exactly the case a
     number is wanted. The state is kept whether or not there is an icon to draw
     it on, because a host arriving later renders from it. */
  setAttention(unread) {
    if (unread === this.unread) return;
    this.unread = unread;
    this.render();
  }

  setWindowVisible(visible) {
    if (visible === this.windowVisible) return;
    this.windowVisible = visible;
    this.render();
  }

  destroy() {
    if (this.stopWatching) this.stopWatching();
    this.detach();
  }
}

module.exports = { TrayIcon };
