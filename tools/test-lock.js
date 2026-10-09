/*
 * The passcode, and the thing a lock over the window alone would leave open.
 *
 * The window being covered is the easy half and the one everybody writes. The
 * half that matters as much is the banner: a client with a passcode on it that
 * still raises "Ahmed: see you at eight" on the desktop has handed over exactly
 * what the passcode was covering, to somebody who never touched the machine.
 * That check is at the bottom of this file and it is the reason it exists.
 *
 * Nothing here needs a window, a bus or an account -- the passcode is PBKDF2
 * over a file, and the redaction is one decision in src/notify.js.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Its own config directory, so running the tests never touches the one the
   client on this machine is using. The version this came from wrote a real
   accounts.json and a real config file into ~/.config on every `make test`. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-lock-'));
process.env.XDG_CONFIG_HOME = sandbox;

const { LockManager } = require('../src/lock.js');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

const fake = (values = {}) => ({
  d: { ...values },
  get(k) { return this.d[k]; },
  set(k, v) { this.d[k] = v; },
  save() {},
});

/* With no passcode set there is nothing to ask, and nothing may be in the way. */
const open = new LockManager(fake());
check('a client with no passcode is not locked', open.isLocked, false);
check('and it is not enabled on the strength of a config key alone',
      open.isEnabled(), false);
check('anything gets past a lock that was never set', open.verify('whatever'), true);

/* Setting one. */
const lock = new LockManager(fake());
check('a passcode shorter than four characters is refused', (() => {
  try { lock.setPasscode('12'); return 'accepted'; } catch (e) { return 'refused'; }
})(), 'refused');
lock.setPasscode('open sesame');
check('a passcode that was set is held', lock.hasPasscode(), true);
check('and the lock is on once there is one to check', lock.isEnabled(), true);

check('the wrong passcode does not get in', lock.verify('open sesam'), false);
check('the right one does', lock.verify('open sesame'), true);

/* What is on disk, which is the part worth being careful about. */
const onDisk = JSON.parse(fs.readFileSync(path.join(sandbox, 'whatsapp-desktop', 'security.json'), 'utf8'));
check('the passcode itself is not written anywhere',
      JSON.stringify(onDisk).includes('open sesame'), false);
check('what is written is a salt and a hash',
      [typeof onDisk.salt, typeof onDisk.hash], ['string', 'string']);
check('and the file is readable by nobody else',
      (fs.statSync(path.join(sandbox, 'whatsapp-desktop', 'security.json')).mode & 0o777).toString(8),
      '600');

/* Two clients, same passcode: the salt is what keeps one answer from reading
   across to another machine's file. Asked of the crypto directly, because the
   config directory is resolved once per process and a second LockManager in
   this one would write beside the first. */
const { deriveHash, generateSalt } = require('../src/lock/crypto.js');
const saltA = generateSalt();
const saltB = generateSalt();
check('two salts are not the same salt', saltA === saltB, false);
check('the same passcode under two salts does not hash the same',
      deriveHash('open sesame', saltA) === deriveHash('open sesame', saltB), false);
check('and the hash that is stored is what the right passcode derives to',
      deriveHash('open sesame', onDisk.salt), onDisk.hash);

/* Wrong answers, and the wait that follows enough of them. */
const guessed = new LockManager(fake());
guessed.setPasscode('1234');
for (let i = 0; i < 5; i++) guessed.verify('0000');
check('five wrong answers buy a wait', (() => {
  try { guessed.verify('1234'); return 'let in'; } catch (e) { return e.message; }
})().startsWith('Too many failed attempts'), true);

/* Taking it off again. */
const removing = new LockManager(fake());
removing.setPasscode('1234');
check('the passcode cannot be removed by someone who does not know it', (() => {
  try { removing.removePasscode('9999'); return 'removed'; } catch (e) { return 'refused'; }
})(), 'refused');
removing.removePasscode('1234');
check('and it can by someone who does', removing.hasPasscode(), false);

/*
 * The banner, which is the half this is really for.
 */
const notify = require.resolve('../src/notify.js');
delete require.cache[notify];
const Module = require('module');
const load = Module._load;
const raised = [];
const electron = {
  Notification: class {
    static isSupported() { return true; }
    constructor(options) { raised.push(options); }
    show() {}
    close() {}
    on() {}
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
};
let Banners;
try {
  Module._load = function (request, ...args) {
    return request === 'electron' ? electron : load.call(this, request, ...args);
  };
  ({ Banners } = require('../src/notify.js'));
} finally {
  Module._load = load;
}

let locked = false;
const banners = new Banners({ isLocked: () => locked });

banners.show({
  key: 'Ahmed', title: 'Ahmed', body: 'Ahmed: see you at eight',
  redacted: '\u{1F4AC} Message',
});
check('unlocked, a banner carries the message',
      raised[raised.length - 1].body, 'Ahmed: see you at eight');

locked = true;
banners.show({
  key: 'Ahmed', title: 'Ahmed', body: 'Ahmed: the password is hunter2',
  redacted: '\u{1F4AC} Message',
});
const covered = raised[raised.length - 1];
check('locked, it says a message arrived and not a word of it',
      covered.body, '\u{1F4AC} Message');
check('and the words are nowhere in what the desktop was handed',
      JSON.stringify(covered).includes('hunter2'), false);

locked = false;
banners.show({ key: 'Ahmed', title: 'Ahmed', body: 'readable again' });
check('unlocking lets the next one through again',
      raised[raised.length - 1].body, 'readable again');

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(failures ? `\n${failures} lock check(s) failed` : '\nlock checks pass');
process.exit(failures ? 1 : 0);
