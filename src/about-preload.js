'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getAbout: () => ipcRenderer.invoke('about:get'),
  checkUpdate: () => ipcRenderer.invoke('about:check-update'),
  /* A name, never a URL: the page asks for "site", "source" or "update" and the
     main process decides where each of those goes. Nothing this window says can
     put an arbitrary address in front of the desktop's browser. */
  open: where => ipcRenderer.send('about:open', where),
  close: () => ipcRenderer.send('about:close'),
  onAboutChanged: callback => {
    ipcRenderer.on('about:changed', (_, data) => callback(data));
  },
});
