/*
 * Forcing the desktop font, without paying for it on every scroll -- and, when
 * the owner asks for it, a different font for Latin and for Arabic.
 *
 * The obvious way is a user stylesheet: `* { font-family: X !important }` at
 * user origin, which is the one level that beats the page's own !important.
 * It works, and it is expensive -- every element in every row WhatsApp recycles
 * down a scrolling conversation has to have its font resolved against a rule
 * that matches everything. Measured on a live chat, the same 2100px of
 * scrolling blocked the main thread for 212ms with that sheet and 82ms without,
 * with the worst single stall going from 82ms to 139ms. That is the difference
 * between a scroll that glides and one that catches.
 *
 * So the substitution is moved to where a browser does it: fontconfig, at font
 * lookup, once per family rather than once per element. A private config is
 * written that includes the system one and then renames the families WhatsApp
 * asks for to the family the desktop is set to. Chromium reads it because
 * FONTCONFIG_FILE points at it, and nothing in the page has to change.
 *
 * This file also answers two questions the settings window asks: what is
 * installed on this machine, and which of a family's faces exist. Both come
 * from fontconfig itself -- `fc-list` is on every distribution that can draw
 * text at all, and it is the same catalogue Chromium is looking at.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/* What WhatsApp Web's own stack names, plus the two generic faces fontconfig
   would otherwise answer with on a Linux desktop. Emoji families are absent on
   purpose: they are what the desktop font falls through to for the glyphs it
   does not have, and rebinding them would draw every emoji as a blank box. */
const REPLACED = [
  'Roboto Variable', 'Roboto', 'Roboto Flex',
  'Segoe UI', 'Segoe UI Variable', 'system-ui', '-apple-system',
  'BlinkMacSystemFont', 'Helvetica', 'Helvetica Neue', 'Arial',
  'Liberation Sans', 'DejaVu Sans', 'Cantarell', 'Adwaita Sans', 'Inter',
];

/* Emoji, and the faces a script the desktop font does not cover falls through
   to. Rebinding any of these would draw every emoji as a blank box and every
   Arabic word in the wrong script's glyphs. */
const NEVER = new Set([
  'noto color emoji', 'apple color emoji', 'segoe ui emoji', 'segoe ui symbol',
  'noto sans arabic', 'noto naskh arabic', 'emoji', 'monospace', 'serif',
  'cursive', 'fantasy', 'ui-monospace', 'ui-serif',
  /* Generics, which the <alias> at the bottom of the config already handles.
     Rewriting one as if it were a family name is how a config ends up telling
     fontconfig that sans-serif is literally called "sans-serif". */
  'sans-serif', 'inherit', 'initial', 'unset', 'revert',
]);

/* Families the page turned out to ask for that the list above does not cover.
   WhatsApp changes its font stack from time to time -- it currently leads with
   "Roboto Variable", which was not in any list written before it appeared -- so
   the page reports what it actually asks for and it is added here. fontconfig
   is read once per process, so a family learned now takes effect on the next
   start; there is no way to make that live, and it costs one launch. */
const learn = (dir, families) => {
  const file = path.join(dir, 'learned-fonts.json');
  let known = [];
  try { known = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }

  const wanted = families
    .map(name => name.trim().replace(/^["']|["']$/g, ''))
    .filter(name => name && !NEVER.has(name.toLowerCase()))
    .filter(name => !REPLACED.some(k => k.toLowerCase() === name.toLowerCase()))
    .filter(name => !known.some(k => k.toLowerCase() === name.toLowerCase()));

  if (!wanted.length) return [];
  known = [...known, ...wanted].slice(-32);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(known, null, 2));
  } catch (e) { /* the next start will learn it again */ }
  return wanted;
};

const learned = dir => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'learned-fonts.json'), 'utf8')); }
  catch (e) { return []; }
};

/* ------------------------------------------------------------- what is here */

