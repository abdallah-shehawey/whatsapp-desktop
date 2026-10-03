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
 * nothing to leave on -- nineteen rules, most of them :root, no descendant
 * matching and nothing evaluated per element on a scrolling list. (The privacy
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
 */
'use strict';

const { THEMES } = require('./themes/palettes.js');
const { detectHyprlandColors } = require('./themes/pywal.js');

/**
 * Generate CSS overrides for WhatsApp Web page when a custom theme is active.
 */
function getWebThemeCss(themeKey, hyprAccent = null) {
  const theme = THEMES[themeKey];
  if (!theme || themeKey === 'system' || themeKey === 'light' || themeKey === 'dark') {
    if (hyprAccent) {
      return `
        /* Dynamic Hyprland accent tint */
        :root { --accent: ${hyprAccent} !important; --teal: ${hyprAccent} !important; }
        .active-pill { background-color: ${hyprAccent} !important; }
      `;
    }
    return '';
  }

  const effectiveAccent = hyprAccent || theme.accent;

  return `
  /* WhatsApp Desktop - Theme: ${theme.name} */
  :root {
    --bg-color: ${theme.bg} !important;
    --background-default: ${theme.bg} !important;
    --background-default-hover: ${theme.card} !important;
    --panel-background-lighter: ${theme.card} !important;
    --panel-background-deep: ${theme.bg} !important;
    --conversation-panel-background: ${theme.bg} !important;
    --border-strong: ${theme.border} !important;
    --border-subtle: ${theme.border} !important;
    --primary-strong: ${effectiveAccent} !important;
    --primary: ${effectiveAccent} !important;
    --teal: ${effectiveAccent} !important;
  }

  body, #app, #main, #pane-side, [data-testid="conversation-panel-wrapper"] {
    background-color: ${theme.bg} !important;
    color: ${theme.text} !important;
  }

  header, [data-testid="chatlist-header"], [data-testid="conversation-header"] {
    background-color: ${theme.card} !important;
    border-color: ${theme.border} !important;
  }

  .message-in .copyable-text {
    background-color: ${theme.incomingBubble} !important;
    color: ${theme.text} !important;
  }

  .message-out .copyable-text {
    background-color: ${theme.outgoingBubble} !important;
    color: ${theme.text} !important;
  }
  `;
}

module.exports = {
  THEMES,
  detectHyprlandColors,
  getWebThemeCss,
};
