/*
 * A session bus client, written here rather than installed.
 *
 * This exists for one reason: the tray has to own its own menu. Electron's Tray
 * can only replace a menu wholesale, and replacing it renumbers every item --
 * measured on the bus, the first item went from id 19 to id 28 across a single
 * hide. gnome-shell draws its popup from the layout it cached, so the click that
 * follows carries a dead id and the window does not move. Owning the menu means
 * owning the ids, and owning the ids means speaking this protocol.
 *
 * Nothing is added to package.json for it. The client ships as `package.json`,
 * `src` and `data` and has no runtime dependencies at all -- see APP_FILES in
 * the Makefile -- and it stays that way, because "it works when I send it to
 * somebody" is the whole point of the package. `gdbus` can call a method but
 * cannot answer one, and answering is most of what a tray does.
 *
 * Only what the tray needs is here: the EXTERNAL handshake every session bus on
 * a Linux desktop accepts, the type system, method calls, exported objects and
 * signals. No file descriptors, no big-endian writer (nothing sends one; the
 * reader handles both because a peer is allowed to).
 */
'use strict';

const net = require('net');
const os = require('os');

const LITTLE = 0x6c;
const BIG = 0x42;

const TYPE = { METHOD_CALL: 1, METHOD_RETURN: 2, ERROR: 3, SIGNAL: 4 };
const NO_REPLY_EXPECTED = 1;

/* Header field codes, in the order the spec numbers them. */
const FIELD = {
  PATH: 1, INTERFACE: 2, MEMBER: 3, ERROR_NAME: 4,
  REPLY_SERIAL: 5, DESTINATION: 6, SENDER: 7, SIGNATURE: 8, UNIX_FDS: 9,
};

/* How far into the message each type has to start. Everything else follows from
   this table and from the rule that a struct opens on eight. */
const ALIGN = {
  y: 1, b: 4, n: 2, q: 2, i: 4, u: 4, x: 8, t: 8, d: 8,
  s: 4, o: 4, g: 1, a: 4, v: 1, '(': 8, '{': 8,
};

/* ------------------------------------------------------------- signatures */

/* One complete type from the front of a signature, so that the marshaller can
   walk a struct or an array element without counting brackets twice. */
const oneType = (sig, at) => {
  const c = sig[at];
  if (c === 'a') {
    const inner = oneType(sig, at + 1);
    return c + inner;
  }
  if (c === '(' || c === '{') {
    const close = c === '(' ? ')' : '}';
    let depth = 1;
    let end = at + 1;
    while (end < sig.length && depth > 0) {
      if (sig[end] === '(' || sig[end] === '{') depth++;
      else if (sig[end] === ')' || sig[end] === '}') depth--;
      if (depth === 0) break;
      end++;
    }
    return sig.slice(at, end + 1);
  }
  return c;
};

/* The types of a signature, side by side: "ia{sv}av" -> ["i","a{sv}","av"] */
const splitTypes = sig => {
  const out = [];
  let at = 0;
  while (at < sig.length) {
    const t = oneType(sig, at);
    out.push(t);
    at += t.length;
  }
  return out;
};

const alignOf = type => ALIGN[type[0]] !== undefined ? ALIGN[type[0]] : 1;

