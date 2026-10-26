/*
 * One request to the X server, written here rather than installed -- for the
 * reason src/dbus.js gives: the client ships with no runtime dependencies.
 *
 * The request is a resize, and the point of it is that Chromium never hears
 * about it. A window the window manager has maximised on X11 is a window whose
 * own size requests are taken by mutter as the size to un-maximise to: the
 * window stays exactly where it is, nothing is drawn, and the next un-maximise
 * goes to that size. Measured in a nested GNOME 50 shell, against the client
 * on Xwayland: mapped maximised, a ConfigureWindow of 1600x968 from another
 * connection left it maximised and un-maximising gave 1600x968; without it,
 * the whole screen.
 *
 * Electron's setSize() sends the same request, and is the wrong way to send
 * it. Chromium assumes a resize it asked for has gone through -- so it lays
 * the page out at the new size at once and corrects itself when the window
 * manager's answer arrives. Measured: the open window jumped to a small copy
 * of the chat list in its corner for a frame and back. From a connection of
 * its own, the request goes past Chromium and nothing is drawn.
 *
 * Only what that needs is here: a local display, the MIT-MAGIC-COOKIE-1 that
 * every desktop's Xauthority carries, and five requests. No extensions, no
 * events, no big-endian server -- the byte order is the client's to choose,
 * and this one chooses little-endian.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

/* The display number in DISPLAY, for a server on this machine: ":0", ":1.0",
   "unix:0". A display on another host is TCP, and nothing here goes there. */
const displayNumber = display => {
  const match = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(display || '');
  return match ? match[1] : null;
};

/* The cookie for that display, out of the Xauthority file: entries of a
   family, an address, a display number, an auth name and its data, each
   behind a big-endian length. A local entry for this host wins over a
   wildcard; an entry with no number is good for every display. */
const FAMILY_LOCAL = 256;
const FAMILY_WILD = 65535;
const COOKIE = 'MIT-MAGIC-COOKIE-1';

const findCookie = (data, number, host) => {
  let at = 0;
  const field = () => {
    const length = data.readUInt16BE(at);
    const value = data.subarray(at + 2, at + 2 + length);
    if (value.length !== length) throw new RangeError('truncated');
    at += 2 + length;
    return value;
  };
  let wild = null;
  try {
    while (at + 2 <= data.length) {
      const family = data.readUInt16BE(at);
      at += 2;
      const address = field().toString('latin1');
      const entry = field().toString('latin1');
      const name = field().toString('latin1');
      const secret = field();
      if (name !== COOKIE || (entry && entry !== number)) continue;
      if (family === FAMILY_LOCAL && address === host) return secret;
      if (family === FAMILY_WILD && !wild) wild = secret;
    }
  } catch (error) {
    /* A file cut short is read up to where it ends. */
  }
  return wild;
};

const readCookie = number => {
  const file = process.env.XAUTHORITY || path.join(os.homedir(), '.Xauthority');
  try {
    return findCookie(fs.readFileSync(file), number, os.hostname());
  } catch (error) {
    return null;
  }
};

const pad = length => (4 - (length % 4)) % 4;

/* The connection setup: byte order, protocol 11.0, and the cookie if there is
   one. A server that lets this user in without one (xhost si:localuser) is
   answered the same way. */
const setupRequest = cookie => {
  const name = cookie ? Buffer.from(COOKIE, 'latin1') : Buffer.alloc(0);
  const data = cookie || Buffer.alloc(0);
  const out = Buffer.alloc(12 + name.length + pad(name.length) + data.length + pad(data.length));
  out[0] = 0x6c;
  out.writeUInt16LE(11, 2);
  out.writeUInt16LE(0, 4);
  out.writeUInt16LE(name.length, 6);
  out.writeUInt16LE(data.length, 8);
  name.copy(out, 12);
  data.copy(out, 12 + name.length + pad(name.length));
  return out;
};

const OP = { GET_WINDOW_ATTRIBUTES: 3, CONFIGURE_WINDOW: 12, INTERN_ATOM: 16,
             GET_PROPERTY: 20, GET_INPUT_FOCUS: 43 };
const VIEWABLE = 2;
const CONFIGURE_WIDTH = 0x4;
const CONFIGURE_HEIGHT = 0x8;

const request = (opcode, data, words) => {
  const out = Buffer.alloc(4 + words.length * 4);
  out[0] = opcode;
  out[1] = data;
  out.writeUInt16LE(1 + words.length, 2);
  words.forEach((word, i) => out.writeUInt32LE(word >>> 0, 4 + i * 4));
  return out;
};

const internAtom = name => {
  const bytes = Buffer.from(name, 'latin1');
  const out = Buffer.alloc(8 + bytes.length + pad(bytes.length));
  out[0] = OP.INTERN_ATOM;
  out[1] = 1; /* only if it exists: a window manager that never made it has nothing to say */
  out.writeUInt16LE(out.length / 4, 2);
  out.writeUInt16LE(bytes.length, 4);
  bytes.copy(out, 8);
  return out;
};

/*
 * A connection, the setup answered, and requests matched to their replies by
 * sequence number. A request with no reply that fails sends an error for its
 * number; it is kept, and asked about after the round trip that follows it.
 */
