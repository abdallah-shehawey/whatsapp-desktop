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
  /* A font per script, and a switch per script to say whether the desktop's own
     is being followed. Two switches and not one, because the two questions are
     genuinely separate: an owner who wants a different Arabic face has no
     reason to have to pick a Latin one as well, and one who has picked a Latin
     one should not have to leave Arabic to it. While a script's switch is on,
     the four keys under it are ignored -- so a choice made once is still there
     to come back to, and there is nothing to type in again.

     Nothing here can invent a face a font does not ship: `bold` on a family
     with no bold face changes nothing, which is why the settings window offers
     that switch only where there is one. */
  'fonts.latin-inherit': true,
  'fonts.latin-family': '',        // empty: the desktop font, as before
  'fonts.latin-size': 100,         // per cent of the family's own size
  'fonts.latin-bold': false,
  'fonts.latin-italic': false,
  'fonts.arabic-inherit': true,
  'fonts.arabic-family': '',       // empty: whatever the system draws Arabic in
  'fonts.arabic-size': 100,
  'fonts.arabic-bold': false,
  'fonts.arabic-italic': false,
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
  /* Ask where every download goes, instead of dropping it in ~/Downloads and
     saying nothing. Turn it off to have files land there again. */
  'media.ask-where-to-save': true,
  /* Where the last one went, so the chooser opens on the folder it was pointed
     at last rather than at the same place every time. Written by the client;
     there is nothing to gain by editing it by hand. */
  'media.download-dir': '',
  /* Ask the desktop to open whatsapp: links with this client rather than in a
     browser tab -- what "Open app" on api.whatsapp.com hands over. Turn it off
     to leave the scheme with whatever already holds it; see src/links.js. */
  'links.claim-scheme': true,
  /* Ask GitHub once a day whether a newer version has been released, and put it
     on the tray's own menu item if one has. Nothing is downloaded and nothing is
     installed -- the package manager does that -- and nothing pops up. Turn it
     off and nothing asks by itself; About's own Check button still does. */
  'updates.check': true,
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
      '',
      '[fonts]',
      '# One switch per script. On: that script is drawn in the desktop font,',
      '# exactly as this client always drew it, and the keys under it are',
      "# ignored -- so a choice is still here to come back to. Off: it is drawn",
      '# in what was chosen for it. The two are separate on purpose: an Arabic',
      '# face of your own does not oblige you to pick a Latin one.',
      `latin-inherit = ${v['fonts.latin-inherit']}`,
      '# The family for Latin text. Empty follows the desktop font.',
      `latin-family = ${v['fonts.latin-family']}`,
      '# Its size, as a percentage of the size that family is drawn at.',
      `latin-size = ${Math.round(Number(v['fonts.latin-size']) || 100)}`,
      "# Draw Latin in the family's own bold or italic face. A family that ships",
      '# neither cannot be made to have one: nothing is synthesised here.',
      `latin-bold = ${v['fonts.latin-bold']}`,
      `latin-italic = ${v['fonts.latin-italic']}`,
      '# And the same for Arabic. Empty family: whatever the system already draws',
      '# Arabic in, which is what a size on its own needs to hang on.',
      `arabic-inherit = ${v['fonts.arabic-inherit']}`,
      `arabic-family = ${v['fonts.arabic-family']}`,
      `arabic-size = ${Math.round(Number(v['fonts.arabic-size']) || 100)}`,
      `arabic-bold = ${v['fonts.arabic-bold']}`,
      `arabic-italic = ${v['fonts.arabic-italic']}`,
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
      '# Every download asks where to put it. Off, and they land in ~/Downloads',
      '# the way a phone does it, with a number on the end of a name already taken.',
      `ask-where-to-save = ${v['media.ask-where-to-save']}`,
      '# The folder the last download was pointed at, so the chooser opens there.',
      `download-dir = ${v['media.download-dir'] || ''}`,
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
