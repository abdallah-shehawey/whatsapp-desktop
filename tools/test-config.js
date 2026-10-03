/*
 * Whether a setting that was changed is still changed after a restart.
 *
 * The config file is written key by key, by hand, in save() -- which is what
 * makes it readable and what makes this test necessary. A key added to DEFAULTS
 * and not added to save() behaves perfectly until the client is closed: the
 * switch moves, the change takes effect, and the next launch has forgotten it.
 * Worse, the forgetting is not even tied to quitting. save() runs whenever the
 * window is resized, so a key read but never written is erased by dragging a
 * corner.
 *
 * So this does not test a list of keys somebody remembered to add here. It
 * walks DEFAULTS, changes every single one to something else, saves, reads the
 * file back from disk with a fresh Config, and insists on getting back what it
 * wrote. A key that is ever added to DEFAULTS and forgotten in save() fails
 * here on the first run.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/* Its own directory: these tests never touch the config of the client
   installed on the machine running them. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-config-'));
process.env.XDG_CONFIG_HOME = sandbox;

const { Config, CONFIG_PATH, CUSTOM_CSS_PATH } = require('../src/config.js');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* Something different from whatever the default is, and still valid. */
const somethingElse = (key, current) => {
  if (typeof current === 'boolean') return !current;
  if (typeof current === 'number') return key === 'view.zoom' ? 1.25 : 42;
  if (key === 'view.theme') return 'nord';
  if (key === 'behaviour.raise') return 'activate';
  if (key === 'behaviour.spellcheck-languages') return 'en-GB,fr';
  if (key === 'shortcuts.toggle') return 'Super+Alt+K';
  if (key === 'shortcuts.mute-call') return 'Super+Alt+J';
  return current === '' ? 'something' : current;
};

const first = new Config();
const wrote = {};
for (const key of Object.keys(first.values)) {
  wrote[key] = somethingElse(key, first.get(key));
  first.set(key, wrote[key]);
}
first.save();

const keys = Object.keys(wrote);
check('the file is written where the client looks for it', fs.existsSync(CONFIG_PATH), true);

/* The whole point. */
const second = new Config();
const forgotten = keys.filter(k => JSON.stringify(second.get(k)) !== JSON.stringify(wrote[k]));
check(`all ${keys.length} settings survive a restart`,
      forgotten.length ? forgotten : [], []);

/* A file somebody has edited by hand, with a key the client does not know and
   a section that is not one of its own. Neither is a reason to lose the rest. */
fs.writeFileSync(CONFIG_PATH, [
  '[view]', 'theme = oled', 'font-size = 19',
  '[nonsense]', 'what = ever',
  '[behaviour]', 'close-to-tray = false',
  'a line with no equals sign',
  '# a comment', '; another one', '',
].join('\n'));
const edited = new Config();
check('a hand-edited file is read', [edited.get('view.theme'), edited.get('view.font-size')], ['oled', 19]);
check('a section the client does not know does not stop the one after it',
      edited.get('behaviour.close-to-tray'), false);
check('and a key that was not in the file keeps its default',
      edited.get('notifications.enabled'), true);

/* Types, because the file is text and everything in it arrives as a string. */
fs.writeFileSync(CONFIG_PATH, ['[view]', 'font-size = not-a-number', 'force-font = yes',
                               '[lock]', 'timeout = 5'].join('\n'));
const typed = new Config();
check('a number that is not a number falls back rather than poisoning the page',
      typed.get('view.font-size'), 16);
check('yes is true, the way an INI file means it', typed.get('view.force-font'), true);
check('and a number that is one is a number', typed.get('lock.timeout'), 5);

/* The stylesheet lives beside the config file, not somewhere else. */
check('custom.css is in the config directory',
      path.dirname(CUSTOM_CSS_PATH), path.dirname(CONFIG_PATH));

fs.rmSync(sandbox, { recursive: true, force: true });

console.log(failures ? `\n${failures} config check(s) failed` : '\nconfig checks pass');
process.exit(failures ? 1 : 0);
