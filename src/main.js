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

const { app, BrowserWindow, Menu, session, shell, nativeTheme, ipcMain, screen: electronScreen, desktopCapturer } = require('electron');
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
const links = require('./links.js');

const APP_ID = 'io.github.shehawey.whatsapp-desktop';
const WHATSAPP_URL = 'https://web.whatsapp.com/';
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
/* Every user stylesheet this process has put into the page, newest last. One
   key was not enough: two overlapping applyStyle calls both read it, both
   removed the same sheet, and both inserted -- so the older one stayed in the
   page for ever, and being older it still beat the new one at equal
   specificity. That is what a settings stepper pressed twice quickly does, and
   the symptom was a text size that would go up and never come back down. */
let cssKeys = [];
/* The options the sheet in the page was built from, or null before there is one. */
let drawnWith = null;
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

/* And the same three questions again, answered by WhatsApp's own store instead
   of by a reading of its chat list. While `storeLive` is true this is the ONLY
   notification path -- the watcher's nudge and the shim over WhatsApp's own
   notifications are both refused below -- because the two of them disagreed
   about what a chat is called, what a mention is and when a message was read,
   and every one of those disagreements was a bug somebody had to report.

   The identities here are WhatsApp's: a chat id rather than a display name (two
   chats can share a name, and this account has three such pairs) and a message
   id rather than the text of a message. */
let storeLive = false;
let activeChatId = '';
const chatTitles = new Map();           // chat id -> what to print for it

/* --------------------------------------------------------------- window */

const clampToScreen = (width, height) => {
  const area = electronScreen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.min(Math.max(400, Math.round(width)), area.width),
    height: Math.min(Math.max(300, Math.round(height)), area.height),
  };
};

/* Raising a window on Wayland is done by taking it down and putting it back up
   (see showWindow), and for the frame in between the window is genuinely not on
   screen. The page must not hear about that frame. Told the client went away and
   came back, WhatsApp resumes as though it had been in the background for an age
   -- which the owner sees as the client closing and reopening itself every time
   a banner is clicked. While the trick is in progress the honest answer is the
   one it is on its way to: on screen. */
let remapping = false;

const pushFocus = () => {
  if (!win || win.isDestroyed()) return;
  const onScreen = remapping || (win.isVisible() && !win.isMinimized());
  const active = onScreen && win.isFocused();
  win.webContents.send('wa:focus', active);
  /* Whether the compositor is drawing this window at all, which is a different
     question from whether it has the focus and the one the page cannot answer
     for itself. See the visibility section of src/page/inject.js. */
  win.webContents.send('wa:on-screen', onScreen);
  /* The tray is deliberately not told anything here. What it needs is tracked
     from the window's own events instead -- see traceWindowState -- because
     asking the window is what got this wrong. */
  /* A window coming back is the user arriving at whatever chat is on screen --
     and at any call the telephone is ringing for. */
  if (active) { withdrawOpen(); withdrawRinging(); }
};

/*
 * Where the window is, and whether the owner is looking at it -- the whole of
 * what the tray's one item needs, both for the word it wears and for what its
 * click does.
 *
 * Three rounds of work went into computing this honestly and each of them was
 * needed: isMinimized() answers false for a window sitting in the dock under
 * GNOME; the focus cannot simply be read, because opening the tray menu is
 * itself what takes the focus off the window; and the focus cannot be left out
 * either, because a window standing behind the editor is one the owner is
 * reaching for. The first is why this is tracked from events at all, the second
 * is what FOCUS_GRACE_MS below is for, and the third is the report this last
 * round answers.
 *
 * The state is worth keeping for the reason it was built: it is the one account
 * of the window that comes from events rather than from queries -- an event is a
 * fact where a query is an opinion. `minimize` fires when the window goes to the
 * dock whatever isMinimized() says a moment later, and `show` and `hide` are the
 * same. Asking isVisible() instead, which is the obvious thing to write, answers
 * true for a window sitting in the dock: the click asking for that window back
 * would take it away instead.
 *
 * The minimised flag under Wayland does not stay true on its own. xdg-shell has
 * no minimised state for a compositor to report back -- a client asks to be
 * minimised and that is the end of the conversation -- so the next configure
 * puts the window back to normal and `restore` arrives seconds after a minimise
 * nobody undid. Measured, in that order, from one click. So a restore is
 * believed only when the window has the focus with it: a window the owner really
 * did fetch out of the dock is a window the compositor activated, and one still
 * sitting in the dock is not.
 */
const windowState = { visible: false, minimized: false, focused: false };

/* Raising the window takes it down for a frame and puts it back up (see
   showWindow), so a window mid-remap is reported as where it is heading -- the
   same reasoning as `remapping` in pushFocus. */
const windowOnScreen = () => remapping || (windowState.visible && !windowState.minimized);

/*
 * When the focus last left the window. Kept because the tray has to tell two
 * blurs apart, and only the clock can.
 *
 * A window that is up but behind something is not a window the owner is looking
 * at, and the tray's item should offer to fetch it rather than to put it away --
 * which is the whole of the report this answers. Whether the owner is looking at
 * it is the focus, and the focus is exactly what asking about the tray destroys:
 * opening a status icon menu on GNOME takes a modal grab, the window loses the
 * keyboard, and the question "is this window in front?" is then asked of a
 * window that looks unfocused because it is being asked about.
 *
 * So a blur that has only just happened is not believed. Nothing a person can do
 * takes the focus off this window and opens the tray inside this many
 * milliseconds; the grab does it in single figures. And a blur that arrives
 * after the menu has asked cannot mislead it either, because the answer is
 * frozen when the menu opens -- see AboutToShow in tray-sni.js.
 */
const FOCUS_GRACE_MS = 400;
let blurredAt = 0;
let graceTimer = null;

/* On the screen and the owner's -- what the tray's one item reads and what its
   click does. */
const windowInFront = () => remapping || (windowOnScreen() &&
  (windowState.focused || Date.now() - blurredAt < FOCUS_GRACE_MS));

