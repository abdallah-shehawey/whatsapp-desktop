/*
 * Which way a notification reads.
 *
 * A banner is one paragraph of plain text handed to the notification daemon,
 * and the daemon lays it out with Pango. Pango takes the paragraph's base
 * direction from its first strong character -- so "Salah: بالنسبه للخريجين تم
 * تسليم النتيجه" is a left-to-right paragraph, because it begins with an S, and
 * an Arabic sentence set in a left-to-right paragraph wraps the wrong way
 * round: the first line sits against the right margin the way Arabic should,
 * and every line after it starts from the left. That is exactly the report --
 * "السطر الاول بيكون بادئ من علي اليمين، لكن السطر التاني بيبدأ من علي الشمال".
 *
 * The base direction has to come from the message rather than from whatever
 * happens to be printed in front of it, and the sender's name has to be kept
 * out of the decision: a Latin name at the head of an Arabic line is a
 * left-to-right run inside a right-to-left paragraph, which is the one thing
 * bidi isolates exist for.
 *
 * So: the direction is taken from the message, stated outright with a mark at
 * the head of every line, and the name is wrapped in FSI..PDI so its own
 * direction is settled inside the isolate and cannot leak out and reorder the
 * colon after it.
 *
 * Two things were added later and each has its own note below, because neither
 * is obvious: the line break is U+2029 and not a newline, because GNOME Shell
 * turns newlines into spaces and silently flattened every banner this module
 * had laid out; and the sender's name is pinned to the LEFT margin even in a
 * right-to-left banner, which is the one place a message is not allowed to
 * decide the layout for something printed in front of it.
 */
'use strict';

const RLM = '‏';   // right-to-left mark: states the paragraph direction
const LRM = '‎';   // left-to-right mark
const FSI = '⁨';   // first-strong isolate: "work this out on its own"
const PDI = '⁩';   // pop directional isolate

/*
 * The line break a notification will actually keep.
 *
 * GNOME Shell sets a banner's body with
 * `this._bodyLabel.setMarkup(text.replace(/\n/g, ' '))` -- read out of
 * messageList.js in gnome-shell 50.4, and it is the shell's own line and not a
 * setting: every newline in a notification becomes a SPACE before Pango is ever
 * handed the text. So a body written on two lines arrived as one, "You got a
 * reply" ran into the message behind it, and -- the part that mattered more --
 * every mark this module puts at the head of a line landed in the middle of a
 * sentence, where a direction mark says nothing at all. That is one bug behind
 * all three reports.
 *
 * U+2029 PARAGRAPH SEPARATOR is the same break under a name the shell's replace
 * does not know. Measured through PangoCairo at banner width rather than
 * reasoned about, against the newline it stands in for:
 *
 *   - it breaks the line, and it draws nothing (0 unknown glyphs);
 *   - each side of it is its own BIDI PARAGRAPH, with its own direction and its
 *     own alignment -- an Arabic line under an English one goes against the
 *     right margin, exactly as it did under a newline.
 *
 * U+2028 LINE SEPARATOR was measured beside it and is the wrong character: it
 * breaks the line and keeps ONE paragraph, so the Arabic line under the English
 * one stayed flush left. The distinction is Unicode's own -- U+2029 is bidi
 * class B, a paragraph separator, and U+2028 is whitespace.
 */
const BREAK = '\u2029';
/* Both, on the way in: text arriving from WhatsApp is written with newlines and
   text arriving from this module is written with the separator, and every line
   of either is a line. */
const BREAKS = /[\n\u2029]/;

/* Ranges that carry a direction. Hebrew and Arabic, including the presentation
   forms an Arabic keyboard can produce, and the Latin/Greek/Cyrillic block for
   the other side. Anything else -- digits, punctuation, emoji, spaces -- is
   neutral and says nothing about which way the line runs, which is the whole
   reason a Latin name in front of an Arabic sentence decides the layout. */
const RTL = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿\u{10e60}-\u{10e7e}\u{1ee00}-\u{1eeff}]/u;
const LTR = /[A-Za-zÀ-ʸͰ-֏ऀ-῿Ⰰ-퟿豈-ﬗ]/u;

/* The characters that open an isolate, and the one that closes any of them. */
const OPENS = /[\u2066\u2067\u2068]/;   /* LRI, RLI, FSI */

/*
 * The direction of the first character that has one, or null when the text is
 * all digits, punctuation and emoji. Deliberately first-strong and not "which
 * script is there more of": that is the rule Pango itself applies, and matching
 * it is what makes the mark below predictable.
 *
 * What is inside an isolate does not count, which is rule P2 of the bidi
 * algorithm itself -- "skip characters between an isolate initiator and its
 * matching PDI" -- and the reason this function has to know about it is that
 * this client isolates things on purpose. A message that OPENS with a mention
 * is the case that forced it: "@Abdallah Shehawey هو انا لما اجي اكتب رساله
 * عربي" is an Arabic message, and WhatsApp's own bubble draws it right to left,
 * because a mention is drawn as its own element and contributes no direction to
 * the line around it. Read letter by letter the way this used to be, the "A" of
 * the name is the first strong character and the whole message turns round.
 *
 * So the mention is isolated where it is substituted (see withNames in the page
 * script) and skipped here, and the two halves agree with Pango and with the
 * conversation.
 */
