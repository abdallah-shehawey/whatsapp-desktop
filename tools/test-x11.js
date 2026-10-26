/*
 * The one X request the client makes, against a fake X server: the setup and
 * its cookie, the wait for the window manager to have the window up, and the
 * resize sent only to a window that came up maximised. No display needed --
 * the server listens in the abstract namespace under a display number nothing
 * real uses.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { sizeToUnmaximiseTo, displayNumber, findCookie } = require('../src/x11.js');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* An Xauthority entry: family, then four fields behind big-endian lengths. */
const entry = (family, address, number, name, data) => {
  const field = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const head = Buffer.alloc(2);
  head.writeUInt16BE(family);
  return Buffer.concat([head, field(address), field(number), field(name), field(data)]);
};

check('":0" is display 0', displayNumber(':0'), '0');
check('":1.0" is display 1', displayNumber(':1.0'), '1');
check('"unix:2" is display 2', displayNumber('unix:2'), '2');
check('a display on another host is not one to connect to', displayNumber('box:0'), null);
check('nor is no display at all', displayNumber(undefined), null);

{
  const mine = Buffer.from('aaaaaaaaaaaaaaaa');
  const wild = Buffer.from('wwwwwwwwwwwwwwww');
  const file = Buffer.concat([
    entry(65535, '', '', 'MIT-MAGIC-COOKIE-1', wild),
    entry(256, 'elsewhere', '0', 'MIT-MAGIC-COOKIE-1', Buffer.from('eeeeeeeeeeeeeeee')),
    entry(256, 'here', '1', 'MIT-MAGIC-COOKIE-1', Buffer.from('1111111111111111')),
    entry(256, 'here', '0', 'XDM-AUTHORIZATION-1', Buffer.from('xxxxxxxx')),
    entry(256, 'here', '0', 'MIT-MAGIC-COOKIE-1', mine),
  ]);
  check('the cookie for this host and display wins over a wildcard',
        findCookie(file, '0', 'here').toString(), mine.toString());
  check('a wildcard answers for a display with nothing of its own',
        findCookie(file, '7', 'here').toString(), wild.toString());
  check('a file cut short is read as far as it goes',
        findCookie(file.subarray(0, file.length - 5), '0', 'here').toString(), wild.toString());
}

/*
 * The fake server. `script` answers what the window looks like on each poll:
 * an array of { mapped, maximised } consumed one per GetWindowAttributes, the
 * last one repeated.
 */
const NUMBER = '987';
const COOKIE = Buffer.from('0123456789abcdef');
const WINDOW = 0x400004;
const ATOMS = { _NET_WM_STATE: 300, _NET_WM_STATE_MAXIMIZED_VERT: 301, _NET_WM_STATE_MAXIMIZED_HORZ: 302 };

