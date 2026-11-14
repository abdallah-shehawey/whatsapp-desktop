'use strict';

/* The global keys through the desktop portal -- see src/portal-keys.js.
   Replayed against a fake bus that answers the way xdg-desktop-portal does:
   a Request path at once, and the result later as that Request's Response. */

const assert = require('assert');
const { create, trigger, waylandSession } = require('../src/portal-keys.js');

const ok = (what, fn) => Promise.resolve().then(fn).then(() => console.log('  ok   %s', what));

const REQUEST = 'org.freedesktop.portal.Request';
const SHORTCUTS = 'org.freedesktop.portal.GlobalShortcuts';
const tick = () => new Promise(resolve => setImmediate(resolve));

/* A portal with `bound` already remembered for this app, and `answer` as what
   the user does with the dialog: 0 bind, 1 cancel. `missing` is a compositor
   with no GlobalShortcuts at all. */
const fakePortal = ({ bound = [], answer = 0, missing = false, version = 2 } = {}) => {
  const seen = [];
  const handlers = [];
  const remembered = new Set(bound);
  const bus = {
    name: ':1.42',
    closed: false,
    onSignal: h => handlers.push(h),
    addMatch: (rule, cb) => { seen.push({ member: 'AddMatch', rule }); cb(null); },
    close() { this.closed = true; },
    emit: msg => handlers.forEach(h => h(msg)),
    call(msg, cb) {
      seen.push(msg);
      const respond = (token, response, results) => {
        const path = `/org/freedesktop/portal/desktop/request/1_42/${token}`;
        cb(null, [path]);
        setImmediate(() => bus.emit({ interface: REQUEST, member: 'Response', path, body: [response, results] }));
      };
      const tokenIn = options => (options.find(([key]) => key === 'handle_token') || [])[1][1];
      switch (msg.member) {
        case 'Register': return cb(null, []);
        case 'Get':
          if (missing) return cb(new Error('org.freedesktop.DBus.Error.UnknownInterface'));
          return cb(null, [version]);
        case 'CreateSession': {
          const options = msg.body[0];
          const sessionToken = options.find(([key]) => key === 'session_handle_token')[1][1];
          return respond(tokenIn(options), 0,
            [['session_handle', `/org/freedesktop/portal/desktop/session/1_42/${sessionToken}`]]);
        }
        case 'ListShortcuts':
          return respond(tokenIn(msg.body[1]), 0,
            [['shortcuts', [...remembered].map(id => [id, [['trigger_description', 'Super+Alt+W']]])]]);
        case 'BindShortcuts': {
          const [, shortcuts, , options] = msg.body;
          if (answer === 0) shortcuts.forEach(([id]) => remembered.add(id));
          return respond(tokenIn(options), answer,
            answer === 0 ? [['shortcuts', shortcuts.map(([id]) => [id, []])]] : []);
        }
        case 'ConfigureShortcuts': return cb(null, []);
        case 'Close': return cb(null, []);
        default: return cb(new Error('unexpected ' + msg.member));
      }
    },
  };
  return { bus, seen, connect: cb => cb(null, bus) };
};

const keys = presses => [
  { id: 'toggle-window', description: 'Show WhatsApp', accelerator: 'Super+Alt+W', run: () => presses.push('toggle') },
  { id: 'mute-call', description: 'Mute', accelerator: 'Super+Alt+M', run: () => presses.push('mute') },
];

