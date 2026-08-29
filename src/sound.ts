/*
 * The notification tone.
 *
 * GNOME plays a sound for a notification only when the notification asks for
 * one, through the `sound-name` or `sound-file` hint of the Notify call --
 * and Electron's Notification has no way to set a hint. Measured on the bus:
 * what goes out is sender-pid, desktop-entry, urgency and image-data, and
 * nothing else. So a banner this client raises is silent, and that is why
 * messages arriving while the window was in front made no sound while messages
 * arriving behind it did: those are WhatsApp Web's own notification and its own
 * <audio> element, which is not silent at all.
 *
 * The tone is therefore played by the client, and played through the page --
 * where it becomes part of the application's own audio stream, follows its
 * volume in the mixer, and needs no player binary to be installed. It is read
 * from the desktop's sound theme rather than shipped, so it is the sound the
 * rest of the desktop makes.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

/* The freedesktop sound naming spec calls it this; `message` is the fallback
   every theme has. */
const NAMES = ['message-new-instant', 'message'];
const PROFILES = ['stereo', ''];
const EXTENSIONS = { '.oga': 'audio/ogg', '.ogg': 'audio/ogg', '.wav': 'audio/wav' };

const themeName = () => {
  try {
    return execFileSync('gsettings', ['get', 'org.gnome.desktop.sound', 'theme-name'],
                        { encoding: 'utf8', timeout: 2000 }).trim().replace(/^'|'$/g, '') ||
           'freedesktop';
  } catch (e) {
    return 'freedesktop';
  }
};

const dataDirs = () => {
  const dirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const home = process.env.XDG_DATA_HOME ||
               path.join(process.env.HOME || '/root', '.local', 'share');
  return [home, ...dirs];
};

/* Themes inherit, and following that properly means parsing index.theme; the
   fallback is named in the spec and every theme has it, so both are tried and
   the first hit wins. */
const find = () => {
  const themes = [...new Set([themeName(), 'freedesktop'])];
  for (const dir of dataDirs()) {
    for (const theme of themes) {
      for (const profile of PROFILES) {
        for (const name of NAMES) {
          for (const [ext, mime] of Object.entries(EXTENSIONS)) {
            const file = path.join(dir, 'sounds', theme, profile, name + ext);
            if (fs.existsSync(file)) return { file, mime };
          }
        }
      }
    }
  }
  return null;
};

let cached: { data: string; mime: string; file: string; } | null | undefined;

/* Read once and kept: it is a few kilobytes, and re-reading it in front of every
   banner would put a disk seek where a sound should be. */
const tone = () => {
  if (cached !== undefined) return cached;
  cached = null;

  const hit = find();
  if (!hit) {
    console.warn('no notification sound found in the desktop sound theme');
    return cached;
  }

  try {
    const bytes = fs.readFileSync(hit.file);
    if (bytes.length && bytes.length < 2 * 1024 * 1024)
      cached = { data: bytes.toString('base64'), mime: hit.mime, file: hit.file };
  } catch (e) {
    if (e instanceof Error) console.warn('could not read %s: %s', hit.file, e.message);
  }
  return cached;
};

export { tone };
