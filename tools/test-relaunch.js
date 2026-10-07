'use strict';
const assert = require('assert');
const { options } = require('../src/relaunch.js');
const check = (label, run) => { run(); console.log('  ok   ' + label); };
const args = ['--hidden', '--font-retry', '--ozone-platform=x11'];
const asked = { args };
const env = { APPIMAGE: '/home/user/My Apps/WhatsApp.AppImage', APPDIR: '/tmp/.mount_WhatsApp' };
check('a bundled runtime restarts through the AppImage with its arguments intact', () => {
  const result = options(asked, env, env.APPDIR + '/usr/lib/whatsapp-desktop/whatsapp-desktop');
  assert.strictEqual(result.execPath, env.APPIMAGE);
  assert.strictEqual(result.args, args);
});
check('a restart from Settings also remounts the AppImage', () => {
  assert.deepStrictEqual(options(undefined, env, env.APPDIR + '/usr/lib/whatsapp-desktop/whatsapp-desktop'), { execPath: env.APPIMAGE });
});
check('a non-executable image restarts within its persistent sandbox mount', () => {
  const sandbox = { APPIMAGE: '/work/BeingTested.AppImage', APPDIR: '/run/firejail/appimage' };
  const result = options(asked, sandbox, sandbox.APPDIR + '/usr/lib/whatsapp-desktop/whatsapp-desktop', false);
  assert.strictEqual(result.execPath, sandbox.APPDIR + '/AppRun');
  assert.strictEqual(result.args, args);
  assert.deepStrictEqual(options(undefined, sandbox, sandbox.APPDIR + '/usr/lib/whatsapp-desktop/whatsapp-desktop', false), { execPath: sandbox.APPDIR + '/AppRun' });
});
check('native installs retain Electron default restart behavior', () => {
  assert.strictEqual(options(asked, {}, '/usr/lib/whatsapp-desktop/whatsapp-desktop'), asked);
  assert.strictEqual(options(undefined, {}, '/usr/lib/whatsapp-desktop/whatsapp-desktop'), undefined);
});
check('AppImage variables inherited from a terminal do not restart its parent app', () => {
  assert.strictEqual(options(asked, env, '/usr/lib/whatsapp-desktop/whatsapp-desktop'), asked);
  assert.strictEqual(options(asked, env, '/tmp/.mount_WhatsApp-other/whatsapp-desktop'), asked);
});
check('an extracted AppDir without its image retains normal restart behavior', () => {
  assert.strictEqual(options(asked, { APPDIR: env.APPDIR }, env.APPDIR + '/usr/bin/whatsapp-desktop'), asked);
});
console.log('\nrelaunch checks pass');
