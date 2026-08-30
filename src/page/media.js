/*
 * Stickers, downloaded whether or not photos are.
 *
 * The report was that stickers do not appear at all with "Media auto-download"
 * turned off, and that nothing appears in their place either -- no placeholder,
 * no button offering to fetch one. That is not this client's doing, and it is
 * worth writing down, because it looks exactly like a bug in it:
 *
 *   WAWebMediaAutoDownloadQueue.shouldAutoDownloadMedia switches on the message
 *   type, and STICKER and IMAGE fall through to the SAME case -- both answer
 *   getAutoDownloadPhotos(). Measured on the live page: photos off, and every
 *   sticker in the account sitting at mediaStage INIT with a directPath, a
 *   mediaKey and a filehash, wanting only for somebody to ask.
 *
 * The phone does not work that way. Its auto-download settings list photos,
 * audio, video and documents, and stickers are in none of them -- they arrive,
 * always, because a sticker is small and a conversation full of grey boxes is
 * not a conversation. This makes the client behave like the phone: the message's
 * own downloadMedia is called for stickers and for nothing else, so the photo
 * switch keeps meaning exactly what it says for photos.
 *
 * Asked of the message rather than arranged by patching the rule above. The rule
 * is writable and patching it was measured to take from outside -- but WhatsApp
 * calls it from inside its own module, where a minified call goes straight to
 * the local binding and never reads the export, so a patch there would be a
 * change that appears to work and quietly does nothing.
 */
'use strict';

/* Big enough for an animated sticker and far below anything that could be a
   photo in disguise; the largest seen on this account was 741 KB. A cap at all
   is here because size is the one property of a sticker that is not fixed by
   what a sticker is. */
const STICKER_MAX_BYTES = 4 * 1024 * 1024;

/* How many to have in flight at once. A conversation opened for the first time
   can hold dozens, and asking for all of them together is a burst of requests
   WhatsApp did not schedule. */
const AT_ONCE = 3;

/* How far back to look when a conversation is opened. Only what is loaded is
   drawn, and only what is drawn needs to arrive. */
const SWEEP_BACK = 60;

const WAIT_MS = 120000;
const POLL_MS = 500;

const start = ({ log }) => {
  const grab = name => {
    if (typeof window === 'undefined' || typeof window.require !== 'function') return null;
    try { return window.require(name); } catch (e) { return null; }
  };

  let msgs = null;
  let chats = null;
  let enabled = true;

  const inFlight = new Set();
  const queue = [];
  let asked = 0;

  const keyOf = msg => {
    try { return (msg.id && (msg.id._serialized || String(msg.id))) || ''; } catch (e) { return ''; }
  };

  const stageOf = msg => {
    try { return (msg.mediaData && msg.mediaData.mediaStage) || ''; } catch (e) { return ''; }
  };

  /* Worth asking for: a sticker, not already here, not already being fetched,
     and small enough to be what it says it is. A message with no mediaKey has
     nothing to decrypt with and no request would succeed. */
  const worthIt = msg => {
    try {
      if (!enabled || !msg || msg.type !== 'sticker') return false;
      if (!msg.mediaKey || !msg.directPath) return false;
      const stage = stageOf(msg);
      if (stage && stage !== 'INIT') return false;
      const size = Number(msg.mediaData && msg.mediaData.size) || 0;
      if (size > STICKER_MAX_BYTES) return false;
      const key = keyOf(msg);
      return !!key && !inFlight.has(key);
    } catch (e) { return false; }
  };

  const pump = () => {
    while (asked < AT_ONCE && queue.length) {
      const msg = queue.shift();
      if (!worthIt(msg)) continue;
      const key = keyOf(msg);
      inFlight.add(key);
      asked++;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        asked--;
        inFlight.delete(key);
        pump();
      };
      try {
        /* isUserInitiated, because that is what it is. The user turned an
           auto-download switch off, and this is not auto-download -- it is the
           client fetching the one kind of media the phone always fetches.
           WhatsApp refuses an untrusted message without it. */
        const answer = msg.downloadMedia({
          downloadEvenIfExpensive: true,
          isUserInitiated: true,
        });
        if (answer && typeof answer.then === 'function') answer.then(finish, finish);
        else finish();
      } catch (e) { finish(); }
    }
  };

  const want = msg => {
    if (!worthIt(msg)) return;
    queue.push(msg);
    if (queue.length > 200) queue.splice(0, queue.length - 200);
    pump();
  };

  /* Everything already loaded in the conversation the user just opened. An
     arrival is caught by the listener below; this is for the stickers that were
     already there, sitting at INIT since whenever the switch was turned off. */
  const sweep = chat => {
    try {
      const held = chat && chat.msgs;
      const all = held && (held.getModelsArray ? held.getModelsArray() : held.models);
      if (!all) return;
      for (const msg of all.slice(-SWEEP_BACK)) want(msg);
    } catch (e) {}
  };

  const wire = () => {
    msgs.on('add', want);
    /* A sticker that arrived before its key did shows up as ciphertext and
       becomes a sticker later, which is an arrival the listener above would
       never see. */
    msgs.on('change:type', msg => want(msg));
    chats.on('change:active', (chat, active) => { if (active) sweep(chat); });

    try {
      const open = chats.getActive && chats.getActive();
      if (open) sweep(open);
    } catch (e) {}
  };

  let waited = 0;
  const attempt = () => {
    const msgMod = grab('WAWebMsgCollection');
    const chatMod = grab('WAWebChatCollection');
    msgs = msgMod && msgMod.MsgCollection;
    chats = chatMod && chatMod.ChatCollection;
    if (!msgs || !chats || typeof msgs.on !== 'function' || !chats.length) {
      waited += POLL_MS;
      if (waited >= WAIT_MS) return;
      setTimeout(attempt, POLL_MS);
      return;
    }
    try { wire(); } catch (e) {
      log('could not arrange for stickers to download: ' + e.message);
      return;
    }
    log('stickers will download whether or not photos do');
  };

  setTimeout(attempt, 800);

  return { setEnabled: value => { enabled = !!value; } };
};

module.exports = { start };
