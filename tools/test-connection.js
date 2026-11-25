/* Exercise failed navigation, background recovery and the boot watch without
 * an account, Chromium, network access, or real timers. */
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
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  const contents = new EventEmitter();
  const ipcMain = new EventEmitter();
  let current = local;
  let destroyed = false;
  let probe = async () => false;
  let clock = 1000;
  const probes = [];
  const calls = [];
  const throttling = [];
  Object.assign(contents, {
    getURL: () => current,
    isDestroyed: () => destroyed,
    send: (channel, value) => calls.push(['send', channel, value]),
    setBackgroundThrottling: enabled => throttling.push(enabled),
  });
  const win = {
    webContents: contents,
    isDestroyed: () => destroyed,
    loadFile: (target, options) => {
      calls.push(['local', target, options]); current = local; return Promise.resolve();
    },
    loadURL: target => { calls.push(['remote', target]); current = target; return Promise.resolve(); },
  };
  const controller = module.exports.attach(win, {
    url: remote, file, ipcMain, now: () => clock,
    probe: (signal, target) => { probes.push(target); return probe(signal, target); },
  });
  return {
    controller, calls, timers, contents, ipcMain, throttling, probes,
    setProbe: value => { probe = value; },
    advance: ms => { clock += ms; },
    remotes: () => calls.filter(call => call[0] === 'remote').length,
    locals: () => calls.filter(call => call[0] === 'local').length,
    delays: () => [...timers.values()].map(timer => timer.ms),
    fail: (code = -106, mainFrame = true, url = remote) => contents.emit('did-fail-load', {}, code, 'offline', url, mainFrame),
    retry: (sender = contents, url = local) => ipcMain.emit('wa:connection-retry', { sender, senderFrame: { url } }),
    navigate: url => { current = url; contents.emit('did-navigate', {}, url); },
    stopLoading: () => contents.emit('did-stop-loading', {}),
    lose: (details = {}) => controller.resourceFailed({
      url: 'https://static.whatsapp.net/rsrc.php/a.js', resourceType: 'script',
      error: 'net::ERR_NETWORK_CHANGED', ...details,
    }),
    destroy: () => { destroyed = true; contents.emit('destroyed'); },
    tick: async () => {
      const next = timers.entries().next().value;
      if (next) { timers.delete(next[0]); await next[1].fn(); }
    },
  };
};