/*
 * The catalogue, asked of fontconfig once per process.
 *
 * It has to be asked with FONTCONFIG_FILE taken back OUT of the environment.
 * By the time anything here runs, that variable points at this client's own
 * config -- the one whose whole purpose is to rename Roboto to something else
 * and to answer every generic with one family. A catalogue read through it
 * would be a list of the client's own opinions rather than of what is
 * installed, and `fc-match :lang=ar` through it would answer with whatever the
 * config had already chosen. So every fc-* call below is made against the
 * system configuration, which is what the settings window is really asking
 * about.
 *
 * A missing fc-list is not an error worth stopping for: the lists come back
 * empty, the settings window shows the family the client is already using and
 * nothing else, and every other mechanism here carries on. That is the
 * difference between a font picker that is unavailable and a client that does
 * not start.
 */
const fc = (tool, args) => {
  const env = { ...process.env };
  delete env.FONTCONFIG_FILE;
  try {
    return execFileSync(tool, args, {
      encoding: 'utf8',
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    return '';
  }
};

/* fontconfig's own numbers: FC_WEIGHT_REGULAR is 80 and FC_WEIGHT_BOLD is 200,
   FC_SLANT_ROMAN is 0 and italic and oblique are 100 and 110, and a width of
   100 is the normal one. They are not CSS numbers and there is no point
   pretending they are -- everything below compares them as fontconfig means
   them and only the answers come out in CSS. */
const REGULAR = 80;
const BOLD = 200;
const ROMAN = 0;
const ITALIC = 100;
const NORMAL_WIDTH = 100;

/* Enough of a face to choose between faces and to name one in `local()`. A
   variable font lists its weight as a range -- "[80 200]" -- with no full name
   at all, and there is no way to ask `local()` for one instance of it, so those
   rows are counted for the family's existence and skipped for everything else. */
const FIELDS = '%{family[0]}\\t%{weight}\\t%{slant}\\t%{width}\\t%{fullname[0]}\\t%{postscriptname}\\n';

const number = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

let catalogue = null;

const scan = () => {
  if (catalogue) return catalogue;

  const faces = new Map();
  for (const line of fc('fc-list', ['-f', FIELDS]).split('\n')) {
    if (!line) continue;
    const [family, weight, slant, width, full, ps] = line.split('\t');
    if (!family) continue;
    if (!faces.has(family)) faces.set(family, []);
    const w = number(weight);
    if (w === null || !(full || ps)) continue;   /* a variable font's own row */
    faces.get(family).push({
      weight: w,
      slant: number(slant) === null ? ROMAN : number(slant),
      width: number(width) === null ? NORMAL_WIDTH : number(width),
      names: [full, ps].filter(Boolean),
    });
  }

  const speaking = lang => new Set(
    fc('fc-list', ['-f', '%{family[0]}\\n', `:lang=${lang}`])
      .split('\n').map(name => name.trim()).filter(Boolean));

  catalogue = { faces, latin: speaking('en'), arabic: speaking('ar') };
  return catalogue;
};

/*
 * Which face of a family to name, for a given weight and slant.
 *
 * There is no CSS that makes a script bold on its own -- `font-weight` is a
 * property and properties cannot be scoped to a writing system -- so "bold
 * Arabic" is not a declaration, it is a different FILE: the family's own bold
 * face, named in `local()` on the @font-face that covers the Arabic range. A
 * family that ships no bold face therefore cannot be made bold at all, and the
 * settings window is told so rather than offering a switch that does nothing.
 * Chromium will not synthesise it either: it fakes bold when the page asks for
 * a weight the family has no face for, and the page here is asking for 400.
 *
 * The width test is what keeps "DejaVu Sans Bold" from coming out as "DejaVu
 * Sans Condensed Bold" -- fontconfig files both under the family name "DejaVu
 * Sans", and the condensed one is a different width of it.
 */
const pick = (family, { bold, italic }) => {
  const faces = scan().faces.get(family) || [];
  if (!faces.length) return { names: [], bold: false, italic: false };

  const wantWeight = bold ? BOLD : REGULAR;
  const wantSlant = italic ? ITALIC : ROMAN;
  const cost = face => Math.abs(face.weight - wantWeight) +
                       Math.abs(face.slant - wantSlant) * 2 +
                       (face.width === NORMAL_WIDTH ? 0 : 40) +
                       (face.names[0] || '').length / 1000;

  const best = faces.slice().sort((a, b) => cost(a) - cost(b))[0];
  return {
    names: best.names,
    /* Whether the face found is the face asked for, which is not the same
       question as whether one was found: the fallback is the regular. */
    bold: best.weight >= (REGULAR + BOLD) / 2,
    italic: best.slant >= ITALIC,
  };
};

/* What the settings window draws its two dropdowns from: the families that can
   draw each script, and whether each of them has a bold and an italic face to
   name. Sorted the way a list of names should be sorted, and deduplicated --
   fontconfig lists one row per face and a family has several. */
const installed = () => {
  const { faces, latin, arabic } = scan();
  const describe = names => [...names]
    .filter(name => faces.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map(name => ({
      name,
      bold: pick(name, { bold: true, italic: false }).bold,
      italic: pick(name, { bold: false, italic: true }).italic,
    }));
  return { latin: describe(latin), arabic: describe(arabic) };
};

/* The family the system itself would draw a script in, for the case where a
   size or a weight is asked for a script but no family is: without a family to
   name there is no @font-face to hang the size on, and the knob would silently
   do nothing. */
const defaultFor = lang => {
  const answer = fc('fc-match', ['-f', '%{family[0]}', `:lang=${lang}`]).trim();
  return answer || '';
};

/*
 * The whole font choice, resolved from what the config says into what the
 * stylesheet and the fontconfig document can be written from: a family per
 * script, the face to name for upright text, the face to name for italic text,
 * and a size for each.
 *
 * A script whose switch is still on arrives here as nothing at all -- `arabic`
 * null, `latin` carrying no more than the desktop's own family -- so a client
 * that has been asked for neither answers exactly what it answered before any
 * of this existed: one family, no size, no weight, no second script. `inherit`
 * says that both of them are in that state, which is the one thing the
 * stylesheet still wants to know as a whole: it is what keeps the rule for
 * unnamed text out of a sheet nobody asked for.
 */
const resolve = prefs => {
  const one = (want, fallbackFamily) => {
    const family = (want && want.family) || fallbackFamily || '';
    if (!family) return null;
    const wants = { bold: !!(want && want.bold), italic: !!(want && want.italic) };
    const size = Math.round(Number(want && want.size) || 100);
    /* The catalogue is only read when a particular FACE has been asked for.
       Naming the family is enough for everything else, and it is what this
       client named before any of this existed -- so a client running on the
       desktop font starts without a single fc-list behind it. Measured: the
       scan is 56ms, which is 56ms nobody who never opened the font settings
       should be paying at every launch. */
    const upright = wants.bold || wants.italic ? pick(family, wants) : null;
    const slanted = wants.bold || wants.italic
      ? pick(family, { bold: wants.bold, italic: true }) : null;
    return {
      family,
      /* Nothing at all at 100 per cent, so the sheet a client that was never
         asked for a size carries is the sheet it always carried. */
      size: size > 0 && size !== 100 ? size : 0,
      /* `local()` takes a full font name or a PostScript name, and which of
         the two a build resolves is not worth guessing at: both are named, in
         that order, and the first one the machine knows wins. */
      normal: upright && upright.names.length ? upright.names : [family],
      italic: slanted && slanted.names.length ? slanted.names : [family],
      /* What was asked for and could not be given, so a caller can say so. */
      wantedBold: wants.bold,
      wantedItalic: wants.italic,
      hasBold: !!(upright && upright.bold),
      hasItalic: !!(slanted && slanted.italic),
    };
  };

  return {
    inherit: !prefs || !!prefs.inherit,
    latin: one(prefs && prefs.latin, ''),
    /* No Arabic block at all until Arabic has been asked for. Its family may
       still be empty then -- a size on its own needs a face to sit on, and the
       system's own answer for Arabic is what it sits on. */
    arabic: prefs && prefs.arabic ? one(prefs.arabic, defaultFor('ar')) : null,
  };
};

/* ------------------------------------------------------- the fontconfig file */

const escapeXml = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/*
 * The document, and why the Arabic rule is at the bottom of it.
 *
 * fontconfig applies every match in the order it reads them, and `mode=assign`
 * replaces the FIRST family in the pattern while `mode=prepend` puts one in
 * front of it. So a rule that prepends the Arabic family and is then followed
 * by a rule that assigns the Latin one has been undone: the assignment lands on
 * the family the prepend just added. The renames come first and the language
 * rule comes last, and that order is the rule, not a matter of taste.
 *
 * The generic at the foot lists both families in turn. Chromium asks fontconfig
 * for sans-serif and takes what it is given, then looks down the sorted list
 * for a glyph the first family has not got -- which is exactly what an Arabic
 * word in a page that named nothing but sans-serif needs.
 */
const document_ = (resolved, extra = []) => {
  const latin = resolved && resolved.latin && resolved.latin.family;
  if (!latin) return '';
  const arabic = resolved.arabic && resolved.arabic.family &&
    resolved.arabic.family.toLowerCase() !== latin.toLowerCase()
    ? resolved.arabic.family : '';

  const target = escapeXml(latin);
  /* Never a family that was CHOSEN. Both of these lists are families the page
     might name, and one of them can perfectly well be the font the owner
     picked for the other script -- DejaVu Sans is on this machine's Arabic list
     and in REPLACED both. Renaming it would answer every request for the
     Arabic font with the Latin one, including the preview in the settings
     window that is meant to show what was picked. */
  const chosen = [latin, arabic].filter(Boolean).map(name => name.toLowerCase());
  const rules = [...REPLACED, ...extra]
    .filter(name => !chosen.includes(name.toLowerCase()))
    .map(name => `  <match target="pattern">
    <test name="family"><string>${escapeXml(name)}</string></test>
    <edit name="family" mode="assign" binding="strong"><string>${target}</string></edit>
  </match>`)
    .join('\n');

  const byLanguage = arabic ? `
  <!-- Arabic text asks for Arabic glyphs, and this is the only place the two
       scripts can be told apart before a family is chosen. Last, so that the
       renames above cannot assign over it. -->
  <match target="pattern">
    <test name="lang" compare="contains"><string>ar</string></test>
    <edit name="family" mode="prepend" binding="strong"><string>${escapeXml(arabic)}</string></edit>
  </match>
` : '';

  const preferred = [target, ...(arabic ? [escapeXml(arabic)] : [])]
    .map(name => `      <family>${name}</family>`).join('\n');

  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<!-- Generated by whatsapp-desktop. Do not edit: it is rewritten on every start
     from the fonts chosen in Settings, or from the desktop's own. -->
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>

${rules}
${byLanguage}
  <!-- and the generic the page falls through to when it names nothing else -->
  <alias binding="strong">
    <family>sans-serif</family>
    <prefer>
${preferred}
    </prefer>
  </alias>
</fontconfig>
`;
};

/*
 * Writes the config and answers with its path and whether it CHANGED -- which
 * is the whole of "does this need a restart". fontconfig is read once, early,
 * by every process that draws text, so a document that is different from the
 * one Chromium read at startup is a difference that only a restart can apply.
 * Everything else the font settings do is a stylesheet, and a stylesheet goes
 * into a page that is already open.
 *
 * `file` is null when it could not be written -- in which case the caller
 * simply does not set FONTCONFIG_FILE and the page is drawn in WhatsApp's own
 * fonts, which is a cosmetic loss and nothing worse.
 */
const configure = (resolved, dir) => {
  const wanted = document_(resolved, learned(dir));
  if (!wanted) return { file: null, changed: false };
  const file = path.join(dir, 'fonts.conf');
  try {
    fs.mkdirSync(dir, { recursive: true });
    /* Rewritten only when it changed: fontconfig caches per file, and touching
       it on every start would throw that cache away for nothing. */
    let current = '';
    try { current = fs.readFileSync(file, 'utf8'); } catch (e) { /* first run */ }
    if (current === wanted) return { file, changed: false };
    fs.writeFileSync(file, wanted);
    return { file, changed: true };
  } catch (e) {
    console.warn('could not write %s: %s', file, e.message);
    return { file: null, changed: false };
  }
};

module.exports = { configure, learn, resolve, installed, defaultFor, REPLACED };
