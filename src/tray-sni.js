/*
 * The tray icon, spoken rather than borrowed.
 *
 * Electron provides a Tray and it very nearly works. What it cannot do is keep
 * an item still: its only lever is setContextMenu, which builds a new menu, and
 * a new menu is a new set of dbusmenu ids. Measured on the session bus, the
 * first item went from id 19 to id 28 across one hide. gnome-shell draws its
 * popup from the layout it cached, so a click after that carries id 19 to a
 * client that has never heard of it -- "error occurred in Event", and the window
 * does not move. Open the tray again and it works, which is exactly the bug the
 * owner reported twice: the first click does nothing.
 *
 * That is why the wording could not follow the window. Nothing else was wrong
 * with the idea, and Telegram does it on this very desktop: it owns its menu, so
 * its ids outlive every change, and it rewrites the label when the shell says
 * the menu is about to show. Watched on the bus, Telegram emits nothing at all
 * while its window is shown and hidden -- a bare AboutToShow(0) is what changes
 * "Minimize to Tray" into "Open Telegram".
 *
 * So this owns the menu. StatusNotifierItem and com.canonical.dbusmenu, both
 * answered here, over src/dbus.js -- which is written out for the same reason
 * this file exists: the client ships as package.json, src and data, with no
 * runtime dependencies, and it has to keep working on a machine that only ever
 * installed the package.
 *
 * The ids below are constants and must stay that way. Everything else here is
 * arrangement; that is the part that fixes the bug.
 */
'use strict';

const { nativeImage } = require('electron');
const { Bus } = require('./dbus');
const debug = require('./debug.js');

const WATCHER = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const ITEM_PATH = '/StatusNotifierItem';
const MENU_PATH = '/MenuBar';
const SNI_IFACE = 'org.kde.StatusNotifierItem';
const MENU_IFACE = 'com.canonical.dbusmenu';
const PROPS_IFACE = 'org.freedesktop.DBus.Properties';
const INTROSPECT_IFACE = 'org.freedesktop.DBus.Introspectable';

/*
 * The menu, by number. A host is entitled to remember these for as long as it
 * likes and to send one back whenever the user clicks -- which is the whole
 * reason this file exists -- so they are assigned once, here, and never
 * computed. Adding an item means adding a number, never renumbering one.
 */
const ID = {
  ROOT: 0,
  TOGGLE: 1,
  SEP_1: 2,
  SETTINGS: 3,
  /* 4, 5, 6 and 7 were Theme and its three modes, taken out of this menu on
     2026-09-03: the same three buttons are in the settings window, and two ways
     to one switch is one too many. The numbers are not reused and not filled in
     -- a host is entitled to hand back an id it read months ago, and the worst
     answer to a stale click is a different item. Nothing is exported at 4..7,
     so such a click now falls through activate() and does nothing at all. */
  SEP_2: 8,
  QUIT: 9,
  /* Added 2026-09-03, after QUIT, because a number here belongs to whichever
     item was given it first -- a host may hand any of them back long after the
     menu it read them from was drawn. Where they sit in the menu is the order
     in `children`, and that is free to change. */
  SEP_3: 10,
  ABOUT: 11,
  /* Added 2026-09-03 as well, and 12 for the same reason 10 and 11 were 10 and
     11: the next number, never a gap somebody would be tempted to fill -- 4 to
     7 fell vacant the same day and stay vacant. It sits under Settings in the
     menu, which is a matter of `children` and costs nothing. */
  FONTS: 12,
};

/* Variant helpers: src/dbus.js takes a variant as [signature, value]. */
const vs = value => ['s', String(value)];
const vb = value => ['b', !!value];

/*
 * An icon as the protocol wants it: width, height, and ARGB32 in network byte
 * order. Electron hands over BGRA, so the channels are re-ordered rather than
 * re-encoded -- no PNG decoder here, and no icon theme lookup either, because a
 * pixmap is the one form every host renders without being told where to look.
 */
