/*
 * The global keys, asked of the desktop rather than grabbed from it.
 *
 * Electron's globalShortcut grabs a key from the X server, and on a Wayland
 * session that X server is XWayland -- which hears a key only while one of its
 * own windows has the focus. With every other window on the desktop native,
 * Super+Alt+W reached this client exactly when it was already in front, which
 * is the one moment it is not needed. system.force-x11 put the window there
 * and nothing about the key said so: it registered, it reported success, and it
 * never fired. A native Wayland window fares no better, since a compositor
 * lets no client grab a key at all.
 *
 * What a Wayland desktop offers instead is the GlobalShortcuts portal: the
 * client names its shortcuts, the desktop asks the user once which keys they
 * go on, and says so on the bus whenever one is pressed -- wherever the focus
 * is, and whichever way the window is drawn. GNOME has it from 48, KDE and
 * Hyprland have their own. Electron 40 will not use it for a window on XWayland
 * (the X11 backend answers for global keys first), so it is spoken here,
 * through the same bus client the tray uses.
 *
 * Where there is no such portal -- an X11 session, or a compositor without it
 * -- `bind` rejects, and the caller grabs the keys from X the way it always did.
 */
'use strict';

const { Bus } = require('./dbus.js');

const PORTAL = 'org.freedesktop.portal.Desktop';
const DESKTOP = '/org/freedesktop/portal/desktop';
const SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
const REQUEST = 'org.freedesktop.portal.Request';
const SESSION = 'org.freedesktop.portal.Session';
const REGISTRY = 'org.freedesktop.host.portal.Registry';
const PROPERTIES = 'org.freedesktop.DBus.Properties';

/* A Wayland session is one the desktop says is, or one with a compositor to
   talk to -- whichever backend this window happens to be drawn through. */
const waylandSession = (env = process.env) =>
  env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;

/* ------------------------------------------------------------ the triggers */

/* Electron's spelling of a key, in the one the portal reads: the modifiers in
   capitals and the key by its keysym name, "Super+Alt+W" -> "LOGO+ALT+w". It
   is only a suggestion -- the desktop shows it and the user decides -- so a
   key with no keysym here is sent without one rather than guessed at. */
const MODIFIERS = {
  super: 'LOGO', meta: 'LOGO', cmd: 'LOGO', command: 'LOGO',
  ctrl: 'CTRL', control: 'CTRL', cmdorctrl: 'CTRL', commandorcontrol: 'CTRL',
  alt: 'ALT', option: 'ALT', shift: 'SHIFT',
};
const KEYSYMS = {
  space: 'space', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete',
  insert: 'Insert', return: 'Return', enter: 'Return', escape: 'Escape',
  esc: 'Escape', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down',
  plus: 'plus', '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period',
  '/': 'slash', ';': 'semicolon', "'": 'apostrophe', '[': 'bracketleft',
  ']': 'bracketright', '\\': 'backslash', '`': 'grave',
};

const trigger = accelerator => {
  const parts = String(accelerator || '').split('+').map(part => part.trim());
  if (parts.some(part => !part)) return '';
  const key = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return '';
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  let keysym = '';
  if (/^[a-z0-9]$/i.test(key)) keysym = key.toLowerCase();
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) keysym = key.toUpperCase();
  else keysym = KEYSYMS[key.toLowerCase()] || '';
  return keysym ? modifiers.concat(keysym).join('+') : '';
};

/* -------------------------------------------------------------- the client */

const dict = entries => Object.fromEntries(entries || []);
const str = value => ['s', String(value)];

/*
 * One connection, one session, kept for the life of the client. The desktop
 * remembers which keys the user gave which shortcut, by the app's id and the
 * shortcut's own. A new session starts with none of them -- measured on GNOME
 * 51, ListShortcuts answers an empty list -- but binding the same ids again is
 * answered at once, with no dialog, from what the desktop remembers. Only the
 * very first bind asks.
 *
 * The other side of that: a bind for an id the desktop already has comes back
 * with the key it already has, whatever this one suggested. So a key changed
 * in the config is changed through `configure`, the desktop's own dialog.
 */
