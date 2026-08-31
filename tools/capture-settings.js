const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
/* The same family the client would draw this window in, so the picture is the
   window as this machine draws it and not a rendering in Chromium's default. */
const desktop = require('../src/desktop.js');

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
  chatFontSize: 100,
  font: desktop.interfaceFont(),
}));
ipcMain.handle('settings:set-theme', () => true);
ipcMain.handle('settings:set-autostart', () => true);
ipcMain.handle('settings:set', () => true);
ipcMain.on('settings:close', () => {});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    /* The size the client itself opens this window at (see openSettings), so
       the picture on the landing page is the window, not a rendering of it. */
    width: 560,
    height: 660,
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

  const ssDir = path.join(__dirname, '../screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });

  win.loadFile(path.join(__dirname, '../src/settings.html'));

  win.webContents.on('did-finish-load', async () => {
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ssDir, 'settings.png'), image.toPNG());
        console.log('CAPTURED_OK');
      } catch (e) {
        console.error('Capture error:', e);
      }
      app.exit(0);
    }, 1000);
  });
});
