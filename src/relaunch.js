'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/* The AppImage runtime unmounts its temporary tree when this process exits.
 * Restart through the image itself so the next copy gets a fresh mount. */
const options = (asked, env, executable, imageExecutable = true) => {
  const bundled = env.APPIMAGE && env.APPDIR &&
    executable.startsWith(path.resolve(env.APPDIR) + path.sep);
  /* Firejail can mount an image without permission to execute the image file.
   * Its AppDir remains mounted for the sandbox's lifetime, so use AppRun there. */
  return bundled ? { ...asked, execPath: imageExecutable ? env.APPIMAGE :
    path.join(env.APPDIR, 'AppRun') } : asked;
};

const relaunch = (app, asked) => {
  let imageExecutable = false;
  try {
    fs.accessSync(process.env.APPIMAGE, fs.constants.X_OK);
    imageExecutable = true;
  } catch (err) { /* A sandbox may mount a non-executable image. */ }
  const resolved = options(asked, process.env, process.execPath, imageExecutable);
  if (resolved === asked) {
    app.relaunch(asked);
    return;
  }
  /* Electron's own relaunch helper also lives in the mount that is leaving.
   * Use the host shell to wait for this process and then execute the image;
   * pass paths and arguments as argv, without inserting them into shell code. */
  const waiter = spawn('/bin/sh', [
    '-c', 'while kill -0 "$1" 2>/dev/null; do ' +
      'read -r stat < "/proc/$1/stat" || break; ' +
      'case "${stat##*) }" in Z*|X*) break;; esac; ' +
      '/bin/sleep 0.1; done; shift; exec "$@"',
    'whatsapp-relaunch', String(process.pid), resolved.execPath,
    ...(asked?.args || process.argv.slice(1)),
  ], { detached: true, stdio: 'inherit', env: process.env });
  waiter.on('error', err => console.error('could not restart the AppImage: %s', err.message));
  waiter.unref();
};

module.exports = { options, relaunch };
