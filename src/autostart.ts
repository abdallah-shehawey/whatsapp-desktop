/*
 * Autostart management for Linux desktops.
 *
 * Reads and writes ~/.config/autostart/io.github.shehawey.whatsapp-desktop.desktop
 * while respecting any system-wide entry in /etc/xdg/autostart/.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

export const APP_ID = 'io.github.shehawey.whatsapp-desktop';
const USER_AUTOSTART_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
const USER_DESKTOP_PATH = path.join(USER_AUTOSTART_DIR, `${APP_ID}.desktop`);
const SYS_DESKTOP_PATH = path.join('/etc', 'xdg', 'autostart', `${APP_ID}.desktop`);

const isEnabled = () => {
  if (fs.existsSync(USER_DESKTOP_PATH)) {
    try {
      const content = fs.readFileSync(USER_DESKTOP_PATH, 'utf8');
      if (/Hidden\s*=\s*true/i.test(content) || /X-GNOME-Autostart-enabled\s*=\s*false/i.test(content)) {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  if (fs.existsSync(SYS_DESKTOP_PATH)) {
    try {
      const content = fs.readFileSync(SYS_DESKTOP_PATH, 'utf8');
      if (/Hidden\s*=\s*true/i.test(content) || /X-GNOME-Autostart-enabled\s*=\s*false/i.test(content)) {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  return false;
};

const setEnabled = (enable: any) => {
  try {
    fs.mkdirSync(USER_AUTOSTART_DIR, { recursive: true, mode: 0o700 });
  } catch (e) {}

  if (enable) {
    const desktopEntry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=WhatsApp',
      'Comment=Start WhatsApp in the background at login',
      'Exec=whatsapp-desktop --hidden',
      'Icon=io.github.shehawey.whatsapp-desktop',
      'Terminal=false',
      'NoDisplay=true',
      'X-GNOME-Autostart-enabled=true',
      'X-GNOME-Autostart-Delay=5',
      'Hidden=false',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(USER_DESKTOP_PATH, desktopEntry, { mode: 0o644 });
      return true;
    } catch (e) {
      if (e instanceof Error) console.warn('autostart: could not write %s: %s', USER_DESKTOP_PATH, e.message);
      return false;
    }
  } else {
    if (fs.existsSync(SYS_DESKTOP_PATH)) {
      const maskEntry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=WhatsApp',
        'Hidden=true',
        'X-GNOME-Autostart-enabled=false',
        '',
      ].join('\n');
      try {
        fs.writeFileSync(USER_DESKTOP_PATH, maskEntry, { mode: 0o644 });
        return true;
      } catch (e) {
        if (e instanceof Error) console.warn('autostart: could not mask %s: %s', USER_DESKTOP_PATH, e.message);
        return false;
      }
    } else {
      try {
        if (fs.existsSync(USER_DESKTOP_PATH)) {
          fs.unlinkSync(USER_DESKTOP_PATH);
        }
        return true;
      } catch (e) {
        return false;
      }
    }
  }
};

export { isEnabled, setEnabled, USER_DESKTOP_PATH };
