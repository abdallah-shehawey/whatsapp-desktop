/*
 * A link to a WhatsApp chat, and how this client comes to be the thing that
 * opens one.
 *
 * Press "Open app" on api.whatsapp.com and the browser does not open anything
 * itself: it hands the desktop a `whatsapp://send?phone=...` URL and asks who
 * handles that scheme. With nobody registered for it the page falls back to
 * "Continue to WhatsApp Web" and the chat opens in a browser tab, which is the
 * report -- a client is installed and the link still went round it.
 *
 * Two halves answer that. The desktop entry declares
 * `x-scheme-handler/whatsapp`, which is what makes this app an *option*; and
 * `claim()` below asks to be the default, which is what makes it the answer.
 * The second one matters because a browser that has been asked to remember its
 * own choice will have taken the scheme, and a MimeType line does not outrank a
 * choice already written into mimeapps.list.
 *
 * What arrives is a command line, not an event: xdg-open runs
 * `whatsapp-desktop whatsapp://send?phone=...`, and because this app holds a
 * single-instance lock the second copy exits and its argv comes back to the
 * first through `second-instance`. Both paths end in `from()`.
 *
 * The shapes accepted are the ones the world actually produces. WhatsApp's own
 * pages emit them; wa.me is what a message body turns into.
 *
 *   whatsapp://send?phone=20…&text=hi     the scheme handler, from any browser
 *   https://api.whatsapp.com/send?phone=  the "Chat on WhatsApp with …" page
 *   https://wa.me/20…?text=hi             the short link people share
 *   https://web.whatsapp.com/send?phone=  WhatsApp Web's own
 *
 *   whatsapp://chat/?code=<code>          "Open app" on a group invite page
 *   https://chat.whatsapp.com/<code>      the invite link people share
 *   https://web.whatsapp.com/accept?code= "Continue to WhatsApp Web" on that page
 *
 * A group invite used to be left to the browser on the reasoning that joining a
 * group is a decision and belongs on a page that spells out which group. That
 * reasoning was right and the conclusion stopped being: the moment this client
 * took the scheme, the browser's only way to act on "Open app" was to hand the
 * link back here, and here it went nowhere -- second-instance found no chat in
 * the argv and fell through to raising the window. So the invite arrived, the
 * window jumped to the current workspace, and nothing opened. That is the report
 * (issue: "it was impossible to join the group without WhatsApp Web").
 *
 * The dialog that spells out which group is one this client can show, and show
 * without going anywhere: the page puts up WhatsApp's own join dialog over the
 * chat list -- group photo, name, when it was created, who is already in it,
 * Cancel and Join group -- with the URL untouched. Nothing is joined without the
 * button being pressed. See openInvite in src/page/inject.js.
 */
'use strict';

const SCHEME = 'whatsapp';

/* A phone number as WhatsApp addresses one: digits, no punctuation, country
   code included. Shorter than five is not a number anybody chats with -- it is
   a truncated link -- and longer than the E.164 maximum is not one either. */
const digitsOf = value => {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits.length >= 5 && digits.length <= 20 ? digits : '';
};

/* A group invite code: the base64url alphabet, and WhatsApp has issued 22
   characters of it for years. The range is wider than 22 so that a length
   WhatsApp changes does not send the owner back to a browser, and narrow enough
   that a path which is not a code -- `/`, `/download`, a stray slug -- answers
   empty and is left alone. */
