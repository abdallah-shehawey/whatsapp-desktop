/*
 * The tray icon.
 *
 * Electron talks StatusNotifierItem over DBus here, which on GNOME needs the
 * AppIndicator extension (appindicatorsupport@rgcjonas.gmail.com) to have a
 * host listening. The GTK client had to speak that protocol by hand over GDBus
 * -- GTK4 has no tray at all and libayatana-appindicator is packaged for
 * GTK2/GTK3 only -- and this is the one part of it Electron simply provides.
 *
 * Click is not delivered on Linux: SNI hosts open the menu instead. So every
 * action lives in the menu, including the one that shows the window.
 */
'use strict';

const { Tray, Menu, nativeImage } = require('electron');

class TrayIcon {
  constructor({ normal, attention, onShow, onHide, onQuit, title = 'WhatsApp' }) {
    this.icons = {
      normal: nativeImage.createFromPath(normal),
      attention: nativeImage.createFromPath(attention || normal),
    };
    this.handlers = { onShow, onHide, onQuit };
    this.title = title;
    this.unread = false;
    this.windowVisible = false;

    this.tray = new Tray(this.icons.normal);
    this.tray.setToolTip(title);
    this.tray.on('click', () => this.handlers.onShow && this.handlers.onShow());
    this.render();
  }

  render() {
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: this.windowVisible ? 'Hide WhatsApp' : 'Open WhatsApp',
        click: () => (this.windowVisible ? this.handlers.onHide : this.handlers.onShow)(),
      },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'Ctrl+Q', click: () => this.handlers.onQuit && this.handlers.onQuit() },
    ]));
    this.tray.setToolTip(this.unread ? `${this.title} — unread messages` : this.title);
    this.tray.setImage(this.unread ? this.icons.attention : this.icons.normal);
  }

  /* Marked, never counted: WhatsApp's own title counts unread CHATS, not
     messages, so a number drawn from it would be wrong for exactly the case a
     number is wanted. */
  setAttention(unread) {
    if (unread === this.unread) return;
    this.unread = unread;
    this.render();
  }

  setWindowVisible(visible) {
    if (visible === this.windowVisible) return;
    this.windowVisible = visible;
    this.render();
  }

  destroy() { try { this.tray.destroy(); } catch (e) {} }
}

module.exports = { TrayIcon };