(async () => {
  {
    const t = build();
    await t.controller.start();
    check('startup goes straight to WhatsApp, with no page of its own in front', () => {
      assert.deepStrictEqual(t.calls.map(call => call[0]), ['remote']);
    });
    t.fail(-3); t.fail(-106, false); t.fail(-106, true, 'https://other.example/');
    check('aborts, subframe failures and other origins do not replace the page', () => assert.strictEqual(t.calls.length, 1));
    t.fail();
    check('a failed main navigation shows the connection page and schedules recovery', () => {
      assert.strictEqual(t.controller.isLocal(), true); assert.strictEqual(t.timers.size, 1);
      assert.deepStrictEqual(t.throttling, [true], 'the offline page can paint after failed navigation');
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
      assert.deepStrictEqual(t.delays(), [30000], 'no retry left, only the new document\'s boot window');
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
  {
    const t = build();
    t.fail();
    check('Chromium\'s error page after a failure is not WhatsApp', () => {
      assert.strictEqual(t.controller.isWhatsApp(), false);
    });
    t.navigate(local);
    check('the connection page is not WhatsApp either', () => assert.strictEqual(t.controller.isWhatsApp(), false));
    t.navigate(remote + 'login/');
    check('a committed WhatsApp document is', () => assert.strictEqual(t.controller.isWhatsApp(), true));
    t.destroy();
  }
  {
    const t = build();
    t.fail();
    t.navigate(local);
    t.stopLoading();
    check('a connection page that committed is left alone when loading stops', () => assert.strictEqual(t.locals(), 1));
    t.fail();
    t.stopLoading(); t.stopLoading(); t.stopLoading();
    check('a connection page the error page outlasted is asked for again, twice at most', () => {
      assert.strictEqual(t.locals(), 4);
    });
    t.destroy();
  }
  {
    const t = build();
    t.fail();
    check('the offline page checks again every two seconds', () => assert.deepStrictEqual(t.delays(), [2000]));
    let count = 0;
    t.setProbe(async () => { count++; return false; });
    t.controller.retryNow();
    await flush();
    check('a wake or an open checks at once, without waiting for the timer', () => assert.strictEqual(count, 1));
    t.destroy();
  }
  {
    const t = build();
    t.navigate(remote);
    t.lose({ error: 'net::ERR_BLOCKED_BY_CLIENT' });
    t.lose({ url: 'https://static.xx.fbcdn.net/a.js' });
    t.lose({ resourceType: 'image' });
    t.lose({ error: 'net::ERR_ABORTED' });
    check('only WhatsApp\'s own scripts and sheets lost to the network count', () => {
      assert.strictEqual(t.timers.size, 1, 'just the boot window');
    });
    t.lose();
    check('a lost script waits out WhatsApp\'s own retries, two seconds', () => {
      assert.ok(t.delays().includes(2000));
    });
    t.advance(2000);
    t.setProbe(async () => false);
    const rescueTick = async () => {
      const entry = [...t.timers.entries()].find(([, timer]) => timer.ms !== 30000);
      t.timers.delete(entry[0]);
      await entry[1].fn();
    };
    await rescueTick();
    check('it checks the very request that failed, not the front page', () => {
      assert.deepStrictEqual(t.probes, ['https://static.whatsapp.net/rsrc.php/a.js']);
      assert.strictEqual(t.remotes(), 0);
    });
    check('and while that does not answer, checks it again every two seconds', () => {
      assert.ok(t.delays().includes(2000));
    });
    t.setProbe(async () => true);
    t.advance(2000);
    await rescueTick();
    check('the moment it answers, WhatsApp is loaded again', () => assert.strictEqual(t.remotes(), 1));
    t.navigate(remote);
    t.lose();
    check('a second loss in a row waits four seconds before reloading', () => {
      assert.ok(t.delays().includes(4000));
    });
    t.advance(1000);
    t.controller.retryNow();
    await flush();
    await rescueTick();
    check('and an early nudge does not jump that gap', () => assert.strictEqual(t.remotes(), 1));
    t.destroy();
  }
  {
    const t = build();
    t.navigate(remote);
    t.lose();
    t.lose({ url: 'https://static.whatsapp.net/rsrc.php/b.css', resourceType: 'stylesheet' });
    t.controller.resourceLoaded({ url: 'https://static.whatsapp.net/rsrc.php/a.js' });
    check('one lost file fetched again is not enough while another is missing', () => {
      assert.strictEqual(t.timers.size, 2);
    });
    t.controller.resourceLoaded({ url: 'https://static.whatsapp.net/rsrc.php/b.css' });
    check('WhatsApp fetching everything it lost by itself calls the reload off', () => {
      assert.strictEqual(t.timers.size, 1, 'just the boot window');
      assert.strictEqual(t.remotes(), 0);
    });
    t.lose();
    t.controller.ready();
    check('so does WhatsApp\'s store saying it is up', () => {
      assert.strictEqual(t.timers.size, 0);
      assert.strictEqual(t.remotes(), 0);
    });
    t.lose();
    check('and a WhatsApp that is up is not watched any more', () => assert.strictEqual(t.timers.size, 0));
    t.destroy();
  }
  {
    const t = build();
    t.navigate(remote);
    await t.tick();
    t.lose();
    check('nothing lost after the boot window counts: WhatsApp handles its own later fetches', () => {
      assert.strictEqual(t.timers.size, 0);
    });
    t.navigate(remote);
    t.lose();
    t.fail();
    check('a failed load hands over to the connection page and drops the boot watch', () => {
      assert.deepStrictEqual(t.delays(), [2000]);
      assert.strictEqual(t.controller.isLocal(), true);
    });
    t.destroy();
    check('closing leaves no timers', () => assert.strictEqual(t.timers.size, 0));
  }
  console.log('\nconnection checks pass');
})().catch(err => { console.error(err); process.exitCode = 1; });
