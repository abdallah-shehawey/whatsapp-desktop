'use strict';

const { contextBridge, ipcRenderer: ipcRender } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setTheme: (theme: any) => ipcRenderer.invoke('settings:set-theme', theme),
  setAutostart: (enable: any) => ipcRenderer.invoke('settings:set-autostart', enable),
  setSetting: (key: any, value: any) => ipcRenderer.invoke('settings:set', key, value),
  close: () => ipcRenderer.send('settings:close'),
  onSettingsChanged: (callback: (arg0: any) => void) => {
    ipcRender.on('settings:changed', (_: any, data: any) => callback(data));
  },
});
