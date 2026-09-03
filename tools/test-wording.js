/*
 * What a banner is allowed to say, and in whose name.
 *
 * Every check here is a line that went out on a real banner and should not
 * have. They are cheap to keep and they are the only place the wording is
 * pinned down: the rest of the notification path needs a desktop, a session and
 * somebody to send a message before it can be asked anything at all.
 */
'use strict';

const { kindOf, pushName, readBody, mediaFromWords, MARKS, REPLY_MARK,
        MENTION_MARK } =
  require('../src/wording.js');

let failures = 0;
const check = (label, got, want) => {
  if (got === want) { console.log('  ok   ' + label); return; }
  failures++;
  console.log('  FAIL ' + label +
              '\n         got  ' + JSON.stringify(got) +
              '\n         want ' + JSON.stringify(want));
};

/* ------------------------------------------------------------- push names */

/* WhatsApp marks a name it read off the sender's own profile, rather than out
   of the user's contacts, with a leading tilde. It is a note to a reader who is
   looking at WhatsApp; on a banner it is a stray character in front of a
   person's name, and it was there in the screenshot that started this. */
check('a push-name marker is not part of anybody\'s name',
      pushName('~Ahmed'), 'Ahmed');
check('with or without the space WhatsApp sometimes leaves',
      pushName('~ Ahmed Salah'), 'Ahmed Salah');
check('a name that merely contains a tilde keeps it',
      pushName('DJ ~Ahmed~'), 'DJ ~Ahmed~');
check('and nothing at all is still nothing',
      pushName(null), '');

/* -------------------------------------------------------------- the split */

check('a group message is a sender and what they said',
      JSON.stringify(readBody('Ahmed: see you there')),
      JSON.stringify({ sender: 'Ahmed', message: 'see you there', mark: '' }));

check('a direct message has no sender in front of it',
      JSON.stringify(readBody('see you there')),
      JSON.stringify({ sender: '', message: 'see you there', mark: '' }));

/* The tilde again, this time where it actually appeared: in front of the name
   WhatsApp writes into the body of a group notification. */
check('and the sender of a group message is cleaned the same way',
      readBody('~Ahmed: تمام').sender, 'Ahmed');

/* A message with a colon in it is not a message from somebody called
   "Meeting". Only a short run in front of the first colon is read as a name,
   and a sentence is not a short run. */
check('a message that happens to contain a colon keeps all of itself',
      readBody('the link is https://example.com/x').message,
      'the link is https://example.com/x');

/* And when the page can say, it says. A direct chat has no sender in its body
   at all, so nothing is looked for -- which is the only way a one-word message
   ending in a colon comes out whole. */
check('told it is one person, nothing is read as a sender',
      JSON.stringify(readBody('Ahmed: see you there', false)),
      JSON.stringify({ sender: '', message: 'Ahmed: see you there', mark: '' }));
check('told it is a group, even a sentence in front of the colon is the sender',
      readBody('the meeting is at 5 today: bring a laptop', true).sender,
      'the meeting is at 5 today');

check('a body of nothing produces nothing rather than throwing',
      JSON.stringify(readBody(undefined)),
      JSON.stringify({ sender: '', message: '', mark: '' }));

/* --------------------------------------------------------- what it is for */

/* WhatsApp prefixes the body when a message is aimed at the user in
   particular. Those words are not a name, and reading them as one is what put
   "Replied to you" on a banner in the place where the sender belongs -- with
   the actual sender pushed into the message, tilde and all. */
check('"replied to you" is a mark on the message, not the person who wrote it',
      readBody('Replied to you: ~Ahmed: جميل').sender, 'Ahmed');
check('and the message is what they actually said',
      readBody('Replied to you: ~Ahmed: جميل').message, 'جميل');
/* It travels separately from the sender and the message so that bidi.line can
   put it at the head of the paragraph, in front of the isolated name -- which is
   where it has to go: a banner broken into two paragraphs loses everything under
   the first line in the notification centre. */
check('and the mark travels separately, to go in front of the line',
      readBody('Replied to you: ~Ahmed: جميل').mark, REPLY_MARK);
