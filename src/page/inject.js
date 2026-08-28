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

  on('focus', state => {
    state = !!state;
    if (state === focused) return;
    focused = state;
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
  const isOutgoing = el => iconNames(el).some(n => OUTGOING_ICON.test(n));

  /* WhatsApp leaves muted chats out of its own notifications, so this client
     does too. */
  const MUTED_LABEL = /muted|مكتوم|كتم/i;
  const isMuted = row => [...row.querySelectorAll('[aria-label]')]
      .some(e => MUTED_LABEL.test(e.getAttribute('aria-label') || ''));

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
  const ping = () => send('arrival', null);

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

  /* What is read off a row on every pass. Three things move when a message lands,
     and it takes all three to catch every one: the preview, because that is the
     message; the timestamp, because a second "tamam" under the first leaves the
     preview identical and that message went unannounced; and the unread count,
     because two identical messages inside the same minute move nothing else. */
  const readRow = row => {
    const titles = titlesIn(row);
    const name = (titles[0] && strip(titles[0].getAttribute('title'))) || nameOf(row);
    let preview = strip(titles[1] && titles[1].getAttribute('title'));

    if (!preview && row) {
      const icons = iconNames(row);
      if (icons.some(i => /sticker|ملصق/i.test(i))) preview = 'Sticker';
      else if (icons.some(i => /image|photo|camera|صورة/i.test(i))) preview = 'Photo';
      else if (icons.some(i => /audio|ptt|mic|headset|صوت|voice/i.test(i))) preview = 'Voice message';
      else if (icons.some(i => /video|فيديو/i.test(i))) preview = 'Video';
      else if (icons.some(i => /document|doc|مستند/i.test(i))) preview = 'Document';
      else if (icons.some(i => /gif/i.test(i))) preview = 'GIF';
      else {
        const text = row.innerText || '';
        if (/ملصق|sticker/i.test(text)) preview = 'Sticker';
        else if (/صورة|photo|image/i.test(text)) preview = 'Photo';
        else if (/رسالة صوتية|صوت|voice message/i.test(text)) preview = 'Voice message';
      }
    }

    return {
      name,
      preview: preview || '',
      badge:   unreadCount(row),
      when:    ((row.innerText || '').match(/\b\d{1,2}:\d{2}(?:\s*[AP]M)?\b/) || [''])[0],
    };
  };

  /* Who spoke, in a group row: the sender is its own element followed by a bare
     ":" element, and a one-to-one row has neither. Verified against live rows:
     groups yield "You", "+20 11 18856364", "@eng_mahmoudmajed", and direct chats
     correctly yield nothing. Reading the position of that ":" beats matching
     WhatsApp's class names, which are obfuscated and rotate every build. */
  const senderIn = row => {
    const lines = (row.innerText || '').split('\n').map(strip);
    const colon = lines.indexOf(':');
    return colon > 0 ? lines[colon - 1] : '';
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

  const scanList = () => {
    const pane = document.querySelector('#pane-side');
    if (!pane) return;

    for (const row of pane.querySelectorAll('[role="row"]')) {
      const now = readRow(row);
      if (!now.name) continue;

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
      if (!isArrival(before, now)) continue;
      if (isMuted(row)) continue;
      if (isOutgoing(row)) continue;

      /* Nothing is queued while the window is away: WhatsApp raises its own
         notification then, and the app dresses that one instead. A queue built up
         in the background used to be handed over the moment the window came back,
         and every message in it was announced a second time. */
      if (!focused) continue;

      /* Queued per message rather than per chat: the app asks once for each one,
         and collapsing them here is what swallowed the second and third message of
         a burst from the same person. */
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
  const knownUnread = new Map();
  const UNREAD_GRACE_MS = 2500;

  const reportUnread = pane => {
    const now = Date.now();
    const currentUnread = new Set();
    const renderedNames = new Set();

    for (const row of pane.querySelectorAll('[role="row"]')) {
      const name = nameOf(row);
      if (!name) continue;
      renderedNames.add(name);
      if (unreadCount(row) > 0) {
        currentUnread.add(name);
        knownUnread.set(name, now);
      }
    }

    if (!renderedNames.size && !pane.querySelector('[role="row"]')) return;

    const names = [];
    for (const [name, lastSeen] of knownUnread.entries()) {
      if (currentUnread.has(name)) {
        names.push(name);
      } else if (renderedNames.has(name)) {
        const open = openRow();
        const isOpenChat = open && nameOf(open) === name && focused;
        if (!isOpenChat && (now - lastSeen < UNREAD_GRACE_MS)) {
          names.push(name);
        } else {
          knownUnread.delete(name);
        }
      } else {
        if (now - lastSeen < 60000) names.push(name);
        else knownUnread.delete(name);
      }
    }

    const key = names.sort().join(SEP);
    if (key === lastUnread) return;
    lastUnread = key;
    send('unread-chats', names);
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
    const row = openRow();
    const name = row ? nameOf(row) : '';
    if (name === lastOpen) return;
    lastOpen = name;
    send('open-chat', name);
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
      if (preview && strip(titles[1] && titles[1].getAttribute('title')) !== preview) continue;
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

  const avatarOf = async row => {
    const img = row && row.querySelector('img[src^="http"], img[src^="blob:"]');
    if (!img || !img.src) return '';
    return withTimeout(fetchAvatar(img.src));
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
    return match ? avatarOf(match) : '';
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
  const pressRow = row => {
    const target = row.querySelector('span[title]') || row;
    const box = row.getBoundingClientRect();
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

  on('open-chat-request', name => {
    const row = rowFor(name);
    if (!row) { log('cannot open "' + name + '": no row for it in the rendered list'); return; }
    pressRow(row);
    /* Said as soon as the page has drawn it rather than waited for: which chat
       is on screen is what takes the banner down, and the observer that would
       report it on its own fires a beat later than the click does. */
    setTimeout(refreshOpen, 400);
  });

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
        if (isOpen(candidate, '') || isMuted(candidate) || isOutgoing(candidate)) continue;

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

    /* Said once, and the guess will not say it again. */
    rememberAnnounced({ name: state.name, preview: preview, when: state.when });
    if (preview !== state.preview) rememberAnnounced(state);

    /* Read off the row, unless the row has moved on and the message is the one that
       was queued -- then so is the sender, or a group message would go out with
       nobody's name on it. */
    const sender = moved ? (queued.sender || '') : senderIn(row);

    return [state.name, sender, preview, await avatarOf(row)].join(SEP);
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
        const row = rowFor(this.title);
        Promise.resolve()
          .then(() => {
            if (!this.icon) return avatarFor(this.title);
            rememberName(this.title);
            return withTimeout(fetchAvatar(this.icon));
          })
          .catch(() => '')
          .then(avatar => send('page-notification', {
            id: this.__id, title: this.title, body: this.body,
            chat: row ? nameOf(row) : '',
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

  on('config', config => {
    if (config && config.notifications) installNotificationShim();
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