const pixmap = image => {
  if (!image || image.isEmpty()) return [];
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const argb = Buffer.alloc(bgra.length);
  for (let at = 0; at < bgra.length; at += 4) {
    argb[at] = bgra[at + 3];         // A
    argb[at + 1] = bgra[at + 2];     // R
    argb[at + 2] = bgra[at + 1];     // G
    argb[at + 3] = bgra[at];         // B
  }
  return [[width, height, Array.from(argb)]];
};

class SniTray {
  constructor({ normal, attention, onToggle, onShow, onHide, onQuit, onSettings,
                onFonts, getInFront, onAbout, getUpdate,
                title = 'WhatsApp', appId = 'whatsapp-desktop' }) {
    this.icons = {
      normal: nativeImage.createFromPath(normal),
      attention: nativeImage.createFromPath(attention || normal),
    };
    this.pixmaps = {
      normal: pixmap(this.icons.normal),
      attention: pixmap(this.icons.attention),
    };
    this.handlers = { onToggle, onShow, onHide, onQuit, onSettings, onFonts,
                      onAbout, getUpdate };
    this.title = title;
    this.appId = appId;
    this.unread = false;
    /* Whether the window is up and in front of the owner. Null until something
       says, and the label reads as though the window were away until then --
       which is what a tray icon is usually looked at for. */
    this.inFront = null;
    /* Asked again the moment the menu is about to be drawn, so a missed event
       cannot leave the wrong word on the item. */
    this.inFrontNow = getInFront || null;
    /* Whether the desktop is drawing this menu right now. The host says so
       itself -- dbusmenu sends `opened` and `closed` against the root -- and
       while it is true nothing here moves; see setInFront. */
    this.menuOpen = false;
    this.revision = 1;

    this.bus = null;
    this.busName = null;
    this.registered = false;
    this.dead = false;
  }

  /* Calls back with an error if this desktop cannot be spoken to at all, so the
     caller can fall back to Electron's own tray rather than showing nothing. */
  start(cb) {
    Bus.connect((err, bus) => {
      if (err) { cb(err); return; }
      if (this.dead) { bus.close(); return; }
      this.bus = bus;

      /* The name every host looks for. The pid keeps two copies of this client
         from colliding, which the bus would otherwise refuse. */
      this.busName = `org.kde.StatusNotifierItem-${process.pid}-1`;
      bus.requestName(this.busName, nameErr => {
        if (nameErr) { cb(nameErr); return; }
        this.exportItem();
        this.exportMenu();
        this.watchForHost();
        cb(null);
      });
    });
  }

  /* ------------------------------------------------------------ the icon */

  itemProperties() {
    const marks = this.unread;
    return [
      ['Category', vs('ApplicationStatus')],
      ['Id', vs(this.appId)],
      ['Title', vs(this.title)],
      /* NeedsAttention is the honest status for an unread message, and hosts
         that do nothing with it still get a changed pixmap below. */
      ['Status', vs(marks ? 'NeedsAttention' : 'Active')],
      ['WindowId', ['u', 0]],
      ['IconName', vs('')],
      ['IconPixmap', ['a(iiay)', marks ? this.pixmaps.attention : this.pixmaps.normal]],
      ['OverlayIconName', vs('')],
      ['OverlayIconPixmap', ['a(iiay)', []]],
      ['AttentionIconName', vs('')],
      ['AttentionIconPixmap', ['a(iiay)', this.pixmaps.attention]],
      ['AttentionMovieName', vs('')],
      ['ToolTip', ['(sa(iiay)ss)', ['', [], marks ? `${this.title} — unread messages` : this.title, '']]],
      /* False, so that a host which delivers clicks calls Activate below. GNOME
         opens the menu instead and never asks. */
      ['ItemIsMenu', vb(false)],
      ['Menu', ['o', MENU_PATH]],
    ];
  }

