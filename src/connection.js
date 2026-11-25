/* Keep a local page visible while WhatsApp is unreachable. Retrying in the
 * background avoids replacing it with Chromium's empty network-error page.
 *
 * Only then. Startup used to paint this page first, as "Connecting to
 * WhatsApp", and load WhatsApp behind it -- so every start online flashed it
 * for most of a second (measured, 0.8s cold) before WhatsApp's own loading
 * screen, which says the same thing in WhatsApp's own way. A failed load
 * still lands here: did-fail-load is what brings it up, from startup as from
 * anywhere else. From here WhatsApp is asked for again the moment the page
 * hears the desktop come online, and every two seconds besides.
 *
 * And a load that did not fail is not the same as a WhatsApp that came up.
 * The client starts with the session, and on a laptop whose Wi-Fi joins only
 * once the keyring is open that is always before the network: the page fails,
 * this page waits, and the network then arrives in pieces -- an address, a
 * route, DNS, IPv6 a moment later, each one a network change that Chromium
 * answers by dropping what is in flight. The retry lands in the middle of
 * that. WhatsApp's own document loads, its scripts and sheets from
 * static.whatsapp.net fail with ERR_NETWORK_CHANGED or ERR_NAME_NOT_RESOLVED,
 * and its loader gives up after two quick retries. What is left is a page
 * with no app in it, which nothing reloads: did-fail-load never fired, so as
 * far as this file knew WhatsApp was up. Reproduced by failing those requests
 * for the first eight seconds of a load: still the bare startup shell 75s
 * later, with the network long back. The owner saw it as an empty window
 * after every boot, put right only by Ctrl+R.
 *
 * So the boot of each WhatsApp document is watched. A script or sheet of its
 * own lost to the network while it boots marks it broken. The request that
 * failed is then tried again every two seconds, and the moment it gets an
 * answer WhatsApp is loaded afresh -- unless WhatsApp has meanwhile fetched it
 * itself, or its store has said it is up. Reloads in a row are spaced 2s, 4s,
 * 8s apart and so on up to a minute, for a network that answers the check and
 * still drops the page. Only the network failing WhatsApp's own scripts asks
 * for any of this: a WhatsApp broken in some other way is left alone.
 *
 * And a load can do neither. On the owner's own profile -- signed in, with
 * WhatsApp's service worker registered -- the first navigation after an
 * unclean exit (a shutdown, a logout, a kill) started offline and then simply
 * waited: no commit, no failure, no document at all, so the window showed
 * nothing but its own background colour. Measured: the network answered every
 * check from 18 s on, and the navigation was still waiting at 81 s. Nothing
 * else ever asked again, because nothing had failed. Stopping it and asking
 * once more committed in 0.7 s -- the Ctrl+R that put it right by hand. So a
 * WhatsApp navigation that has not committed after 8 s is checked: if the
 * network answers, it is stuck and is asked for again; if not, this page goes
 * up and the retries above take over. The wait doubles for each stall in a
 * row, so a network that is merely slow gets more time. */
'use strict';

const { pathToFileURL } = require('url');

/* The network letting a request down, as opposed to the page, a policy or the
 * client turning it away. Only these say a second try could go differently. */
const NETWORK_ERROR = /^net::ERR_(INTERNET_DISCONNECTED|NETWORK_|NAME_|CONNECTION_|TIMED_OUT|ADDRESS_|EMPTY_RESPONSE|SOCKET_|PROXY_|TUNNEL_|QUIC_|HTTP2_)/;
/* What WhatsApp is made of: the scripts and sheets of its own two hosts. A
 * blocked tracker elsewhere is not a WhatsApp that failed to come up. */
const BOOT_HOSTS = new Set(['web.whatsapp.com', 'static.whatsapp.net']);
const BOOT_TYPES = new Set(['script', 'stylesheet']);

