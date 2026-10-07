'use strict';
const path = require('path');
const { spawn } = require('child_process');

/* The AppImage runtime unmounts its temporary tree when this process exits.
 * Restart through the image itself so the next copy gets a fresh mount. */
const options = (asked, env, executable) => {
  const bundled = env.APPIMAGE && env.APPDIR &&
    executable.startsWith(path.resolve(env.APPDIR) + path.sep);
  return bundled ? { ...asked, execPath: env.APPIMAGE } : asked;
};

const relaunch = (app, asked) => {
  const resolved = options(asked, process.env, process.execPath);
  if (!resolved?.execPath || resolved.execPath !== process.env.APPIMAGE) {
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
