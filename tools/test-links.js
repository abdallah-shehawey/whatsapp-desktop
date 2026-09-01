'use strict';

/*
 * What counts as a link to a chat, and -- more to the point -- what does not.
 * A false positive here means a link the owner clicked went to this client
 * instead of the page it was addressed to, and there is no way back from that
 * inside a window with no address bar.
 */

const assert = require('assert');
const links = require('../src/links.js');

const ok = [];
const check = (what, fn) => {
  try { fn(); ok.push(what); }
  catch (e) { console.error('  FAIL ' + what + '\n    ' + e.message); process.exitCode = 1; }
};

/* ------------------------------------------------- the scheme, as browsers send it */

check('the scheme handler, which is what "Open app" hands to the desktop', () => {
  assert.deepStrictEqual(links.from('whatsapp://send?phone=201501899476'),
                         { phone: '201501899476', text: '' });
});

check('a trailing slash after the verb, which some pages emit', () => {
  assert.deepStrictEqual(links.from('whatsapp://send/?phone=201501899476&text=hi'),
                         { phone: '201501899476', text: 'hi' });
});

check('the message that came with it, decoded', () => {
  assert.strictEqual(links.from('whatsapp://send?phone=201501899476&text=%D9%85%D8%B1%D8%AD%D8%A8%D8%A7').text,
                     'مرحبا');
});

check('a verb this client cannot perform is not answered', () => {
  assert.strictEqual(links.from('whatsapp://call?phone=201501899476'), null);
  assert.strictEqual(links.from('whatsapp://settings'), null);
});

/* --------------------------------------------------------------- the web links */

check('the "Chat on WhatsApp with …" page', () => {
  assert.deepStrictEqual(links.from('https://api.whatsapp.com/send?phone=201501899476&text=hi'),
                         { phone: '201501899476', text: 'hi' });
});

check('the short link people share, whose number is its path', () => {
  assert.deepStrictEqual(links.from('https://wa.me/201501899476?text=hi'),
                         { phone: '201501899476', text: 'hi' });
});

check("WhatsApp Web's own", () => {
  assert.deepStrictEqual(links.from('https://web.whatsapp.com/send?phone=201501899476'),
                         { phone: '201501899476', text: '' });
});

check('a number written the way a person writes one', () => {
  assert.strictEqual(links.from('https://wa.me/+20 150 189 9476').phone, '201501899476');
});

/* ------------------------------------------------------- and what is left alone */

check('a wa.me short code, which only WhatsApp can resolve, goes to a browser', () => {
  assert.strictEqual(links.from('https://wa.me/message/ABCDEFGHIJKLM1'), null);
});

check('a group invite is a decision, not a chat, and is left to its own page', () => {
  assert.strictEqual(links.from('https://chat.whatsapp.com/ABCDEFabcdef123456'), null);
});

check('the client itself is not a link to a chat', () => {
  assert.strictEqual(links.from('https://web.whatsapp.com/'), null);
});

check('somebody else entirely', () => {
  assert.strictEqual(links.from('https://example.com/send?phone=201501899476'), null);
  assert.strictEqual(links.from('mailto:someone@example.com'), null);
});

check('nothing, and rubbish, answer nothing rather than throwing', () => {
  assert.strictEqual(links.from(''), null);
  assert.strictEqual(links.from(null), null);
  assert.strictEqual(links.from('not a url at all'), null);
  assert.strictEqual(links.from('whatsapp://send?phone=12'), null);
});

/* --------------------------------------------------------------- the command line */

check('the link is found among the switches a launch carries', () => {
  const argv = ['/usr/lib/whatsapp-desktop/whatsapp-desktop', '--font-retry',
                'whatsapp://send?phone=201501899476'];
  assert.deepStrictEqual(links.inArgv(argv), { phone: '201501899476', text: '' });
});

check('an ordinary launch carries no link', () => {
  assert.strictEqual(links.inArgv(['/usr/lib/whatsapp-desktop/whatsapp-desktop', '--hidden']), null);
  assert.strictEqual(links.inArgv([]), null);
  assert.strictEqual(links.inArgv(undefined), null);
});

/* ------------------------------------------------------------------ the claim */

check('the scheme is not claimed when the owner has said not to', () => {
  const app = { isDefaultProtocolClient: () => { throw new Error('should not be asked'); } };
  assert.strictEqual(links.claim(app, 'io.github.shehawey.whatsapp-desktop', { enabled: false }),
                     'not asked for');
});

check('and a claim names the desktop file, which is where Electron reads it from', () => {
  const before = process.env.CHROME_DESKTOP;
  delete process.env.CHROME_DESKTOP;
  const app = { isDefaultProtocolClient: () => false, setAsDefaultProtocolClient: () => true };
  assert.strictEqual(links.claim(app, 'io.github.shehawey.whatsapp-desktop'), 'claimed');
  assert.strictEqual(process.env.CHROME_DESKTOP, 'io.github.shehawey.whatsapp-desktop.desktop');
  if (before === undefined) delete process.env.CHROME_DESKTOP;
  else process.env.CHROME_DESKTOP = before;
});

check('one that already holds the scheme does not ask again', () => {
  const app = {
    isDefaultProtocolClient: () => true,
    setAsDefaultProtocolClient: () => { throw new Error('should not be asked'); },
  };
  assert.strictEqual(links.claim(app, 'io.github.shehawey.whatsapp-desktop'), 'already ours');
});

for (const line of ok) console.log('  ok   ' + line);
if (!process.exitCode) console.log('\nlink checks pass');
