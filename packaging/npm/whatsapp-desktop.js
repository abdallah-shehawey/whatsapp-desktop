#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const args = process.argv.slice(2);
if (args.includes('--version') || args.includes('-v')) {
  console.log(`whatsapp-desktop ${require('../package.json').version}`);
  process.exit(0);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: whatsapp-desktop [options] [whatsapp://URL]\n\nOptions:\n  --hidden        Start minimized to the system tray\n  -v, --version   Show version number\n  -h, --help      Show this help message');
  process.exit(0);
}
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const fonts = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'whatsapp-desktop/fonts.conf');
if (fs.existsSync(fonts)) env.FONTCONFIG_FILE = fonts;
const child = spawn(require('electron'), [path.resolve(__dirname, '..'), '--class=io.github.shehawey.whatsapp-desktop', '--name=whatsapp-desktop', ...args], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