  exportItem() {
    const properties = () => this.itemProperties();

    this.bus.export(ITEM_PATH, {
      [SNI_IFACE]: {
        /* A left click where one is delivered -- KDE does, GNOME opens the menu
           instead. There is no word on the icon to have promised anything, so
           this one asks how things stand and decides now. */
        Activate: (args, reply) => { this.refreshToggle(); this.toggle(); reply(); },
        SecondaryActivate: (args, reply) => { this.refreshToggle(); this.toggle(); reply(); },
        Scroll: (args, reply) => reply(),
        ContextMenu: (args, reply) => reply(),
      },
      [PROPS_IFACE]: {
        Get: ([, name], reply, fail) => {
          const found = properties().find(p => p[0] === name);
          if (!found) { fail('org.freedesktop.DBus.Error.InvalidArgs', `no property ${name}`); return; }
          reply('v', [found[1]]);
        },
        GetAll: (args, reply) => reply('a{sv}', [properties()]),
        Set: (args, reply) => reply(),
      },
      [INTROSPECT_IFACE]: {
        Introspect: (args, reply) => reply('s', [ITEM_XML]),
      },
    });
  }

  /* --------------------------------------------------------- the menu */

  /*
   * The one word that moves. Everything else in this menu is fixed.
   *
   * "In front", not "on screen". A window that is up but behind the editor is
   * one the owner is reaching for -- offering to put it away would be answering
   * a question nobody asked, and it is what this item used to do.
   */
  toggleLabel() {
    return this.inFront ? 'Minimize to Tray' : 'Open WhatsApp';
  }

  /*
   * The other word that moves, and the menu's only announcement.
   *
   * Checking for a version and going to the site are both inside the About
   * window rather than out here -- the owner asked for the menu back, and a tray
   * menu earns its length. What is left is that a release nobody has looked for
   * would then be found by the daily check and never mentioned, so the one item
   * that leads to it says so.
   */
  aboutLabel() {
    const found = this.handlers.getUpdate && this.handlers.getUpdate();
    return found && found.newer ? `About WhatsApp — ${found.latest} is out` : 'About WhatsApp';
  }

  /* An item's properties, filtered to what the host asked for -- an empty
     request means all of them, which is what the spec says and what gnome-shell
     relies on. */
  itemProps(id, wanted) {
    const all = {
      [ID.TOGGLE]: [['label', vs(this.toggleLabel())], ['enabled', vb(true)], ['visible', vb(true)]],
      [ID.SEP_1]: [['type', vs('separator')], ['visible', vb(true)]],
      [ID.SETTINGS]: [['label', vs('Settings…')], ['enabled', vb(true)], ['visible', vb(true)]],
      /* The way in that the owner asked for: a window of their own, opened on
         the fonts rather than on a window that has them somewhere in it. */
      [ID.FONTS]: [['label', vs('Fonts…')], ['enabled', vb(true)], ['visible', vb(true)]],
      [ID.SEP_3]: [['type', vs('separator')], ['visible', vb(true)]],
      [ID.ABOUT]: [['label', vs(this.aboutLabel())], ['enabled', vb(true)], ['visible', vb(true)]],
      [ID.SEP_2]: [['type', vs('separator')], ['visible', vb(true)]],
      [ID.QUIT]: [['label', vs('Quit')], ['enabled', vb(true)], ['visible', vb(true)]],
      [ID.ROOT]: [['children-display', vs('submenu')]],
    }[id] || [];
    if (!wanted || !wanted.length) return all;
    return all.filter(p => wanted.includes(p[0]));
  }

  /* The tree, as a host reads it: (id, properties, children-as-variants). */
  layout(id, depth, wanted) {
    const children = {
      [ID.ROOT]: [ID.TOGGLE, ID.SEP_1, ID.SETTINGS, ID.FONTS, ID.SEP_3,
                  ID.ABOUT, ID.SEP_2, ID.QUIT],
    }[id] || [];

    const kids = depth === 0 ? [] : children.map(child =>
      ['(ia{sv}av)', this.layout(child, depth < 0 ? -1 : depth - 1, wanted)]);

    return [id, this.itemProps(id, wanted), kids];
  }

