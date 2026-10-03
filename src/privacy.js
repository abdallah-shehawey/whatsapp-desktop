/*
 * Blurring the conversation, for the person standing behind you.
 *
 * The threat this answers is a shoulder over yours in a cafe or an office, and
 * nothing more: the messages are still in the page and still in memory, and
 * anyone with the machine can read them. What it buys is that a glance at the
 * screen -- while you are turned away, while you are sharing it, while the
 * window is in the background -- costs nothing.
 *
 * Two ways in, because the two moments are different. Ctrl+Alt+P is the one you
 * press when somebody walks up; `auto-blur` is the one that catches the time you
 * did not. Hover reveal is what makes it usable to leave on: the line under the
 * pointer is readable and the rest of the screen is not.
 *
 * It is drawn as a user stylesheet, so WhatsApp's own !important rules do not
 * win over it. The sheet is inserted only while something is actually covered
 * -- see styleSheet in src/main.js -- and the classes on <body> decide which
 * parts of it apply.
 *
 * Nothing here uses :has(). It is the obvious way to reach the row around a
 * name, and it cost 22ms of the 27ms this sheet spent per style recalc on a
 * 300-row list: Chromium matches right to left, so `div:has(> span[title])`
 * is evaluated against every div on the page. The name inside those rows is
 * already blurred by its own selector, so the :has() rules were buying the
 * padding around text that was covered anyway.
 */
'use strict';

const PRIVACY_CSS = `
/* WhatsApp Desktop - Privacy Shield */
body.wa-privacy-active #main .message-in .copyable-text,
body.wa-privacy-active #main .message-out .copyable-text,
body.wa-privacy-active #main div[data-pre-plain-text],
body.wa-privacy-active #main span.selectable-text {
  filter: blur(8px) !important;
  transition: filter 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none !important;
}

body.wa-privacy-active #main img,
body.wa-privacy-active #main video,
body.wa-privacy-active #main div[data-testid="audio-player"],
body.wa-privacy-active #main div[data-testid="ptt-draft-player"],
body.wa-privacy-active #main div[data-testid="sticker"],
body.wa-privacy-active #main div[data-testid="image-thumb"],
body.wa-privacy-active #main span[data-icon="audio-play"],
body.wa-privacy-active #main span[data-icon="audio-pause"] {
  filter: blur(12px) !important;
  transition: filter 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Chat list: contact names, last message preview, and status text */
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] span[title],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] span[dir="auto"],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] span[dir="ltr"],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] span[dir="rtl"],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] [data-testid="last-msg-status"],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] div[data-testid="cell-frame-title"],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="gridcell"] span[title],
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="gridcell"] span[dir="auto"],
body.wa-privacy-active.wa-privacy-contacts #pane-side div[role="listitem"] span[title],
body.wa-privacy-active.wa-privacy-contacts #side [role="row"] span[title],
body.wa-privacy-active.wa-privacy-contacts #side [role="row"] span[dir="auto"] {
  filter: blur(7px) !important;
  transition: filter 0.18s cubic-bezier(0.4, 0, 0.2, 1);
  user-select: none !important;
}

/* Chat list: profile pictures & avatars */
body.wa-privacy-active.wa-privacy-contacts #pane-side [role="row"] img,
body.wa-privacy-active.wa-privacy-contacts #pane-side img,
body.wa-privacy-active.wa-privacy-contacts #side [role="row"] img,
body.wa-privacy-active.wa-privacy-contacts #side div[role="button"] img {
  filter: blur(10px) !important;
  transition: filter 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Active chat header: contact title and avatar */
body.wa-privacy-active.wa-privacy-contacts header span[title],
body.wa-privacy-active.wa-privacy-contacts header [data-testid="conversation-info-header"] span[title],
body.wa-privacy-active.wa-privacy-contacts header span[dir="auto"],
body.wa-privacy-active.wa-privacy-contacts header img {
  filter: blur(7px) !important;
  transition: filter 0.18s cubic-bezier(0.4, 0, 0.2, 1);
}

/* Hover reveal */
body.wa-privacy-active.wa-privacy-hover #main .message-in:hover .copyable-text,
body.wa-privacy-active.wa-privacy-hover #main .message-out:hover .copyable-text,
body.wa-privacy-active.wa-privacy-hover #main div[data-pre-plain-text]:hover,
body.wa-privacy-active.wa-privacy-hover #main span.selectable-text:hover,
body.wa-privacy-active.wa-privacy-hover #main img:hover,
body.wa-privacy-active.wa-privacy-hover #main video:hover,
body.wa-privacy-active.wa-privacy-hover #main div[data-testid="audio-player"]:hover,
body.wa-privacy-active.wa-privacy-hover #main div[data-testid="ptt-draft-player"]:hover,
body.wa-privacy-active.wa-privacy-hover #main div[data-testid="sticker"]:hover,
body.wa-privacy-active.wa-privacy-hover #main div[data-testid="image-thumb"]:hover,
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover span[title],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover span[dir="auto"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover span[dir="ltr"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover span[dir="rtl"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover [data-testid="last-msg-status"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover div[data-testid="cell-frame-title"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="row"]:hover img,
body.wa-privacy-active.wa-privacy-hover #pane-side [role="gridcell"]:hover span[title],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="gridcell"]:hover span[dir="auto"],
body.wa-privacy-active.wa-privacy-hover #pane-side [role="gridcell"]:hover img,
body.wa-privacy-active.wa-privacy-hover #pane-side div[role="listitem"]:hover span[title],
body.wa-privacy-active.wa-privacy-hover #side [role="row"]:hover span[title],
body.wa-privacy-active.wa-privacy-hover #side [role="row"]:hover span[dir="auto"],
body.wa-privacy-active.wa-privacy-hover #side [role="row"]:hover img,
body.wa-privacy-active.wa-privacy-hover header:hover span[title],
body.wa-privacy-active.wa-privacy-hover header:hover span[dir="auto"],
body.wa-privacy-active.wa-privacy-hover header:hover img {
  filter: none !important;
}
`;

