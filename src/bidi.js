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
 * the head of the paragraph, and everything that has a direction of its own --
 * the name, the message, a mention inside it -- is wrapped in FSI..PDI, where
 * that direction is settled and from where it cannot leak out and reorder what
 * is printed around it.
 *
 * Two things below are not obvious and each has its own note: a banner is ONE
 * paragraph and never two, which is the notification centre's rule and not this
 * module's; and the sender's name is pinned to the LEFT margin even in a
 * right-to-left banner, which is the one place a message is not allowed to
 * decide the layout for something printed in front of it.
 */
'use strict';

const RLM = '‏';   // right-to-left mark: states the paragraph direction
const LRM = '‎';   // left-to-right mark
const FSI = '⁨';   // first-strong isolate: "work this out on its own"
const PDI = '⁩';   // pop directional isolate

/*
 * One paragraph, and why there is no second one.
 *
 * The obvious shape for a message aimed at the user is two lines -- "You got a
 * reply:" and then "Mega: تيست" under it, which is what the phone raises -- and
 * it was written that way. A newline could not carry it: GNOME Shell sets a
 * body with `this._bodyLabel.setMarkup(text.replace(/\n/g, ' '))`, so every
 * newline is a SPACE before Pango is handed the text. U+2029 PARAGRAPH
 * SEPARATOR survives that replace, it breaks the line, it draws nothing, and
 * each side of it is its own bidi paragraph. All of that was measured, all of
 * it is true, and the two lines drew correctly on the popup banner.
 *
 * In the notification centre the second line was gone -- and with it the whole
 * message. The shell gives a collapsed message ONE line of body, and the arrow
 * that opens the rest is offered on one condition:
 *
 *     const canExpand = layout.is_ellipsized() || this.expanded ||
 *                       !!this._actionBin.child;
 *     this._header.expandButton.opacity = canExpand ? 255 : 0;
 *                              -- messageList.js, gnome-shell 50.4, Message
 *
 * The arrow appears when PANGO CUT SOMETHING. A first line that fits is not
 * cut: a mark is short, whatever it is called, so nothing is ellipsized, the
 * arrow is drawn at zero opacity, and everything after the break is clipped out
 * of a one-line allocation with nothing left to reach it by. Measured in the centre
 * itself, four banners side by side: the two carrying a mark had no arrow and
 * showed no message, the two ordinary ones -- one long paragraph each -- had
 * both. It is not a setting and there is no action bin to fill either: Electron
 * raises these notifications and its Notification carries no actions on Linux.
 *
 * So every break is flattened to a space on the way in, which is what the shell
 * does to a newline anyway, done here where the rest of this module can see it.
 * The mark, the sender and the message share the one paragraph, the paragraph
 * is stated left to right, and each part keeps its own direction inside its own
 * isolate.
 *
 * What that costs, and it is worth writing down: a message the sender wrote on
 * several lines is run together, and an Arabic line that used to state its own
 * direction now takes the direction of the message it is part of. Both were
 * right on the popup banner, which expands itself and drew both lines. Neither
 * is worth a message that cannot be read at all once the banner is gone.
 */
const BREAKS = /[\r\n\u2028\u2029]+/g;

/* Whatever it arrived as, on one line. WhatsApp writes a message's own newlines
   and this module used to write U+2029; both are the same thing here. */
const flatten = text => String(text == null ? '' : text).replace(BREAKS, ' ').trim();

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
 * The mark goes at the head of the paragraph, which is the only place a
 * direction mark says anything: it is read as the paragraph's first strong
 * character and every neutral run in the text after it is laid out from there.
 *
 * `direction`, when given, is the one the caller worked out for the whole
 * banner -- that is how the sender's name is kept out of the decision.
 *
 * Neutral text is left alone: a mark in front of "👍" or "3" would pick a side
 * for a line that has no side to pick, and a stray invisible character in a
 * notification the user may copy is worth avoiding when it buys nothing.
 */
const paragraph = (text, direction) => {
  const body = flatten(text);
  const way = direction || directionOf(body);
  return way ? (way === 'rtl' ? RLM : LRM) + body : body;
};

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
 * جديد دا لا وحشه اوي" -- and the notification centre settled the question for
 * good afterwards: see the note on BREAKS above.
 *
 * `mark`, when there is one, is what the message carries rather than what it
 * says -- "Replied to you:", "Mentioned you:", WhatsApp's own words for it --
 * and it opens the paragraph, in front of the name. It is written in English
 * and it is why the paragraph can be stated left to right without arguing.
 *
 * What is NOT in this module's gift is which margin the block is laid against.
 * A notification body is aligned by the shell that draws it, and a wrapped
 * Arabic paragraph whose last line comes back to the left margin is that
 * alignment showing through, not a direction gone wrong: the words inside each
 * line are still in the right order. Left where it is, deliberately.
 *
 * `joiner` is what goes between the name and the message.
 */
const lead = (sender, message, joiner, mark) => {
  const text = flatten(message);
  const who = String(sender == null ? '' : sender).trim();
  const opener = flatten(mark);
  const head = opener ? opener + ' ' : '';
  /* A direct chat has no sender to print and nothing in front of the message,
     so the message speaks for the whole paragraph and needs no isolate to do
     it. With a mark in front of it, it does: the mark is what the paragraph
     opens with, and the message goes back to being a thing inside the line. */
  if (!who) return head ? paragraph(head + isolate(text), 'ltr') : paragraph(text);
  return paragraph(head + isolate(who) + joiner + isolate(text), 'ltr');
};

/* What somebody said, which a colon is the right punctuation for. */
const line = (sender, message, mark) => lead(sender, message, ': ', mark);

/* What somebody DID -- "Mega reacted 😂 to: ..." -- which this client is
   describing rather than quoting. No colon: a colon after a name claims that
   person said what follows, and they did not. */
const did = (sender, message, mark) => lead(sender, message, ' ', mark);

/* Plain words, run together on the one line a banner has, for the things that
   are not laid out at all -- the redacted body, which is this client naming a
   kind of message rather than showing one. */
const words = (...parts) => parts
  .map(part => flatten(part))
  .filter(Boolean)
  .join(' ');

module.exports = { directionOf, paragraph, isolate, line, did, words,
                   RLM, LRM, FSI, PDI };
