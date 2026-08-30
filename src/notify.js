/*
 * Banners.
 *
 * Two things here are not Electron's defaults, and both were learned the hard
 * way on GNOME with the GTK client.
 *
 * A banner is taken down on the client's clock. GNOME reads the expire_timeout
 * of a notification and throws it away: a banner leaves the screen when the user
 * has been active *and* the pointer is not resting on it. The shell shows one at
 * a time, queues three behind it and drops the rest -- so a single banner parked
 * under an idle mouse pointer silently swallows every message that follows.
 * Measured live: with one stuck, six notifications produced no banner and no
 * sound between them, including one sent at critical urgency, and the moment it
 * went away the next one rang. Each banner is closed after twelve seconds and
 * the message posted again at LOW urgency, which the shell files in the
 * notification centre without a banner and without a sound. Nothing is lost and
 * nothing blocks.
 *
 * And a picture is stored under a name taken from the picture itself. A
 * notification holds the PATH of its icon and the shell reads it lazily, so a
 * rotating name meant a later message could rewrite the file under a banner
 * still on screen and put one sender's face on another sender's message.
 */
'use strict';

const { Notification } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AVATAR_PREFIX = 'whatsapp-desktop-avatar-';
const runtimeDir = () => process.env.XDG_RUNTIME_DIR || os.tmpdir();

/* Writes the picture out and answers with its path, or null. Named from the
   bytes, so the same face is written once and never rewritten under a banner. */
const avatarPath = base64 => {
  if (!base64) return null;
  let bytes;
  try { bytes = Buffer.from(base64, 'base64'); } catch (e) { return null; }
  if (!bytes.length) return null;

  const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const file = path.join(runtimeDir(), AVATAR_PREFIX + digest);
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
    return file;
  } catch (e) {
    return null;
  }
};

/* The pictures of a whole session add up and nothing else ever deletes them: a
   notification may still be pointing at one, so they cannot be cleaned up while
   the client runs. Startup is the safe moment -- whatever is on screen then
   belongs to a client that is no longer running. */
const sweepAvatars = () => {
  let names = [];
  try { names = fs.readdirSync(runtimeDir()); } catch (e) { return; }
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith(AVATAR_PREFIX)) continue;
    try { fs.unlinkSync(path.join(runtimeDir(), name)); removed++; } catch (e) {}
  }
  if (removed) console.log('cleared %d notification picture(s) from the last session', removed);
};

/*
 * What has already been announced, and what the user has already dealt with.
 *
 * A notification is one message made visible, so the thing that identifies it is
 * the message -- the chat it landed in, who wrote it and what it said -- and not
 * the chat alone. Keyed on the chat, a second message from one person replaces
 * the first; keyed on the message, the two stack, which is what the phone does
 * and what the specification asks for.
 *
 * The identity is kept as a digest and never as the message. It has to survive a
 * restart -- a client that came back and re-announced everything still unread
 * would be a client nobody leaves running -- and a file of everybody's messages
 * sitting in the state directory is not a price worth paying for that. A digest
 * answers the only question asked of it ("has this one been said?") and answers
 * nothing else, so the file is a list of hashes, written with no permissions for
 * anyone but its owner.
 */
/* How long a row is worth keeping. What is actually asked of this list is a
   window of seconds (SAME_MESSAGE_MS below) -- the hour is simply how long a row
   is worth the bytes, so a client restarted twice in a minute does not re-raise
   what it raised just before it went down, and a client started tomorrow reads
   an empty file rather than yesterday's. */
const SEEN_TTL_MS = 60 * 60 * 1000;
const SEEN_MAX = 4096;

class Seen {
  constructor(file) {
    this.file = file;
    this.at = new Map();                  // digest -> when it was announced
    this.dirty = false;
    this.flushTimer = null;
    this.load();
  }

  static digest(identity) {
    return crypto.createHash('sha256').update(String(identity)).digest('hex').slice(0, 24);
  }

  load() {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return; }
    if (!raw || typeof raw !== 'object' || !raw.seen) return;
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of Object.entries(raw.seen))
      if (typeof at === 'number' && at > cutoff) this.at.set(key, at);
    console.log('carried %d announced message(s) over from the last session', this.at.size);
  }

  /* Written on a timer rather than per notification: a burst is a dozen messages
     in a few seconds and each one would otherwise be a synchronous write. */
  save() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.dirty) return;
      this.dirty = false;
      const cutoff = Date.now() - SEEN_TTL_MS;
      for (const [key, at] of this.at) if (at < cutoff) this.at.delete(key);
      while (this.at.size > SEEN_MAX) this.at.delete(this.at.keys().next().value);
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.file, JSON.stringify({ seen: Object.fromEntries(this.at) }),
                         { mode: 0o600 });
      } catch (e) {
        console.warn('could not remember which messages were announced: %s', e.message);
      }
    }, 5000);
    if (this.flushTimer.unref) this.flushTimer.unref();
  }

  /* Whether this exact message has been announced inside the window. Identity,
     not resemblance: two people saying the same thing are two messages, and one
     person saying it twice an hour apart is two as well. */
  has(identity, windowMs) {
    const at = this.at.get(Seen.digest(identity));
    return at !== undefined && Date.now() - at < windowMs;
  }

  add(identity) {
    this.at.set(Seen.digest(identity), Date.now());
    this.save();
  }
}

