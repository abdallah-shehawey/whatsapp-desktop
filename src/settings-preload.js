'use strict';

/* The bridge for the client's own windows -- Settings and Fonts. One preload
   for both: they ask the same client the same questions, and `close` shuts
   whichever of them asked, so neither needs a channel of its own. */
const { contextBridge, ipcRenderer } = require('electron');

require('./brand.js').brandDocument(document);

/* The window is transparent and the page draws its corners -- only when the
   client says so, because it is only transparent on Wayland (see panelWindow
   in main.js). Marked as the <html> element arrives, before anything paints,
   so the window is never seen square first. */
if (process.argv.includes('--rounded-panel')) {
  const round = () => document.documentElement.classList.add('rounded');
  if (document.documentElement) round();
  else new MutationObserver((_, watch) => {
    if (document.documentElement) { round(); watch.disconnect(); }
  }).observe(document, { childList: true });
}

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTheme: theme => ipcRenderer.invoke('settings:set-theme', theme),
  setAutostart: enable => ipcRenderer.invoke('settings:set-autostart', enable),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  close: () => ipcRenderer.send('settings:close'),
  /* Only the Fonts window asks for this, and only when the client has said a
     restart would finish what it started -- see changeSetting in main.js. */
  restart: () => ipcRenderer.send('settings:restart'),
  /* The passcode rows. Setting one and clearing one both go through the client,
     which is the only side that has the salt and the hash. */
  openCustomCss: () => ipcRenderer.invoke('custom-css:open'),
  lockNow: () => ipcRenderer.send('lock:now'),
  cacheSize: () => ipcRenderer.invoke('storage:size'),
  clearCache: () => ipcRenderer.invoke('storage:clear'),
  lockStatus: () => ipcRenderer.invoke('lock:status'),
  setPasscode: passcode => ipcRenderer.invoke('lock:set-passcode', passcode),
  removePasscode: passcode => ipcRenderer.invoke('lock:remove-passcode', passcode),
  onSettingsChanged: callback => {
    ipcRenderer.on('settings:changed', (_, data) => callback(data));
  },
});