const create = ({ appId = '', connect = cb => Bus.connect(cb), log = () => {} } = {}) => {
  let bus = null;
  let opening = null;
  let session = null;
  let version = 0;
  let handlers = new Map();
  let serial = 0;
  let queue = Promise.resolve();
  const waiting = new Map();

  const token = () => `whatsapp_${process.pid}_${++serial}`;

  const call = (member, signature, body, iface = SHORTCUTS, path = DESKTOP) =>
    new Promise((resolve, reject) => {
      bus.call({ destination: PORTAL, path, interface: iface, member, signature, body },
        (err, reply) => (err ? reject(err) : resolve(reply || [])));
    });

  const match = rule => new Promise((resolve, reject) =>
    bus.addMatch(rule, err => (err ? reject(err) : resolve())));

  /* A portal method answers at once with the path of a Request, and with the
     result later, as that Request's Response -- after a dialog, for a bind. The
     path is predictable from the token, so the answer is waited for before the
     question is asked, and cannot slip past. */
  const request = async (member, signature, body, handleToken) => {
    const sender = String(bus.name || '').replace(/^:/, '').replace(/\./g, '_');
    const expected = `${DESKTOP}/request/${sender}/${handleToken}`;
    const answer = new Promise(resolve => waiting.set(expected, resolve));
    let handle;
    try {
      [handle] = await call(member, signature, body);
    } catch (err) {
      waiting.delete(expected);
      throw err;
    }
    if (handle && handle !== expected && waiting.has(expected)) {
      waiting.set(handle, waiting.get(expected));
      waiting.delete(expected);
    }
    const [response, results] = await answer;
    return { response, results: dict(results) };
  };

  const onSignal = msg => {
    if (msg.interface === REQUEST && msg.member === 'Response') {
      const resolve = waiting.get(msg.path);
      if (!resolve) return;
      waiting.delete(msg.path);
      resolve(msg.body || [2, []]);
      return;
    }
    if (msg.interface === SHORTCUTS && msg.member === 'Activated') {
      const [handle, id] = msg.body || [];
      if (!session || handle !== session) return;
      const run = handlers.get(id);
      if (run) run();
    }
  };

  const open = () => opening || (opening = connectAndAsk().catch(err => {
    if (bus) bus.close();
    bus = null;
    throw err;
  }));

  const connectAndAsk = async () => {
    bus = await new Promise((resolve, reject) =>
      connect((err, connected) => (err ? reject(err) : resolve(connected))));
    /* First, because the portal settles which app a connection belongs to on
       its first call. Without it a client started from a terminal is the
       terminal, and GNOME turns down every key asked for under an id that has
       no desktop file. A sandbox already has its id, and a portal older than
       1.19 has no registry: both are told no, and both are fine. */
    if (appId) {
      try { await call('Register', 'sa{sv}', [appId, []], REGISTRY); }
      catch (err) { log(`keys: the portal did not take the app id (${err.message})`); }
    }
    bus.onSignal(onSignal);
    await match(`type='signal',interface='${REQUEST}',member='Response'`);
    await match(`type='signal',interface='${SHORTCUTS}',member='Activated'`);
    /* The question that says whether there is a portal for this at all. A
       compositor without one answers it with an error, and that error is what
       sends the caller back to X. */
    const [answer] = await call('Get', 'ss', [SHORTCUTS, 'version'], PROPERTIES);
    version = Number(answer) || 1;
  };

  const startSession = async () => {
    if (session) return session;
    const handleToken = token();
    const { response, results } = await request('CreateSession', 'a{sv}',
      [[['handle_token', str(handleToken)], ['session_handle_token', str(token())]]], handleToken);
    if (response !== 0 || !results.session_handle) {
      throw new Error(`the portal would not open a session (response ${response})`);
    }
    session = String(results.session_handle);
    return session;
  };

  /* `wanted` is [{ id, description, accelerator, run }]. Answers with what
     became of them: the ids the desktop bound, or turned down. */
  const bindNow = async wanted => {
    await open();
    await startSession();
    handlers = new Map(wanted.map(one => [one.id, one.run]));

    const shortcuts = wanted.map(one => {
      const options = [['description', str(one.description)]];
      const preferred = trigger(one.accelerator);
      if (preferred) options.push(['preferred_trigger', str(preferred)]);
      return [one.id, options];
    });
    const handleToken = token();
    const { response, results } = await request('BindShortcuts', 'oa(sa{sv})sa{sv}',
      [session, shortcuts, '', [['handle_token', str(handleToken)]]], handleToken);
    if (response !== 0) return { declined: true, bound: [] };
    return { declined: false, bound: (results.shortcuts || []).map(([id]) => id) };
  };

  /* One at a time: a settings change arriving while the first bind's dialog is
     still up must not open a second session alongside it. */
  const bind = wanted => {
    const next = queue.then(() => bindNow(wanted));
    queue = next.catch(() => {});
    return next;
  };

  /* The desktop's own dialog for changing the keys, which is where a key the
     user has already been asked about is changed. Version 2 of the portal and
     later; before that there is nothing to open. */
  const configure = () => {
    queue = queue.then(async () => {
      if (!session || version < 2) return false;
      await call('ConfigureShortcuts', 'osa{sv}', [session, '', []]);
      return true;
    }).catch(err => log(`keys: the desktop could not open its key settings (${err.message})`));
    return queue;
  };

  /* Closing the session is what lets the keys go: the desktop stops sending
     them, and they are still remembered for the next session. */
  const close = () => {
    handlers = new Map();
    const closing = session;
    session = null;
    if (closing && bus) {
      bus.call({ destination: PORTAL, path: closing, interface: SESSION, member: 'Close' }, () => {});
    }
  };

  return { bind, configure, close, get version() { return version; } };
};

module.exports = { create, trigger, waylandSession };