const traceWindowState = () => {
  /* The raw stream, before anything is made of it: which events the compositor
     actually sends and in what order is the whole question about this window,
     and it is asked again every time the tray reads wrong. */
  for (const event of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore']) {
    win.on(event, () => debug.trace('window event: %s %s', event, JSON.stringify({
      visible: win.isVisible(), minimized: win.isMinimized(), focused: win.isFocused() })));
  }

  const set = change => {
    Object.assign(windowState, change);
    const onScreen = windowOnScreen();
    debug.trace('window: %s -> %s', JSON.stringify(windowState),
      onScreen ? 'on the screen' : 'away');
    /* The word on the tray's one item, and what its click will do. Only a
       change reaches the desktop. */
    if (tray) tray.setInFront(windowInFront());
  };

  /* Only this program hides and shows this window, and both events arrive when
     it does -- so these two own `visible` outright and nothing else writes it.
     That is not fussiness. `focus` used to set it as well, on the reasoning that
     a window cannot be given the focus while hidden, and the compositor does not
     agree: hide the window from the tray's own menu and the focus comes back to
     it as the menu's grab is released, seconds after it left the screen. The
     tray then believed the window was up, so its item still said "Minimize to
     Tray" and its click hid an already hidden window -- which is precisely the
     "it does nothing, and the next time I open the tray the word is right"
     report. Hiding it again is what emitted the second `hide` that put the word
     right, one open too late. */
  win.on('show', () => set({ visible: true, minimized: false }));
  win.on('hide', () => set({ visible: false, focused: false }));
  win.on('minimize', () => set({ minimized: true }));
  win.on('restore', () => set(win.isFocused() ? { minimized: false } : {}));
  /* Having the focus settles the dock: a window in it does not hold the
     keyboard, whatever a `restore` that never arrived implies. */
  win.on('focus', () => { clearTimeout(graceTimer); set({ minimized: false, focused: true }); });
  win.on('blur', () => {
    blurredAt = Date.now();
    set({ focused: false });
    /* And again when the grace above runs out, because the grace is the only
       reason the tray was not told. Without this the desktop keeps "Minimize to
       Tray" in its cache until something else about the window moves, and it is
       from that cache that the menu is drawn -- before anything said here can
       reach it. The tray ignores this while its menu is open; see setInFront. */
    clearTimeout(graceTimer);
    graceTimer = setTimeout(() => {
      if (tray) tray.setInFront(windowInFront());
    }, FOCUS_GRACE_MS + 50);
  });
};

/*
 * The window, brought to the user -- which on Wayland is not what asking for it
 * does.
 *
 * Wayland has no raise. A client cannot put itself in front of anything; the
 * one way up is the xdg-activation protocol, and whether it is granted is the
 * compositor's decision. Measured on the wire, this is the request Chromium
 * sends when focus() is called on a window that is not already in front:
 *
 *   xdg_activation_v1.get_activation_token(new xdg_activation_token_v1)
 *   xdg_activation_token_v1.set_serial(36978, wl_seat)
 *   xdg_activation_token_v1.commit()
 *
 * and mutter's rule for what to do with it (meta-wayland-activation.c) is:
 *
 *   if (!token->seat)    return FALSE;
 *   if (!token->surface) return FALSE;
 *   ...
 *   token_can_activate (token) ? meta_window_activate_full (...)
 *                              : meta_window_set_demands_attention (window);
 *
 * There is no set_surface in that request, so the answer can only ever be no,
 * and "demands attention" is the notification the owner sees: "WhatsApp is
 * ready", posted instead of the window arriving. Chromium omits it on purpose
 * -- DetermineSurface() hands over a surface only for the window that already
 * holds the pointer or keyboard, which by definition is not this one. Qt sets
 * the surface unconditionally, which is why Telegram's tray raises its window
 * on the same desktop and this client's could not. gtk_shell1 would be the
 * other way through and is bound but never used: Chromium creates no
 * gtk_surface1, so there is nothing to call request_focus on.
 *
 * So the window is not raised, it is opened. Taken down and mapped again, it is
 * a new window rather than an old one asking for something, and the compositor
 * gives a new window the focus without being asked -- measured, in every state
 * the tray can find it in. This is not a trick that will age well and it should
 * be deleted the day Electron ships a Chromium that sets the surface; until
 * then it is the only thing that works, and the cost is the window's own
 * closing and opening animation, which cannot be suppressed from here.
 *
 * Asking nicely first is deliberately not tried. It was: request, wait, re-map
 * if refused. It works, and by the time the refusal can be seen the shell has
 * already posted "WhatsApp is ready", which flashes up before the window
 * arrives. There is no withdrawing somebody else's notification, so the only
 * way not to see it is not to earn it.
 *
 * Nor is the re-map one option among several. Measured on GNOME 50, against a
 * second client holding the focus -- because a window asking for the focus it
 * already has proves nothing -- focus() on its own, moveTop() and being briefly
 * always-on-top all leave the window exactly where it was, and only the re-map
 * brings it forward with the focus. Always-on-top had been written up here as
 * the other way through; it is not one any more, whatever it once did.
 *
 * The cost is paid in the dock. A client with no window up is a client that is
 * not running, so for the frame in between the icon leaves an unpinned dock and
 * the icons beside it close the gap, which reads as a flicker. Pinning the app
 * settles it: a favourite keeps its place and only the running dot blinks.
 */
const showWindow = () => {
  if (!win || win.isDestroyed()) return;

  /* Already up, and already the owner's. There is nothing to raise, and raising
     it anyway means the re-map below -- which takes the window down for a frame
     and puts the page through a rebuild to no purpose. Clicking a banner while
     looking at the client should move to the chat and do nothing else. */
  if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
    win.focus();
    return;
  }

  /* Down and up again in one turn of the loop, with no frame in between. The
     frame was insurance -- a compositor that sees an unmap and a map together is
     free to fold them into no change at all, and then nothing is raised -- and
     it was bought at the dock's expense: for that frame this app has no window
     up, which is what a dock reads as not running, so an unpinned icon leaves it
     and the icons beside it close over the space. Measured on mutter, three
     runs out of three from the dock and two out of two from behind another
     window, the window comes back with the focus either way. */
  remapping = true;
  win.hide();

  /* A window taken down while it was minimised keeps that state in Ozone --
     hide() unmaps it and leaves it kMinimized, measured -- and showing it in
     that state ends the process, the whole of it:
       FATAL wayland_toplevel_window.cc:806 "Should not be called with
       kMinimized state"
     so the un-minimising is done here, between the two, while nothing is up.
   *
   * Here rather than before the hide, which is where it used to be and is
   * the whole of the notification that flashed. Wayland has no unminimise:
   * Ozone spends a restore as an activation request, and a request from a
   * window the owner is not using is exactly what focus stealing prevention
   * is for -- the shell refuses it, marks the window as wanting attention
   * and posts "WhatsApp is ready", then withdraws it a frame later when the
   * re-map takes the focus honestly. Asking on behalf of a window with no
   * surface up asks the compositor for nothing, so there is nothing to
   * refuse and nothing to announce.
   *
   * isMinimized() is the right question and the only one: it reads the very
   * state Ozone refuses to be shown in, which is not the same thing as
   * whether the window is in the dock. The tracked flag deliberately is not
   * consulted -- it answers the other question, and restoring a window that
   * is merely maximised would un-maximise it. */
  if (win.isMinimized()) win.restore();

  win.show();
  win.focus();
  /* Cleared a turn later, so that the events the show and the focus raise both
     find the trick still in progress. */
  setTimeout(() => { remapping = false; }, 0);
};

