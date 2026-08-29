/*
 * whatsapp-desktop -- WhatsApp Web in a window of its own.
 *
 * It loads web.whatsapp.com, so it is the same client WhatsApp serves to a
 * browser: no reverse-engineered protocol and nothing that puts an account at
 * risk. What the browser will not do is live in the tray, keep the desktop's
 * font, and raise a banner per message that GNOME cannot swallow -- and that is
 * the whole of what this adds.
 */
'use strict';

const { app, BrowserWindow, Menu, session, shell, nativeTheme, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Config } = require('./config.js');
const desktop = require('./desktop.js');
const style = require('./style.js');
const { TrayIcon } = require('./tray.js');
const { Banners, sweepAvatars } = require('./notify.js');
const bidi = require('./bidi.js');
const { kindOf, pushName, readBody, mediaFromWords } = require('./wording.js');
const { SEP } = require('./page/inject.js');
const debug = require('./debug.js');
const sound = require('./sound.js');
const fonts = require('./fonts.js');
const autostart = require('./autostart.js');

const APP_ID = 'io.github.shehawey.whatsapp-desktop';
const URL = 'https://web.whatsapp.com/';
const TITLE = 'WhatsApp';

/* The backlog that syncs in over the first half-minute of a launch rewrites the
   whole chat list, and every row it touches has the shape of an arrival. The
   page-side freshness test catches most of it; this catches the rest. */
const STARTUP_GRACE_MS = 30000;
/* How long after the watcher has spoken the document title stays quiet. The
   title counts unread CHATS and fires on its own clock, so without this the two
   paths announce one message twice. */
const TITLE_FALLBACK_MS = 2000;
/* How long a notification is safe from being withdrawn as "already read". The
   unread pill is drawn a beat after the row moves, so a banner raised in that
   gap would otherwise be taken down by the very next report. */
const ARRIVAL_SETTLE_MS = 4000;

const hidden = process.argv.includes('--hidden');
const config = new Config();

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  const pkg = require('../package.json');
  console.log(`whatsapp-desktop ${pkg.version}`);
  app.exit(0);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: whatsapp-desktop [options]

Options:
  --hidden        Start minimized to the system tray
  -v, --version   Show version number
  -h, --help      Show this help message
