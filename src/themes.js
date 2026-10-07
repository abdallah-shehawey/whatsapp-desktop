/*
 * Palettes, for a client that should not be the one bright thing on the screen.
 *
 * WhatsApp Web has two looks and neither of them is the desktop's. On a dark
 * setup that is not WhatsApp's dark -- an OLED panel, Nord, Catppuccin -- the
 * window sits there in its own colours, and the usual answer is a user
 * stylesheet somebody else wrote and nobody maintains.
 *
 * These are the same idea with the maintenance done once: a palette is eight
 * colours, and the sheet built from it writes WhatsApp's own custom properties
 * rather than restyling its elements. That is the whole reason this costs
 * nothing to leave on -- the rules name :root, #main, body and the startup logo,
 * with nothing evaluated per element on a scrolling list. (The privacy
 * sheet next door is the cautionary tale; see src/privacy.js.)
 *
 * `system`, `dark` and `light` are not palettes and never were: they are what
 * the window tells nativeTheme, and they leave the page to WhatsApp.
 *
 * pywal is the other half. A desktop themed from the wallpaper writes its
 * colours to ~/.cache/wal/colors.json, and a client that ignores that is the
 * one window that did not get the memo. Only the accent is taken from it,
 * because a generated palette is reliable about its accent and not about
 * whether its background has enough contrast to read a message on.
 *
 *
 * WHICH PROPERTIES, AND WHY THE LIST GREW
 *
 * This file used to write eleven of them -- --bg-color, --background-default,
 * --panel-background-lighter, --conversation-panel-background and the like --
 * and then paint over the gaps with element rules on body, #app, #main and
 * #pane-side. The report was that the palette reached the chat list and
 * stopped: the whole right-hand half of the window stayed WhatsApp's own grey,
 * and so did the settings panel and the tooltips.
 *
 * Measured on the live page (2026-10-04), and the reason is not subtle:
 *
 *   .two                       background-color: var(--WDS-surface-emphasized)
 *   the right-hand <section>   background-color: var(--WDS-background-elevated-wash-inset)
 *   #pane-side                 background-color: var(--WDS-surface-default)
 *   #main                      background-color: var(--WDS-systems-chat-background-wallpaper)
 *   the "You" tooltip          background-color: var(--WDS-surface-inverse)
 *   the settings drawer        #161717, straight off --WDS-surface-default
 *
 * WhatsApp has moved to a design system -- every token above is `--WDS-`
 * something -- and of the eleven names this file was writing, four were no
 * longer defined by the page at all. The palette landed on #pane-side and #app
 * because those were painted by hand here, and nowhere else, because nothing
 * else was.
 *
 * So the list below is the WDS one. It is longer and it is not more expensive:
 * every one of these is a declaration on a single element, and a custom
 * property costs what any inherited value costs -- nothing per element that
 * reads it. What came OUT is the part that did cost:
 *
 *   .message-in .copyable-text { ... }
 *   .message-out .copyable-text { ... }
 *
 * two descendant selectors evaluated against every bubble of every chat, for
 * classes this build of WhatsApp does not put on the page any more (measured:
 * 0 of each, against 33 .copyable-text). The bubbles are tokens now --
 * --WDS-systems-bubble-surface-incoming and -outgoing -- which is one
 * declaration each and reaches the bubbles the old rule never did.
 *
 *
 * AND WHY #main IS NO LONGER PAINTED BY HAND
 *
 * `#main { background-color: <bg> !important }` is what made the doodles
 * disappear. The wallpaper is drawn as an overlay above that ground --
 * `background-color: var(--WDS-systems-chat-foreground-wallpaper)` through an
 * SVG mask, at opacity 0.6 -- and that token is `rgba(255,255,255,.1)`, chosen
 * by WhatsApp against ITS ground of #161717. Over black it comes out at
 * level 7 of 255. Measured, by sampling the window:
 *
 *   alpha .10 (WhatsApp's own)   the doodles land at 7    invisible
 *   alpha .16                    18
 *   alpha .22                    28
 *   alpha .28                    39
 *
 * So the ground is set through its own token instead -- same colour, and the
 * wallpaper system left intact -- and the doodle colour is derived from the
 * palette rather than inherited from a theme that assumed a different ground.
 * An image wallpaper is a `background-image` on that same overlay and is not
 * touched by any of this, which is the other half of the report.
 */
