/*
 * The config file, kept in the same INI shape the GTK client used so the keys
 * are familiar and can be edited by hand. Everything in it is optional.
 *
 *   ~/.config/whatsapp-desktop/whatsapp-desktop.conf
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
                             'whatsapp-desktop');
const CONFIG_PATH = path.join(CONFIG_DIR, 'whatsapp-desktop.conf');

const DEFAULTS = {
  'view.theme': 'system',          // 'system' (follow desktop), 'dark', or 'light'
  'view.font': '',                 // empty: follow the desktop font
  'view.font-size': 16,            // WhatsApp sizes in rem, so this scales the client
  /* The size of the words in a conversation only, as a percentage of the size
     WhatsApp draws them at -- the knob the phone has under Chats. 100 changes
     nothing at all; the chat list and the headers never move with it. */
  'view.chat-font-size': 100,
  'view.zoom': 1.0,
  'view.force-font': true,         // draw the page in one family, like a browser told to ignore page fonts
  'view.arabic-fix': false,        // widen the clip Arabic descenders are cut against
  'window.width': 1200,
  'window.height': 800,
  'behaviour.close-to-tray': true,
  'behaviour.minimize-to-tray': false,
  'behaviour.spellcheck': true,
  'notifications.enabled': true,
  'notifications.sound': true,     // a tone for the banners this client raises itself
  'notifications.outgoing-sound': false,  // WhatsApp's own tone for a message you send
  'notifications.whatsapp-sound': false,  // let WhatsApp play its own tone for a message arriving
  'notifications.banner-seconds': 12,
  'notifications.hide-preview': false,    // the chat and the kind of message, never the words
  /* WhatsApp Web files a sticker under "photos" for auto-download purposes, so
     turning photos off takes the stickers with it and leaves nothing in their
     place -- not even a button to fetch one. The phone has no sticker switch at
     all and always fetches them. This does the same; turn it off to have
     WhatsApp's photo switch govern stickers again. */
  'media.download-stickers': true,
  /* Take the desktop's media card down when a voice note is paused, instead of
     leaving it there until the note has played out. */
  'media.hide-controls-when-paused': true,
};

/* A deliberately small INI reader: sections, key = value, # and ; comments.
   Nothing here is worth a dependency, and a parser that silently accepts a
   half-written file is what a hand-edited config needs. */
const parse = text => {
  const out = {};
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    out[(section ? section + '.' : '') + key] = value;
  }
  return out;
};

const coerce = (value, fallback) => {
  if (typeof fallback === 'boolean') return /^(1|true|yes|on)$/i.test(value);
  if (typeof fallback === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return value;
};

class Config {
  constructor() {
    this.values = { ...DEFAULTS };
    this.reload();
  }

  reload() {
    let text = '';
    try { text = fs.readFileSync(CONFIG_PATH, 'utf8'); } catch (e) { return; }
    const raw = parse(text);
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      if (raw[key] !== undefined) this.values[key] = coerce(raw[key], fallback);
    }
  }

  get(key) { return this.values[key]; }

  set(key, value) { this.values[key] = value; }

  /* Only what the client itself decides is written back -- the window size and
     the zoom level. A hand-written config keeps its comments and its layout,
     because the file is rewritten from the values it already held plus these. */
  save() {
    const v = this.values;
    const text = [
      '# whatsapp-desktop -- every key is optional; delete one to get the default back.',
      '',
      '[view]',
      '# Theme mode: system (follow desktop), dark, or light.',
      `theme = ${v['view.theme'] || 'system'}`,
      '# Family for everything the client draws. Empty follows the desktop font.',
      `font = ${v['view.font']}`,
      '# Root font size in pixels. WhatsApp sizes in rem, so this scales the client.',
      `font-size = ${v['view.font-size']}`,
      '# The words in a conversation, as a percentage of the size WhatsApp draws',
      '# them at -- messages and the box you type in, and nothing else. 100 leaves',
      '# the page exactly as WhatsApp drew it.',
      `chat-font-size = ${Math.round(Number(v['view.chat-font-size']) || 100)}`,
      `zoom = ${Number(v['view.zoom']).toFixed(2)}`,
      '# Draw the whole page in one family, the way a browser told to ignore page fonts does.',
      `force-font = ${v['view.force-font']}`,
      '# Give Arabic descenders room in the boxes WhatsApp clips them against.',
      '# Off by default: Chromium measures a line against every font in it, so',
      '# the clipping WebKit caused does not happen here.',
      `arabic-fix = ${v['view.arabic-fix']}`,
      '',
      '[window]',
      `width = ${Math.round(v['window.width'])}`,
      `height = ${Math.round(v['window.height'])}`,
      '',
      '[behaviour]',
      '# Closing the window leaves the client running in the tray.',
      `close-to-tray = ${v['behaviour.close-to-tray']}`,
      '# Minimising does the same. Off by default: minimise is not close.',
      `minimize-to-tray = ${v['behaviour.minimize-to-tray']}`,
      `spellcheck = ${v['behaviour.spellcheck']}`,
      '',
      '[notifications]',
      `enabled = ${v['notifications.enabled']}`,
      '# A tone for the banners this client raises itself. WhatsApp plays its own',
      '# for the ones it raises, and two sounds for one message is worse than none.',
      `sound = ${v['notifications.sound']}`,
      '# WhatsApp plays a tone of its own when a message of yours goes out. Off',
      '# here: the message is already on screen, with a tick under it, in the',
      '# window you are looking at.',
      `outgoing-sound = ${v['notifications.outgoing-sound']}`,
      '# WhatsApp also plays one for a message arriving while the window is away,',
      '# and that is the only moment it announces anything itself. Off here, so',
      '# that a message sounds the same whether the window is in front or in the',
      '# tray: the client plays the desktop tone for both. Turn it on to hear',
      "# WhatsApp's own tone instead -- and then the window in front stays silent,",
      '# because that is the half WhatsApp does not announce.',
      `whatsapp-sound = ${v['notifications.whatsapp-sound']}`,
      '# Seconds before a banner is taken down and filed silently. GNOME parks a',
      '# banner under an idle pointer for ever, and one parked banner swallows',
      '# every message behind it.',
      `banner-seconds = ${v['notifications.banner-seconds']}`,
      '# Keep the message itself off the screen: a banner then says which chat it',
      '# came from and what kind of thing arrived, and nothing of what was said.',
      `hide-preview = ${v['notifications.hide-preview']}`,
      '',
      '[media]',
      '# WhatsApp counts a sticker as a photo for auto-download, so turning photos',
      '# off leaves every sticker as a blank space with no way to fetch it. The',
      '# phone always fetches stickers; so does this, unless it is turned off here.',
      `download-stickers = ${v['media.download-stickers']}`,
      "# A voice note that is only paused leaves its card in the desktop's",
      '# notification centre until the note has played out -- Chromium keeps the',
      '# media session for a paused player, and the shell shows every session it',
      '# can see. On, the card goes down with the pause and comes back when the',
      '# note does. Turn it off to keep a paused note on the shell, where its',
      '# play button can start it again.',
      `hide-controls-when-paused = ${v['media.hide-controls-when-paused']}`,
      '',
    ].join('\n');

    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(CONFIG_PATH, text);
    } catch (e) {
      console.warn('could not write %s: %s', CONFIG_PATH, e.message);
    }
  }
}

module.exports = { Config, CONFIG_PATH, CONFIG_DIR };
