'use strict';

/*
 * Ctrl+F, which a browser answers with its find bar and which this client
 * answered with nothing at all (issue #11). It searches whatever is on screen:
 *
 *   a conversation  -- its own message search, the panel the magnifier in its
 *                      header opens, with the caret already in the box;
 *   Calls, Channels -- the box at the top of that section, and the same for any
 *                      panel over the chat list that carries one (New chat);
 *   the chat list   -- "Search or start a new chat".
 *
 * Measured on the live client. WhatsApp's own Cmd.chatSearch opens the panel
 * the magnifier opens, and leaves the caret out of its box -- focus sits on
 * a bare div[tabindex=-1] in the drawer, so typing would go nowhere. Asked
 * again with the panel up it leaves the panel up: it does not toggle. A
 * conversation without a magnifier (a channel) has no search to open, and the
 * section's box is the next best thing.
 *
 * A box is taken only while it is the thing on top at its own centre. Every
 * section keeps the chat list mounted underneath it: on Calls the chat list's
 * box measures 391px wide, exactly as when it is showing, and only
 * elementFromPoint tells it apart -- it answers the Calls box there. The same
 * question keeps this off whatever a photo viewer or a menu is covering.
 */

const start = ({ press, log, window: view = window }) => {
  const doc = view.document;
  const SEARCH_ICON = /^(?:wds-ic-search|ic-search|search)$/;
  /* The date-search button, which only the message search panel draws. */
  const PANEL_ICON = /calendar-search/;
  const BOX = 'input[type="text"]';
  /* Where a box may be taken from, in the order they are asked: a panel over
     the chat list, then the chat list itself. */
  const PLACES = ['[data-testid="drawer-left"]', '#side'];
  /* The panel slides in and its box arrives with it; give up after this. */
  const OPEN_MS = 1000;
  /* How long WhatsApp's command is given before the magnifier is pressed
     instead: the command is a private name, and one deploy can empty it. */
  const COMMAND_MS = 300;
  let opening = 0;

  const grab = name => {
    try { return typeof view.require === 'function' ? view.require(name) : null; }
    catch (err) { return null; }
  };
  const titles = el => [...el.querySelectorAll('svg title')].map(title => title.textContent.trim());
  const onTop = el => {
    const rect = el.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const top = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return !!top && (el === top || el.contains(top));
  };
  const boxIn = root => root ? [...root.querySelectorAll(BOX)].find(onTop) || null : null;
  const take = box => {
    box.focus();
    /* A query left from last time is selected, so the next keystroke replaces
       it -- the way a browser's find bar takes Ctrl+F. */
    if (typeof box.select === 'function') box.select();
  };
  const deepestIn = el => {
    let node = el;
    while (node.firstElementChild) node = node.firstElementChild;
    return node;
  };

  const panel = () => {
    const drawer = doc.querySelector('[data-testid="drawer-right"]');
    return drawer && titles(drawer).some(title => PANEL_ICON.test(title)) ? drawer : null;
  };

  const messageSearch = () => {
    const header = doc.querySelector('#main header');
    if (!header) return false;
    const button = [...header.querySelectorAll('button, [role="button"]')]
      .find(el => titles(el).some(title => SEARCH_ICON.test(title)));
    if (!button || !onTop(button)) return false;

    const ready = boxIn(panel());
    if (ready) { take(ready); return true; }

    let pressed = false;
    try {
      const Cmd = grab('WAWebCmd')?.Cmd;
      const chat = grab('WAWebChatCollection')?.ChatCollection?.getActive?.();
      if (typeof Cmd?.chatSearch === 'function' && chat) Cmd.chatSearch(chat);
      else { press(button, deepestIn(button)); pressed = true; }
    } catch (err) {
      press(button, deepestIn(button));
      pressed = true;
    }

    const mine = ++opening;
    const asked = Date.now();
    const wait = () => {
      if (mine !== opening) return;
      const box = boxIn(panel());
      if (box) { take(box); return; }
      if (!pressed && !panel() && Date.now() - asked >= COMMAND_MS) {
        press(button, deepestIn(button));
        pressed = true;
      }
      if (Date.now() - asked < OPEN_MS) view.setTimeout(wait, 16);
      else log('Ctrl+F: the message search did not open');
    };
    wait();
    return true;
  };

  const mediaSearch = () => {
    const button = doc.querySelector('[data-testid="media-hub-modal"] [aria-label="Search"]')
    if (!button || !onTop(button)) return false;

    let pressed = false;
    try {
      const Cmd = grab('WAWebCmd')?.Cmd;
      const chat = grab('WAWebChatCollection')?.ChatCollection?.getActive?.();
      if (typeof Cmd?.chatSearch === 'function' && chat) Cmd.chatSearch(chat);
      else { press(button, deepestIn(button)); pressed = true; }
    } catch (err) {
      press(button, deepestIn(button));
      pressed = true;
    }

    return true;
  };

  const find = () => {
    if (mediaSearch()) return true;
    if (messageSearch()) return true;
    for (const place of PLACES) {
      const box = boxIn(doc.querySelector(place));
      if (box) { ++opening; take(box); return true; }
    }
    return false;
  };

  view.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    /* The letter on a Latin layout, and the same physical key on one that
       types something else there -- ب on an Arabic one. */
    const latin = /^[a-z]$/i.test(event.key || '');
    if (latin ? event.key.toLowerCase() !== 'f' : event.code !== 'KeyF') return;
    if (find()) event.preventDefault();
  }, true);
};

module.exports = { start };
// vim: et ts=2 sw=2 sts=2