/* And it is WhatsApp's own words, put back down exactly as they were lifted.
   Two better ones were written here and taken out again: "الكلمه كمان نفسها
   بتاعه المنشن والريبلاي برضو فكك من بتاعتنا خليك في دي". */
check('and it is the words WhatsApp itself wrote, with its colon',
      REPLY_MARK, 'Replied to you:');
/* In words. It was an arrow, and a machine without the text form of U+21A9 in
   any of its fonts drew an empty box in the one place a banner explains why it
   is louder than the chat's own settings. */
check('and it is words, with nothing in it that a font can fail to draw',
      /^[\x20-\x7E]+$/.test(REPLY_MARK), true);

check('a mention says so as well, in the words WhatsApp uses for one',
      readBody('Mentioned you: Ahmed: يا عبدالله').mark, MENTION_MARK);
check('and those words are WhatsApp\'s, not this client\'s',
      MENTION_MARK, 'Mentioned you:');
check('and it too leaves the sender where a sender belongs',
      readBody('Mentioned you: Ahmed: يا عبدالله').sender, 'Ahmed');

check('the same in Arabic, which is what the client is mostly read in',
      readBody('رد عليك: ~Ahmed: تمام').sender, 'Ahmed');

/* And none of that is said in a chat with one person in it. The mark picks a
   message out of a room; there is no room here, and the only person who could
   have replied is the one the banner is already titled with. The owner asked
   for it off -- "انا بكلم واحد يعني مش اكتر من واحد" -- so a direct chat keeps
   the words and loses the label. */
check('a direct chat is told nothing about being replied to',
      readBody('Replied to you: تمام', false).mark, '');
check('and the words themselves survive it, without WhatsApp\'s prefix',
      readBody('Replied to you: تمام', false).message, 'تمام');
check('a mention in a direct chat goes the same way',
      readBody('Mentioned you: يا عبدالله', false).mark, '');
/* A group is the case the mark exists for, and it is untouched. */
check('and a group still says which message was aimed at you',
      readBody('Replied to you: ~Ahmed: جميل', true).mark, REPLY_MARK);

/* A message that merely begins with those words is a message. The mark is only
   lifted when WhatsApp's own punctuation follows it. */
check('a message that starts with the words but is not the mark is left alone',
      readBody('Mentioned you in the meeting').mark, '');

/* -------------------------------------------------------- the media marks */

/* The words WhatsApp writes into a notification it raises itself, which is
   every notification raised while the window is not in front. They arrived bare
   -- "Sticker", and nothing to look at -- because only the chat-list watcher
   had this table. */
check('a sticker WhatsApp named itself gets the mark too',
      mediaFromWords('Sticker'), MARKS.sticker);
check('and a voice message', mediaFromWords('Voice message'), MARKS.ptt);
check('and a photo', mediaFromWords('Photo'), MARKS.image);
check('and the round video keeps WhatsApp\'s own name for it',
      mediaFromWords('Video note'), MARKS.ptv);
check('in Arabic as well', mediaFromWords('\u0645\u0644\u0635\u0642'), MARKS.sticker);
check('an album counts what is in it', mediaFromWords('4 photos'), MARKS.album);

/* Anchored, or a message ABOUT a photo becomes a photo. */
check('a message that merely mentions one is a message',
      mediaFromWords('send me the photo'), '');
check('and nothing at all names nothing', mediaFromWords(''), '');

/* ------------------------------------------------- previews kept off screen */

/* With previews hidden the banner still says what kind of thing arrived, and
   that is read back off the glyph the page put in front of it. */
check('a sticker is still announced as a sticker with the words hidden',
      kindOf('Mega: ' + MARKS.sticker), MARKS.sticker);
check('and a voice note keeps its name but not its length',
      kindOf(MARKS.ptt + ' (0:41)'), MARKS.ptt);
check('a message of words says only that it is one',
      kindOf('Ahmed: نتقابل بكرة الساعة ٥'), 'New message');
check('and so does one with nothing in it',
      kindOf(''), 'New message');

console.log(failures ? `\n${failures} failed` : '\nwording checks pass');
process.exit(failures ? 1 : 0);