  exportMenu() {
    this.bus.export(MENU_PATH, {
      [MENU_IFACE]: {
        GetLayout: ([parent, depth, wanted], reply) => {
          debug.trace('menu: GetLayout(%s, %s), label "%s"', parent, depth, this.toggleLabel());
          reply('u(ia{sv}av)', [this.revision, this.layout(parent, depth, wanted)]);
        },

        GetGroupProperties: ([ids, wanted], reply) => {
          const all = Object.values(ID);
          const asked = ids && ids.length ? ids : all;
          reply('a(ia{sv})', [asked.map(id => [id, this.itemProps(id, wanted)])]);
        },

        GetProperty: ([id, name], reply, fail) => {
          const found = this.itemProps(id, [name])[0];
          if (!found) { fail('org.freedesktop.DBus.Error.InvalidArgs', `no property ${name}`); return; }
          reply('v', [found[1]]);
        },

        /*
         * The moment everything turns on. The shell sends this as its popup
         * opens, and Telegram's answer to it is what keeps Telegram's own label
         * right. The word is recomputed here, and `true` says the layout is
         * worth reading again -- which is safe now in a way it never was under
         * Electron's tray, because re-reading this menu returns the same ids.
         *
         * It is also the last honest moment there is. From here until the popup
         * closes the shell holds the keyboard, so the window it is being asked
         * about is unfocused for as long as the owner spends reading the menu.
         * What is decided now is therefore what the click will do -- see
         * toggle() -- and the two cannot come apart however long the menu stays
         * open.
         */
        AboutToShow: ([id], reply) => {
          const changed = this.refreshToggle();
          debug.trace('menu: AboutToShow(%s) -> %s, label "%s"', id, changed, this.toggleLabel());
          reply('b', [changed || id === ID.ROOT]);
        },

        AboutToShowGroup: ([ids], reply) => {
          this.refreshToggle();
          debug.trace('menu: AboutToShowGroup(%s), label "%s"', JSON.stringify(ids), this.toggleLabel());
          reply('aiai', [[], ids || []]);
        },

        Event: ([id, event], reply) => {
          debug.trace('menu: Event(%s, %s)', id, event);
          this.handle(id, event);
          reply();
        },

        EventGroup: ([events], reply) => {
          for (const [id, event] of events || []) this.handle(id, event);
          reply('ai', [[]]);
        },
      },

      [PROPS_IFACE]: {
        Get: ([, name], reply, fail) => {
          const props = this.menuProperties();
          const found = props.find(p => p[0] === name);
          if (!found) { fail('org.freedesktop.DBus.Error.InvalidArgs', `no property ${name}`); return; }
          reply('v', [found[1]]);
        },
        GetAll: (args, reply) => reply('a{sv}', [this.menuProperties()]),
        Set: (args, reply) => reply(),
      },

      [INTROSPECT_IFACE]: {
        Introspect: (args, reply) => reply('s', [MENU_XML]),
      },
    });
  }

  menuProperties() {
    return [
      ['Version', ['u', 3]],
      ['TextDirection', vs('ltr')],
      ['Status', vs('normal')],
      ['IconThemePath', ['as', []]],
    ];
  }

  /*
   * One event from the host, of the three kinds it sends.
   *
   * `opened` and `closed` are worth answering because they are the only word
   * anybody gives about what the owner can see. Between them the item is being
   * looked at, and an item being looked at must not change: a click is coming
   * for whichever word is on it, and the window state that word came from was
   * settled when the menu opened.
   *
   * A click closes the popup on every host this has been run against, and the
   * `closed` that follows is not waited for -- if a host ever failed to send one
   * the item would be frozen for the rest of the session.
   */
  handle(id, event) {
    if (event === 'opened') { this.menuOpen = true; return; }
    if (event === 'closed') { this.menuOpen = false; this.refreshToggle(); return; }
    if (event !== 'clicked') return;
    this.menuOpen = false;
    this.activate(id);
  }

  activate(id) {
    const h = this.handlers;
    if (id === ID.TOGGLE) this.toggle();
    else if (id === ID.SETTINGS) h.onSettings && h.onSettings();
    else if (id === ID.FONTS) h.onFonts && h.onFonts();
    else if (id === ID.QUIT) h.onQuit && h.onQuit();
    else if (id === ID.ABOUT) h.onAbout && h.onAbout();
  }

