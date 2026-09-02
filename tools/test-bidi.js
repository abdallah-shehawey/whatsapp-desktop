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
 * One paragraph is meant literally, and half of what is checked below is that
 * nothing here ever writes a second one: the notification centre gives a
 * collapsed message a single line of body and offers the arrow that opens the
 * rest only when Pango cut something, so a banner broken into two paragraphs
 * shows the first and loses the message. See BREAKS in src/bidi.js.
 *
 * Nothing here needs Electron or a desktop: it is text in and text out.
 */
'use strict';

const bidi = require('../src/bidi.js');
const wording = require('../src/wording.js');

const RLM = '‏';
const LRM = '‎';
const FSI = '⁨';
const PDI = '⁩';

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  const show = text => JSON.stringify(text)
    .replace(/‏/g, '<RLM>').replace(/‎/g, '<LRM>')
    .replace(/⁨/g, '<FSI>').replace(/⁩/g, '<PDI>')
    .replace(/\u2029/g, '<PS>').replace(/\u2028/g, '<LS>');
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

/* ------------------------------------------------------------ one paragraph */

/* A message written on several lines arrives as one. The break is not dropped
   for tidiness: the shell's message list opens a collapsed notification only
   when Pango ellipsized it, a short first line is never ellipsized, and every
   line after the break is clipped out of a one-line allocation with no arrow
   left to reach it by. Run together, the whole message is in the one line the
   list will cut, and the arrow comes back with it. */
check('a message of several lines is run together into one paragraph',
      bidi.paragraph('We are hiring / IT\nتبحث سلسله مطاعم\nرواتب مجزيه'),
      LRM + 'We are hiring / IT تبحث سلسله مطاعم رواتب مجزيه');
/* A blank line is a break like any other and leaves no gap of its own. */
check('a blank line between them leaves one space and no more',
      bidi.paragraph('رواتب مجزيه\n\n01148813215'),
      RLM + 'رواتب مجزيه 01148813215');
check('the same message under a name is one isolate, not several lines',
      bidi.line('Mo farhat', 'We are hiring / IT\nتبحث سلسله مطاعم'),
      LRM + FSI + 'Mo farhat' + PDI + ': ' + FSI + 'We are hiring / IT تبحث سلسله مطاعم' + PDI);
/* And the separator this module used to write is flattened on the way in the
   same way a newline is, so text that has been through it once cannot come back
   carrying a break. */
check('the paragraph separator is flattened too, wherever it came from',
      bidi.line('Ahmed', 'one\u2029two'),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + 'one two' + PDI);

/* The report the isolate exists for: an English word inside an Arabic sentence.
   Flattened into the left-to-right line the name needs, "local" would be pulled
   out of the sentence and read as part of the line; inside the isolate the
   sentence keeps its own direction and the word keeps its place in it. */
check('an English word inside an Arabic message stays inside it',
      bidi.line('Salah', 'شكله مشغل الاجينت local'),
      LRM + FSI + 'Salah' + PDI + ': ' + FSI + 'شكله مشغل الاجينت local' + PDI);
check('and the isolated message is what decides its own direction',
      bidi.directionOf('شكله مشغل الاجينت local'), 'rtl');

/* ------------------------------------------------- the mark, in front of it */

/* What a message carries rather than what it says, at the head of the line the
   sender and the message share. It used to stand on a line of its own, which is
   where the phone puts it and what was asked for; the notification centre took
   the message away for it. */
check('a mark opens the line the sender and the message share',
      bidi.line('Salah', 'تمام يا معلم', wording.REPLY_MARK),
      LRM + 'Replied to you: ' + FSI + 'Salah' + PDI + ': ' + FSI + 'تمام يا معلم' + PDI);

/* A direct chat has no name to isolate, and with a mark in front of it the
   message stops speaking for the paragraph: the mark opens it, the paragraph is
   left to right because the mark is, and the message goes inside an isolate so
   an Arabic one still runs right to left inside the line. */
check('and on a direct message it opens a line with no name on it',
      bidi.line('', 'يعم خد راحتك', wording.MENTION_MARK),
      LRM + 'Mentioned you: ' + FSI + 'يعم خد راحتك' + PDI);

/* Nothing is written for a mark that is not there: an ordinary message must not
   open with a space where a mark would have gone. */
check('a message with no mark is exactly the line it always was',
      bidi.line('Ahmed', 'on my way', ''),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + 'on my way' + PDI);
check('and a mark of nothing but spaces counts as no mark at all',
      bidi.line('Ahmed', 'on my way', '   '),
      LRM + FSI + 'Ahmed' + PDI + ': ' + FSI + 'on my way' + PDI);

/* The one thing that must never leave this module. A banner is one paragraph:
   a newline is a space by the time Pango is handed it, and a paragraph
   separator survives to break the line and take the message with it. */
for (const [label, body] of [
  ['a message of several lines', bidi.line('Mega', 'one\ntwo\nthree')],
  ['a marked message', bidi.line('Mega', 'يا عبدالله', wording.MENTION_MARK)],
  ['a message that already carried a separator', bidi.line('Mega', 'one\u2029two')],
  ['a paragraph on its own', bidi.paragraph('one\ntwo')],
  ['a redacted body', bidi.words(wording.REPLY_MARK, 'Photo\nAlbum')],
]) check('no line break of any kind survives ' + label,
         /[\n\u2028\u2029]/.test(body), false);

/* A reaction is this client describing what somebody did, not quoting them, so
   the name carries no colon -- and it is pinned left the same way. */
check('a reaction names the person without claiming they said it',
      bidi.did('Mega', 'reacted \u{1F602} to: نتقابل بكرة'),
      LRM + FSI + 'Mega' + PDI + ' ' + FSI + 'reacted \u{1F602} to: نتقابل بكرة' + PDI);
check('and a reaction aimed at the user takes the mark the same way',
      bidi.did('Mega', 'reacted \u{1F602} to: نتقابل بكرة', wording.REPLY_MARK),
      LRM + 'Replied to you: ' + FSI + 'Mega' + PDI + ' ' +
      FSI + 'reacted \u{1F602} to: نتقابل بكرة' + PDI);

/* The body a banner shows with previews turned off is not laid out at all: it
   names a kind of message rather than showing one, and the parts that are there
   are run together on the one line a banner has. */
check('a redacted body is words and nothing else',
      bidi.words(wording.MENTION_MARK, '\u{1F4F7} Photo'),
      'Mentioned you: \u{1F4F7} Photo');
check('and the parts that are not there are not written',
      bidi.words('', null, 'New message'), 'New message');
check('nothing to say is nothing', bidi.words(), '');

/* Nothing may come back undefined or throw: a banner with no text is a banner
   nobody can read, and these are called in front of every one of them. */
check('nothing in, nothing out', bidi.line(null, null), '');
check('a name with no message still produces a line',
      bidi.line('Mega', ''), LRM + FSI + 'Mega' + PDI + ':');

console.log(failures ? `\n${failures} failed` : '\nbidi checks pass');
process.exit(failures ? 1 : 0);