/*
 * One banner and everything that outlives it: the timer that takes it down, the
 * silent copy filed in its place, and the key -- the chat it belongs to -- that
 * lets it be withdrawn when that chat is read.
 */
class Entry {
  constructor(owner, { key, msgId, title, body, iconPath, onClick }) {
    this.owner = owner;
    this.key = key || title;
    /* The message this banner is, when there is one to name. A withdrawal used
       to be able to speak only in whole chats -- "everything for Mega" -- which
       is right for a chat that has been opened and wrong for every other case:
       a message deleted for everyone takes down one banner, and a chat read
       down to two remaining messages takes down all but two. */
    this.msgId = msgId || '';
    this.title = title;
    this.body = body || '';
    this.iconPath = iconPath;
    this.onClick = onClick;
    this.raisedAt = Date.now();
    this.settled = false;
    this.timer = null;
    this.current = null;
  }

  _open() { try { this.onClick && this.onClick(); } catch (e) {} }

  /* Watching one notification, and the way to take that one down again.
   *
   * "Did we close this, or did the user?" is the whole question, and it used to
   * be answered by a field on the entry set immediately before close() and
   * cleared immediately after. That answer is a race and it is wrong on the
   * losing side: close() returns as soon as the D-Bus call is away, the server's
   * NotificationClosed comes back on a later turn, and by then the field says
   * "the user did it". The banner filed in its place is then disposed of at
   * once, which is a message swept out of the notification centre twelve seconds
   * after it arrived and no way to know it had been.
   *
   * So the flag belongs to the notification rather than to the entry, and it is
   * set for good rather than cleared. Whoever wants this one gone calls the
   * retire function that comes with it. */
  _watch(notification) {
    this.current = notification;
    let ours = false;
    notification.__retire = () => {
      ours = true;
      try { notification.close(); } catch (e) {}
    };
    notification.on('click', () => {
      this.settled = true;
      this._open();
      this.dispose();
    });
    /* GNOME sends this when the user dismisses the banner or clears it out of
       the notification centre -- not when it merely leaves the screen. So a
       close we did not ask for means the user has dealt with the message. */
    notification.on('close', () => {
      if (ours) return;
      this.settled = true;
      this.dispose();
    });
  }

  show(seconds) {
    const banner = new Notification({
      title: this.title,
      body: this.body,
      icon: this.iconPath,
      urgency: 'normal',
      timeoutType: 'default',
    });
    this._watch(banner);
    banner.show();

    /* Down after its seconds, and filed silently in its place so the message is
       still there to be found. The filed copy is not taken down again on a
       timer: an entry in the notification centre is not a banner and blocks
       nothing. It is still withdrawn when the chat is read. */
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.settled) return;
      banner.__retire();

      const filed = new Notification({
        title: this.title, body: this.body, icon: this.iconPath,
        urgency: 'low', silent: true, timeoutType: 'default',
      });
      this._watch(filed);
      filed.show();
    }, Math.max(1, seconds) * 1000);

    return this;
  }

  /* Take whatever is on screen down and forget the entry. Used both when the
     user deals with the notification and when the message it announced has been
     read somewhere else. */
  dispose() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.current) {
      this.current.__retire();
      this.current = null;
    }
    this.owner._forget(this);
  }
}

/* How long one message stays recognisable as itself.
 *
 * Two internal watchers can report one arrival -- the chat-list watcher and the
 * shim over the notifications WhatsApp Web raises -- and the specification
 * allows exactly one kind of deduplication: the same message arriving twice.
 * Not "a banner that looks like the last one", which would swallow the second
 * "tamam" of a pair, but this message, in this chat, from this person. The
 * window is short because that is the only case it is for: the two watchers
 * report within a second of each other or not at all. */
const SAME_MESSAGE_MS = 15000;

/* And how long one MESSAGE ID stays itself, which is a different question with a
   different answer: for ever, or as near to it as the file goes. The window
   above is short because it is guarding against two watchers describing one
   arrival, and two descriptions that are going to differ will differ inside a
   second. A message id needs no such window -- it is not a description, it is
   the thing -- and the case it guards is the client restarting: WhatsApp puts
   the recent history back into its collection on every page load, `add` fires
   for all of it, and a message announced four minutes before a restart is
   inside the freshness window on the other side of it. The startup grace
   catches most of that and this catches the rest. */