const hideWindow = () => {
  if (!win || win.isDestroyed()) return;
  win.hide();
};

/* The tray's one item, and the whole of what it does -- for the hosts that
   deliver a click on the icon itself, where there is no menu and so no word to
   have promised anything. GNOME is not one of them: it opens the menu instead,
   and there the item acts on the word it is wearing (see tray-sni.js).
 *
 * "In front" rather than "on screen", because a window sitting behind the editor
 * is one the owner is asking for, not one they are asking to put away. */
const toggleWindow = () => {
  if (windowInFront()) hideWindow();
  else showWindow();
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

/* One switch, moved. The settings window asks for this over IPC and the debug
   rig asks for it directly, so both go the same way through the same redraws --
   which is what makes a switch testable without a mouse. */
const changeSetting = (key, value) => {
  config.set(key, value);
  config.save();
  if (key === 'view.zoom' && win && !win.isDestroyed()) {
    win.webContents.setZoomFactor(Number(value) || 1.0);
  }
  if (key === 'view.font-size' || key === 'view.chat-font-size') applyStyle();
  return true;
};

/* Answers with the window, so a caller that wants to look at it -- the debug
   rig, which cannot press Ctrl+, -- has something to look at. */
const openSettings = () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return settingsWin;
  }

  const isDark = nativeTheme.shouldUseDarkColors;
  /* An ordinary window, not one as tall as the screen. This used to be sized to
     the panel -- tall enough that every switch fitted without a scroll -- which
     on a laptop meant a column of settings from the top of the work area to the
     bottom of it for a handful of switches. The panel scrolls; a window this
     size is what the owner asked for, and it is what the settings window of
     anything else on the desktop looks like. */
  const panel = clampToScreen(560, 660);
  const settingsFont = config.get('view.font') || desktop.interfaceFont();
  settingsWin = new BrowserWindow({
    width: panel.width,
    height: panel.height,
    /* Asked for the middle of the screen. Honoured on X11; on Wayland a client
       does not place its own windows and getBounds answers 0,0 whatever is
       asked -- GNOME centres a new window there of its own accord. */
    center: true,
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
      /* The desktop's font here as well, so the client's own window does not
         arrive in Chromium's default while the page beside it is drawn in the
         family the user chose. This covers whatever falls through to a generic
         family; settings.html is told the name outright and puts it first. */
      defaultFontFamily: {
        standard: settingsFont, sansSerif: settingsFont, serif: settingsFont,
      },
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

  return settingsWin;
};

/* What the page is drawn with. Lifted out of applyStyle because a call moved
   into a window of its own is a second page of WhatsApp's, and it is this
   client's font it should be drawn in too. */
const styleSheet = () => {
  const family = config.get('view.font') || desktop.interfaceFont();
  const wanted = {
    fontSize: config.get('view.font-size'),
    chatScale: config.get('view.chat-font-size'),
  };
  /* What the last sheet said, so this one can contradict it. A sheet inserted at
     user origin cannot be removed again -- see style.js -- so a switch turned
     off is a rule that has to be written, not one that can be left out. */
  const sheet = style.build(wanted, drawnWith);
  drawnWith = wanted;
  return [
    sheet,
    config.get('view.force-font') ? style.aliasSheet(pageFontStack, family) : '',
  ].filter(Boolean).join('\n');
};

const drawStyle = async () => {
  if (!win || win.isDestroyed()) return;
  const family = config.get('view.font') || desktop.interfaceFont();
  const css = styleSheet();

  /* Every sheet, not just the last one: a key that fails to come out is worth
     saying so about, because what it leaves behind is a rule the user cannot
     get rid of from Settings. */
  const stale = cssKeys;
  cssKeys = [];
  for (const key of stale) {
    try {
      await win.webContents.removeInsertedCSS(key);
    } catch (e) { /* the page navigated; the old sheet went with it */ }
  }

  /* USER origin, which is the one level whose !important beats the page's own.
     An author-level sheet loses to WhatsApp's !important rules, and that is the
     difference between the desktop font being used and being ignored. */
  if (css) cssKeys.push(await win.webContents.insertCSS(css, { cssOrigin: 'user' }));
  /* Kept reachable so the scroll probe can measure the page without it. */
  require('./main-css.js').track(win, () => cssKeys[cssKeys.length - 1] || null,
                                 key => { cssKeys = key ? [key] : []; });
  console.log('drawing in %s at %dpx%s', family, config.get('view.font-size'),
              pageFontStack ? '' : ' (waiting for the page to say what it asks for)');
};

/* One at a time. Inserting a stylesheet and taking the old one out is two round
   trips to the renderer, and a second call arriving in between is what left two
   sheets in the page. */
let styling = Promise.resolve();
const applyStyle = () => {
  styling = styling.catch(() => {}).then(drawStyle);
  return styling;
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
  win.loadURL(WHATSAPP_URL);

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

  traceWindowState();

  win.once('ready-to-show', () => {
    if (!hidden) showWindow();
    pushFocus();
  });

  /* ------------------------------------------------------------- the page */

  win.webContents.on('did-finish-load', async () => {
    loadedAt = Date.now();
    if (pendingChat) {
      win.webContents.send('wa:open-link', { phone: pendingChat.phone, wantsText: !!pendingChat.text });
      pendingChat = null;
    }
    if (pendingInvite) {
      win.webContents.send('wa:open-invite', { code: pendingInvite });
      pendingInvite = '';
    }
    await applyStyle();
    win.webContents.setZoomFactor(Number(config.get('view.zoom')) || 1);
    win.webContents.send('wa:config', {
      notifications: !!config.get('notifications.enabled'),
      downloadStickers: config.get('media.download-stickers') !== false,
      hideControlsWhenPaused: config.get('media.hide-controls-when-paused') !== false,
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
    setTimeout(() => win && !win.isDestroyed() && win.loadURL(WHATSAPP_URL), 5000);
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
     have ended up.
   *
   * The client's own pages are the exception, and refusing them was a bug with a
   * dialog attached: "Move to new window" in a call is a window.open, and a page
   * handed null back from one reads that as the browser blocking pop-ups and
   * says exactly that. So WhatsApp gets the window it asked for. */
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (!isOwnPage(url)) {
      openExternally(url);
      return { action: 'deny' };
    }
    return { action: 'allow', overrideBrowserWindowOptions: popupOptions(features) };
  });

  win.webContents.on('did-create-window', adoptPopup);

  win.webContents.on('will-navigate', (event, url) => {
    /* A link this file knows how to act on is acted on, even when isWhatsApp
       would have waved it through: chat.whatsapp.com ends in whatsapp.com and is
       still the invite page rather than the client, and letting the window
       navigate to it would put a page with a "Download" button and no address
       bar where the chat list was, with no way back.
     *
     * The client's own pages are asked about first and never answered for. Not
     * because one would arrive here -- loadURL does not raise will-navigate --
     * but because `/accept?code=` is a link this file recognises AND the URL
     * openGroupInvite loads, and a route from one to the other is a loop waiting
     * for the day some navigation does come through. */
    const link = isOwnPage(url) ? null : links.from(url);
    if (link) { event.preventDefault(); openLink(link, 'a link in the page'); return; }
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
    const host = new URL(url).hostname;
    return host === 'web.whatsapp.com' || host.endsWith('.whatsapp.com') || host === 'whatsapp.com';
  } catch (e) {
    return false;
  }
};

/* Narrower than isWhatsApp, and deliberately so. faq.whatsapp.com is WhatsApp
   as well, and it is still a page for a browser rather than for a window of
   this client's: there is no address bar here and no way back. What this answers
   true for is the client itself, and the URLs a page of it opens that carry no
   origin of their own. */
const isOwnPage = url => {
  if (!url) return true;
  if (url.startsWith('blob:') || url.startsWith('data:') || url.startsWith('about:')) return true;
  try {
    return new URL(url).hostname === 'web.whatsapp.com';
  } catch (e) {
    return false;
  }
};

/*
 * A link this client is not showing, handed to whatever does show it -- with one
 * exception. A wa.me link is a chat and a chat.whatsapp.com link is a group
 * invite, and sending the owner out to a browser so that the browser can hand
 * either straight back is a round trip nobody asked for. Those are opened here.
 * See src/links.js.
 */
const openExternally = url => {
  const link = links.from(url);
  if (link) { openLink(link, 'a link in the page'); return; }
  if (/^https?:|^mailto:|^tel:/i.test(url)) shell.openExternal(url).catch(() => {});
};

/* A chat asked for before there was a page to ask, and the message that came
   with it. The message is held here rather than sent to the page and asked for
   back: it is this process's to type, and a channel the page can put words into
   is a channel that can be made to type them. */
let pendingChat = null;
let pendingText = '';
let pendingInvite = '';

/*
 * A chat, opened by phone number rather than by clicking a row in the list --
 * which is the only way to reach somebody who is not in it yet.
 *
 * The page does the work, through WhatsApp's own openChatWithContact, so this
 * costs no reload: measured on the live client, the conversation changed in
 * about a second with the URL still at web.whatsapp.com. The window is raised
 * first because a link followed from a browser is somebody asking for this
 * client, not for a chat to change behind a tray icon.
 */
const openLinkedChat = (chat, why) => {
  if (!chat || !win || win.isDestroyed()) return;
  console.log('opening a chat with +%s%s (%s)', chat.phone,
              chat.text ? ' with a message ready to send' : '', why);
  showWindow();
  /* A link that started this client arrives before there is a page to tell, and
     a send into a window still loading is a send into nothing. It is held and
     handed over by did-finish-load; the page waits from there for WhatsApp's own
     modules, which take a few seconds more. */
  pendingText = chat.text || '';
  if (loadedAt) win.webContents.send('wa:open-link', { phone: chat.phone, wantsText: !!pendingText });
  else pendingChat = chat;
};

/*
 * A group invite, put up where the client already is.
 *
 * The chunk that only /accept loads was the reason this used to be a reload, and
 * the page fetches that chunk itself now: see openInvite in src/page/inject.js
 * for what was measured. The dialog is WhatsApp's own, it comes up over the chat
 * list in about a second, and nothing is joined until the button in it is
 * pressed. The reload is still here, one message away, for the morning
 * WhatsApp's module names change.
 *
 * The window is raised first for the same reason a linked chat raises it: a link
 * followed from a browser is somebody asking for this client, not for a dialog
 * behind a tray icon.
 */
const openGroupInvite = (code, why) => {
  if (!code || !win || win.isDestroyed()) return;
  console.log('opening a group invite (%s)', why);
  showWindow();
  /* An invite that started this client arrives before there is a page to tell;
     did-finish-load hands it over, and the page waits from there for WhatsApp's
     own modules. */
  if (loadedAt) win.webContents.send('wa:open-invite', { code });
  else pendingInvite = code;
};

/* Which of the two a link turned out to be. Everything that follows a link --
   the command line, a second copy's argv, macOS's event, a click in the page --
   comes through here so that the answer is decided in one place. */
const openLink = (link, why) => {
  if (!link) return;
  if (link.invite) openGroupInvite(link.invite, why);
  else openLinkedChat(link, why);
};

/* ----------------------------------------------------------------- popups */

/* WhatsApp opens one window of its own: the call, moved out of the chat list by
   "Move to new window". It comes through window.open on the client's own origin,
   so it is allowed -- and then it is this client's window to dress, because
   Chromium's default is an untitled box with Electron's icon and the wrong
   font. */
const popups = new Set();

const popupOptions = features => {
  const family = config.get('view.font') || desktop.interfaceFont();
  /* WhatsApp says how big it wants the window; a size of this client's choosing
     is only put on one that did not ask. */
  const sized = /(^|,)\s*(width|height)\s*=/i.test(features || '');
  return {
    ...(sized ? {} : { width: 480, height: 640 }),
    title: TITLE,
    icon: appIcon,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b141a' : '#ffffff',
    webPreferences: {
      /* Spelled out rather than left to what a child window inherits. The preload
         is not optional here: without it navigator.gpu stays, and that is a call
         window whose video comes through black -- see src/page/inject.js. The
         marker is how the preload tells this window from the client, which is a
         distinction the page cannot be trusted to make for it. */
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: ['--wa-popup'],
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',
      defaultFontFamily: { standard: family, sansSerif: family, serif: family },
      defaultFontSize: config.get('view.font-size'),
      /* Never throttled, and said out loud because a child window inherits what
         it is not told. This was tried the other way round for one build, on the
         theory that a call window has nothing that must keep running -- and a
         call window has the call. Wayland's compositor marks a window suspended
         the moment something covers it, Chromium throttles a suspended page when
         it is allowed to, and "switch to video" went from answering on the click
         to answering seconds later. */
      backgroundThrottling: false,
    },
  };
};

const adoptPopup = popup => {
  popups.add(popup);
  popup.on('closed', () => {
    popups.delete(popup);
    debug.trace('popup: closed, %d left', popups.size);
  });
  popup.on('close', () => debug.trace('popup: asked to close'));

  const contents = popup.webContents;

  contents.on('did-finish-load', async () => {
    debug.trace('popup: loaded %s', contents.getURL());
    contents.setZoomFactor(Number(config.get('view.zoom')) || 1);
    const css = styleSheet();
    if (css) await contents.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
  });

  /* Whatever this window opens in turn is a link, not a call. */
  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (isWhatsApp(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  contents.on('before-input-event', (event, input) => onPopupKey(popup, event, input));

  console.log('WhatsApp asked for a window of its own; %dx%d',
              popup.getBounds().width, popup.getBounds().height);
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

/* A call window answers to fewer keys than the client does, and reload is not
   among them: the call itself lives in the window that opened this one, so a
   popped-out call reloaded is an empty window with no way back to it. */
const onPopupKey = (popup, event, input) => {
  if (input.type !== 'keyDown' || popup.isDestroyed()) return;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();

  if (ctrl && key === 'q') { event.preventDefault(); quit(); return; }
  if (ctrl && key === 'w') { event.preventDefault(); popup.close(); return; }
  if (ctrl && input.shift && key === 'i') {
    event.preventDefault();
    popup.webContents.toggleDevTools();
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

/* Every call this client is ringing for. A ringing banner is ongoing -- it
   names something still happening, so nothing about reading a chat takes it
   down -- and until now the only thing that did was the ringing stopping. A
   call answered by opening the window instead of by clicking the banner
   therefore left the banner in the notification centre for the rest of the
   session. Arriving at the client is dealing with the call, whichever chat is
   on screen, so it counts as an answer too. */
const ringingBanners = new Set();

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
/* The ringing, taken down because the owner is here. Deliberately not keyed on
   the chat: the call is being dealt with in the client whether or not its
   conversation is the one on screen. */
const withdrawRinging = () => {
  if (!banners || !ringingBanners.size) return;
  for (const id of [...ringingBanners]) {
    ringingBanners.delete(id);
    if (banners.closeMessage(id)) console.log('withdrew the ringing: the client is open');
  }
};

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

/* --------------------------------------------------- the store's own answers */

/*
 * Everything below reads WhatsApp's own state rather than a picture of it.
 * There is no age guard anywhere in it, and that absence is the point: a guard
 * belongs in front of an inference, and none of these is one. A chat whose
 * unread count WhatsApp just changed has been read; a message whose type
 * WhatsApp just rewrote to `revoked` has been taken back. The guards that used
 * to sit here -- ARRIVAL_SETTLE_MS, a 2.5s grace, a 3s sweep -- were each there
 * because the chat list answers late, and each of them was a second or more of
 * a notification sitting on screen for a message the user had already read on
 * their phone.
 */

/* A chat read down to `unread` messages.
 *
 * WhatsApp counts the messages still waiting, and the ones it is counting are
 * the last ones in the conversation -- so five unread becoming two means the
 * oldest three have been read, and it does not matter at all which device read
 * them. That is partial read handling, and it needs nothing from the read side
 * but a number. Zero takes the chat's banners with it. */
const storeRead = (chatId, unread) => {
  if (!banners || !chatId) return;
  const held = banners.countFor(chatId);
  if (!held) return;
  const closed = banners.trim(chatId, unread);
  if (!closed) return;
  console.log('withdrew %d notification(s) for %s: %s', closed,
              chatTitles.get(chatId) || chatId,
              unread ? unread + ' message(s) still unread' : 'it has been read');
};

/* The conversation on screen. An answer from WhatsApp, and one it gives whether
   or not the window is drawn -- which is what the old reading of aria-selected
   could not do, and why leaving a chat took a beat to register and swallowed the
   next message to land in it. */
const storeActive = chatId => {
  activeChatId = chatId || '';
  if (!banners || !activeChatId) return;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible() || win.isMinimized() || !win.isFocused()) return;
  const closed = banners.trim(activeChatId, 0);
  if (closed) console.log('withdrew %d notification(s) for %s: it is the chat on screen',
                          closed, chatTitles.get(activeChatId) || activeChatId);
};

/* Everything still waiting, asked for outright rather than waited for. The
   events above are the whole story while the client is listening; this is for
   the spell where it was not -- a laptop out of suspend, a socket that dropped
   and came back -- where the only thing that can be trusted is the answer now. */
const storeUnread = map => {
  if (!banners || !map || typeof map !== 'object') return;
  for (const key of banners.keys()) storeRead(key, Number(map[key]) || 0);
};

/* Whether the store's banners are this client's to raise.
 *
 * Deliberately unlike bannersAreOurs: that one refuses while the window is away,
 * because WhatsApp Web raises its own notification then and dressing both would
 * be two banners for one message. The store has no such rival -- the shim
 * swallows WhatsApp's notification while the store is live -- so this path is
 * the one that runs in every window state, which is what makes a message id and
 * a chat id available for a message that arrived into the tray. */
const storeBannersAreOurs = () => {
  if (!storeLive || !banners) return false;
  if (!config.get('notifications.enabled')) return false;
  if (Date.now() - loadedAt < STARTUP_GRACE_MS) {
    console.log('notification skipped: the client is still syncing');
    return false;
  }
  return true;
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
  /* And nothing at all while the store is answering. This is the last of the
     three ways into the old path and it was the one left open: the two obvious
     ones -- the watcher's nudge and the shim over WhatsApp's own notifications
     -- were shut, and a message still arrived twice, with two tones behind it.
     A count going up is a guess that something arrived, and a guess raises a
     banner whose identity is the chat, the sender and the text; the store's
     carries a message id. Nothing deduplicates across those two, so the guess
     was announcing a second time every message the store had already named. */
  if (!storeLive &&
      chats > unreadChats &&
      Date.now() - lastArrivalAt > TITLE_FALLBACK_MS &&
      bannersAreOurs()) {
    describeThenNotify();
  }
  unreadChats = chats;

  /* The badge and the tray, and neither of them while the store is answering.
     The title counts unread CHATS and leaves muted ones out of even that --
     measured "(3)" against six unread chats holding eleven messages -- while
     the store counts the messages themselves. Two places writing one number
     from answers that disagree is how an icon ends up marked unread with
     nothing behind it. */
  if (storeLive) {
    if (win && !win.isDestroyed()) win.setTitle(title && title.trim() ? title : TITLE);
    return;
  }

  /* The title dropping its prefix is the one unambiguous statement WhatsApp
     makes about unread: everything has been read. It is taken as such, and the
     page's count is reset with it rather than left to expire on its own. */
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
      zoom: Number(config.get('view.zoom')) || 1.0,
      fontSize: Number(config.get('view.font-size')) || 16,
      chatFontSize: Number(config.get('view.chat-font-size')) || 100,
      /* The family the client draws the page in, so this window can be drawn in
         it too rather than in whatever Chromium picks for a plain page. */
      font: config.get('view.font') || desktop.interfaceFont(),
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

  ipcMain.handle('settings:set', (_, key, value) => changeSetting(key, value));

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

  /* The page could not find WhatsApp's own modules for opening a chat, so it is
     asked for the page WhatsApp serves for the purpose. A reload, and the last
     resort: it is what still works on the morning those module names change. */
  ipcMain.on('wa:link-unresolved', (event, chat) => {
    const phone = links.digitsOf(chat && chat.phone);
    if (!phone || !win || win.isDestroyed()) return;
    const query = 'phone=' + encodeURIComponent(phone) +
                  (pendingText ? '&text=' + encodeURIComponent(pendingText) : '');
    pendingText = '';
    console.log('loading WhatsApp\'s own send page for +%s', phone);
    win.loadURL('https://web.whatsapp.com/send?' + query).catch(() => {});
  });

  /* The dialog the page could not draw, on the page WhatsApp draws it on. This
     is the old behaviour entire, and it is reached only when the modal's module
     names have stopped answering -- a reload, which is why it is last. */
  ipcMain.on('wa:invite-unresolved', (event, invite) => {
    const code = links.inviteOf(invite && invite.code);
    if (!code || !win || win.isDestroyed()) return;
    console.log('loading WhatsApp\'s own invite page for %s', code);
    win.loadURL('https://web.whatsapp.com/accept?code=' + encodeURIComponent(code)).catch(() => {});
  });

  /* The composer is up and empty, so the message the link carried can go in.
     Not with execCommand from the page: an evaluated script has no user gesture
     behind it and WhatsApp's editor takes the call and stays empty -- measured,
     and the same finding the #type probe in debug.js is written around.
     insertText goes in through the path a keyboard uses, and only this process
     can call it. */
  ipcMain.on('wa:composer-ready', () => {
    if (!pendingText || !win || win.isDestroyed()) return;
    win.webContents.focus();
    win.webContents.insertText(pendingText);
    console.log('put the link\'s message in the composer (%d characters)', pendingText.length);
    pendingText = '';
  });

  /* The chat list watcher nudges us for every message it sees land, which is what
     makes a banner per message possible at all. The document title cannot do that
     job: its number counts unread CHATS, so the second and third message from one
     person leave "(1) WhatsApp" exactly as it was and nothing fires. */
  ipcMain.on('wa:arrival', () => {
    /* Refused outright while the store is answering. This nudge is the chat-list
       watcher's, and the watcher stops sending it then -- this is the second
       half of that gate, so a report already in flight when the store came up
       does not turn into a duplicate banner. */
    if (storeLive) return;
    if (!bannersAreOurs()) return;
    lastArrivalAt = Date.now();
    describeThenNotify();
  });

  /* A notification WhatsApp Web itself decided to raise, intercepted in the page
     and handed over with the sender's picture already fetched. The click goes
     back to the page, whose own handler opens the conversation. */
  ipcMain.on('wa:page-notification', (event, note) => {
    if (storeLive) return;
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
      body: bidi.line(sender, message, mark),
      redacted: bidi.words(mark, kindOf(message)),
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

  /* ------------------------------------------------ WhatsApp's own store */

  ipcMain.on('wa:store-ready', (event, state) => {
    const ready = !!(state && state.ready);
    if (ready === storeLive) return;
    storeLive = ready;
    if (!ready) {
      console.log('WhatsApp\'s store is not answering; the chat list watcher is in charge');
      return;
    }
    /* What the chat list had been reporting is not carried over: it speaks in
       display names and the store speaks in chat ids, and a mixed set is a set
       nothing can withdraw from. The store's own report of what is unread
       follows immediately behind this. */
    unreadChatNames = new Set();
    for (const timer of withdrawing.values()) clearTimeout(timer);
    withdrawing.clear();
  });

  /* One message, as WhatsApp described it: a message id, a chat id, the sender
     when there is one, and a mark for what kind of thing arrived. Nothing here
     is parsed out of a sentence -- the "Sender: message" split that a
     notification body used to need, and the heuristic that decided a direct
     message reading "the link is https://..." came from somebody called "the
     link is https", are both gone with the body they were reading. */
  ipcMain.on('wa:store-message', (event, note) => {
    if (!note || !note.chat || !note.title) return;
    if (!storeBannersAreOurs()) return;

    chatTitles.set(note.chat, note.title);
    if (chatTitles.size > 512) chatTitles.delete(chatTitles.keys().next().value);

    const mark = note.mark ? note.mark.trim() : '';
    /* The mark and the words, in that order, and either of them may be missing:
       a photo with no caption is its mark alone, and a message of words has none
       at all. */
    const said = [mark, note.text].filter(Boolean).join(' ');
    /* And a message aimed at the user says so in front of the sender, in
       WhatsApp's own words: "Replied to you: Mega: تيست". It opens the line
       rather than standing above it, and the line is all there is -- a banner
       broken into two paragraphs loses everything under the first one in the
       notification centre, which is the note on BREAKS in bidi.js. */
    const aimed = note.aimed ? String(note.aimed).trim() : '';

    /* Two ways to put a name in front of a line, and the difference is not
       cosmetic. A message is "Mega: نتقابل بكرة" -- the colon says Mega SAID
       this. A reaction is "Mega reacted 😂 to: ..." -- Mega said none of it,
       this client is describing what they did, and a colon after the name would
       claim otherwise. Either way the mark opens the line, the name is isolated
       and pinned to the left margin, and the message keeps its own direction
       inside an isolate of its own. */
    const body = note.join === 'space' ? bidi.did(note.sender, said, aimed)
                                       : bidi.line(note.sender, said, aimed);
    const banner = banners.show({
      /* The message and no other. This used to be the chat, the sender and the
         text hashed together, which is as close to a message's identity as
         reading a chat list can get -- and it cost a genuinely repeated message
         inside two minutes, because two identical sentences hash the same. A
         message id is the thing itself. */
      identity: note.msg,
      msgId: note.msg,
      /* Keyed on the chat ID. Every withdrawal below speaks the same identity,
         so a banner can always be taken down -- which a key made of a display
         name could not promise, with two chats sharing one. */
      key: note.chat,
      title: bidi.paragraph(note.title),
      body,
      /* What the banner may say with previews turned off. The page names it when
         the mark alone would not -- a reaction has no mark, and "New message" is
         the wrong thing to call one. */
      redacted: bidi.words(aimed, note.redacted || mark || 'New message'),
      icon: note.avatar,
      onClick: () => {
        showWindow();
        /* The message travels with the click, and a story travels with a flag
           saying so: a story mention landed in `status@broadcast` along with
           everybody else's updates, and opening that chat is not what the user
           asked for by clicking it. The page opens the story itself. */
        if (win && !win.isDestroyed())
          win.webContents.send('wa:store-open', { chat: note.chat, name: note.title,
                                                  preview: note.text, msg: note.msg,
                                                  story: !!note.story });
      },
    });
    if (!banner) return;
    console.log('raised: %s in %s%s', note.why === 'reaction' ? 'a reaction'
                : mark || 'a message of words', note.title,
                note.mention ? ' (addressed to you)' : '');
    playTone();
  });

  /* A message landing in the conversation the user is looking at, on screen and
     in front of them. Nothing: no banner, and no tone either. The bubble was
     drawn under their eyes as it arrived and there is nothing left for an
     announcement to tell them -- which is the owner's own rule for this case,
     stated twice. A tone was put here for a moment, on the reasoning that
     WhatsApp's own had been muted and the case would otherwise go silent, and
     silent is exactly what it is meant to be. */
  /* A telephone ringing, which is the one banner here that announces something
     still happening rather than something that has happened.
   *
   * It is an ordinary banner and deliberately so. Keeping one on the screen for
   * the whole of a call needs critical urgency, and GNOME's rule for a critical
   * banner is that it stands until it is acted on -- the pointer moving over it
   * and away, which is how every other banner is waved off, does nothing to it
   * at all. The owner asked for the pointer to work. So this behaves like any
   * other: it shows, it is waved away or slides off by itself, and it waits in
   * the notification centre -- where it can still be clicked to take the call --
   * until the ringing stops and it is withdrawn.
   *
   * No tone. WhatsApp Web rings for an incoming call through its own audio and
   * this client has never muted that -- playing one here would be a second
   * sound over the first. */
  ipcMain.on('wa:store-ringing', (event, note) => {
    if (!note || !note.chat || !note.title || !note.call) return;
    if (!storeBannersAreOurs()) return;

    chatTitles.set(note.chat, note.title);

    const banner = banners.show({
      /* The call, not the message. The banner for a call that was missed is
         keyed on the message it was written into, so the two live side by side
         for the moment it takes one to replace the other. */
      identity: 'ring' + SEP + note.call,
      msgId: 'ring' + SEP + note.call,
      key: note.chat,
      /* Not a message, so nothing about the chat being read takes it down. */
      ongoing: true,
      title: bidi.paragraph(note.title),
      body: bidi.line(note.sender, note.mark),
      redacted: note.mark,
      icon: note.avatar,
      onClick: () => {
        showWindow();
        if (win && !win.isDestroyed())
          win.webContents.send('wa:store-open', { chat: note.chat, name: note.title });
      },
    });
    if (!banner) return;
    ringingBanners.add('ring' + SEP + note.call);
    console.log('ringing: %s in %s', note.mark, note.title);
  });

  /* And the ringing stopping, whatever stopped it. What follows -- a banner for
     the call that was missed, and then everything held while it rang -- is not
     this handler's business. */
  ipcMain.on('wa:store-ring-over', (event, note) => {
    if (!storeLive || !note || !note.call || !banners) return;
    ringingBanners.delete('ring' + SEP + note.call);
    if (banners.closeMessage('ring' + SEP + note.call))
      console.log('the telephone has stopped ringing in %s',
                  chatTitles.get(note.chat) || note.chat);
  });

  ipcMain.on('wa:store-open-arrival', () => {
    if (!storeBannersAreOurs()) return;
    console.log('a message in the chat on screen: nothing raised, and nothing played');
  });

  /* Read. Here, on the phone, or on another desktop -- WhatsApp does not say
     which and it does not matter. */
  ipcMain.on('wa:store-read', (event, state) => {
    if (!storeLive || !state) return;
    storeRead(state.chat, Number(state.unread) || 0);
  });

  ipcMain.on('wa:store-active', (event, state) => {
    if (!storeLive || !state) return;
    storeActive(state.chat || '');
  });

  ipcMain.on('wa:store-unread', (event, map) => {
    if (!storeLive) return;
    storeUnread(map);
  });

  /* Deleted for everyone. The banner for that one message comes down and nothing
     is raised in its place -- the phone withdraws it silently, and a notification
     announcing that a message the user never read has been deleted tells them
     about a message twice over and about its contents not at all. */
  ipcMain.on('wa:store-gone', (event, state) => {
    if (!storeLive || !state || !state.msg || !banners) return;
    const closed = banners.closeMessage(state.msg);
    if (!closed) return;
    /* The two things that take one notification down rather than a chat's worth
       of them, told apart in the log because they are told apart nowhere else:
       a message deleted for everyone, and a reaction taken back or read. */
    console.log('withdrew %d notification(s) in %s: %s', closed,
                chatTitles.get(state.chat) || state.chat || 'a chat',
                String(state.msg).startsWith('reaction') ? 'the reaction is gone'
                                                         : 'the message was deleted');
  });

  ipcMain.on('wa:store-count', (event, count) => {
    if (!storeLive || !count || typeof count.messages !== 'number') return;
    unreadMessages = count.messages;
    setBadge(count.messages);
    if (tray) tray.setAttention(count.messages > 0);
  });

  /* The conversation on screen, reported by the page when it changes and again
     whenever the window comes back. This is the signal that takes a banner down
     the moment the user opens the chat -- the unread report below cannot: it is
     refused for the first few seconds of a banner's life, and it is sent only
     when the answer changes, so those few seconds used to be for ever. */
  ipcMain.on('wa:open-chat', (event, name) => {
    if (storeLive) return;
    openChat = typeof name === 'string' ? name : '';
    withdrawOpen();
  });

  /* Which chats still have something unread, reported by the page whenever the
     answer changes. A notification is an unread message made visible, so when
     the message stops being unread the notification has no business staying on
     screen -- and it stops being unread whether it was read here or on the
     phone, because WhatsApp Web clears the pill either way. */
  ipcMain.on('wa:unread-chats', (event, names) => {
    if (storeLive) return;
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
    if (storeLive) return;
    if (!count || typeof count.messages !== 'number') return;
    unreadMessages = count.messages;
    setBadge(count.messages);
    if (tray) tray.setAttention(count.messages > 0);
  });
};

/* Where the chooser opens: the folder the last download was pointed at, and
   ~/Downloads until there has been one. Checked rather than trusted -- a folder
   remembered from a removable disk that is not mounted this time would open the
   dialog on nothing. */
const downloadStart = () => {
  const kept = String(config.get('media.download-dir') || '');
  try { if (kept && fs.statSync(kept).isDirectory()) return kept; } catch (e) {}
  return app.getPath('downloads');
};

const rememberDownloadDir = dir => {
  if (!dir || dir === config.get('media.download-dir')) return;
  config.set('media.download-dir', dir);
  config.save();
};

/* A download asks where it should go, every time.
 *
 * This used to drop every file in ~/Downloads without a word, on the reasoning
 * that a phone does the same. The owner asked for the chooser instead -- "لما
 * اعمل download لحاجه ... يقولي اختار الفولدر اللي عايز تعمل download فيه
 * وتيجي كل مره" -- and this is the half a phone gets wrong on a desktop: a
 * file saved somewhere you chose is filed, and a file in ~/Downloads is one
 * more thing to find later.
 *
 * The dialog is not raised here. Electron shows the desktop's own save dialog
 * for any download whose save path is left unset, so the work is to NOT set one
 * and to dress the dialog it puts up: the name WhatsApp sent, in the folder the
 * last one went to. Cancelling it cancels the download, which is Chromium's
 * behaviour and the right one -- there is nowhere to put the file.
 *
 * With the switch off it goes back to what it did: ~/Downloads, no dialog, and
 * a number on the end of a name that is already taken rather than a file
 * quietly written over. */
const wireDownloads = ses => {
  ses.on('will-download', (event, item) => {
    const name = item.getFilename();

    if (config.get('media.ask-where-to-save') !== false) {
      item.setSaveDialogOptions({ defaultPath: path.join(downloadStart(), name) });
      item.once('done', (e, state) => {
        /* Cancelled is the dialog waved away, and it is a normal answer here
           rather than a failure: nothing is saved, and the log says which of
           the two happened so a missing file is not a mystery. */
        if (state !== 'completed') { console.log('download %s: %s', state, name); return; }
        const saved = item.getSavePath();
        console.log('downloaded %s', saved);
        rememberDownloadDir(path.dirname(saved));
      });
      return;
    }

    const downloads = app.getPath('downloads');
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
  /* Where a whatsapp: link lands. xdg-open starts a second copy with the URL on
     its command line; the lock sends that copy home and its argv arrives here. */
  const link = links.inArgv(argv);
  if (link) { openLink(link, 'a link from the desktop'); return; }
  /* A whatsapp: URL this client cannot act on still raised the window and did
     nothing else, which reads from the outside as the link having been eaten --
     and for group invites it was exactly that, for a year. There is nowhere to
     send one, because this client holds the scheme and the browser would hand it
     straight back, so the verb goes in the log instead: the next report of a
     link that went nowhere then says which one. */
  for (const arg of argv) {
    const verb = links.unhandled(arg);
    if (verb) console.log('nothing here opens a whatsapp: "%s" link', verb);
  }
  /* A --hidden launch that finds one already running exits without raising the
     window: that is the login autostart arriving on top of a client the user
     started themselves. */
  if (!argv.includes('--hidden')) showWindow();
});

/* macOS delivers the same thing as an event rather than as argv. Nothing here
   runs there yet, and one line costs less than the next person finding out. */
app.on('open-url', (event, url) => {
  const link = links.from(url);
  if (!link) return;
  event.preventDefault();
  openLink(link, 'a link from the desktop');
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

  /* The scheme, and the link that may have asked for this window in the first
     place. Both after createWindow, because the second one needs somewhere to
     put the chat. */
  console.log('whatsapp: links -> %s',
              links.claim(app, APP_ID, { enabled: config.get('links.claim-scheme') !== false }));
  const launchedFor = links.inArgv(process.argv);
  if (launchedFor) openLink(launchedFor, 'the link this client was started for');

  tray = new TrayIcon({
    normal: iconFile(24, `status/${APP_ID}-tray.png`),
    attention: iconFile(24, `status/${APP_ID}-tray-attention.png`),
    onToggle: toggleWindow,
    /* Shown and put away are separate here, rather than one toggle, because the
       menu decides which of the two it is offering when it opens and the click
       has to do what the word said -- not what has become true in the seconds
       the menu spent open. */
    onShow: showWindow,
    onHide: hideWindow,
    /* Asked again as the menu opens, so the item cannot be caught wearing the
       wrong word because an event went missing. */
    getInFront: windowInFront,
    onQuit: quit,
    onSettings: openSettings,
    onSetTheme: setTheme,
    getTheme: () => config.get('view.theme') || 'system',
    title: TITLE,
    appId: APP_ID,
  });
  /* The tray is built after the window, so the events that would have told it
     where the window is have already been and gone. */
  tray.setInFront(windowInFront());

  debug.install(() => win, () => banners,
                { show: showWindow, toggle: toggleWindow, onScreen: windowOnScreen,
                  inFront: windowInFront, settings: openSettings, set: changeSetting });

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
