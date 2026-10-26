/*
 * The desktop watcher must not outlive the client. `gsettings monitor` holds
 * every descriptor Chromium left open, so a monitor left behind keeps the GPU
 * process and the network service of a client that is gone running with it.
 * Run the real watcher in a node process, end that process the hardest way
 * there is, and look in /proc for anything it left: no Electron, desktop or
 * account needed -- only /proc and a gsettings to run.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log('  ok   ' + label);
    return;
  }
  failures++;
  console.log('  FAIL ' + label + '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

const haveGsettings = (() => {
  try { execFileSync('gsettings', ['--version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
})();
if (!haveGsettings || !fs.existsSync('/proc/self/stat')) {
  console.log('  skip no gsettings or no /proc here\n\ndesktop checks pass');
  process.exit(0);
}

/* Every process descended from `root`, read from /proc. */
const descendants = root => {
  const parents = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch (e) { /* gone in between */ }
  }
  const found = [];
  const walk = pid => {
    for (const [child, parent] of parents) {
      if (parent === pid) { found.push(child); walk(child); }
    }
  };
  walk(root);
  return found;
};
const alive = pid => {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !/^[ZX]$/.test(stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3));
  } catch (e) { return false; }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const settle = async (pids, ms = 3000) => {
  for (const until = Date.now() + ms; Date.now() < until && pids.some(alive);) await sleep(50);
  return pids.filter(alive);
};

const desktop = path.join(__dirname, '../src/desktop.js');
const client = code => spawn(process.execPath, ['-e',
  `const stop = require(${JSON.stringify(desktop)}).watch(['font-name'], () => {});\n${code}\n` +
  'setInterval(() => {}, 1000);'], { stdio: 'ignore' });

(async () => {
  {
    const node = client('');
    await sleep(700);
    const watcher = descendants(node.pid);
    check('the watcher starts a monitor under the client', watcher.length > 0, true);
    node.kill('SIGKILL');
    check('a client killed outright leaves nothing of the watcher running', await settle(watcher), []);
  }
  {
    const node = client('setTimeout(stop, 300);');
    await sleep(150);
    const watcher = descendants(node.pid);
    check('stopping the watcher ends the monitor while the client runs',
          await settle(watcher), []);
    check('and the client is still running', alive(node.pid), true);
    node.kill('SIGKILL');
  }
  console.log(failures ? `\n${failures} desktop check(s) failed` : '\ndesktop checks pass');
  process.exitCode = failures ? 1 : 0;
})();