'use strict';

const { THEMES } = require('./themes/palettes.js');
const { detectHyprlandColors } = require('./themes/pywal.js');

/* ------------------------------------------------------------- colours */

const hex = colour => {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(colour).trim());
  if (!match) return null;
  const digits = match[1].length === 3
    ? match[1].split('').map(d => d + d).join('')
    : match[1];
  return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
};

/* Rec. 709, which is what "is this dark" wants: the eye is not equally
   sensitive to the three channels, and a plain average calls #0000ff light. */
const luma = colour => {
  const rgb = hex(colour);
  if (!rgb) return 0;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
};

/* One colour a fraction of the way to another, for the surfaces a palette does
   not name. A palette is eight colours on purpose -- adding a ninth to
   palettes.js for every token WhatsApp invents is the maintenance this file
   exists to avoid -- so "the surface one step up from the card" is derived. */
const mix = (from, to, amount) => {
  const a = hex(from);
  const b = hex(to);
  if (!a || !b) return from;
  const channel = i => Math.round(a[i] + (b[i] - a[i]) * amount);
  return '#' + [0, 1, 2].map(i => channel(i).toString(16).padStart(2, '0')).join('');
};

const alpha = (colour, amount) => {
  const rgb = hex(colour);
  if (!rgb) return colour;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${amount})`;
};

/*
 * The doodle colour, derived so that it stays visible on whatever ground the
 * palette puts behind it.
 *
 * WhatsApp draws the wallpaper as a masked overlay at opacity 0.6, so what
 * lands on screen is roughly
 *
 *   delta = alpha * 0.6 * 0.85 * (distance from the ground to the overlay)
 *
 * where 0.85 is the mask itself -- its strokes are thin and antialiased, so
 * the overlay never reaches full coverage. Fitted against the sweep in the
 * header comment: alpha .22 on a black ground measured 28, and .22 * .51 * 255
 * is 28.6.
 *
 * TARGET is the delta asked for, in levels of 255. WhatsApp's own is 14 -- its
 * #161717 ground with the doodles at 36 -- and 14 over black is the 7 that
 * started this. 22 is the number here: clearly there on an OLED panel, and not
 * louder than WhatsApp's own on the mid-greys where its own is already right.
 */
const DOODLE_TARGET = 22;

const doodle = background => {
  const level = luma(background);
  /* White over a dark ground, black over a light one -- on #f0f2f5 there is no
     amount of white that draws anything. */
  const over = level < 128 ? '#ffffff' : '#000000';
  const distance = level < 128 ? 255 - level : level;
  const wanted = DOODLE_TARGET / (0.51 * Math.max(distance, 1));
  return alpha(over, Math.min(0.4, Math.max(0.1, Number(wanted.toFixed(3)))));
};

/* ----------------------------------------------------------- the sheet */

/*
 * WHY EVERY RULE BELOW IS HUNG OFF AN ATTRIBUTE
 *
 * A stylesheet inserted at user origin cannot be taken out of the page again.
 * That is measured and it is written down in src/style.js: insertCSS returns a
 * key, removeInsertedCSS resolves for that key, and the rules go on applying.
 * The client inserts a fresh sheet on every change and the newest declaration
 * wins, so switching one palette for another has always worked -- the new rule
 * contradicts the old one by name.
 *
 * Choosing *Default* does not. There is no palette to write, so the sheet says
 * nothing about these tokens, and "nothing" cannot beat a declaration that is
 * still in the page: the client went on wearing the palette it had been told to
 * take off. Reported as "عملت oled black بعد كده رجعت لل default مرجعش", and
 * confirmed on the live page -- the config said `system` while the page still
 * answered #2e3440 for --WDS-surface-default, which is Nord.
 *
 * Writing WhatsApp's own values back instead is not available: they are not
 * knowable once our own are in force, they differ between its dark and its
 * light, and `revert` at user origin rolls back to the user-agent rather than
 * to the page.
 *
 * So the rules are gated on an attribute the client sets on the page -- the
 * same shape as the privacy sheet, which hangs off `body.wa-privacy-active` for
 * exactly this reason. Taking the palette off is then clearing one attribute,
 * and every stale copy stops matching at once, however many of them the session
 * has accumulated. It is also why the palette's own key is in the selector
 * rather than the bare attribute: with the key, which palette is in force is a
 * fact about the page and not about which sheet happened to be inserted last.
 */
const MARK = 'data-wa-theme';
const ACCENT_MARK = 'data-wa-accent';

const isPalette = key => !!THEMES[key] && key !== 'system' && key !== 'light' && key !== 'dark';

/* What the page must be wearing for the sheet this call returns to apply.
   `null` means the attribute is cleared, which is what takes a palette off. */
const markFor = (themeKey, hyprAccent = null) => {
  if (isPalette(themeKey)) return { theme: themeKey, accent: null };
  return { theme: null, accent: hyprAccent ? 'on' : null };
};

/**
 * Generate CSS overrides for WhatsApp Web page when a custom theme is active.
 */
function getWebThemeCss(themeKey, hyprAccent = null) {
  if (!isPalette(themeKey)) {
    /* No palette: the page is WhatsApp's, and the only thing taken from the
       desktop is the accent -- which is a colour, not a theme, and does not
       need a ground of its own to sit on. */
    if (!hyprAccent) return '';
    return `
  /* WhatsApp Desktop -- the desktop's accent, over WhatsApp's own colours */
  :root[${ACCENT_MARK}] {
    --WDS-accent: ${hyprAccent} !important;
    --WDS-content-action-emphasized: ${hyprAccent} !important;
    --WDS-content-external-link: ${hyprAccent} !important;
    --WDS-persistent-always-branded: ${hyprAccent} !important;
    --primary: ${hyprAccent} !important;
    --primary-strong: ${hyprAccent} !important;
    --primary-stronger: ${hyprAccent} !important;
    --teal: ${hyprAccent} !important;
  }`;
  }

  const theme = THEMES[themeKey];
  const accent = hyprAccent || theme.accent;
  const dark = luma(theme.bg) < 128;

  /* The three surfaces WhatsApp's neutral ramp actually resolves to -- its own
     dark is #161717 / #1D1F1F / #242626 -- named here after what they are for
     rather than after the greys they happen to be. `raised` is the one a
     palette does not carry: the composer and an incoming bubble sit one step
     above the panels, and deriving it keeps a palette eight colours. */
  const ground = theme.bg;
  const panel = theme.card;
  const raised = theme.incomingBubble || mix(panel, dark ? '#ffffff' : '#000000', 0.06);
  /* What a tooltip is drawn on. WhatsApp's answer is --WDS-surface-inverse,
     which on its dark theme is #EEEEEE -- a white chip, which is what the "You"
     label looked like against every palette here. Lifted off the panel instead,
     so it reads as raised rather than as the one unthemed thing on screen. */
  const chip = mix(panel, theme.text, dark ? 0.14 : 0.08);

  const at = `:root[${MARK}="${themeKey}"]`;

  return `
  /* WhatsApp Desktop - Theme: ${theme.name} */
  ${at} {
    /* The neutral ramp the rest of the design system is built out of. Written
       first and on its own, so a token this list has not caught up with still
       lands somewhere in the palette rather than in WhatsApp's grey. */
    --WDS-neutral-gray-900: ${ground} !important;
    --WDS-neutral-gray-850: ${panel} !important;
    --WDS-neutral-gray-800: ${raised} !important;
    --WDS-neutral-gray-1000: ${mix(ground, dark ? '#000000' : '#ffffff', 0.5)} !important;

    /* Surfaces. --WDS-surface-default is the chat list and the settings drawer;
       -elevated-default and -emphasized are the panels and the nav rail;
       -elevated-emphasized is the composer and an incoming bubble. */
    --WDS-surface-default: ${ground} !important;
    --WDS-surface-elevated-default: ${panel} !important;
    --WDS-surface-emphasized: ${panel} !important;
    --WDS-surface-elevated-emphasized: ${raised} !important;
    --WDS-surface-highlight: ${alpha(theme.text, 0.1)} !important;
    --WDS-surface-pressed: ${alpha(theme.text, 0.2)} !important;
    --WDS-surface-inverse: ${chip} !important;
    --WDS-background-wash-plain: ${ground} !important;
    --WDS-background-wash-inset: ${ground} !important;
    --WDS-background-elevated-wash-plain: ${panel} !important;
    --WDS-background-elevated-wash-inset: ${panel} !important;
    --WDS-components-surface-nav-bar: ${panel} !important;
    --WDS-components-active-list-row: ${alpha(theme.text, 0.1)} !important;

    /* Text. --WDS-content-inverse is what is written ON surface-inverse, so it
       moves with the chip above or the tooltip is text in its own colour. */
    --WDS-content-default: ${theme.text} !important;
    --WDS-content-action-default: ${theme.text} !important;
    --WDS-content-deemphasized: ${alpha(theme.text, 0.6)} !important;
    --WDS-content-inverse: ${theme.text} !important;

    /* Lines. */
    --WDS-lines-divider: ${alpha(theme.text, 0.1)} !important;
    --WDS-lines-outline-deemphasized: ${alpha(theme.text, 0.1)} !important;
    --WDS-lines-outline-default: ${theme.border} !important;

    /* The accent, which is the palette's unless the desktop has one of its own. */
    --WDS-accent: ${accent} !important;
    --WDS-content-action-emphasized: ${accent} !important;
    --WDS-content-external-link: ${accent} !important;
    --WDS-persistent-always-branded: ${accent} !important;

    /* Startup uses its own tokens, including the RGB ground of the logo's
       shimmer. Leaving those at WhatsApp's grey draws rectangles over OLED
       black and leaves the logo almost invisible. */
    --splashscreen-startup-background: ${ground} !important;
    --splashscreen-startup-background-plain: ${ground} !important;
    --splashscreen-startup-background-rgb: ${hex(ground).join(', ')} !important;
    --splashscreen-startup-icon: ${accent} !important;
    --startup-icon: ${accent} !important;
    --splashscreen-primary-title: ${theme.text} !important;
    --splashscreen-secondary-lighter: ${theme.textMuted} !important;
    --splashscreen-startup-content-deemphasized: ${theme.textMuted} !important;
    --splashscreen-progress-primary: ${accent} !important;
    --splashscreen-progress-background: ${theme.border} !important;

    /* The bubbles, which used to be two descendant selectors matching nothing. */
    --WDS-systems-bubble-surface-incoming: ${raised} !important;
    --WDS-systems-bubble-surface-incoming-RGB: ${hex(raised).join(', ')} !important;
    --WDS-systems-bubble-surface-outgoing: ${theme.outgoingBubble} !important;
    --WDS-systems-bubble-surface-outgoing-RGB: ${hex(theme.outgoingBubble).join(', ')} !important;
    --WDS-systems-bubble-surface-system: ${panel} !important;
    --WDS-systems-bubble-surface-e2e: ${panel} !important;
    --WDS-systems-bubble-surface-business: ${panel} !important;
    --WDS-systems-chat-surface-composer: ${raised} !important;
    --WDS-systems-chat-surface-tray: ${ground} !important;

    /* The names WhatsApp has not finished retiring. Several of these are no
       longer defined by the page at all; they cost one declaration each and
       they are what an older corner of the interface still reads. */
    --bg-color: ${ground} !important;
    --background-default: ${ground} !important;
    --background-default-hover: ${panel} !important;
    --app-background: ${ground} !important;
    --panel-background-deep: ${ground} !important;
    --panel-background-lighter: ${panel} !important;
    --conversation-panel-background: ${ground} !important;
    --navbar-background: ${panel} !important;
    --incoming-background: ${raised} !important;
    --outgoing-background: ${theme.outgoingBubble} !important;
    --border-strong: ${theme.border} !important;
    --border-subtle: ${theme.border} !important;
    --primary-strong: ${accent} !important;
    --primary: ${accent} !important;
    --primary-stronger: ${theme.text} !important;
    --teal: ${accent} !important;
  }

  /*
   * The chat's own ground, which is set HERE and not on :root.
   *
   * WhatsApp puts the chat theme on #main itself -- measured: #main carries a
   * generated class whose rule writes --WDS-systems-chat-background-wallpaper
   * and -foreground-wallpaper -- so a declaration on :root is overridden by it
   * for the whole conversation and reaches nothing. One ID selector, one
   * element, and the wallpaper overlay above it is left exactly as WhatsApp
   * draws it: the doodles, or an image, whichever is switched on.
   */
  ${at} #main {
    /* WhatsApp attaches per-chat colour classes after the first render. Set
       these at the same scope so opening/switching chats cannot change palette. */
    --WDS-accent: ${accent} !important;
    --WDS-content-action-emphasized: ${accent} !important;
    --WDS-content-external-link: ${accent} !important;
    --WDS-content-read: ${accent} !important;
    --WDS-systems-bubble-surface-incoming: ${raised} !important;
    --WDS-systems-bubble-surface-incoming-RGB: ${hex(raised).join(', ')} !important;
    --WDS-systems-bubble-surface-outgoing: ${theme.outgoingBubble} !important;
    --WDS-systems-bubble-surface-outgoing-RGB: ${hex(theme.outgoingBubble).join(', ')} !important;
    --WDS-systems-bubble-surface-system: ${panel} !important;
    --WDS-systems-bubble-surface-e2e: ${panel} !important;
    --WDS-systems-bubble-surface-business: ${panel} !important;
    --incoming-background: ${raised} !important;
    --outgoing-background: ${theme.outgoingBubble} !important;
    --WDS-systems-chat-background-wallpaper: ${ground} !important;
    --WDS-systems-chat-foreground-wallpaper: ${doodle(ground)} !important;
  }

  /* The ground behind everything, for the moment before the page has drawn and
     for whatever it leaves transparent. */
  ${at} body {
    background-color: ${ground} !important;
    color: ${theme.text} !important;
  }

  /* React replaces the initial splash with a second loading screen. Both
     logos have a hardcoded dim colour and a gradient of WhatsApp's own grey,
     so theme the logo itself and remove its decorative overlay in both. */
  ${at} :is(#wa_web_initial_startup, [data-testid="wa-web-loading-screen"]) > div:first-child {
    color: ${accent} !important;
  }
  ${at} :is(#wa_web_initial_startup, [data-testid="wa-web-loading-screen"]) > div:first-child::after {
    content: none !important;
    display: none !important;
  }
  `;
}

module.exports = {
  THEMES,
  detectHyprlandColors,
  getWebThemeCss,
  markFor,
  MARK,
  ACCENT_MARK,
  /* Exported for the tests, which check the derivation rather than the string:
     a doodle that comes out invisible is the bug this file shipped. */
  doodle,
  luma,
  mix,
};
