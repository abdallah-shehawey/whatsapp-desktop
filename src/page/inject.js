/*
 * Page-side helpers, running in WhatsApp Web's own world from document-start.
 *
 * Almost all of this is the notification story, and it is carried over from the
 * GTK client where every line of it was paid for on a live session. What is NOT
 * here is just as deliberate:
 *
 *   - No clipboard shim. WebKitGTK handed the page an empty clipboardData for
 *     images, so Ctrl+V pasted nothing and the bytes had to be lifted off the
 *     GTK clipboard and dispatched by hand. Chromium's clipboard is not broken.
 *
 *   - No document.hasFocus override. WebKit reported a view in a hidden window
 *     as focused, and the truth had to be pushed in from the app; get that wrong
 *     in either direction and it costs either every notification or every read
 *     receipt. Chromium reports it correctly, so the page is left alone and only
 *     this file's own idea of focus is pushed in, for the watcher.
 *
 *   - No emoji sprite cache. Nothing on this machine kept WhatsApp's 152 sprite
 *     sheets between runs -- WebKit's disk cache stored not one of them -- so
 *     every launch pulled 4.7 MB again and the emoji panel sat full of blank
 *     squares. Chromium's HTTP cache keeps them.
 */
'use strict';

const wording = require('../wording.js');
const store = require('./store.js');
const media = require('./media.js');

const SEP = '\u001f';   // joins the parts of an answer; occurs in no chat name

