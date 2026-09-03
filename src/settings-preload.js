'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTheme: theme => ipcRenderer.invoke('settings:set-theme', theme),
  setAutostart: enable => ipcRenderer.invoke('settings:set-autostart', enable),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  close: () => ipcRenderer.send('settings:close'),
  /* Only the font section asks for this, and only when the client has said a
     restart would finish what it started -- see changeSetting in main.js. */
  restart: () => ipcRenderer.send('settings:restart'),
  onSettingsChanged: callback => {
    ipcRenderer.on('settings:changed', (_, data) => callback(data));
  },
});
