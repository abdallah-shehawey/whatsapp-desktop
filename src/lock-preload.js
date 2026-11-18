'use strict';

const { contextBridge, ipcRenderer } = require('electron');

require('./brand.js').brandDocument(document);

contextBridge.exposeInMainWorld('api', {
  unlock: passcode => ipcRenderer.invoke('lock:unlock', passcode),
  getTheme: () => ipcRenderer.invoke('lock:get-theme'),
});
