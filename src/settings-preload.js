'use strict';

/* The bridge for the client's own windows -- Settings and Fonts. One preload
   for both: they ask the same client the same questions, and `close` shuts
   whichever of them asked, so neither needs a channel of its own. */
const { contextBridge, ipcRenderer } = require('electron');

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
