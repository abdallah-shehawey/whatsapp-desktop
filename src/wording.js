/*
 * The sticker's glyph, which took the longest to settle.
 *
 * Unicode has no sticker, so the question is which character comes nearest to
 * the mark WhatsApp itself puts on one. That mark is a rounded square with a
 * peeled corner and a smiling face inside it -- the app names its own button
 * for it "sticker-smiley" -- and of everything in the emoji font it is the
 * face that carries the meaning. The peel is what makes it a sticker rather
 * than a smiley, and no character has it.
 *
 * A label was tried first, on the reasoning that a label is a thing you peel
 * and stick. It reads as a price tag and nothing else, and it was rejected on
 * sight. Every candidate was drawn through Pango at banner size before this
 * one was chosen, because how a glyph reads is not a thing to reason about
 * from its Unicode name.
 *
 * A label was tried, then a face, and both were rejected on sight -- the label
 * reads as a price tag and the face reads as an emoji, which is the one thing a
 * sticker must not be mistaken for. The answer came from the owner of the
 * client, who wanted the shape rather than the meaning: a square with a heart in
 * it, in pink, the way it looks on the phone. U+1F49F is drawn as exactly that,
 * a rounded magenta square with a white heart knocked out of it, and it is the
 * only character in the font that is a square with something inside it.
 *
 * The picture in the notification body is not an option and was checked rather
 * than assumed: gnome-shell 50.4 answers GetCapabilities with actions, body,
 * body-markup, icon-static, persistence and sound -- and no body-images. So the
 * mark has to be a character, and this is the character.
 *
 * It defaults to emoji presentation, so it needs no variation selector to land
 * in the colour font.
 */
/* Monochrome, and by asking for it rather than by choosing characters that
 * happen to have no colour.
 *
 * Every mark below is a character with EMOJI presentation by default, so a
 * shaper hands it to Noto Color Emoji and it lands on the banner as a small
 * colour picture -- a pink camera, a blue person, a red pin -- next to text the
 * shell draws in one colour. U+FE0E, VARIATION SELECTOR-15, is the request for
 * the text form of the same character, and on this machine it moves every one of
 * them from Noto Color Emoji to **Noto Emoji**: the same designs, drawn as
 * outlines in the colour of the surrounding text.
 *
 * Measured rather than reasoned about, through PangoCairo at banner size, which
 * is the only way to know: the run's resolved family was read for each mark both
 * ways, and the pair was drawn to a PNG and looked at. Picking different
 * characters -- the ones Unicode gives text presentation by default -- was the
 * other way to do this, and it was worse: it scatters the marks across Noto Sans
 * Symbols 2, Font Awesome, DejaVu and Adwaita Mono, four designs that do not
 * belong together, and it changes shapes the user already recognises. */
const TEXT = '︎';
const mono = character => character + TEXT;

const STICKER = mono('\u{1F49F}') + ' Sticker';

/* A call nobody answered, which is not a message and needs a mark of its own.
   Three of them: the phone names the two kinds separately -- a missed video call
   is a different thing to be owed than a missed voice call -- and the third is
   for a preview that says only that one was missed. */
const MISSED = {
  voice: mono('\u{1F4DE}') + ' Missed voice call',
  video: mono('\u{1F4F9}') + ' Missed video call',
  call:  mono('\u{1F4DE}') + ' Missed call',
};

/* And the same call while it is still ringing, which is a different thing to be
   told and is told in the present tense. The marks are the same characters: what
   changes between the two is which of them has already happened. */
const RINGING = {
  voice: mono('\u{1F4DE}') + ' Incoming voice call',
  video: mono('\u{1F4F9}') + ' Incoming video call',
  call:  mono('\u{1F4DE}') + ' Incoming call',
};
/* The selector is on the three whose default presentation is text -- the label,
   the film frames and the framed picture -- and off the rest, whose default is
   already the emoji. Adding it where it is not needed makes a sequence Unicode
   does not list, and the point was to be handed to the emoji font, not to carry
   an invisible character for its own sake. */

/* The words WhatsApp itself writes in a preview for the same things, so a
   preview that arrived as text still gets its glyph. Anchored, because a
   message about a photo is a message and not a photo. */
const MEDIA_WORDS = [
  { text: /^(sticker|ملصق)$/i,                            label: STICKER },
  { text: /^(gif)$/i,                                     label: mono('\u{1F39E}') + ' GIF' },
  { text: /^(voice message|رسالة صوتية)$/i,               label: mono('\u{1F3A4}') + ' Voice message' },
  { text: /^(photo|image|صورة)$/i,                        label: mono('\u{1F4F7}') + ' Photo' },
  /* WhatsApp's own name for the round one, and it is the phone's wording too,
     so it is kept rather than flattened into "Video". */
  { text: /^(video note|ملاحظة فيديو)$/i,               label: mono('\u{1F3A5}') + ' Video note' },
  { text: /^(video|فيديو)$/i,                             label: mono('\u{1F3A5}') + ' Video' },
  { text: /^(audio|أغنية|ملف صوتي)$/i,                    label: mono('\u{1F3B5}') + ' Audio' },
  { text: /^(poll|استطلاع)$/i,                             label: mono('\u{1F4CA}') + ' Poll' },
  { text: /^(location|live location|موقع)$/i,             label: mono('\u{1F4CD}') + ' Location' },
  { text: /^(contact|جهة اتصال)$/i,                       label: mono('\u{1F464}') + ' Contact' },
  { text: /^(document|مستند)$/i,                          label: mono('\u{1F4C4}') + ' Document' },
  { text: /^(\d+\s*(photos|videos|صور|مقاطع))$/i,             label: mono('\u{1F5BC}') + ' Album' },
  { text: /^(missed voice call|مكالمة صوتية فائتة)$/i,     label: MISSED.voice },
  { text: /^(missed video call|مكالمة فيديو فائتة)$/i,     label: MISSED.video },
  { text: /^(missed call|مكالمة فائتة)$/i,                 label: MISSED.call },
  { text: /^(this message was deleted|تم حذف هذه الرسالة)$/i, label: mono('\u{1F6AB}') + ' Deleted message' },
];

