const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
/* The same family the client would draw this window in, so the picture is the
   window as this machine draws it and not a rendering in Chromium's default. */
const desktop = require('../src/desktop.js');
/* The real catalogue, so the picture shows the font picker with this machine's
   own families in it rather than an empty dropdown. */
const fonts = require('../src/fonts.js');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-dev-shm-usage');

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
    latin: { inherit: true, family: '', size: 100, bold: false, italic: false },
    arabic: { inherit: true, family: '', size: 100, bold: false, italic: false },
    available: fonts.installed(),
  },
}));
ipcMain.handle('settings:set-theme', () => true);
ipcMain.handle('settings:set-autostart', () => true);
ipcMain.handle('settings:set', () => true);
ipcMain.on('settings:close', () => {});

/* Both of the client's own windows, at the sizes the client itself opens them
   at -- see openSettings and openFonts in src/main.js. The fonts left the
   settings window on 2026-09-03, so a single picture is no longer the whole of
   what this client can be told. */
const WINDOWS = [
  { name: 'settings', file: 'settings.html', width: 560, height: 660 },
  { name: 'fonts', file: 'fonts.html', width: 560, height: 720 },
];

const shoot = ({ name, file, width, height }, ssDir) => new Promise(resolve => {
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
      preload: path.join(__dirname, '../src/settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  win.loadFile(path.join(__dirname, '../src', file));

  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      try {
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

/* Two windows, one after the other -- and Electron quits by itself the moment
   the last one closes, which is exactly the gap between them. Held open here so
   the second picture is taken at all. */
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const ssDir = path.join(__dirname, '../screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

  /* One at a time: two windows up together would be two pictures of whichever
     of them the compositor decided to paint. */
  for (const window of WINDOWS) await shoot(window, ssDir);
  app.exit(0);
});
