/*
 * What the desktop says the client should look like: the interface font and the
 * dark/light preference, read from GNOME and watched for changes.
 *
 * Chromium knows neither. It picks its default families from fontconfig, which
 * answers with the system default rather than with the font the user chose for
 * their desktop -- so the choice has to be read from GSettings and handed to
 * Chromium, which is the whole of what "inherit the laptop's font" needs.
 */
'use strict';

const { execFile, execFileSync } = require('child_process');

const SCHEMA = 'org.gnome.desktop.interface';

/* Style words Pango may put between the family and the size in a font
   description. They are not part of the family name and Chromium wants the
   family alone: "Cantarell Bold 11" is the Cantarell family. */
const PANGO_STYLES = new Set([
  'thin', 'ultra-light', 'extralight', 'extra-light', 'light', 'semi-light', 'demi-light',
  'book', 'regular', 'normal', 'roman', 'medium', 'semi-bold', 'demibold', 'demi-bold',
  'semibold', 'bold', 'ultra-bold', 'extrabold', 'extra-bold', 'heavy', 'black',
  'italic', 'oblique', 'ultra-condensed', 'extra-condensed', 'condensed',
  'semi-condensed', 'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
]);

/* "PoetsenOne 10" -> "PoetsenOne"; "Noto Sans Bold Italic 11" -> "Noto Sans". */
const familyOf = spec => {
  const words = String(spec || '').replace(/^'|'$/g, '').trim().split(/\s+/);
  if (words.length && /^\d+(\.\d+)?$/.test(words[words.length - 1])) words.pop();
  while (words.length > 1 && PANGO_STYLES.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').trim();
};

const read = (schema, key) => {
  try {
    return execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 2000 })
      .trim().replace(/^'|'$/g, '');
  } catch (e) {
    return '';                                   // not GNOME, or gsettings is not installed
  }
};

const gsettings = key => read(SCHEMA, key);

/* Two settings that are asked in front of a notification rather than once at
   startup, and so are worth not spawning gsettings for every time. A quarter of
   a minute is short enough that turning do-not-disturb on takes effect while the
   user still remembers doing it, and long enough that a burst of ten messages
   costs one process rather than ten. */
const CACHE_MS = 15000;
const cached = new Map();

const setting = (schema, key, fallback) => {
  const id = schema + ' ' + key;
  const held = cached.get(id);
  if (held && Date.now() - held.at < CACHE_MS) return held.value;
  const answer = read(schema, key);
  const value = answer === '' ? fallback : answer !== 'false';
  cached.set(id, { value, at: Date.now() });
  return value;
};

/* Do not disturb. GNOME calls it show-banners, and turning it off is what the
   quick-settings toggle does. A desktop that will not say -- anything that is
   not GNOME -- is taken at its word rather than second-guessed: the client does
   not get to decide it knows better than a shell it cannot ask. */
const notificationsAllowed = () =>
  setting('org.gnome.desktop.notifications', 'show-banners', true);

/* And the desktop's own switch for alert sounds, which is the setting the tone
   this client plays would follow if the notification daemon were playing it. */
const eventSoundsEnabled = () =>
  setting('org.gnome.desktop.sound', 'event-sounds', true);

/* fontconfig's answer for the generic sans family, which is what Chromium would
   have used anyway. Only reached when there is no GSettings to ask. */
const fontconfigSans = () => {
  try {
    return execFileSync('fc-match', ['-f', '%{family[0]}', 'sans-serif'],
                        { encoding: 'utf8', timeout: 2000 }).trim();
  } catch (e) {
    return 'sans-serif';
  }
};

const interfaceFont = () => familyOf(gsettings('font-name')) || fontconfigSans();

const prefersDark = () => {
  const scheme = gsettings('color-scheme');
  /* Default to dark when the desktop will not say: WhatsApp Web's dark theme is
     what this client has always opened in, and only an explicit light
     preference opts out. */
  return scheme !== 'prefer-light';
};

/* `gsettings monitor` prints a line per change and costs one idle process, which
   is what following the desktop live is worth. It is a child of this process, so
   it goes away with it. */
const watch = (keys, onChange) => {
  let child;
  try {
    child = execFile('gsettings', ['monitor', SCHEMA]);
  } catch (e) {
    return () => {};
  }

  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const key = line.split(':')[0].trim();
      if (keys.includes(key)) onChange(key);
    }
  });
  child.on('error', () => {});

  return () => { try { child.kill(); } catch (e) {} };
};

module.exports = { interfaceFont, prefersDark, watch, familyOf,
                   notificationsAllowed, eventSoundsEnabled };
