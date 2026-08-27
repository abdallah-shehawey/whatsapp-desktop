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

const { app, BrowserWindow, Menu, session, shell, nativeTheme, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Config } = require('./config.js');
const desktop = require('./desktop.js');
const style = require('./style.js');
const { TrayIcon } = require('./tray.js');
const { Banners, sweepAvatars } = require('./notify.js');
const { SEP } = require('./page/inject.js');
const debug = require('./debug.js');

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

const hidden = process.argv.includes('--hidden');
const config = new Config();

/* ------------------------------------------------------------------ paths */

/* The state directory keeps the project's own name rather than the product's.
   ~/.local/share/whatsapp belongs to the GTK client this one replaces, and a
   signed-in WebKit session and a signed-in Chromium session have no business
   sharing a directory -- least of all one the user might reinstall the other
   client into. */
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
app.setPath('userData', path.join(dataHome, 'whatsapp-desktop'));
app.setName('whatsapp-desktop');

/* Notifications carry the application's desktop file: without it GNOME files
   every banner under "Electron" and draws Electron's icon on it. */
if (process.platform === 'linux') app.setDesktopName(APP_ID + '.desktop');

const iconFile = (size, name) =>
  path.join(__dirname, '..', 'data', 'icons', String(size), name);
const appIcon = iconFile(256, `apps/${APP_ID}.png`);

/* -------------------------------------------------------------- switches */

/* Wayland natively rather than through XWayland: it is the difference between
   crisp text on a fractional scale and a blurry upscale, and between smooth
   trackpad scrolling and stepped wheel events. */
if (process.env.XDG_SESSION_TYPE === 'wayland') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}
/* WhatsApp Web is one page that stays open for days. Letting Chromium hand
   memory back when it is not being looked at is worth more here than the
   milliseconds it costs to fault it in again. */
app.commandLine.appendSwitch('enable-features', 'MemoryPurgeOnFreezeLimit');

/* ------------------------------------------------------------ single copy */

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
}

/* ----------------------------------------------------------------- state */

let win = null;
let tray = null;
let banners = null;
let quitting = false;
let cssKey = null;
let loadedAt = 0;
let unreadChats = 0;
let lastArrivalAt = 0;
const pageBanners = new Map();          // page notification id -> the banner raised for it

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

const applyStyle = async () => {
  if (!win || win.isDestroyed()) return;
  const family = config.get('view.font') || desktop.interfaceFont();
  const css = style.build({
    family,
    forceFont: config.get('view.force-font'),
    arabicFix: config.get('view.arabic-fix'),
    fontSize: config.get('view.font-size'),
  });

  try {
    if (cssKey) await win.webContents.removeInsertedCSS(cssKey);
  } catch (e) { /* the page navigated; the old sheet went with it */ }

  /* USER origin, which is the one level whose !important beats the page's own.
     An author-level sheet loses to WhatsApp's !important rules, and that is the
     difference between the desktop font being used and being ignored. */
  cssKey = await win.webContents.insertCSS(css, { cssOrigin: 'user' });
  console.log('drawing in %s at %dpx', family, config.get('view.font-size'));
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
    win.webContents.send('wa:config', { notifications: !!config.get('notifications.enabled') });
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
    console.log('notification skipped: the message is in the chat on screen');
    return;
  }
  if (!answer) {
    /* The list moved but the page cannot say what moved it -- a row mid-render, a
       reaction, a chat read somewhere else. Not something to put a banner over. */
    console.log('notification skipped: nothing the page could name');
    return;
  }

  const [chat, sender, message, avatar] = answer.split(SEP);
  if (!chat || !message) return;

  banners.show({
    title: chat,
    body: sender ? `${sender}: ${message}` : message,
    icon: avatar,
    onClick: showWindow,
  });
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

  if (tray) tray.setAttention(chats > 0);
  app.badgeCount = chats;
  if (win && !win.isDestroyed()) win.setTitle(title && title.trim() ? title : TITLE);
};

/* --------------------------------------------------------------- the app */

const quit = () => {
  quitting = true;
  app.quit();
};

const wireIpc = () => {
  ipcMain.on('wa:log', (event, message) => console.log('page: %s', message));

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
    const banner = banners.show({
      title: note.title,
      body: note.body,
      icon: note.avatar,
      onClick: () => {
        showWindow();
        if (win && !win.isDestroyed()) win.webContents.send('wa:notification-clicked', note.id);
      },
    });
    if (banner) pageBanners.set(note.id, banner);
  });

  ipcMain.on('wa:page-notification-close', (event, note) => {
    const banner = note && pageBanners.get(note.id);
    if (!banner) return;
    pageBanners.delete(note.id);
    try { banner.close(); } catch (e) {}
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
]);

const wirePermissions = ses => {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const url = (details && details.requestingUrl) || (contents && contents.getURL()) || '';
    callback(isWhatsApp(url) && ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((contents, permission, origin) =>
    isWhatsApp(origin || '') && ALLOWED_PERMISSIONS.has(permission));
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

app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  sweepAvatars();

  const ua = chromeUserAgent();
  app.userAgentFallback = ua;
  const ses = session.defaultSession;
  ses.setUserAgent(ua);
  wireDownloads(ses);
  wirePermissions(ses);

  if (config.get('behaviour.spellcheck')) {
    try { ses.setSpellCheckerLanguages(['en-US']); } catch (e) {}
  }

  nativeTheme.themeSource = desktop.prefersDark() ? 'dark' : 'light';

  banners = new Banners({
    seconds: Number(config.get('notifications.banner-seconds')) || 12,
    appIcon,
  });

  wireIpc();
  createWindow();

  tray = new TrayIcon({
    normal: iconFile(24, `status/${APP_ID}-tray.png`),
    attention: iconFile(24, `status/${APP_ID}-tray-attention.png`),
    onShow: showWindow,
    onHide: hideWindow,
    onQuit: quit,
    title: TITLE,
  });

  debug.install(() => win);

  /* Follow the desktop live: a theme switched from light to dark, or a font
     changed in Settings, should not need the client restarted. */
  desktop.watch(['color-scheme', 'font-name'], key => {
    if (key === 'color-scheme') {
      nativeTheme.themeSource = desktop.prefersDark() ? 'dark' : 'light';
    } else {
      applyStyle();
    }
  });
});