/* -------------------------------------------------------------- marshalling */

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  /* Alignment is measured from the start of the message. The body is written on
     its own here, which is sound because a body always begins on eight. */
  pad(to) {
    const short = (to - (this.length % to)) % to;
    if (short) this.raw(Buffer.alloc(short));
  }

  raw(buf) {
    this.chunks.push(buf);
    this.length += buf.length;
  }

  byte(v) { this.raw(Buffer.from([v & 0xff])); }

  uint16(v) { this.pad(2); const b = Buffer.alloc(2); b.writeUInt16LE(v); this.raw(b); }
  int16(v) { this.pad(2); const b = Buffer.alloc(2); b.writeInt16LE(v); this.raw(b); }
  uint32(v) { this.pad(4); const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.raw(b); }
  int32(v) { this.pad(4); const b = Buffer.alloc(4); b.writeInt32LE(v | 0); this.raw(b); }
  uint64(v) { this.pad(8); const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.raw(b); }
  int64(v) { this.pad(8); const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); this.raw(b); }
  double(v) { this.pad(8); const b = Buffer.alloc(8); b.writeDoubleLE(v); this.raw(b); }

  /* Strings and object paths carry a four byte length; signatures carry one
     byte, which is why they are the only type that never needs padding. */
  string(v) {
    const b = Buffer.from(String(v), 'utf8');
    this.uint32(b.length);
    this.raw(b);
    this.byte(0);
  }

  signature(v) {
    const b = Buffer.from(String(v), 'utf8');
    this.byte(b.length);
    this.raw(b);
    this.byte(0);
  }

  write(type, value) {
    switch (type[0]) {
      case 'y': return this.byte(value);
      case 'b': return this.uint32(value ? 1 : 0);
      case 'n': return this.int16(value);
      case 'q': return this.uint16(value);
      case 'i': return this.int32(value);
      case 'u': return this.uint32(value);
      case 'x': return this.int64(value);
      case 't': return this.uint64(value);
      case 'd': return this.double(value);
      case 's': case 'o': return this.string(value);
      case 'g': return this.signature(value);
      case 'v': return this.variant(value);
      case 'a': return this.array(type, value);
      case '(': return this.struct(type, value);
      case '{': return this.struct(type, value);
      default: throw new Error(`dbus: cannot write type '${type}'`);
    }
  }

  /* A variant is its own signature followed by its value: [signature, value]. */
  variant(pair) {
    const [sig, value] = pair;
    this.signature(sig);
    this.write(oneType(sig, 0), value);
  }

  /*
   * An array is a byte count, then its elements -- and the count does not
   * include the padding that gets the first element onto its own alignment.
   * That padding is why the length has to be patched in afterwards rather than
   * measured first: where the elements begin depends on where the array begins.
   */
  array(type, values) {
    const element = type.slice(1);
    this.pad(4);
    const lengthAt = this.length;
    this.raw(Buffer.alloc(4));                    // patched below
    this.pad(alignOf(element));
    const from = this.length;
    for (const v of values || []) this.write(element, v);
    const bytes = this.length - from;
    /* The placeholder is its own chunk, so it can be rewritten in place. */
    let seen = 0;
    for (const chunk of this.chunks) {
      if (seen === lengthAt && chunk.length === 4) { chunk.writeUInt32LE(bytes >>> 0); break; }
      seen += chunk.length;
    }
  }

  struct(type, values) {
    const inner = type.slice(1, -1);
    const types = splitTypes(inner);
    this.pad(8);
    types.forEach((t, i) => this.write(t, values[i]));
  }

  toBuffer() { return Buffer.concat(this.chunks, this.length); }
}

/* Marshal a body on its own. A body always starts eight-aligned, so writing it
   from zero gives the same layout it will have in the message. */
const marshalBody = (signature, values) => {
  if (!signature) return Buffer.alloc(0);
  const w = new Writer();
  splitTypes(signature).forEach((t, i) => w.write(t, values[i]));
  return w.toBuffer();
};

/* ------------------------------------------------------------ unmarshalling */

class Reader {
  constructor(buf, little = true, at = 0) {
    this.buf = buf;
    this.little = little;
    this.at = at;
  }

  pad(to) { this.at += (to - (this.at % to)) % to; }

  byte() { return this.buf.readUInt8(this.at++); }

  uint16() { this.pad(2); const v = this.little ? this.buf.readUInt16LE(this.at) : this.buf.readUInt16BE(this.at); this.at += 2; return v; }
  int16() { this.pad(2); const v = this.little ? this.buf.readInt16LE(this.at) : this.buf.readInt16BE(this.at); this.at += 2; return v; }
  uint32() { this.pad(4); const v = this.little ? this.buf.readUInt32LE(this.at) : this.buf.readUInt32BE(this.at); this.at += 4; return v; }
  int32() { this.pad(4); const v = this.little ? this.buf.readInt32LE(this.at) : this.buf.readInt32BE(this.at); this.at += 4; return v; }
  uint64() { this.pad(8); const v = this.little ? this.buf.readBigUInt64LE(this.at) : this.buf.readBigUInt64BE(this.at); this.at += 8; return Number(v); }
  int64() { this.pad(8); const v = this.little ? this.buf.readBigInt64LE(this.at) : this.buf.readBigInt64BE(this.at); this.at += 8; return Number(v); }
  double() { this.pad(8); const v = this.little ? this.buf.readDoubleLE(this.at) : this.buf.readDoubleBE(this.at); this.at += 8; return v; }

  string() {
    const len = this.uint32();
    const s = this.buf.toString('utf8', this.at, this.at + len);
    this.at += len + 1;
    return s;
  }

  signatureString() {
    const len = this.byte();
    const s = this.buf.toString('utf8', this.at, this.at + len);
    this.at += len + 1;
    return s;
  }