const inviteOf = value => {
  const code = String(value || '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(code) ? code : '';
};

/*
 * A URL, read as one of two things: which chat and what was already typed into
 * it (`{ phone, text }`), or which group is being offered (`{ invite }`).
 *
 * Returns null for everything else, and that null is the whole safety of this
 * file: an unrecognised link is not this client's to interpret, and the caller
 * hands it back to the browser.
 */
const from = url => {
  if (!url || typeof url !== 'string') return null;
  let parsed;
  try { parsed = new URL(url); } catch (e) { return null; }

  const scheme = parsed.protocol.replace(':', '').toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const params = parsed.searchParams;
  const text = params.get('text') || '';

  if (scheme === SCHEME) {
    /* The host is where the verb lands: `whatsapp://send?phone=` parses with
       "send" as the hostname, and `whatsapp:send?phone=` -- which some pages
       emit -- puts it in the path instead. Two verbs are answered; the scheme
       also carries calls, settings and business flows that this client has no
       way to perform. */
    const verb = (host || parsed.pathname.replace(/[/:]/g, '')).toLowerCase();
    /* "chat" is the invite, and it is the measured name rather than a guessed
       one: the group invite page emits `whatsapp://chat/?code=<code>`, read
       straight out of what chat.whatsapp.com serves. */
    if (verb === 'chat') {
      const invite = inviteOf(params.get('code'));
      return invite ? { invite } : null;
    }
    if (verb && verb !== 'send') return null;
    const phone = digitsOf(params.get('phone'));
    return phone ? { phone, text } : null;
  }

  if (scheme !== 'http' && scheme !== 'https') return null;

  if (host === 'chat.whatsapp.com') {
    /* `/<code>`, and the older `/invite/<code>` that links shared years ago
       still carry. The query on the end -- chat.whatsapp.com hangs `?s=cl&p=a`
       and friends off a shared link -- is not part of it. */
    const path = parsed.pathname.replace(/^\/(?:invite\/)?/, '').replace(/\/+$/, '');
    const invite = inviteOf(path);
    return invite ? { invite } : null;
  }

  if (host === 'web.whatsapp.com' && /^\/accept\/?$/.test(parsed.pathname)) {
    /* Where "Continue to WhatsApp Web" points, which is also where this client
       sends an invite of its own. Recognising it costs nothing and means a
       client already showing the dialog is not asked to load it again. */
    const invite = inviteOf(params.get('code'));
    return invite ? { invite } : null;
  }

  if (host === 'wa.me' || host === 'api.whatsapp.com' || host === 'web.whatsapp.com') {
    /* Decoded before the digits are picked out of it: a number written with
       spaces arrives as %20, and stripping punctuation from THAT leaves a 20 in
       the middle of the number for every space in it. */
    let path = parsed.pathname;
    try { path = decodeURIComponent(path); } catch (e) { /* leave it as it came */ }
    const phone = digitsOf(params.get('phone')) || digitsOf(path);
    /* wa.me/message/<code> is a short link that only WhatsApp can resolve, and
       its path is letters -- digitsOf answers empty and it goes to a browser,
       which is the only thing that can follow it. */
    return phone ? { phone, text } : null;
  }

  return null;
};

/* The first thing on a command line that this file recognises. Electron's own
   switches are on there too, and so is the path to the app in a dev run. */
const inArgv = argv => {
  for (const arg of argv || []) {
    if (typeof arg !== 'string' || arg[0] === '-') continue;
    const link = from(arg);
    if (link) return link;
  }
  return null;
};

/* A whatsapp: URL that this file did not recognise, worth saying out loud
   because there is nowhere to send it. Handing it to the browser is not a
   fallback: this client holds the scheme, so the browser would hand it straight
   back. What it can do is name the verb in the log, so the next report of a link
   that went nowhere says which one on the first read. */
const unhandled = url => {
  if (!url || typeof url !== 'string') return '';
  let parsed;
  try { parsed = new URL(url); } catch (e) { return ''; }
  if (parsed.protocol.replace(':', '').toLowerCase() !== SCHEME) return '';
  return (parsed.hostname || parsed.pathname.replace(/[/:]/g, '')).toLowerCase() || SCHEME;
};

/*
 * Ask to be the app the desktop opens whatsapp: links with.
 *
 * Electron shells out to `xdg-settings set default-url-scheme-handler`, and it
 * takes the desktop file's name from the CHROME_DESKTOP environment variable --
 * which is set for us when the app is launched from its own .desktop file and
 * absent when it is launched from a terminal. So it is filled in here rather
 * than assumed; without it the call fails silently and the scheme stays with
 * whatever holds it.
 *
 * Asked on every start, and only when the answer is currently no. A single
 * "we have registered once" flag would lose the scheme for good the first time
 * a browser took it, and re-registering something already registered is a
 * process that does nothing. `links.claim-scheme = false` in the config file is
 * for the owner who wants their browser to keep it.
 */
const claim = (app, appId, { enabled = true } = {}) => {
  if (!enabled) return 'not asked for';
  if (!process.env.CHROME_DESKTOP) process.env.CHROME_DESKTOP = `${appId}.desktop`;
  try {
    if (app.isDefaultProtocolClient(SCHEME)) return 'already ours';
    return app.setAsDefaultProtocolClient(SCHEME) ? 'claimed' : 'refused';
  } catch (e) {
    return `could not ask (${e.message})`;
  }
};

module.exports = { SCHEME, from, inArgv, unhandled, claim, digitsOf, inviteOf };
