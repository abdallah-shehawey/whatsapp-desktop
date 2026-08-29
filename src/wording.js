/* What a message is, when its words are not to be shown. The page marks every
   kind of media with a glyph of its own -- see MEDIA_KINDS in the page script --
   so a body that begins with one already says what arrived, and the rest of it
   is the part the user asked to keep off the screen. Anything else is a message
   of words, and with previews hidden that is all a banner may say about it. */
const KIND = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]+\s*[A-Za-z ]+)/u;
const kindOf = message => {
  const body = String(message || '');
  /* The whole body first, and only then the body with a sender taken off it.
     The other way round, "\u{1F3A4} Voice message (0:41)" had "(0:" read as a
     sender prefix and was left as "41)" -- which matches no kind, so a voice
     note announced itself as "New message" with previews hidden. */
  const found = KIND.exec(body) || KIND.exec(body.replace(/^[^:]{1,40}:\s*/, ''));
  return found ? found[1].trim() : 'New message';
};

/* The name WhatsApp printed, without the note it printed about where the name
   came from. A leading tilde marks a name taken from the sender's own profile
   rather than from the user's contacts -- "~Ahmed" -- and it is a footnote to
   the reader, not part of anybody's name. The phone does not show it and neither
   does this. */
const pushName = name => String(name == null ? '' : name).replace(/^~\s*/, '').trim();

/* What WhatsApp puts in front of the sender when a message is aimed at the user
   in particular. It is not a name, and the split below read it as one: a banner
   went out reading "Replied to you: ~Ahmed: ..." with the wrong half of that in
   the place a sender belongs. Lifted off and turned back into what it is -- a
   mark on the message -- which is how the phone shows it too. */
const AIMED_AT_US = [
  { text: /^(?:replied to you|رد عليك)\s*[:\u061b\u003a]\s*/i, mark: '\u21A9\uFE0F ' },
  { text: /^(?:mentioned you|ذكرك)\s*[:\u061b\u003a]\s*/i,     mark: '@ ' },
];

/* Whether the run in front of a colon can be somebody's name.
 *
 * Only consulted when nothing else can say, and written to refuse rather than
 * to guess. The case it exists for is a DIRECT message that happens to contain
 * a colon: "the link is https://example.com/x" split into a person called "the
 * link is https" who said "//example.com/x", and that went out on a banner.
 *
 * Four words and forty characters, because the names that show up here are
 * people and telephone numbers -- "Ahmed", "Ahmed Salah", "+20 11 18856364",
 * "@eng_mahmoudmajed", all measured off the live list -- and none of them is a
 * sentence. Digits are allowed for exactly that reason, so a length is the only
 * thing left to hold the line with. And a colon followed by a slash is a URL
 * scheme in every case there is. */
const NAME_WORDS = 4;
const NAME_CHARS = 40;
const nameLike = (candidate, rest) => {
  if (rest.startsWith('/')) return false;
  if (candidate.length > NAME_CHARS) return false;
  return candidate.trim().split(/\s+/).length <= NAME_WORDS;
};

/* WhatsApp writes a GROUP notification as "Group name" with "Sender: message"
   in the body, and a direct one as the contact with the bare message. Nothing in
   the text distinguishes the two, so the page is asked -- it has the row and can
   see the group icon -- and `group` is what it answers: true, false, or null
   when the chat is not on screen and it has never seen one.
 *
 * The marks come off first either way. They sit in front of the sender in a
 * group and in front of the message in a direct chat, and they are not part of
 * either. */
const readBody = (raw, group) => {
  let rest = String(raw == null ? '' : raw);
  let mark = '';
  for (const aimed of AIMED_AT_US) {
    const found = aimed.text.exec(rest);
    if (!found) continue;
    mark = aimed.mark;
    rest = rest.slice(found[0].length);
    break;
  }

  /* Told it is one person: there is no sender in the body and nothing to look
     for. This is the half the heuristic below can only approximate. */
  if (group === false) return { sender: '', message: rest, mark };

  const split = /^([^:\n]{1,60}):\s*([\s\S]+)$/.exec(rest);
  if (!split) return { sender: '', message: rest, mark };
  if (group !== true && !nameLike(split[1], split[2])) {
    return { sender: '', message: rest, mark };
  }
  return { sender: pushName(split[1]), message: split[2], mark };
};


module.exports = { kindOf, pushName, readBody };
