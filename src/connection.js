/* Keep a local page visible while WhatsApp is unreachable. Retrying in the
 * background avoids replacing it with Chromium's empty network-error page. */
'use strict';

const { pathToFileURL } = require('url');

const attach = (win, { url, file, ipcMain, probe, retryMs = 5000 }) => {
  const contents = win.webContents;
  const localURL = pathToFileURL(file).href;
  const isLocal = value => String(value || contents.getURL()).split('?')[0] === localURL;
  let offline = false;
  let timer = null;
  let checking = null;

  const alive = () => !win.isDestroyed() && !contents.isDestroyed();
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    if (checking) checking.abort();
    checking = null;
    offline = false;
  };
  const schedule = () => {
    if (offline && alive() && !timer) timer = setTimeout(retry, retryMs);
  };
  const state = busy => {
    if (alive() && isLocal()) contents.send('wa:connection-check', busy);
  };
  const retry = async () => {
    if (!offline || !alive() || checking) return;
    clearTimeout(timer);
    timer = null;
    const controller = new AbortController();
    checking = controller;
    state(true);
    try {
      const reachable = await probe(controller.signal);
      if (checking !== controller || !offline || !alive()) return;
      if (reachable) {
        stop();
        win.loadURL(url).catch(() => {}); // did-fail-load restores the local page
      }
    } catch (err) {
      // Still offline, or the window navigated/closed while checking.
    } finally {
      if (checking === controller) {
        checking = null;
        state(false);
        schedule();
      }
    }
  };
  const failed = (event, code, description, failedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    try { if (new URL(failedURL).origin !== new URL(url).origin) return; }
    catch (err) { return; }
    console.warn('load failed (%d %s); showing the connection page', code, description);
    stop();
    offline = true;
    contents.setBackgroundThrottling(true);
    win.loadFile(file).catch(err => console.warn('connection page: %s', err.message));
    schedule();
  };
  const navigated = (event, destination) => {
    if (!isLocal(destination)) stop();
  };
  const requested = event => {
    if (event.sender === contents && event.senderFrame?.url && isLocal(event.senderFrame.url) && isLocal()) retry();
  };
  contents.on('did-fail-load', failed);
  contents.on('did-navigate', navigated);
  ipcMain.on('wa:connection-retry', requested);
  contents.once('destroyed', () => {
    stop();
    ipcMain.removeListener('wa:connection-retry', requested);
  });

  return {
    isLocal: () => isLocal(),
    start: () => win.loadFile(file, { query: { connecting: '1' } }).then(() => {
      if (alive() && isLocal()) return win.loadURL(url);
    }).catch(() => {}),
  };
};

module.exports = { attach };