class Connection {
  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.waiting = new Map();
    this.errors = new Map();
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.closed = false;
    socket.on('data', chunk => this.read(chunk));
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('the X server closed the connection')));
  }

  setUp(cookie) {
    return new Promise((resolve, reject) => {
      this.onSetup = { resolve, reject };
      this.socket.write(setupRequest(cookie));
    });
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.ready) {
      if (this.buffer.length < 8) return;
      const length = 8 + this.buffer.readUInt16LE(6) * 4;
      if (this.buffer.length < length) return;
      const status = this.buffer[0];
      const reason = this.buffer.subarray(8, 8 + this.buffer[1]).toString('latin1');
      this.buffer = this.buffer.subarray(length);
      this.ready = true;
      if (status === 1) this.onSetup.resolve();
      else this.onSetup.reject(new Error(`the X server refused the connection${reason ? `: ${reason.trim()}` : ''}`));
    }
    while (this.buffer.length >= 32) {
      const kind = this.buffer[0];
      /* A reply carries its length; an error or an event is 32 bytes. The one
         exception, an extension's GenericEvent, cannot arrive here: nothing
         selected it. */
      const length = kind === 1 ? 32 + this.buffer.readUInt32LE(4) * 4 : 32;
      if (this.buffer.length < length) return;
      const message = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      const sequence = message.readUInt16LE(2);
      const waiter = this.waiting.get(sequence);
      if (kind === 1 && waiter) {
        this.waiting.delete(sequence);
        waiter.resolve(message);
      } else if (kind === 0) {
        const error = new Error(`X error ${message[1]} for request ${message[10]}`);
        if (waiter) { this.waiting.delete(sequence); waiter.reject(error); }
        else this.errors.set(sequence, error);
      }
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    if (!this.ready && this.onSetup) this.onSetup.reject(error);
    for (const waiter of this.waiting.values()) waiter.reject(error);
    this.waiting.clear();
  }

  /* Sent, and its sequence number handed back. */
  send(bytes) {
    if (this.closed) throw new Error('the X connection is closed');
    this.sequence = (this.sequence + 1) & 0xffff;
    this.socket.write(bytes);
    return this.sequence;
  }

  ask(bytes) {
    return new Promise((resolve, reject) => {
      const sequence = this.send(bytes);
      this.waiting.set(sequence, { resolve, reject });
    });
  }

  close() {
    this.closed = true;
    this.socket.destroy();
  }
}

/* The server's socket: the file first, then the same name in the abstract
   namespace, which is where Xwayland listens when /tmp is not shared. */
const open = number => new Promise((resolve, reject) => {
  const names = [`/tmp/.X11-unix/X${number}`, `\0/tmp/.X11-unix/X${number}`];
  const attempt = i => {
    const socket = net.createConnection(names[i]);
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    socket.once('error', error => (i + 1 < names.length ? attempt(i + 1) : reject(error)));
  };
  attempt(0);
});

const connect = async (display = process.env.DISPLAY) => {
  const number = displayNumber(display);
  if (number === null) throw new Error(`not a local X display: ${display || '(unset)'}`);
  const connection = new Connection(await open(number));
  try {
    await connection.setUp(readCookie(number));
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/*
 * The size `xid` goes back to when it is un-maximised, told to the window
 * manager once it has the window up maximised -- and only then.
 *
 * Before that the same request means something else entirely. A window the
 * manager has not mapped yet is not one it manages, and a request for it is
 * carried out as asked: the window would map at that size and be maximised
 * after, which is the very frame of a small page in a large window that this
 * exists to avoid. So the window is watched until the server says it is
 * viewable -- with a window manager running, that is mutter having taken the
 * map and done what it does with it -- and the request goes only if the window
 * came up maximised. One that did not is left alone: resizing it would be
 * resizing a window the owner is looking at.
 *
 * Answers what became of it: 'sent', or 'not maximised' when the window was up
 * and not maximised, or 'not up' when it never got there in `within` ms.
 */
const sizeToUnmaximiseTo = async (xid, width, height, { display, within = 3000, every = 40 } = {}) => {
  const connection = await connect(display);
  try {
    const atom = async name => (await connection.ask(internAtom(name))).readUInt32LE(8);
    const [state, vert, horz] = await Promise.all(['_NET_WM_STATE', '_NET_WM_STATE_MAXIMIZED_VERT',
      '_NET_WM_STATE_MAXIMIZED_HORZ'].map(atom));
    /* No window manager has ever maximised anything on this server. */
    if (!state || !vert || !horz) return 'not maximised';
    const until = Date.now() + within;
    for (;;) {
      const attributes = await connection.ask(request(OP.GET_WINDOW_ATTRIBUTES, 0, [xid]));
      if (attributes[26] === VIEWABLE) {
        const reply = await connection.ask(request(OP.GET_PROPERTY, 0, [xid, state, 0, 0, 32]));
        const count = reply[1] === 32 ? reply.readUInt32LE(16) : 0;
        const atoms = new Set(Array.from({ length: count }, (_, i) => reply.readUInt32LE(32 + i * 4)));
        if (!atoms.has(vert) || !atoms.has(horz)) return 'not maximised';
        const sent = connection.send(request(OP.CONFIGURE_WINDOW, 0,
          [xid, CONFIGURE_WIDTH | CONFIGURE_HEIGHT, width, height]));
        /* A round trip, so that an error for the resize -- the window gone in
           between -- has arrived by the time it is asked about. */
        await connection.ask(request(OP.GET_INPUT_FOCUS, 0, []));
        const error = connection.errors.get(sent);
        if (error) throw error;
        return 'sent';
      }
      if (Date.now() >= until) return 'not up';
      await sleep(every);
    }
  } finally {
    connection.close();
  }
};

module.exports = { sizeToUnmaximiseTo, displayNumber, findCookie };