  read(type) {
    switch (type[0]) {
      case 'y': return this.byte();
      case 'b': return this.uint32() !== 0;
      case 'n': return this.int16();
      case 'q': return this.uint16();
      case 'i': return this.int32();
      case 'u': return this.uint32();
      case 'x': return this.int64();
      case 't': return this.uint64();
      case 'd': return this.double();
      case 's': case 'o': return this.string();
      case 'g': return this.signatureString();
      case 'v': {
        const sig = this.signatureString();
        return this.read(oneType(sig, 0));
      }
      case 'a': {
        const element = type.slice(1);
        const bytes = this.uint32();
        this.pad(alignOf(element));
        const end = this.at + bytes;
        const out = [];
        while (this.at < end) out.push(this.read(element));
        this.at = end;
        return out;
      }
      case '(': case '{': {
        const types = splitTypes(type.slice(1, -1));
        this.pad(8);
        return types.map(t => this.read(t));
      }
      default: throw new Error(`dbus: cannot read type '${type}'`);
    }
  }
}

/* ------------------------------------------------------------------ messages */

let nextSerial = 1;

const encode = msg => {
  const body = marshalBody(msg.signature, msg.body || []);

  const fields = [];
  const add = (code, sig, value) => fields.push([code, [sig, value]]);
  if (msg.path) add(FIELD.PATH, 'o', msg.path);
  if (msg.interface) add(FIELD.INTERFACE, 's', msg.interface);
  if (msg.member) add(FIELD.MEMBER, 's', msg.member);
  if (msg.errorName) add(FIELD.ERROR_NAME, 's', msg.errorName);
  if (msg.replySerial !== undefined) add(FIELD.REPLY_SERIAL, 'u', msg.replySerial);
  if (msg.destination) add(FIELD.DESTINATION, 's', msg.destination);
  if (msg.signature) add(FIELD.SIGNATURE, 'g', msg.signature);

  const w = new Writer();
  w.byte(LITTLE);
  w.byte(msg.type);
  w.byte(msg.flags || 0);
  w.byte(1);
  w.uint32(body.length);
  w.uint32(msg.serial);
  w.array('a(yv)', fields);
  /* The body opens on eight whatever the header came to. */
  w.pad(8);
  return Buffer.concat([w.toBuffer(), body]);
};

/* Returns [message, bytesConsumed] or null when the buffer holds less than a
   whole message. */
const decode = buf => {
  if (buf.length < 16) return null;
  const little = buf.readUInt8(0) === LITTLE;
  if (!little && buf.readUInt8(0) !== BIG) throw new Error('dbus: bad endianness byte');

  const r = new Reader(buf, little, 1);
  const type = r.byte();
  const flags = r.byte();
  r.byte();                                        // protocol version
  const bodyLength = r.uint32();
  const serial = r.uint32();
  const fields = r.read('a(yv)');
  r.pad(8);
  const headerEnd = r.at;
  const total = headerEnd + bodyLength;
  if (buf.length < total) return null;

  const msg = { type, flags, serial };
  for (const [code, value] of fields) {
    if (code === FIELD.PATH) msg.path = value;
    else if (code === FIELD.INTERFACE) msg.interface = value;
    else if (code === FIELD.MEMBER) msg.member = value;
    else if (code === FIELD.ERROR_NAME) msg.errorName = value;
    else if (code === FIELD.REPLY_SERIAL) msg.replySerial = value;
    else if (code === FIELD.DESTINATION) msg.destination = value;
    else if (code === FIELD.SENDER) msg.sender = value;
    else if (code === FIELD.SIGNATURE) msg.signature = value;
  }

  msg.body = [];
  if (msg.signature) {
    const br = new Reader(buf.slice(headerEnd, total), little, 0);
    for (const t of splitTypes(msg.signature)) msg.body.push(br.read(t));
  }
  return [msg, total];
};

/* --------------------------------------------------------------- connection */

/* Where the session bus is, in the one form every desktop sets. Anything other
   than a unix socket -- tcp, which nothing on a login session uses -- is left
   to the caller to fail on. */
