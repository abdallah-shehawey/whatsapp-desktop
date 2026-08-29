const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

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
  arabicFix: false,
  zoom: 1.0,
  fontSize: 16,
}));
ipcMain.handle('settings:set-theme', () => true);
ipcMain.handle('settings:set-autostart', () => true);
ipcMain.handle('settings:set', () => true);
ipcMain.on('settings:close', () => {});

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 560,
    height: 640,
    show: false,
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