  /*
   * What the item does, which is whichever of the two things it currently says.
   *
   * Reading the word rather than asking the window again is the point. The menu
   * settled the question when it opened -- and it had to, because by the time
   * the click arrives the shell has held the keyboard for as long as the owner
   * spent looking at the menu. Asking now would be asking about a window that
   * has been unfocused all that while, and every click would read "open" and
   * re-map a window that was already in front.
   */
  toggle() {
    const h = this.handlers;
    if (this.inFront && h.onHide) h.onHide();
    else if (!this.inFront && h.onShow) h.onShow();
    else if (h.onToggle) h.onToggle();
  }

  /* --------------------------------------------------- telling the host */

  /* Re-read the window's state into the label. Returns whether the word moved,
     which is what AboutToShow answers with. */
  refreshToggle() {
    const wanted = this.inFrontNow ? this.inFrontNow() : this.inFront;
    if (wanted === this.inFront) return false;
    this.inFront = wanted;
    this.pushProperties([ID.TOGGLE]);
    return true;
  }

  /*
   * A property update, which is the signal a host applies to a menu it is
   * already showing -- no relayout, no renumbering, nothing for a cached popup
   * to get wrong. This is the whole difference between this file and the tray
   * it replaces.
   */
  pushProperties(ids) {
    if (!this.bus || !this.registered) return;
    const updated = ids.map(id => [id, this.itemProps(id, [])]);
    this.bus.signal({
      path: MENU_PATH, interface: MENU_IFACE, member: 'ItemsPropertiesUpdated',
      signature: 'a(ia{sv})a(ias)', body: [updated, []],
    });
  }

  /*
   * Where the window went. Called from main.js, from the window's own events.
   *
   * Told eagerly rather than only when the menu asks, and that is worth the
   * traffic: gnome-shell files a property update that arrives while its popup is
   * closed instead of applying it, and re-reads the whole menu the next time the
   * popup opens *because* one was filed. An item that only ever spoke up when
   * asked would be drawn from a cache nothing had invalidated.
   */
  setInFront(inFront) {
    /* Not while the owner is reading it. The word would change under their
       hand -- and worse, the click that is on its way would do the other thing.
       What is true now is read again on `closed`. */
    if (this.menuOpen) return;
    if (inFront === this.inFront) return;
    this.inFront = inFront;
    this.pushProperties([ID.TOGGLE]);
  }

  setAttention(unread) {
    if (unread === this.unread) return;
    this.unread = unread;
    if (!this.bus || !this.registered) return;
    for (const member of ['NewIcon', 'NewAttentionIcon', 'NewStatus']) {
      this.bus.signal({
        path: ITEM_PATH, interface: SNI_IFACE, member,
        signature: member === 'NewStatus' ? 's' : undefined,
        body: member === 'NewStatus' ? [unread ? 'NeedsAttention' : 'Active'] : [],
      });
    }
    this.bus.signal({ path: ITEM_PATH, interface: SNI_IFACE, member: 'NewToolTip' });
  }

  /* ------------------------------------------------------ finding a host */

  /*
   * Electron asks the watcher once and gives up if nobody answers, which at
   * login is most of the time: this client starts seconds after gnome-shell and
   * before the extension has claimed the name, and the icon is then missing for
   * the whole session. So the name is waited for, on this connection rather than
   * through a spawned gdbus.
   */
  watchForHost() {
    this.bus.addMatch(
      `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',` +
      `member='NameOwnerChanged',arg0='${WATCHER}'`);

    this.bus.onSignal(msg => {
      if (msg.member !== 'NameOwnerChanged') return;
      const [name, , owner] = msg.body || [];
      if (name === WATCHER && owner) this.register();
    });

    this.bus.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: 'NameHasOwner',
      signature: 's', body: [WATCHER],
    }, (err, body) => {
      if (!err && body && body[0]) this.register();
      else console.log('tray: no status icon host yet; the icon appears when one arrives');
    });
  }

  register() {
    if (this.dead || !this.bus) return;
    this.bus.call({
      destination: WATCHER, path: WATCHER_PATH,
      interface: WATCHER, member: 'RegisterStatusNotifierItem',
      signature: 's', body: [this.busName],
    }, err => {
      if (err) { console.log(`tray: the host refused this icon (${err.message})`); return; }
      this.registered = true;
      console.log('tray: registered with a status icon host');
    });
  }

  destroy() {
    this.dead = true;
    if (this.bus) { this.bus.close(); this.bus = null; }
  }
}

