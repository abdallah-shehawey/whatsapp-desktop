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
const { SniTray } = require('./tray-sni');
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

class ElectronTray {
  constructor({ normal, attention, onToggle, onShow, onHide, onQuit, onSettings,
                onSetTheme, getTheme, title = 'WhatsApp' }) {
    this.icons = {
      normal: nativeImage.createFromPath(normal),
      attention: nativeImage.createFromPath(attention || normal),
    };
    this.handlers = { onToggle, onShow, onHide, onQuit, onSettings, onSetTheme, getTheme };
    this.title = title;
    this.unread = false;
    /* Where the window was when this was last told. The word above it cannot
       move -- see renderMenu -- but what the click does still should, and the
       last thing an event said is a better answer than asking a window the
       desktop has been holding the keyboard away from. */
    this.inFront = null;

    this.tray = null;
    this.stopWaiting = waitForHost(() => this.build());
  }

  build() {
    if (this.tray) return;
    try {
      this.tray = new Tray(this.icons.normal);
      /* A click on the icon, where one is delivered at all: no menu was drawn,
         so nothing was promised and the app may decide for itself. */
      this.tray.on('click', () => this.handlers.onToggle && this.handlers.onToggle());
    } catch (e) {
      console.log(`tray: could not be created (${e.message})`);
      this.tray = null;
      return;
    }
    this.render();
  }

  render() {
    this.renderMenu();
    this.renderIcon();
  }

  /*
   * One item, one word, and the word never changes -- because changing it is
   * what breaks the button.
   *
   * The wording ought to follow the window, the way Telegram's does, and it was
   * built that way and measured. What came back settles it. Electron offers one
   * lever, setContextMenu, and pulling it renumbers the whole menu: read off the
   * session bus, the item was id 19 before a hide and id 28 after, every other
   * id moved with it, and the layout revision went 2 -> 3.
   *
   * gnome-shell draws its popup from the layout it cached, and that cache holds
   * the old ids as surely as it holds the old word. So the click lands on an id
   * that no longer exists: `Event(19, 'clicked')` against this client answers
   * "error occurred in Event" and the window does not move. That is the whole of
   * the bug that has been chased through three designs -- not a stale word, a
   * dead click. Open the tray, click, nothing; open it again and it works,
   * because by then the shell has re-read the layout.
   *
   * Both of Electron's other openings are shut. `menuItem.label` and
   * `menuItem.visible` are plain JS properties: measured against Electron 40,
   * assigning to either sends no signal, changes no layout and moves no
   * revision. A property update -- `ItemsPropertiesUpdated`, which the shell
   * applies to an open popup, and which is how Telegram keeps its own wording
   * right -- cannot be sent from here at all. Telegram is Qt, owns its dbusmenu,
   * keeps its ids for the life of the process and rewrites the label when the
   * shell asks with `AboutToShow`. Reaching that from here means writing the
   * StatusNotifierItem and its menu by hand over DBus, the way the GTK client
   * did, rather than using Electron's Tray.
   *
   * So: never rebuilt, therefore never renumbered, therefore the first click
   * always works. The word says both things it does, and which one happens is
   * decided from where the window last reported itself -- see act(). Left click
   * on the icon asks the app instead, where a host delivers one at all; GNOME's
   * opens the menu instead.
   */
  renderMenu() {
    if (!this.tray) return;
    const currentTheme = this.handlers.getTheme ? this.handlers.getTheme() : 'system';

    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        /* Telegram's words for the half that needed better ones: the window is
           not being closed, it is going where this icon is. */
        label: 'Open / Minimize to Tray',
        click: () => this.act(),
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
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => this.handlers.onQuit && this.handlers.onQuit() },
    ]));
  }

  /* The icon and its tooltip, which are not the menu -- and are kept apart from
     it because a message arriving would otherwise throw the whole menu away and
     build another, for a change that never touched a single item of it. */
  renderIcon() {
    if (!this.tray) return;
    this.tray.setToolTip(this.unread ? `${this.title} — unread messages` : this.title);
    this.tray.setImage(this.unread ? this.icons.attention : this.icons.normal);
  }

  /* Whichever half of the word applies. Read from what the window last said
     rather than asked now, because the menu that was clicked has had the
     keyboard for as long as it was open. */
  act() {
    const h = this.handlers;
    if (this.inFront && h.onHide) h.onHide();
    else if (!this.inFront && h.onShow) h.onShow();
    else if (h.onToggle) h.onToggle();
  }

  /* The Electron tray's word never moves, for the reason written over
     renderMenu, so this only remembers, and nothing is redrawn. */
  setInFront(inFront) { this.inFront = inFront; }

  /* Marked, never counted: WhatsApp's own title counts unread CHATS, not
     messages, so a number drawn from it would be wrong for exactly the case a
     number is wanted. The state is kept whether or not there is an icon to draw
     it on yet, because a host arriving later renders from it. */
  setAttention(unread) {
    if (unread === this.unread) return;
    this.unread = unread;
    this.renderIcon();
  }

  destroy() {
    if (this.stopWaiting) this.stopWaiting();
    if (!this.tray) return;
    try { this.tray.destroy(); } catch (e) {}
    this.tray = null;
  }
}

/*
 * Which of the two to use, decided at runtime rather than in the build.
 *
 * The one above is Electron's and is honest about what it cannot do. The one in
 * tray-sni.js speaks StatusNotifierItem itself, keeps its ids, and can therefore
 * let the item say where the window is. That is the whole reason it was written
 * -- but it needs a session bus, and a machine without one still has to get a
 * tray icon rather than an error. So it is tried, and if the bus is not there or
 * will not have us, Electron's takes over.
 *
 * Everything before the answer arrives is remembered and replayed into whichever
 * one wins, because the window is up and reporting itself long before a bus
 * handshake comes back.
 */
class TrayIcon {
  constructor(options) {
    this.impl = null;
    this.queued = { unread: false, inFront: null };

    const sni = new SniTray(options);
    sni.start(err => {
      if (err) {
        console.log(`tray: this desktop would not be spoken to directly (${err.message}); using Electron's tray`);
        this.adopt(new ElectronTray(options));
        return;
      }
      console.log('tray: one item, and its wording follows the window');
      this.adopt(sni);
    });
  }

  adopt(impl) {
    this.impl = impl;
    impl.setAttention(this.queued.unread);
    if (this.queued.inFront !== null) impl.setInFront(this.queued.inFront);
  }

  setInFront(inFront) {
    this.queued.inFront = inFront;
    if (this.impl) this.impl.setInFront(inFront);
  }

  setAttention(unread) {
    this.queued.unread = unread;
    if (this.impl) this.impl.setAttention(unread);
  }

  /* A setting changed under the menu -- the theme radio, which both of them draw
     from the same getter. */
  render() {
    if (!this.impl) return;
    if (this.impl.render) this.impl.render();
    else if (this.impl.pushProperties) this.impl.pushProperties([5, 6, 7]);
  }

  destroy() {
    if (this.impl) this.impl.destroy();
    this.impl = null;
  }
}

module.exports = { TrayIcon };
