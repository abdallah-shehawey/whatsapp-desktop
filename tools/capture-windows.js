/*
 * The pictures of the client's own windows, for the README and the site.
 *
 * Each window is opened at the size the client itself opens it at, with the
 * preload it really uses and a main process that answers the same IPC -- so the
 * picture is the window, not a mock-up of it. What is faked is only the state
 * behind it: a theme, a set of switches, and an update check that has already
 * come back, because a capture must not depend on a session or on the network.
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
/* The same family the client would draw these windows in, so the picture is the
   window as this machine draws it and not a rendering in Chromium's default. */
const desktop = require('../src/desktop.js');
/* The real catalogue, so the picture shows the font picker with this machine's
   own families in it rather than an empty dropdown. */
const fonts = require('../src/fonts.js');
const manifest = require('../package.json');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

/* The fonts window is photographed with both scripts *chosen*, not inheriting.
   Left on the defaults every control below the switch is dimmed and the two
   previews are the same font, which is a picture of the feature turned off. The
   families are picked from what this machine actually has, so the picker beside
   them is the real catalogue and the two preview lines really are drawn in the
   two faces named. */
const pick = (list, wanted) => {
  const names = list.map(font => font.name);
  return wanted.find(name => names.includes(name)) || names[0] || '';
};
const installed = fonts.installed();
const shownLatin = pick(installed.latin, ['Adwaita Sans', 'Cantarell', 'Inter', 'Noto Sans']);
const shownArabic = pick(installed.arabic, ['Noto Naskh Arabic', 'Noto Sans Arabic', 'Vazirmatn']);

ipcMain.handle('settings:get', () => ({
  theme: 'dark',
  autostart: true,
  closeToTray: true,
  minimizeToTray: false,
  notifyEnabled: true,
  notifySound: true,
  outgoingSound: false,
  zoom: 1.0,
  fontSize: 16,
  font: desktop.interfaceFont(),
  fonts: {
    desktop: desktop.interfaceFont(),
    systemArabic: fonts.defaultFor('ar'),
    latin: { inherit: false, family: shownLatin, size: 100, bold: false, italic: false },
    arabic: { inherit: false, family: shownArabic, size: 105, bold: false, italic: false },
    available: installed,
  },
}));
ipcMain.handle('settings:set-theme', () => true);
ipcMain.handle('settings:set-autostart', () => true);
ipcMain.handle('settings:set', () => true);
ipcMain.on('settings:close', () => {});

/* About, with a check that has already been answered. The window asks the
   moment it loads, and a picture taken while it says "Checking…" is a picture
   of a spinner; so the answer is here from the start and `checkNow` is off.
   "Up to date" is the state a reader should recognise -- the other one is a
   version number that would be wrong the day after it was taken. */
ipcMain.handle('about:get', () => ({
  name: 'WhatsApp',
  version: manifest.version,
  icon: '../data/icons/128/apps/io.github.shehawey.whatsapp-desktop.png',
  license: manifest.license,
  author: String(manifest.author || '').replace(/\s*<[^>]*>/, ''),
  electron: process.versions.electron,
  chromium: process.versions.chrome,
  node: process.versions.node,
  theme: 'dark',
  font: desktop.interfaceFont(),
  update: { newer: false, current: manifest.version, latest: manifest.version },
  checkNow: false,
}));
ipcMain.handle('about:check-update', () => ({
  newer: false, current: manifest.version, latest: manifest.version,
}));
ipcMain.on('about:open', () => {});
ipcMain.on('about:close', () => {});

/* Every window the client can open, at the size it opens it at -- see
   openSettings, openFonts and openAbout in src/main.js. The fonts left the
   settings window on 2026-09-03 and About arrived beside them, so a single
   picture is no longer the whole of what this client can be told. */
const WINDOWS = [
  { name: 'settings', file: 'settings.html', preload: 'settings-preload.js', width: 560, height: 660 },
  { name: 'fonts',    file: 'fonts.html',    preload: 'settings-preload.js', width: 560, height: 720 },
  { name: 'about',    file: 'about.html',    preload: 'about-preload.js',    width: 430, height: 610 },
];

const shoot = ({ name, file, preload, width, height }, ssDir) => new Promise(resolve => {
  const win = new BrowserWindow({
    width,
    height,
    /* Frameless, like the window the client opens: capturePage takes the web
       contents, and a frame here would only shrink them. */
    frame: false,
    /* Shown, and not captured out of sight: a window that is never mapped is
       never painted on Wayland, and capturePage then waits for a frame that
       does not come. */
    show: true,
    webPreferences: {
      preload: path.join(__dirname, '../src', preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  win.loadFile(path.join(__dirname, '../src', file));

  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
        /* Grown -- or shrunk -- to exactly what it has to say, so the picture
           is the whole window and not the top of a scroller with a switch cut
           in half at the bottom, or a card floating over empty space.
           `scrollHeight` alone cannot answer this: the scroller is `flex: 1`,
           so a container with room to spare reports the room, not the content.
           What is measured instead is the bottom of the last thing in it. */
        const grow = await win.webContents.executeJavaScript(`(() => {
          const box = document.querySelector('.container');
          const last = box && box.lastElementChild;
          if (!last) return 0;
          const needed = last.getBoundingClientRect().bottom + box.scrollTop
            - box.getBoundingClientRect().top
            + parseFloat(getComputedStyle(box).paddingBottom);
          return Math.ceil(needed - box.clientHeight);
        })()`);
        if (grow) {
          const [w, h] = win.getContentSize();
          win.setContentSize(w, Math.max(320, h + grow));
          await new Promise(done => setTimeout(done, 400));
        }
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ssDir, name + '.png'), image.toPNG());
        console.log('CAPTURED_OK %s', name);
      } catch (e) {
        console.error('Capture error:', e);
      }
      win.destroy();
      resolve();
    }, 1000);
  });
});

/* Three windows, one after the other -- and Electron quits by itself the moment
   the last one closes, which is exactly the gap between them. Held open here so
   the later pictures are taken at all. */
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const ssDir = path.join(__dirname, '../screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

  /* One at a time: two windows up together would be two pictures of whichever
     of them the compositor decided to paint. */
  for (const window of WINDOWS) await shoot(window, ssDir);
  app.exit(0);
});