/* Hosts that introspect before they talk. gnome-shell does not, KDE's does. */
const ITEM_XML = `<node>
 <interface name="org.kde.StatusNotifierItem">
  <property name="Category" type="s" access="read"/>
  <property name="Id" type="s" access="read"/>
  <property name="Title" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="WindowId" type="u" access="read"/>
  <property name="IconName" type="s" access="read"/>
  <property name="IconPixmap" type="a(iiay)" access="read"/>
  <property name="OverlayIconName" type="s" access="read"/>
  <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionIconName" type="s" access="read"/>
  <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
  <property name="AttentionMovieName" type="s" access="read"/>
  <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
  <property name="ItemIsMenu" type="b" access="read"/>
  <property name="Menu" type="o" access="read"/>
  <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
  <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
  <signal name="NewIcon"/>
  <signal name="NewAttentionIcon"/>
  <signal name="NewToolTip"/>
  <signal name="NewStatus"><arg name="status" type="s"/></signal>
 </interface>
</node>`;

const MENU_XML = `<node>
 <interface name="com.canonical.dbusmenu">
  <property name="Version" type="u" access="read"/>
  <property name="TextDirection" type="s" access="read"/>
  <property name="Status" type="s" access="read"/>
  <property name="IconThemePath" type="as" access="read"/>
  <method name="GetLayout">
   <arg name="parentId" type="i" direction="in"/>
   <arg name="recursionDepth" type="i" direction="in"/>
   <arg name="propertyNames" type="as" direction="in"/>
   <arg name="revision" type="u" direction="out"/>
   <arg name="layout" type="(ia{sv}av)" direction="out"/>
  </method>
  <method name="GetGroupProperties">
   <arg name="ids" type="ai" direction="in"/>
   <arg name="propertyNames" type="as" direction="in"/>
   <arg name="properties" type="a(ia{sv})" direction="out"/>
  </method>
  <method name="GetProperty">
   <arg name="id" type="i" direction="in"/>
   <arg name="name" type="s" direction="in"/>
   <arg name="value" type="v" direction="out"/>
  </method>
  <method name="Event">
   <arg name="id" type="i" direction="in"/>
   <arg name="eventId" type="s" direction="in"/>
   <arg name="data" type="v" direction="in"/>
   <arg name="timestamp" type="u" direction="in"/>
  </method>
  <method name="EventGroup">
   <arg name="events" type="a(isvu)" direction="in"/>
   <arg name="idErrors" type="ai" direction="out"/>
  </method>
  <method name="AboutToShow">
   <arg name="id" type="i" direction="in"/>
   <arg name="needUpdate" type="b" direction="out"/>
  </method>
  <method name="AboutToShowGroup">
   <arg name="ids" type="ai" direction="in"/>
   <arg name="updatesNeeded" type="ai" direction="out"/>
   <arg name="idErrors" type="ai" direction="out"/>
  </method>
  <signal name="ItemsPropertiesUpdated">
   <arg name="updatedProps" type="a(ia{sv})"/>
   <arg name="removedProps" type="a(ias)"/>
  </signal>
  <signal name="LayoutUpdated"><arg name="revision" type="u"/><arg name="parent" type="i"/></signal>
  <signal name="ItemActivationRequested"><arg name="id" type="i"/><arg name="timestamp" type="u"/></signal>
 </interface>
</node>`;

module.exports = { SniTray, ID };
