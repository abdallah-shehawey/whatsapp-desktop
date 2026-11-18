'use strict';

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
