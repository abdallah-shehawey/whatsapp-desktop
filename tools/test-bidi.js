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
const wording = require('../src/wording.js');

const RLM = '\u200f';
const LRM = '\u200e';
const FSI = '\u2068';
const PDI = '\u2069';
/* The line break a banner is actually written with. GNOME Shell turns a newline
   into a space before Pango sees it -- see BREAK in src/bidi.js -- so a test
   that spelled these with "\n" was testing something no notification daemon
   would ever be handed. */
const PS = '\u2029';

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  const show = text => JSON.stringify(text)
    .replace(/\\u200f/g, '<RLM>').replace(/\\u200e/g, '<LRM>')
    .replace(/\\u2068/g, '<FSI>').replace(/\\u2069/g, '<PDI>')
    .replace(/\\u2029/g, '<PS>\n         ');
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
   decide which way the message runs, and the message must not decide where the
   name is printed either. The line is stated left to right so the name stays on
   the left, and the message is isolated so that costs it nothing -- inside its
   own isolate it still runs right to left, and an English word inside an Arabic
   sentence stays where the sentence puts it. */
check('an Arabic message shares the line, inside an isolate of its own',
      bidi.line('Salah', 'بالنسبه للخريجين'),
      LRM + FSI + 'Salah' + PDI + ': ' + FSI + 'بالنسبه للخريجين' + PDI);

check('and an English message under the same name is shaped the same way',
      bidi.line('Salah', 'see you tomorrow'),
      LRM + FSI + 'Salah' + PDI + ': ' + FSI + 'see you tomorrow' + PDI);

/* And an Arabic name is not a reason to put it anywhere else: "دايما الاسم علي
   الشمال سواء كان الاسم عربي او انجليزي". The LRM is what holds it there -- the
   name's own letters would otherwise take the line right to left with them. */
check('an Arabic name is pinned to the left the same way',
      bidi.line('صلاح', 'تمام يا معلم'),
      LRM + FSI + 'صلاح' + PDI + ': ' + FSI + 'تمام يا معلم' + PDI);

/* A direct chat has no sender to print, and the message stands on its own. */
check('a direct message carries the mark and nothing else',
      bidi.line('', 'يعم خد راحتك'), RLM + 'يعم خد راحتك');
check('and an English one the other mark',
      bidi.line('', 'on my way'), LRM + 'on my way');

/* A message with no direction of its own falls back to the whole line, so a
   Latin name still lays the banner out the way it reads. */
check('a message with no direction of its own is isolated all the same',
      bidi.line('Ahmed', '👍'),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + '👍' + PDI);

/* A mention is a thing, not a word, and it says nothing about which way the
   message around it runs -- rule P2 of the bidi algorithm, and what WhatsApp's
   own bubble does, since it draws a mention as its own element. The message
   below is Arabic that happens to OPEN with a Latin @name, and it turned round
   in the banner while the conversation drew it right to left. */
check('a mention at the head does not turn the message round',
      bidi.directionOf('@' + bidi.isolate('Abdallah Shehawey') +
                       ' هو انا لما اجي اكتب رساله عربي'), 'rtl');
check('and the same name loose in the text still decides, as it should',
      bidi.directionOf('Abdallah هو انا لما اجي اكتب رساله عربي'), 'ltr');
check('an isolate that is never closed swallows the rest of the line',
      bidi.directionOf(FSI + 'Abdallah'), null);
check('and one isolate does not close two',
      bidi.directionOf(FSI + FSI + 'Abdallah' + PDI + PDI + ' تمام'), 'rtl');
/* A PDI with nothing open in front of it is not an error and not a direction. */
check('a stray PDI is ignored', bidi.directionOf(PDI + 'تمام'), 'rtl');

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

/* A banner of several lines is several bidi paragraphs, so one mark at the head
   of it only ever settles the first line. Each line states its own direction --
   this is the same message that reads wrong in the conversation, an English
   headline over Arabic body copy. */
check('every line of a banner is marked, from its own first strong character',
      bidi.paragraph('We are hiring / IT\nتبحث سلسله مطاعم\nرواتب مجزيه'),
      LRM + 'We are hiring / IT' + PS + RLM + 'تبحث سلسله مطاعم' + PS + RLM + 'رواتب مجزيه');
/* A line with nothing strong in it is still left alone, line by line. */
check('a blank line between them is left as it is',
      bidi.paragraph('رواتب مجزيه\n\n01148813215'),
      RLM + 'رواتب مجزيه' + PS + PS + '01148813215');
