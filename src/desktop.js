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

const gsettings = key => {
  try {
    return execFileSync('gsettings', ['get', SCHEMA, key], { encoding: 'utf8', timeout: 2000 })
      .trim().replace(/^'|'$/g, '');
  } catch (e) {
    return '';                                   // not GNOME, or gsettings is not installed
  }
};

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

module.exports = { interfaceFont, prefersDark, watch, familyOf };
