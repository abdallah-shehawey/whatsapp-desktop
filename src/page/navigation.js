'use strict';

/* The rail and the conversation have separate lifetimes. Closing a chat must
 * also clear the rail's restore target; hiding it behind another tab must not.
 * Read the selected rail button rather than inferring a tab from #main. */
const start = ({ press, log, prepareChat = () => {}, window: view = window }) => {
  const doc = view.document;
  const RAIL = '[data-testid="chatlist-header"]';
  const LEFT = '[data-testid="drawer-left"] > div > span > div';
  const PANELS = LEFT + ', [data-testid="drawer-middle"] > div > span > div';
  const BODY = '[data-testid="conversation-panel-body"]';
  const MESSAGES = '[data-testid="conversation-panel-messages"], [data-tab="conversation-panel-messages"]';
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
  const CHAT_ICON = /^(?:wds-ic-chat|chat)(?:-filled)?$/;
  let previous = null;
  let leavingChats = false;
  let departure = 0;
  let chatCollection = null;
  let chatMotions = [];
  let pendingChat = null;
  let requestedSection = null;
  let listMotion = null;
  let pendingList = false;
  let sectionGeneration = 0;
  let restoreHooked = false;
  let updateQueued = false;
  const stillness = typeof view.matchMedia === 'function'
    ? view.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const panels = new Map();
  const preparing = new Set();
  const grab = name => {
    try { return typeof view.require === 'function' ? view.require(name) : null; }
    catch (err) { return null; }
  };
  const rail = () => {
    const root = doc.querySelector(RAIL);
    if (!root) return null;
    const buttons = [...root.querySelectorAll('button[aria-pressed]')];
    const chats = buttons.find(button => [...button.querySelectorAll('svg title')]
      .some(title => CHAT_ICON.test(title.textContent.trim())));
    const selected = buttons.find(button => button.getAttribute('aria-pressed') === 'true');
    return chats && selected ? { chats, selected, root } : null;
  };
  const visible = element => {
    if (element.closest?.('[data-wa-navigation-panel="inactive"]')) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0;
  };
  const layerIsUp = state => {
    const meList = doc.querySelector('[data-testid="me-tab-drawer"] [role="listbox"]');
    for (const el of doc.querySelectorAll(
      '[role="menu"], [role="listbox"], [role="application"], [role="dialog"], [data-testid="drawer-right"]'))
      if (el !== meList && visible(el)) return true;
    /* A nested settings page or community detail keeps its own Back button.
       One Escape goes to that page, leaving the selected rail tab in place. */
    const panel = doc.querySelector(LEFT);
    if (panel && !panel.closest?.('[data-wa-navigation-panel="inactive"]')) {
      for (const title of panel.querySelectorAll('header svg title'))
        if (/^(?:ic-arrow-back|wds-ic-arrow-back|back)$/.test(title.textContent.trim())) return true;
    }
    /* Photo/status viewers need Escape themselves. They cover the rail even
       when they carry none of the usual dialog roles. */
    const rect = state.chats.getBoundingClientRect();
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!top && !state.chats.contains(top);
  };
  const forgetClosedChat = () => {
    sectionGeneration++;
    const activity = grab('WAWebSideNavButtonsActivityModel');
    const restore = grab('WAWebOpenLastActiveChatAction');
    try {
      if (typeof activity?.setLastActiveChat === 'function') activity.setLastActiveChat(null);
      if (typeof restore?.cancelPendingLastActiveChatRestore === 'function')
        restore.cancelPendingLastActiveChatRestore();
    } catch (err) { log('could not clear the closed chat restore target: ' + err.message); }
  };
  const activeId = () => {
    if (!chatCollection) chatCollection = grab('WAWebChatCollection')?.ChatCollection || null;
    try { return chatCollection?.getActive?.()?.id?.toString() || ''; }
    catch (err) { return ''; }
  };
  const reducedMotion = () => !!stillness?.matches;
  const motion = (element, frames, duration, easing = EASE) => {
    if (!element || reducedMotion() || typeof element.animate !== 'function') return null;
    try {
      const animation = element.animate(frames, { duration, easing });
      /* Raster the newly mounted content at its first keyframe before starting
         the clock. Otherwise the first native layout/paint can consume most
         of a short reveal, which makes it appear to jump to the end. */
      if (typeof animation.pause === 'function' && typeof view.requestAnimationFrame === 'function') {
        animation.pause();
        preparing.add(animation);
        view.requestAnimationFrame(() => {
          preparing.delete(animation);
          if (animation.playState !== 'paused') return;
          if (!element.isConnected || reducedMotion() || doc.visibilityState === 'hidden')
            animation.cancel();
          else animation.play();
        });
      }
      return animation;
    } catch (err) { return null; /* A build without Web Animations still opens. */ }
  };
  const reveal = (element, offset, opacity, duration) => motion(element,
    [{ transform: `translate3d(0, ${offset}px, 0)`, opacity },
     { transform: 'none', opacity: 1 }], duration);
  const deferChatRestore = () => {
    if (restoreHooked || typeof view.requestAnimationFrame !== 'function') return;
    const restore = grab('WAWebOpenLastActiveChatAction');
    const original = restore?.openLastActiveChatIfNotLocked;
    if (typeof original !== 'function') return;
    /* The native tab handler restores the conversation in the same task as
       the tab change. Give the list's compositor reveal a painted first frame
       before rebuilding messages. Keep native lock/restore checks intact. */
    restore.openLastActiveChatIfNotLocked = function (...args) {
      const state = rail();
      if (!state || (requestedSection !== state.chats &&
          !(state.selected === state.chats && previous && !previous.chats)))
        return original.apply(this, args);
      const generation = sectionGeneration;
      return new Promise((resolve, reject) => {
        view.requestAnimationFrame(() => view.setTimeout(() => {
          const current = rail();
          if (generation !== sectionGeneration || !current || current.selected !== current.chats) {
            resolve(); return;
          }
          try { resolve(original.apply(this, args)); }
          catch (err) { reject(err); }
        }, 0));
      });
    };
    restoreHooked = true;
  };
  const cancelChatMotion = () => {
    for (const animation of chatMotions) animation.cancel();
    chatMotions = [];
  };
  const animateChat = (main, switching) => {
    cancelChatMotion();
    if (!switching) {
      /* Preserve the first entrance's lateral motion without making a new GPU
         surface out of the whole frame and wallpaper. The messages already
         have a compositor layer for scrolling; reuse it and move the small
         header/composer contents with it. */
      const offset = doc.documentElement?.getAttribute('dir') === 'rtl' ? -14 : 14;
      chatMotions = [main.querySelector(MESSAGES) || main.querySelector(BODY),
        main.querySelector('header > div'), main.querySelector('footer > div')]
        .map(element => motion(element,
          [{ transform: `translate3d(${offset}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }],
          220, 'cubic-bezier(0.2, 0.8, 0.2, 1)')).filter(Boolean);
      return;
    }
    /* A chat swap replaces #main in some builds and reuses it in others. Only
       the newly committed messages and identity move in either case. No
       delayed callbacks or copies of an old chat survive a rapid switch. */
    chatMotions = [
      reveal(main.querySelector(MESSAGES) || main.querySelector(BODY), 4, 0.85, 160),
      reveal(main.querySelector('header > div'), 2, 0.75, 140),
    ].filter(Boolean);
  };
  const changeSection = (button, state) => {
    if (button === state.selected) return;
    sectionGeneration++;
    requestedSection = button;
    pendingList = button === state.chats;
    if (listMotion) { listMotion.cancel(); listMotion = null; }
    for (const [panel, record] of panels) {
      panel.setAttribute('data-wa-navigation-panel', 'inactive');
      record.active = false;
      if (record.animation) { record.animation.cancel(); record.animation = null; }
    }
  };
  const animateSections = state => {
    if (requestedSection === state.selected) requestedSection = null;
    const destination = requestedSection || state.selected;
    for (const [panel, record] of panels) {
      if (!panel.isConnected) {
        if (record.animation) record.animation.cancel();
        panels.delete(panel);
      } else if (record.active && record.owner !== destination) {
        panel.setAttribute('data-wa-navigation-panel', 'inactive');
        record.active = false;
        if (record.animation) { record.animation.cancel(); record.animation = null; }
      }
    }
    if (destination === state.chats) return;
    const fronts = new Set();
    for (const panel of doc.querySelectorAll(PANELS)) {
      const group = panel.closest?.('[data-testid="drawer-left"], [data-testid="drawer-middle"]') || panel.parentElement;
      let record = panels.get(panel);
      if (record && record.owner !== destination) continue;
      /* The newest wrapper comes first, including nested You > Profile pages.
         Those keep the same selected rail button. Retire siblings by drawer,
         rather than only when the rail selection changes, before either can
         paint over the other. An empty incoming wrapper holds the surface
         while its content is being prepared. */
      if (fronts.has(group)) {
        if (!record) {
          panel.setAttribute('data-wa-navigation-panel', 'inactive');
          panels.set(panel, { owner: destination, group, active: false, content: null, page: null, animation: null });
        }
        continue;
      }
      fronts.add(group);
      if (!record || !record.active) {
        for (const [old, retiring] of panels) {
          if (old === panel || retiring.group !== group || !retiring.active) continue;
          old.setAttribute('data-wa-navigation-panel', 'inactive');
          retiring.active = false;
          if (retiring.animation) { retiring.animation.cancel(); retiring.animation = null; }
        }
        panel.setAttribute('data-wa-navigation-panel', 'active');
        record = { owner: destination, group, active: true, content: null, page: null, animation: null };
        panels.set(panel, record);
      }
      const content = panel.firstElementChild;
      const page = panel.querySelector?.('[data-testid]') || content;
      if (!content || (content === record.content && page === record.page)) continue;
      /* Velocity fades the OUTER wrapper on the main thread, even after a
         new section has mounted above it. The stylesheet holds that wrapper
         steady; one compositor animation on its child owns the reveal. */
      if (record.animation) record.animation.cancel();
      record.content = content;
      record.page = page;
      /* The large welcome/empty surface beside a tab stays steady. Promoting
         that background as a second reveal adds raster work to the list. */
      if (page.matches?.('[data-testid="empty-state-drawer"], [data-testid="intro-panel"]')) continue;
      record.animation = reveal(content, 8, 0, 220);
    }
  };
  const mediaCloseButton = () => {
    const media = doc.querySelector('[data-testid="media-hub-modal"]');
    if (!media || !visible(media)) return null;
    for (const el of doc.querySelectorAll('[role="menu"], [role="listbox"], [role="dialog"]'))
      if (!el.contains(media) && visible(el)) return null;
    if (media.querySelector('input[type="checkbox"], [role="checkbox"], input[type="search"], input[type="text"]')) return null;
    const rect = media.getBoundingClientRect();
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (top && !media.contains(top)) return null;
    const buttons = [...media.querySelectorAll('button, [role="button"]')]
      .filter(button => [...button.querySelectorAll('svg title')]
        .some(title => /^(?:ic-close|wds-ic-close|x)$/.test(title.textContent.trim())));
    return buttons.length === 1 ? buttons[0] : null;
  };
  const update = () => {
    const state = rail();
    if (!state) return;
    deferChatRestore();
    const main = doc.querySelector('#main');
    const chats = state.selected === state.chats;
    const id = main ? activeId() : '';
    const messages = main?.querySelector(MESSAGES);
    const contentKey = messages?.querySelector?.('[data-id]')?.getAttribute('data-id') || '';
    animateSections(state);
    if (chats && !main && !leavingChats &&
        (!previous || (previous.chats && previous.main))) forgetClosedChat();
    if (chats && previous && !previous.chats && !requestedSection) pendingList = true;
    const list = chats && !requestedSection && pendingList &&
      (doc.querySelector('#side') || doc.querySelector('#pane-side'));
    if (list && list.firstElementChild) {
      if (listMotion) listMotion.cancel();
      listMotion = reveal(list, 8, 0, 220);
      pendingList = false;
    }
    if (main && (!previous?.main || (id && id !== previous?.id) ||
        (!id && main !== previous?.main))) {
      cancelChatMotion();
      pendingChat = { main, switching: !!(previous?.chats && previous.main),
        fromKey: previous?.contentKey || '' };
    } else if (pendingChat && main) pendingChat.main = main;
    else if (main && main !== previous?.main) prepareChat(main);
    /* The active model changes before React replaces the old conversation.
       Wait for its message identity to change, and don't replay when the same
       chat later replaces #main while filling its virtualised history. */
    if (pendingChat?.main === main && main?.querySelector(BODY) &&
        (!pendingChat.switching || !pendingChat.fromKey || contentKey !== pendingChat.fromKey)) {
      prepareChat(main);
      animateChat(main, pendingChat.switching);
      pendingChat = null;
    }
    if (!main) { cancelChatMotion(); pendingChat = null; }
    if (!chats) leavingChats = false;
    previous = { chats, main, id, contentKey };
  };
  view.addEventListener('click', event => {
    const state = rail();
    const button = event.target?.closest?.('button[aria-pressed]');
    if (!state || !button || !state.root.contains(button)) return;
    changeSection(button, state);
    if (state.selected === state.chats && button !== state.chats) {
      /* The native click closes the chat before updating aria-pressed. Keep
         that intermediate DOM commit from looking like a manual Close chat. */
      leavingChats = true;
      const mine = ++departure;
      view.setTimeout(() => {
        if (mine === departure) { leavingChats = false; update(); }
      }, 1000);
    }
  }, true);
  view.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.repeat || event.isComposing ||
        event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    const mediaButton = mediaCloseButton();
    const state = rail();
    if (!mediaButton && (!state || state.selected === state.chats || layerIsUp(state))) return;
    /* The section's own capture handler can prevent Escape and do nothing on
       its first press. Handle this at document-start, ahead of that handler. */
    event.preventDefault();
    event.stopImmediatePropagation();
    const button = mediaButton || state.chats;
    if (!mediaButton) changeSection(button, state);
    let target = button;
    while (target.firstElementChild) target = target.firstElementChild;
    press(button, target);
  }, true);
  view.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'hidden') return;
    for (const animation of preparing) animation.cancel();
    preparing.clear();
  });
  const scheduleUpdate = () => {
    if (updateQueued) return;
    if (typeof view.requestAnimationFrame !== 'function') { update(); return; }
    updateQueued = true;
    view.requestAnimationFrame(() => {
      updateQueued = false;
      update();
    });
  };
  const observer = new view.MutationObserver(records => {
    /* Closing is a navigation decision, not animation work. Clear its restore
       target in the removal microtask, before a fast tab change can restore
       the closed chat while the visual reconciliation waits for paint. */
    if (previous?.chats && previous.main && !leavingChats && records?.some(record =>
      [...(record.removedNodes || [])].some(node => node === previous.main || node.contains?.(previous.main))) &&
        !doc.querySelector('#main')) {
      const state = rail();
      if (state && state.selected === state.chats) {
        forgetClosedChat();
        cancelChatMotion();
        pendingChat = null;
        previous = { ...previous, main: null, id: '', contentKey: '' };
      }
    }
    /* Message text, ticks, and list previews cannot change the selected tab or
       mount a conversation. Avoid scanning every drawer for those updates.
       A pending conversation still needs its first content commit. */
    if (!pendingChat && !pendingList && records?.length && records.every(record =>
      record.target?.closest?.(MESSAGES + ', #pane-side')))
      return;
    /* React can commit the rail, drawers and conversation in separate batches.
       Reconcile once before paint, after those commits, rather than starting
       an animation in each microtask while the new page is still being built. */
    scheduleUpdate();
  });
  /* The parser can replace the document-start html element. Watching the
     document also covers that replacement and the first conversation mount. */
  observer.observe(doc, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'],
  });
  update();
};

module.exports = { start };
