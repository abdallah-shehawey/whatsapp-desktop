/*
 * WhatsApp's own store, asked directly.
 *
 * Everything the notification half of this client used to know, it inferred
 * from the chat list: a row moved, so something arrived; a pill went away, so
 * something was read; an @ badge is on the row, so this is a mention. Each of
 * those is a guess about a picture drawn for a person, and each of them was
 * wrong in a way that showed:
 *
 *   - a mention badge stays on the row until the mention is READ, so every
 *     ordinary message that followed one into a muted group was announced as
 *     though it were addressed to the user;
 *   - the pill is redrawn on WhatsApp's clock, so "read on the phone" reached
 *     this client seconds late, behind a MutationObserver, a 2.5s grace and a
 *     3s sweep -- and never at all while the window sat in the tray, because a
 *     hidden renderer does not repaint a list nobody is looking at;
 *   - a deleted message left its banner up, because nothing in a chat list says
 *     a message that WAS there has gone.
 *
 * None of that has to be guessed. contextIsolation is off for this window, so
 * this file shares WhatsApp Web's world, and `window.require` is Meta's own
 * module registry -- `require('__debug').modulesMap` lists 16866 of them on the
 * build measured here. The collections behind the interface are ordinary
 * Backbone-shaped models with events on them, and every question this client
 * asks has an answer that WhatsApp itself is already computing:
 *
 *   MsgCollection      'add'                    a message, with its type, its
 *                                               author and its mentions
 *   ChatCollection     'change:unreadCount'     read, here or on the phone,
 *                                               measured at 16ms behind arrival
 *   ChatCollection     'change:active'          the conversation on screen
 *   MsgCollection      'change:type' -> revoked deleted for everyone
 *   MsgCollection      'change'                 a call that has stopped ringing
 *   ReactionsCollection 'add'/'change'          somebody reacted, and to what
 *
 * These are private names and they will not be private for ever, so nothing
 * here believes them: every lookup happens inside a try, every answer is
 * checked, and a store that does not resolve leaves `ready` false -- at which
 * point inject.js keeps its chat-list watcher and the client behaves exactly as
 * it did before this file existed. The DOM path is not dead code; it is the
 * fallback for the morning WhatsApp renames a module.
 */
'use strict';

const wording = require('../wording.js');

/* How old a message may be and still be news. WhatsApp adds history to the
   collection as it syncs, with isNewMsg set on all of it, so the timestamp is
   what tells a message that just arrived from one being filled in behind it. */
const FRESH_S = 300;

/* Nothing is announced in the moment the store comes up: that is the sync, and
   the sync is the whole unread backlog arriving at once. */
const SETTLE_MS = 8000;

/* How much of the message a reaction landed on is worth quoting back. Short: the
   point of the line is who reacted and with what, and the message is there to
   say which one. */
const REACTION_ABOUT_MAX = 90;

/* Joins the parts of a synthetic notification id. Occurs in no chat name and in
   no message key. */
const SEP = '\u001f';

/* How long to keep asking for the store before giving up on it and leaving the
   chat-list watcher in charge. A cold start on a slow link takes a while to get
   as far as a populated ChatCollection. */
const WAIT_MS = 120000;
const POLL_MS = 400;

/* What each kind of message is called, and which kinds are messages at all.
 *
 * An allow-list, and it lives in wording.js beside the table the chat-list
 * watcher matches previews against -- one place, so the two halves of the client
 * cannot end up calling a voice note different things. A type that is not in it
 * is not a message: the census of one real account turned up forty-two
 * type/subtype pairs, of which nine were things people had sent and the rest
 * were WhatsApp talking to itself (e2e_notification, gp2, call_log, protocol,
 * notification_template, biz_content_placeholder, message_history_notice). A
 * deny-list would announce every one of those the first time WhatsApp invented a
 * new one.
 *
 * `call_log` is the one of those the user is owed something for, and it is
 * handled apart from this table -- see missedCall below, and CALL. */
const KINDS = wording.MARKS;

/* A message that has not decrypted yet. WhatsApp puts it in the collection as
   this and rewrites its type when the key arrives, so it is not dropped -- it is
   remembered, and announced when it turns into something. */
const PENDING = 'ciphertext';

/* A call, which WhatsApp files as an ordinary message in the chat it was made
   from. It is a system message -- WAWebMsgType.SYSTEM_MESSAGE_TYPES lists it
   beside gp2 and e2e_notification -- and the table above drops all of those,
   which is right for every one of them except this. WhatsApp itself makes the
   same exception: WAWebGetNotificationStrings.getNotificationMessageBody has a
   `case "call_log"` among the message types it writes a body for. */
const CALL = 'call_log';

