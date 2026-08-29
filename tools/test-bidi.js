/*
 * The direction a banner reads in.
 *
 * A notification is one paragraph handed to a daemon that lays it out with
 * Pango, and Pango takes the paragraph's direction from its first strong
 * character. "Salah: <arabic>" therefore reads left to right, and an Arabic
 * sentence in a left-to-right paragraph wraps with its first line against the
 * right margin and every line after it against the left -- which is the report
 * this module exists to answer.
 *
 * Nothing here needs Electron or a desktop: it is text in and text out.
 */
'use strict';

const bidi = require('../src/bidi.js');

const RLM = '‏';
const LRM = '‎';
const FSI = '⁨';
const PDI = '⁩';

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  const show = text => JSON.stringify(text)
    .replace(/\\u200f/g, '<RLM>').replace(/\\u200e/g, '<LRM>')
    .replace(/\\u2068/g, '<FSI>').replace(/\\u2069/g, '<PDI>');
  console.log('  FAIL ' + label + '\n         got  ' + show(got) +
              '\n         want ' + show(want));
};

console.log('driving src/bidi.js\n');

check('an Arabic message is right to left', bidi.directionOf('بالنسبه للخريجين'), 'rtl');
check('an English one is left to right', bidi.directionOf('see you tomorrow'), 'ltr');
/* Neutral text has no direction to state, and stating one for it would put an
   invisible character in front of a banner that reads "👍" for no gain. */
check('digits and emoji have no direction of their own', bidi.directionOf('12 👍 :)'), null);
check('and neither has nothing at all', bidi.directionOf(''), null);

/* The heart of it: a Latin display name in front of an Arabic message must not
   decide which way the message runs. Most of the people this client is used with
   have Latin display names and write in Arabic. */
check('an Arabic message keeps its direction under a Latin name',
      bidi.line('Salah', 'بالنسبه للخريجين'),
      RLM + FSI + 'Salah' + PDI + ': ' + 'بالنسبه للخريجين');

check('and an English message under the same name reads the other way',
      bidi.line('Salah', 'see you tomorrow'),
      LRM + FSI + 'Salah' + PDI + ': ' + 'see you tomorrow');

check('an Arabic name in front of an Arabic message is the same shape',
      bidi.line('صلاح', 'تمام يا معلم'),
      RLM + FSI + 'صلاح' + PDI + ': ' + 'تمام يا معلم');

/* A direct chat has no sender to print, and the message stands on its own. */
check('a direct message carries the mark and nothing else',
      bidi.line('', 'يعم خد راحتك'), RLM + 'يعم خد راحتك');
check('and an English one the other mark',
      bidi.line('', 'on my way'), LRM + 'on my way');

/* A message with no direction of its own falls back to the whole line, so a
   Latin name still lays the banner out the way it reads. */
check('a message with no direction takes the line it is on',
      bidi.line('Ahmed', '👍'), LRM + FSI + 'Ahmed' + PDI + ': ' + '👍');

/* The chat name on the title line gets the same treatment on its own. */
check('an Arabic chat name is marked right to left',
      bidi.paragraph('خريجين قسم الهندسة'), RLM + 'خريجين قسم الهندسة');
check('a Latin one left to right',
      bidi.paragraph('4th ECE Alazhar University'), LRM + '4th ECE Alazhar University');
/* A phone number has no strong character in it, so there is no direction to
   state and no mark is added: an invisible character in a title the user may
   well copy out is a cost with nothing on the other side of it. */
check('and one made of digits is left exactly as it is',
      bidi.paragraph('+20 10 03734117'), '+20 10 03734117');

/* Nothing may come back undefined or throw: a banner with no text is a banner
   nobody can read, and these are called in front of every one of them. */
check('nothing in, nothing out', bidi.line(null, null), '');
check('a name with no message still produces a line',
      bidi.line('Mega', ''), LRM + FSI + 'Mega' + PDI + ': ');

console.log(failures ? `\n${failures} failed` : '\nbidi checks pass');
process.exit(failures ? 1 : 0);