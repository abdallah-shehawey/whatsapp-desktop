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

class Banners {
  constructor({ seconds = 12, appIcon = null } = {}) {
    this.seconds = seconds;
    this.appIcon = appIcon;
    this.live = new Set();
  }

  get supported() { return Notification.isSupported(); }

  /*
   * title  the chat
   * body   "sender: message", or the message on its own in a direct chat
   * icon   base64 image bytes for the sender's picture, or nothing
   * onClick what to do when the user clicks the banner
   */
  show({ title, body, icon, onClick }) {
    if (!this.supported || !title) return null;

    const iconPath = avatarPath(icon) || this.appIcon || undefined;
    const open = () => { try { onClick && onClick(); } catch (e) {} };

    const banner = new Notification({
      title,
      body: body || '',
      icon: iconPath,
      urgency: 'normal',
      timeoutType: 'default',
    });

    let timer = null;
    let closedByUs = false;
    let settled = false;                 // clicked or dismissed: nothing to refile

    banner.on('click', () => {
      settled = true;
      clearTimeout(timer);
      this.live.delete(banner);
      open();
    });

    /* GNOME sends this when the user dismisses the banner or clears it out of
       the notification centre -- not when it merely leaves the screen. So a
       close we did not ask for means the user has dealt with the message. */
    banner.on('close', () => {
      this.live.delete(banner);
      if (closedByUs) return;
      settled = true;
      clearTimeout(timer);
    });

    banner.show();
    this.live.add(banner);

    /* Down after its seconds, and filed silently in its place so the message is
       still there to be found. The filed copy is never taken down again: an
       entry in the notification centre is not a banner and blocks nothing. */
    timer = setTimeout(() => {
      if (settled) return;
      closedByUs = true;
      banner.close();

      const filed = new Notification({
        title, body: body || '', icon: iconPath,
        urgency: 'low', silent: true, timeoutType: 'default',
      });
      filed.on('click', open);
      filed.show();
    }, Math.max(1, this.seconds) * 1000);

    return banner;
  }
}

module.exports = { Banners, sweepAvatars, avatarPath };
