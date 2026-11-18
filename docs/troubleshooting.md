# Troubleshooting

## No tray icon on GNOME

GNOME doesn't have a system tray of its own. Install and enable the
[AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/)
extension. If the client starts before the extension at login, it waits for the
extension and then adds the icon.

## Notifications show the wrong name, or no icon

GNOME reads a notification's name and icon from the app's installed `.desktop`
file. If you run the client from a source tree without installing it, you get
the title `io.github.shehawey.whatsapp-desktop` and an empty icon. To fix this,
run `make install`.

## Notifications reach the list but never pop up

Run `notify-send hello world`. If that doesn't pop up either, the problem is
in the desktop settings, not the client. GNOME hides pop-ups while a window is
fullscreen, while Do Not Disturb is on, or when notification banners are turned
off.

## "Chat on WhatsApp" links open in a browser tab

`wa.me` and `api.whatsapp.com` links ask the browser to open a `whatsapp://`
link, and this client handles those links. Firefox-based browsers show a prompt
for this every time. Check *Always allow https://api.whatsapp.com to open
whatsapp links*, then click *Open Link*. Chromium-based browsers show a similar
prompt.

Links that go straight to `web.whatsapp.com` never pass through the
`whatsapp://` scheme, so they always open in the browser.

## Black screen when sharing your screen

Some Wayland compositors give a black screen share. Set
`[system] force-x11 = true` to run through XWayland, then restart the client.

## The session freezes or the window stays blank

Some graphics drivers hang with GPU acceleration. Set
`[system] hardware-acceleration = false`, then restart the client.

## Global shortcuts don't work

If the desktop has already assigned the same key combination to something else,
the client logs a message at startup and runs without that shortcut. Set a
different combination in `[shortcuts]`. On Wayland the desktop owns the
binding, so you can also change it in your desktop's keyboard settings.

## Reporting a bug

Open an [issue](https://github.com/abdallah-shehawey/whatsapp-desktop/issues/new/choose)
and include the version (from *About*), your distribution, and how you
installed the client. Run `whatsapp-desktop` from a terminal to see its log.
Don't include phone numbers, message text or session files.
