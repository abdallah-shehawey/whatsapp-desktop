/*
 * A chat's picture, put back when it breaks.
 *
 * The report: the photograph on a chat -- somebody's, or a group's -- sometimes
 * goes, and what is left is not WhatsApp's grey circle but nothing at all, a
 * hole where the face was. Opening that chat brings it back. It had been there
 * a minute earlier.
 *
 * All three halves of that are explained by the same two measurements.
 *
 * WhatsApp Web does not draw a chat's face with an <img> any more. Measured on
 * the live list: it is an <svg> with a mask, holding either an
 * `<image xlink:href="https://…">` for a photograph or a `<rect>` and a glyph
 * in a `<foreignObject>` for the grey circle. An <img> whose source fails gets a
 * broken-image mark from the engine; an SVG <image> whose href fails **draws
 * nothing**, silently, and leaves the mask empty. That is the hole, and it is
 * why no placeholder appears in its place: WhatsApp never asked for a
 * placeholder, it asked for a photograph and believes it got one.
 *
 * And the URL it asked for is not permanent. `ProfilePicThumb.img` is a derived,
 * MEMOISED getter over `eurl` -- measured, the value is cached on the model as
 * `__x_img` and re-read from there for ever -- which rewrites the host to
 * whichever CDN the model last used, `media-hbe1-1.cdn.whatsapp.net` on this
 * account, while `eurl` itself points at `pps.whatsapp.net`. The model carries
 * `hostRetryCount`, `lastHostUsed`, `markMms4HostFailure` and
 * `markMms4HostSuccess`: WhatsApp has host failover for exactly this, and the
 * intended answer to a picture that will not load is to mark the host failed and
 * derive the URL again. Nothing calls it for a chat-list avatar, because React
 * renders an `<image>` and no part of WhatsApp is listening for its error.
 *
 * So this listens. It is the only thing here that is new: everything it does
 * about a failure afterwards is WhatsApp's own -- `getProfilePic` for a fresh
 * signed URL (measured: it answers with an eurl that differs from the cached
 * one, and does NOT write it to the model), `markMms4HostFailure` for the host,
 * and, when even that fails, the same circle src/page/avatar.js already draws
 * for a notification.
 *
 * Which is also why "open the chat and it comes back" was true: opening a chat
 * is one of the things that asks WhatsApp for the picture again.
 */
'use strict';

const placeholder = require('./avatar.js');

/* Long enough to gather a burst -- a laptop coming back from sleep fails every
   avatar on the screen within a frame or two of each other -- and short enough
   that a single broken face is back before the eye settles on it. */
const GATHER_MS = 150;

/* At most this many repairs in flight. Each one is a round trip to WhatsApp's
   servers, and forty of them at once on a network that has just come back is
   how a repair becomes the outage. */
const AT_ONCE = 4;

/* How many times one picture may be repaired before it is left alone. A URL
   that fails, is replaced, and fails again is not a stale URL -- it is a
   picture that is not there -- and the circle below is the honest answer to
   that, not a third round trip. */
const TRIES = 2;

/* And how long a repaired URL is remembered, so that a re-render carrying the
   same broken href back is recognised rather than repaired again from nought. */
const REMEMBER_MS = 10 * 60 * 1000;

/* WhatsApp's own picture hosts, and nothing else. An <image> is not necessarily
   an avatar -- a sticker, a link preview, a document thumbnail are all drawn
   with one -- and a repair aimed at those would ask the profile-picture store
   about a URL it has never heard of, every time one of them failed. */
const PICTURE_HOST = /(^|\.)(whatsapp\.net|whatsapp\.com)$/i;

const hrefOf = element => {
  try {
    if (element.namespaceURI === 'http://www.w3.org/2000/svg')
      return element.getAttribute('xlink:href') || element.getAttribute('href') || '';
    return element.getAttribute('src') || '';
  } catch (e) { return ''; }
};

const setHref = (element, url) => {
  try {
    if (element.namespaceURI === 'http://www.w3.org/2000/svg') {
      /* Both forms. WhatsApp writes the xlink one and the engine reads either;
         leaving the old xlink attribute in place beside a new href is a picture
         that changes back on the next re-parse. */
      element.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
      element.setAttribute('href', url);
    } else {
      element.setAttribute('src', url);
    }
  } catch (e) {}
};

