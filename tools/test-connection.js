/* Exercise failed navigation and background recovery without an account,
 * Chromium, network access, or real timers. */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const source = fs.readFileSync(path.join(__dirname, '../src/connection.js'), 'utf8');
const remote = 'https://web.whatsapp.com/';
const file = '/app/connection.html';
const local = pathToFileURL(file).href;
const check = (label, run) => { run(); console.log('  ok   ' + label); };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const build = () => {
  const timers = new Map();
  let timerId = 0;
  const module = { exports: {} };
  vm.runInNewContext(source, {
    require, module, URL, AbortController,
    console: { warn() {} },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const contents = new EventEmitter();
  const ipcMain = new EventEmitter();
  let current = local;
  let destroyed = false;
  let probe = async () => false;
  const calls = [];
  Object.assign(contents, {
    getURL: () => current,
    isDestroyed: () => destroyed,
    send: (channel, value) => calls.push(['send', channel, value]),
  });
  const win = {
    webContents: contents,
    isDestroyed: () => destroyed,
    loadFile: (target, options) => {
      calls.push(['local', target, options]); current = local; return Promise.resolve();
    },
    loadURL: target => { calls.push(['remote', target]); current = target; return Promise.resolve(); },
  };
  const controller = module.exports.attach(win, { url: remote, file, ipcMain, probe: signal => probe(signal) });
  return {
    controller, calls, timers, contents, ipcMain,
    setProbe: value => { probe = value; },
    fail: (code = -106, mainFrame = true, url = remote) => contents.emit('did-fail-load', {}, code, 'offline', url, mainFrame),
    retry: (sender = contents, url = local) => ipcMain.emit('wa:connection-retry', { sender, senderFrame: { url } }),
    navigate: url => { current = url; contents.emit('did-navigate', {}, url); },
    destroy: () => { destroyed = true; contents.emit('destroyed'); },
    tick: async () => {
      const next = timers.entries().next().value;
      if (next) { timers.delete(next[0]); await next[1](); }
    },
  };
};

(async () => {
  {
    const t = build();
    await t.controller.start();
    check('startup paints a bundled page before loading WhatsApp', () => {
      assert.deepStrictEqual(t.calls.map(call => call[0]), ['local', 'remote']);
      assert.strictEqual(t.calls[0][2].query.connecting, '1');
    });
    t.fail(-3); t.fail(-106, false); t.fail(-106, true, 'https://other.example/');
    check('aborts, subframe failures and other origins do not replace the page', () => assert.strictEqual(t.calls.length, 2));
    t.fail();
    check('a failed main navigation shows the connection page and schedules recovery', () => {
      assert.strictEqual(t.controller.isLocal(), true); assert.strictEqual(t.timers.size, 1);
    });
    await t.tick();
    check('an unsuccessful background check keeps the local page visible', () => {
      assert.strictEqual(t.calls.filter(call => call[0] === 'remote').length, 1);
      assert.strictEqual(t.timers.size, 1);
    });
    t.setProbe(async () => { throw new Error('DNS failed'); });
    await t.tick();
    check('a rejected check is retried without an unhandled rejection', () => assert.strictEqual(t.timers.size, 1));
    t.setProbe(async () => true);
    await t.tick();
    check('recovery opens WhatsApp once and stops the retry loop', () => {
      assert.strictEqual(t.calls.filter(call => call[0] === 'remote').length, 2);
      assert.strictEqual(t.timers.size, 0);
    });
    t.fail();
    check('failure after a successful probe restores the connection page', () => assert.strictEqual(t.controller.isLocal(), true));
    t.destroy();
  }
  {
    const t = build();
    t.fail();
    let resolve;
    let count = 0;
    let signal;
    t.setProbe(value => { count++; signal = value; return new Promise(done => { resolve = done; }); });
    t.retry({}, local); t.retry(t.contents, remote);
    check('another window or a remote frame cannot request connection retries', () => assert.strictEqual(count, 0));
    t.retry(); t.retry();
    check('repeated retry clicks share one in-flight check', () => assert.strictEqual(count, 1));
    t.navigate(remote);
    resolve(true); await flush();
    check('navigation cancels a pending check and ignores its stale result', () => {
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(t.calls.filter(call => call[0] === 'remote').length, 0);
      assert.strictEqual(t.timers.size, 0);
    });
    t.fail(); t.retry();
    t.destroy(); resolve(true); await flush();
    check('closing cancels checks, removes IPC listeners, and leaves no timers', () => {
      assert.strictEqual(signal.aborted, true);
      assert.strictEqual(t.ipcMain.listenerCount('wa:connection-retry'), 0);
      assert.strictEqual(t.timers.size, 0);
      assert.strictEqual(t.calls.filter(call => call[0] === 'remote').length, 0);
    });
  }
  console.log('\nconnection checks pass');
})().catch(err => { console.error(err); process.exitCode = 1; });
