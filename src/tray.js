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
 * that instant there is no icon, no error and no second attempt. That is what a
 * login looks like: /etc/xdg/autostart started this client two seconds after
 * gnome-shell, before the extension had claimed the name, and the client owned
 * no StatusNotifierItem for the rest of the session -- checked on the bus, where
 * the watcher listed Telegram, which retries, and nobody else. So the name is
 * waited for here, and the icon is built once a host is listening.
 *
 * Only the first host is waited for. An icon that already exists survives the
 * host restarting: measured by toggling the extension off and on under a plain
 * Electron tray, which was still registered afterwards. Destroying the icon and
 * building a new one is what does not survive -- the fresh registration went out
 * on a connection that was gone by the time gnome-shell asked about it ("The
 * name is not activatable" in its log) and the icon never came back. So this
 * builds once and then leaves the tray alone.
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

/* Half a second between the name appearing and the icon registering into it.
   Nothing measured says a host answers late, but a registration lost in that gap
   would be silent and would last the whole session, and at login nobody sees the
   delay. */
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
   installed. `monitor` prints one line per signal, and the bus driver's
   NameOwnerChanged carries (name, old owner, new owner). Calls back once, and
   stops watching. */
const waitForHost = onHost => {
  let done = false;
  let monitor = null;

  const stop = () => {
    if (!monitor) return;
    try { monitor.kill(); } catch (e) {}
    monitor = null;
  };

  const arrived = delay => {
    if (done) return;
    done = true;
    stop();
    console.log('tray: a status icon host is listening');
    setTimeout(onHost, delay);
  };

  try {
    monitor = spawn('gdbus', ['monitor', ...DBUS], { stdio: ['ignore', 'pipe', 'ignore'] });
    monitor.on('error', () => {});     // no gdbus: the check below says "try anyway"
    let rest = '';
    monitor.stdout.setEncoding('utf8');
    monitor.stdout.on('data', chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const owner = OWNER_CHANGED.exec(line);
        if (owner && owner[1] !== '') arrived(SETTLE_MS);
      }
    });
  } catch (e) {
    monitor = null;
  }

  hostPresent(present => {
    /* The monitor can report a host arriving before this answer comes back, and
       the answer is the older of the two. */
    if (done) return;
    if (present === null || present) arrived(0);
    else console.log('tray: no status icon host yet; the icon appears when one arrives');
  });

  /* Nothing else would take the monitor down, and a leaked child outlives the
     client. */
  return stop;
};

class TrayIcon {
  constructor({ normal, attention, onShow, onHide, onQuit, onSettings, onSetTheme, getTheme, onToggleAutostart, getAutostart, title = 'WhatsApp' }) {
    this.icons = {
      normal: nativeImage.createFromPath(normal),
      attention: nativeImage.createFromPath(attention || normal),
    };
    this.handlers = { onShow, onHide, onQuit, onSettings, onSetTheme, getTheme, onToggleAutostart, getAutostart };
    this.title = title;
    this.unread = false;
    this.windowVisible = false;

    this.tray = null;
    this.stopWaiting = waitForHost(() => this.build());
  }

  build() {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.icons.normal);
      this.tray.on('click', () => this.handlers.onShow && this.handlers.onShow());
    } catch (e) {
      console.log(`tray: could not be created (${e.message})`);
      this.tray = null;
      return;
    }
    this.render();
  }

  render() {
    if (!this.tray) return;
    const currentTheme = this.handlers.getTheme ? this.handlers.getTheme() : 'system';
    const autostart = this.handlers.getAutostart ? this.handlers.getAutostart() : false;

    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: this.windowVisible ? 'Hide WhatsApp' : 'Open WhatsApp',
        click: () => (this.windowVisible ? this.handlers.onHide : this.handlers.onShow)(),
      },
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => this.handlers.onSettings && this.handlers.onSettings(),
      },
      {
        label: 'Theme',
        submenu: [
          {
            label: 'System Default',
            type: 'radio',
            checked: currentTheme === 'system',
            click: () => this.handlers.onSetTheme && this.handlers.onSetTheme('system'),
          },
          {
            label: 'Dark Mode',
            type: 'radio',
            checked: currentTheme === 'dark',
            click: () => this.handlers.onSetTheme && this.handlers.onSetTheme('dark'),
          },
          {
            label: 'Light Mode',
            type: 'radio',
            checked: currentTheme === 'light',
            click: () => this.handlers.onSetTheme && this.handlers.onSetTheme('light'),
          },
        ],
      },
      {
        label: 'Start at Login',
        type: 'checkbox',
        checked: autostart,
        click: item => this.handlers.onToggleAutostart && this.handlers.onToggleAutostart(item.checked),
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
     it on yet, because a host arriving later renders from it. */
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
    if (this.stopWaiting) this.stopWaiting();
    if (!this.tray) return;
    try { this.tray.destroy(); } catch (e) {}
    this.tray = null;
  }
}

module.exports = { TrayIcon };