const start = ({ log, grab }) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const faces = placeholder.make({ grab });

  /* url -> { at, tries }. Keyed by the URL and not by the element for the
     reason the arrival glide is: WhatsApp recycles the nodes, and an element
     this has already seen may be carrying a different chat's face by the time
     it fails. */
  const seen = new Map();
  /* The elements waiting for the next round, and the round itself. */
  let waiting = [];
  let timer = 0;
  let busy = 0;

  const sweep = () => {
    if (seen.size < 512) return;
    const cutoff = Date.now() - REMEMBER_MS;
    for (const [url, note] of seen) if (note.at < cutoff) seen.delete(url);
  };

  /* Which account a URL belongs to.
   *
   * Asked of the store rather than worked out from the URL: the path carries an
   * id of Meta's own that means nothing here, and the model is where the answer
   * already is. The index is rebuilt per round rather than kept, because the
   * whole point of a repair is that these URLs change -- a cache would hand back
   * the very URL that was replaced. 741 models on this account, four string
   * reads each, once per burst. */
  const whoseIs = url => {
    const pics = grab('WAWebProfilePicThumbCollection');
    const collection = pics && pics.ProfilePicThumbCollection;
    if (!collection || typeof collection.getModelsArray !== 'function') return null;
    for (const model of collection.getModelsArray()) {
      for (const field of ['img', 'imgFull', 'eurl', 'previewEurl']) {
        let value = '';
        try { value = String(model[field] || ''); } catch (e) { continue; }
        if (value && value === url) return model;
      }
    }
    return null;
  };

  /* The memoised derived values, taken off so that `img` is worked out again
     from the eurl and the host that have just been written. There is no public
     way to do this -- `set` leaves them alone, measured: eurl changed and img
     did not -- and they are plain own properties with a WhatsApp prefix, so
     they are deleted by name. If the prefix ever changes, `img` simply keeps
     the value it had and the href written below is still the repaired one; the
     picture on the screen comes back either way. */
  const forget = model => {
    for (const key of ['__x_img', '__x_imgFull']) {
      try { delete model[key]; } catch (e) {}
    }
  };

  /* Does this URL actually serve a picture? Asked before anything is written
     into the page, because putting a second dead URL in place of the first is
     not a repair and the circle below is a better answer than another hole. */
  const loads = url => new Promise(resolve => {
    let done = false;
    const answer = ok => { if (!done) { done = true; resolve(ok); } };
    try {
      const probe = new Image();
      probe.onload = () => answer(probe.naturalWidth > 0);
      probe.onerror = () => answer(false);
      probe.src = url;
    } catch (e) { answer(false); }
    setTimeout(() => answer(false), 4000);
  });

  /* WhatsApp's own grey circle, drawn here because WhatsApp will not draw it:
     it has a URL for this chat and no reason to believe it is bad. The same
     canvas a notification's face comes off, at the same colours the list is
     using this moment, so a picture that cannot be fetched leaves a circle that
     belongs rather than a hole. */
  const circleFor = (element, model) => {
    if (!model) return false;
    let wid = null;
    try { wid = model.id; } catch (e) { return false; }
    let kind = '';
    try {
      const chats = grab('WAWebChatCollection');
      const chat = chats && chats.ChatCollection && chats.ChatCollection.get(wid);
      kind = (chat && chat.groupType) || '';
    } catch (e) {}
    let face = '';
    try { face = faces.faceFor(wid, kind); } catch (e) { face = ''; }
    if (!face) return false;
    setHref(element, 'data:image/png;base64,' + face);
    return true;
  };

  const repair = async element => {
    if (!element.isConnected) return;
    const url = hrefOf(element);
    if (!url || !/^https?:/.test(url)) return;

    const note = seen.get(url) || { at: Date.now(), tries: 0 };
    note.at = Date.now();
    seen.set(url, note);
    sweep();
    if (note.tries >= TRIES) return;
    note.tries++;

    const model = whoseIs(url);
    if (!model) return;                 /* not a chat's face: a sticker, a preview */

    /* The host first, which is WhatsApp's own answer to a host that will not
       serve and costs nothing when the host was never the problem. */
    try { model.markMms4HostFailure(); } catch (e) {}

    let fresh = null;
    try {
      const job = grab('WAWebGetProfilePicJob');
      if (job && typeof job.getProfilePic === 'function')
        fresh = await job.getProfilePic(model.id, {});
    } catch (e) { fresh = null; }

    if (fresh && fresh.eurl) {
      try {
        model.set({
          eurl: fresh.eurl,
          previewEurl: fresh.previewEurl || fresh.eurl,
          tag: fresh.tag,
          fullDirectPath: fresh.directPath,
          previewDirectPath: fresh.directPath,
          filehash: fresh.filehash,
        });
      } catch (e) {}
      forget(model);

      let next = '';
      try { next = String(model.img || fresh.eurl); } catch (e) { next = String(fresh.eurl); }
      if (next && next !== url && await loads(next)) {
        try { model.markMms4HostSuccess(); } catch (e) {}
        if (element.isConnected && hrefOf(element) === url) setHref(element, next);
        seen.set(next, { at: Date.now(), tries: 0 });
        log('picture: a chat face was refetched after it failed to load');
        return;
      }
    }

    /* Nothing served it. WhatsApp asked for a photograph and there is none to
       be had, so the chat gets the face it would have had if WhatsApp had known
       that -- rather than the hole it has now. */
    if (element.isConnected && hrefOf(element) === url && circleFor(element, model))
      log('picture: a chat face could not be fetched, so it wears its own circle');
  };

  const round = async () => {
    timer = 0;
    const batch = waiting;
    waiting = [];
    for (const element of batch) {
      while (busy >= AT_ONCE) await new Promise(r => setTimeout(r, 60));
      busy++;
      repair(element).catch(() => {}).then(() => { busy--; });
    }
  };

  const note = element => {
    if (waiting.indexOf(element) >= 0) return;
    waiting.push(element);
    /* A burst has an end. Past this the queue is a leak rather than a batch --
       every avatar on a page can fail at once and each is one entry. */
    if (waiting.length > 128) waiting.shift();
    if (!timer) timer = setTimeout(round, GATHER_MS);
  };

  /* `error` does not bubble -- measured on a real SVG <image> pointed at a URL
     that is not there: `bubbles=false` -- so this is a capture listener at the
     window, which non-bubbling events still travel through on the way down.
     There is no other way to hear about one of these from outside React. */
  addEventListener('error', event => {
    const element = event.target;
    if (!element || element.nodeType !== 1) return;
    const tag = (element.tagName || '').toLowerCase();
    if (tag !== 'image' && tag !== 'img') return;
    const url = hrefOf(element);
    if (!url || !/^https?:/.test(url)) return;
    let host = '';
    try { host = new URL(url, location.href).hostname; } catch (e) { return; }
    if (!PICTURE_HOST.test(host)) return;
    note(element);
  }, true);

  /* And the case the whole report is really about: a laptop that slept, or a
     network that went and came back. Every avatar that failed while it was away
     is still a hole, and nothing will ask about it again -- the elements are not
     re-rendered, so no second error is coming. So they are swept for: any
     avatar on the page that the engine has decoded to nothing. */
  const sweepThePage = why => {
    let found = 0;
    for (const element of document.querySelectorAll('image, img')) {
      const url = hrefOf(element);
      if (!url || !/^https?:/.test(url)) continue;
      let host = '';
      try { host = new URL(url, location.href).hostname; } catch (e) { continue; }
      if (!PICTURE_HOST.test(host)) continue;
      /* An <img> says so itself. An SVG <image> has no naturalWidth and no
         complete flag -- there is nothing on the element to ask -- so it is
         asked of the URL, which is a cache hit for every picture that is fine
         and the one round trip that matters for a picture that is not. */
      if (typeof element.naturalWidth === 'number') {
        if (!element.complete || element.naturalWidth > 0) continue;
        note(element);
        found++;
        continue;
      }
      const known = seen.get(url);
      if (known && known.tries >= TRIES) continue;
      loads(url).then(ok => { if (!ok) note(element); });
      found++;
    }
    if (found) log('picture: checking ' + found + ' chat face(s) after ' + why);
  };

  let asleep = 0;
  addEventListener('online', () => sweepThePage('the network came back'));
  addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { asleep = Date.now(); return; }
    /* Only after a real absence. Every alt-tab is a visibilitychange and a
       page full of avatars is not worth re-checking for one of those. */
    if (asleep && Date.now() - asleep > 60000) sweepThePage('a spell away');
    asleep = 0;
  });

  log('picture: watching for chat faces that fail to load');
  return { sweep: sweepThePage };
};

module.exports = { start };