const SAME_ID_MS = SEEN_TTL_MS;

class Banners {
  constructor({ seconds = 12, appIcon = null, stateFile = null, hidePreview = false } = {}) {
    this.seconds = seconds;
    this.appIcon = appIcon;
    this.hidePreview = hidePreview;
    this.byKey = new Map();             // chat name -> Set of live entries
    this.seen = stateFile ? new Seen(stateFile) : null;
  }

  get supported() { return Notification.isSupported(); }

  /*
   * identity  what makes this message this message -- chat, sender and text --
   *           so a second message from one person stacks instead of replacing
   *           the first, and the same one reported twice is raised once
   * key       the chat, so the notification can be withdrawn when it is read
   * title     the chat
   * body      "sender: message", or the message on its own in a direct chat
   * icon      base64 image bytes for the sender's picture, or nothing
   * onClick   what to do when the user clicks the banner
   */
  show({ identity, msgId, key, title, body, icon, onClick, redacted }) {
    if (!this.supported || !title) return null;

    if (identity && this.seen) {
      if (this.seen.has(identity, msgId ? SAME_ID_MS : SAME_MESSAGE_MS)) {
        console.log('already announced: the same message reported twice');
        return null;
      }
      this.seen.add(identity);
    }

    const entry = new Entry(this, {
      key, msgId, title,
      /* With previews hidden the banner says which chat and what kind of thing
         arrived, and never a word of it. */
      body: this.hidePreview ? (redacted || 'New message') : body,
      iconPath: avatarPath(icon) || this.appIcon || undefined,
      onClick,
    });

    let set = this.byKey.get(entry.key);
    if (!set) this.byKey.set(entry.key, set = new Set());
    set.add(entry);

    return entry.show(this.seconds);
  }

  _forget(entry) {
    const set = this.byKey.get(entry.key);
    if (!set) return;
    set.delete(entry);
    if (!set.size) this.byKey.delete(entry.key);
  }

  /* Everything still on screen for this chat, taken down. `minimumAge` keeps a
     banner raised a moment ago from being withdrawn by the very first report
     that follows it -- WhatsApp draws the unread pill a beat after it moves the
     row, so a fresh arrival can briefly look like a chat with nothing unread. */
  closeKey(key, minimumAge = 0) {
    const set = this.byKey.get(key);
    if (!set) return 0;
    let closed = 0;
    for (const entry of [...set]) {
      if (Date.now() - entry.raisedAt < minimumAge) continue;
      entry.dispose();
      closed++;
    }
    return closed;
  }

  /* How long until the youngest banner still up for this chat is old enough for
     that guard, or 0 when nothing is waiting on it. A caller that was refused
     needs this: the reason it was refused expires, and nothing else will tell
     it when. */
  guardRemaining(key, minimumAge) {
    const set = this.byKey.get(key);
    if (!set) return 0;
    let longest = 0;
    for (const entry of set) {
      const left = minimumAge - (Date.now() - entry.raisedAt);
      if (left > longest) longest = left;
    }
    return longest;
  }

  /* One message, taken back. A message deleted for everyone is the case this
     exists for: the phone withdraws the notification for it and does not raise
     a second one saying it was deleted, and neither does this. */
  closeMessage(msgId) {
    if (!msgId) return 0;
    let closed = 0;
    for (const set of [...this.byKey.values()])
      for (const entry of [...set])
        if (entry.msgId === msgId) { entry.dispose(); closed++; }
    return closed;
  }

  /* All but the newest `keep` for this chat.
   *
   * WhatsApp counts what is unread in a conversation, and the messages it is
   * counting are the last ones in it -- so a chat that has gone from five unread
   * to two has had the oldest three read, whoever read them and wherever. That
   * is the whole of partial-read handling, and it needs no message id from the
   * read side at all: the banners are held in the order they were raised, and
   * everything before the last `keep` of them comes down.
   *
   * `keep` of zero is a chat that has been read to the end and takes all of them
   * with it. No age guard: this is an answer WhatsApp gave, not something
   * inferred from a redrawn list, and the guard that used to sit here is what
   * left a message read on the phone sitting in the notification centre. */
  trim(key, keep) {
    const set = this.byKey.get(key);
    if (!set) return 0;
    const live = [...set];
    const going = keep > 0 ? live.slice(0, Math.max(0, live.length - keep)) : live;
    for (const entry of going) entry.dispose();
    return going.length;
  }

  /* How many are still up for this chat, which is what decides whether a report
     is worth logging. */
  countFor(key) {
    const set = this.byKey.get(key);
    return set ? set.size : 0;
  }

  keys() { return [...this.byKey.keys()]; }
}

module.exports = { Banners, sweepAvatars, avatarPath };