`);
  app.exit(0);
}

/* ------------------------------------------------------------------ paths */

/* The state directory keeps the project's own name rather than the product's.
   ~/.local/share/whatsapp belongs to the GTK client this one replaces, and a
   signed-in WebKit session and a signed-in Chromium session have no business
   sharing a directory -- least of all one the user might reinstall the other
   client into. */
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
app.setPath('userData', path.join(dataHome, 'whatsapp-desktop'));
app.setName('WhatsApp');
process.title = 'WhatsApp';

/* Notifications carry the application's desktop file: without it GNOME files
   every banner under "Electron" and draws Electron's icon on it. */
if (process.platform === 'linux') app.setDesktopName(APP_ID + '.desktop');

const iconFile = (size, name) =>
  path.join(__dirname, '..', 'data', 'icons', String(size), name);
const appIcon = iconFile(256, `apps/${APP_ID}.png`);

/* ----------------------------------------------------------------- fonts */

/* The desktop's font is imposed through fontconfig rather than through a user
   stylesheet, because a stylesheet that matches every element is paid for on
   every scroll -- measured at 212ms of blocked main thread against 82ms for the
   same scroll without it.
 *
 * The catch is when. FONTCONFIG_FILE has to be in the environment the process
 * was executed with: fontconfig is read once, early, and setting the variable
 * from here reaches children but not this process -- measured, the running
 * client had no FONTCONFIG_FILE in /proc/self/environ at all and drew the page
 * in Roboto while `fc-match` against the very same config answered PoetsenOne.
 *
 * So the launcher exports it, and this is the belt to that pair of braces: when
 * the variable did not arrive, the config is written and the client restarts
 * itself once into an environment that has it. Guarded by an argument, because
 * a relaunch loop is a worse bug than the wrong font. */
const INHERITED_FONTCONFIG = process.env.FONTCONFIG_FILE;

const configureFonts = () => {
  if (!config.get('view.force-font')) return null;
  const family = config.get('view.font') || desktop.interfaceFont();
  return fonts.configure(family, app.getPath('userData'));
};

const fontConfigFile = configureFonts();
if (fontConfigFile) {
  process.env.FONTCONFIG_FILE = fontConfigFile;
  if (INHERITED_FONTCONFIG !== fontConfigFile && !process.argv.includes('--font-retry')) {
    console.log('restarting once so Chromium reads %s', fontConfigFile);
    app.relaunch({ args: process.argv.slice(1).concat('--font-retry') });
    app.exit(0);
  }
}

/* -------------------------------------------------------------- switches */

/* Wayland natively rather than through XWayland: it is the difference between
   crisp text on a fractional scale and a blurry upscale, and between smooth
   trackpad scrolling and stepped wheel events.
 *
 * Asked of the socket as well as of the session type, and this matters on
 * somebody else's machine rather than on the one it was written on.
 * XDG_SESSION_TYPE is set by the login session and inherited; a client started
 * from anything that does not pass the whole environment on -- a launcher, a
 * systemd unit, a terminal opened inside something else -- sees it missing,
 * falls through to X11, and lands on XWayland. Nothing announces that: the
 * client simply looks softer and scrolls in steps, which is exactly the report
 * this switch exists to prevent. WAYLAND_DISPLAY is set by the compositor
 * itself, so between the two the answer survives the trip. */
const chromiumFeatures = ['MemoryPurgeOnFreezeLimit', 'WebRTCPipeWireCapturer'];
const onWayland = process.env.XDG_SESSION_TYPE === 'wayland' ||
                  !!process.env.WAYLAND_DISPLAY;
if (onWayland) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  chromiumFeatures.push('WaylandWindowDecorations');
}
/* Said out loud, because the difference is one a user reports as "it looks
   blurry" or "it scrolls in steps" and never as "it is on XWayland". */
console.log('display server: %s', onWayland ? 'wayland, natively' : 'x11');
/* WhatsApp Web is one page that stays open for days. Letting Chromium hand
   memory back when it is not being looked at is worth more here than the
   milliseconds it costs to fault it in again. Electron accepts one
   `enable-features` switch, so keep all requested features in one value instead
   of allowing a later append to replace an earlier one. */
app.commandLine.appendSwitch('enable-features', chromiumFeatures.join(','));

/* Scrolling.
 *
 * A browser scrolls a long chat smoothly because its compositor does the work
 * on the GPU. Chromium decides that per driver, from a blocklist that is years
 * out of date on Linux, and when it decides against it every scroll is a
 * software raster of the whole viewport -- which is exactly the "it lags, the
 * browser does not" report. The blocklist is overridden and rasterisation is
 * asked for explicitly.
 *
 * Smooth scrolling itself is a separate thing: it is what turns a wheel notch
 * into an animation instead of a jump, and Chrome ships it on by default while
 * a bare Electron does not. */
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-smooth-scrolling');
/* WebGPU on Linux/Wayland has a broken CreateExternalTexture pipeline for video
   streams, which causes WhatsApp call cameras to render black 1280x720 frames.
   Disabling WebGPU forces WhatsApp to use its reliable WebGL/direct pipeline. */
app.commandLine.appendSwitch('disable-features', 'WebGPU');
app.commandLine.appendSwitch('disable-webgpu');

/* ------------------------------------------------------------ single copy */

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

/* ----------------------------------------------------------------- state */

let win = null;
let settingsWin = null;
let tray = null;
let banners = null;
let quitting = false;
let cssKey = null;
let loadedAt = 0;
let unreadChats = 0;
/* How many messages are waiting, as the page counted them off the unread pills.
   null until it has, which is what makes the document title's chat count a
   stand-in rather than a permanent answer. */
let unreadMessages = null;
let badgeShown = -1;
let lastArrivalAt = 0;
/* The font stack the page says it wants, which is what gets aliased to the
   desktop font. Empty until the page reports it, a moment after each load. */
let pageFontStack = '';
const pageBanners = new Map();          // page notification id -> the banner raised for it
/* The conversation on screen and the chats that still have something waiting,
   both as the page last reported them, plus the withdrawals that are waiting out
   ARRIVAL_SETTLE_MS before they can be carried out. */
let openChat = '';
let unreadChatNames = new Set();
const withdrawing = new Map();          // chat -> the timer that will try again

/* --------------------------------------------------------------- window */

const clampToScreen = (width, height) => {
  const area = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(Math.max(400, Math.round(width)), area.width),
    height: Math.min(Math.max(300, Math.round(height)), area.height),
  };
};

const pushFocus = () => {
  if (!win || win.isDestroyed()) return;
  const active = win.isVisible() && !win.isMinimized() && win.isFocused();
  win.webContents.send('wa:focus', active);
  if (tray) tray.setWindowVisible(win.isVisible() && !win.isMinimized());
  /* A window coming back is the user arriving at whatever chat is on screen. */
  if (active) withdrawOpen();
};

const showWindow = () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

const hideWindow = () => {
  if (!win || win.isDestroyed()) return;
  win.hide();
};

const setTheme = theme => {
  config.set('view.theme', theme);
  config.save();
  if (theme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else if (theme === 'light') {
    nativeTheme.themeSource = 'light';
  } else {
    nativeTheme.themeSource = desktop.prefersDark() ? 'dark' : 'light';
  }
  if (win && !win.isDestroyed()) {
    win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0b141a' : '#ffffff');
  }
  if (tray) tray.render();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:changed', { theme });
  }
};

const setAutostart = enable => {
  autostart.setEnabled(enable);
  if (tray) tray.render();
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:changed', { autostart: enable });
  }
};

const openSettings = () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }

  const isDark = nativeTheme.shouldUseDarkColors;
  settingsWin = new BrowserWindow({
    width: 480,
    height: 590,
    resizable: false,
    frame: false,
    title: 'WhatsApp Settings',
    icon: appIcon,
    autoHideMenuBar: true,
    backgroundColor: isDark ? '#111b21' : '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));

  settingsWin.once('ready-to-show', () => {
    settingsWin.show();
    settingsWin.focus();
  });

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
};

const applyStyle = async () => {
  if (!win || win.isDestroyed()) return;
  const family = config.get('view.font') || desktop.interfaceFont();
  const css = [
    style.build({
      arabicFix: config.get('view.arabic-fix'),
      fontSize: config.get('view.font-size'),
    }),
    config.get('view.force-font') ? style.aliasSheet(pageFontStack, family) : '',
  ].filter(Boolean).join('\n');

  try {
    if (cssKey) await win.webContents.removeInsertedCSS(cssKey);
  } catch (e) { /* the page navigated; the old sheet went with it */ }

  /* USER origin, which is the one level whose !important beats the page's own.
     An author-level sheet loses to WhatsApp's !important rules, and that is the
     difference between the desktop font being used and being ignored. */
  cssKey = css ? await win.webContents.insertCSS(css, { cssOrigin: 'user' }) : null;
  /* Kept reachable so the scroll probe can measure the page without it. */
  require('./main-css.js').track(win, () => cssKey, key => { cssKey = key; });
  console.log('drawing in %s at %dpx%s', family, config.get('view.font-size'),
              pageFontStack ? '' : ' (waiting for the page to say what it asks for)');
};

const createWindow = () => {
  const { width, height } = clampToScreen(config.get('window.width'), config.get('window.height'));
  const family = config.get('view.font') || desktop.interfaceFont();

  win = new BrowserWindow({
    width,
    height,
    minWidth: 500,
    minHeight: 400,
    title: TITLE,
    icon: appIcon,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b141a' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      /* Off so the preload can hand the page script the same world WhatsApp's
         own code runs in, at document-start. Node stays out of the page:
         nodeIntegration is off and the preload puts nothing on window. */
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: !!config.get('behaviour.spellcheck'),
      /* The tone this client plays for its own banners goes through the page,
         and Chromium blocks audio from a page the user has not interacted with
         yet -- which a window sitting in the tray never has. */
      autoplayPolicy: 'no-user-gesture-required',
      /* Chromium picks its default families from fontconfig, which answers with
         the system default rather than the font chosen for the desktop. The user
         stylesheet is what actually draws the page, but these decide what
         anything the sheet does not reach falls back to. */
      defaultFontFamily: { standard: family, sansSerif: family, serif: family },
      defaultFontSize: config.get('view.font-size'),
      /* A window in the tray is a hidden window, and Chromium freezes the timers
         of those. The chat-list watcher and WhatsApp's own keepalive both live on
         timers, so this stays on. */
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadURL(URL);

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && (input.control || input.meta) && input.key === ',') {
      event.preventDefault();
      openSettings();
    }
  });

  /* ------------------------------------------------------ closing and hiding */

  win.on('close', event => {
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds();
      config.set('window.width', bounds.width);
      config.set('window.height', bounds.height);
      config.set('view.zoom', win.webContents.getZoomFactor());
      config.save();
    }
    /* Closing the window is not quitting: the client stays connected in the tray
       and messages keep arriving. Ctrl+Q, and the tray's own Quit, are the two
       ways out. */
    if (!quitting && config.get('behaviour.close-to-tray')) {
      event.preventDefault();
      hideWindow();
    }
  });

  win.on('minimize', event => {
    if (config.get('behaviour.minimize-to-tray')) {
      event.preventDefault();
      hideWindow();
    } else {
      pushFocus();
    }
  });

  for (const event of ['show', 'hide', 'focus', 'blur', 'restore']) win.on(event, pushFocus);

  win.once('ready-to-show', () => {
    if (!hidden) showWindow();
    pushFocus();
  });

  /* ------------------------------------------------------------- the page */

  win.webContents.on('did-finish-load', async () => {
    loadedAt = Date.now();
    await applyStyle();
    win.webContents.setZoomFactor(Number(config.get('view.zoom')) || 1);
    win.webContents.send('wa:config', {
      notifications: !!config.get('notifications.enabled'),
      muteSendTone: !config.get('notifications.outgoing-sound'),
      /* One event, one sound, and the same one either way round: the client
         plays the desktop's tone for a message arriving whether the window is in
         front or in the tray, so the page's own tone is silenced. */
      mutePageTone: !config.get('notifications.whatsapp-sound'),
    });

    /* The tone is handed over once and kept in the page, decoded, so raising it
       later costs nothing. */
    if (config.get('notifications.sound')) {
      const tone = sound.tone();
      if (tone) win.webContents.send('wa:tone', tone);
    }
    pushFocus();
  });

  win.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;                  // -3 is an aborted load
    console.warn('load failed (%d %s); trying again in 5s', code, description);
    setTimeout(() => win && !win.isDestroyed() && win.loadURL(URL), 5000);
  });

  win.webContents.on('render-process-gone', (event, details) => {
    console.warn('the page went away (%s); reloading', details.reason);
    if (details.reason !== 'clean-exit') win.reload();
  });

  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    onTitle(title);
  });

  /* Links open in the desktop's browser. Anything that is not WhatsApp itself is
     not this client's to show: it has no address bar to tell the user where they
     have ended up. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isWhatsApp(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  win.webContents.on('before-input-event', onKey);
};

const isWhatsApp = url => {
  if (!url) return true;
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('about:')) return true;
  try {
    const host = new global.URL(url).hostname;
    return host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com') || host === 'whatsapp.com';
  } catch (e) {
    return false;
  }
};

const openExternally = url => {
  if (/^https?:|^mailto:|^tel:/i.test(url)) shell.openExternal(url).catch(() => {});
};

/* ------------------------------------------------------------------- keys */

const onKey = (event, input) => {
  if (input.type !== 'keyDown' || !win) return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (ctrl && key === 'q') { event.preventDefault(); quit(); return; }
  if (ctrl && key === 'w') { event.preventDefault(); win.close(); return; }
  if (ctrl && key === 'r') { event.preventDefault(); win.reload(); return; }
  if (ctrl && input.shift && key === 'i') {
    event.preventDefault();
    win.webContents.toggleDevTools();
    return;
  }

  const zoom = win.webContents.getZoomFactor();
  if (ctrl && (key === '+' || key === '=')) {
    event.preventDefault();
    win.webContents.setZoomFactor(Math.min(3, zoom + 0.1));
  } else if (ctrl && key === '-') {
    event.preventDefault();
    win.webContents.setZoomFactor(Math.max(0.3, zoom - 0.1));
  } else if (ctrl && key === '0') {
    event.preventDefault();
    win.webContents.setZoomFactor(1);
  }
};

/* ---------------------------------------------------------- notifications */

/* The tone for a banner, whichever half of the client raised it.
 *
 * It used to be played only for the watcher's banners -- the window-in-front
 * half -- because WhatsApp Web plays a tone of its own for the notifications it
 * raises, and two sounds for one message is worse than none. What that left was
 * two different sounds for the same event: the desktop's tone with the window in
 * front, and WhatsApp's own, served from static.whatsapp.net, with the window in
 * the tray. A notification that does not sound like itself is the one thing a
 * notification must not be. So the page's tone is silenced instead (see the
 * sound section of src/page/inject.js) and this one is played for both. */
const playTone = () => {
  if (!config.get('notifications.sound')) return;
  if (!win || win.isDestroyed()) return;
  /* The desktop has the last word.
   *
   * A notification daemon reads the urgency and the do-not-disturb setting and
   * decides whether to put a banner on screen, and it decides whether to make a
   * sound the same way -- but only for the sound IT plays, from the hint on the
   * call. This tone is played by the client, through the page, and the daemon
   * knows nothing about it. So do-not-disturb silenced the banner and left the
   * sound, which is the opposite of what do-not-disturb is for. Asked here
   * instead, and the same question the shell asks itself. */
  if (!desktop.notificationsAllowed()) {
    console.log('the tone is not played: the desktop is not taking notifications');
    return;
  }
  if (!desktop.eventSoundsEnabled()) {
    console.log('the tone is not played: the desktop has its alert sounds off');
    return;
  }
  win.webContents.send('wa:play-tone', null);
};

/* ------------------------------------------------------------ withdrawals */

/* A notification is an unread message made visible, so it comes down as soon as
   the message has been dealt with. Two things say that it has, and they are not
   the same thing:
 *
 *   the chat is the one on screen, in a window the user is looking at -- which
 *   is an answer, immediate and certain;
 *
 *   the chat has stopped being unread -- which is an inference, and one that
 *   arrives a beat late because WhatsApp draws the pill a beat after it moves
 *   the row. It also covers a message read on the phone.
 */

/* The banners for the conversation on screen, taken down at once.

   Deliberately without the ARRIVAL_SETTLE_MS guard below: that guard is there
   for a pill drawn late, and there is nothing late about the chat the user just
   clicked on. Opening a chat while its banner was still on screen used to leave
   the message sitting in the notification centre for good -- the guard refused
   the withdrawal, and the page reports the unread list only when it CHANGES, so
   nothing ever asked a second time. */
const withdrawOpen = () => {
  if (!banners || !openChat) return;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible() || win.isMinimized() || !win.isFocused()) return;

  const closed = banners.closeKey(openChat);
  if (closed) console.log('withdrew %d notification(s) for %s: it is the chat on screen',
                          closed, openChat);
};

/* The banners for a chat that has stopped being unread. A request refused for
   being too young is not dropped -- nothing would ever ask again -- but deferred
   to the moment the guard is over and asked again then, because the chat may
   have gone unread once more in between. */
const withdrawRead = key => {
  const waiting = withdrawing.get(key);
  if (waiting) { clearTimeout(waiting); withdrawing.delete(key); }
  if (!banners || unreadChatNames.has(key)) return;

  const closed = banners.closeKey(key, ARRIVAL_SETTLE_MS);
  if (closed) console.log('withdrew %d notification(s) for %s: it has been read', closed, key);

  const left = banners.guardRemaining(key, ARRIVAL_SETTLE_MS);
  if (left > 0) {
    console.log('holding %s for another %dms before withdrawing: the banner is new',
                key, Math.round(left));
    withdrawing.set(key, setTimeout(() => withdrawRead(key), left + 50));
  }
};

/* Whether a banner is this client's to raise at all. While the window is away
   WhatsApp Web raises its own, which the page shim hands over here already
   dressed; the watcher has to stay out of that, or one message arrives twice. */
const bannersAreOurs = () => {
  if (!config.get('notifications.enabled')) return false;
  if (!win || win.isDestroyed() || !win.isVisible() || !win.isFocused()) return false;
  if (Date.now() - loadedAt < STARTUP_GRACE_MS) {
    console.log('notification skipped: the client is still syncing');
    return false;
  }
  return true;
};

/* The page is asked for the description at notification time rather than pushing
   it ahead of time. Pushing it on every title change raced the title itself: the
   count reached the app first and every banner read "You have a new message".
   The quarter second lets WhatsApp finish moving the chat to the top of the list
   before the row is read. */
const describeThenNotify = () => setTimeout(async () => {
  if (!win || win.isDestroyed()) return;

  let answer = '';
  try {
    answer = await win.webContents.executeJavaScript(
      'window.__waDescribeUnread ? window.__waDescribeUnread() : ""', true);
  } catch (e) {
    console.warn('could not ask the page what arrived: %s', e.message);
    return;
  }

  if (answer === 'open') {
    /* Nothing at all: no banner, and no tone either.
     *
     * The message landed in the conversation the user is looking at, with the
     * bubble drawn under their eyes as it arrived -- there is nothing left for
     * an announcement to tell them. WhatsApp Web used to play its own tone here
     * and it is silenced along with the rest of the page's; a tone was put in
     * its place for a moment, and it was noise. This is the one case that is
     * quiet on purpose, and the only one.
     *
     * "In front" is doing real work in that sentence: this path is reached only
     * while the window is visible AND focused (bannersAreOurs). A message to the
     * chat on screen of a window the user is NOT looking at goes down the page's
     * own path instead, and is announced like any other. */
    console.log('a message in the chat on screen: nothing raised, and nothing played');
    return;
  }
  if (!answer) {
    /* The list moved but the page cannot say what moved it -- a row mid-render, a
       reaction, a chat read somewhere else. Not something to put a banner over. */
    console.log('notification skipped: nothing the page could name');
    return;
  }

  const [chat, sender, message, avatar, token] = answer.split(SEP);
  if (!chat || !message) return;

  const raised = banners.show({
    /* This message and no other. Not the chat -- keyed on the chat, the second
       message of a burst would replace the first instead of stacking under it. */
    identity: [chat, sender, message].join(SEP),
    key: chat,
    title: bidi.paragraph(chat),
    body: bidi.line(sender, message),
    redacted: kindOf(message),
    icon: avatar,
    /* A banner is a message, and clicking one is asking to read it. The banners
       WhatsApp Web raises have always done this -- the click goes back to the
       page and WhatsApp's own handler opens the conversation -- while these,
       raised on this side, only brought the window forward and left the user
       wherever they already were. The page has no handler to hand this one back
       to, so it is asked for the chat by name. */
    onClick: () => {
      showWindow();
      /* The row this banner was made from travels back with the click, because a
         chat cannot always be found again by its name: two of them can share one,
         and this account has such a pair. The name and the message go too, for
         when WhatsApp has recycled the row in the meantime. */
      if (win && !win.isDestroyed())
        win.webContents.send('wa:open-chat-request', { token, name: chat, preview: message });
    },
  });
  /* One event, one sound. A banner refused as a message already announced is not
     an event, and playing a tone for it would be the duplicate arriving in the
     one form the deduplication cannot take back. */
  if (raised) playTone();
}, 250);

/* WhatsApp Web puts "(3) WhatsApp" in the document title while chats are unread
   and drops the prefix once they are read. That is the only unread signal the
   page hands over without scraping its DOM, and it is what marks the tray. */
const onTitle = title => {
  /* The parenthesised number counts unread CHATS, not messages: two
     conversations holding five messages between them read "(2) WhatsApp". It is
     read for one thing only -- has anything new arrived -- because that is all
     it is reliable for. No number is drawn anywhere. */
  let chats = 0;
  const m = /^\((\d+)\)/.exec(title || '');
  if (m) chats = parseInt(m[1], 10) || 1;

  /* A backstop for the one case the chat list watcher cannot see: a chat far
     enough down the list that its row was never rendered has no previous preview
     to have changed, so nothing is reported when a message moves it to the top.
     The count rises all the same. */
  if (chats > unreadChats &&
      Date.now() - lastArrivalAt > TITLE_FALLBACK_MS &&
      bannersAreOurs()) {
    describeThenNotify();
  }
  unreadChats = chats;

  /* The title dropping its prefix is the one unambiguous statement WhatsApp
     makes about unread: everything has been read. It is taken as such, and the
     page's count is reset with it rather than left to expire on its own -- two
     places writing the badge and the tray from numbers that disagree is how an
     icon ends up marked unread with nothing behind it. */
  if (chats === 0) unreadMessages = 0;

  const waiting = unreadMessages === null ? chats : unreadMessages;
  if (tray) tray.setAttention(waiting > 0);
  /* The number on the launcher icon, from the title only until the page has
     counted the pills for us. The title's number is chats, not messages, so it
     is the wrong number for a badge -- three conversations holding eleven
     messages read "3" where the phone reads "11" -- but it is the right number
     when nothing has been counted yet. */
  setBadge(waiting);
  if (win && !win.isDestroyed()) win.setTitle(title && title.trim() ? title : TITLE);
};

/* Drawn by the launcher, over the application's icon. On Linux this goes out on
   the Unity LauncherEntry interface, which GNOME reads through Dash to Dock and
   its relatives and which nothing at all reads on a plain GNOME -- so it is set
   and not depended upon, and the tray icon carries the same news for a desktop
   that does not draw badges. */
const setBadge = count => {
  const wanted = Math.max(0, Math.round(Number(count) || 0));
  if (wanted === badgeShown) return;
  badgeShown = wanted;
  try { app.badgeCount = wanted; } catch (e) { /* no launcher listening */ }
  console.log('badge: %d', wanted);
};

/* --------------------------------------------------------------- the app */

const quit = () => {
  quitting = true;
  app.quit();
};

const wireIpc = () => {
  ipcMain.on('wa:log', (event, message) => console.log('page: %s', message));

  ipcMain.handle('settings:get', () => {
    return {
      theme: config.get('view.theme') || 'system',
      autostart: autostart.isEnabled(),
      closeToTray: !!config.get('behaviour.close-to-tray'),
      minimizeToTray: !!config.get('behaviour.minimize-to-tray'),
      notifyEnabled: !!config.get('notifications.enabled'),
      notifySound: !!config.get('notifications.sound'),
      outgoingSound: !!config.get('notifications.outgoing-sound'),
      arabicFix: !!config.get('view.arabic-fix'),
      zoom: Number(config.get('view.zoom')) || 1.0,
      fontSize: Number(config.get('view.font-size')) || 16,
    };
  });

  ipcMain.handle('settings:set-theme', (_, theme) => {
    setTheme(theme);
    return true;
  });

  ipcMain.handle('settings:set-autostart', (_, enable) => {
    setAutostart(enable);
    return true;
  });

  ipcMain.handle('settings:set', (_, key, value) => {
    config.set(key, value);
    config.save();
    if (key === 'view.zoom' && win && !win.isDestroyed()) {
      win.webContents.setZoomFactor(Number(value) || 1.0);
    }
    if (key === 'view.arabic-fix' || key === 'view.font-size') {
      applyStyle();
    }
    return true;
  });

  ipcMain.on('settings:close', () => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.close();
    }
  });

  /* The font stack the page actually asks for. fontconfig is read once per
     process, so a family learned here takes effect on the next start -- which
     is the price of not having to guess what WhatsApp will name its font next. */
  ipcMain.on('wa:font-stack', (event, stack) => {
    if (!config.get('view.force-font') || typeof stack !== 'string') return;
    if (stack === pageFontStack) return;
    pageFontStack = stack;
    /* Applied straight away rather than on the next start: an @font-face alias
       is a stylesheet, and a stylesheet can be inserted into a page that is
       already open. */
    applyStyle();
    fonts.learn(app.getPath('userData'), stack.split(','));
  });

  ipcMain.on('wa:focus-request', showWindow);


  /* The chat list watcher nudges us for every message it sees land, which is what
     makes a banner per message possible at all. The document title cannot do that
     job: its number counts unread CHATS, so the second and third message from one
     person leave "(1) WhatsApp" exactly as it was and nothing fires. */
  ipcMain.on('wa:arrival', () => {
    if (!bannersAreOurs()) return;
    lastArrivalAt = Date.now();
    describeThenNotify();
  });

  /* A notification WhatsApp Web itself decided to raise, intercepted in the page
     and handed over with the sender's picture already fetched. The click goes
     back to the page, whose own handler opens the conversation. */
  ipcMain.on('wa:page-notification', (event, note) => {
    if (!note || !config.get('notifications.enabled')) return;
    /* The page says whether this chat is a group, because WhatsApp's own body
       reads "Sender: message" for one and the bare message for the other, and
       nothing in the text tells them apart. */
    const { sender, message: said, mark } = readBody(note.body, note.group);
    /* And the mark for what kind of thing it is, which this path never used to
       put on. The chat-list watcher labelled every preview it read; the
       notifications WhatsApp Web raises itself came through with WhatsApp's own
       bare "Sticker" and no glyph -- and those are every notification raised
       while the window is not in front, which is most of them. Same table both
       sides now, so the two also agree on what a message is called and the
       deduplication between them keeps working. */
    const message = mediaFromWords(said) || said;

    const banner = banners.show({
      identity: [note.chat || note.title, sender, message].join(SEP),
      /* Keyed on the chat the page found in its list rather than on the title
         WhatsApp wrote, so this path and the watcher's agree on what a chat is
         called. The withdrawal side speaks chat-list names and nothing else: a
         key that does not appear there is a notification nothing can take
         down. */
      key: note.chat || note.title,
      title: bidi.paragraph(pushName(note.title)),
      body: mark + bidi.line(sender, message),
      redacted: mark + kindOf(message),
      icon: note.avatar,
      onClick: () => {
        showWindow();
        if (win && !win.isDestroyed()) win.webContents.send('wa:notification-clicked', note.id);
      },
    });
    if (banner) {
      pageBanners.set(note.id, banner);
      /* Most of these are never mentioned again: a banner the user clicked, or
         one withdrawn when its chat was read, is finished with and WhatsApp
         never names its id. Trimmed oldest-first rather than tracked, which a
         client left running for days needs and nothing else would do. */
      while (pageBanners.size > 256) pageBanners.delete(pageBanners.keys().next().value);
    }
    /* And the tone, because the page's own has been silenced for this.
     *
     * `silent` on the notification is deliberately not honoured. In the web API
     * it means "raise this without the browser's own sound", and a page that
     * plays its own tone through an <audio> element -- which is exactly what
     * WhatsApp Web does -- has every reason to set it. Honouring it here, with
     * that tone silenced, would leave the one case this whole change is about
     * making no sound at all. It is logged instead, so the truth about which
     * notifications carry it is in the log rather than in a guess. */
    if (banner) {
      /* What kind of thing it was, and never a word of what it said. This is the
         one line that answers "the sticker arrived without its mark" from a log
         instead of from a screenshot. */
      console.log('raised: %s', mark + (mediaFromWords(said) || 'a message of words'));
      if (note.silent) console.log('the page asked for a silent notification; the tone is played anyway');
      playTone();
    }
  });

  /*
   * WhatsApp Web closing a notification of its own.
   *
   * It does this for two very different reasons and says which for neither. One
   * is the message having been read -- on the phone, most often -- and that is
   * a banner this client should take down with it. The other is housekeeping:
   * it closes notifications it has finished with, and it does so in batches, so
   * a sticker arriving used to sweep every earlier message out of the
   * notification centre along with it. That was the report, and taking the
   * disposal out altogether was the fix -- which left the phone case unhandled.
   *
   * The chat itself settles it. A close for a chat that still has something
   * waiting is housekeeping and is ignored; a close for a chat with nothing
   * unread left is the message having been read, and the banner goes.
   */
  ipcMain.on('wa:page-notification-close', (event, note) => {
    if (!note) return;
    const banner = pageBanners.get(note.id);
    pageBanners.delete(note.id);
    if (!banner) return;
    if (unreadChatNames.has(banner.key)) {
      console.log('WhatsApp closed its notification for %s but the chat still has ' +
                  'something unread; leaving the banner up', banner.key);
      return;
    }
    banner.dispose();
    console.log('withdrew a notification for %s: WhatsApp closed it and the chat is caught up',
                banner.key);
  });

  /* The conversation on screen, reported by the page when it changes and again
     whenever the window comes back. This is the signal that takes a banner down
     the moment the user opens the chat -- the unread report below cannot: it is
     refused for the first few seconds of a banner's life, and it is sent only
     when the answer changes, so those few seconds used to be for ever. */
  ipcMain.on('wa:open-chat', (event, name) => {
    openChat = typeof name === 'string' ? name : '';
    withdrawOpen();
  });

  /* Which chats still have something unread, reported by the page whenever the
     answer changes. A notification is an unread message made visible, so when
     the message stops being unread the notification has no business staying on
     screen -- and it stops being unread whether it was read here or on the
     phone, because WhatsApp Web clears the pill either way. */
  ipcMain.on('wa:unread-chats', (event, names) => {
    if (!Array.isArray(names) || !banners) return;
    unreadChatNames = new Set(names);
    const held = banners.keys();
    /* Names, never messages. Which chats are unread and which still have a
       banner up is the whole of the withdrawal question, and it is the one thing
       a log of this path has to be able to answer. */
    if (held.length)
      console.log('unread: [%s]; banners still up for: [%s]', names.join(', '), held.join(', '));
    for (const key of new Set([...held, ...withdrawing.keys()])) withdrawRead(key);
  });

  /* How many messages are waiting, counted off the unread pills rather than
     inferred from the document title. This is the number the badge wants. */
  ipcMain.on('wa:unread-count', (event, count) => {
    if (!count || typeof count.messages !== 'number') return;
    unreadMessages = count.messages;
    setBadge(count.messages);
    if (tray) tray.setAttention(count.messages > 0);
  });
};

/* Downloads land in ~/Downloads without a dialog, the way a phone would do it.
   A name already taken gets a number, rather than overwriting what is there. */
const wireDownloads = ses => {
  const downloads = app.getPath('downloads');
  ses.on('will-download', (event, item) => {
    const name = item.getFilename();
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let target = path.join(downloads, name);
    for (let n = 1; fs.existsSync(target); n++) target = path.join(downloads, `${stem} (${n})${ext}`);
    item.setSavePath(target);
    item.once('done', (e, state) => {
      if (state === 'completed') console.log('downloaded %s', target);
    });
  });
};

/* WhatsApp asks for notifications, for the microphone and camera when a call
   starts, and for the clipboard when something is pasted. Nothing else is
   granted: this window shows one site and has no address bar to explain a
   prompt from anywhere else. */
const ALLOWED_PERMISSIONS = new Set([
  'notifications', 'media', 'audioCapture', 'videoCapture',
  'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'display-capture',
  'speaker-selection', 'mediaKeySystem', 'idle-detection', 'window-management',
]);

const wirePermissions = ses => {
  /* The origin is checked as well as the permission, and the check is written to
     survive not being told one. Chromium hands over an empty requestingUrl for
     the media request a call starts with, and an earlier version of this read
     that as "not WhatsApp" and refused the camera -- which is why the check was
     taken out altogether. It is back, with isWhatsApp answering true for the
     empty, blob: and about: URLs that are this window's own. Without it, an
     <iframe> of somebody else's making asks for the microphone and is given
     it. */
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (contents && contents.getURL()) || '';
    callback(isWhatsApp(url) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((contents, permission, origin, details) =>
    isWhatsApp(origin || '') && ALLOWED_PERMISSIONS.has(permission));
  /* This one is not about the camera. It decides which USB, HID and serial
     devices a page may open, and WhatsApp Web asks for none of them -- so the
     answer is scoped to the one origin this window shows rather than left as a
     blanket yes to anything that finds its way into it. */
  ses.setDevicePermissionHandler(details =>
    isWhatsApp((details && details.origin) || ''));
};

/* Screen sharing during calls. WhatsApp Web calls getDisplayMedia() when the user
   presses the share-screen button in a call, and Electron does not forward that to
   the compositor on its own -- the page must ask the main process for a source, or
   the request silently goes nowhere. The entire screen is handed over without a
   picker: WhatsApp's own UI already tells the user what they are sharing, and a
   system dialog on top of that would be a speed bump. PipeWire is the path it takes
   on Wayland, and the WebRTCPipeWireCapturer flag in the switches above is what
   enables that. */
const wireScreenSharing = ses => {
  /* Electron will not forward getDisplayMedia anywhere without a handler, so the
     share-screen button in a call silently does nothing until one is set. What
     the handler must never do is fail to answer: a callback that is not called
     leaves the page waiting for ever, which looks exactly like a button that
     does nothing -- the very thing this is here to fix.

     useSystemPicker asks Chromium to run the platform's own chooser and skip
     this handler entirely where it can. That is the right answer wherever it is
     available, and the handler below is what happens where it is not. */
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    /* Wayland picks in the compositor, not here.
     *
     * desktopCapturer.getSources() on a Wayland session goes out to
     * xdg-desktop-portal and waits -- and measured on this session it never came
     * back, for screens and for windows alike, with an eight second ceiling on
     * the measurement. A handler built on it is a handler that never answers,
     * which is how "screen sharing was added" and screen sharing did not work.
     *
     * There is nothing to enumerate anyway. Under WebRTCPipeWireCapturer the
     * portal puts up its own chooser when the stream starts, and it is the only
     * thing on a Wayland session allowed to say what may be captured. So the
     * request is answered at once with the screen Chromium will hand to the
     * portal, and the user picks in the dialog the compositor draws. */
    if (onWayland) {
      console.log('screen sharing: handing the choice to the desktop portal');
      callback({ video: { id: 'screen:0:0', name: 'Entire screen' } });
      return;
    }

    /* X11, where enumeration is local and answers immediately. Windows as well
       as screens: WhatsApp's own button offers both, and a handler that only
       ever answers with a screen turns "share this window" into "share
       everything", which is a privacy bug rather than a missing feature. */
    try {
      const sources = await Promise.race([
        desktopCapturer.getSources({ types: ['screen', 'window'], fetchWindowIcons: false }),
        /* Belt and braces. Whatever else happens, this handler answers. */
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
      if (!sources) {
        console.warn('screen sharing: the desktop did not answer in time');
        callback({ video: null });
        return;
      }
      const source = sources.find(s => s.id.startsWith('screen:')) || sources[0];
      if (!source) {
        console.warn('screen sharing: nothing to share -- no screen or window source');
        callback({ video: null });
        return;
      }
      console.log('screen sharing: handing over "%s"', source.name);
      /* No audio. `loopback` is the system-audio capture Electron implements on
         Windows and nowhere else; passing it here is at best ignored, and the
         microphone is already in the call. */
      callback({ video: source });
    } catch (err) {
      console.warn('screen sharing failed: %s', err.message);
      callback({ video: null });
    }
  }, { useSystemPicker: true });
};

/* WhatsApp Web keys the client it thinks it is talking to off the user agent, and
   the Electron one is not a browser it knows. A plain Chrome string is: the same
   page, the same features, and the device registers as Chrome on Linux rather
   than as something WhatsApp has never heard of. */
const chromeUserAgent = () => {
  const chrome = process.versions.chrome.split('.')[0];
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
         `Chrome/${chrome}.0.0.0 Safari/537.36`;
};

app.on('second-instance', (event, argv) => {
  /* A --hidden launch that finds one already running exits without raising the
     window: that is the login autostart arriving on top of a client the user
     started themselves. */
  if (!argv.includes('--hidden')) showWindow();
});

app.on('window-all-closed', () => {
  /* Nothing to do: the window hides rather than closes, and quitting is what
     Ctrl+Q and the tray's Quit are for. */
});

app.on('before-quit', () => {
  quitting = true;
  /* The tray keeps a gdbus monitor alive to notice a status icon host coming and
     going; nothing else would take it down. */
  if (tray) tray.destroy();
});

app.whenReady().then(() => {
  sweepAvatars();

  const ua = chromeUserAgent();
  app.userAgentFallback = ua;
  const ses = session.defaultSession;
  ses.setUserAgent(ua);
  wireDownloads(ses);
  wirePermissions(ses);
  wireScreenSharing(ses);

  if (config.get('behaviour.spellcheck')) {
    try { ses.setSpellCheckerLanguages(['en-US']); } catch (e) {}
  }

  const initialTheme = config.get('view.theme') || 'system';
  if (initialTheme === 'dark') {
    nativeTheme.themeSource = 'dark';
  } else if (initialTheme === 'light') {
    nativeTheme.themeSource = 'light';
  } else {
    nativeTheme.themeSource = desktop.prefersDark() ? 'dark' : 'light';
  }

  banners = new Banners({
    seconds: Number(config.get('notifications.banner-seconds')) || 12,
    appIcon,
    hidePreview: !!config.get('notifications.hide-preview'),
    /* Which messages have already been announced, so a restart does not put the
       whole unread backlog back on screen as though it had just arrived. */
    stateFile: path.join(app.getPath('userData'), 'announced.json'),
  });

  wireIpc();
  createWindow();

  tray = new TrayIcon({
    normal: iconFile(24, `status/${APP_ID}-tray.png`),
    attention: iconFile(24, `status/${APP_ID}-tray-attention.png`),
    onShow: showWindow,
    onHide: hideWindow,
    onQuit: quit,
    onSettings: openSettings,
    onSetTheme: setTheme,
    getTheme: () => config.get('view.theme') || 'system',
    onToggleAutostart: setAutostart,
    getAutostart: () => autostart.isEnabled(),
    title: TITLE,
  });

  debug.install(() => win, () => banners);

  /* Follow the desktop live: a theme switched from light to dark, or a font
     changed in Settings, should not need the client restarted. */
  desktop.watch(['color-scheme', 'font-name'], key => {
    if (key === 'color-scheme') {
      if ((config.get('view.theme') || 'system') === 'system') {
        nativeTheme.themeSource = desktop.prefersDark() ? 'dark' : 'light';
      }
    } else {
      applyStyle();
    }
  });
});
