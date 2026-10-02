/*
 * When the conversation is blurred, and when it is not.
 *
 * The blur itself is CSS and cannot be tested here. What can -- and what has
 * been wrong on somebody's screen -- is the decision in front of it: which of
 * the two switches is holding the screen covered, which one letting go
 * uncovers it, and whether a config file written before any of this existed
 * comes back blurring on every alt-tab.
 */
'use strict';

const { PrivacyManager, PRIVACY_CSS } = require('../src/privacy.js');

let failures = 0;
const check = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* The config, as much of it as this reads. */
const fake = values => ({
  data: { ...values },
  get(key) { return this.data[key]; },
  set(key, value) { this.data[key] = value; },
  save() {},
});

/* Left alone, nothing is covered. */
const plain = new PrivacyManager(fake({
  'privacy.stealth': false, 'privacy.auto-blur': false,
  'privacy.hover-reveal': true, 'privacy.blur-contacts': true,
}));
check('a window nobody has asked to cover is readable', plain.isBlurred(), false);
check('and it is wearing no classes at all', plain.getClasses(), []);

/* The key you press when somebody walks up. */
check('pressing it covers the screen', plain.toggleStealth(), true);
check('and the switch is written down, so a restart comes back covered',
      plain.config.get('privacy.stealth'), true);
check('pressing it again uncovers it', plain.toggleStealth(), false);

/* Focus, and the switch that acts on it. */
const off = new PrivacyManager(fake({ 'privacy.auto-blur': false }));
off.setWindowFocus(false);
check('with auto-blur off, losing the focus covers nothing', off.isBlurred(), false);

const on = new PrivacyManager(fake({ 'privacy.auto-blur': true }));
on.setWindowFocus(false);
check('with it on, losing the focus covers the screen', on.isBlurred(), true);
on.setWindowFocus(true);
check('and getting it back uncovers it', on.isBlurred(), false);

/* The two together: a manual press outlives the focus coming back, or the
   shortcut would be undone by the click that follows it. */
const both = new PrivacyManager(fake({ 'privacy.auto-blur': true }));
both.toggleStealth();
both.setWindowFocus(true);
check('a screen covered by hand stays covered when the focus returns',
      both.isBlurred(), true);

/* A config file from before any of these keys existed. */
const older = new PrivacyManager(fake({}));
check('an older config file does not come back blurring on every alt-tab',
      older.autoBlur, false);
check('but hover reveal and contact blurring, which default on, are on',
      [older.hoverReveal, older.blurContacts], [true, true]);

/* What the page is actually told to wear. */
const dressed = new PrivacyManager(fake({
  'privacy.stealth': true, 'privacy.hover-reveal': true, 'privacy.blur-contacts': true,
}));
check('a covered screen wears all three classes',
      dressed.getClasses().sort(),
      ['wa-privacy-active', 'wa-privacy-contacts', 'wa-privacy-hover']);

const narrow = new PrivacyManager(fake({
  'privacy.stealth': true, 'privacy.hover-reveal': false, 'privacy.blur-contacts': false,
}));
check('with the two extras off, only the blur itself is asked for',
      narrow.getClasses(), ['wa-privacy-active']);

/* The script that carries them, which runs in WhatsApp's own page. */
const script = dressed.getInjectScript();
check('the script takes the old classes off before putting new ones on',
      script.includes('classList.remove'), true);
check('and nothing in the sheet applies without one of them',
      PRIVACY_CSS.includes('body.wa-privacy-active'), true);

console.log(failures ? `\n${failures} privacy check(s) failed` : '\nprivacy checks pass');
process.exit(failures ? 1 : 0);