class PrivacyManager {
  constructor(config) {
    this.config = config;
    this.manualStealth = !!config.get('privacy.stealth');
    /* Read as "on only if asked", matching the default, so a config file
       written before this key existed does not come back blurring on every
       alt-tab. The two below are the other way round and read as "on unless
       turned off", because their default is on. */
    this.autoBlur = config.get('privacy.auto-blur') === true;
    this.hoverReveal = config.get('privacy.hover-reveal') !== false;
    this.blurContacts = config.get('privacy.blur-contacts') !== false;
    this.windowFocused = true;
  }

  isBlurred() {
    if (this.manualStealth) return true;
    if (this.autoBlur && !this.windowFocused) return true;
    return false;
  }

  toggleStealth() {
    this.manualStealth = !this.manualStealth;
    this.config.set('privacy.stealth', this.manualStealth);
    this.config.save();
    return this.isBlurred();
  }

  setWindowFocus(focused) {
    this.windowFocused = !!focused;
    return this.isBlurred();
  }

  getClasses() {
    const classes = [];
    if (this.isBlurred()) {
      classes.push('wa-privacy-active');
      if (this.hoverReveal) classes.push('wa-privacy-hover');
      if (this.blurContacts) classes.push('wa-privacy-contacts');
    }
    return classes;
  }

  getInjectScript() {
    const classes = this.getClasses();
    const classStr = JSON.stringify(classes);
    return `(() => {
      const cls = ${classStr};
      const targets = ['wa-privacy-active', 'wa-privacy-hover', 'wa-privacy-contacts'];
      targets.forEach(c => document.body.classList.remove(c));
      cls.forEach(c => document.body.classList.add(c));
    })();`;
  }
}

module.exports = {
  PRIVACY_CSS,
  PrivacyManager,
};