const directionOf = text => {
  const source = String(text == null ? '' : text);
  let inside = 0;
  for (const ch of source) {
    if (OPENS.test(ch)) { inside++; continue; }
    if (ch === PDI) { if (inside) inside--; continue; }
    if (inside) continue;
    if (RTL.test(ch)) return 'rtl';
    if (LTR.test(ch)) return 'ltr';
  }
  return null;
};

/*
 * Text, told which way it runs.
 *
 * A newline ends a bidi paragraph, so a banner of several lines is several
 * paragraphs and Pango works each of their directions out separately. One mark
 * at the head of the whole thing therefore only ever settles the FIRST line,
 * and the rest go back to being decided by whatever happens to open them -- an
 * English word at the head of line four of an otherwise Arabic message flips
 * that line and nothing else. So every line is marked, and each from its own
 * first strong character, which is the same rule the conversation itself
 * follows (see MESSAGE_BIDI in style.js).
 *
 * `direction`, when given, is the one the caller worked out for the whole
 * banner and applies to every line of it -- that is how the sender's name is
 * kept out of the decision.
 *
 * Neutral lines are left alone: a mark in front of "👍" or "3" would pick a
 * side for a line that has no side to pick, and a stray invisible character in
 * a notification the user may copy is worth avoiding when it buys nothing.
 */
const paragraph = (text, direction) => {
  const body = String(text == null ? '' : text);
  return body.split(BREAKS).map(part => {
    const way = direction || directionOf(part);
    return way ? (way === 'rtl' ? RLM : LRM) + part : part;
  }).join(BREAK);
};

/* Several things, each on its own line: the mark a message carries, the person
   who sent it, what they said. A part that is not there is not written -- a
   banner with no mark on it must not open with a blank line. */
const stack = (...parts) => parts
  .map(part => (part == null ? '' : String(part)))
  .filter(Boolean)
  .join(BREAK);

/* A name that must not decide the direction of the line it is printed on, and
   must not be reordered by it either. FSI lets the name run whichever way its
   own letters do; PDI ends that and hands the line back. */
const isolate = text => {
  const name = String(text == null ? '' : text);
  return name ? FSI + name + PDI : '';
};

/*
 * The sender, in front of what they said, and always at the left margin.
 *
 * A name and a message do not have to read the same way round, and the line
 * they share can only have one base direction. Take it from the message --
 * which is what this used to do -- and "Salah: <arabic>" becomes a right-to-
 * left line: the name goes against the RIGHT margin with the colon to its left.
 * Correct Arabic, and not what was asked for. A name is the thing the eye looks
 * for first and it belongs on the left, whether it is written in Arabic letters
 * or Latin ones: "دايما الاسم علي الشمال سواء كان الاسم عربي او انجليزي".
 *
 * So the line is stated left-to-right outright, and the message is put inside
 * an isolate of its own. That is the whole trick and it is worth being clear
 * about why it works: FSI..PDI makes the message ONE object as far as the line
 * is concerned, and gives it its own base direction, worked out from its own
 * first strong character. The line reads "name, colon, then a thing" and puts
 * the name on the left; inside the thing, Arabic runs right to left and an
 * English word in the middle of an Arabic sentence -- "local", a link, a
 * branch name -- sits exactly where the conversation itself puts it. Without
 * the isolate the message would be flattened into the left-to-right line and
 * that English word would move.
 *
 * Putting the message on a LINE of its own was tried in between, and it did
 * give both sides their own margin. The owner rejected it on sight -- "فكره سطر
 * جديد دا لا وحشه اوي" -- so the two share a line and the isolate is what makes
 * that possible.
 *
 * What is NOT in this module's gift is which margin the block is laid against.
 * A notification body is aligned by the shell that draws it, and a wrapped
 * Arabic paragraph whose last line comes back to the left margin is that
 * alignment showing through, not a direction gone wrong: the words inside each
 * line are still in the right order. Left where it is, deliberately.
 *
 * `joiner` is what goes between the name and the message.
 */
const lead = (sender, message, joiner) => {
  const text = String(message == null ? '' : message);
  const who = String(sender == null ? '' : sender).trim();
  if (!who) return paragraph(text);

  /* Only the FIRST line of the message shares the name's line. The lines under
     it are read the way any other line is, from their own first strong
     character -- an English headline over Arabic body copy keeps each of them
     its own way round, and neither needs the name for it. */
  const [head, ...rest] = text.split(BREAKS);
  const first = paragraph(isolate(who) + joiner + isolate(head), 'ltr');
  return rest.length ? stack(first, paragraph(rest.join(BREAK))) : first;
};

/* What somebody said, which a colon is the right punctuation for. */
const line = (sender, message) => lead(sender, message, ': ');

/* What somebody DID -- "Mega reacted 😂 to: ..." -- which this client is
   describing rather than quoting. No colon: a colon after a name claims that
   person said what follows, and they did not. */
const did = (sender, message) => lead(sender, message, ' ');

module.exports = { directionOf, paragraph, stack, isolate, line, did,
                   BREAK, RLM, LRM, FSI, PDI };