const sessionAddress = () => {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (addr) {
    for (const part of addr.split(';')) {
      const path = /^unix:(?:.*,)?path=([^,]+)/.exec(part);
      if (path) return path[1];
      const abstract = /^unix:(?:.*,)?abstract=([^,]+)/.exec(part);
      if (abstract) return '\0' + abstract[1];
    }
    return null;
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime ? `${runtime}/bus` : null;
};

class Bus {
  constructor(socket) {
    this.socket = socket;
    this.rest = Buffer.alloc(0);
    this.pending = new Map();                      // serial -> callback
    this.objects = new Map();                      // path -> { iface -> handlers }
    this.signalHandlers = [];
    this.name = null;

    socket.on('data', chunk => this.onData(chunk));
    socket.on('error', () => {});
  }

  /*
   * EXTERNAL is the mechanism a session bus grants to the user that owns it, and
   * the credentials travel with the socket rather than in the exchange -- the
   * uid written out here is only what the client claims to be. The leading NUL
   * is not part of any command; the protocol wants one byte on the wire before
   * the first word.
   */
  static connect(cb) {
    const path = sessionAddress();
    if (!path) { cb(new Error('no session bus address')); return; }

    let settled = false;
    const done = (err, bus) => { if (!settled) { settled = true; cb(err, bus); } };

    const socket = net.createConnection(path);
    socket.once('error', err => done(err));
    socket.once('connect', () => {
      const uid = Buffer.from(String(os.userInfo().uid), 'utf8').toString('hex');
      let greeting = '';

      const onGreeting = chunk => {
        greeting += chunk.toString('utf8');
        if (!greeting.includes('\r\n')) return;
        socket.removeListener('data', onGreeting);
        if (!/^OK /.test(greeting)) { done(new Error(`dbus: auth refused (${greeting.trim()})`)); return; }
        socket.write('BEGIN\r\n');

        const bus = new Bus(socket);
        bus.call({
          destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus', member: 'Hello',
        }, (err, body) => {
          if (err) { done(err); return; }
          bus.name = body[0];
          done(null, bus);
        });
      };

      socket.on('data', onGreeting);
      socket.write('\0AUTH EXTERNAL ' + uid + '\r\n');
    });
  }

  onData(chunk) {
    this.rest = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    for (;;) {
      let framed = null;
      try { framed = decode(this.rest); } catch (e) { this.rest = Buffer.alloc(0); return; }
      if (!framed) return;
      const [msg, used] = framed;
      this.rest = this.rest.slice(used);
      try { this.dispatch(msg); } catch (e) { /* one bad message is not the bus */ }
    }
  }

  dispatch(msg) {
    if (msg.type === TYPE.METHOD_RETURN || msg.type === TYPE.ERROR) {
      const cb = this.pending.get(msg.replySerial);
      if (!cb) return;
      this.pending.delete(msg.replySerial);
      if (msg.type === TYPE.ERROR) cb(new Error(msg.errorName || 'dbus error'), msg.body);
      else cb(null, msg.body);
      return;
    }

    if (msg.type === TYPE.SIGNAL) {
      for (const h of this.signalHandlers) h(msg);
      return;
    }

    if (msg.type === TYPE.METHOD_CALL) this.serve(msg);
  }

  /* An exported object answers, and anything it does not know about gets the
     error the spec asks for rather than silence -- a caller left waiting is
     worse than a caller told no. */
  serve(msg) {
    const reply = (signature, body) => {
      if (msg.flags & NO_REPLY_EXPECTED) return;
      this.send({
        type: TYPE.METHOD_RETURN, replySerial: msg.serial,
        destination: msg.sender, signature, body,
      });
    };
    const fail = (name, text) => {
      if (msg.flags & NO_REPLY_EXPECTED) return;
      this.send({
        type: TYPE.ERROR, replySerial: msg.serial, destination: msg.sender,
        errorName: name, signature: 's', body: [text],
      });
    };

    const object = this.objects.get(msg.path);
    const iface = object && object[msg.interface];
    const handler = iface && iface[msg.member];
    if (!handler) {
      fail('org.freedesktop.DBus.Error.UnknownMethod',
        `no ${msg.interface}.${msg.member} at ${msg.path}`);
      return;
    }
    try {
      handler(msg.body || [], reply, fail, msg);
    } catch (e) {
      fail('org.freedesktop.DBus.Error.Failed', e.message);
    }
  }

  send(msg) {
    const serial = nextSerial++;
    this.socket.write(encode(Object.assign({ serial }, msg)));
    return serial;
  }

  call(msg, cb) {
    const serial = nextSerial++;
    if (cb) this.pending.set(serial, cb);
    this.socket.write(encode(Object.assign({ type: TYPE.METHOD_CALL, serial }, msg)));
    return serial;
  }

  signal(msg) {
    this.send(Object.assign({ type: TYPE.SIGNAL }, msg));
  }

  export(path, interfaces) {
    const at = this.objects.get(path) || {};
    Object.assign(at, interfaces);
    this.objects.set(path, at);
  }

  onSignal(handler) { this.signalHandlers.push(handler); }

  addMatch(rule, cb) {
    this.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: 'AddMatch',
      signature: 's', body: [rule],
    }, cb || (() => {}));
  }

  requestName(name, cb) {
    /* 4 is DBUS_NAME_FLAG_DO_NOT_QUEUE: a second copy of this client should
       fail here rather than wait for the first one to exit. */
    this.call({
      destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus',
      interface: 'org.freedesktop.DBus', member: 'RequestName',
      signature: 'su', body: [name, 4],
    }, cb);
  }

  close() {
    try { this.socket.destroy(); } catch (e) {}
  }
}

module.exports = { Bus, TYPE, marshalBody, splitTypes, oneType };