const start = ({ send, on }) => {
  const log = message => send('log', String(message));

  /* WebGPU on Linux/Wayland has a broken CreateExternalTexture implementation in
     Chromium for video streams (generating "Invalid ExternalTexture is invalid" and
     black video call frames). Disabling navigator.gpu forces WhatsApp to use its
     working WebGL / direct MediaStream pipeline. */
  try {
    if (window.Navigator && window.Navigator.prototype && 'gpu' in window.Navigator.prototype) {
      Object.defineProperty(window.Navigator.prototype, 'gpu', {
        get: () => undefined,
        configurable: true,
      });
    }
  } catch (e) {}

  /* ------------------------------------------------------------------ focus */

  /* Only this file's own view of focus, pushed in by the app. It is the line the
     whole notification story is divided along: while the window is away WhatsApp
     Web raises its own notifications, which the app dresses, and the watcher
     below stays out of it -- two paths reporting one message is two banners. */
  let focused = false;
  let arrivals = [];

  /* WhatsApp's own store, once it answers. Everything below it in this file --
     the chat-list watcher, the shim over the notifications WhatsApp raises --
     is what happens when it does not. See store.js: those two paths read a
     picture drawn for a person and infer from it, and the store is asked. */
  let waStore = null;
  let waMedia = null;
  const storeLive = () => !!(waStore && waStore.ready);

  on('focus', state => {
    state = !!state;
    if (state === focused) return;
    focused = state;
    if (waStore) waStore.setFocus(focused);
    /* Nothing queued survives the window going away: from here the page raises
       its own notifications, so an arrival still waiting to be asked about would
       be announced a second time the moment the window came back. */
    if (!focused) arrivals = [];
    /* And the chat on screen is said again, unchanged though it is: it is only
       now, with the window back, that it is being read. */
    else refreshOpen();
  });

  /* ------------------------------------------------------------------- tone */

  /* GNOME plays a sound for a notification only when the Notify call asks for
     one by hint, and Electron cannot set hints -- so a banner this client raises
     is silent while WhatsApp's own, which plays its tone through an <audio>
     element on this page, is not. That was the whole of "there is no sound while
     the window is in front": in front, WhatsApp stays quiet and this client did
     the announcing.

     The tone is played here rather than by spawning a player, so it belongs to
     the application's own audio stream, follows its volume in the mixer, and
     needs nothing installed. Decoded once, on arrival. */
  let toneBuffer = null;
  let audio = null;

  const decodeTone = async payload => {
    if (!payload || !payload.data) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const binary = atob(payload.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      toneBuffer = await audio.decodeAudioData(bytes.buffer);
      log('tone ready (' + Math.round(toneBuffer.duration * 1000) + 'ms)');
    } catch (err) {
      log('could not decode the tone: ' + err.message);
    }
  };

  const playTone = async () => {
    if (!toneBuffer || !audio) return;
    try {
      /* A context created while the window was hidden starts suspended, and a
         suspended context plays nothing at all. */
      if (audio.state === 'suspended') await audio.resume();
      const source = audio.createBufferSource();
      source.buffer = toneBuffer;
      source.connect(audio.destination);
      /* Ours, and so exempt from the muting of the tone WhatsApp plays for a
         message going out. */
      source.__waOurs = true;
      source.start();
    } catch (err) {
      log('could not play the tone: ' + err.message);
    }
  };

  on('tone', decodeTone);
  on('play-tone', playTone);

  /* ------------------------------------------------------- what just arrived */

  /* Everything below only matters while the window is in front. WhatsApp Web
     stays silent then -- it can see it has the user's attention -- so a message
     landing in a conversation the user is not looking at would pass unannounced.
     The chat list is watched for it: WhatsApp rewrites a row the moment a message
     lands there, so the row that changed is the chat the message went to. */

  /* The chat on screen. WhatsApp marks its row aria-selected="true", which beats
     reading the conversation header: the header of a community announcement group
     carries title="Announcements", not the name of the group.

     Two things have to hold, and both were measured on the live page by walking
     eight conversations open and shut: #main exists only while a conversation is
     open -- the empty state that replaces it is a different element -- and the
     marker always resolves to exactly one row. Falling back to the marked element
     itself when it resolves to no row could only ever do harm: an element above
     the rows contains every one of them, so isOpen would answer "the chat on
     screen" for the whole list, which is not a quiet banner but no banner. */
  const openRow = () => {
    if (!document.querySelector('#main')) return null;
    const pane = document.querySelector('#pane-side');
    const selected = pane && pane.querySelector('[aria-selected="true"]');
    return selected ? selected.closest('[role="row"]') : null;
  };

  /* Chat names and message previews arrive wrapped in bidi control characters,
     which have to come off before anything is compared or displayed. */
  const strip = t => (t || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();

  const titlesIn = row => [...row.querySelectorAll('span[title]')];
  const nameOf = row => {
    if (!row) return '';
    const first = titlesIn(row)[0];
    const fromTitle = strip(first && first.getAttribute('title'));
    if (fromTitle) return fromTitle;
    const dirAuto = row.querySelector('span[dir="auto"], div[dir="auto"]');
    if (dirAuto && dirAuto.innerText) return strip(dirAuto.innerText.split('\n')[0]);
    return '';
  };

  /* A message of our own moves a chat to the top of the list and rewrites its
     preview exactly the way an incoming one does, so without this a message sent
     from the phone raised a banner on the desktop. The delivery tick on the row
     is what tells them apart -- WhatsApp draws one only for what we sent, under
     its design-system name (wds-ic-read and friends) or the older msg- names.
     Class names could not be used: they are obfuscated and rotate every build. */
  const OUTGOING_ICON = /^(wds-)?(ic-)?(msg-)?(status-)?(read|delivered|sent|check|dblcheck|clock|time)$/;
  /* The name is not always in the same place. WhatsApp's current build gives the
     tick an <svg> whose only marking is a <title> child reading "wds-ic-read";
     older ones put data-icon on the element. Both are read, which is what this
     costs -- looking only at data-icon found nothing at all and every message
     sent from the phone raised a banner on the desktop. */
  const iconNames = el => {
    const names = [...el.querySelectorAll('[data-icon]')].map(i => i.getAttribute('data-icon') || '');
    for (const svg of el.querySelectorAll('svg')) {
      names.push(svg.getAttribute('title') || '');
      const inner = svg.querySelector('title');
      if (inner) names.push(inner.textContent || '');
    }
    return names;
  };
  /* The same thing said in words rather than in a glyph. Some builds label the
     tick instead of naming it, and a label is not obfuscated. */
  const OUTGOING_LABEL =
    /^(sent|delivered|read|pending|تم الإرسال|تم الارسال|تم التسليم|تمت القراءة|قيد الانتظار)$/i;

  /* Who spoke, in a group row: the sender is its own element followed by a bare
     ":" element, and a one-to-one row has neither. Verified against live rows:
     groups yield "You", "+20 11 18856364", "@eng_mahmoudmajed", and direct chats
     correctly yield nothing. Reading the position of that ":" beats matching
     WhatsApp's class names, which are obfuscated and rotate every build. */
  const senderIn = row => {
    const lines = ((row && row.innerText) || '').split('\n').map(strip);
    const colon = lines.indexOf(':');
    /* WhatsApp marks a name it took from the sender's profile rather than from
       the user's contacts with a leading tilde -- "~Amr Mostafa". That is a note
       to the reader about where the name came from, not part of it, and it has
       no business being printed on a banner. */
    return colon > 0 ? lines[colon - 1].replace(/^~\s*/, '') : '';
  };

  /* WhatsApp writes the sender in front of the preview, and for a message of our
     own it writes the localised word for "you". That is the signal the delivery
     tick could not be: the tick is an <svg> whose only marking is a name that
     rotates with the build, so a build that renames it puts a banner over every
     message the user sends -- which is what "sometimes I send a message to a
     group and I get a notification of it" was, with "You:" printed in the banner
     for anyone to read. The word is checked in the languages the client is
     likely to be run in, and it costs nothing when it does not match. */
  const SELF_SENDER = /^(you|أنت|انت|أنتَ|أنتِ)$/i;

  /* What WhatsApp writes into a chat-list preview when somebody reacts to one of
     the user's messages. Measured on the live list rather than guessed, because
     the guess was wrong: the preview reads `~Ahmed reacted \u{1F44D} to: "..."`,
     so the verb is in the middle and an anchored test never matched it. The
     user's own reaction is written `You reacted ... to: "..."` and is caught by
     the sender test below like any other message of their own.

     Nothing is put in front of it: the reaction the sender chose is already in
     that text, and a glyph here would be a second emoji beside it. */
  const REACTION_PREVIEW = /\b(reacted|تفاعل)\b/i;

  const isOutgoing = el => {
    if (!el) return false;
    if (iconNames(el).some(n => OUTGOING_ICON.test(n))) return true;
    if ([...el.querySelectorAll('[aria-label]')]
          .some(e => OUTGOING_LABEL.test(strip(e.getAttribute('aria-label'))))) return true;
    return SELF_SENDER.test(senderIn(el));
  };

  /* WhatsApp leaves muted chats out of its own notifications, so this client
     does too -- with the one exception the phone makes as well. */
  const MUTED_LABEL = /muted|مكتوم|كتم/i;
  const isMuted = row => [...row.querySelectorAll('[aria-label]')]
      .some(e => MUTED_LABEL.test(e.getAttribute('aria-label') || ''));

  /* A message addressed to the user by name, which is the one thing that gets
     through a muted group -- on the phone and here. WhatsApp marks such a row in
     the chat list with an @ badge of its own, so this reads the badge rather than
     trying to find the user's own name inside the message text: a partial match
     against a display name would call every "@everyone" and every mention of
     somebody else a mention of the user, and the spec is explicit that it must
     not. A reply to one of the user's own messages is marked the same way. */
  /* "alternate-email" is the @ sign, and it is what this build actually draws --
     measured on the live list, where the one mentioned row carried
     <svg title="ic-alternate-email"> and nothing whatever containing the word
     "mention". The older names are kept beside it because they cost nothing and
     a build that goes back to them must not go quiet.

     Read through iconNames, which looks at the <svg title> and the <title> child
     as well as at data-icon. Reading data-icon alone is what made this return
     false for every row on this build: the badge has no data-icon at all, so
     every mention inside a muted group was silenced exactly like the messages it
     is supposed to be an exception to. */
  const MENTION_ICON  = /alternate-email|mention|reply|quoted|\bat-sign\b/i;
  const MENTION_LABEL = /mention|منشن|إشارة|اشارة|رد على|replied to you/i;
  const isMention = row => {
    if (!row) return false;
    if (iconNames(row).some(name => MENTION_ICON.test(name))) return true;
    return [...row.querySelectorAll('[aria-label]')]
      .some(e => MENTION_LABEL.test(e.getAttribute('aria-label') || ''));
  };

  /* Whether a row is a group rather than one person.
   *
   * This exists for one question the app cannot answer on its own: WhatsApp
   * writes "Sender: message" into the body of a GROUP notification and writes
   * the bare message into a direct one, and there is nothing in the text that
   * distinguishes the two. Split on the colon regardless and a direct message
   * reading "the link is https://example.com/x" goes out with "the link is
   * https" printed as the person who wrote it.
   *
   * Three signals, any of which settles it: a group or community icon; the
   * third span[title] that only a community group draws; and a sender line for
   * somebody other than the user, which a direct chat never has. The user's own
   * name is excluded because a direct chat does write "You:" in front of the
   * last message when it was theirs. */
  const GROUP_ICON = /group|communit/i;
  const isGroupRow = row => {
    if (!row) return false;
    if (iconNames(row).some(name => GROUP_ICON.test(name))) return true;
    if (titlesIn(row).length >= 3) return true;
    const who = senderIn(row);
    return !!who && !SELF_SENDER.test(who);
  };

  /* Whether this row is one the client should stay quiet about. Muted, unless
     the user was named in it. */
  const isSilenced = row => isMuted(row) && !isMention(row);

  const UNREAD_LABEL = /unread|غير مقروء/i;
  const unreadCount = row => {
    if (!row) return 0;
    for (const el of row.querySelectorAll('[aria-label]')) {
      const label = el.getAttribute('aria-label') || '';
      if (!UNREAD_LABEL.test(label)) continue;
      const digits = label.match(/\d+/);
      return digits ? parseInt(digits[0], 10) : 1;
    }
    for (const el of row.querySelectorAll('[data-icon]')) {
      const icon = el.getAttribute('data-icon') || '';
      if (/unread/i.test(icon)) {
        const digits = (el.innerText || el.getAttribute('aria-label') || '').match(/\d+/);
        return digits ? parseInt(digits[0], 10) : 1;
      }
    }
    return 0;
  };

  /* The app is told that something landed; it then asks what. Only the nudge is
     pushed -- pushing the description is the race that used to make every banner
     read "You have a new message". */
  /* Silent while the store is answering: two paths reporting one message is two
     banners, and the store's report is the better of the two in every way the
     other one was measured to be wrong. */
  const ping = () => { if (!storeLive()) send('arrival', null); };

  /* Keyed on the row itself, never on the chat name: two chats can carry the same
     name -- this account has four such pairs, and keying by name made each scan
     read one row's preview as the other's, so every single pass reported an
     arrival that had not happened. */
  const rowState = new WeakMap();
  const ARRIVAL_TTL_MS = 30000;
  /* How long an arrival may wait for the app to ask about it. The nudge is
     dropped whenever the window is not active in the moment it lands, and the
     entry it was for used to sit in the queue for the full thirty seconds -- so
     the next ask after the window came back answered with it and put a banner
     over a message the user had already been told about. The app asks a quarter
     of a second after the nudge; past this, nobody is coming. */
  const ANSWER_WINDOW_MS = 5000;
  /* The list does not arrive in one piece: rows appear, and then their previews,
     their badges and their timestamps fill in behind them. Every one of those is
     a change to a row we have already seen, which is the shape of an arrival --
     and on the first launch after this watcher was written, two chats that had
     been sitting there for hours were announced as new. Nothing counts until the
     list has stood still for a moment. */
  const SETTLE_MS = 2500;
  let seeded = false;
  let seededAt = 0;

  /* The preview WhatsApp shows while the other side is writing, in the languages
     this client is likely to be run in. It comes in three shapes, and only the
     first was matched before: the bare "typing..." of a direct chat, "Mega is
     typing..." in an English group -- which is why a group announced somebody
     starting to write as though they had said something -- and "Ahmed: typing...",
     where the sender is written the way it is written in front of a message.

     Anchored at both ends on purpose: a message that merely begins with the word
     "typing" is a message, and swallowing it would cost a banner. \b cannot do
     that job here -- it is defined on ASCII word characters, so it never matches
     after Arabic. The name in front is matched loosely and the verb strictly, and
     English has to put a colon or a copula between the two; only Arabic gets the
     bare space its grammar needs. */
  const TYPING_VERB    = 'typing|recording(?: audio)?';
  const TYPING_VERB_AR = 'يكتب|يسجل';
  const TYPING_END     = '\\s*(?:\\.{1,3}|…)?$';
  const TYPING_PREVIEW = new RegExp([
    '^(?:' + TYPING_VERB + '|' + TYPING_VERB_AR + ')' + TYPING_END,
    '^[^:]{1,40}:\\s*(?:' + TYPING_VERB + '|' + TYPING_VERB_AR + ')' + TYPING_END,
    '^.{1,40}?\\s+(?:is|are)\\s+(?:' + TYPING_VERB + ')' + TYPING_END,
    '^.{1,40}?\\s+(?:' + TYPING_VERB_AR + ')' + TYPING_END,
  ].join('|'), 'i');
  const isTyping = preview => TYPING_PREVIEW.test(preview || '');

  /* What a row says when the message on it is not made of words.
   *
   * Each label carries the glyph of its kind, and that is not decoration. A
   * banner reading "Sticker" is indistinguishable from a banner over somebody
   * who typed the word sticker -- which is the whole complaint -- and the same
   * goes for "Photo", "Video" and every other one of these. The glyph is the one
   * thing a message of plain text can never produce here, because plain text
   * comes through with WhatsApp's own preview and never reaches this table.
   *
   * Ordered, and the order is load-bearing: a voice note's icon is named "ptt"
   * on some builds and "audio" on others, and "audio" would otherwise be read as
   * a music file; a GIF is a video to every icon set that does not name it. */
  const STICKER = wording.STICKER;

  const MEDIA_KINDS = [
    { icon: /sticker|ملصق/i,                         label: STICKER },
    { icon: /\bgif\b/i,                              label: '\u{1F39E}\uFE0F GIF' },
    { icon: /ptt|mic\b|headset|voice|رسالة صوتية/i,  label: '\u{1F3A4} Voice message' },
    { icon: /image|photo|camera|صورة/i,              label: '\u{1F4F7} Photo' },
    { icon: /videocam|video|فيديو/i,                label: '\u{1F3A5} Video' },
    { icon: /audio|music|أغنية|صوت/i,                label: '\u{1F3B5} Audio' },
    { icon: /poll|استطلاع/i,                         label: '\u{1F4CA} Poll' },
    { icon: /location|pin\b|موقع/i,                  label: '\u{1F4CD} Location' },
    { icon: /contact|vcard|جهة اتصال/i,              label: '\u{1F464} Contact' },
    { icon: /document|\bdoc\b|مستند|ملف/i,           label: '\u{1F4C4} Document' },
  ];

  /* The kind of a row, from its icons and then from whatever text it carries.
     Answers '' when nothing says: an empty preview is a row mid-render, and the
     caller has to be able to tell that from a row with nothing to say. */
  const mediaLabel = row => {
    if (!row) return '';
    const icons = iconNames(row);
    for (const kind of MEDIA_KINDS)
      if (icons.some(name => kind.icon.test(name))) return kind.label;

    const text = strip((row.innerText || '').split('\n').find(line => strip(line)) || '');
    return wording.mediaFromWords(text);
  };

  /* A preview WhatsApp handed over as words, given its glyph when the words name
     a kind of media rather than say something. The sender prefix rides along
     untouched -- it is put back on by the caller, not read from here. */
  const labelled = (preview, row) => {
    const said = strip(preview);
    if (!said) return said;
    const named = wording.mediaFromWords(said);
    if (named) return named;
    /* A voice note has no words to preview, so WhatsApp writes its LENGTH there:
       the row for one reads "0:41". A banner saying 0:41 tells the user nothing
       at all, and it is not even obviously a duration -- so the row is asked what
       kind of thing it is holding, and the length is kept after the label. */
    if (/^\d{1,2}:\d{2}$/.test(said)) {
      const kind = mediaLabel(row);
      return kind ? kind + ' (' + said + ')' : said;
    }
    return said;
  };

  /* What is read off a row on every pass. Three things move when a message lands,
     and it takes all three to catch every one: the preview, because that is the
     message; the timestamp, because a second "tamam" under the first leaves the
     preview identical and that message went unannounced; and the unread count,
     because two identical messages inside the same minute move nothing else. */
  /* The message a row is showing, which is the LAST of its titles and not the
     second.
   *
   * A plain chat draws two: the name and the message. A group inside a community
   * draws three -- the community, then the group, then the message -- and
   * reading the second of those announced "Graduation Project: Graduation
   * project", a banner whose body was the name of the chat it came from. Worse
   * than the wrong words: the preview then never changed from one message to the
   * next, so every arrival in a community had to be caught by the clock or the
   * unread pill instead, and the ones that moved neither were never announced at
   * all. Measured on the live list: seventy rows, and every community group in
   * it carried three. */
  const previewIn = (row, titles) => {
    const list = titles || titlesIn(row);
    if (list.length < 2) return '';
    const last = strip(list[list.length - 1].getAttribute('title'));
    /* A row mid-render can repeat the name where the message should be; that is
       not a message, and announcing it would be the bug this replaced. */
    return last === strip(list[0] && list[0].getAttribute('title')) ? '' : last;
  };

  const readRow = row => {
    const titles = titlesIn(row);
    const name = (titles[0] && strip(titles[0].getAttribute('title'))) || nameOf(row);
    let preview = labelled(previewIn(row, titles), row);

    if (!preview) preview = mediaLabel(row);

    return {
      name,
      preview: preview || '',
      badge:   unreadCount(row),
      when:    ((row.innerText || '').match(/\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/) || [''])[0],
    };
  };

  /* Whether the time a row shows is the time it is now. WhatsApp stamps a row
     with the time of its last message, so a row rewritten by a sync -- which is
     what the whole chat list does for half a minute after the client starts, and
     again after the network comes back -- carries an old one. Four conversations
     were announced fifteen seconds into a launch this way, and that is what "it
     shows me phantom notifications when I open it" was.

     Returns null rather than false when the format is not one this can read, so a
     locale that writes its clock in digits the regex above cannot match falls back
     to the unread count instead of going silent. */
  const FRESH_MS = 3 * 60 * 1000;
  const freshness = when => {
    const m = /^(\d{1,2}):(\d{2})(?:\s*([AP])\.?M\.?)?$/i.exec(when || '');
    if (!m) return null;

    let hour = parseInt(m[1], 10);
    if (m[3]) hour = (hour % 12) + (/p/i.test(m[3]) ? 12 : 0);

    const now = new Date();
    const stamp = new Date(now);
    stamp.setHours(hour, parseInt(m[2], 10), 0, 0);

    let age = now - stamp;
    if (age < -FRESH_MS) age += 24 * 60 * 60 * 1000;   // the clock has just passed midnight
    return age >= -FRESH_MS && age <= FRESH_MS;
  };

  /* Whether the difference between two readings of one row is a message landing.
     Comparing the readings wholesale is what put phantom banners on screen: the
     badge clears when a chat is read, so every conversation the user opened -- and
     the whole backlog clearing when the window came back from the tray -- looked
     exactly like an arrival. An unread count going DOWN is the user catching up,
     and is never news; a row whose clock says half an hour ago is WhatsApp
     rewriting it, not somebody writing to it. */
  const isArrival = (before, now) => {
    const changed = now.preview !== before.preview ||
                    now.when !== before.when ||
                    now.badge > before.badge;
    if (!changed) return false;

    const fresh = freshness(now.when);
    return fresh === null ? now.badge > before.badge : fresh;
  };

  /* What this client has already put on screen, so the guess at the bottom of
     describeUnread cannot say the same thing twice. Two records, because the two
     notification paths know different things: a reading, for the banners this side
     describes, and a bare chat name for the ones WhatsApp Web raises while the
     window is away -- a page notification arrives as a name and nothing else.

     This is what the duplicate banner was made of. With one chat open and another
     left unread, every ask the queue could not answer -- and the document title
     asks on its own, off its own count -- fell through to "the topmost unread row"
     and announced that chat's last message a second time, minutes after it had
     arrived and been announced. */
  const ANNOUNCED_TTL_MS = 10 * 60 * 1000;
  const NAME_TTL_MS      = 60 * 1000;
  /* How long after a row moves the guess may still credit an ask to it. The app
     asks a quarter second after it is nudged, so this is generous already. */
  const GUESS_WINDOW_MS  = 10 * 1000;
  const announced      = new Map();
  const announcedNames = new Map();

  /* The last thing said about each chat, and how long a repeat of it is read as
     the same message rather than as a new one. See the note at the bottom of
     describeUnread: a reply inside a community thread moves the group with the
     parent message still in its preview, and that is not an arrival. */
  const REPEAT_MS = 2 * 60 * 1000;
  const lastAnnounced = new Map();        // chat -> { preview, at }

  /*
   * The row each banner was made from, so clicking it opens THAT conversation.
   *
   * Two chats can carry one name, and on this account two do: a community and a
   * group inside it, both called "4th ECE Alazhar University" -- verified on the
   * live list, where they differ in nothing a lookup by name can see. Finding the
   * chat by name afterwards is therefore a coin toss, and the specification is
   * explicit that a click must open the conversation the message came from and
   * not the first row that happens to share its title.
   *
   * The element itself is the answer while it lives. WhatsApp recycles rows, so
   * it is not the only answer: the name and the message ride along with it, and
   * between them they find the row again when the original has been thrown away.
   */
  const OPENABLE_TTL_MS = 30 * 60 * 1000;
  let nextToken = 1;
  const openable = new Map();             // token -> { row, name, preview, at }

  const rememberOpenable = (row, name, preview) => {
    const token = String(nextToken++);
    openable.set(token, { row, name, preview, at: Date.now() });
    if (openable.size > 64) {
      const cutoff = Date.now() - OPENABLE_TTL_MS;
      for (const [key, held] of openable) if (held.at < cutoff) openable.delete(key);
      for (const key of openable.keys()) {
        if (openable.size <= 64) break;
        openable.delete(key);
      }
    }
    return token;
  };

  const sweepStamped = (map, ttl) => {
    const now = Date.now();
    if (map.size <= 128) return;
    for (const [key, value] of map) if (now - value.at > ttl) map.delete(key);
  };

  const sweep = (map, ttl) => {
    const now = Date.now();
    if (map.size > 128)
      for (const [key, at] of map) if (now - at > ttl) map.delete(key);
  };
  /* Deliberately without the unread count: the pill is drawn a beat after the
     preview, so the same message can be read once with a badge and once without,
     and a key that disagreed with itself would let the guess through. */
  const readingKey = state => [state.name, state.preview, state.when].join(SEP);

  const wasAnnounced = state => {
    const now   = Date.now();
    const said  = announced.get(readingKey(state));
    const named = announcedNames.get(state.name);
    return (said  !== undefined && now - said  < ANNOUNCED_TTL_MS) ||
           (named !== undefined && now - named < NAME_TTL_MS);
  };
  const rememberAnnounced = state => {
    announced.set(readingKey(state), Date.now());
    sweep(announced, ANNOUNCED_TTL_MS);
  };
  const rememberName = name => {
    const wanted = strip(name);
    if (!wanted) return;
    announcedNames.set(wanted, Date.now());
    sweep(announcedNames, NAME_TTL_MS);
  };

  /*
   * Where each chat's face was, the last time its row was on screen.
   *
   * #pane-side is not always there. Opening a picture full-screen unmounts the
   * whole chat list, and so does a call: a notification that arrives in that
   * moment finds no row to take a face from, and goes out wearing the app's own
   * icon instead of the group's. That is the report -- a message from a group
   * that plainly has a picture, announced without one, while a picture happened
   * to be open in another chat. It cost the chat name as well, which is worse
   * than a missing face: the key a notification is filed under is what withdraws
   * it when the message is read, and a key nothing recognises never comes down.
   *
   * The URL is what is kept, not the bytes. Reading it off a row costs one
   * property access per scan, the bytes are in the page's own HTTP cache
   * already, and a face that has genuinely changed is re-fetched the next time
   * the row is drawn.
   */
  const chatFaces = new Map();            // chat name -> { url, group, at }
  const FACES_TTL_MS = 12 * 60 * 60 * 1000;
  const FACES_MAX = 256;

  /*
   * The picture on a row, and never the placeholder standing in for one.
   *
   * A row whose avatar has not been fetched yet carries an <img> all the same,
   * pointing at a one-pixel transparent GIF as a data: URL. Taking that as the
   * face is how a message from a group with a perfectly good picture arrived
   * wearing the application's icon -- measured on the live list, where the
   * community's announcement row held exactly that placeholder while the row
   * above it held the real 96x96 image.
   *
   * So a data: URL is never a face, and neither is anything the page has decoded
   * to fewer than sixteen pixels across. naturalWidth is 0 for an image still
   * loading, which is not a reason to reject it: the fetch below asks the network
   * and the cache, not this element.
   */
  const faceUrlIn = row => {
    for (const img of (row ? row.querySelectorAll('img') : [])) {
      const src = img.src || '';
      if (!/^https?:|^blob:/.test(src)) continue;
      if (img.naturalWidth && img.naturalWidth < 16) continue;
      return src;
    }
    return '';
  };

  const rememberFace = (name, row) => {
    if (!name) return;
    const url = faceUrlIn(row);
    /* The picture may not have loaded, and the answer to "is this a group" does
       not depend on it. A row is remembered for either, and a face that arrives
       later is written over the entry rather than beside it. */
    const before = chatFaces.get(name);
    chatFaces.set(name, {
      url: url || (before && before.url) || '',
      group: isGroupRow(row),
      at: Date.now(),
    });
    if (chatFaces.size > FACES_MAX) {
      const cutoff = Date.now() - FACES_TTL_MS;
      for (const [key, seen] of chatFaces) if (seen.at < cutoff) chatFaces.delete(key);
      /* Still over after the sweep: the oldest go, in insertion order, which is
         the order a Map iterates. */
      for (const key of chatFaces.keys()) {
        if (chatFaces.size <= FACES_MAX) break;
        chatFaces.delete(key);
      }
    }
  };

  const scanList = () => {
    const pane = document.querySelector('#pane-side');
    if (!pane) return;

    for (const row of pane.querySelectorAll('[role="row"]')) {
      const now = readRow(row);
      if (!now.name) continue;

      /* Kept on every pass, arrival or not: this is the only moment the list is
         guaranteed to be on screen, and a notification that arrives once it is
         not has nowhere else to find the chat's picture. */
      rememberFace(now.name, row);

      const before = rowState.get(row);

      /* Neither of these is a message, and both are skipped before the row's
         state is recorded, so the text that replaces them matches what was there
         before and does not read as an arrival of its own. "typing..." is what
         WhatsApp writes in the preview while the other side is still writing --
         it announced "Mega -- typing..." as though it were something somebody had
         said -- and an empty preview is a row mid-render. */
      if (isTyping(now.preview)) continue;
      if (!now.preview && before !== undefined) continue;

      /* When this row last said something different. The guess leans on it: a row
         that has been showing the same message since before the ask is not the row
         the message being asked about landed in. A row seen for the first time
         counts as having just changed -- one appearing at the top of the list is
         the whole reason the guess exists -- but only once the list has settled,
         or a chat left unread since yesterday would be announced on the opening
         pass. */
      const settled = seeded && Date.now() - seededAt >= SETTLE_MS;
      now.changedAt = !settled ? 0
                    : (before && before.preview === now.preview &&
                       before.when === now.when && before.badge === now.badge)
                    ? before.changedAt : Date.now();
      rowState.set(row, now);

      /* A row we are seeing for the first time is not news -- only one we already
         knew, whose message has since changed. */
      if (!seeded || before === undefined) continue;
      if (Date.now() - seededAt < SETTLE_MS) continue;
      /* Reactions get their own line in the log, and only reactions. They are
         the one arrival whose row keeps the delivery tick of the message it
         landed on, so they pass through more tests than anything else does and
         "no notification came" has more places to have happened. The chat is
         named and the reaction is not: what somebody chose to react with is as
         much their message as the words would have been. */
      const isReaction = REACTION_PREVIEW.test(now.preview);
      if (!isArrival(before, now)) {
        if (isReaction) log('a reaction in "' + now.name + '" did not read as an arrival');
        continue;
      }
      if (isSilenced(row)) {
        if (isReaction) log('a reaction in "' + now.name + '" is in a muted chat');
        continue;
      }
      /* The delivery tick says the last message in this row is the user's own,
         and that is normally the end of it. A reaction is the exception: it is
         somebody else's event landing on the user's own message, so the row
         keeps the tick and WhatsApp rewrites the preview to say what happened.
         The phone announces those, and without this the row is read as an echo
         of a message the user sent and dropped. Narrow on purpose -- only a
         preview that opens with WhatsApp's own word for it gets past the guard,
         and the user's own reaction is written "You reacted", which does not. */
      if (isOutgoing(row) && !isReaction) continue;

      /* Nothing is queued while the window is away: WhatsApp raises its own
         notification then, and the app dresses that one instead. A queue built up
         in the background used to be handed over the moment the window came back,
         and every message in it was announced a second time. */
      if (!focused) {
        if (isReaction)
          log('a reaction in "' + now.name + '" arrived with the window away; ' +
              'WhatsApp raises that one');
        continue;
      }

      /* Queued per message rather than per chat: the app asks once for each one,
         and collapsing them here is what swallowed the second and third message of
         a burst from the same person. */
      if (isReaction) log('a reaction in "' + now.name + '" is queued');
      arrivals.push({ row, name: now.name, preview: now.preview,
                      sender: senderIn(row), at: Date.now() });
      ping();
    }

    const cutoff = Date.now() - ARRIVAL_TTL_MS;
    arrivals = arrivals.filter(a => a.at > cutoff);
    /* Deep enough for a burst the app has not caught up with yet; it asks once per
       message, so this is a backstop, not a queue depth. */
    if (arrivals.length > 16) arrivals = arrivals.slice(-16);
    if (!seeded) { seeded = true; seededAt = Date.now(); }

    reportUnread(pane);
    reportOpen();
  };

  /* Which chats still have something waiting. A notification is an unread
     message made visible, so the app withdraws one as soon as its chat stops
     being unread -- and that covers being read on the phone just as well as
     here, because WhatsApp Web clears the pill for both. Reported only when the
     answer changes, which is a handful of messages an hour rather than one
     message per scan. */
  let lastUnread = null;
  let lastCount = null;
  const knownUnread = new Map();          // chat -> { at, count }
  const UNREAD_GRACE_MS = 2500;
  /* How long a chat that has stopped being rendered is still believed to be
     unread. Longer than the grace above because scrolling a name out of the list
     says nothing about whether it was read. */
  const OFFSCREEN_MS = 60000;

  /* Another look, later.
   *
   * This watcher is driven by a MutationObserver and by nothing else -- there is
   * no timer behind it -- so a decision that was DEFERRED is a decision never
   * taken again, unless something else happens to move the list. That is what
   * "the notification only goes away when I open the app" was: reading a message
   * on the phone clears the unread pill, the mutation that clears it is the last
   * one the list makes, and the scan it triggers finds the chat inside its grace
   * window and keeps it. Opening the app was simply the next thing to move the
   * DOM. So whenever a name is held rather than judged, the moment it becomes
   * judgeable is booked here. One timer, coalesced to the soonest. */
  /* And a heartbeat under all of it, for the cases a mutation never comes at all.
   *
   * The list is watched by a MutationObserver, so everything this client knows
   * about a chat being read arrives as a change to the DOM. That is enough when
   * WhatsApp redraws the row -- and it is not something to depend on for the one
   * case that matters most: a message read on the PHONE, with the window in the
   * tray or simply behind something else, where the whole of WhatsApp's answer
   * may be a single attribute going away.
   *
   * So while any chat is being tracked as unread, the list is re-read every few
   * seconds regardless. It costs nothing when the client is caught up -- there is
   * no timer at all then -- and it is the difference between a banner that goes
   * when the message is read and one that goes when the user next opens the
   * window. */
  const SWEEP_MS = 3000;
  let sweeping = false;
  const sweepLater = () => {
    if (sweeping) return;
    sweeping = true;
    setTimeout(() => {
      sweeping = false;
      const pane = document.querySelector('#pane-side');
      if (!pane || !knownUnread.size) return;
      reportUnread(pane);          // which arms the next one if anything is left
    }, SWEEP_MS);
  };

  let regrade = 0;
  let regradeAt = 0;
  const scanSoon = ms => {
    const when = Date.now() + ms;
    if (regrade && regradeAt <= when) return;
    if (regrade) clearTimeout(regrade);
    regradeAt = when;
    regrade = setTimeout(() => { regrade = 0; scanList(); }, ms);
  };

  const reportUnread = pane => {
    const now = Date.now();
    const currentUnread = new Set();
    const renderedNames = new Set();

    for (const row of pane.querySelectorAll('[role="row"]')) {
      const name = nameOf(row);
      if (!name) continue;
      renderedNames.add(name);
      const waiting = unreadCount(row);
      if (waiting > 0) {
        currentUnread.add(name);
        /* Silenced is carried alongside the count, for the badge below. The
           withdrawal list keeps every unread chat regardless: a mention in a
           muted group does raise a banner, and a banner has to be withdrawable
           whatever the chat it came from. */
        knownUnread.set(name, { at: now, count: waiting, silenced: isSilenced(row) });
      }
    }

    if (!renderedNames.size && !pane.querySelector('[role="row"]')) return;

    const names = [];
    /* The soonest moment at which one of the names below stops being held and
       becomes a decision. Zero when nothing is being held. */
    let judgeIn = 0;
    const hold = until => {
      const left = Math.max(0, until - now);
      if (!judgeIn || left < judgeIn) judgeIn = left;
    };

    for (const [name, seen] of knownUnread.entries()) {
      if (currentUnread.has(name)) {
        names.push(name);
      } else if (renderedNames.has(name)) {
        const open = openRow();
        const isOpenChat = open && nameOf(open) === name && focused;
        if (!isOpenChat && (now - seen.at < UNREAD_GRACE_MS)) {
          names.push(name);
          hold(seen.at + UNREAD_GRACE_MS);
        } else {
          knownUnread.delete(name);
        }
      } else {
        if (now - seen.at < OFFSCREEN_MS) {
          names.push(name);
          hold(seen.at + OFFSCREEN_MS);
        } else {
          knownUnread.delete(name);
        }
      }
    }
    if (judgeIn) scanSoon(judgeIn + 100);
    if (knownUnread.size) sweepLater();

    const key = names.sort().join(SEP);
    if (key !== lastUnread) {
      lastUnread = key;
      if (!storeLive()) send('unread-chats', names);
    }

    /* And the number the launcher draws on the icon.
     *
     * The document title cannot supply it, and it is wrong in two ways at once.
     * Its "(3)" counts unread CHATS rather than messages, so three conversations
     * holding eleven messages between them put a 3 on an icon where the phone
     * shows 11. And it leaves muted chats out of even that -- measured on this
     * account, where the title read "(3)" with six chats unread.
     *
     * The pills carry the real number and they are already being read here. Muted
     * chats stay out, which is the title's one good instinct and the phone's rule
     * as well: a badge counts what the user was told about, and a muted chat is
     * one they asked not to be told about. A mention inside one is not muted, so
     * it counts. */
    let messages = 0;
    let chats = 0;
    for (const name of names) {
      const seen = knownUnread.get(name);
      if (!seen || seen.silenced) continue;
      messages += seen.count || 1;
      chats++;
    }
    const counted = chats + SEP + messages;
    if (counted !== lastCount) {
      lastCount = counted;
      if (!storeLive()) send('unread-count', { chats, messages });
    }
  };

  /* Which chat the user is looking at. The unread report above is an inference
     -- no pill, so it must have been read -- and it arrives a beat after the
     fact, late enough that the app has to hold a banner raised a moment ago
     safe from it. This is the answer instead: a chat drawn on screen in a window
     that has focus is a chat being read, and its banner can go now.

     Reported on change, and again whenever the window comes back: a chat that
     was already open when the window went away is being read the moment it
     returns, and nothing about the chat itself changes to say so. */
  let lastOpen = null;
  const reportOpen = () => {
    /* A picture opened full-screen, or a call, takes the whole chat list off the
       page -- and a list that is not rendered is not a chat that has been
       closed. Reporting "nothing is open" for it would withdraw the banner for
       the conversation the user is still sitting in, and then have nothing to
       say when it came back, because this only speaks when the answer changes. */
    if (!document.querySelector('#pane-side')) return;
    const row = openRow();
    const name = row ? nameOf(row) : '';
    if (name === lastOpen) return;
    lastOpen = name;
    if (!storeLive()) send('open-chat', name);
  };
  const refreshOpen = () => { lastOpen = null; reportOpen(); };

  const watchList = () => {
    const pane = document.querySelector('#pane-side');
    if (!pane || pane.__waWatched) return;
    pane.__waWatched = true;

    scanList();                       // seed first, so the opening pass is silent
    let timer = 0;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(scanList, 150);
    /* aria-selected is in the filter for the report of which chat is on screen:
       opening one usually rewrites its row anyway, by clearing the unread pill,
       but a chat that was already caught up moves nothing else at all. */
    }).observe(pane, { childList: true, subtree: true, characterData: true,
                       attributes: true, attributeFilter: ['title', 'aria-selected'] });
    log('watching the chat list for arrivals');
  };

  /* #pane-side is rebuilt when the client re-renders, taking the observer with it,
     so the watch is re-established rather than set up once. */
  setInterval(watchList, 4000);
  addEventListener('load', watchList);

  /* The row for a chat WhatsApp has re-rendered since. Rows are recycled freely,
     and an arrival whose element was thrown away in the 250ms before the app asked
     about it used to fall through to "nothing identified" -- which is what raised
     a banner reading "You have a new message" over a conversation the user was
     already reading. The message rides along with the name, so a chat that shares
     its name with another is still told apart. */
  const findRow = (name, preview) => {
    const pane = document.querySelector('#pane-side');
    for (const row of (pane ? pane.querySelectorAll('[role="row"]') : [])) {
      const titles = titlesIn(row);
      if (strip(titles[0] && titles[0].getAttribute('title')) !== name) continue;
      if (preview && labelled(previewIn(row, titles), row) !== preview) continue;
      return row;
    }
    return null;
  };

  /* The text of the last message drawn in the conversation on screen. */
  const lastOnScreen = () => {
    const main = document.querySelector('#main');
    const rows = main ? main.querySelectorAll('[role="row"]') : [];
    const last = rows[rows.length - 1];
    return last ? strip(last.innerText) : '';
  };

  /* Whether this row is the conversation the user is looking at. Element identity
     answers it whenever the row survived; when WhatsApp recycled it the name has
     to, and the name alone is not enough -- this account has four pairs of chats
     that share one -- so the message has to be on screen as well. */
  const isOpen = (row, preview) => {
    const open = openRow();
    if (!open) return false;

    /* A row still wearing an unread pill is not the conversation on screen,
       whatever else it looks like. WhatsApp clears that pill the moment it draws a
       chat in a window that has focus, and this watcher only runs while the window
       has focus. Without it the client went silent for a whole burst: ten messages
       landed in a chat sitting at ten unread, and every one of them was answered
       "the message is in the chat on screen". */
    if (unreadCount(row) > 0) return false;
    if (row === open) return true;

    const name = nameOf(row);
    if (!name || name !== nameOf(open)) return false;
    /* Short text cannot carry this test. The message has to be found in the
       conversation on screen, and a one-letter message is inside the last bubble's
       text by accident -- with two chats sharing a name, that silenced the wrong
       one. */
    const text = strip(preview).replace(/…$/, '');
    return text.length >= 3 && lastOnScreen().indexOf(text) >= 0;
  };

  /* ---------------------------------------------------------------- pictures */

  /* Fetched once per URL and kept. The same face comes back for every message of a
     burst, and a network round trip in front of every banner is a banner that
     arrives late. */
  const avatars = new Map();
  const AVATAR_MAX_BYTES = 200000;
  const AVATAR_TIMEOUT_MS = 1200;

  const bytesToBase64 = bytes => {
    let binary = '';
    /* In chunks: fromCharCode.apply over the whole array blows the argument limit,
       and a character at a time over 200 KB is slow enough to be felt as a
       stutter, since this runs on the page's own thread. */
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return btoa(binary);
  };

  /* The <img> is already on screen but its canvas is tainted, so the bytes are
     re-fetched instead -- the CDN answers a plain fetch with CORS, verified
     against a live avatar (200 image/jpeg). */
  const fetchAvatar = async src => {
    if (avatars.has(src)) return avatars.get(src);

    let encoded = '';
    try {
      const response = await fetch(src);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length && bytes.length <= AVATAR_MAX_BYTES) encoded = bytesToBase64(bytes);
      }
    } catch (e) { /* offline, or the URL expired: the app icon will do */ }

    if (avatars.size > 64) avatars.clear();
    avatars.set(src, encoded);
    return encoded;
  };

  /* A picture must never hold a notification up. Better plain than late. */
  const withTimeout = promise => Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(''), AVATAR_TIMEOUT_MS)),
  ]);

  const avatarOf = async (row, name) => {
    const url = faceUrlIn(row) ||
                (chatFaces.get(strip(name) || nameOf(row)) || {}).url || '';
    if (!url) return '';
    return withTimeout(fetchAvatar(url));
  };

  /* The row a notification WhatsApp raised belongs to. WhatsApp titles a group
     notification with the group name and a direct one with the contact, so an
     exact match is tried first and a containing one after it. */
  const rowFor = name => {
    const wanted = strip(name);
    if (!wanted) return null;

    const pane = document.querySelector('#pane-side');
    const rows = [...(pane ? pane.querySelectorAll('[role="row"]') : [])];
    const exact = rows.find(row => nameOf(row) === wanted);
    if (exact) return exact;

    return rows.find(row => {
      const rowName = nameOf(row);
      return rowName.length > 2 &&
             (wanted.indexOf(rowName) >= 0 || rowName.indexOf(wanted) >= 0);
    }) || null;
  };

  /* The chat-list name for a notification WhatsApp titled itself, found in the
     rendered list when there is one and in the names this client has seen when
     there is not. Every withdrawal speaks chat-list names, so a notification
     filed under WhatsApp's own wording of who wrote is one nothing can take
     down again -- and while the list is unmounted, WhatsApp's wording was all
     there used to be. */
  const chatNameFor = name => {
    const wanted = strip(name);
    if (!wanted) return '';

    const row = rowFor(wanted);
    if (row) return nameOf(row);

    if (chatFaces.has(wanted)) return wanted;
    for (const known of chatFaces.keys())
      if (known.length > 2 && (wanted.indexOf(known) >= 0 || known.indexOf(wanted) >= 0))
        return known;
    return '';
  };

  /* Whether the chat a notification belongs to is a group, for the app's benefit
     when it comes to read WhatsApp's wording of the body. Answers null when
     there is nothing on record, which is not the same as "no": the app has a
     cautious reading for that case and a decisive one for this. */
  const chatKindFor = name => {
    const row = rowFor(strip(name));
    if (row) return isGroupRow(row);
    /* From memory, "yes" is worth having and "no" is not. The signals for a
       group are all positive ones -- an icon, a third title, somebody else's
       name in front of the last message -- so their absence means either a
       one-to-one chat or a group whose last message was the user's own, and
       there is no telling which. Answering false for the second would stop the
       sender being lifted out of the body, and an Arabic message then reads its
       direction off the Latin name in front of it and wraps the wrong way. */
    const known = chatFaces.get(chatNameFor(name));
    return known && known.group ? true : null;
  };

  /* Asked by name when the notification is one the page raised.

     This is only ever asked while a banner for that chat is on its way out, so
     it doubles as the record of it. Nothing else tells this side that WhatsApp
     Web announced something while the window was away, and without it the guess
     in describeUnread would announce the same chat again the moment the window
     came back and anything asked. */
  const avatarFor = async name => {
    const wanted = strip(name);
    if (!wanted) return '';
    rememberName(wanted);

    const match = rowFor(wanted);
    if (match) return avatarOf(match, wanted);

    /* No row -- the list is not rendered. The face this chat wore the last time
       it was is the right one; a group's picture does not change between one
       message and the next. */
    const remembered = chatFaces.get(chatNameFor(wanted) || wanted);
    return remembered ? withTimeout(fetchAvatar(remembered.url)) : '';
  };

  /* Opening a chat from a banner raised on this side.
   *
   * A banner WhatsApp Web raised carries its own click handler back into the
   * page, and WhatsApp opens the conversation itself -- that is the window-away
   * half, and it has always worked. The watcher's banners, the ones raised while
   * the window is in front, had nothing of the kind: clicking one raised the
   * window and left the user looking at whatever chat they were already in.
   *
   * Nothing on this side knows how to navigate WhatsApp Web except by doing what
   * the user would do, which is press the row in the list. It is found by name,
   * the same lookup the banner's key came from, so the two cannot disagree, and
   * the list is virtualised but a chat that has just received a message is at
   * the top of it -- which is the part that is rendered.
   *
   * Where the press is aimed matters more than what is in it. A row's handler
   * is not on the row: it is on an element inside it, and an event dispatched at
   * the row -- or at the [role="gridcell"] immediately under it -- travels
   * upwards from there and never reaches it. Measured on the live page, in this
   * order: pressing the row opened nothing, pressing the gridcell opened
   * nothing, pressing the deepest node inside the row opened the chat. So the
   * target is the name itself, which every chat row carries and which sits under
   * every handler between it and the row.
   *
   * The whole press goes out and not a bare .click(): the row answers to pointer
   * and mouse events both, and which of them opens a conversation is WhatsApp's
   * business rather than something to depend on. */
  const press = (element, target) => {
    if (!element) return;
    target = target || element;
    const box = element.getBoundingClientRect();
    const where = {
      bubbles: true, cancelable: true, view: window, button: 0, buttons: 1,
      clientX: Math.round(box.left + box.width / 2),
      clientY: Math.round(box.top + box.height / 2),
    };
    const pointer = Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, where);
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const isPointer = type.indexOf('pointer') === 0;
      const Kind = isPointer && window.PointerEvent ? window.PointerEvent : window.MouseEvent;
      try {
        target.dispatchEvent(new Kind(type, isPointer ? pointer : where));
      } catch (err) { /* a kind this build does not construct; the rest still go */ }
    }
  };

  const pressRow = row => press(row, row.querySelector('span[title]') || row);

  on('open-chat-request', request => {
    /* A bare name is still accepted: it is what the click carried before the
       banners started remembering which row they were made from. */
    const wanted = typeof request === 'string' ? { name: request } : (request || {});
    const held = wanted.token ? openable.get(wanted.token) : null;
    const name = wanted.name || (held && held.name) || '';
    const preview = wanted.preview || (held && held.preview) || '';

    /* The row it was actually made from, while it is still on the page. Then the
       row carrying that same message, which tells two chats of one name apart.
       Then, and only then, the first row with the name. */
    const row = (held && held.row && held.row.isConnected ? held.row : null) ||
                findRow(name, preview) ||
                rowFor(name);
    if (!row) { log('cannot open "' + name + '": no row for it in the rendered list'); return; }
    if (wanted.token) openable.delete(wanted.token);
    pressRow(row);
    /* Said as soon as the page has drawn it rather than waited for: which chat
       is on screen is what takes the banner down, and the observer that would
       report it on its own fires a beat later than the click does. */
    setTimeout(refreshOpen, 400);
  });

  /* ------------------------------------------------------- Escape and panels */

  /*
   * Escape closes the emoji panel, whether or not an emoji has been picked.
   *
   * Every line of this was measured against the live page, and each measurement
   * killed a fix that had looked obvious:
   *
   *   The button carries no aria-expanded -- the attribute is absent, open or
   *   shut -- so there is nothing to ask whether the panel is up. What is up is
   *   read off the panel instead: it is the page's only [role="application"].
   *
   *   It carries no data-icon either. Every icon on this build is an <svg> whose
   *   only marking is a <title> child, so the button is found by its label and
   *   by that title, never by data-icon.
   *
   *   Picking an emoji moves focus to an <input> inside the panel, the "Search
   *   emoji" box. That is the bug entire: WhatsApp's Escape handler is on the
   *   composer, and a key typed into a box that is not the composer never
   *   reaches it. Which is the report exactly -- it closes if you have not
   *   picked one, and does not if you have.
   *
   *   Escape does not close it however it is delivered: dispatched at the panel,
   *   at the search box, or sent into the window as a real key by the app. Nor
   *   does a click outside. The one thing that closes it is the button, pressed
   *   the way the row of a chat has to be pressed -- at the deepest node inside
   *   it, because the handler is not on the button but on an element under it,
   *   and an event dispatched at the button travels upwards and never reaches it.
   *
   * The trusted-key route was tried and is gone. It also taught something worth
   * keeping written down: a key the app injects arrives back here as an ordinary
   * keydown, this handler caught it, asked for another, and the two processes
   * threw Escapes at each other until the renderer stopped answering at all.
   */
  const PANEL_LABEL = /emoji|sticker|gif|رموز|ملصق|إيموجي|ايموجي/i;
  const PANEL_ICON  = /smil|emoji|sticker|gif/i;

  const emojiPanel = () => {
    const panel = document.querySelector('[role="application"]');
    if (!panel) return null;
    /* It has to be the composer's panel and not something else claiming the
       role -- a call window would, and Escape belongs to the call then. */
    return (panel.querySelector('[role="tab"]') || panel.querySelector('input')) ? panel : null;
  };

  const composer = () =>
    document.querySelector('#main [contenteditable="true"]') ||
    document.querySelector('footer [contenteditable="true"]');

  /* The name of an icon, wherever this build happens to keep it. */
  const iconTitle = el => {
    const own = el.getAttribute('data-icon');
    if (own) return own;
    const inner = el.querySelector('[data-icon]');
    if (inner) return inner.getAttribute('data-icon') || '';
    const svg = el.querySelector('svg title');
    return svg ? svg.textContent || '' : '';
  };

  const panelButton = () => {
    const footer = document.querySelector('footer') || document;
    for (const el of footer.querySelectorAll('button, [role="button"]')) {
      const label = strip(el.getAttribute('aria-label'));
      if (PANEL_LABEL.test(label) || PANEL_ICON.test(iconTitle(el))) return el;
    }
    return null;
  };

  /* The node an event has to be aimed at for a handler above it to see it. */
  const deepestIn = el => {
    let node = el;
    while (node.firstElementChild) node = node.firstElementChild;
    return node;
  };

  /* Escape, when WhatsApp swallows it and closes nothing.
   *
   * Escape closes an ordinary conversation -- WhatsApp's own handler does that,
   * and there are twenty-odd keydown listeners on window that look like one per
   * mounted panel. It does NOT close a conversation inside a community, and the
   * live page finally said why. Three listeners of this file's own, one at each
   * point of the dispatch, watched a real key sent by the app:
   *
   *   an ordinary chat -- the key arrives at window's capture phase unprevented,
   *   travels the whole way to the bubble phase, and the conversation is already
   *   gone by the time it gets there. Nothing consumed it; something acted on it.
   *
   *   a community subgroup -- by window's capture phase defaultPrevented is
   *   ALREADY true, and the key never reaches the bubble phase at all. Something
   *   the community view mounts answers Escape, calls preventDefault and
   *   stopPropagation, and then closes nothing. The conversation stays up.
   *
   * So there was never anything to retry: the key was not missed, it was eaten.
   * Sending a second one -- at the document, with the caret out of the composer,
   * which is what stood here before -- only fed the same handler again, and was
   * measured doing nothing both times. What closes it is WhatsApp's own
   * closeActiveChat, and failing that its menu's own "Close chat", pressed the
   * way every control on this page has to be.
   *
   * The one thing this must never do is close a conversation for an Escape that
   * was for something else -- a dropdown, the profile drawer, in-chat search, a
   * reply being cancelled. Every one of those leaves the conversation open too,
   * so "still open" is not the test. What they are told apart by is timing, and
   * the timings were measured one at a time:
   *
   *   a dropdown is the slow one. It stays in the DOM for its exit animation --
   *   141ms and 147ms in two runs -- and a MutationObserver over the whole of
   *   #app saw NOTHING before that, not an attribute, not a class. Nothing can
   *   tell it apart from an Escape that did nothing, so waiting for it would put
   *   a seventh of a second in front of every close. It does not have to be
   *   waited for: a dropdown that is up is up at the keypress, and reading it
   *   there costs nothing.
   *
   *   everything else goes at once. The profile drawer was gone 27ms after the
   *   key. In-chat search closed inside the dispatch itself -- a listener
   *   registered after this one, on the same event, already saw it gone.
   *
   * So: a layer that is up at the keypress is answered by leaving Escape alone,
   * and everything else is caught by watching the page for a short moment. The
   * page is counted rather than reasoned about, because a count moves for a
   * layer this code has never heard of too. Measured at rest that count sat at
   * 3611 without a flicker, and a message landing inside the window costs
   * nothing worse than an Escape that has to be pressed a second time. */

  const ANSWERED_MS = 60;
  const WATCH_MS = 8;
  let closing = false;
  const conversation = () => document.querySelector('#main');

  /* Is there something on screen that Escape is for? Everything below is read
     at the keypress, and each line is one measured layer that takes longer to
     leave than it is worth waiting for.

     A dropdown, a list of suggestions, the emoji panel. The panel is handled
     above this as well; it is named here because this runs for the Escape after
     the one that opened it. */
  const OPEN_LAYER = '[role="menu"], [role="listbox"], [role="application"]';

  /* Selection mode: 282ms to leave, and the only sure sign of it is that every
     message has grown a checkbox. Eleven of them against none in a plain
     conversation, measured. Its header and footer say nothing a language could
     not change, and the composer is no test either -- a member who cannot post
     in an announcement group has no composer and still deserves this.

     A modal -- "add to list" was the one measured -- needs no name here: it
     goes well inside the watch below. Only what outlasts the watch has to be
     read at the keypress. */
  const SELECTING = 'input[type="checkbox"]';

  /* A bar in the composer with a cancel on it -- a reply being written, a
     message being edited. This one is a guess made safe rather than a
     measurement: the reply bar cannot be raised from a script, because the
     control that raises it appears on a real hover that a dispatched event does
     not produce. What was measured is the other half, that a plain footer
     carries only ic-attach-file, wds-ic-sticker-smiley and mic-outlined, so
     this can cost nothing when there is nothing there. */
  const CANCELLABLE = /close|cancel/i;

  /* And the one that wears no marking at all: a photo opened full screen, 299ms
     to leave, with neither a role nor a name to ask it by. What it does do is
     cover the window, so it is asked geometrically -- is the chat list still the
     thing on top of the chat list? Measured both ways: with the photo up the
     middle of the pane answers a div outside it, with the photo shut it answers
     the pane's own span. This catches every full-window overlay, including the
     ones WhatsApp has not shipped yet. */
  const chatListCovered = () => {
    const pane = document.querySelector('#pane-side');
    if (!pane) return false;
    const box = pane.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    const on = document.elementFromPoint(Math.round(box.left + box.width / 2),
                                         Math.round(box.top + box.height / 2));
    return !!on && !pane.contains(on);
  };

  const somethingElseIsUp = () => {
    const main = conversation();
    if (!main) return true;
    if (document.querySelector(OPEN_LAYER)) return true;
    if (main.querySelector(SELECTING)) return true;
    /* The profile drawer. It has no name of its own, but it is the only thing
       that puts a second [role="dialog"] on the page and puts it OUTSIDE the
       conversation -- one while it is open and none while it is shut, over an
       open-and-shut cycle. The dialog INSIDE the conversation is the
       announcement tip, which is not a layer and stays as long as the chat does.
       It is read here rather than waited for because waiting for it was flaky:
       its first measurement said 27ms and a later run outlasted the watch and
       took the conversation down with it. */
    for (const dialog of document.querySelectorAll('#app [role="dialog"]'))
      if (!main.contains(dialog)) return true;
    const footer = main.querySelector('footer');
    if (footer) {
      for (const title of footer.querySelectorAll('svg title'))
        if (CANCELLABLE.test(strip(title.textContent))) return true;
    }
    return chatListCovered();
  };

  /* The page in a few cheap numbers, chosen to move whenever a layer opens or
     shuts. The roles are counted apart from the total because they are the
     layers this is about, and because the log is worth reading.

     The total is compared with a tolerance and the roles exactly. A live
     conversation drifts by a node or two on its own -- a timestamp, a tick, a
     picture finishing -- and a drift of one is not an Escape that did something,
     while every layer measured here moved hundreds: 139 for a dropdown, 288 for
     a photo, 351 for the profile drawer, 48 for in-chat search. */
  const DRIFT = 8;

  const layers = () => {
    const app = document.querySelector('#app') || document.body;
    return {
      menus: document.querySelectorAll('[role="menu"]').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      panels: document.querySelectorAll('[role="application"]').length,
      nodes: app.querySelectorAll('*').length,
    };
  };

  const same = (a, b) => a.menus === b.menus && a.dialogs === b.dialogs &&
                         a.panels === b.panels && Math.abs(a.nodes - b.nodes) <= DRIFT;

  /* The item that closes a chat, found by its icon and not by its words: this
     account reads WhatsApp in English and the next one reads it in Arabic, and
     the icon is the same in both. `ic-cancel` was the only one of its name in
     both menus measured -- a community subgroup's twelve items and a direct
     chat's fifteen -- and everything that destroys something carries a different
     one (`ic-delete`, `ic-block`, `ic-do-not-disturb-on`, `ic-logout`). If a
     build ever draws two, this presses neither: a menu of destructive items is
     the wrong place to guess. The label is only a fallback, for a build that has
     renamed the icon. */
  const CLOSE_LABEL = /^(close chat|إغلاق الدردشة|إغلاق المحادثة)$/i;

  const closeItem = () => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const byIcon = items.filter(item => {
      const title = item.querySelector('svg title');
      return title && strip(title.textContent) === 'ic-cancel';
    });
    if (byIcon.length === 1) return byIcon[0];
    if (byIcon.length > 1) {
      log('the conversation menu draws ' + byIcon.length + ' items that could close it; none pressed');
      return null;
    }
    return items.find(item => CLOSE_LABEL.test(strip(item.getAttribute('aria-label')))) || null;
  };

  /* The menu is opened only to press one thing in it. It is up for about a
     thirtieth of a second, which still reads as a flash, so it is hidden while
     that happens -- verified against a capture of the window, where opacity on
     the menu alone leaves nothing visible: neither it nor its wrapper paints a
     background of its own.

     The style removes itself twice over, once when the press is done and once on
     a timer armed before the menu is opened at all, so that a throw anywhere in
     between cannot leave this page without menus. */
  const hideMenus = () => {
    const style = document.createElement('style');
    style.textContent = '[role="menu"] { opacity: 0 !important; }';
    (document.head || document.documentElement).appendChild(style);
    let dropped = false;
    const drop = () => { if (dropped) return; dropped = true; try { style.remove(); } catch (err) {} };
    setTimeout(drop, 1500);
    return drop;
  };

  const menuButton = () => {
    const header = document.querySelector('#main header');
    if (!header) return null;
    for (const el of header.querySelectorAll('button, [role="button"]'))
      if (el.getAttribute('aria-haspopup') === 'menu') return el;
    return null;
  };

  /* WhatsApp's own command, which is what its menu item ends up calling and
     what every other client on this page uses. `window.require` is Meta's
     module registry and it is right there -- contextIsolation is off for this
     window, so this file shares the page's world with WhatsApp's own code --
     and `WAWebCmd`'s Cmd carries closeActiveChat among its 188 methods.
     Measured at 29ms against the menu's 85, and it raises nothing on screen to
     hide.

     It is a private name and one WhatsApp deploy can take it away, so it is
     asked for inside a try, its answer is checked rather than believed, and the
     menu below stays as what happens when it is gone. */
  const closeByCommand = () => {
    try {
      const module = typeof window.require === 'function' && window.require('WAWebCmd');
      const Cmd = module && module.Cmd;
      if (!Cmd || typeof Cmd.closeActiveChat !== 'function') return false;
      Cmd.closeActiveChat();
      return true;
    } catch (err) {
      return false;
    }
  };

  const gone = async ms => {
    const until = Date.now() + ms;
    while (conversation() && Date.now() < until) await new Promise(r => setTimeout(r, 4));
    return !conversation();
  };

  const closeConversation = async () => {
    if (closeByCommand() && await gone(200)) {
      log('Escape closed nothing, so the conversation was closed by WhatsApp\'s own command');
      return;
    }

    const button = menuButton();
    if (!button) { log('Escape closed nothing and the conversation menu cannot be found'); return; }

    const show = hideMenus();
    try {
      press(button, deepestIn(button));
      /* 31ms, measured, and not one of them is this client's to save: React
         mounts the menu when it is ready. Polled on a timer rather than on
         animation frames, which is both quicker to notice it -- 31ms against
         45ms, three frames -- and safe in a window nobody is looking at, where
         frames stop coming and an await on one would never return. */
      let menu = null;
      const until = Date.now() + 500;
      while (!menu && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, 2));
        menu = document.querySelector('[role="menu"]');
      }
      if (!menu) { log('Escape closed nothing and the conversation menu did not open'); return; }

      const item = closeItem();
      /* Left open on purpose when the item cannot be found: the menu becomes
         visible again the moment this returns, and the user is looking at the
         thing this failed to press rather than at nothing. */
      if (!item) { log('Escape closed nothing and the menu has no "close chat" in it'); return; }

      press(item, deepestIn(item));
      log('Escape closed nothing, so the conversation was closed from its own menu');
    } finally {
      show();
    }
  };

  addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (!emojiPanel()) {
      /* No panel: the key is WhatsApp's. Nothing is swallowed here -- the event
         goes on to it exactly as it did before -- and all this does is take the
         page's measure now, and again once WhatsApp has had its turn with it. */
      if (closing || !conversation()) return;
      /* A layer that is up now is what the key is for, and this has nothing to
         say about it. */
      if (somethingElseIsUp()) return;

      const before = layers();
      const until = Date.now() + ANSWERED_MS;
      const watch = () => {
        if (closing || !conversation() || !same(layers(), before)) return;
        if (Date.now() < until) { setTimeout(watch, WATCH_MS); return; }
        closing = true;
        closeConversation()
          .catch(err => log('could not close the conversation: ' + err.message))
          .then(() => { closing = false; });
      };
      setTimeout(watch, WATCH_MS);
      return;
    }

    const button = panelButton();
    if (!button) { log('the emoji panel is open and its button cannot be found'); return; }

    event.preventDefault();
    event.stopPropagation();
    press(button, deepestIn(button));
    /* And the caret back in the composer, so the next keystroke is a message
       rather than a search in a panel that is no longer on screen. */
    const box = composer();
    if (box) { try { box.focus(); } catch (err) {} }
  }, true);

  /* ------------------------------------------------------------ the question */

  /* Answers the app's one question at notification time: what just arrived, and
     was it the conversation already on screen? The reply is the chat, the sender,
     the message and the avatar joined by unit separators -- or the single word
     "open", which means stay quiet, or an empty string, which means there is
     nothing to say and the app should say nothing. There is deliberately no third
     answer: a banner whose text the app had to invent is the phantom this client
     kept raising. */
  window.__waDescribeUnread = async () => {
    scanList();                       // collect whatever the debounce still owes us

    /* Oldest first, one per call. The app raises a banner for every message, so
       draining the queue for a single description would announce the newest
       arrival and quietly discard the rest -- messages the user never saw. */
    const cutoff = Date.now() - ARRIVAL_TTL_MS;
    arrivals = arrivals.filter(a => a.at > cutoff);

    let row = null, queued = null;
    while (arrivals.length && !row) {
      queued = arrivals.shift();
      if (Date.now() - queued.at > ANSWER_WINDOW_MS) { queued = null; continue; }
      row = queued.row.isConnected ? queued.row : findRow(queued.name, queued.preview);
    }
    const fromQueue = !!row;
    /* The message landed in the chat on screen: the user is reading it as it
       arrives and WhatsApp plays its own tone, so a banner over the top of the very
       conversation it came from is noise. */
    if (row && isOpen(row, queued.preview)) return 'open';

    /* Nothing queued and the app still asked, which means the document title saw a
       chat go unread that the watcher never did: the list only renders the rows
       near the top, and a message to a chat below them arrives on an element we
       have no previous reading for. The topmost unread row is the one WhatsApp
       just moved up there. This is a guess, and it is confined to the case where
       there is nothing better.

       Unread is not the same thing as new, and reading that as though it were is
       what announced a chat's last message over and over while the user sat in a
       different conversation. So the guess has to clear what the queue clears -- a
       row that has just moved, a clock that says now, and something this client has
       not already said. */
    if (!row) {
      const pane = document.querySelector('#pane-side');
      for (const candidate of (pane ? pane.querySelectorAll('[role="row"]') : [])) {
        if (!unreadCount(candidate)) continue;
        if (isOpen(candidate, '') || isSilenced(candidate) || isOutgoing(candidate)) continue;

        const state = rowState.get(candidate);
        if (!state || isTyping(state.preview)) continue;
        if (!state.changedAt || Date.now() - state.changedAt > GUESS_WINDOW_MS) continue;
        if (freshness(state.when) !== true) continue;
        if (wasAnnounced(state)) continue;
        row = candidate;
        break;
      }
    }

    /* Nothing changed and nothing unread: there is genuinely nothing to say. */
    if (!row) return '';

    const state = readRow(row);
    /* The sender can start writing again in the quarter second between the arrival
       and this call, and then the row reads "Mega is typing..." -- which is a
       banner announcing that somebody has begun to type. What goes out is the
       message that was queued; if there is no queued message behind it, the row has
       nothing to report and nothing is raised. */
    const moved = isTyping(state.preview);
    const preview = !moved ? state.preview
                  : (fromQueue && !isTyping(queued.preview) ? queued.preview : '');
    if (!state.name || !preview) return '';

    /* Read off the row, unless the row has moved on and the message is the one that
       was queued -- then so is the sender, or a group message would go out with
       nobody's name on it. */
    const sender = moved ? (queued.sender || '') : senderIn(row);

    /* A message of the user's own, caught here as well as at the row.
     *
     * The row test runs at scan time, and the sender WhatsApp prints in front of
     * a preview can arrive a beat after the preview itself -- so a row that
     * looked like anybody's when it was queued can read "You:" by the time it is
     * described. That gap is what put a banner over a message the user had just
     * sent to a group, with "You:" printed in it for them to read. */
    if (SELF_SENDER.test(sender)) {
      log('not announced: "' + state.name + '" moved for a message of our own');
      return '';
    }

    /* The same words for the same chat again, moments after they were announced.
     *
     * A reply in a community lands in a thread, and WhatsApp answers by moving
     * the group to the top of the chat list with the PARENT message still in the
     * preview and a fresh clock on it. Every test an arrival has to pass, it
     * passes -- and the banner it produces names a message the user was told
     * about already, not the reply that actually arrived. Of the two ways out,
     * announcing the reply is not available: the chat list is not told what the
     * reply said, only that the thread moved. So the second banner is dropped.
     * A banner naming the wrong message is worse than no banner: it is the one
     * thing a notification must not be, and the reply is still counted in the
     * unread pill, the tray and the badge.
     *
     * Narrow on purpose. Only the identical text, only for the same chat, and
     * only inside two minutes -- two people saying "tamam" a quarter of an hour
     * apart are two messages and both are announced. */
    const said = lastAnnounced.get(state.name);
    if (said && said.preview === preview && Date.now() - said.at < REPEAT_MS) {
      /* The chat is named and the message is not. What was said belongs in the
         banner and nowhere else -- a log is read over a shoulder, pasted into an
         issue and kept in the journal, and none of those is a place for
         somebody's messages. */
      log('not announced: "' + state.name + '" moved for the message already ' +
          'announced -- a thread reply, not a new message');
      return '';
    }
    lastAnnounced.set(state.name, { preview, at: Date.now() });
    sweepStamped(lastAnnounced, REPEAT_MS);

    /* Said once, and the guess will not say it again. */
    rememberAnnounced({ name: state.name, preview: preview, when: state.when });
    if (preview !== state.preview) rememberAnnounced(state);

    const token = rememberOpenable(row, state.name, preview);
    return [state.name, sender, preview, await avatarOf(row, state.name), token].join(SEP);
  };

  /* What the watcher is holding, for the devtools console and the test rig. Every
     notification question -- why was this announced, why was that one not -- comes
     down to these values, and reading them out of a live session beats inferring
     them from which banners did and did not appear. */
  window.__waWatcherState = () => JSON.stringify({
    focused,
    settled: seeded && Date.now() - seededAt >= SETTLE_MS,
    open: (() => { const row = openRow(); return row ? nameOf(row) : null; })(),
    queued: arrivals.map(a => ({ name: a.name, preview: a.preview, age: Date.now() - a.at })),
  });

  /* ---------------------------------------------- the sounds the page makes */

  /* WhatsApp Web plays two tones of its own, and the client has an opinion about
     both.
   *
   * The first is the one it plays the moment a message of yours leaves, and it
   * is the one sound here that says nothing: the message is already on screen,
   * with a tick under it, in the window being looked at.
   *
   * The second is the one it plays for a message arriving while the window is
   * away -- the only moment WhatsApp Web announces anything itself, because it
   * is the only moment it believes nobody is looking. That tone is not
   * unwanted, it is simply the wrong one: with the window in front the client
   * announces the arrival with the desktop's own notification sound, so the
   * same message sounded like two different events depending on where the
   * window happened to be. It is silenced here and the client plays its tone
   * for that banner too, which is the whole of "one event, one sound".
   *
   * Neither can be silenced by name. WhatsApp serves its sounds from
   * static.whatsapp.net under filenames that are hashes -- l-ut9G1w4eu.ogg,
   * kAbvQpjkfMK.ogg -- and they change with the build, so there is nothing
   * stable to match on. What is stable is the moment: a message goes out because
   * the user pressed a key or clicked a button, and the tone follows within a
   * beat. Sound played inside that beat is the sound of their own message;
   * sound played outside it, by something that is not the conversation, is the
   * arrival tone. */
  const SEND_TONE_MS = 1500;
  /* Longer than any notification tone and far shorter than a call: a ring is
     what must never be silenced by any of this. */
  const RINGING_S = 6;
  let sentAt = 0;
  let muteSendTone = false;
  let mutePageTone = false;
  let mutedSend = false;
  let mutedArrival = false;

  /* What sending looks like from out here: Enter in the composer -- Shift+Enter
     is a newline and a keystroke mid-composition belongs to the input method --
     or a click on the send button, which is how a picture, a voice note or a
     forward goes. The button is found by the name of its icon and by its label,
     never by its class: class names are obfuscated and rotate every build. */
  const SEND_ICON  = /send/i;
  const SEND_LABEL = /^(send|إرسال|ارسال)\b/i;
  const isSendClick = target => {
    if (!target || !target.closest) return false;
    const icon = target.closest('[data-icon]');
    if (icon && SEND_ICON.test(icon.getAttribute('data-icon') || '')) return true;
    const labelled = target.closest('[aria-label]');
    return !!labelled && SEND_LABEL.test(strip(labelled.getAttribute('aria-label')));
  };

  const noteSend = () => { sentAt = Date.now(); };

  const watchForSends = () => {
    addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target;
      if (target && target.closest && target.closest('[contenteditable="true"]')) noteSend();
    }, true);
    addEventListener('pointerdown', event => {
      if (isSendClick(event.target)) noteSend();
    }, true);
  };

  /* Both ways a page can make a sound, because which one WhatsApp uses is not
     worth depending on: it has played its tones through an <audio> element for
     years, and the tone this client raises for its own banners goes through
     WebAudio -- a build that moved from one to the other is a build where this
     quietly stopped working. The client's own source is tagged, and exempt. */
  const interceptSounds = () => {
    if (window.HTMLMediaElement) {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        if (muted(this)) return Promise.resolve();
        return play.apply(this, args);
      };
    }

    if (window.AudioBufferSourceNode) {
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (...args) {
        if (!this.__waOurs && muted(this)) return;
        return start.apply(this, args);
      };
    }
  };

  /* How long a source is going to sound for, asked of whichever kind it is.
     Unknown -- an <audio> whose metadata has not loaded -- answers 0, which is
     the answer that does not exempt anything: the loop test below is what a ring
     is actually caught by. */
  const lengthOf = source => {
    const seconds = source && source.buffer ? source.buffer.duration
                  : source ? source.duration : 0;
    return typeof seconds === 'number' && isFinite(seconds) ? seconds : 0;
  };

  /* A sound effect and not something the user asked to hear. A voice note and a
     video live in the conversation; a tone is an element the page keeps to
     itself, or no element at all. Silencing a voice note because a message went
     out a second ago would be a bug of its own, and silencing a call would be a
     worse one -- so a ring, which loops and goes on long after any tone would
     have finished, is exempt before anything else is decided. */
  const muted = source => {
    if (!source) return false;
    /* Video elements (camera stream, remote caller video, chat video) must never be muted or blocked */
    if ((typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) ||
        (source.tagName && source.tagName.toUpperCase() === 'VIDEO')) return false;
    /* WebRTC media streams (video/audio calls) have srcObject, never mute them */
    if (source.srcObject) return false;
    /* Elements inside conversation or call overlay/modals */
    if (source.closest && (source.closest('#main') || source.closest('[role="dialog"]') || source.closest('[data-testid*="call"]') || source.closest('[class*="call"]'))) return false;
    /* Ringing or looped sounds */
    if (source.loop === true || lengthOf(source) > RINGING_S) return false;

    /* Voice notes and media playback. WhatsApp plays voice messages, audio files
       and video messages through <audio>/<video> elements whose src is a blob: URL
       or a URL on WhatsApp's media CDN (mmg.whatsapp.net, pps.whatsapp.net, or
       media-*.cdn.whatsapp.net). These are user content, not notification tones,
       and must never be silenced. Their duration is often NaN when .play() is first
       called -- the metadata has not loaded yet -- so the RINGING_S check above
       cannot catch them. */
    const src = source.currentSrc || source.src || '';
    if (/^blob:|mmg\.whatsapp\.net|pps\.whatsapp\.net|media[\w-]*\.cdn\.whatsapp\.net/i.test(src)) return false;

    /* Within a beat of a keystroke or a click on send: their own message. */
    if (Date.now() - sentAt <= SEND_TONE_MS) {
      if (!muteSendTone) return false;
      if (!mutedSend) { mutedSend = true; log('muting the tone WhatsApp plays for a message going out'); }
      return true;
    }

    /* Anything else: a message arriving while the window is away, which the
       client is about to announce with the desktop's tone. Only once that tone
       is decoded and ready, though -- muting this one before there is another
       would turn an arrival the user could hear into one they could not. */
    if (!mutePageTone || !toneBuffer) return false;
    if (!mutedArrival) { mutedArrival = true; log('muting the tone WhatsApp plays for a message arriving'); }
    return true;
  };

  watchForSends();
  interceptSounds();

  /* --------------------------------------------- the notifications WA raises */

  /* While the window is away WhatsApp Web raises its own notification, and it is
     the better judge by far: it knows the sender, the text, whether the chat is
     muted, and that what just landed is a message rather than a typing indicator
     or something the user sent from their phone. What it cannot do is dress one,
     or bring a window back from the tray -- so the decision is left to the page and
     the banner is raised by the app, with the sender's face on it, a click that
     opens the conversation, and the twelve-second policy that keeps GNOME from
     parking one banner in front of every message behind it. */
  const installNotificationShim = () => {
    const Real = window.Notification;
    if (!Real) return;

    let nextId = 1;
    const raised = new Map();

    class Shimmed {
      constructor(title, options = {}) {
        this.__id = nextId++;
        this.title = String(title == null ? '' : title);
        this.body = options.body || '';
        this.icon = options.icon || '';
        this.tag = options.tag || '';
        this.data = options.data;
        this.silent = !!options.silent;
        this.__handlers = { click: [], close: [], show: [], error: [] };
        raised.set(this.__id, this);

        /* The picture comes from the icon WhatsApp put on the notification when
           there is one, and from the chat list by name when there is not -- and
           the lookup by name is also what records that WhatsApp announced this
           chat, so the watcher does not announce it again when the window comes
           back.

           The chat goes over with it, taken from the list rather than from the
           title, because the title is WhatsApp's wording of who wrote and the
           withdrawals all speak in chat-list names. A notification keyed on
           anything else is one nothing can take down again. */
        const chat = chatNameFor(this.title);
        /* Swallowed rather than dressed. The shim stays installed either way --
           taking it out would let Chromium raise WhatsApp's own notification,
           which is the one with the wrong picture and no way to withdraw it --
           but while the store is answering, this message has already been
           announced from it, with a message id on it and a chat id to open. */
        if (storeLive()) return;
        log('WhatsApp raised a notification of its own');
        Promise.resolve()
          .then(() => {
            if (!this.icon) return avatarFor(this.title);
            rememberName(this.title);
            return withTimeout(fetchAvatar(this.icon));
          })
          .catch(() => '')
          .then(avatar => send('page-notification', {
            id: this.__id, title: this.title, body: this.body,
            chat: chat,
            group: chatKindFor(this.title),
            avatar: avatar || '', silent: this.silent,
          }));
      }

      close() {
        raised.delete(this.__id);
        send('page-notification-close', { id: this.__id });
        this.__fire('close');
      }

      addEventListener(type, fn) { (this.__handlers[type] || (this.__handlers[type] = [])).push(fn); }
      removeEventListener(type, fn) {
        const list = this.__handlers[type] || [];
        const at = list.indexOf(fn);
        if (at >= 0) list.splice(at, 1);
      }

      __fire(type) {
        const event = new Event(type);
        try { Object.defineProperty(event, 'target', { value: this, configurable: true }); } catch (e) {}
        const inline = this['on' + type];
        if (typeof inline === 'function') { try { inline.call(this, event); } catch (e) {} }
        for (const fn of (this.__handlers[type] || [])) { try { fn.call(this, event); } catch (e) {} }
      }

      static get permission() { return 'granted'; }
      static requestPermission(callback) {
        if (typeof callback === 'function') callback('granted');
        return Promise.resolve('granted');
      }
    }

    /* The click is handed back to the page, because WhatsApp's own handler is what
       opens the conversation the message came from. Bringing the window back from
       the tray is the app's half. */
    on('notification-clicked', id => {
      const note = raised.get(id);
      if (note) note.__fire('click');
    });
    on('notification-closed', id => {
      const note = raised.get(id);
      if (!note) return;
      raised.delete(id);
      note.__fire('close');
    });

    window.Notification = Shimmed;
    /* Some builds reach for the service worker path instead. Same treatment:
       WhatsApp keeps a websocket in the page, so nothing here is web push. */
    try {
      const proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
      if (proto && proto.showNotification) {
        proto.showNotification = function (title, options) {
          new Shimmed(title, options);
          return Promise.resolve();
        };
        proto.getNotifications = function () { return Promise.resolve([]); };
      }
    } catch (e) { log('could not shim the service worker notifications: ' + e.message); }
  };

  /* Opening a conversation the app asked for by chat id -- the identity a
     notification now carries. It goes to WhatsApp's own openChatBottom, which
     needs no row on the page and cannot pick the wrong one of two chats sharing
     a name. Pressing a row is what happens when that is not available. */
  on('store-open', request => {
    const chatId = request && request.chat;
    if (chatId && waStore && waStore.open(chatId)) {
      setTimeout(() => { if (waStore) send('store-active', { chat: waStore.activeChat() }); }, 300);
      return;
    }
    if (request && request.name) {
      log('opening "' + request.name + '" by name: the store could not place ' + chatId);
      /* The same path a banner raised by the watcher takes. */
      const row = findRow(request.name, request.preview) || rowFor(request.name);
      if (row) pressRow(row);
    }
  });

  on('config', config => {
    if (config && config.notifications) installNotificationShim();

    /* And the store, started once the app has said what it wants. It answers a
       beat later than this -- WhatsApp has to finish loading before its
       collections hold anything -- so everything above stays in charge until
       store-ready arrives with ready: true. */
    if (!waStore) {
      waStore = store.start({
        send, log,
        fetchAvatar: url => withTimeout(fetchAvatar(url)),
        faceFor: name => avatarFor(name),
      });
      waStore.setFocus(focused);
    }

    /* And the stickers, which are nothing to do with notifications and are
       started from here because this is where the page learns what the client
       wants. See media.js: WhatsApp files a sticker under "photos", so turning
       photos off leaves every sticker blank with no way to fetch one. */
    if (!waMedia && config && config.downloadStickers !== false) {
      waMedia = media.start({ log });
    }
    muteSendTone = !!(config && config.muteSendTone);
    mutePageTone = !!(config && config.mutePageTone);
    log('ready on ' + location.host);

    /* What the page asks for, so the app can bind those families to the
       desktop font where it costs nothing -- in fontconfig, rather than in a
       stylesheet that has to be matched against every element on every scroll. */
    const report = () => {
      try {
        send('font-stack', getComputedStyle(document.body).fontFamily || '');
      } catch (err) { /* the body is not there yet */ }
    };
    if (document.body) report();
    else addEventListener('DOMContentLoaded', report, { once: true });
  });
};

module.exports = { start, SEP };