/* Only the first line of a banner has a name in front of it, so only that line
   needs the direction stating for it. The lines under it are read the way any
   other line is -- this is the message from the report, an English headline
   over Arabic body copy, sent into a group by somebody with a Latin name. */
check('the name settles the line it is on, and no line under it',
      bidi.line('Mo farhat', 'We are hiring / IT\nتبحث سلسله مطاعم\nرواتب مجزيه'),
      LRM + FSI + 'Mo farhat' + PDI + ': ' + FSI + 'We are hiring / IT' + PDI + PS +
      RLM + 'تبحث سلسله مطاعم' + PS + RLM + 'رواتب مجزيه');
check('and an Arabic message under the same name keeps every line of it Arabic',
      bidi.line('Mo farhat', 'تبحث سلسله مطاعم\nرواتب مجزيه'),
      LRM + FSI + 'Mo farhat' + PDI + ': ' + FSI + 'تبحث سلسله مطاعم' + PDI + PS +
      RLM + 'رواتب مجزيه');
/* A first line with nothing strong in it must not decide for the message, so
   the whole message is read before the name is placed: this one goes under it,
   on the strength of a second line the first says nothing about. */
check('an opening emoji leans on nothing but its own isolate',
      bidi.line('Ahmed', '👍\nتمام يا معلم'),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + '👍' + PDI + PS + RLM + 'تمام يا معلم');

/* The report the isolate exists for: an English word inside an Arabic sentence.
   Flattened into the left-to-right line the name needs, "local" would be pulled
   out of the sentence and read as part of the line; inside the isolate the
   sentence keeps its own direction and the word keeps its place in it. */
check('an English word inside an Arabic message stays inside it',
      bidi.line('Salah', 'شكله مشغل الاجينت local'),
      LRM + FSI + 'Salah' + PDI + ': ' + FSI + 'شكله مشغل الاجينت local' + PDI);
check('and the isolated message is what decides its own direction',
      bidi.directionOf('شكله مشغل الاجينت local'), 'rtl');

/* ------------------------------------------------ the lines above a message */

/* A mark and a message, each on its own line. This is the shape that was asked
   for -- "you got a reply :" and then the message under it -- and it is the one
   the old newline could not deliver, because the shell replaced it with a space
   and ran the two together. */
check('a mark stands on its own line above the sender',
      bidi.stack(bidi.paragraph(wording.REPLY_MARK), bidi.line('Salah', 'تمام يا معلم')),
      LRM + 'You got a reply:' + PS +
      LRM + FSI + 'Salah' + PDI + ': ' + FSI + 'تمام يا معلم' + PDI);

/* Nothing is written for a part that is not there: an ordinary message must not
   open with a blank line where a mark would have gone. */
check('and a message with no mark does not open with a blank line',
      bidi.stack('', bidi.line('Ahmed', 'on my way')),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + 'on my way' + PDI);
check('a stack of nothing is nothing', bidi.stack('', null, undefined), '');

/* The one thing that must never leave this module. A newline in a banner is a
   space by the time Pango is handed it, and every mark this module writes would
   be stranded mid-sentence with it. */
for (const [label, body] of [
  ['a message of several lines', bidi.line('Mega', 'one\ntwo\nthree')],
  ['a mark above a sender', bidi.stack(bidi.paragraph(wording.MENTION_MARK),
                                       bidi.line('Mega', 'يا عبدالله'))],
  ['a paragraph on its own', bidi.paragraph('one\ntwo')],
]) check('no newline survives ' + label, /\n/.test(body), false);

/* A reaction is this client describing what somebody did, not quoting them, so
   the name carries no colon -- and it is pinned left the same way. */
check('a reaction names the person without claiming they said it',
      bidi.did('Mega', 'reacted \u{1F602} to: نتقابل بكرة'),
      LRM + FSI + 'Mega' + PDI + ' ' + FSI + 'reacted \u{1F602} to: نتقابل بكرة' + PDI);

/* Nothing may come back undefined or throw: a banner with no text is a banner
   nobody can read, and these are called in front of every one of them. */
check('nothing in, nothing out', bidi.line(null, null), '');
check('a name with no message still produces a line',
      bidi.line('Mega', ''), LRM + FSI + 'Mega' + PDI + ': ');

console.log(failures ? `\n${failures} failed` : '\nbidi checks pass');
process.exit(failures ? 1 : 0);