const attach = (win, { url, file, ipcMain, probe, retryMs = 2000, bootMs = 30000,
                       gapMs = 2000, maxGapMs = 60000, stallMs = 8000, now = Date.now }) => {
  const contents = win.webContents;
  const localURL = pathToFileURL(file).href;
  const origin = new URL(url).origin;
  const isLocal = value => String(value || contents.getURL()).split('?')[0] === localURL;
  const isRemote = value => { try { return new URL(value).origin === origin; } catch (err) { return false; } };
  /* What the main frame holds. Chromium commits its own error page in place of
   * a failed load, under the failed URL -- so getURL() answers WhatsApp's
   * address for an empty page -- and that page finishes loading like any
   * other. Measured on the owner's display: its did-finish-load arrives before
   * this page commits, and main.js took it for WhatsApp and set about styling
   * it. 'remote' is a WhatsApp document, 'local' this page, 'error' Chromium's. */
  let holding = null;
  let offline = false;
  let timer = null;
  let checking = null;
  /* Asks for this page again, should the failed load's own page outlast it. */
  let reasserts = 0;
  /* The boot of the WhatsApp document in the window, and what it lost. */
  let booting = false;
  let bootTimer = null;
  const lost = new Set();
  let lostAt = 0;
  let rescueTimer = null;
  let rescuing = null;
  let rescues = 0;
  /* A WhatsApp navigation that has neither committed nor failed yet. */
  let pending = null;
  let pendingAt = 0;
  let stallTimer = null;
  let stallCheck = null;
  let stalls = 0;

  const alive = () => !win.isDestroyed() && !contents.isDestroyed();
  const showLocal = () => win.loadFile(file).catch(() => {}); // settles with the error page's load too
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (checking) checking.abort();
    checking = null;
    offline = false;
  };
  const schedule = () => {
    if (offline && alive() && !timer) timer = setTimeout(retry, retryMs);
  };
  const state = busy => {
    if (alive() && isLocal()) contents.send('wa:connection-check', busy);
  };
  const retry = async () => {
    if (!offline || !alive() || checking) return;
    clearTimeout(timer);
    timer = null;
    const controller = new AbortController();
    checking = controller;
    state(true);
    try {
      const reachable = await probe(controller.signal);
      if (checking !== controller || !offline || !alive()) return;
      if (reachable) {
        stop();
        win.loadURL(url).catch(() => {}); // did-fail-load restores the local page
      }
    } catch (err) {
      // Still offline, or the window navigated/closed while checking.
    } finally {
      if (checking === controller) {
        checking = null;
        state(false);
        schedule();
      }
    }
  };

  const endBoot = () => {
    clearTimeout(bootTimer);
    bootTimer = null;
    booting = false;
  };
  const recovered = () => {
    clearTimeout(rescueTimer);
    rescueTimer = null;
    if (rescuing) rescuing.abort();
    rescuing = null;
    lost.clear();
  };
  const forget = () => {
    endBoot();
    recovered();
  };
  /* The earliest the next reload may go, counted from the first loss. */
  const due = () => lostAt + Math.min(gapMs * 2 ** rescues, maxGapMs);
  const rescueSoon = delay => {
    clearTimeout(rescueTimer);
    rescueTimer = setTimeout(rescue, Math.max(0, delay));
  };
  const rescue = async () => {
    rescueTimer = null;
    if (!lost.size || holding !== 'remote' || !alive() || rescuing) return;
    if (now() < due()) { rescueSoon(due() - now()); return; }
    const controller = new AbortController();
    rescuing = controller;
    let reachable = false;
    try { reachable = await probe(controller.signal, lost.values().next().value); } catch (err) { /* not yet */ }
    if (rescuing !== controller) return; // the page moved on, or WhatsApp came up
    rescuing = null;
    if (!lost.size || holding !== 'remote' || !alive()) return;
    if (!reachable) { rescueSoon(retryMs); return; }
    rescues++;
    console.warn('WhatsApp lost part of itself to the network while it started; loading it again (%d)', rescues);
    forget();
    win.loadURL(url).catch(() => {}); // did-fail-load brings up the local page
  };

  const goOffline = () => {
    stop();
    forget();
    offline = true;
    reasserts = 0;
    contents.setBackgroundThrottling(true);
    showLocal();
    schedule();
  };
  const settle = () => {
    clearTimeout(stallTimer);
    stallTimer = null;
    if (stallCheck) stallCheck.abort();
    stallCheck = null;
    pending = null;
  };
  const stalled = async () => {
    stallTimer = null;
    if (!pending || !alive() || !contents.isLoading() || stallCheck) return;
    const target = pending;
    const controller = new AbortController();
    stallCheck = controller;
    let reachable = false;
    try { reachable = await probe(controller.signal); } catch (err) { /* offline */ }
    if (stallCheck !== controller || pending !== target || !alive()) return;
    settle();
    stalls++;
    contents.stop();
    if (reachable) {
      console.warn('WhatsApp\'s page neither loaded nor failed while the network answers; asking again (%d)', stalls);
      win.loadURL(target).catch(() => {}); // did-fail-load brings up the local page
    } else {
      console.warn('WhatsApp\'s page neither loaded nor failed, and the network does not answer; showing the connection page');
      goOffline();
    }
  };
  const started = (event, startedURL, isInPlace, isMainFrame) => {
    if (!isMainFrame || isInPlace) return;
    settle();
    if (!isRemote(startedURL)) return;
    pending = startedURL;
    pendingAt = now();
    stallTimer = setTimeout(stalled, Math.min(stallMs * 2 ** stalls, maxGapMs));
  };

  const failed = (event, code, description, failedURL, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isRemote(failedURL)) return;
    console.warn('load failed (%d %s); showing the connection page', code, description);
    settle();
    holding = 'error';
    goOffline();
  };
  const navigated = (event, destination) => {
    settle();
    if (isLocal(destination)) {
      holding = 'local';
      return;
    }
    stop();
    forget();
    holding = isRemote(destination) ? 'remote' : 'other';
    if (holding !== 'remote') return;
    stalls = 0;
    booting = true;
    bootTimer = setTimeout(() => {
      endBoot();
      if (!lost.size) rescues = 0; // a clean start: the count is for reloads in a row
    }, bootMs);
  };
  const settled = () => {
    if (offline && holding !== 'local' && alive() && reasserts < 2) {
      reasserts++;
      console.warn('the connection page did not stay up; asking for it again');
      showLocal();
    }
  };
  const requested = event => {
    if (event.sender === contents && event.senderFrame?.url && isLocal(event.senderFrame.url) && isLocal()) retry();
  };
  contents.on('did-start-navigation', started);
  contents.on('did-fail-load', failed);
  contents.on('did-navigate', navigated);
  contents.on('did-stop-loading', settled);
  ipcMain.on('wa:connection-retry', requested);
  contents.once('destroyed', () => {
    stop();
    forget();
    settle();
    ipcMain.removeListener('wa:connection-retry', requested);
  });

  return {
    isLocal: () => isLocal(),
    /* A WhatsApp document, as opposed to this page or Chromium's error page. */
    isWhatsApp: () => holding === 'remote',
    start: () => win.loadURL(url).catch(() => {}), // did-fail-load brings up the local page
    /* Something worth trying again for at once -- the machine woke, the window opened. */
    retryNow: () => {
      if (offline) retry();
      else if (lost.size && !rescuing) rescueSoon(0);
      /* Opened onto an empty window: a navigation already this old is checked now. */
      else if (pending && stallTimer && now() - pendingAt >= 3000) { clearTimeout(stallTimer); stalled(); }
    },
    /* A request of the window's own that failed (session.webRequest's details). */
    resourceFailed: ({ url: failedURL, resourceType, error }) => {
      if (!booting || holding !== 'remote' || !BOOT_TYPES.has(resourceType) || !NETWORK_ERROR.test(error || '')) return;
      let host = '';
      try { host = new URL(failedURL).hostname; } catch (err) { return; }
      if (!BOOT_HOSTS.has(host)) return;
      if (!lost.size) {
        console.warn('WhatsApp could not load %s (%s) while starting', resourceType, error);
        lostAt = now();
        rescueSoon(due() - lostAt);
      }
      lost.add(failedURL);
    },
    /* One that arrived after all: WhatsApp's own retry got it. */
    resourceLoaded: ({ url: loadedURL }) => {
      if (!lost.delete(loadedURL) || lost.size) return;
      console.warn('WhatsApp fetched what it had lost by itself');
      recovered();
    },
    /* WhatsApp's store answered: whatever it lost on the way, it is up. */
    ready: () => {
      forget();
      rescues = 0;
    },
  };
};

module.exports = { attach, NETWORK_ERROR };
