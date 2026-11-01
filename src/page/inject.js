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
const pictures = require('./pictures.js');
const arabicDigits = require('./arabic-digits.js');
const navigation = require('./navigation.js');
const motion = require('./motion.js');
const wallpaper = require('./wallpaper.js');
const warmup = require('./warmup.js');
const find = require('./find.js');

const SEP = '\u001f';   // joins the parts of an answer; occurs in no chat name

/* WebGPU on Linux/Wayland has a broken CreateExternalTexture implementation in
   Chromium for video streams (generating "Invalid ExternalTexture is invalid" and
   black video call frames). Disabling navigator.gpu forces WhatsApp to use its
   working WebGL / direct MediaStream pipeline.
 *
 * On its own because a call moved out into a window of its own is a second page
 * drawing the same video, and it needs this and nothing else in here. */
const fixVideo = () => {
  try {
    if (window.Navigator && window.Navigator.prototype && 'gpu' in window.Navigator.prototype) {
      Object.defineProperty(window.Navigator.prototype, 'gpu', {
        get: () => undefined,
        configurable: true,
      });
    }
  } catch (e) {}
};

const start = ({ send, on }) => {
  const log = message => send('log', String(message));

  fixVideo();
  arabicDigits.start();

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
  let waPictures = null;
  const storeLive = () => !!(waStore && waStore.ready);

  /* ------------------------------------------------------------- visibility */

  /* What the page is allowed to believe about being on screen.
   *
   * Chromium is asked never to throttle this window (backgroundThrottling in
   * src/main.js), which is what keeps the watcher's timers running while the
   * client sits in the tray -- and it has a second effect nobody asked for: the
   * page goes on being told it is visible after the compositor has stopped
   * drawing it. Measured on this session with the client minimised: the timers
   * keep their pace, and requestAnimationFrame goes to zero.
   *
   * A page told it is visible and given no frames is a page waiting for
   * animation frames that will never arrive, and WhatsApp waits in exactly that
   * way. It is what stopped a call moved into a window of its own from
   * answering: the camera, the screen-share button and the popped-out window's
   * own closing all sat behind a client nobody was drawing, and came back the
   * moment the client was brought up.
   *
   * So the page is told the truth, from the one place that knows it. The
   * throttling stays off underneath: this changes what the page believes, not
   * what Chromium does with its timers -- so the watcher keeps its pace in the
   * tray, which a browser's hidden tab does not. */
  let onScreen = true;
  try {
    Object.defineProperty(document, 'visibilityState', {
      get: () => (onScreen ? 'visible' : 'hidden'),
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: () => !onScreen,
      configurable: true,
    });
  } catch (e) {}

  on('on-screen', state => {
    state = !!state;
    if (state === onScreen) return;
    onScreen = state;
    document.dispatchEvent(new Event('visibilitychange'));
  });

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

  /*
   * A chat asked for by phone number: a whatsapp: or wa.me link, followed from
   * outside this window. See src/links.js for how one gets here.
   *
   * A row cannot answer this. The number may belong to somebody who has never
   * written, and the chat list has nothing to press. WhatsApp's own
   * openChatWithContact does exactly the right thing -- it finds or creates the
   * chat and opens it -- and it was measured here: the conversation changed in
   * about a second, with the URL still on web.whatsapp.com and no reload. The
   * reload is the fallback, because /send?phone= is a page WhatsApp itself
   * serves and it works even on the morning these module names change.
   *
   * The wait is for WhatsApp, not for the page. A link that started this client
   * arrives while the registry is still being built, so the modules are asked
   * for until they answer -- the same shape as the store's own wait.
   */
  const LINK_WAIT_MS = 60000;
  const LINK_POLL_MS = 400;

  /* WhatsApp's own module registry, asked for one name, and never trusted to
     answer: contextIsolation is off so `window.require` is Meta's, and it is
     private -- see src/page/store.js for the same guard around the same idea. */
  const grab = name => {
    try { return typeof window.require === 'function' ? window.require(name) : null; }
    catch (err) { return null; }
  };

  const openByNumber = (phone, wantsText, waitedFor) => {
    const wf = grab('WAWebWidFactory');
    const action = grab('WAWebOpenChatWithContactAction');

    if (!wf || !action || typeof action.openChatWithContact !== 'function') {
      if (waitedFor < LINK_WAIT_MS) {
        setTimeout(() => openByNumber(phone, wantsText, waitedFor + LINK_POLL_MS), LINK_POLL_MS);
        return;
      }
      /* Handed back to the app, which still has the link that started this and
         can load WhatsApp's own /send page for it -- text and all, which /send
         puts in the composer itself. Costs a reload, which is why it is last. */
      log('WhatsApp\'s modules never answered for +' + phone + '; asking for its own page');
      send('link-unresolved', { phone: phone });
      return;
    }

    let wid;
    try { wid = wf.createUserWidOrThrow(phone); }
    catch (err) {
      log('cannot make a chat id for +' + phone + ': ' + err.message);
      send('link-unresolved', { phone: phone });
      return;
    }

    /* The current WhatsApp action accepts one options object. It also catches
       its own errors, so resolving its promise alone does not prove a chat
       opened. onOpened is called only after Cmd.openChatFromUnread succeeds. */
    const point = grab('WAWebChatEntryPoint')?.ChatEntryPoint?.Link || 'Link';
    let opened = false;
    const unresolved = () => {
      if (opened) return;
      log('could not open +' + phone + ' in place; asking for its own page');
      send('link-unresolved', { phone: phone });
    };
    try {
      Promise.resolve(action.openChatWithContact({
        targetId: wid,
        chatEntryPoint: point,
        findChatOrigin: point,
        opts: { onOpened: () => {
          opened = true;
          log('opened a chat with +' + phone);
          setTimeout(refreshOpen, 400);
          if (wantsText) setTimeout(() => focusComposer(0), 400);
        } },
      })).then(unresolved, unresolved);
    } catch (err) { unresolved(); }
  };

  /*
   * The composer, focused and reported -- and NOT typed into here.
   *
   * Text that came with a link belongs in front of the owner, unsent: this
   * client sends nothing on its own. What it must not do is put it there with
   * execCommand, which an evaluated script has no user gesture behind: WhatsApp's
   * editor takes the call, answers true and stays empty. Measured, twice, and it
   * is the same finding the #type probe in debug.js is written around. So the
   * page only says "the box is up, focused and empty" and the app types it in
   * through the path a keyboard uses.
   *
   * The retry is because a composer mounted for a chat that has just been opened
   * is not focusable for the first few hundred milliseconds. A composer with
   * something already in it is a draft, and a link is not worth losing one over.
   */
  const FOCUS_TRIES = 12;

  const focusComposer = tries => {
    const box = document.querySelector('#main footer div[contenteditable="true"]');
    if (box && (box.innerText || '').trim()) {
      log('left the message out: the composer already has a draft');
      return;
    }
    if (box) {
      box.click();
      box.focus();
      if (document.activeElement === box) { send('composer-ready', null); return; }
    }
    if (tries < FOCUS_TRIES) { setTimeout(() => focusComposer(tries + 1), 300); return; }
    log('no composer to put the link\'s message in');
  };

  /* The microphone button in a call, pressed from a key the desktop caught
     while the window was behind something else -- which is the whole point of
     it, and why it cannot be a shortcut in the page. Matched on the label
     rather than a test id: WhatsApp changes those, and the label is what a
     screen reader is given and so the thing least likely to move. The Arabic
     label is here because the client is read in Arabic too. */
  on('toggle-call-mute', () => {
    const found = document.querySelector(
      'button[aria-label*="mute" i], button[aria-label*="mic" i], button[aria-label*="كتم" i], ' +
      'span[data-icon="mic-off"], span[data-icon="mic"]');
    if (!found) { log('no call to mute'); return; }
    (found.closest('button') || found).click();
    log('call microphone toggled');
  });

  on('open-link', chat => {
    const phone = chat && chat.phone;
    if (!phone) return;
    openByNumber(String(phone), !!(chat && chat.wantsText), 0);
  });

  /*
   * A group invite, opened where the client already is.
   *
   * This cost a reload until now, and the reload was the report: `/accept?code=`
   * is WhatsApp's own page for an invite, loading it brings the whole client up
   * again, and on the way it moved the window to whichever workspace the browser
   * was on and then showed no dialog at all -- "it was impossible to join the
   * group without WhatsApp Web". Every other WhatsApp client on Linux puts the
   * invite up without reloading anything.
   *
   * Measured on the live page, and this is the whole of it: the dialog is
   * `WAWebGroupInviteLinkModal.react`, its props are `{ groupCode, source }` and
   * nothing else, and it is NOT in the bundle this client boots with -- going to
   * /accept adds exactly one module to a registry of 17964, and that is the one.
   * `WAWebGroupInviteLinkModalLoadable.react` is what fetches it: that one IS in
   * the bundle, it is an ordinary React component, and rendering it pulls the
   * chunk down. So the dialog goes up through WhatsApp's own ModalManager --
   * verified with the chat list still behind it and the URL still at
   * web.whatsapp.com: group photo, name, when it was created, who is already in
   * it, Cancel and Join group. Nothing is joined without that button.
   *
   * A code the server will not have answers in the same dialog and in WhatsApp's
   * own words ("Couldn't join this group. Please try again later."), which is
   * the other reason to let WhatsApp draw this rather than draw one here.
   *
   * The wait and the fallback are openByNumber's, for openByNumber's two
   * reasons: a link that started this client arrives while the registry is still
   * being built, and on the morning these names change the reload still works.
   *
   * The wait is for the chat list as well as for the modules, and that is a
   * measured requirement rather than caution. A link that STARTS this client
   * resolves those modules about six seconds before WhatsApp has drawn anything:
   * asked then, ModalManager takes the call, answers nothing, and does not even
   * fetch the modal's chunk -- sampled every 200ms through a cold start, the
   * dialog was never on the page for a single frame. #pane-side is the app being
   * up, and a modal opened after it appears is one WhatsApp keeps.
   */
  const INVITE_SETTLE_MS = 1500;

  const openInvite = (code, waitedFor, retried) => {
    const React = grab('react');
    const loadable = grab('WAWebGroupInviteLinkModalLoadable.react');
    const manager = (grab('WAWebModalManager') || {}).ModalManager;
    const Modal = loadable && loadable.WAWebGroupInviteLinkModalLoadable;

    if (!React || typeof React.createElement !== 'function' ||
        typeof Modal !== 'function' || !manager || typeof manager.open !== 'function' ||
        !document.querySelector('#pane-side')) {
      if (waitedFor < LINK_WAIT_MS) {
        setTimeout(() => openInvite(code, waitedFor + LINK_POLL_MS, retried), LINK_POLL_MS);
        return;
      }
      /* Handed back to the app, which still has the invite and can load
         WhatsApp's own /accept page for it. Costs a reload, which is why it is
         last -- and it is also the honest answer for a client sitting on the QR
         screen, where no chat list is ever going to appear. */
      log('WhatsApp\'s modules never answered for the invite; asking for its own page');
      send('invite-unresolved', { code: code });
      return;
    }

    try {
      /* `source` is what the live page passes for an invite followed from
         outside, read off the open dialog rather than invented: it is WhatsApp's
         own logging, and a value it does not know is not worth guessing at. */
      manager.open(React.createElement(Modal, { groupCode: code, source: 'invite_link' }),
                   { transition: 'modal-flow' });
      log('put up the join dialog for a group invite');
    } catch (err) {
      log('cannot show the invite dialog: ' + err.message);
      send('invite-unresolved', { code: code });
      return;
    }

    /* Asked for once more if it did not arrive, and once only: a dialog the
       owner has already closed must not come back, and a second and a third
       attempt would be exactly that. The check is late enough for the chunk to
       have been fetched and drawn, and early enough that nobody has read it yet.
       Twice with nothing to show for it is the app's page after all -- the owner
       followed this link to join a group, and a reload they did not want beats
       the silence this whole issue was about. */
    setTimeout(() => {
      if (document.querySelector('[role="dialog"]')) return;
      if (retried) {
        log('the join dialog did not arrive twice over; asking for WhatsApp\'s own page');
        send('invite-unresolved', { code: code });
        return;
      }
      log('the join dialog did not arrive; asking once more');
      openInvite(code, waitedFor, true);
    }, INVITE_SETTLE_MS);
  };

  on('open-invite', invite => {
    const code = invite && invite.code;
    if (!code) return;
    openInvite(String(code), 0, false);
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

  /* The date picker that in-chat search opens from its calendar button
     (issue #10). It is the dropdown's kind, only slower: WhatsApp closes it on
     Escape, but it was still up 300ms after the key and gone by 500ms, and the
     page did not move inside the watch -- 2519 nodes at the key and still 2519
     at 50ms, measured -- so the watch called it an Escape that closed nothing
     and closed the conversation, taking the search panel and the picker with it.
     It is a [role="grid"], which the chat list is too, so a grid counts only
     where the picker is mounted: the popup layer, outside the chat list, the
     conversation and every drawer. */
  const IN_PLACE = '#pane-side, #main, [data-testid^="drawer-"]';
  const popupGrid = () =>
    [...document.querySelectorAll('[role="grid"]')].some(grid => !grid.closest(IN_PLACE));

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
    if (popupGrid()) return true;
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

  let adoptConversation = () => {};
  const doodles = wallpaper.start({ log, window });
  navigation.start({ press, log, window, prepareChat: () => { adoptConversation(); doodles.scan(); } });
  warmup.start({ log, window });
  find.start({ press, log, window });

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
  /* What the user asked to hear rather than something the page decided to play:
     a voice note, an audio file, a video. WhatsApp serves all of them from a
     blob: URL or from its own media CDN, and serves nothing else that way --
     its tones come from static.whatsapp.net. Read by the muting below, which
     must never touch one, and by the media controls further down, which are
     only ever interested in one. */
  const USER_MEDIA = /^blob:|mmg\.whatsapp\.net|pps\.whatsapp\.net|media[\w-]*\.cdn\.whatsapp\.net/i;
  let sentAt = 0;
  let muteSendTone = false;
  let mutePageTone = false;
  let hideControlsWhenPaused = true;
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

  /* ------------------------------------------ the desktop's media controls */

  /*
   * A voice note that is only paused leaves its card sitting in the
   * notification centre, and nothing but playing the note out to its end takes
   * it down. That is not the shell being stubborn and it is not Chromium's
   * either -- it is the two of them agreeing on something neither was asked.
   *
   * Measured on the bus, against org.mpris.MediaPlayer2.chromium.instance<pid>:
   * playing answers CanPlay true / PlaybackStatus "Playing", pausing moves the
   * status to "Paused" and leaves CanPlay ALONE. And gnome-shell shows a player
   * for exactly one reason -- its own mpris.js filters the list on
   * `player.canPlay` and reads PlaybackStatus only to draw the button. So a
   * paused note is still a player as far as the shell can tell.
   *
   * Chromium drops a player from its media session when the stream ends or when
   * the element loses its resource, and pausing is neither. Losing the resource
   * is reachable from here: blanking the src and running the load algorithm
   * destroys the WebMediaPlayer, Chromium takes it out of the session, CanPlay
   * goes false and the card leaves. Putting the src straight back gives the
   * element its audio again WITHOUT putting it back in the session -- a player
   * joins on play(), not on load -- so the note is still there to be resumed
   * and the card returns only when it actually is.
   *
   * Measured end to end, driving the conversation's own buttons: playing ->
   * CanPlay true; paused and recycled -> CanPlay false, PlaybackStatus
   * "Stopped", currentTime still 2.52, readyState still 4, the bubble still
   * reading its duration and offering Play; pressed again -> resumed from 2.52
   * and CanPlay true. WhatsApp's player noticed none of it.
   *
   * Audio only, deliberately. A <video> stripped of its resource has nothing to
   * draw until the seek lands again, and a flash in the middle of a video is a
   * worse thing than a card that outstays its welcome.
   */

  /* If loadedmetadata never comes, stop waiting and let the element be. Well
     past what a blob already in memory takes, and short enough that a press
     held behind it is not a hang. */
  const RESTORE_WAIT_MS = 2000;

  /* Elements whose src is on its way back, and the promise that says when it
     is. A press that lands inside that window has to wait for it: play() on an
     element with no resource rejects, and the note would be stuck. */
  const restoring = new WeakMap();

  const conversationAudio = el => {
    if (!el || el.tagName !== 'AUDIO') return false;
    /* A call carries its audio on a stream and rings on a loop; neither is a
       recording somebody chose to listen to. */
    if (el.srcObject || el.loop === true) return false;
    return USER_MEDIA.test(el.currentSrc || el.src || '');
  };

  /* Take the resource away and hand it back, in that order and in one go. The
     two load() calls are what Chromium reads: the first tears the player down,
     the second builds one that has never played and so was never enrolled. */
  const recycle = el => {
    if (restoring.has(el)) return;
    const url = el.getAttribute('src') || el.src;
    if (!url) return;
    const at = el.currentTime;

    const back = new Promise(resolve => {
      const settle = () => {
        clearTimeout(timer);
        el.removeEventListener('loadedmetadata', settle);
        /* Where the user left it. Seeking a paused element does not re-enrol
           it -- only play() does -- so this costs nothing back. */
        if (at > 0 && isFinite(at)) { try { el.currentTime = at; } catch (e) {} }
        restoring.delete(el);
        resolve();
      };
      const timer = setTimeout(settle, RESTORE_WAIT_MS);
      el.addEventListener('loadedmetadata', settle);
      el.removeAttribute('src');
      el.load();
      el.setAttribute('src', url);
      el.load();
    });

    restoring.set(el, back);
  };

  /* How near the duration still counts as the end. Chromium's own end lands
     exactly on it, so this is only for a decode that leaves the position a hair
     short -- and a note stopped by hand inside the last frame of it is one
     whose card can wait for the end that is arriving anyway. */
  const END_SLACK = 0.05;

  /* At the end of the resource, whether or not the ended event has gone out
     yet. The element's own answer first, because it is the one that is right
     before the event is. */
  const atEnd = el => {
    if (el.ended === true) return true;
    const at = el.currentTime, length = el.duration;
    return typeof length === 'number' && isFinite(length) && length > 0 &&
           typeof at === 'number' && length - at <= END_SLACK;
  };

  /* Watched on the element itself, once, at its first play. WhatsApp's voice
     notes are detached -- measured: isConnected false, and getRootNode answers
     the element -- so there is no path from one to window and a capture
     listener up there would never hear a thing. The pause event is where every
     way a note can stop meets: the button, another note starting, the page's
     own shortcut. */
  const watchPlayback = el => {
    if (el.__waWatched) return;
    el.__waWatched = true;
    /* The end of a note is Chromium's own business: it drops that player by
       itself and the card goes with it. And THE END ARRIVES AS A PAUSE --
       measured here, not reasoned about: playing a blob out fires
       `pause(ended=true, t=0.400/0.400)` and only then `ended`. So a flag set
       by an ended listener is set after the pause handler has already run, and
       every note that played out was being recycled: WhatsApp rewinds a
       finished note when it hears `ended`, and the restore's seek put it
       straight back at the end, behind WhatsApp's back. An element parked
       there will not play again -- measured too: play() resolved, currentTime
       stayed 0.400, paused stayed true -- which is the note that needed its
       bar dragged back by hand before it would start over. */
    el.addEventListener('pause', () => {
      if (!hideControlsWhenPaused || atEnd(el)) return;
      if (conversationAudio(el)) recycle(el);
    });
  };

  /*
   * And the client's OWN card, which none of the above touches.
   *
   * Everything up to here is about the player CHROMIUM registers. This process
   * registers one too (src/mpris.js), it is what a media key is routed to, and
   * it answered CanPlay true from the moment it took its name -- so the shell
   * drew a card for it from launch and never had a reason to take it down. The
   * report was a call: the phone was answered, and a WhatsApp card was still
   * sitting in the notification centre reading "WhatsApp Voice Message", which
   * is the placeholder it was constructed with. Nothing had played. It had been
   * there all along.
   *
   * So the card is told what is actually happening, from the one place that
   * knows: the element. conversationAudio() is what keeps a CALL out of it --
   * it refuses a looping element and a stream, which is a ring and a call
   * respectively -- so a call raises no card and the ring that woke this report
   * never could have.
   *
   * The element is asked ONCE, here, and not again in the handlers: `emptied`
   * fires with the src already taken off, so a test made inside it would call
   * the note it is reporting the end of something else and say nothing.
   */
  let currentVoiceNote = null;

  const watchCard = el => {
    if (el.__waCard || !conversationAudio(el)) return;
    el.__waCard = true;
    const tell = state => {
      /* A previous note can pause or empty after its successor starts. Only
         the note being controlled may update the desktop's card. */
      if (currentVoiceNote !== el) return;
      const length = Number(el.duration), at = Number(el.currentTime);
      send('media', {
        state,
        durationSec: isFinite(length) ? length : 0,
        positionSec: isFinite(at) ? at : 0,
      });
    };
    el.addEventListener('play', () => {
      if (!conversationAudio(el)) return;
      currentVoiceNote = el;
      tell('playing');
    });
    /* A note played out arrives as a pause before it arrives as `ended` -- the
       same measurement the recycle above rests on -- so the end is read off the
       element rather than waited for, and the card goes at the end instead of
       sitting there offering to resume something that has finished. */
    el.addEventListener('pause', () => tell(atEnd(el) ? 'stopped' : 'paused'));
    el.addEventListener('ended', () => tell('stopped'));
    /* The resource going away, which is how a paused note ends when the recycle
       above runs: the card follows Chromium's out rather than outliving it. */
    el.addEventListener('emptied', () => tell('stopped'));
  };

  /* WhatsApp's audio elements are detached from the document. Keep the one
     that raised the card, including while its paused resource is restored, so
     a desktop control always reaches the same note without clicking a bubble
     or accidentally playing a ringtone or an older note. */
  on('media-control', command => {
    const el = currentVoiceNote;
    if (!el || !conversationAudio(el)) return;
    if (command === 'pause' || (command === 'playPause' && !el.paused)) {
      if (!el.paused) el.pause();
    } else if (command === 'play' || command === 'playPause') {
      if (el.paused) el.play().catch(err => log('could not resume voice note: ' + err.message));
    } else if (command === 'stop') {
      const stop = () => {
        /* Rewind before pause: recycling saves the position at pause time. */
        el.currentTime = 0;
        if (!el.paused) el.pause();
        if (currentVoiceNote === el)
          send('media', { state: 'stopped', durationSec: 0, positionSec: 0 });
      };
      const back = restoring.get(el);
      if (back) back.then(stop);
      else stop();
    }
  });

  /* Both ways a page can make a sound, because which one WhatsApp uses is not
     worth depending on: it has played its tones through an <audio> element for
     years, and the tone this client raises for its own banners goes through
     WebAudio -- a build that moved from one to the other is a build where this
     quietly stopped working. The client's own source is tagged, and exempt. */
  const interceptSounds = () => {
    if (window.HTMLMediaElement) {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        /* Pressed again while the src is still being put back, and asked
           before the muting is: an element mid-restore is a voice note by
           construction, and a note is the one thing the muting must never
           answer for. */
        const back = restoring.get(this);
        if (back) return back.then(() => play.apply(this, args));
        if (muted(this)) return Promise.resolve();
        /* The card goes on FIRST, and the order is load-bearing rather than
           tidy. Listeners for one event on one element run in the order they
           were added, and watchPlayback's `pause` handler RECYCLES the element
           -- which empties it, which is the card's own cue that the note is
           gone. Added the other way round, the card hears the teardown and then
           the pause, and settles on "paused": the resource is gone, nothing can
           resume, and the card sits in the notification centre anyway. Which is
           the bug this pair was written to answer. */
        watchCard(this);
        watchPlayback(this);
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
    if (USER_MEDIA.test(src)) return false;

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

  /* ---------------------------------------------------- the right-hand drawer */

  /*
   * Message info, contact info and in-chat search all slide in from the right,
   * and WhatsApp animates them with `flex-basis: 0% -> 30%` over 0.2s. That is a
   * layout property: every frame of it lays the whole app out again, the
   * conversation re-wraps every bubble it holds, and the open stutters (frame
   * gaps of 12 to 66ms, measured, and the same with this client's stylesheet
   * removed -- it is not ours).
   *
   * The stylesheet makes that animation instant, so the width is taken in one
   * layout (src/style.js), and the motion is put back here, on the compositor:
   * transform and opacity never touch layout. It has to be done from JavaScript
   * rather than in CSS because the panel is NOT unmounted when the drawer
   * closes -- measured: it stays in the DOM at flex-basis 0% -- so a CSS
   * animation on it plays once, at mount, and every open after the first is a
   * snap with no motion at all. What does happen on every open is WhatsApp
   * starting its own animation again, and that is an event.
   *
   * The panel is clipped by the row around it, by #app, by body and by html
   * (all overflow: hidden, checked), so starting it a full panel-width to the
   * right shows nothing spilling past the window.
   */
  const DRAWER = '[data-testid="drawer-right"]';
  const SLIDE_MS = 200;
  let drawerSlide = null;

  /* Where the slide starts, in pixels, or 0 while the panel is still collapsed.
   *
   * Never a percentage. This began as `translateX(100%)` applied on the event
   * itself, and a percentage is resolved against the box on every frame it is
   * sampled: when the event arrives while WhatsApp's own animation is still on
   * its first frame -- flex-basis 0%, no width -- the offset starts at nothing
   * and GROWS to a panel-width while the slide plays. The panel appears in
   * place, jumps sideways and comes back. That is the glitch that shipped, and
   * it is why the drawer looked as though it had opened from the wrong side.
   *
   * The side is measured rather than assumed: an Arabic interface puts this
   * panel on the left of the window, and sliding in from the far side of the
   * screen is the same glitch by another route. */
  const slideOffset = panel => {
    const box = panel.getBoundingClientRect();
    if (!(box.width > 0)) return 0;
    const middle = (box.left + box.right) / 2;
    return Math.round(middle > innerWidth / 2 ? box.width : -box.width);
  };

  const slideTheDrawer = () => {
    addEventListener('animationstart', event => {
      const panel = event.target;
      /* The panel itself, not the animations WhatsApp runs on things inside it.
         Message info, contact info and group info are all this one panel --
         checked on the live page: group info renders
         [group-info-participants-section] inside [data-testid="drawer-right"],
         and the same keyframes start on the panel for all three. */
      if (!(panel instanceof Element) || !panel.matches || !panel.matches(DRAWER)) return;
      if (typeof panel.animate !== 'function') return;

      /* A frame later, so the width is settled and can be measured once.
       *
       * Nothing is painted in place in the meantime, which was the worry.
       * Measured on the live page: the event arrives on the very frame the
       * width lands (event t == that frame's time, width already 512), and a
       * callback registered from inside an event handler runs in THAT frame's
       * callback list, before style and paint. Read back from a second
       * listener added after this one -- so it runs second, in the same frame
       * -- the panel is already at translate 512px, opacity 0. The frame the
       * drawer becomes wide is the frame it is offset in.
       *
       * The retry is for the other order: an event on the frame where
       * flex-basis is still 0% leaves nothing to measure, and one snap with no
       * motion is better than a slide of nought pixels. A close needs no guard
       * of its own -- measured, it starts no animation at all, the width simply
       * drops to 0 -- but a panel that never widens gives up after three
       * frames all the same. */
      let tries = 3;
      const start = () => {
        let offset = 0;
        try { offset = slideOffset(panel); } catch (err) { return; }
        if (!offset) {
          if (--tries > 0) requestAnimationFrame(start);
          return;
        }
        try {
          if (drawerSlide) drawerSlide.cancel();
          drawerSlide = panel.animate(
            [{ transform: 'translate3d(' + offset + 'px, 0, 0)', opacity: 0 },
             { transform: 'none', opacity: 1 }],
            { duration: SLIDE_MS, easing: 'cubic-bezier(0.16, 0.84, 0.44, 1)' });
        } catch (err) { /* an older engine: the drawer simply appears */ }
      };
      requestAnimationFrame(start);
    }, true);
  };

  slideTheDrawer();

  /* ------------------------------------------ the reply bar over the composer */

  /*
   * Reply to a message and a bar carrying the quoted one rises over the
   * composer; send the reply or dismiss it, and the bar goes again.
   *
   * WhatsApp moves that bar with Web Animations now. Measured on the live page
   * 2026-10-11, both on [data-testid="popup_panel"] and both filled forwards
   * and committed inline when they finish:
   *
   *   open    max-height 0 -> 200px, translateY(24px) -> 0, 300ms
   *   close   the same backwards, cubic-bezier(0.47, 0, 0.745, 0.715), 300ms
   *
   * and the close finishing is what unmounts the bar. It used to be Velocity
   * writing those two inline on every frame, which is what the first version of
   * this section listened for, and the change broke it quietly and badly. The
   * close was noticed only when WhatsApp committed its final frame, 300ms in
   * and 3ms before the unmount; the bar shrank through a layout animation of
   * its own in the meantime, a strip of bare wallpaper opened where it had
   * been, and 20ms after the unmount the conversation was handed its room back
   * with nobody watching and dropped 72px in a single frame. A reply being SENT
   * was worse again: the message landed while the bar still stood, so its
   * entrance played out of sight behind it.
   *
   * The room the bar takes comes out of the conversation, and that is the other
   * half. It is a spacer between the conversation and the footer -- `#main >
   * div`, childless, an inline height -- which WhatsApp sizes to the bar a
   * couple of frames after the bar has its height (measured: 30ms after the
   * open, 20ms after the unmount). The conversation is the flex item above it,
   * so it shrinks or grows by a bar-height in one layout, and one held at its
   * bottom is scrolled by the same amount in the same frame.
   *
   * Both are taken over at the one moment WhatsApp announces them, which is the
   * animate() call itself: made with the bar in the page, in its footer and at
   * its full height (checked: 67px), before the frame that would first draw it.
   *
   * Opening, WhatsApp's animation is finished on the spot, so the bar takes its
   * height in one layout, and what moves is its card -- the span carrying its
   * corners and shadow -- sliding up out from behind the composer, which is
   * drawn over it (z-index 2 against auto, checked), clipped at the composer's
   * edge so it never shows below it. The spacer is held where it was while the
   * card rises. Let go, WhatsApp's write lands at once, the conversation's clip
   * edge jumps up a bar-height, and the last message is cut off above a card
   * that has barely begun to move -- so instead the messages rise with the
   * card, by a transform, to the frame, and only when the card is up is the
   * spacer let go: the conversation takes its new size and its new scroll in
   * one layout and the transform comes off in that same frame, which nets out
   * to nothing on screen.
   *
   * Closing, WhatsApp's animation is again finished on the spot, and the bar
   * unmounts with it, but a copy of the card stays where it stood and slides
   * down behind the composer, and the room is handed back in the same breath
   * rather than whenever WhatsApp gets to it -- the conversation follows the
   * card down into it. Unless the close is a reply being sent: then the card
   * fades out of the way, the message lands in that room 35-80ms later, and the
   * room and the message are made one motion -- see the holds below.
   */
  const PANEL = 'footer [data-testid="popup_panel"]';
  /* The card's rise and its fall. The rise starts gently rather than at its
     fastest: its first frames are the ones most likely to come late -- WhatsApp
     renders the bar's contents in a 48ms task right beside them, measured --
     and a frame missed at the steep top of a curve is a visible jump. The fall
     eases in and out: the conversation rides down with the card, and a
     conversation that stops at full speed lands with a thud. */
  const BAR_IN_MS = 240;
  const BAR_OUT_MS = 200;
  const BAR_IN = 'cubic-bezier(0.33, 1, 0.68, 1)';
  const BAR_OUT = 'cubic-bezier(0.4, 0, 0.2, 1)';
  /* A reply being sent does not follow the card down -- its message comes up
     where the card was -- so the card gets out of the way instead: it fades
     as it drops, and is gone in the time the message takes to arrive. Slid
     whole, it stood over the message coming up beneath it for most of its
     200ms, seen frame by frame. */
  const BAR_FADE_MS = 150;
  /* Only the card's bottom is clipped, where it goes behind the composer; the
     shadow along its top edge stays drawn. */
  const BAR_CLIP = 'inset(-24px -24px 0px -24px)';
  /* How long a closing bar's room is waited for. Handed back by `fall` itself
     it comes in the next frame; this is for a footer with no spacer to hold,
     where WhatsApp hands it back in its own time. Measured: 20-40ms after an
     Escape, but 108-118ms after a reply sent, behind WhatsApp's own work on
     the send -- past the 120ms first allowed here, which let the room come
     back with nobody watching, the very drop this is here to stop. */
  const BAR_ROOM_MS = 400;
  /* And how long the card's copy waits for it before leaving alone: it goes
     down WITH the conversation when it can, and on its own rather than
     standing still. */
  const BAR_GHOST_WAIT_MS = 120;
  /* How long a rising bar's room is waited for once its spacer is let go: one
     that never comes means WhatsApp never asked for any, and the messages go
     back where they were. */
  const BAR_SETTLE_MS = 600;
  /* A reply going out: how recent a send has to be to have dismissed the bar,
     and how long the conversation then waits for the message before moving
     without it. Measured: the bar is dismissed 20ms after Enter, and the
     message lands 35-80ms after that, the longer while WhatsApp's main thread
     is busiest. */
  const SEND_FRESH_MS = 250;
  const SEND_LANDS_MS = 220;

  /* The conversation is the other half of this motion, and the half the eye is
     actually on.

     What is moved is the list INSIDE the scroller and never the scroller
     itself. A transform on the scroller moves its top edge too and opens a
     gap under the header; a transform on the list is clipped by the
     scroller's own overflow. Nothing about scrolling changes -- a transform is
     not layout, so scrollTop and scrollHeight are what they were.

     It is looked up from the panel outwards rather than from #main, because a
     community thread draws its own conversation in a panel outside #main and a
     reply written there moves its own messages, not the ones behind it. */
  const CONVERSATION_LIST = '[data-testid="conversation-panel-messages"]';

  /* The scroller is not the thing that grows: the rows live in one child of it,
     and that child is the only one with any in it. */
  const rowsInside = scroller =>
    [...scroller.children].find(kid => kid.querySelector('[role="row"]')) || null;

  const roomBehind = panel => {
    for (let where = panel.parentElement; where; where = where.parentElement) {
      const scroller = where.querySelector(CONVERSATION_LIST);
      if (scroller) return { scroller: scroller, list: rowsInside(scroller) };
    }
    return null;
  };

  /* The spacer that holds the bar's room: the footer's elder sibling, a
     childless box. A footer that has none -- a layout this has not seen -- has
     its room answered as it comes instead of held. */
  const spacerOf = panel => {
    const foot = panel.closest('footer');
    const spacer = foot && foot.previousElementSibling;
    return spacer && spacer.tagName === 'DIV' && !spacer.firstElementChild ? spacer : null;
  };

  /* The spacer held at a height of ours, which outranks the inline one
     WhatsApp writes without touching it. One hold per spacer: a bar opened
     straight after one closed replaces the close's hold with its own.
     `until` lets go of the hold by itself once WhatsApp has written that same
     height -- from then on the hold changes nothing. */
  const spacerHolds = new WeakMap();
  const releaseSpacer = spacer => {
    const hold = spacer && spacerHolds.get(spacer);
    if (!hold) return;
    spacerHolds.delete(spacer);
    if (hold.watch) hold.watch.disconnect();
    hold.animation.cancel();
  };
  const holdSpacer = (spacer, height, until = null) => {
    releaseSpacer(spacer);
    const hold = { animation: null, watch: null };
    try {
      hold.animation = spacer.animate([{ height: height }, { height: height }],
                                      { duration: 1, fill: 'forwards' });
    } catch (err) { return false; }
    spacerHolds.set(spacer, hold);
    if (until !== null) {
      const written = () => parseFloat(spacer.style.height) === until;
      if (written()) { releaseSpacer(spacer); return true; }
      try {
        hold.watch = new MutationObserver(() => {
          if (written() && spacerHolds.get(spacer) === hold) releaseSpacer(spacer);
        });
        hold.watch.observe(spacer, { attributes: true, attributeFilter: ['style'] });
      } catch (err) { hold.watch = null; }
    }
    return true;
  };

  const { park, letGo, shift, stop: stopMotion } = motion.create();

  /* How far down a thing is at this instant, mid-motion and all: a transition
     resolves to a matrix, and the vertical of one is its 6th number in two
     dimensions and its 14th in three. Read rather than worked out, because the
     point of asking is to carry on from wherever the eye last saw it. */
  const liftOf = element => {
    const shape = getComputedStyle(element).transform;
    if (!shape || shape.indexOf('(') < 0) return 0;
    const numbers = shape.slice(shape.indexOf('(') + 1, -1).split(',').map(parseFloat);
    if (numbers.length === 6) return numbers[5] || 0;
    if (numbers.length === 16) return numbers[13] || 0;
    return 0;
  };

  const pinnedAt = scroller =>
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= ARRIVAL_PIN_SLACK;

  /*
   * What a conversation is still waiting for before it moves: the room a
   * departing bar is about to hand back, and the message a send is about to
   * land.
   *
   * Whatever comes first parks the list where the eye last saw it, composed
   * with whatever is already there, and only the last of them lets go -- so a
   * reply sent is ONE glide, by the net of the two (the message's room less
   * the bar's: 106 - 67 = 39px, measured), and not a slide down into the room
   * the bar gave up followed by a slide back up out of it. When the message
   * has come its timing is the one used, because the net motion is its own.
   *
   * Every wait has a deadline. A send that lands nothing -- an Enter on an
   * empty composer, a voice note whose row is slow -- costs at most the wait,
   * and the conversation then moves without it.
   */
  const holds = new WeakMap();
  /* When a message last landed in each list, in the clock `sentAt` keeps. */
  const landedAt = new WeakMap();
  const settleHold = (list, hold) => {
    const now = performance.now();
    if (hold.room && hold.room <= now) hold.room = 0;
    if (hold.message && hold.message <= now) hold.message = 0;
    clearTimeout(hold.timer);
    const due = Math.min(hold.room || Infinity, hold.message || Infinity);
    if (due !== Infinity) {
      hold.timer = setTimeout(() => settleHold(list, hold), due - now + 1);
      return;
    }
    if (holds.get(list) === hold) holds.delete(list);
    if (hold.glide) letGo(list, hold.glide.ms, hold.glide.easing);
    for (const then of hold.then.splice(0)) { try { then(); } catch (err) {} }
  };
  const awaitOn = (list, what, ms) => {
    let hold = holds.get(list);
    if (!hold) {
      hold = { room: 0, message: 0, timer: 0, glide: null, byMessage: false, then: [] };
      holds.set(list, hold);
    }
    hold[what] = performance.now() + ms;
    settleHold(list, hold);
  };
  /* Something the list was waiting for has come, and has parked it if it
     moved anything; `ms` of 0 says it moved nothing. */
  const cameOn = (list, what, ms, easing) => {
    const hold = holds.get(list);
    if (!hold) { if (ms) letGo(list, ms, easing); return; }
    hold[what] = 0;
    if (ms && (what === 'message' || !hold.byMessage)) {
      hold.glide = { ms: ms, easing: easing };
      hold.byMessage = what === 'message';
    }
    settleHold(list, hold);
  };

  /*
   * The room changing hands, answered in the frame it does and never a frame
   * before or after it.
   *
   * It is answered by the same reading the arrivals take further down
   * (`settled`), which already runs in every frame the scroller changes size --
   * a ResizeObserver, after layout and before paint, with the size that frame
   * really has. One reading for both, and that is not tidiness. What it reads
   * is how far the MESSAGES moved, held on rows near the bottom and against the
   * scroller's own top; the obvious reading, the list's top edge, is the one
   * that was tried first here and it is wrong for the reason given there:
   * measured on a reply sent, WhatsApp handed the room back in the same frame
   * as it dropped three rows off the top, the list's top edge moved 232px and
   * the messages 67, and parking by the first threw the conversation 181px up
   * the screen. And a message landing between the bar's dismissal and its room
   * coming back is already in the reading: two readers would each answer it.
   *
   * What moved is not how much room changed hands, either: a conversation held
   * at its bottom is scrolled by the room, one the owner has scrolled up into
   * gains or loses it off its bottom edge without moving a pixel, and only the
   * first has anything to answer.
   *
   * `keep` asks for a conversation that was at its bottom when the bar came to
   * still be at its bottom once the room is taken: its spacer was held while the
   * bar rose, so whatever scroll WhatsApp gave it at the time was spent against
   * a conversation that could not move, and this is where it is put right.
   *
   * `then(moved, late)` -- how far the messages went UP, the way the arrivals
   * count it; null when the frame's message landing has already answered it;
   * `late` when no room came in time.
   */
  const roomWatches = new WeakMap();
  const awaitRoom = (list, { keep = false, ms, then }) => {
    adoptConversation();
    const previous = roomWatches.get(list);
    if (previous) clearTimeout(previous.timer);
    const watch = { keep: keep, then: then, timer: 0 };
    watch.timer = setTimeout(() => {
      if (roomWatches.get(list) !== watch) return;
      roomWatches.delete(list);
      then(0, true);
    }, ms);
    roomWatches.set(list, watch);
  };
  /* Taken by the reading, in the frame the scroller changed size. */
  const roomTaken = list => {
    const watch = roomWatches.get(list);
    if (!watch) return null;
    roomWatches.delete(list);
    clearTimeout(watch.timer);
    return watch;
  };

  /* Each bar this has taken over, and what it is doing. */
  const bars = new WeakMap();

  /* The bar arriving. False when it is not a bar this can move, which leaves
     WhatsApp's own animation to run as it was called. */
  const rise = panel => {
    const span = panel.parentElement;
    const clipHost = span && span.parentElement;
    if (!clipHost || span.children.length !== 1 || !panel.closest('footer')) return false;
    const height = Math.round(span.getBoundingClientRect().height);
    if (!(height > 0)) return false;
    const room = roomBehind(panel);
    const list = room && room.list;
    const spacer = spacerOf(panel);
    const state = { span, clipHost, height, room, spacer, slide: null, timer: 0, rising: true };

    /* No spacer to hold: the bar is simply there, and the conversation glides
       out of its way when the room comes. */
    if (!spacer || !holdSpacer(spacer, getComputedStyle(spacer).height)) {
      if (list) awaitRoom(list, { ms: BAR_SETTLE_MS, then: moved => {
        if (!moved) return;
        park(list, liftOf(list) + moved);
        letGo(list, BAR_IN_MS, BAR_IN);
      } });
      return true;
    }

    try {
      clipHost.style.clipPath = BAR_CLIP;
      state.slide = span.animate(
        [{ transform: `translate3d(0, ${height}px, 0)` }, { transform: 'none' }],
        { duration: BAR_IN_MS, easing: BAR_IN });
    } catch (err) {
      clipHost.style.clipPath = '';
      releaseSpacer(spacer);
      return false;
    }
    /* The messages ride up with the card -- only those held at the bottom,
       which are the ones WhatsApp would have scrolled. */
    state.pinned = !!list && pinnedAt(room.scroller);
    if (state.pinned) {
      const lift = liftOf(list);
      shift(list, lift, lift - height, BAR_IN_MS, BAR_IN);
    }
    bars.set(panel, state);
    state.timer = setTimeout(() => risen(panel, state), BAR_IN_MS);
    return true;
  };

  /* The card is up: the room is handed over, and the transform that stood in
     for it comes off in the frame it is. */
  const risen = (panel, state) => {
    if (bars.get(panel) !== state || !state.rising) return;
    state.rising = false;
    state.clipHost.style.clipPath = '';
    if (state.slide) { state.slide.cancel(); state.slide = null; }
    const list = state.room && state.room.list;
    if (list && list.isConnected) {
      awaitRoom(list, { keep: state.pinned, ms: BAR_SETTLE_MS, then: (moved, late) => {
        const lift = liftOf(list);
        /* No room ever came, and the messages that rose to make it go back. */
        if (late) { if (lift) { park(list, lift); letGo(list, BAR_OUT_MS, BAR_OUT); } return; }
        const rest = lift + (moved || 0);
        if (Math.abs(rest) < 1) { stopMotion(list); return; }
        park(list, rest);
        letGo(list, BAR_IN_MS, BAR_IN);
      } });
    }
    releaseSpacer(state.spacer);
  };

  /*
   * The bar leaving: a copy of its card left where it stood, slid down behind
   * the composer as the room comes back.
   *
   * The room is handed back here and now, by holding the spacer at nothing,
   * rather than when WhatsApp gets round to it -- which on a reply being sent
   * is 108-118ms later, measured, behind its own work on the send, and the
   * message landed into a room that was not there yet: it waited out of sight
   * below the bar's edge while the bar went, and only then came up, one motion
   * after the other. Handing the room back early costs nothing on the scroll:
   * a conversation at its bottom that grows at its bottom edge stays at its
   * bottom by the browser's own clamping, which is the very scroll WhatsApp's
   * own hand-back gets -- only it comes in the next frame instead of 100ms on.
   * WhatsApp's own write of nothing, when it comes, then changes nothing, and
   * the hold lets go of itself.
   */
  const fall = panel => {
    const span = panel.parentElement;
    const foot = panel.closest('footer');
    if (!span || !foot || span.children.length !== 1) return false;
    const state = bars.get(panel);
    bars.delete(panel);
    let from = 0;
    if (state) {
      clearTimeout(state.timer);
      if (state.rising) {
        /* Dismissed while still rising: it leaves from where it has got to. */
        from = Math.max(0, Math.round(liftOf(span)));
        if (state.slide) { state.slide.cancel(); state.slide = null; }
        state.clipHost.style.clipPath = '';
        state.rising = false;
      }
    }
    /* Whether there is any room to hand back: none, if the bar is going before
       its rise had handed any over. */
    const spacer = spacerOf(panel);
    const given = spacer ? parseFloat(getComputedStyle(spacer).height) > 0 : true;
    if (spacer) holdSpacer(spacer, '0px', 0);
    const box = span.getBoundingClientRect();
    const height = Math.round(box.height);
    let ghost = null;
    let copy = null;
    if (height > 0 && from < height) {
      const footBox = foot.getBoundingClientRect();
      ghost = document.createElement('div');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.cssText = 'position: absolute; pointer-events: none; ' +
        `left: ${box.left - footBox.left}px; top: ${box.top - footBox.top}px; ` +
        `width: ${box.width}px; height: ${box.height}px; clip-path: ${BAR_CLIP};`;
      copy = span.cloneNode(true);
      /* Nothing in the copy may answer to what the real bar answers to: not
         this file's mount hook, not WhatsApp's own lookups. */
      for (const el of [copy, ...copy.querySelectorAll('[data-testid], [id]')]) {
        el.removeAttribute('data-testid');
        el.removeAttribute('id');
      }
      if (from) copy.style.transform = `translate3d(0, ${from}px, 0)`;
      ghost.appendChild(copy);
      foot.appendChild(ghost);
    }
    /* The real bar out of the footer in this same frame, now that its copy is
       standing where it stood. WhatsApp will not unmount it for most of a
       third of a second (measured: 299ms after the X), and src/style.js pins
       the height it would shrink by, so without this the copy falls away in
       front of a bar still drawn at full height behind it. The mark is read
       by that sheet; the style attribute React owns is not touched. */
    panel.setAttribute('data-wa-reply-bar', 'going');
    let gone = false;
    const leave = fade => {
      if (gone || !ghost) return;
      gone = true;
      const away = () => ghost.remove();
      const rest = 1 - from / height;
      try {
        const run = copy.animate(fade
          ? [{ transform: `translate3d(0, ${from}px, 0)`, opacity: 1 },
             { transform: `translate3d(0, ${Math.round(from + (height - from) / 2)}px, 0)`, opacity: 0 }]
          : [{ transform: `translate3d(0, ${from}px, 0)` }, { transform: `translate3d(0, ${height}px, 0)` }],
          { duration: Math.max(60, Math.round((fade ? BAR_FADE_MS : BAR_OUT_MS) * rest)),
            easing: BAR_OUT, fill: 'forwards' });
        run.onfinish = away;
      } catch (err) { away(); }
      setTimeout(away, BAR_OUT_MS + 300);
    };

    const room = roomBehind(panel);
    const list = room && room.list;
    if (!list) { leave(false); return true; }
    /* A reply going out: the conversation waits for its message rather than
       following the card down, so the card has nobody to wait for and goes at
       once. Unless the message is already in. */
    const sending = Date.now() - sentAt <= SEND_FRESH_MS;
    if (sending && (landedAt.get(list) || 0) < sentAt) awaitOn(list, 'message', SEND_LANDS_MS);
    if (sending) leave(true);
    else setTimeout(() => leave(false), BAR_GHOST_WAIT_MS);
    if (!given) {
      /* No room was ever handed over, so none comes back: the messages that
         were rising with the card go back down with it. */
      const lift = liftOf(list);
      if (lift) park(list, lift);
      cameOn(list, 'room', lift ? BAR_OUT_MS : 0, BAR_OUT);
      leave(sending);
      return true;
    }
    awaitOn(list, 'room', BAR_ROOM_MS);
    awaitRoom(list, { ms: BAR_ROOM_MS, then: moved => {
      if (moved) park(list, liftOf(list) + moved);
      cameOn(list, 'room', moved ? BAR_OUT_MS : 0, BAR_OUT);
      leave(sending);
    } });
    return true;
  };

  /*
   * When the bar arrives and when it goes, and why neither is an animate()
   * call any more.
   *
   * This section used to take the bar over by wrapping
   * Element.prototype.animate: WhatsApp moved the bar with Web Animations,
   * and the call itself was the one moment it announced the open and the
   * close. It does not any more.
   *
   * MEASURED on the live page 2026-11-01, with the prototype wrapped and
   * every animate() on anything inside the footer logged: the log came back
   * EMPTY through an open and a close. What the panel's style attribute shows
   * over the same open is a script tween, written inline frame after frame
   * for about 190ms --
   *
   *   max-height: 0px -> 0.62 -> 10.7 -> 12.8 -> 15.2 -> 17.5 -> 20.2 -> ...
   *   transform:  translateY(24px) -> 23.93 -> 22.71 -> 22.46 -> 22.18 -> ...
   *
   * -- which is what Velocity used to do here, and what the Web Animations
   * takeover was written to replace. So the takeover had quietly not run for
   * some time: no card, no messages riding up with it, and a `max-height`
   * tween laying out the footer and the whole conversation on every one of
   * its frames. Sampled together: the panel grew 1, 4, 8, 13, 20, 27, 37, 48,
   * 61, 75, 90, 91px while the scroller went 853 -> 762 and its scrollTop
   * 3609 -> 3700, in frames of 5, 11, 26, 8, 20, 19, 13, 12, 19, 16, 13 and
   * 18ms against a display that draws one every 6.
   *
   * The tween is answered where it can be answered without listening for
   * anything: src/style.js pins `max-height` and `transform` at user origin,
   * which outranks the inline declaration WhatsApp writes without touching
   * the style attribute React owns. Every write then decides nothing, and the
   * bar takes its height in one layout.
   *
   * That leaves the two moments, and the page still offers both:
   *
   *  - the open is the one-millisecond animation src/style.js puts on every
   *    popup_panel, raised once per mount in every chat, group and community.
   *    The same event this file already puts the caret back on.
   *  - the close is WhatsApp writing `max-height: 0px` in a single step, 3.8ms
   *    before it unmounts the panel and 16ms before the spacer hands the room
   *    back -- measured. An observer on the panel's own style attribute runs
   *    as a microtask, so `fall` still has the bar in the page to copy.
   *
   * The removal is watched alongside it, in the same observer and over the
   * footer only, for a close that comes some other way.
   *
   * The animate() wrapper is kept behind both. It costs one `getAttribute` on
   * calls this page makes anyway, and the day WhatsApp goes back to Web
   * Animations -- it has moved between the two once already -- the bar is
   * taken over at the call again, ahead of the mount. Whichever arrives
   * first wins: `bars` is what says a panel is already in hand.
   *
   * A desktop that has asked for less motion gets the same instant bar and
   * none of the motion of ours.
   */
  const PANEL_MOUNT_NAME = 'whatsapp-desktop-panel';

  /* One way in for each moment, whatever raised it. */
  const barArrived = panel => {
    if (bars.has(panel) || closers.has(panel)) return false;
    watchForTheClose(panel);
    return stillnessAsked() ? true : rise(panel);
  };
  const barLeaving = panel => {
    const closer = closers.get(panel);
    if (closer) { closers.delete(panel); closer.disconnect(); }
    return stillnessAsked() ? true : fall(panel);
  };

  /*
   * The close, read off the same tween -- at its FIRST frame and not its last.
   *
   * Dismissing the bar runs the open's tween backwards, and that one is not
   * instant: MEASURED on the live page 2026-11-01, the X clicked and the
   * panel's style attribute sampled on every mutation,
   *
   *   max-height: 199.4 -> 198.6 -> 197.8 -> 196.8 -> 195.6 -> ... -> 1.6 -> 0
   *
   * over 292ms, and only then is the panel unmounted (at 299ms) and the room
   * handed back (at 312ms). Pinned by src/style.js, every one of those writes
   * draws nothing -- so a close answered at `max-height: 0` is a bar that
   * stands at its full height, untouched, for most of a third of a second
   * after it was dismissed. That is the delay the owner reported on the X,
   * and it is this client's doing: unpinned the bar at least shrank, badly.
   *
   * So the close is the first write that goes DOWN. A fall of more than a
   * couple of pixels below the tallest this bar has been, which the opening
   * tween cannot produce -- it only ever climbs -- and which a settle of a
   * pixel at the top of the open cannot either. Measured, that is 196.8px at
   * 11.8ms rather than 0px at 291.6ms.
   *
   * The write to nothing and the unmount are both kept behind it, for a close
   * that comes some other way: Escape writes 0 in a single step, and a chat
   * switched out from under the bar takes the whole footer with it.
   *
   * Scoped to the bar and the footer deliberately. The removal could be read
   * off the document, and a childList observer over the whole page would then
   * run on every row the conversation drops off its top and walk every
   * subtree a chat switch takes away. The footer is a dozen nodes.
   */
  const BAR_CLOSING_PX = 2;
  const closers = new WeakMap();
  const watchForTheClose = panel => {
    if (typeof MutationObserver !== 'function') return;
    const foot = panel.closest('footer');
    let tallest = parseFloat(panel.style.maxHeight);
    if (!(tallest > 0)) tallest = 0;
    let watch;
    try {
      watch = new MutationObserver(records => {
        for (const record of records) {
          if (record.type === 'attributes') {
            const now = parseFloat(panel.style.maxHeight);
            if (!(now >= 0)) continue;
            if (now > tallest) { tallest = now; continue; }
            if (now === 0 || tallest - now > BAR_CLOSING_PX) { barLeaving(panel); return; }
            continue;
          }
          for (const node of record.removedNodes) {
            if (node.nodeType === 1 && (node === panel || node.contains(panel))) {
              barLeaving(panel);
              return;
            }
          }
        }
      });
      watch.observe(panel, { attributes: true, attributeFilter: ['style'] });
      if (foot) watch.observe(foot, { childList: true, subtree: true });
    } catch (err) { return; }
    closers.set(panel, watch);
  };

  const takeOverTheReplyBar = () => {
    addEventListener('animationstart', event => {
      const panel = event.target;
      if (event.animationName !== PANEL_MOUNT_NAME) return;
      if (!(panel instanceof Element) || !panel.matches || !panel.matches(PANEL)) return;
      try { barArrived(panel); } catch (err) { /* the bar is simply there */ }
    }, true);

    const proto = typeof Element === 'function' ? Element.prototype : null;
    const native = proto && proto.animate;
    if (typeof native !== 'function' || native.__waReplyBar) return;
    const barFrames = (element, frames) =>
      Array.isArray(frames) && frames.length >= 2 &&
      element.getAttribute && element.getAttribute('data-testid') === 'popup_panel' &&
      frames.every(frame => frame && frame.maxHeight !== undefined);
    const animate = function (frames, options) {
      try {
        if (barFrames(this, frames) && this.closest('footer')) {
          const closing = parseFloat(frames[frames.length - 1].maxHeight) === 0;
          if (closing ? barLeaving(this) : barArrived(this)) {
            options = typeof options === 'object' && options
              ? { ...options, duration: 0, delay: 0, endDelay: 0 }
              : { duration: 0, fill: 'forwards' };
          }
        }
      } catch (err) { /* WhatsApp's own animation, as it was called */ }
      return native.call(this, frames, options);
    };
    for (const key of Object.keys(native)) animate[key] = native[key];
    animate.__waReplyBar = true;
    proto.animate = animate;
  };

  takeOverTheReplyBar();

  /* ------------------------------------- a message landing in the open room */

  /*
   * A message arriving in the conversation on screen -- sent or received --
   * measured on the live page 2026-09-04 with the rows sampled every frame.
   *
   * There is no motion in it at all. WhatsApp appends the row and, when the
   * conversation is held at its bottom, scrolls by exactly the room the row
   * took, both in the SAME frame. From a 55px message: scrollTop 2576 -> 2631,
   * scrollHeight 3363 -> 3418, the list's own top -55px, and the row that used
   * to be last stayed at viewport top 778 while everything above it stepped up
   * 55 pixels in one go. The new bubble is simply there, already at rest.
   *
   * So the whole conversation jumps a message-height every time one lands, and
   * that jump is the thing to answer. It is answered the way the reply bar's is:
   * the list is put back where the eye last saw it and glided to where WhatsApp
   * has already scrolled it, which costs a compositor transform and no layout,
   * and the arriving bubble grows into place out of its own bottom corner over
   * the same window. Nothing about scrolling changes -- a transform is not
   * layout, so scrollTop and scrollHeight are what WhatsApp set them to.
   *
   * What the DOM offers to hang this on, all checked rather than assumed on
   * this build:
   *
   *  - `message-in` / `message-out` ARE GONE. Every class on a row is
   *    obfuscated now (`x1n2onr6 xscbp6u`), and the only semantic names left
   *    anywhere inside #main are selectable-text, copyable-text, copyable-area
   *    and the html-* ones. So which side a message came from is measured from
   *    the bubble's box instead -- which is also the only reading that survives
   *    an Arabic interface, where the sides are the other way round.
   *  - The bubble is `[data-testid="msg-container"]`, and a row that has none is
   *    not a message: "Your security code changed" and the day separators are
   *    rows too, and they are centred rather than on either side.
   *  - The row is NOT the node the mutation reports. WhatsApp appends a plain
   *    wrapper two levels down from the list and the row is inside it, so the
   *    added nodes are searched downwards for one.
   *
   * What it costs, measured at 165Hz against the same send with all of this
   * turned off: WhatsApp's own frame -- inserting the row and painting it --
   * runs 10 to 12ms, and with the glide and the pop on top of it 11 to 17ms.
   * Every frame after that one is 6ms, the display's own. The `will-change`
   * hint is free on the other side too: the client's scroll probe over the same
   * conversation answers 201/216ms blocked with it and 214/240ms without.
   */

  /* Keep the original send's corner pop, overshoot and timing. The performance
     changes concern how it is scheduled and measured, not its visual design.

     The glide under it is another matter. It used the reply bar's curve,
     cubic-bezier(0.16, 0.84, 0.44, 1), which is at its fastest on its first
     frame -- 6.3px of a 55px glide in the first 6ms. Those first frames are
     exactly the ones WhatsApp's own send work lands on: traced on real sends,
     three misses in the first ten frames of the glide where a bare glide of the
     same list has none, and a miss at the steepest point of the curve is a
     12px jump -- the stutter the owner saw as the message went. This curve
     starts at about half that speed and gives the time back at the end. */
  const ARRIVAL_GLIDE_MS = 280;
  const ARRIVAL_EASE = 'cubic-bezier(0.33, 1, 0.68, 1)';
  const ARRIVAL_POP_MS = 300;
  const ARRIVAL_POP = 'cubic-bezier(0.34, 1.28, 0.64, 1)';
  const ARRIVAL_POP_SCALE = 0.12;
  const ARRIVAL_POP_TRAVEL = 64;
  const ARRIVAL_SETTLE_MS = 160;
  /* More new rows than this below the newest one seen is a render, not
     messages landing -- the same eight the pending queue keeps. */
  const ARRIVAL_BURST = 8;
  /* And with no row seen at all, the first message of an empty chat at most. */
  const ARRIVAL_FIRST_ROWS = 2;
  const ARRIVAL_PIN_SLACK = 3;
  const ARRIVAL_ADOPT_MS = 600;

  /* GNOME's "Reduce animation" reaches Chromium as this query, and a desktop
     that has asked for less motion is not asking for a client with its own.
     Asked once and then listened to: matchMedia builds a new list object every
     call, and this one would be on the path of every message that lands. */
  let stillness = null;
  const stillnessAsked = () => {
    if (!stillness) {
      try { stillness = matchMedia('(prefers-reduced-motion: reduce)'); }
      catch (err) { return false; }
    }
    return stillness.matches;
  };

  const POP_SCALE_VAR = '--whatsapp-desktop-pop';
  const POP_KEYFRAMES = `@keyframes whatsapp-desktop-arrival {
  from { opacity: 0; transform: scale(var(${POP_SCALE_VAR}, 0.88)); }
  55%  { opacity: 1; }
  to   { opacity: 1; transform: none; }
}`;
  let popSheet = null;
  const keyframesReady = () => {
    if (popSheet?.isConnected) return true;
    const head = document.head || document.documentElement;
    if (!head) return false;
    popSheet = document.createElement('style');
    popSheet.textContent = POP_KEYFRAMES;
    head.appendChild(popSheet);
    return true;
  };
  const bubbleCleanups = new WeakMap();
  /* The original CSS corner-pop, with geometry supplied by the read phase.
     Its stylesheet is installed at adoption, never on the first send.

     `held` starts it paused at its first frame -- invisible, at its smallest --
     and hands back what plays it: a message that lands while a reply bar is
     still standing over it is out of sight until the bar's room comes back,
     and its entrance is for when it can be seen. */
  const popTheBubble = (bubble, box, room, held = false) => {
    if (!keyframesReady() || !(box.width > 0) || box.bottom < room.top || box.top > room.bottom) return null;
    const origin = ((room.right - box.right) <= (box.left - room.left) ? '100%' : '0%') + ' 100%';
    const from = 1 - Math.min(ARRIVAL_POP_SCALE,
      ARRIVAL_POP_TRAVEL / Math.max(box.width, box.height, 1));
    const previousCleanup = bubbleCleanups.get(bubble);
    const previousAnimation = previousCleanup && bubble.getAnimations?.()
      .find(animation => animation.animationName === 'whatsapp-desktop-arrival');
    previousCleanup?.();
    bubble.style.setProperty(POP_SCALE_VAR, from.toFixed(3));
    bubble.style.transformOrigin = origin;
    bubble.style.animation = 'whatsapp-desktop-arrival ' + ARRIVAL_POP_MS + 'ms ' + ARRIVAL_POP + ' both' +
      (held ? ' paused' : '');
    /* A recycled bubble can receive another message before its first pop ends.
       Reapplying the same CSS name alone keeps the old clock; rewind it so the
       new message receives the original entrance from its own first frame. */
    if (previousAnimation) {
      previousAnimation.currentTime = 0;
      if (held) previousAnimation.pause(); else previousAnimation.play();
    }
    let began = performance.now();
    let timer;
    const done = event => {
      if (event && (event.target !== bubble || event.animationName !== 'whatsapp-desktop-arrival')) return;
      if (event && performance.now() - began < ARRIVAL_POP_MS - 20) return;
      if (bubbleCleanups.get(bubble) !== done) return;
      clearTimeout(timer);
      bubble.removeEventListener('animationend', done);
      bubble.style.removeProperty(POP_SCALE_VAR);
      bubble.style.animation = '';
      bubble.style.transformOrigin = '';
      bubbleCleanups.delete(bubble);
    };
    bubbleCleanups.set(bubble, done);
    bubble.addEventListener('animationend', done);
    /* A pop held for longer than any hold lasts is let go as it stands -- the
       bubble at rest, with no entrance -- rather than left invisible. */
    timer = setTimeout(done, ARRIVAL_POP_MS + 250 + (held ? SEND_LANDS_MS : 0));
    if (!held) return null;
    return () => {
      if (bubbleCleanups.get(bubble) !== done) return;
      began = performance.now();
      bubble.style.animationPlayState = 'running';
      clearTimeout(timer);
      timer = setTimeout(done, ARRIVAL_POP_MS + 250);
    };
  };

  /* Every conversation panel on the page, which is two of them at most: the one
     in #main and the one a community thread draws in a dialog outside it. */
  const listsOnPage = () => {
    const out = [];
    for (const scroller of document.querySelectorAll(CONVERSATION_LIST)) {
      const list = rowsInside(scroller);
      if (list) out.push({ scroller: scroller, list: list });
    }
    return out;
  };

  const watched = [];

  /* How long a row the mutation saw waits for the frame's own layout to say
     what it cost. Stamped, because a list can change size for reasons that have
     nothing to do with a message -- a picture finishing, the window being
     dragged -- and a row remembered from two seconds ago is not what that resize
     is about. It is also what times out the rows that piled up while the window
     was behind another one, whose entrance was over before anyone could look. */
  const ARRIVAL_PENDING_MS = 180;

  const adoptArrivals = (scroller, list) => {
    const since = performance.now();

    /*
     * Where the conversation is, held on a MESSAGE at the bottom of it and not
     * on the top edge of the list.
     *
     * The list's own top was the obvious reading and it is the wrong one, which
     * cost the whole animation on and off until it was measured. WhatsApp keeps
     * a window of rows rather than the conversation, and drops old ones off the
     * top as new ones land -- so the list's top edge moves for reasons that have
     * nothing to do with the message, and the difference between two readings of
     * it is not how far anything the eye is on actually went. Sampled on the
     * live page against 65px messages: 14, 19, and -34. The last one is the
     * telling one: a 99px row left the top in the same frame a 65px message
     * arrived, the conversation moved up the full 65, and the top edge of the
     * list moved DOWN 34. A negative reading fails the test below and the
     * message lands with no motion at all.
     *
     * A row near the bottom answers the question that was being asked. It is
     * carried from one callback to the next and moves by exactly what the
     * conversation moves, whatever is being added or taken away above it, and
     * it is re-taken each time so that the reference is always one of the rows
     * still on screen.
     *
     * SEVERAL rows, and this is the whole of the "it animates one message and
     * not the next" the owner kept reporting. One row was held, the last one,
     * and the last row is the one WhatsApp is most likely to throw away: a
     * message is drawn optimistically the moment it is typed and REPLACED by
     * the acknowledged one a second or two later. Caught outright -- the last
     * row was swapped for a copy of itself between two sends, and the very next
     * message measured:
     *
     *   mark: false   moved: 0   go: false
     *
     * a message landing with no motion at all. It healed itself whenever
     * something else resized the list in between, which is why it came and
     * went. The rows above the last one are not swapped, they move by exactly
     * the same amount, and one of them is always still there -- so the reading
     * is taken from the lowest of a handful that has survived.
     *
     * And if every one of them has gone -- a screenful of history filled in, a
     * conversation re-rendered whole -- the scroller's own scrolling answers
     * instead. WhatsApp holds a conversation at its bottom by scrolling it by
     * the room each message takes, so that delta is the same travel by another
     * road. It is the second reading rather than the first because it also
     * moves for reasons the eye never sees: rows dropped off the top are paid
     * for out of scrollTop, and the messages on screen do not budge.
     *
     * Every reading is taken against the scroller's own top, not the window's.
     * The chat's entrance moves the whole conversation by a transform on the
     * scroller -- 6px while its history is still on the way, 4px on a switch
     * (navigation.js) -- and a reading taken while it ran and compared after it
     * had settled came out 6.5px wrong: measured on the first message sent
     * after opening a chat, a 54.5px travel parked at 61, so the conversation
     * dropped 6.5px the instant the message went and then rose. Measured from
     * the scroller, a transform on it moves both ends of the reading at once.
     */
    let marks = [];
    let scrolledFrom = 0;
    let heightWas = -1;
    const topIn = row => row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const marksOn = lift => {
      const rows = list.querySelectorAll('[role="row"]');
      marks = [];
      /* Spread rather than consecutive: a re-render that takes the last row
         usually takes its neighbour with it, and the one eight rows up costs
         the same to hold. */
      for (const back of [1, 2, 4, 8]) {
        const row = rows[rows.length - back];
        if (row) marks.push({ row: row, name: nameOf(row), top: topIn(row) - lift });
      }
      scrolledFrom = scroller.scrollTop;
      heightWas = scroller.clientHeight;
    };

    /* How far the messages the eye is on have moved since the last reading,
       with whatever motion of ours is on them taken back out -- so this is
       where the page would have the conversation rather than where a
       transition has it at this instant. Null when there is nothing left to
       measure against.

       Held on the MESSAGE, by its id, and only through the element while the
       element still carries it. The first message sent after the client
       starts has WhatsApp draw the whole window of rows again: every element
       held here was gone by the frame the message landed, the reading fell
       through to the scroll -- which a row dropped off the top had made -1 --
       and the message arrived with the conversation jumping 54px and no glide
       at all, measured. The same messages were all still on screen, in new
       elements; and an element WhatsApp recycles for another message is the
       opposite trap, there but no longer the message the reading was of. */
    const markedRow = mark => {
      if (mark.row.isConnected && (!mark.name || nameOf(mark.row) === mark.name)) return mark.row;
      if (!mark.name) return null;
      const tag = list.querySelector(`[data-id="${mark.name.replace(/["\\]/g, '\\$&')}"]`);
      return tag ? tag.closest('[role="row"]') || tag : null;
    };
    const travelled = lift => {
      for (const mark of marks) {
        const row = markedRow(mark);
        if (!row) continue;
        return Math.round(mark.top - (topIn(row) - lift));
      }
      return null;
    };

    /* The layer the glide moves, made now rather than on the frame it is first
       needed. A transform promotes the list, promoting it means rastering the
       conversation again, and asked for on the frame a message arrives that
       raster lands in the frame that should have been the first of the glide.
       Half a second after the chat opened there is nothing else going on.

       It is the list and not the scroller: src/style.js already promotes the
       scroller for scrolling, and this is the box inside it that moves. */
    list.style.willChange = 'transform';

    /*
     * Which messages have already had their entrance -- by the id WhatsApp
     * gives each MESSAGE, and deliberately not by the element it is drawn in.
     *
     * A WeakSet of elements was the obvious way and it is the bug the owner
     * kept seeing: a conversation is a fixed window of rows, and WhatsApp
     * RECYCLES them. Caught in the log -- three arrivals in a row, all held at
     * the bottom, and the row count never leaves 43:
     *
     *   ROW n=1 last-is-new  rows=43  ->  moved
     *   ROW n=2 last-is-new  rows=43  ->  NOTHING
     *   ROW n=1 last-is-new  rows=43  ->  moved
     *
     * The middle one took a row off the top and put it back at the bottom with
     * the new message inside it. The element had been seen, so it was refused,
     * and the message it was now carrying landed with no motion. Intermittent
     * exactly as reported, because it only happens once the window of rows is
     * full -- which is what a spell with the app minimised does to it. */
    const shown = new Set();
    const nameOf = row => {
      const tag = row.matches('[data-id]') ? row : row.querySelector('[data-id]');
      return tag ? tag.getAttribute('data-id') : '';
    };
    for (const row of list.querySelectorAll('[role="row"]')) {
      const name = nameOf(row);
      if (name) shown.add(name);
    }

    /* The rows this has recognised, waiting for the frame's own layout to say
       what they cost.
     *
     * A list and not a slot. Two messages can land in two mutation batches
     * before one frame's layout -- ordinary in a group where several people are
     * typing -- and the one held in a slot was overwritten by the second and
     * never got an entrance at all. That is the other half of "one message yes,
     * one message no". */
    let pending = [];

    /* Recognise identities without measuring in a mutation microtask. A
       recycled row may receive a new data-id or bubble without being appended;
       a burst may append several messages in one batch. Only a batch touching
       the tail is an arrival, so filling older history never starts a glide. */
    const watch = new MutationObserver(records => {
      const candidates = new Set();
      for (const record of records) {
        if (record.type === 'attributes') {
          const row = record.target.closest('[role="row"]');
          if (row) candidates.add(row);
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.matches('[role="row"]')) candidates.add(node);
          for (const row of node.querySelectorAll('[role="row"]')) candidates.add(row);
          const row = node.closest('[role="row"]');
          if (row) candidates.add(row);
        }
      }
      if (!candidates.size) return;
      const rows = list.querySelectorAll('[role="row"]');
      if (!candidates.has(rows[rows.length - 1])) return;
      /*
       * Only what lands BELOW the newest message already seen is arriving.
       *
       * A conversation opened for the first time in a session holds one row
       * -- its last message, the one the chat list shows -- and fetches the
       * rest from the local store a moment later. Measured on the live
       * client: the row at +101ms, the history (22 rows) at +292ms, and the
       * time rule above let it through, 130ms past the settle. The batch
       * touched the tail (the history is rendered afresh, the last row with
       * it) and every message in it was new to this list, so seven old
       * messages popped into place at once as though they had just been sent
       * -- the "the opening animation breaks" the owner reported.
       *
       * A history fill keeps the newest message where it was and puts the
       * rest ABOVE it; an arrival puts something below it. So the rows after
       * the newest one already seen are the only candidates, and a batch with
       * no row seen at all -- a different conversation in a reused list, a
       * jump to the latest messages -- is a render unless it is one or two
       * rows, which is the first message of an empty chat.
       */
      let newest = rows.length - 1;
      while (newest >= 0 && !shown.has(nameOf(rows[newest]))) newest--;
      const landing = new Set();
      for (let i = newest + 1; i < rows.length; i++) landing.add(rows[i]);
      const arriving = landing.size <= (newest < 0 ? ARRIVAL_FIRST_ROWS : ARRIVAL_BURST);
      const now = performance.now();
      const canPlay = arriving && now - since >= ARRIVAL_SETTLE_MS && !stillnessAsked() &&
        document.visibilityState === 'visible';
      for (const row of candidates) {
        if (!row.isConnected || !list.contains(row)) continue;
        const name = nameOf(row);
        if (!name || shown.has(name)) continue;
        shown.add(name);
        if (shown.size > 400) shown.delete(shown.values().next().value);
        /* Remember hidden and opening messages too, so an acknowledgement or
           returning to the window cannot replay an already displayed message. */
        if (canPlay && landing.has(row)) pending.push({ row, at: now });
      }
      if (pending.length > 8) {
        if (sizes) for (const one of pending.slice(0, -8)) sizes.unobserve(one.row);
        pending = pending.slice(-8);
      }
      if (!pending.length) return;
      /*
       * Answered in the frame the row is first laid out, and not a frame later.
       *
       * The observer below hears of a message by the list changing size, and a
       * list that drops a row off the top as it takes one at the bottom can come
       * out the very height it went in: no callback, and the message waits for
       * the backstop's second frame -- after the first has been drawn with the
       * conversation already jumped. A ResizeObserver reports a newly observed
       * element in the first frame that lays it out, whatever else changed
       * size or did not, so each waiting row is observed and that report is
       * the answer.
       */
      if (sizes) for (const one of pending) sizes.observe(one.row);
      backstop();
    });

    /*
     * Where the conversation IS, answered in the frame it changes and never a
     * frame before or after, and kept from one reading to the next so the
     * difference is how far the messages travelled.
     *
     * How far they travelled, and NOT how much room the message took -- the
     * two are different numbers and the difference is the whole of the reply
     * case. Measured on a reply being sent: the row is 106px tall, because a
     * reply carries the quoted message inside it, and the conversation moved
     * 45. The rest went to the reply bar, which was dismissed by the same
     * keypress and handed its own 67px back at the same time. Gliding the room
     * rather than the movement parked the list 61px too low, and the message
     * the owner had just sent lurched DOWN the screen before coming back up.
     * Measured again on ordinary sends since: a 65px row, and 55px of travel,
     * every time.
     *
     * This is where all of it is decided, and it is called from a frame that
     * has already had its layout: a ResizeObserver runs after layout and before
     * paint, with the size the frame actually has, so the room the message took
     * is read rather than forced and the offset lands in the very frame the
     * room changes.
     */
    const answer = (lift, seen, scrolled, handed) => {
      const rows = pending;
      pending = [];
      if (sizes) for (const one of rows) sizes.unobserve(one.row);
      const now = performance.now();
      /* Rows the frame never came for: a spell with the window behind another
         one, where the mutations went on arriving and no frame was drawn. Their
         entrance is over -- it was over before anyone could have looked. */
      const landed = [];
      for (const one of rows) {
        if (one.row.isConnected && now - one.at <= ARRIVAL_PENDING_MS) landed.push(one);
      }
      /* A reply bar's room changing hands, and nothing landing with it: the
         bar's own business, told how far the messages went. */
      if (!landed.length) {
        if (handed) handed.then(seen === null ? null : seen);
        return;
      }

      /*
       * How far the conversation could honestly have moved on their account,
       * which is the room they took.
       *
       * `seen` is the difference between two readings, and the earlier one is
       * only refreshed when a frame comes -- so anything that moves the
       * conversation while nobody is being shown it settles into that baseline
       * and comes back out later as travel these messages never made. Two ways
       * in, and the second is the one that was reported:
       *
       *  - The owner scrolls away from the bottom and back between two frames.
       *    Their own scrolling is now in the reading.
       *  - The window is covered. MEASURED on this build: a window behind
       *    another is `visibilityState: "visible"` with `document.hidden`
       *    false, and gets NO frames at all -- a rig that logged one every
       *    frame logged nothing for as long as this window sat behind a
       *    terminal, while its MutationObservers went on firing throughout.
       *    So every message that lands while the window is away moves the
       *    conversation with nobody reading it, and the baseline falls a
       *    message further behind for each one. Come back, and the next message
       *    asks for the whole pile: two away messages made a 55px arrival glide
       *    165, and enough of them put it past the viewport test below, which is
       *    the "it stopped animating" that was seen.
       *
       * WhatsApp scrolls a conversation held at its bottom by exactly the room
       * the row took, and the wrappers it appends carry no margins, checked on
       * the live page: the row, its parent and its grandparent all answer the
       * same height. So this is the ceiling. Past it is a stale reading rather
       * than a message, and the truthful answer is the row -- which is why this
       * trims rather than gives up: the conversation really did move that far in
       * this frame, whatever the baseline believes about the ones before.
       *
       * The readings are free here. A ResizeObserver runs after layout, so
       * nothing is forced by asking. */
      let cost = 0;
      for (const one of landed) cost += Math.round(one.row.getBoundingClientRect().height);
      const roomBox = scroller.getBoundingClientRect();
      const bubbles = landed.map(one => one.row.querySelector('[data-testid="msg-container"]'))
        .filter(Boolean).map(bubble => ({ bubble, box: bubble.getBoundingClientRect() }));

      /* The rows the eye is on first, and the scroller's own scrolling only
         when there is no row left to ask. Both are the same travel by different
         roads; the second also moves for reasons the eye never sees, which is
         why it is the second. */
      let moved = seen === null ? scrolled : seen;
      if (!(moved > 0) && scrolled > 0) moved = scrolled;
      if (cost > 0 && moved > cost) moved = cost;

      /* Held at the bottom, or read from further up. WhatsApp scrolls the
         first and leaves the second alone -- measured: scrollTop 2576 -> 2631
         against a scrollHeight that grew by the same 55 -- so for the second
         nothing moved and there is nothing to smooth. The entrance below still
         plays: the message is on screen either way once it is scrolled to, and
         a pop is not a scroll. */
      const pinned = pinnedAt(scroller);
      landedAt.set(list, Date.now());

      /* Back where the eye last saw the conversation, then let go to where
         WhatsApp has already scrolled it. The lift is carried, so this composes
         with whatever is already moving the list -- the room a reply bar has
         just handed back, most often, since sending a reply dismisses the bar
         and lands the message in the same breath. A travel bigger than the
         viewport is a render rather than a message, and is left alone. */
      let parked = false;
      if (handed) {
        /* The room and a message in the same frame. The reading is the net of
           the two, and either way round -- a short message into a big room
           moves the conversation DOWN -- it is what the eye last saw, so it is
           answered once, here, whatever its sign. */
        if (seen !== null && seen && Math.abs(seen) < scroller.clientHeight) {
          park(list, lift + seen);
          parked = true;
        }
        handed.then(null);
      } else if (pinned && moved > 0 && moved < scroller.clientHeight) {
        park(list, lift + moved);
        parked = true;
      }
      /* And let go now, unless the list is waiting on a bar that is leaving --
         see the holds by the reply bar, which turn the message and the room
         the bar gives up into one glide by the net of the two. A message that
         lands while a reply is still being WRITTEN finds no hold, and goes at
         once like any other. */
      cameOn(list, 'message', parked ? ARRIVAL_GLIDE_MS : 0, ARRIVAL_EASE);

      /* Still waiting, the bar still stands over the message: its entrance is
         held at its first frame until the conversation moves to show it. */
      const waiting = holds.get(list);
      for (const { bubble, box } of bubbles) {
        const play = popTheBubble(bubble, box, roomBox, !!waiting);
        if (waiting && play) waiting.then.push(play);
      }
    };

    /* One reading of where everything is, taken at the point a frame has
       settled it, and handed on. It is in one place because two callers want
       exactly the same three numbers and the order they are taken in matters:
       the travel is measured against the last reading, and the last reading is
       replaced by this one. */
    const settled = () => {
      const lift = liftOf(list);
      let seen = travelled(lift);
      /* The scroller changed size: a reply bar's room changing hands, if one
         is waiting for it -- and the conversation it asked to be kept at its
         bottom is put back there before anything is read off it. A scroll
         down moves every message up by as much, so it is simply added in. */
      const handed = heightWas >= 0 && scroller.clientHeight !== heightWas ? roomTaken(list) : null;
      if (handed && handed.keep && !pinnedAt(scroller)) {
        const before = scroller.scrollTop;
        scroller.scrollTop = scroller.scrollHeight;
        if (seen !== null) seen += Math.round(scroller.scrollTop - before);
      }
      const scrolled = Math.round(scroller.scrollTop - scrolledFrom);
      marksOn(lift);
      answer(lift, seen, scrolled, handed);
    };

    /*
     * A frame of last resort, for the arrival nothing reports.
     *
     * The rows on their way in are observed themselves, so their first layout
     * is reported whatever the list does -- this is for a frame where even
     * that does not come: a row laid out at nought by nought, which an
     * observer does not report. Before the rows were observed it was the only
     * answer to a list that dropped one row off the top as it appended one at
     * the bottom and came out the same height it went in.
     *
     * Two frames, because the observer runs after this one in the frame's own
     * order -- rAF, then style, then layout, then resizes -- so a single frame
     * would be asking before the answer exists. And frames rather than a timer,
     * deliberately: a window nobody is looking at gets none, and an entrance
     * played to an empty room is not one.
     */
    let armed = false;
    const backstop = () => {
      if (armed) return;
      armed = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        armed = false;
        if (pending.length) settled();
      }));
    };

    /* The scroller is observed as well as the list, and that is not for
       tidiness: the reply bar opening changes the scroller's height and moves
       the conversation without changing the list's size at all, so a reading
       kept only on the list's own resizes would be stale by a bar-height
       exactly when a reply is about to be sent.

       And every row on its way in is observed for as long as it waits (see
       the mutation observer above), because a newly observed element is
       reported in the first frame that lays it out, whatever else did or did
       not change size. */
    let sizes = null;
    if (typeof ResizeObserver === 'function') {
      try {
        sizes = new ResizeObserver(settled);
        sizes.observe(list);
        sizes.observe(scroller);
      } catch (err) { sizes = null; }
    }
    /* The initial resize supplies the baseline after native layout. Adoption
       at chat commit never measures the newly mounted conversation early. */
    if (!sizes) { try { marksOn(0); } catch (err) { return; } }

    /* And taken again whenever the conversation comes to rest after a scroll
       with nothing on its way in: a scroll moves every message on screen and
       resizes nothing, so the observers above never hear of it.

       Nothing on its way in includes a resize the observer has not answered
       yet. `scrollend` is dispatched at the top of a frame, before the
       observers, and when the frame is the one a reply bar's room comes back
       in, a reading taken here sees the room already handed over -- and the
       observer, asked a moment later, finds nothing moved. Caught on a reply
       sent: the message parked, the room came back, and the conversation
       dropped 67px with the message held invisible behind it until the hold
       gave up 350ms later. */
    const rest = () => {
      if (pending.length || roomWatches.has(list)) return;
      try {
        if (scroller.clientHeight !== heightWas) return;
        marksOn(liftOf(list));
      } catch (err) { /* the next resize retakes it */ }
    };
    scroller.addEventListener('scrollend', rest, { passive: true });

    watch.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id'] });
    watched.push({ list: list, watch: watch, room: sizes, scroller: scroller, rest: rest });
  };

  const smoothTheArrivals = () => {
    /* A list WhatsApp has thrown away keeps its observer alive, and with it the
       whole detached conversation. They are dropped here rather than on any
       event, because the event that would say so is the one WhatsApp does not
       raise. */
    for (let i = watched.length - 1; i >= 0; i--) {
      if (watched[i].list.isConnected) continue;
      watched[i].watch.disconnect();
      if (watched[i].room) watched[i].room.disconnect();
      watched[i].scroller.removeEventListener('scrollend', watched[i].rest);
      watched.splice(i, 1);
    }
    for (const where of listsOnPage()) {
      if (where.list.__waArrivals) continue;
      where.list.__waArrivals = true;
      keyframesReady();
      adoptArrivals(where.scroller, where.list);
    }
  };

  /* A community thread draws its conversation, and its wallpaper, in a dialog
     outside #main; the same poll that adopts its messages finds its doodles. */
  setInterval(() => { smoothTheArrivals(); doodles.scan(); }, ARRIVAL_ADOPT_MS);
  adoptConversation = smoothTheArrivals;
  smoothTheArrivals();

  /* --------------------------------------------------- the jump to a message */

  /*
   * Clicking the pinned message at the top of a chat -- or a quoted reply, or a
   * search result -- lands on the message and then scrolls a screenful past it.
   *
   * WhatsApp announces the jump before it makes it, on its own command bus.
   * MEASURED on the live page 2026-09-05, the row sampled every frame:
   *
   *   +0ms    open_chat             { msgContext: { key, msg, highlightMsg } }
   *   +14ms   scroll_to_focused_msg { pos: 'top', scrollIfNeeded: true }
   *   +15ms   scroll_to_focused_msg { pos: 'center', animate: true,
   *                                   duration: 400,
   *                                   easing: [0.88, 0.64, 0.13, 0.99] }
   *
   * So the jump is two scrolls, and WhatsApp says which message they are for and
   * where it wants it to end up. The first is instant, it brings the message
   * onto the screen, and it is right: it framed the row 35px below the top of
   * the room. The second is a Velocity animation meant to settle the row in the
   * middle of the room, and it is the one that is wrong. Velocity works out
   * where it is going at the moment it is CALLED, from the row's box at that
   * instant -- and at that instant React is still mounting the rows above it, so
   * the list grows underneath the animation (3509 -> 6097, 21 rows -> 45, over
   * the 200ms that followed). It then scrolls faithfully to a measurement of a
   * conversation that no longer exists: the row went from 35px below the top of
   * the room to 1304px ABOVE it, and stayed there.
   *
   * Both scrolls are WhatsApp's own. This client writes scrollTop nowhere near
   * them, and turning its stylesheet off changes none of it.
   *
   * What is done about it: the settle is called off and run again here. The row
   * is measured LIVE every frame and written to where WhatsApp asked for it --
   * centred -- on the curve and over the duration WhatsApp asked for. A
   * destination recomputed every frame cannot go stale, so the list growing
   * underneath the animation stops mattering: rows mount, the row moves, and the
   * same frame takes the movement back out. Measured after: the row glides from
   * 35px below the top of the room to 196, which is (737 - 345) / 2, and stays
   * there -- and the second pinned message of the same chat, an 180px row, to
   * 278, which is (737 - 180) / 2.
   *
   * The first version of this held the row wherever the instant scroll had left
   * it, which is why it worked on a chat's first pinned message and on no other.
   * There is no "wherever it landed" for the second one: the banner cycles
   * through the chat's pins, the message for the next click is often on screen
   * already, WhatsApp's instant scroll then correctly does nothing -- and
   * holding the room where it stands is holding it exactly where the jump was
   * asked to move it away from. That version also had to guess the row, from
   * whatever Velocity had marked as animating, and what Velocity animates is a
   * WRAPPER of up to three rows: the guess took the first of them, so the two
   * pinned messages behind it were held by the wrong message's box. Reading the
   * target from WhatsApp instead of guessing it from the page is the whole of
   * this fix.
   */

  /* How long to keep asking for the command bus before giving up on it. The
     same wait the links above use, for the same reason: a client started by a
     link is running before the page's registry has been built. */
  const JUMP_WAIT_MS = 60000;
  const JUMP_POLL_MS = 400;

  /* How long a landing may take in all. WhatsApp's own settle is 400ms and rows
     above it kept arriving for 200ms after that here; the rest is for a
     conversation being filled in over a slow link. It ends the moment the room
     is still, so the whole window is only ever paid for by a jump that never
     finished. */
  const JUMP_HOLD_MS = 4000;

  /* Still: nothing left to put right and nothing new rendered, for this long. */
  const JUMP_QUIET_MS = 350;

  /* Past this many rooms away, a landing is not a glide. WhatsApp's own instant
     scroll is what covers distance, so what is left for the settle is a screen
     or two -- and three screens of conversation crossed in 400ms is a blur
     nobody reads. */
  const JUMP_FAR_ROOMS = 3;

  /* What the settle is, when WhatsApp does not say. */
  const JUMP_MS = 400;
  const JUMP_EASE = [0.88, 0.64, 0.13, 0.99];

  /* How long after a jump is announced its animated scroll still belongs to it.
     Measured at 15ms; a second is a wide margin around that, and a
     scroll_to_focused_msg outside it is somebody else's. */
  const JUMP_FRESH_MS = 1000;

  /* A cubic-bezier read at a point, the way CSS reads the four numbers WhatsApp
     hands over: x has to be solved for before y can be answered. Eight halvings
     put x inside a 256th of the curve -- a tenth of a frame of a 400ms one --
     and cost no derivative, which is what a Newton step would want and what
     this curve, whose control points cross over each other, is a poor candidate
     for. */
  const easedBy = (curve, u) => {
    if (!(u > 0)) return 0;
    if (u >= 1) return 1;
    const along = (a, b, t) => {
      const s = 1 - t;
      return 3 * s * s * t * a + 3 * s * t * t * b + t * t * t;
    };
    let low = 0;
    let high = 1;
    let t = u;
    for (let i = 0; i < 8; i++) {
      if (along(curve[0], curve[2], t) < u) low = t; else high = t;
      t = (low + high) / 2;
    }
    return along(curve[1], curve[3], t);
  };

  /* Where in the room WhatsApp wants the message, in pixels below its top. A
     message taller than the room cannot be centred in it and goes to the top,
     which is where the eye starts reading it. */
  const restingPlace = (pos, room, row) => {
    if (pos === 'center') return Math.max(0, Math.round((room - row) / 2));
    if (pos === 'bottom') return Math.max(0, Math.round(room - row));
    return 0;
  };

  /*
   * WhatsApp's own settle, called off.
   *
   * It has to be, rather than merely out-written. The paint belongs to whoever
   * wrote last in the frame, and Velocity's tick runs AFTER this one: measured
   * over a whole settle, every frame put the scroller back where the message
   * belongs -- 1612 -- and the next frame read 2027, 1933, 2122, further away
   * each time. Left running, the animation is what the eye sees for its whole
   * 400ms: the message flies off the top of the room and is put back only when
   * the animation ends. That is the "it scrolls somewhere and then jumps onto
   * the message" this is here to end.
   *
   * Nothing is lost by stopping it. The whole of what WhatsApp asked for is in
   * the options it passed -- `{ duration: 400, easing: generateBezier(0.88,
   * 0.64, 0.13, 0.99), container, offset: -278.5 }` on the jump measured here,
   * where 278.5 is (737 - 180) / 2 exactly: the room, less the row, halved.
   * There is NO complete and NO begin callback in it, so the animation answers
   * to nobody and its end is not a step in anything. The offset is the only
   * thing it knows that this does not, and it is recomputed here every frame
   * instead of once, which is the whole disagreement.
   *
   * `velocity-animate` is a private name like every other on this page, so the
   * whole of it is asked for inside a try and every part of its answer is
   * checked. A build that has taken it away leaves the settle running, and the
   * writes below still land the message -- just with the animation showing
   * underneath them until it ends.
   */
  const callOffTheSettle = scroller => {
    try {
      const V = grab('velocity-animate');
      if (typeof V !== 'function' || !V.State || !Array.isArray(V.State.calls)) return;
      for (const call of V.State.calls) {
        if (!call || !call[2] || call[2].container !== scroller) continue;
        for (const tween of call[0] || [])
          if (tween && tween.scroll && tween.element) V(tween.element, 'stop');
      }
    } catch (err) {
      /* WhatsApp's animation library, on WhatsApp's own terms. */
    }
  };

  /* The message, wherever its row is now.
   *
   * By id and never by element: the panel, the scroller and every row in it are
   * thrown away and built again -- twice -- during one jump, so an element kept
   * from the frame before is a detached one within 200ms. `data-id` is the bare
   * message id on the build measured here and has been the whole serialised key
   * on others, so both are answered. */
  const rowOfJump = id => {
    for (const where of listsOnPage())
      for (const row of where.scroller.querySelectorAll('[data-id]')) {
        const value = row.getAttribute('data-id');
        if (value === id || value.endsWith('_' + id))
          return { scroller: where.scroller, row: row };
      }
    return null;
  };

  let landing = null;

  const landTheJump = (id, pos, ms, curve) => {
    /* One at a time: the banner cycles through a chat's pinned messages, and a
       second click is a second jump that this one has no business finishing. */
    if (landing) landing();

    const began = performance.now();
    let start = null;              /* the distance the settle is animating away */
    let grown = -1;
    let stillFrom = 0;
    let done = false;

    /* A hand on the wheel ends it there and then. Holding a message against
       somebody scrolling away from it is the one way this could be worse than
       the scroll it exists to replace. */
    const letGo = () => {
      if (done) return;
      done = true;
      if (landing === letGo) landing = null;
      for (const name of ['wheel', 'pointerdown', 'keydown'])
        window.removeEventListener(name, letGo, true);
    };
    landing = letGo;
    for (const name of ['wheel', 'pointerdown', 'keydown'])
      window.addEventListener(name, letGo, true);

    const step = () => {
      const now = performance.now();
      if (done || now - began > JUMP_HOLD_MS) return letGo();
      requestAnimationFrame(step);

      const at = rowOfJump(id);
      if (!at) return;                    /* being rebuilt: ask again next frame */

      const room = at.scroller.clientHeight;
      const box = at.row.getBoundingClientRect();
      const rest = restingPlace(pos, room, box.height);

      /* How far the row still is from where it belongs. Positive is below it,
         and the room scrolls down by exactly that to take it away. */
      const need = Math.round(box.top - at.scroller.getBoundingClientRect().top - rest);

      /* What the settle has to animate, taken once, and WhatsApp's own settle
         called off in the same breath -- while the curve is running, because a
         second one can start behind the first when a conversation is still
         being filled in. A distance that is really a jump is not animated at
         all: the first frame writes the whole of it. */
      if (now - began <= ms) callOffTheSettle(at.scroller);
      if (start === null)
        start = Math.abs(need) > room * JUMP_FAR_ROOMS || stillnessAsked() ? 0 : need;

      /* The error this frame is entitled to keep, on WhatsApp's own curve; at
         the end of the duration it is nought and the row is exactly where the
         jump asked for it. Everything else in `need` -- a row mounting above,
         WhatsApp's own componentDidUpdate putting the scroll back, Velocity's
         tick writing a stale destination a moment ago -- is measured out and
         taken back out in the same frame. */
      const left = Math.round(start * (1 - easedBy(curve, (now - began) / ms)));
      const put = need - left;
      const was = at.scroller.scrollTop;
      if (put) at.scroller.scrollTop += put;

      /* Still: nothing left to put right, or nowhere left to put it -- a message
         at the end of a conversation cannot be lifted to the middle of the room,
         and asking for four seconds of it would be a poor answer to a scroller
         already against its stop. */
      if ((!put || at.scroller.scrollTop === was) && at.scroller.scrollHeight === grown) {
        if (!stillFrom) stillFrom = now;
        if (now - stillFrom > JUMP_QUIET_MS) letGo();
      } else {
        stillFrom = 0;
        grown = at.scroller.scrollHeight;
      }
    };
    requestAnimationFrame(step);
  };

  /* WhatsApp's own account of the jump, rather than a guess taken off the page.
     Private names, so each is asked for inside a try and its answer checked: a
     bus that never appears leaves the jump exactly as WhatsApp makes it, which
     is what this client did before this code existed. */
  const watchTheJumps = (waitedFor = 0) => {
    const module = grab('WAWebCmd');
    const Cmd = module && module.Cmd;
    if (!Cmd || typeof Cmd.on !== 'function') {
      if (waitedFor < JUMP_WAIT_MS)
        setTimeout(() => watchTheJumps(waitedFor + JUMP_POLL_MS), JUMP_POLL_MS);
      else
        log('WhatsApp never offered its command bus, so a jump to a message is left as it comes');
      return;
    }

    let wanted = null;
    let asked = 0;

    Cmd.on('open_chat', where => {
      const context = where && where.msgContext;
      const key = context && context.key;
      const id = key && key.id;
      if (typeof id !== 'string' || !id) return;    /* a chat opened at its bottom */
      wanted = id;
      asked = performance.now();
    });

    /* Two of these arrive per jump: the instant one that brings the message onto
       the screen, which is right and is left alone, and the animated settle,
       which is the one taken over. */
    Cmd.on('scroll_to_focused_msg', (where, how) => {
      if (!wanted || !how || !how.animate) return;
      if (performance.now() - asked > JUMP_FRESH_MS) return;
      const id = wanted;
      wanted = null;
      landTheJump(id,
                  how.pos || 'center',
                  how.duration > 0 ? how.duration : JUMP_MS,
                  Array.isArray(how.easing) && how.easing.length === 4 ? how.easing : JUMP_EASE);
    });

    log('a jump to a message lands where WhatsApp asks for it');
  };

  watchTheJumps();

  /* ------------------------------------------- the caret after a message goes */

  /*
   * The caret falls out of the composer and the owner is left clicking the box
   * again before every second message.
   *
   * MEASURED on the live page, focus events stamped:
   *
   *   focusout  composer      -> BUTTON{Send}     the click
   *   focusin   BUTTON{Send}
   *   focusout  BUTTON{Send}  -> null             76ms later: the composer is
   *                                               empty, so the button is gone
   *   ... 1.6 seconds with nothing focused at all ...
   *
   * The button takes the focus, the button is then taken off the moment the
   * composer empties, and focus falls to <body>, which cannot be typed into.
   * WhatsApp puts it back sometimes and not others -- both were sampled inside
   * ten seconds of each other -- so this makes it always.
   *
   * Sending is not the only way in, which is what the first go at this missed:
   * it listened for the focus leaving the FOOTER, and the loudest case the
   * owner reported starts nowhere near it. Replying to a message is a click on
   * an item in the message's own menu; the menu closes, the item goes with it,
   * and the caret lands on <body> with a reply bar standing open over a
   * composer that cannot be typed into. So the trigger is any focus that falls
   * to nothing, wherever it fell from.
   *
   * Only the fall to NOTHING is answered, and that is the whole of the care
   * needed here. A caret that has gone somewhere is where it was asked to be:
   * the search box, a menu, another window. `document.activeElement` is the
   * body exactly when there is nowhere for a keystroke to land, which is the
   * one state worth mending.
   */
  const COMPOSER = 'footer [contenteditable="true"]';

  /* What is on top of the conversation, if anything. A dialog owns the keyboard
     while it is up -- the media viewer, a forward picker, the poll editor --
     and a composer behind one is not where the next keystroke belongs. */
  const OVER_ALL = '[role="dialog"], [role="alertdialog"]';

  /* A pointer that is still down is in the middle of something, and the thing
     it is most often in the middle of is a phrase being dragged over inside a
     message. Focus moves to <body> on the mousedown that starts that drag --
     so a caret put back there and then would collapse the selection as it was
     being made, and the owner would be left unable to copy a line out of a
     chat. It waits for the button to come up, and then only if the drag turned
     out to have selected nothing. */
  let pointerIsDown = false;

  const caretBack = () => {
    if (!document.hasFocus()) return;
    if (pointerIsDown) return;
    const where = document.activeElement;
    if (where && where !== document.body && where !== document.documentElement) return;
    if (document.querySelector(OVER_ALL)) return;
    /* Something is selected: that is where the owner's attention is, and
       focusing anything would throw it away. */
    const picked = document.getSelection();
    if (picked && !picked.isCollapsed) return;
    const box = document.querySelector(COMPOSER);
    if (!box || box.isContentEditable !== true) return;
    /* On screen, and not a composer belonging to something that is closing. */
    const rect = box.getBoundingClientRect();
    if (!(rect.height > 0 && rect.width > 0)) return;
    try { box.focus({ preventScroll: true }); } catch (err) { /* older engine */ }
  };

  /* Three times over the third of a second these things take, and deliberately:
     what takes the focus away is usually removed a frame or two after it loses
     it -- the send button once the composer empties, a menu item once its menu
     closes -- and a check that ran only on the first would find the thing still
     there and still focused. Every one of them is a no-op unless the caret is
     nowhere. */
  const caretSoon = () => {
    setTimeout(caretBack, 0);
    setTimeout(caretBack, 120);
    setTimeout(caretBack, 320);
  };

  addEventListener('focusout', event => {
    if (event.relatedTarget) return;          /* it went somewhere; leave it */
    caretSoon();
  }, true);

  addEventListener('pointerdown', () => { pointerIsDown = true; }, true);
  addEventListener('pointerup', () => { pointerIsDown = false; caretSoon(); }, true);
  addEventListener('pointercancel', () => { pointerIsDown = false; }, true);

  /* A reply bar going up, which is the case the owner asked for by name. The
     bar arrives from a menu that has just taken the focus away with it, and the
     composer under it is the only place a reply can be typed. */
  addEventListener('animationstart', event => {
    const panel = event.target;
    if (panel instanceof Element && panel.matches && panel.matches(PANEL)) caretSoon();
  }, true);

  /* And coming back to the window at all. A window blurred with the caret on
     nothing comes back with it still on nothing, and the first keystroke after
     an alt-tab is the one most likely to be a reply. */
  addEventListener('focus', caretSoon);

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
    /* A story first, because it is not in a conversation and the chat it
       nominally arrived in -- `status@broadcast` -- would open a screen with
       nothing on it. See openStory in store.js. */
    if (request && request.story && waStore) {
      const opened = waStore.openStory(request.msg);
      if (opened === 'story') { log('opened the story the mention was posted on'); return; }
      if (opened === 'list') {
        log('the story is no longer in the collection; opened the updates panel instead');
        return;
      }
      log('could not open the story; falling back to the chat it arrived in');
    }

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

    /* And the chat faces, which are nothing to do with notifications either.
       They are started from here for the same reason the two above are: this is
       the point at which the page is up and WhatsApp's own registry answers.
       Nothing about them is configurable -- a picture that will not load is not
       a preference -- so they take no setting, only the way in. See
       pictures.js. */
    if (!waPictures) {
      waPictures = pictures.start({
        log,
        grab: name => {
          try {
            return typeof window.require === 'function' ? window.require(name) : null;
          } catch (err) { return null; }
        },
      });
    }
    muteSendTone = !!(config && config.muteSendTone);
    mutePageTone = !!(config && config.mutePageTone);
    hideControlsWhenPaused = !(config && config.hideControlsWhenPaused === false);
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

module.exports = { start, fixVideo, SEP };
