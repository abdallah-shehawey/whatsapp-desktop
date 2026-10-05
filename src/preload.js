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

/* Two kinds of window load this. The client, with the chat list in it, and the
   call WhatsApp has moved out into a window of its own -- which the app marks
   when it lets the pop-up through. The call window gets the video fix and
   nothing else: the watcher, the notification shim and the tone all belong to
   the window that has a chat list, and a second copy of them announcing the same
   arrival is two banners for one message. */
if (process.argv.includes('--wa-popup')) {
  page.fixVideo();
} else {
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

  page.start({ send, on });
}
