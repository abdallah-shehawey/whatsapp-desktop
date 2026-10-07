/*
 * The bridge between the page and the app.
 *
 * This runs in WhatsApp Web's own world (contextIsolation is off) so the page
 * script can be a plain require, and it runs before any of WhatsApp's own
 * JavaScript -- which the notification shim depends on. Node stays in module
 * scope: nothing here is put on window except the two hooks the app calls back
 * into, so the page cannot reach ipcRenderer or require.
 */
'use strict';

const { ipcRenderer } = require('electron');
const page = require('./page/inject.js');
const fontFaces = require('./page/font-faces.js');
const { pathToFileURL } = require('url');
const path = require('path');

ipcRenderer.on('wa:font-faces', (_, css) => fontFaces.apply(document, css));

/* Two kinds of window load this. The client, with the chat list in it, and the
   call WhatsApp has moved out into a window of its own -- which the app marks
   when it lets the pop-up through. The call window gets the video fix and
   nothing else: the watcher, the notification shim and the tone all belong to
   the window that has a chat list, and a second copy of them announcing the same
   arrival is two banners for one message. */
if (process.argv.includes('--wa-popup')) {
  page.fixVideo();
} else {
  /* Install the palette while the document is being created. The main process
     still draws its user-origin sheet after load and on setting changes; this
     early author sheet uses the same marks so it switches off with Default. */
  const initialTheme = ipcRenderer.sendSync('wa:initial-theme');
  if (initialTheme && (initialTheme.css || initialTheme.fontFaces)) {
    const applyTheme = () => {
      const root = document.documentElement;
      if (!root) return false;
      fontFaces.apply(document, initialTheme.fontFaces);
      if (initialTheme.css) {
        const sheet = document.createElement('style');
        sheet.id = 'wa-initial-theme';
        sheet.textContent = initialTheme.css;
        root.appendChild(sheet);
      }
      for (const [name, value] of Object.entries(initialTheme.attributes)) {
        if (value !== null) root.setAttribute(name, value);
      }
      return true;
    };
    if (!applyTheme()) {
      const observer = new MutationObserver(() => {
        if (applyTheme()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  }

  const send = (channel, payload) => ipcRenderer.send('wa:' + channel, payload);
  const on = (channel, handler) =>
    ipcRenderer.on('wa:' + channel, (event, payload) => handler(payload));

  /* The app owns top-level focus, including restoring a hidden window and
     waiting for the notification centre's grab to close. Calling native focus
     here as well bypasses that coordination: Wayland can reject it and post
     "WhatsApp is ready" before the app gets a chance to show the window. */
  window.focus = function () {
    send('focus-request', null);
  };

  if (location.href.split('?')[0] === pathToFileURL(path.join(__dirname, 'connection.html')).href) {
    document.addEventListener('DOMContentLoaded', async () => {
      const button = document.getElementById('connection-retry');
      if (new URLSearchParams(location.search).has('connecting')) {
        document.getElementById('connection-title').textContent = 'Connecting to WhatsApp';
        document.getElementById('connection-message').textContent = 'Your chats will appear when the connection is ready.';
        button.disabled = true;
      }
      button.addEventListener('click', () => send('connection-retry'));
      window.addEventListener('online', () => send('connection-retry'));
      on('connection-check', busy => {
        button.disabled = busy;
        button.textContent = busy ? 'Checking connection…' : 'Try again';
      });
      const settings = await ipcRenderer.invoke('settings:get');
      const root = document.documentElement;
      root.dataset.theme = settings.theme;
      root.style.setProperty('--font-family', settings.font);
      const palette = settings.palettes[settings.theme];
      if (palette) {
        root.dataset.theme = 'dark';
        root.style.setProperty('--bg-primary', palette.bg);
        root.style.setProperty('--text-primary', palette.text);
        root.style.setProperty('--accent', palette.accent);
      }
    });
  } else {
    page.start({ send, on });
  }
}
