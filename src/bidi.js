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
 * the head of the line, and the name is wrapped in FSI..PDI so its own
 * direction is settled inside the isolate and cannot leak out and reorder the
 * colon after it.
 */
'use strict';

const RLM = '‏';   // right-to-left mark: states the paragraph direction
const LRM = '‎';   // left-to-right mark
const FSI = '⁨';   // first-strong isolate: "work this out on its own"
const PDI = '⁩';   // pop directional isolate

/* Ranges that carry a direction. Hebrew and Arabic, including the presentation
   forms an Arabic keyboard can produce, and the Latin/Greek/Cyrillic block for
   the other side. Anything else -- digits, punctuation, emoji, spaces -- is
   neutral and says nothing about which way the line runs, which is the whole
   reason a Latin name in front of an Arabic sentence decides the layout. */
const RTL = /[֐-׿؀-ۿ܀-ݏݐ-ݿࢠ-ࣿיִ-﷿ﹰ-﻿\u{10e60}-\u{10e7e}\u{1ee00}-\u{1eeff}]/u;
const LTR = /[A-Za-zÀ-ʸͰ-֏ऀ-῿Ⰰ-퟿豈-ﬗ]/u;

/* The direction of the first character that has one, or null when the text is
   all digits, punctuation and emoji. Deliberately first-strong and not "which
   script is there more of": that is the rule Pango itself applies, and matching
   it is what makes the mark below predictable. */
const directionOf = text => {
  const source = String(text == null ? '' : text);
  for (const ch of source) {
    if (RTL.test(ch)) return 'rtl';
    if (LTR.test(ch)) return 'ltr';
  }
  return null;
};

/* One paragraph, told which way it runs. Neutral text is left alone: a mark in
   front of "👍" or "3" would pick a side for a line that has no side to pick,
   and a stray invisible character in a notification the user may copy is worth
   avoiding when it buys nothing. */
const paragraph = (text, direction) => {
  const body = String(text == null ? '' : text);
  const way = direction || directionOf(body);
  if (!way) return body;
  return (way === 'rtl' ? RLM : LRM) + body;
};

/* A name that must not decide the direction of the line it is printed on, and
   must not be reordered by it either. FSI lets the name run whichever way its
   own letters do; PDI ends that and hands the line back. */
const isolate = text => {
  const name = String(text == null ? '' : text);
  return name ? FSI + name + PDI : '';
};

/*
 * The body of a banner: "sender: message" in a group, the message alone in a
 * direct chat, laid out the way the message reads.
 *
 * In an Arabic paragraph the parts come out in the order Arabic writes them --
 * the name at the right margin, then the colon, then the message running
 * leftwards -- which is what the phone does and what the same message looks
 * like inside WhatsApp itself.
 */
const line = (sender, message) => {
  const text = String(message == null ? '' : message);
  const who = String(sender == null ? '' : sender).trim();
  if (!who) return paragraph(text);
  /* The direction is the message's, never the name's. A group of Arabic
     speakers whose display names are Latin -- which is most of them -- would
     otherwise get a left-to-right banner for every Arabic message in it. */
  return paragraph(isolate(who) + ': ' + text, directionOf(text));
};

module.exports = { directionOf, paragraph, isolate, line, RLM, LRM, FSI, PDI };
