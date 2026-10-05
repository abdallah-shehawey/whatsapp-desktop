/*
 * The display backend must agree with the window-raising strategy. Electron
 * chooses Ozone before main.js runs, so changing a JavaScript boolean -- or
 * appending a switch too late -- cannot turn a Wayland window into an X11 one.
 * Run the real startup block without opening a window or using a real config.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const start = main.indexOf('/* -------------------------------------------------------------- switches */');
const end = main.indexOf('/* Scrolling.', start);
assert(start !== -1 && end > start, 'display startup block is present');
const startup = main.slice(start, end);

const run = ({ platform = 'wayland', forceX11 = false, args = [], env = {} } = {}) => {
  const switches = new Map([['ozone-platform', platform]]);
  const appended = [];
  const relaunched = [];
  const stopped = {};
  const context = {
    process: { argv: ['/electron', '/app', ...args], env },
    config: { get: key => key === 'system.force-x11' && forceX11 },
    console: { log() {} },
    app: {
      commandLine: {
        getSwitchValue: key => switches.get(key) || '',
        appendSwitch(key, value) { appended.push([key, value]); switches.set(key, value); },
      },
      relaunch(options) { relaunched.push(Array.from(options.args)); },
      exit(code) { assert.strictEqual(code, 0); throw stopped; },
    },
  };
  let result;
  try { result = vm.runInNewContext(startup + '\n({ onWayland, forceX11 });', context); }
  catch (error) { if (error !== stopped) throw error; }
  return { result, switches, appended, relaunched };
};

const originalArgs = ['--hidden', '--user-data-dir=/isolated/profile'];
const requested = run({ forceX11: true, args: originalArgs });
assert.deepStrictEqual(requested.relaunched,
  [['/app', ...originalArgs, '--ozone-platform=x11']],
  'a saved X11 preference reaches Electron at process launch and preserves other arguments');
assert.strictEqual(requested.result, undefined, 'the process with the wrong backend exits');
assert.deepStrictEqual(requested.appended, [], 'no switches are changed in the old Wayland process');

const restarted = run({ platform: 'x11', forceX11: true,
  args: [...originalArgs, '--ozone-platform=x11'] });
assert.deepStrictEqual(restarted.relaunched, [], 'the replacement process does not relaunch again');
assert.strictEqual(restarted.result.onWayland, false, 'an X11 window uses the X11 raising strategy');

const overridden = run({ platform: 'wayland', forceX11: true,
  args: ['--ozone-platform=wayland'], env: { XDG_SESSION_TYPE: 'x11' } });
assert.deepStrictEqual(overridden.relaunched, [], 'an explicit Wayland flag overrides the saved X11 preference');
assert.strictEqual(overridden.result.onWayland, true, 'explicit Wayland does not depend on session variables');
assert.strictEqual(overridden.result.forceX11, false);

const xwayland = run({ platform: 'x11', args: ['--ozone-platform=x11'],
  env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } });
assert.strictEqual(xwayland.result.onWayland, false, 'XWayland is recognized inside a Wayland session');
assert.strictEqual(xwayland.result.forceX11, true);
assert.deepStrictEqual(xwayland.relaunched, []);

const native = run();
assert.strictEqual(native.result.onWayland, true, 'the selected Wayland backend survives missing session variables');
assert.deepStrictEqual(native.relaunched, [], 'the default Wayland launch is left alone');
assert.strictEqual(native.switches.has('ozone-platform-hint'), false, 'the removed Ozone hint is not added');
assert.deepStrictEqual(native.switches.get('enable-features').split(','),
  ['MemoryPurgeOnFreezeLimit', 'WebRTCPipeWireCapturer', 'WaylandWindowDecorations'],
  'Wayland decorations and the existing Chromium features are kept together');

const x11 = run({ platform: 'x11', forceX11: true,
  env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } });
assert.deepStrictEqual(x11.relaunched, [], 'X11 already selected by Electron needs no restart');
assert.strictEqual(x11.result.onWayland, false);
assert.deepStrictEqual(x11.switches.get('enable-features').split(','),
  ['MemoryPurgeOnFreezeLimit', 'WebRTCPipeWireCapturer'],
  'X11 keeps memory and screen-sharing features without Wayland decorations');

console.log('display startup checks pass');