const serve = (script, { cookie = COOKIE } = {}) => new Promise(resolve => {
  const seen = { configures: [], polls: 0, setup: null };
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    let ready = false;
    let sequence = 0;
    const reply = (extra, fill) => {
      const out = Buffer.alloc(32 + extra.length);
      out[0] = 1;
      out.writeUInt16LE(sequence, 2);
      out.writeUInt32LE(extra.length / 4, 4);
      if (fill) fill(out);
      extra.copy(out, 32);
      socket.write(out);
    };
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!ready) {
        if (buffer.length < 12) return;
        const nameLength = buffer.readUInt16LE(6);
        const dataLength = buffer.readUInt16LE(8);
        const nameAt = 12;
        const dataAt = nameAt + nameLength + ((4 - (nameLength % 4)) % 4);
        const length = dataAt + dataLength + ((4 - (dataLength % 4)) % 4);
        if (buffer.length < length) return;
        seen.setup = { order: String.fromCharCode(buffer[0]), major: buffer.readUInt16LE(2),
                       name: buffer.subarray(nameAt, nameAt + nameLength).toString(),
                       data: buffer.subarray(dataAt, dataAt + dataLength).toString() };
        buffer = buffer.subarray(length);
        ready = true;
        if (seen.setup.data !== cookie.toString()) {
          const reason = Buffer.from('No protocol specified\n\0\0');
          const out = Buffer.alloc(8 + reason.length);
          out[0] = 0;
          out[1] = 22;
          out.writeUInt16LE(reason.length / 4, 6);
          reason.copy(out, 8);
          socket.end(out);
          return;
        }
        /* A setup reply with a body of its own, which the client must skip. */
        const out = Buffer.alloc(8 + 64);
        out[0] = 1;
        out.writeUInt16LE(11, 2);
        out.writeUInt16LE(16, 6);
        socket.write(out);
      }
      while (buffer.length >= 4) {
        const length = buffer.readUInt16LE(2) * 4;
        if (buffer.length < length) return;
        const request = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        sequence = (sequence + 1) & 0xffff;
        const opcode = request[0];
        if (opcode === 16) {
          const name = request.subarray(8, 8 + request.readUInt16LE(4)).toString();
          reply(Buffer.alloc(0), out => out.writeUInt32LE(ATOMS[name] || 0, 8));
        } else if (opcode === 3) {
          const now = script[Math.min(seen.polls++, script.length - 1)];
          reply(Buffer.alloc(12), out => { out[26] = now.mapped ? 2 : 0; });
        } else if (opcode === 20) {
          const now = script[Math.min(seen.polls - 1, script.length - 1)];
          const atoms = now.maximised ? [ATOMS._NET_WM_STATE_MAXIMIZED_VERT, ATOMS._NET_WM_STATE_MAXIMIZED_HORZ]
                                      : [999];
          const value = Buffer.alloc(atoms.length * 4);
          atoms.forEach((atom, i) => value.writeUInt32LE(atom, i * 4));
          reply(value, out => { out[1] = 32; out.writeUInt32LE(4, 8); out.writeUInt32LE(atoms.length, 16); });
        } else if (opcode === 12) {
          const window = request.readUInt32LE(4);
          seen.configures.push({ window, mask: request.readUInt16LE(8),
                                 size: [request.readUInt32LE(12), request.readUInt32LE(16)],
                                 afterPolls: seen.polls });
          if (window !== WINDOW) {
            const error = Buffer.alloc(32);
            error[0] = 0;
            error[1] = 3;
            error.writeUInt16LE(sequence, 2);
            error[10] = 12;
            socket.write(error);
          }
        } else if (opcode === 43) {
          reply(Buffer.alloc(0));
        }
      }
    });
  });
  server.listen(`\0/tmp/.X11-unix/X${NUMBER}`, () => resolve({ server, seen }));
});

const run = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-x11-'));
  const auth = path.join(dir, 'Xauthority');
  fs.writeFileSync(auth, entry(256, os.hostname(), NUMBER, 'MIT-MAGIC-COOKIE-1', COOKIE));
  process.env.XAUTHORITY = auth;
  const display = `:${NUMBER}`;
  const attempt = async (script, options = {}, xid = WINDOW) => {
    const { server, seen } = await serve(script, options);
    let result;
    try {
      result = await sizeToUnmaximiseTo(xid, 1600, 968, { display, within: 300, every: 10 });
    } catch (error) {
      result = 'error: ' + error.message;
    }
    await new Promise(resolve => server.close(resolve));
    return { result, seen };
  };

  {
    const { result, seen } = await attempt([{ mapped: false }, { mapped: false },
                                            { mapped: true, maximised: true }]);
    check('the setup is little-endian protocol 11 with the cookie for the display',
          seen.setup, { order: 'l', major: 11, name: 'MIT-MAGIC-COOKIE-1', data: COOKIE.toString() });
    check('a window that comes up maximised is told its own size', result, 'sent');
    check('and only once the server says it is up, never before',
          seen.configures, [{ window: WINDOW, mask: 0xc, size: [1600, 968], afterPolls: 3 }]);
  }
  {
    const { result, seen } = await attempt([{ mapped: true, maximised: false }]);
    check('a window that came up not maximised is left alone',
          [result, seen.configures.length], ['not maximised', 0]);
  }
  {
    const { result, seen } = await attempt([{ mapped: false }]);
    check('a window that never comes up is never resized',
          [result, seen.configures.length], ['not up', 0]);
  }
  {
    const { result } = await attempt([{ mapped: true, maximised: true }], {}, WINDOW + 1);
    check('an error for the resize is reported, not swallowed', /^error: X error 3/.test(result), true);
  }
  {
    const { result, seen } = await attempt([{ mapped: true, maximised: true }],
                                           { cookie: Buffer.from('fedcba9876543210') });
    check('a refused connection says why and sends nothing',
          [result, seen.configures.length],
          ['error: the X server refused the connection: No protocol specified', 0]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
};

run().then(() => {
  console.log(failures ? `\n${failures} x11 check(s) failed` : '\nx11 checks pass');
  process.exitCode = failures ? 1 : 0;
}, error => {
  console.log('x11 checks crashed: ' + error.stack);
  process.exitCode = 1;
});
