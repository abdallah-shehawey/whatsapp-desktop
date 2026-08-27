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
 * One banner and everything that outlives it: the timer that takes it down, the
 * silent copy filed in its place, and the key -- the chat it belongs to -- that
 * lets it be withdrawn when that chat is read.
 */
class Entry {
  constructor(owner, { key, title, body, iconPath, onClick }) {
    this.owner = owner;
    this.key = key || title;
    this.title = title;
    this.body = body || '';
    this.iconPath = iconPath;
    this.onClick = onClick;
    this.raisedAt = Date.now();
    this.settled = false;
    this.closedByUs = false;
    this.timer = null;
    this.current = null;
  }

  _open() { try { this.onClick && this.onClick(); } catch (e) {} }

  _watch(notification) {
    this.current = notification;
    notification.on('click', () => {
      this.settled = true;
      this._open();
      this.dispose();
    });
    /* GNOME sends this when the user dismisses the banner or clears it out of
       the notification centre -- not when it merely leaves the screen. So a
       close we did not ask for means the user has dealt with the message. */
    notification.on('close', () => {
      if (this.closedByUs) return;
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
      this.closedByUs = true;
      try { banner.close(); } catch (e) {}
      this.closedByUs = false;

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
      this.closedByUs = true;
      try { this.current.close(); } catch (e) {}
      this.current = null;
    }
    this.owner._forget(this);
  }
}

class Banners {
  constructor({ seconds = 12, appIcon = null } = {}) {
    this.seconds = seconds;
    this.appIcon = appIcon;
    this.byKey = new Map();             // chat name -> Set of live entries
  }

  get supported() { return Notification.isSupported(); }

  /*
   * key     the chat, so the notification can be withdrawn when it is read
   * title   the chat
   * body    "sender: message", or the message on its own in a direct chat
   * icon    base64 image bytes for the sender's picture, or nothing
   * onClick what to do when the user clicks the banner
   */
  show({ key, title, body, icon, onClick }) {
    if (!this.supported || !title) return null;

    const entry = new Entry(this, {
      key, title, body,
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

  keys() { return [...this.byKey.keys()]; }
}

module.exports = { Banners, sweepAvatars, avatarPath };
