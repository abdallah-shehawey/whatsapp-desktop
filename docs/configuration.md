# Configuration

You can set every option in the Settings window (`Ctrl+,`) and the Fonts window
(in the tray menu), and changes take effect right away. They're saved to an INI
file, which you can also edit by hand:

```
~/.config/whatsapp-desktop/whatsapp-desktop.conf
```

Every key is optional. Booleans accept `true`/`false`, `yes`/`no`, `on`/`off`
or `1`/`0`. Comments start with `#` or `;`.

```ini
[view]
theme = nord
chat-cards = true

[privacy]
auto-blur = true
```

## `[view]`

| Key | Default | Description |
|---|---|---|
| `theme` | `system` | `system`, `dark` or `light`, or one of the palettes `oled`, `nord`, `catppuccin`, `dracula`, `tokyonight`. |
| `follow-desktop-accent` | `true` | Use the accent color from pywal/wallust or Hyprland, if either one has set it. |
| `font` | desktop font | Font family for everything the client draws. |
| `font-size` | `16` | Base font size in pixels. WhatsApp sizes its text in `rem`, so this scales the whole interface. |
| `zoom` | `1.0` | Page zoom. `Ctrl` `+` / `-` / `0` change it too. |
| `force-font` | `true` | Draw the whole page in a single font family. |
| `custom-css` | `false` | Load `custom.css` from the same folder, after all other styles. The page redraws when you save the file. |
| `chat-cards` | `false` | Show each chat in the list as a raised card. |

## `[fonts]`

| Key | Default | Description |
|---|---|---|
| `latin-inherit` | `true` | Use the desktop font for Latin text. Set it to `false` to use the keys below. |
| `latin-family` | desktop font | Font family for Latin letters, digits and punctuation. |
| `latin-size` | `100` | Size, as a percentage of the family's normal size. |
| `latin-bold`, `latin-italic` | `false` | Use the family's bold or italic face. Only works if the font actually has one. |
| `arabic-inherit` | `true` | The same switch for Arabic. |
| `arabic-family` | system Arabic font | Font family for Arabic, including Arabic words inside an English line. |
| `arabic-size` | `100` | Size of Arabic text. |
| `arabic-bold`, `arabic-italic` | `false` | Same as for Latin. |

## `[window]`

| Key | Default | Description |
|---|---|---|
| `remember-size` | `true` | Save the window's size and whether it's maximized, and on X11 also its position and monitor. Turn it off for tiling window managers, or if you keep this file in git. |
| `maximized` | `false` | Open the window maximized. |
| `width`, `height` | `1200`, `800` | Window size, which is also the size it goes back to when you un-maximize it. |
| `x`, `y`, `display-id` | empty | Where the window was on X11, and on which monitor. Empty leaves it to the desktop. If that monitor is gone, the window opens in the middle of the primary one. Wayland doesn't let apps place their own windows, so these stay empty there. |

`[settings-window]`, `[fonts-window]` and `[about-window]` take the same `x`,
`y` and `display-id` keys for those three windows, also only on X11 and only
while `remember-size` is on.

## `[behaviour]`

| Key | Default | Description |
|---|---|---|
| `close-to-tray` | `true` | Closing the window keeps the client running in the tray. |
| `minimize-to-tray` | `false` | Minimizing the window hides it to the tray. |
| `spellcheck` | `true` | Chromium's spell checker in the message box. |
| `spellcheck-languages` | `en-US` | Comma-separated list using Chromium's language codes. Chromium has no Arabic dictionary, so `ar` isn't available. |
| `mpris` | `true` | Show voice notes as a media player, so headset buttons and media keys control them. |
| `raise` | `auto` | How the window is brought to the front when you click a notification: `auto`, `activate` or `remap`. |

## `[shortcuts]`

Global shortcuts work even when the window isn't focused. They use
[Electron's accelerator syntax](https://www.electronjs.org/docs/latest/api/accelerator).
Leave a value empty to turn that shortcut off.

| Key | Default | Description |
|---|---|---|
| `global` | `true` | Set to `false` to turn off both global shortcuts. |
| `toggle` | `Super+Alt+W` | Show or hide the window. |
| `mute-call` | `Super+Alt+M` | Mute or unmute your microphone in a call. |

## `[privacy]`

| Key | Default | Description |
|---|---|---|
| `stealth` | `false` | Blur the conversation. This is what `Ctrl+Alt+P` toggles, and it stays on after a restart. |
| `auto-blur` | `false` | Blur whenever the window isn't focused. |
| `hover-reveal` | `true` | While blurred, keep the line under the mouse pointer readable. |
| `blur-contacts` | `true` | Blur the chat list and the chat header too, not only the messages. |

## `[lock]`

| Key | Default | Description |
|---|---|---|
| `enabled` | `false` | The client sets this when you add or remove a passcode. Don't edit it by hand. |
| `timeout` | `15` | Minutes of inactivity before the window locks. Use `0` to turn off the timer. |
| `on-system-lock` | `true` | Also lock when the desktop locks or the computer suspends. |

The passcode isn't stored in this file. A PBKDF2 hash of it is kept in
`security.json` (mode 0600) next to the config file. The lock hides the window
and keeps message text out of notifications, but it **doesn't** encrypt the
session data in `~/.local/share/whatsapp-desktop`.

## `[notifications]`

| Key | Default | Description |
|---|---|---|
| `enabled` | `true` | Set to `false` to let Chromium show WhatsApp's own notifications instead. |
| `sound` | `true` | Play a sound with the client's notifications. |
| `outgoing-sound` | `false` | Play WhatsApp's sound when you send a message. |
| `whatsapp-sound` | `false` | Also play WhatsApp's own sound for incoming messages. |
| `banner-seconds` | `12` | How long a notification stays on screen before it moves to the notification list. |
| `hide-preview` | `false` | Show only the chat name and the type of message, never the text. |

## `[media]`

| Key | Default | Description |
|---|---|---|
| `ask-where-to-save` | `true` | Ask where to save each download. When off, downloads go to `~/Downloads`. |
| `download-dir` | — | The client saves the last folder you used here. |
| `download-stickers` | `true` | Download stickers even when WhatsApp's auto-download for photos is off. |
| `hide-controls-when-paused` | `true` | Remove the media player from the desktop when you pause a voice note. |

## `[links]`

| Key | Default | Description |
|---|---|---|
| `claim-scheme` | `true` | Open `whatsapp:` links in this client instead of a browser tab. |

## `[system]`

You need to restart the client after changing these.

| Key | Default | Description |
|---|---|---|
| `force-x11` | `false` | Run through XWayland. Try this if screen sharing shows a black screen. |
| `hardware-acceleration` | `true` | Set to `false` to draw without the GPU, for graphics drivers that hang. |

## `[updates]`

| Key | Default | Description |
|---|---|---|
| `check` | `true` | Check GitHub once a day for a new release. The *Check* button in About works either way. |