const start = ({ send, log, fetchAvatar, faceFor }) => {
  /* `window` itself is checked, not just the registry on it. This module is a
     plain CommonJS file and the test rig loads it as one, outside the sandbox it
     builds for the page -- so the first thing it meets is a world with no window
     at all, which is the same shape as a WhatsApp build that has taken the
     registry away. Both answer "no store", which is the right answer to both. */
  const R = () => (typeof window !== 'undefined' && typeof window.require === 'function'
                   ? window.require : null);
  const grab = name => { const r = R(); if (!r) return null; try { return r(name); } catch (e) { return null; } };

  let S = null;                 // the resolved store, or null
  let liveAt = 0;               // when it came up
  let focused = false;
  let enabled = true;

  /* ------------------------------------------------------------- resolving */

  const resolve = () => {
    const chatMod = grab('WAWebChatCollection');
    const msgMod  = grab('WAWebMsgCollection');
    if (!chatMod || !msgMod) return null;
    const chats = chatMod.ChatCollection;
    const msgs  = msgMod.MsgCollection;
    /* A collection that exists but is empty is a page that has not finished
       loading, not a store that is ready to be believed. */
    if (!chats || !msgs || typeof chats.on !== 'function' || !chats.length) return null;

    const contactMod = grab('WAWebContactCollection');
    const contactNames = grab('WAWebContactGetters');
    const reactMod   = grab('WAWebReactionsCollection');
    const picMod     = grab('WAWebProfilePicThumbCollection');
    const cmdMod     = grab('WAWebCmd');
    const meMod      = grab('WAWebUserPrefsMeUser');
    const getterMod  = grab('WAWebMsgGetters');
    const callMod    = grab('WAWebCallLogMsgData.flow');

    return {
      chats, msgs,
      contacts: contactMod && contactMod.ContactCollection,
      contactNames,
      reactions: reactMod && reactMod.ReactionsCollection,
      pics: picMod && picMod.ProfilePicThumbCollection,
      cmd: cmdMod && cmdMod.Cmd,
      me: meMod,
      getters: getterMod,
      /* Non-enumerable, so Object.keys answers {} and the values have to be
         asked for by name. Each one is its own name -- Missed is "Missed" -- and
         the fallbacks below say so, but the enum is read first. */
      outcomes: callMod && callMod.CallOutcome,
    };
  };

  /* ---------------------------------------------------------------- basics */

  /* A message's identity, and never a name.
   *
   * `_serialized` is a lazily built string and it was measured ABSENT on a
   * change:type for a message whose id was otherwise whole -- so a withdrawal
   * keyed on it would have missed the one event it exists for, a message being
   * deleted. The parts are always there, and WhatsApp's own format for joining
   * them is what is written here. */
  const keyOf = id => {
    if (!id) return '';
    try {
      if (typeof id._serialized === 'string' && id._serialized) return id._serialized;
    } catch (e) {}
    try {
      const remote = id.remote && (id.remote._serialized || String(id.remote));
      if (!remote || !id.id) return '';
      const parts = [String(!!id.fromMe), remote, String(id.id)];
      const who = id.participant && (id.participant._serialized || String(id.participant));
      if (who) parts.push(who);
      return parts.join('_');
    } catch (e) { return ''; }
  };

  const widOf = wid => {
    if (!wid) return '';
    try { return wid._serialized || String(wid); } catch (e) { return ''; }
  };

  const isMe = wid => {
    const serialized = widOf(wid);
    if (!serialized) return false;
    try {
      if (S.me && typeof S.me.isSerializedWidMe === 'function')
        return !!S.me.isSerializedWidMe(serialized);
    } catch (e) {}
    /* The registry answers this itself on every build measured; the comparison
       below is only reached if it stops doing so. Both forms are kept because an
       account has a phone-number jid and a lid and WhatsApp uses either. */
    for (const get of ['getMaybeMeLidUser', 'getMaybeMePnUser']) {
      try {
        if (S.me && widOf(S.me[get]()) === serialized) return true;
      } catch (e) {}
    }
    return false;
  };

  const chatOf = id => {
    try { return S.chats.get(id) || null; } catch (e) { return null; }
  };

  const titleOf = chat => {
    if (!chat) return '';
    try {
      return String(chat.formattedTitle || chat.name || widOf(chat.id) || '').trim();
    } catch (e) { return ''; }
  };

  /* A group, a community subgroup, a newsletter -- anything where the message
     carries an author of its own and the banner has to say who wrote. */
  const isGroup = chat => {
    try {
      const server = chat && chat.id && chat.id.server;
      return server === 'g.us' || server === 'newsletter' || server === 'broadcast' ||
             chat.isGroup === true;
    } catch (e) { return false; }
  };

  /* WhatsApp writes -1 for "until I turn it off" and a unix time in SECONDS for
     everything else; 0 and undefined are not muted. */
  const isMuted = chat => {
    try {
      const mute = chat && chat.mute;
      const until = mute ? mute.expiration : chat && chat.muteExpiration;
      if (!until) return false;
      if (until === -1) return true;
      return until * 1000 > Date.now();
    } catch (e) { return false; }
  };

  /* What to call somebody, tried in the order the phone tries it.
   *
   * Measured on this account's 44661 contacts: 1683 carry an address-book name,
   * 1918 carry a push name and not their own, and **41060 carry neither** -- so
   * what happens at the bottom of this list is not an edge case, it is most of
   * them.
   *
   * `name` is the address book and it wins, because a name the user chose beats
   * a name somebody chose for themselves. Then WhatsApp's own getNotifyName,
   * which is here rather than below the raw fields because it answers where they
   * do not: a contact with `name` and `pushname` both empty came back
   * "Mohamed abdalla" from it. Then the fields it did not cover, and then the
   * telephone number -- which is what the phone shows for somebody it cannot
   * name, and is the answer to "what happens to a mention of a person with no
   * username": their saved name if there is one, their profile name if not,
   * and their number if neither. Never a lid: a lid is an internal identifier,
   * fifteen digits that mean nothing to anybody, and one of them going out on a
   * banner is the bug this list exists to prevent.
   *
   * `fallback` is the push name WhatsApp wrote onto the message itself, which a
   * group message carries even for a sender with no contact row at all. */
  const clean = value => String(value == null ? '' : value).replace(/^~\s*/, '').trim();

  /* Somebody's telephone number, which is what goes on the banner when there is
     no name to put there -- the owner asked for this outright, and it is what the
     phone does.

     A lid is an internal identifier and never appears. Two ways back from one to
     a number, in order: the pairing WhatsApp has already written onto the contact,
     and then WhatsApp's own converter, WAWebLidMigrationUtils.toPn, which answers
     for any account the client has ever exchanged messages with. When toPn
     answers undefined WhatsApp does not know the number either, and nothing else
     on the page does. */
  const numberOf = (contact, wid, serialized) => {
    let digits = '';
    if (/@c\.us$/.test(serialized)) digits = serialized.replace(/@.*$/, '');
    if (!digits) {
      try { digits = widOf(contact && contact.phoneNumber).replace(/@.*$/, ''); } catch (e) {}
    }
    if (!digits) {
      try {
        const lids = grab('WAWebLidMigrationUtils');
        if (lids && typeof lids.toPn === 'function')
          digits = widOf(lids.toPn(wid)).replace(/@.*$/, '');
      } catch (e) {}
    }
    return /^\d{6,}$/.test(digits) ? '+' + digits : '';
  };

  const nameOf = (wid, fallback) => {
    const serialized = widOf(wid);
    let contact = null;
    try { contact = (S.contacts && S.contacts.get(wid)) || null; } catch (e) {}

    if (contact) {
      const saved = clean(contact.name);
      if (saved) return saved;
      try {
        if (S.contactNames && typeof S.contactNames.getNotifyName === 'function') {
          const known = clean(S.contactNames.getNotifyName(contact));
          if (known) return known;
        }
      } catch (e) {}
      for (const field of ['pushname', 'verifiedName', 'formattedName']) {
        const found = clean(contact[field]);
        if (found) return found;
      }
    }

    const said = clean(fallback);
    if (said) return said;

    const number = numberOf(contact, wid, serialized);
    if (number) return number;

    /* Nothing is known about this account at all. A bare telephone number is
       still something a person can recognise; a lid is not, so it is left as it
       is rather than dressed up as a number it never was. */
    return /@c\.us$/.test(serialized) ? '+' + serialized.replace(/@.*$/, '') : serialized;
  };

  /* ------------------------------------------------------- what the user asked for */

  /*
   * WhatsApp Web's own notification settings, honoured rather than re-invented.
   *
   * These are the switches in Settings -> Notifications, and until now this
   * client could not see them: it had its own three (enabled, sound, hide
   * preview) and WhatsApp had its own six, and turning one of WhatsApp's off did
   * nothing at all because the banner was not WhatsApp's to raise. "Show
   * reaction notifications" was off on this account for the whole of the work
   * above, and reactions were being announced the entire time.
   *
   * Read at the moment of the decision rather than cached: the user can change
   * any of them while the client runs, and WhatsApp writes them to its own
   * storage with no event this side can subscribe to.
   *
   * Every one of them is an AND with the client's own setting, never a
   * replacement -- the client's switch stays the master, because it is the one
   * in the window the user opened to turn notifications off.
   */
  /* Asked of MuteCollection first, because that is where WhatsApp's own
     shouldEnableReactionsNotificationGranular reads them -- the same names live
     on WAWebUserPrefsNotifications and the two agreed on every switch when
     compared, but the one WhatsApp consults is the one to consult. */
  const asks = (name, fallback) => {
    for (const where of ['WAWebMuteCollection', 'WAWebUserPrefsNotifications']) {
      try {
        const module = grab(where);
        const on = where === 'WAWebMuteCollection' ? (module && module.MuteCollection) : module;
        if (on && typeof on[name] === 'function') {
          const answer = on[name]();
          if (typeof answer === 'boolean') return answer;
        }
      } catch (e) {}
    }
    return fallback;
  };

  /* Whether WhatsApp itself would announce a message in this chat. */
  const wanted = chat => {
    if (!asks('getGlobalNotificationsEnabled', true)) return false;
    if (!isGroup(chat)) return true;
    return asks('getGlobalGroupNotificationsEnabled', true);
  };

  /* "Only notify me for messages that mention me", WhatsApp's own group switch. */
  const onlyMentions = () => asks('getIgnoreNondirectGroupMsg', false);

  /* And the one that was being ignored outright. WhatsApp keeps a separate
     answer for a direct chat, a group and a status; the first two are the ones a
     reaction can land in here. */
  const reactionsWanted = chat =>
    asks(isGroup(chat) ? 'getGlobalGroupNotificationReactionsEnabled'
                       : 'getGlobalNotificationReactionsEnabled', false);

  /* -------------------------------------------------------------- pictures */

  /* The chat's own thumbnail, straight out of the store. This is the answer to
     "a community notification arrived wearing the application icon": the chat
     list keeps a 1x1 transparent GIF in the <img> of a row whose picture has not
     loaded, and reading the face off the DOM read that. The store holds the URL
     whether or not anything has drawn it. */
  const pictureFor = async chat => {
    let url = '';
    try {
      const thumb = S.pics && S.pics.get(chat.id);
      if (thumb) url = thumb.img || thumb.imgFull || thumb.eurl || '';
    } catch (e) {}
    if (url) {
      try {
        const encoded = await fetchAvatar(url);
        if (encoded) return encoded;
      } catch (e) {}
    }
    /* And what the chat list saw, for a chat whose thumbnail the store has not
       fetched yet. */
    try { return (await faceFor(titleOf(chat))) || ''; } catch (e) { return ''; }
  };

  /* ------------------------------------------------------- what a message is */

  /* Addressed to the user in particular, which is the one thing that gets past
     a muted group.
     *
     * Read off the MESSAGE and never off the chat. WhatsApp puts an @ badge on
     * the chat-list row and leaves it there until the mention has been READ, so
     * a client reading the row announced every ordinary message that followed a
     * mention into a muted group -- measured: a mention at 46331826 with
     * mentionedJidList set, then a plain message at 46339758 with an empty one,
     * and the row's badge identical for both. */
  const aimedAtUs = msg => {
    try {
      for (const wid of (msg.mentionedJidList || [])) if (isMe(wid)) return wording.MENTION_MARK;
    } catch (e) {}
    /* A reply to something the user wrote. The phone treats it the same way a
       mention is treated, and so does WhatsApp Web's own muting. */
    try {
      if (msg.quotedParticipant && isMe(msg.quotedParticipant)) return wording.REPLY_MARK;
      const quoted = msg.quotedMsg;
      if (quoted && quoted.id && quoted.id.fromMe) return wording.REPLY_MARK;
      if (msg.quotedStanzaID && msg.quotedRemoteJid && !isGroup({ id: msg.id.remote }) &&
          msg.quotedParticipant === undefined) return '';
    } catch (e) {}
    return '';
  };

  /* The words, if there are any, and never more of them than a banner can hold.
     A caption rides in `body` for every media type measured, so there is one
     field to read and not two. */
  const TEXT_MAX = 400;

  /* A mention, written the way it is read rather than the way it is stored.
   *
   * WhatsApp keeps the ACCOUNT in the message and the name nowhere: the body of
   * "ايه دا @abdullah" is literally "ايه دا @162251130572804", and the interface
   * substitutes the display name every time it draws it. A notification built
   * from the raw body therefore announced a mention as a sixteen-digit number --
   * which is not a wrong name, it is an internal identifier on a banner.
   *
   * The list of who was mentioned rides along on the message, so each account's
   * user part is found in the text and the name put in its place. Longest first:
   * two accounts whose ids share a prefix would otherwise have the shorter one
   * rewritten inside the longer one, leaving half an id behind the name. */
  /* The @ in front of a name, asked of WhatsApp. A username is stored with its
     own @ already on it, so putting one in front produced
     "@@abdullah_shehawey" -- measured on the live account, where the owner's own
     contact is named that. WhatsApp has the same problem and solves it in
     addAtPrefixForMention: strip a leading @, then add exactly one. The local
     copy below is that function, kept for the day the name goes away. */
  const atPrefix = name => {
    try {
      const mod = grab('WAWebMentionDisplayUtils');
      if (mod && typeof mod.addAtPrefixForMention === 'function') {
        const answer = mod.addAtPrefixForMention(name);
        if (typeof answer === 'string' && answer) return answer;
      }
    } catch (e) {}
    return '@' + (name.startsWith('@') ? name.slice(1) : name);
  };

  const withNames = (said, msg) => {
    let out = said;
    let list = [];
    try { list = msg.mentionedJidList || []; } catch (e) { return out; }
    const users = [];
    for (const wid of list) {
      const user = widOf(wid).replace(/@.*$/, '');
      if (user) users.push({ user, name: nameOf(wid) });
    }
    users.sort((a, b) => b.user.length - a.user.length);
    for (const { user, name } of users) {
      if (!name || name === user) continue;
      out = out.split('@' + user).join(atPrefix(name));
    }
    return out;
  };

  const textOf = msg => {
    let said = '';
    try { said = msg.body || msg.caption || ''; } catch (e) {}
    said = withNames(String(said == null ? '' : said), msg)
      .replace(/\s+/g, ' ').trim();
    return said.length > TEXT_MAX ? said.slice(0, TEXT_MAX) + '…' : said;
  };

  /* ----------------------------------------------------------------- calls */

  /* One of WhatsApp's own memoised getters, read off the message. These are the
     very ones WAWebFormatCallLog consults when it writes the call's line into
     the chat, so nothing below is a second opinion about a call. */
  const askCall = (name, msg) => {
    try {
      const get = S.getters && S.getters[name];
      return typeof get === 'function' ? get(msg) : undefined;
    } catch (e) { return undefined; }
  };

  /*
   * A call nobody picked up, and the mark to put on it -- or null for every
   * other thing a call can be.
   *
   * This is the one system message the user is owed a banner for, and it went
   * missing the day the store took over: WhatsApp Web raises its own
   * notification for a missed call, the shim in inject.js swallows that while
   * the store is live, and the store dropped call_log with the rest of the
   * types it does not recognise. Nobody was announcing it.
   *
   * Which outcomes are worth a banner is the phone's answer rather than a new
   * one. WAWebCallLogMsgData.flow names eight:
   *
   *   Missed, Canceled     nobody answered, or the caller gave up waiting
   *   Rejected             the user turned it down, so they know
   *   AcceptedElsewhere    the user answered on the phone, so they know
   *   Completed            answered here
   *   Ongoing              ringing right now, and it has no outcome yet
   *   Failed, Unknown      nothing a person did
   *
   * Ongoing matters more than it looks, and the two outcomes have to be read in
   * WhatsApp's own order to get it right. Measured on a real call: the log lands
   * in the chat the instant the phone starts ringing, carrying callOutcome
   * "Ongoing" and finalCallOutcome ALREADY "Missed" -- WhatsApp writes the
   * pessimistic answer up front and settles it when the call is over. Reading
   * the final one first therefore announced a missed call while the phone was
   * still ringing, which is exactly what the owner saw.
   *
   * So the live state wins, which is the test WAWebFormatCallLog itself makes:
   *
   *   isOngoing = callOutcome === Ongoing && finalCallOutcome !== Completed
   *
   * A call still ringing answers null here, and the `change` this file listens
   * for brings the message back once the outcome has settled.
   */
  const callNow = msg => {
    if (!S.getters) return null;

    /* WhatsApp's own switch for an unknown number that was never allowed to
       ring. Announcing it is the thing the user turned it on to avoid. */
    if (askCall('getIsCallSilenced', msg) === true) return null;
    if (askCall('getIsSentByMe', msg) === true) return null;

    /* Each name in the enum is its own value -- Missed is "Missed" -- so the
       fallback is the name itself, but the enum is what is read. */
    const names = S.outcomes || {};
    const named = name => names[name] || name;

    /* Named the way the phone names it. A build that stops answering which kind
       of call it was still gets a mark, because the one thing worth saying is
       that there was a call. */
    const markFrom = set => {
      const video = askCall('getIsVideoCall', msg);
      if (video === true) return set.video;
      if (video === false) return set.voice;
      return set.call;
    };

    const outcome = askCall('getCallOutcome', msg);
    const final = askCall('getFinalCallOutcome', msg);
    if (outcome === named('Ongoing') && final !== named('Completed'))
      return { ringing: true, mark: markFrom(wording.RINGING) };

    const settled = final == null ? outcome : final;
    if (settled == null) return null;
    if (settled !== named('Missed') && settled !== named('Canceled') &&
        askCall('getIsMissedCall', msg) !== true) return null;
    return { ringing: false, mark: markFrom(wording.MISSED) };
  };

  /* The mark for what arrived. A voice note gets its length, the way the phone
     writes it, because "Voice message" alone loses the one fact about it that
     the chat list bothers to show. */
  const markOf = msg => {
    /* A call is not in the table above, because it is not one kind of thing but
       several and only one of them is news here. A call still ringing has a
       banner of its own -- see calling() -- and nothing for this path to say
       until it is over. */
    if (msg.type === CALL) {
      const call = callNow(msg);
      return call && !call.ringing ? call.mark : null;
    }
    const label = KINDS[msg.type];
    if (label === undefined) return null;                    // not a message
    if (msg.type !== 'ptt' && msg.type !== 'audio') return label;
    const seconds = parseInt(msg.duration, 10);
    if (!label || !seconds || !isFinite(seconds)) return label;
    const clock = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
    return label + ' (' + clock + ')';
  };

  /* ------------------------------------------------------------- announcing */

  /* The conversation the user is looking at, which gets no banner at all. Both
     halves are needed and neither is enough: `active` is WhatsApp's own answer
     to which chat is open -- it beats reading aria-selected, and it is right
     while the window is hidden, when nothing is drawn to read -- and a window
     the user is not in front of is not one they are reading. */
  const onScreen = chat => {
    try { return chat.active === true && focused; } catch (e) { return false; }
  };

  const pending = new Set();          // ciphertext ids waiting to become messages
  const announced = new Set();        // ids already sent over, so a retype is not a repeat

  const remember = id => {
    announced.add(id);
    if (announced.size > 512) announced.delete(announced.values().next().value);
  };

  const arrived = async (msg, why) => {
    if (!enabled || !S) return;
    if (Date.now() - liveAt < SETTLE_MS) return;

    let id, chatId;
    try {
      if (!msg || !msg.id || msg.id.fromMe) return;
      id = keyOf(msg.id);
      chatId = widOf(msg.id.remote);
    } catch (e) { return; }
    if (!id || !chatId || announced.has(id)) return;

    /* Not decrypted yet: WhatsApp will rewrite the type when the key lands, and
       this is asked again then. */
    if (msg.type === PENDING) { pending.add(id); return; }

    const mark = markOf(msg);
    if (mark === null) return;                       // WhatsApp talking to itself

    /* History filling in behind the sync. isNewMsg is set on all of it. */
    const age = Date.now() / 1000 - (Number(msg.t) || 0);
    if (!(age < FRESH_S)) return;

    const chat = chatOf(msg.id.remote);
    if (!chat) return;

    const aimed = aimedAtUs(msg);
    if (!wanted(chat)) return;                       // WhatsApp's own switch is off
    if (isMuted(chat) && !aimed) return;             // muted, and not for the user
    /* "Only notify me if I am mentioned", asked of a group and of nothing else. */
    if (isGroup(chat) && onlyMentions() && !aimed) return;
    if (onScreen(chat)) {
      /* The bubble was drawn under the user's eyes as it arrived. Nothing to
         announce, but the app still wants to know, so it can play its tone. */
      remember(id);
      send('store-open-arrival', { chat: chatId });
      return;
    }

    remember(id);
    const group = isGroup(chat);
    const payload = {
      msg: id,
      chat: chatId,
      title: titleOf(chat),
      sender: group ? nameOf(msg.author || msg.from, msg.notifyName) : '',
      group,
      mark: (aimed ? aimed + ' ' : '') + (mark || ''),
      text: textOf(msg),
      mention: !!aimed,
      muted: isMuted(chat),
      avatar: '',
      why,
    };
    payload.avatar = await pictureFor(chat);
    send('store-message', payload);
  };

  /* -------------------------------------------------- a telephone ringing */

  /*
   * A call while it is still ringing, which is a banner that stands until it
   * stops rather than one that is read and gone.
   *
   * One message carries both edges of this. WhatsApp writes the call into the
   * chat with the outcome Ongoing the instant the offer lands and rewrites it
   * when the call is over -- measured on a real call at 15452ms and 21807ms,
   * six seconds apart, both on the same message id. So this is asked on the
   * arrival and on every change, and "is it ringing" is the answer callNow
   * already gives.
   *
   * Keyed by WhatsApp's own call id and not by the message. The banner for a
   * call that was MISSED is keyed on the message, and the two have to be
   * different things: they are both up for a moment while one replaces the
   * other, and taking one down must not take the other with it.
   */
  const ringing = new Map();          // call id -> the chat it is ringing in

  const calling = async msg => {
    if (!S) return;

    let callId, chatId;
    try {
      if (!msg || msg.type !== CALL || !msg.id || msg.id.fromMe) return;
      callId = String(askCall('getCallId', msg) || keyOf(msg.id));
      chatId = widOf(msg.id.remote);
    } catch (e) { return; }
    if (!callId || !chatId) return;

    const call = callNow(msg);

    /* Stopped ringing -- answered, turned down, or missed. The banner comes down
       either way. Whether a missed call is announced in its place is arrived()'s
       answer and not this one's, which is why nothing here looks at why it
       stopped. */
    if (!call || !call.ringing) {
      if (!ringing.delete(callId)) return;
      send('store-ring-over', { call: callId, chat: chatId });
      return;
    }

    if (ringing.has(callId)) return;               // already announced
    if (!enabled) return;
    if (Date.now() - liveAt < SETTLE_MS) return;

    /* History filling in behind the sync, which is full of calls that were
       ringing once. None of them is ringing now. */
    const age = Date.now() / 1000 - (Number(msg.t) || 0);
    if (!(age < FRESH_S)) return;

    /* The window is in front of the user and WhatsApp draws the incoming call
       across the whole of it. A banner would be a second copy of something
       already filling the screen. */
    if (focused) return;

    const chat = chatOf(msg.id.remote);
    if (!chat) return;
    if (!wanted(chat)) return;
    /* Muting is deliberately not consulted here, and that is the phone's own
       behaviour: muting a chat silences its messages, and a call from the same
       person still rings. */

    ringing.set(callId, chatId);
    if (ringing.size > 32) ringing.delete(ringing.keys().next().value);

    const group = isGroup(chat);
    send('store-ringing', {
      call: callId,
      chat: chatId,
      title: titleOf(chat),
      sender: group ? nameOf(msg.author || msg.from, msg.notifyName) : '',
      group,
      mark: call.mark,
      avatar: await pictureFor(chat),
    });
  };

  /* ------------------------------------------------------------- reactions */

  /* Somebody reacting to one of the user's messages. It is not a message and it
     does not move the unread count -- measured: hasReaction fired with no
     change:unreadCount behind it -- so it has its own path, and the row it lands
     on is keyed by the message reacted to.
     *
     * `unreadSenders` is WhatsApp's own answer to "which of these has the user
     * not seen", so a reaction read on the phone stops being reported here
     * without this file knowing anything about read receipts. */
  const reacted = new Map();          // parent key + sender -> the emoji announced

  /* Every seat this parent message still has an unread reaction for. WhatsApp's
     own answer: unreadSenders filters out anything the user has seen, wherever
     they saw it, and anything that has since been taken back. */
  const unreadSeats = row => {
    let senders = [];
    try {
      const unread = typeof row.unreadSenders === 'function' ? row.unreadSenders() : row.unreadSenders;
      senders = Array.isArray(unread) ? unread : (unread && unread.toArray ? unread.toArray() : []);
    } catch (e) { return null; }
    return senders;
  };

  /* Every banner raised for a reaction on this message, taken down. */
  const dropReactions = (parentKey, chatId) => {
    for (const [seat, emoji] of [...reacted]) {
      if (!seat.startsWith(parentKey + '|')) continue;
      reacted.delete(seat);
      send('store-gone', { msg: 'reaction' + SEP + seat + SEP + emoji, chat: chatId });
    }
  };

  /*
   * A message that has stopped carrying any reaction at all.
   *
   * This is the ONLY thing WhatsApp says when the last reaction on a message is
   * taken back. Measured, twice, in a group and in a direct chat: the reaction
   * arrives as a ReactionsCollection `add` with the sender unread, and when it
   * is removed four seconds later that collection is **silent** -- no add, no
   * change, no remove -- and the parent message alone reports
   * change:hasReaction false. A withdrawal waiting on the reactions collection
   * was therefore waiting for something that never comes, which is why the
   * banner stayed up.
   *
   * The other half -- one of several reactions removed, the message still
   * carrying the rest -- leaves hasReaction true and does move the collection,
   * and that is reconciled seat by seat in reaction() below.
   */
  const reactionsGone = msg => {
    let parentKey, chatId;
    try {
      if (!msg || !msg.id || !msg.id.fromMe) return;
      parentKey = keyOf(msg.id);
      chatId = widOf(msg.id.remote);
    } catch (e) { return; }
    if (!parentKey || !chatId) return;
    dropReactions(parentKey, chatId);
  };

  const reaction = async row => {
    if (!enabled || !S) return;
    let parentKey, chatId;
    try {
      if (!row || !row.id || !row.id.fromMe) return;    // only on the user's own
      parentKey = keyOf(row.id);
      chatId = widOf(row.id.remote);
    } catch (e) { return; }
    if (!parentKey || !chatId) return;

    const senders = unreadSeats(row);
    if (senders === null) return;

    /*
     * What is no longer waiting, taken down -- and this runs before any of the
     * tests below, and before the settle window, because a withdrawal is owed
     * whatever the reason a banner would not be raised now.
     *
     * A reaction does not move the chat's unread count -- measured: hasReaction
     * fired with no change:unreadCount behind it -- so the trim that takes a
     * message's banner down when the chat is read never applied to one. This is
     * the read state for reactions, and it covers all three of the cases that
     * were left standing: read on the phone, read here, and the reaction taken
     * back by whoever left it.
     */
    const live = new Set();
    for (const sender of senders) {
      try {
        /* A reaction taken back does NOT leave unreadSenders. WhatsApp keeps the
           sender there and blanks the text -- REVOKED_REACTION_TEXT is the empty
           string, read from WAWebReactionsBEUtils rather than assumed -- so a
           seat counted live on the strength of the sender alone was a banner
           nothing would ever take down. The text is what says a reaction is
           still there. */
        if (!String(sender.reactionText || '').trim()) continue;
        live.add(parentKey + '|' + widOf(sender.senderUserJid));
      } catch (e) {}
    }
    for (const [seat, emoji] of [...reacted]) {
      if (!seat.startsWith(parentKey + '|') || live.has(seat)) continue;
      reacted.delete(seat);
      send('store-gone', { msg: 'reaction' + SEP + seat + SEP + emoji, chat: chatId });
    }


    if (Date.now() - liveAt < SETTLE_MS) return;

    /* WhatsApp's own switch for exactly this, which this client could not see
       until it was asked for it. It is granular: a group has its own answer,
       under Settings -> Notifications -> Groups, and it was off on this account
       while the one under Messages was on. */
    const chat = chatOf(row.id.remote);
    if (!chat) return;
    if (!wanted(chat) || !reactionsWanted(chat)) return;
    if (isMuted(chat)) return;
    if (onScreen(chat)) return;
    if (!senders.length) return;

    /* What was reacted TO, which is the half the phone shows and this did not.
       A reaction on a photo says so rather than quoting nothing. */
    let about = '';
    try {
      const parent = S.msgs.get(row.id);
      if (parent) {
        const mark = markOf(parent);
        const said = textOf(parent);
        about = said || (mark || '');
        if (about.length > REACTION_ABOUT_MAX) about = about.slice(0, REACTION_ABOUT_MAX) + '…';
      }
    } catch (e) {}

    const group = isGroup(chat);
    for (const sender of senders) {
      let who, emoji;
      try {
        who = widOf(sender.senderUserJid);
        emoji = String(sender.reactionText || '').trim();
      } catch (e) { continue; }
      if (!who || !emoji) continue;
      const seat = parentKey + '|' + who;
      if (reacted.get(seat) === emoji) continue;
      reacted.set(seat, emoji);
      if (reacted.size > 256) reacted.delete(reacted.keys().next().value);

      /* "Mega reacted 😂 to: ..." -- the person, then what they did, then the
         message they did it to, which is the order the phone writes it in and
         the order it was asked for. The name is not followed by a colon here:
         a colon after a name reads as that person having SAID what follows, and
         what follows is this client describing what they did. */
      const said = 'reacted ' + emoji + ' to' + (about ? ': ' + about : '');
      send('store-message', {
        msg: 'reaction' + SEP + seat + SEP + emoji,
        chat: chatId,
        title: titleOf(chat),
        sender: group ? nameOf(sender.senderUserJid) : '',
        join: 'space',
        group,
        mark: '',
        text: said,
        redacted: emoji + ' Reaction',
        mention: false,
        muted: false,
        avatar: await pictureFor(chat),
        why: 'reaction',
      });
    }
  };

  /* ------------------------------------------------------------ the counter */

  /* The number on the icon, counted the way the phone counts it: messages, not
     conversations, and a muted chat contributes only the mentions inside it --
     because a badge counts what the user was told about, and a muted chat is one
     they asked not to be told about. */
  let countTimer = 0;
  let lastCount = '';
  const recount = () => {
    if (countTimer) return;
    countTimer = setTimeout(() => {
      countTimer = 0;
      if (!S) return;
      let messages = 0, chats = 0;
      try {
        for (const chat of S.chats.getModelsArray()) {
          const waiting = Number(chat.unreadCount) || 0;
          if (waiting <= 0) continue;
          if (isMuted(chat)) {
            const mentions = Number(chat.unreadMentionCount) || 0;
            if (mentions > 0) { messages += mentions; chats++; }
            continue;
          }
          messages += waiting;
          chats++;
        }
      } catch (e) { return; }
      const key = chats + ':' + messages;
      if (key === lastCount) return;
      lastCount = key;
      send('store-count', { chats, messages });
    }, 250);
  };

  /* ---------------------------------------------------------------- wiring */

  const wire = () => {
    const { chats, msgs, reactions } = S;

    msgs.on('add', msg => { arrived(msg, 'add'); calling(msg); });

    /* Two things arrive on this one. A message that has just decrypted, which is
       an arrival that was held; and a message deleted for everyone, which is a
       banner that has to come down -- and NOT a banner of its own. The phone
       withdraws the notification for a message that is taken back; it does not
       raise a second one saying so. */
    /* The last reaction on a message going away, which nothing else reports. */
    msgs.on('change:hasReaction', (msg, has) => { if (!has) reactionsGone(msg); });

    msgs.on('change:type', (msg, type) => {
      let id = '';
      try { id = keyOf(msg.id); } catch (e) { return; }
      if (!id) return;
      if (type === 'revoked') {
        send('store-gone', { msg: id, chat: widOf(msg.id.remote) });
        return;
      }
      if (pending.has(id)) { pending.delete(id); arrived(msg, 'decrypted'); }
    });

    /* A call, asked again once it has stopped ringing.
     *
     * WhatsApp writes the call into the chat the moment the offer arrives and
     * writes the outcome onto that same message when it is over, so the `add`
     * above meets a call with nothing to say about it yet. There is no
     * change:<attribute> to wait for that is worth naming here -- the outcome
     * reaches the message through more than one field and they are private
     * names -- so this listens for the message changing at all and asks the same
     * question again. Every model event is re-triggered on the collection:
     * WhatsApp binds `all` on each model it holds and passes the event straight
     * through, which is how change:hasReaction above arrives too.
     *
     * The type check in front is the whole cost for every other message that
     * changes, and `announced` keeps a call that changes twice to one banner. */
    msgs.on('change', msg => {
      try { if (!msg || msg.type !== CALL) return; } catch (e) { return; }
      /* The ringing banner first, so it is on its way down before the banner for
         the call that was missed goes up in its place. */
      calling(msg);
      arrived(msg, 'call');
    });

    /* Read -- here, or on the phone, or on another desktop. One event, no
       inference, and measured at 16ms behind the arrival it cancels. */
    chats.on('change:unreadCount', (chat, unread) => {
      const id = widOf(chat && chat.id);
      if (!id) return;
      send('store-read', { chat: id, unread: Number(unread) || 0 });
      recount();
    });
    chats.on('change:unreadMentionCount', recount);
    chats.on('change:mute.expiration', recount);

    /* The conversation on screen, as WhatsApp itself understands it. This
       replaces reading aria-selected off the list, which was a beat late in both
       directions -- and being late on the way OUT is what left a chat "still
       open" after the user had closed it, so the next message in it was
       swallowed. */
    chats.on('change:active', (chat, active) => {
      if (!active) {
        /* Which chat became active is what matters; a chat going inactive is
           either a close or the other half of a switch, and the switch reports
           the new one in the same turn. */
        send('store-active', { chat: '', was: widOf(chat && chat.id) });
        return;
      }
      send('store-active', { chat: widOf(chat && chat.id) });
    });

    if (reactions && typeof reactions.on === 'function') {
      /* Three events and one handler, because all three ask the same question:
         which of this message's reactions is the user still owed a banner for.
         `remove` is the row going away entirely -- the last reaction on a
         message taken back -- and it has to withdraw as surely as a change
         that empties unreadSenders does. */
      reactions.on('add', row => { reaction(row); });
      reactions.on('change', row => { reaction(row); });
      reactions.on('remove', row => { reaction(row); });
    } else {
      log('the reactions collection is not where it was; reactions will not be announced');
    }

    if (!S.getters || !S.outcomes) {
      log('WhatsApp\'s call getters are not where they were; missed calls will not be announced');
    }

    recount();
  };

  /* ------------------------------------------------------------ the outside */

  /* Opening a conversation, asked of WhatsApp rather than driven through its
     interface. A click on a banner used to press the deepest node inside a
     chat-list row -- which works, and which needs the row to still be in the
     list and the name to be unambiguous. The chat id is neither. */
  const open = chatId => {
    if (!S || !S.cmd) return false;
    const chat = chatOf(chatId);
    if (!chat) return false;
    for (const method of ['openChatBottom', 'openChatAt']) {
      try {
        if (typeof S.cmd[method] !== 'function') continue;
        S.cmd[method]({ chat });
        return true;
      } catch (e) {}
    }
    return false;
  };

  /* Which chat is open right now, asked rather than remembered -- the app wants
     this again whenever the window comes back, and nothing about the chat itself
     changes to say so. */
  /* Said again on the way back, unchanged though it is.
   *
   * change:active fires when the open conversation CHANGES, and a window coming
   * out of the tray onto the conversation it was already showing changes
   * nothing -- so nothing fired, and nothing was withdrawn. A message survived
   * that because reading it moves the unread count, which has its own event; a
   * reaction has neither, and that is the whole of "I clicked one and the rest
   * stayed there". It is only now, with the window back, that the chat on
   * screen is being read. */
  const sayActive = () => { send('store-active', { chat: activeChat() }); };

  const activeChat = () => {
    if (!S) return '';
    try {
      const chat = S.chats.getActive && S.chats.getActive();
      return chat ? widOf(chat.id) : '';
    } catch (e) { return ''; }
  };

  /* Every chat that still has something waiting, so the app can take down what
     is no longer unread after a spell where it was not listening -- a laptop
     coming out of suspend, or a socket that dropped. */
  const unreadNow = () => {
    if (!S) return null;
    const out = {};
    try {
      for (const chat of S.chats.getModelsArray()) {
        const waiting = Number(chat.unreadCount) || 0;
        if (waiting > 0) out[widOf(chat.id)] = waiting;
      }
    } catch (e) { return null; }
    return out;
  };

  /* ---------------------------------------------------------------- start */

  let waited = 0;
  const attempt = () => {
    S = resolve();
    if (!S) {
      waited += POLL_MS;
      if (waited >= WAIT_MS) {
        log('WhatsApp\'s own store never appeared; the chat list watcher stays in charge');
        send('store-ready', { ready: false });
        return;
      }
      setTimeout(attempt, POLL_MS);
      return;
    }
    liveAt = Date.now();
    try { wire(); } catch (e) {
      S = null;
      log('could not listen to WhatsApp\'s store: ' + e.message);
      send('store-ready', { ready: false });
      return;
    }
    log('reading arrivals and read state from WhatsApp\'s own store (' +
        S.chats.length + ' chats)');
    send('store-ready', { ready: true });
    /* And the answer to the two standing questions, once, so the app does not
       start out believing the wrong thing about either. */
    send('store-active', { chat: activeChat() });
    send('store-unread', unreadNow());
  };

  setTimeout(attempt, POLL_MS);

  return {
    get ready() { return !!S; },
    open,
    activeChat,
    unreadNow,
    setFocus: value => {
      const was = focused;
      focused = !!value;
      if (S && focused && !was) sayActive();
    },
    setEnabled: value => { enabled = !!value; },
  };
};

module.exports = { start, KINDS };