(async () => {
  await ok('Electron spells a key one way and the portal another', () => {
    assert.strictEqual(trigger('Super+Alt+W'), 'LOGO+ALT+w');
    assert.strictEqual(trigger('Ctrl+Shift+F5'), 'CTRL+SHIFT+F5');
    assert.strictEqual(trigger('CommandOrControl+Plus'), 'CTRL+plus');
    assert.strictEqual(trigger('Alt+PageDown'), 'ALT+Page_Down');
    assert.strictEqual(trigger('Super+Alt+,'), 'LOGO+ALT+comma');
  });

  await ok('and a key it cannot spell is sent without a suggestion, not guessed at', () => {
    assert.strictEqual(trigger('Hyper+W'), '');
    assert.strictEqual(trigger('Super+MediaPlayPause'), '');
    assert.strictEqual(trigger('Ctrl++'), '');
    assert.strictEqual(trigger(''), '');
  });

  await ok('a Wayland session is told apart from an X11 one, whatever draws the window', () => {
    assert.strictEqual(waylandSession({ XDG_SESSION_TYPE: 'wayland' }), true);
    assert.strictEqual(waylandSession({ WAYLAND_DISPLAY: 'wayland-0' }), true);
    assert.strictEqual(waylandSession({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false);
  });

  await ok('the first start asks the desktop, with the keys the config names', async () => {
    const fake = fakePortal();
    const client = create({ appId: 'io.github.shehawey.whatsapp-desktop', connect: fake.connect });
    const result = await client.bind(keys([]));
    assert.deepStrictEqual(result, { declined: false, bound: ['toggle-window', 'mute-call'] });
    assert.strictEqual(fake.seen[0].member, 'Register', 'the app id goes first, before any other portal call');
    assert.deepStrictEqual(fake.seen[0].body, ['io.github.shehawey.whatsapp-desktop', []]);
    const bind = fake.seen.find(m => m.member === 'BindShortcuts');
    assert.strictEqual(bind.signature, 'oa(sa{sv})sa{sv}');
    assert.deepStrictEqual(bind.body[1][0], ['toggle-window',
      [['description', ['s', 'Show WhatsApp']], ['preferred_trigger', ['s', 'LOGO+ALT+w']]]]);
  });

  await ok('every start binds again, into a session of its own', async () => {
    const fake = fakePortal({ bound: ['toggle-window', 'mute-call'] });
    const client = create({ connect: fake.connect });
    const result = await client.bind(keys([]));
    assert.deepStrictEqual(result.bound, ['toggle-window', 'mute-call']);
    assert.ok(!fake.seen.some(m => m.member === 'ListShortcuts'),
      'a new session lists nothing on GNOME, so it is not asked');
  });

  await ok('a press reaches the shortcut it was bound to, and nothing else', async () => {
    const fake = fakePortal({ bound: ['toggle-window', 'mute-call'] });
    const presses = [];
    const client = create({ connect: fake.connect });
    await client.bind(keys(presses));
    const session = fake.seen.find(m => m.member === 'BindShortcuts').body[0];
    fake.bus.emit({ interface: SHORTCUTS, member: 'Activated', body: [session, 'toggle-window', 0, []] });
    fake.bus.emit({ interface: SHORTCUTS, member: 'Activated', body: [session, 'mute-call', 0, []] });
    fake.bus.emit({ interface: SHORTCUTS, member: 'Activated', body: ['/some/other/session', 'toggle-window', 0, []] });
    fake.bus.emit({ interface: SHORTCUTS, member: 'Activated', body: [session, 'not-ours', 0, []] });
    assert.deepStrictEqual(presses, ['toggle', 'mute']);
  });

  await ok('turning the dialog down is said, not retried', async () => {
    const fake = fakePortal({ answer: 1 });
    const client = create({ connect: fake.connect });
    const result = await client.bind(keys([]));
    assert.deepStrictEqual(result, { declined: true, bound: [] });
  });

  await ok('a compositor without the portal is an error, so the caller grabs from X', async () => {
    const fake = fakePortal({ missing: true });
    const client = create({ connect: fake.connect });
    await assert.rejects(client.bind(keys([])), /UnknownInterface/);
    assert.ok(fake.bus.closed, 'the connection is not left open for nothing');
    await assert.rejects(client.bind(keys([])), /UnknownInterface/);
  });

  await ok('no session bus at all is the same error', async () => {
    const client = create({ connect: cb => cb(new Error('no session bus address')) });
    await assert.rejects(client.bind(keys([])), /no session bus/);
  });

  await ok('two binds in a row share one session', async () => {
    const fake = fakePortal();
    const client = create({ connect: fake.connect });
    await Promise.all([client.bind(keys([])), client.bind(keys([]))]);
    assert.strictEqual(fake.seen.filter(m => m.member === 'CreateSession').length, 1);
  });

  await ok('a key changed later opens the desktop\'s own dialog', async () => {
    const fake = fakePortal({ bound: ['toggle-window', 'mute-call'] });
    const client = create({ connect: fake.connect });
    await client.bind(keys([]));
    await client.configure();
    const configure = fake.seen.find(m => m.member === 'ConfigureShortcuts');
    assert.ok(configure, 'ConfigureShortcuts was called');
    assert.strictEqual(configure.signature, 'osa{sv}');
  });

  await ok('but not on a portal too old to have one', async () => {
    const fake = fakePortal({ bound: ['toggle-window', 'mute-call'], version: 1 });
    const client = create({ connect: fake.connect });
    await client.bind(keys([]));
    await client.configure();
    assert.ok(!fake.seen.some(m => m.member === 'ConfigureShortcuts'));
  });

  await ok('closing lets the keys go and stops the presses', async () => {
    const fake = fakePortal({ bound: ['toggle-window', 'mute-call'] });
    const presses = [];
    const client = create({ connect: fake.connect });
    await client.bind(keys(presses));
    const session = fake.seen.find(m => m.member === 'BindShortcuts').body[0];
    client.close();
    const close = fake.seen.find(m => m.member === 'Close');
    assert.strictEqual(close.path, session);
    assert.strictEqual(close.interface, 'org.freedesktop.portal.Session');
    fake.bus.emit({ interface: SHORTCUTS, member: 'Activated', body: [session, 'toggle-window', 0, []] });
    assert.deepStrictEqual(presses, []);
    await tick();
  });

  console.log('\nportal key checks pass');
})().catch(err => { console.error(err); process.exit(1); });