/* The glyph for a preview WhatsApp handed over as words.
 *
 * Both halves of the client need this and only one of them used to have it. The
 * chat-list watcher labelled what it read off a row; the notifications WhatsApp
 * Web raises itself -- which is EVERY notification while the window is not in
 * front, and so most of them -- went out with WhatsApp's bare "Sticker" and no
 * mark at all. That was the report: a sticker arrives and there is no icon on
 * it.
 *
 * Anchored, because a message about a photo is a message and not a photo. */
const mediaFromWords = text => {
  const said = String(text == null ? '' : text).trim();
  if (!said) return '';
  for (const kind of MEDIA_WORDS) if (kind.text.test(said)) return kind.label;
  return '';
};

/* What a message is, when its words are not to be shown. The page marks every
   kind of media with a glyph of its own -- see MEDIA_KINDS in the page script --
   so a body that begins with one already says what arrived, and the rest of it
   is the part the user asked to keep off the screen. Anything else is a message
   of words, and with previews hidden that is all a banner may say about it. */
/* FE0E is in the class beside FE0F: every mark carries one now, and a class
   that did not know it read "Photo" out of a body whose glyph it had stopped
   recognising -- which is the whole label, so nothing broke visibly and the
   hidden-preview banner quietly said "New message" for everything. */
const KIND = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{FE0E}\u{FE0F}]+\s*[A-Za-z ]+)/u;
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

/* What goes in front of a message aimed at the user in particular -- on a line
   of its own, above the sender, which is where the phone puts it and what it
   says there.

   In words, and not in a glyph. It was an arrow before, in the monochrome the
   marks below use, and on a machine whose fonts do not cover the text form of
   U+21A9 the shell drew it as an empty box: a banner that said a message was
   aimed at you with a shape that means nothing. A word cannot fall back to
   nothing. The @ stays because it is ASCII and every font has it. */
const MENTION_MARK = '@ You were mentioned';
const REPLY_MARK = 'You got a reply';

/* What WhatsApp puts in front of the sender when a message is aimed at the user
   in particular. It is not a name, and the split below read it as one: a banner
   went out reading "Replied to you: ~Ahmed: ..." with the wrong half of that in
   the place a sender belongs. Lifted off and turned back into what it is -- a
   mark on the message -- which is how the phone shows it too. */
const AIMED_AT_US = [
  { text: /^(?:replied to you|رد عليك)\s*[:\u061b\u003a]\s*/i, mark: REPLY_MARK + '\n' },
  { text: /^(?:mentioned you|ذكرك)\s*[:\u061b\u003a]\s*/i,     mark: MENTION_MARK + '\n' },
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


/* The mark for each kind of message WhatsApp's own store names, which is the
   same table the previews above are matched against -- one place, so the two
   halves of the client cannot drift into calling a voice note different things.
   A key that is not here is not a message: the census of one real account turned
   up forty-two type/subtype pairs, of which nine were things people had sent and
   the rest were WhatsApp talking to itself. An empty label is a message that
   speaks for itself. */
const MARKS = {
  chat:                  '',
  sticker:               STICKER,
  image:                 mono('\u{1F4F7}') + ' Photo',
  video:                 mono('\u{1F3A5}') + ' Video',
  ptv:                   mono('\u{1F3A5}') + ' Video note',
  gif:                   mono('\u{1F39E}') + ' GIF',
  audio:                 mono('\u{1F3B5}') + ' Audio',
  ptt:                   mono('\u{1F3A4}') + ' Voice message',
  document:              mono('\u{1F4C4}') + ' Document',
  album:                 mono('\u{1F5BC}') + ' Album',
  location:              mono('\u{1F4CD}') + ' Location',
  live_location:         mono('\u{1F4CD}') + ' Live location',
  vcard:                 mono('\u{1F464}') + ' Contact',
  multi_vcard:           mono('\u{1F464}') + ' Contacts',
  poll_creation:         mono('\u{1F4CA}') + ' Poll',
  groups_v4_invite:      mono('\u{1F4E8}') + ' Group invite',
  payment:               mono('\u{1F4B3}') + ' Payment',
  order:                 mono('\u{1F6CD}') + ' Order',
  product:               mono('\u{1F6CD}') + ' Product',
  list:                  mono('\u{1F4CB}') + ' List',
  interactive:           '',
  buttons_response:      '',
  template_button_reply: '',
  list_response:         '',
};

module.exports = { kindOf, pushName, readBody, mediaFromWords, STICKER, MISSED,
                   RINGING, MARKS, MENTION_MARK, REPLY_MARK, TEXT, mono };
