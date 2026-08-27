# whatsapp-desktop

WhatsApp Web in a window of its own, on Chromium. It loads `web.whatsapp.com`,
so it is the same client WhatsApp serves to a browser — no reverse-engineered
protocol, and nothing that puts an account at risk.

It is the second attempt. The first, [`whatsapp`](../whatsapp), is 120 KB of C
against GTK4 and WebKitGTK, and every hard thing about it was WebKit: an empty
clipboard for pasted images, a user agent rewritten behind the application's
back, a view in a hidden window reporting itself focused, a disk cache that kept
none of the emoji sheets, and line boxes that shaved the tails off Arabic. This
one starts from an engine that does none of that, and keeps the parts of the
first that were never about WebKit at all — which is most of the notification
story, and all of what makes it feel like the desktop it runs on.

## What it does

- **Draws everything in the desktop's own font.** Chromium picks its defaults
  from fontconfig, which answers with the system default rather than with the
  font chosen in Settings — so the choice is read from GSettings and pushed in
  two ways: as Chromium's default families, and as a user stylesheet. User
  origin is the point. `!important` in a user sheet is the one thing that beats
  `!important` in the page, which is exactly how a browser set to ignore page
  fonts behaves, and matching that browser is the whole idea.
- **Lives in the tray.** Closing the window hides it and the client stays
  connected; Ctrl+Q and the tray's own Quit are the two ways out. It can start
  hidden at login, with the page loaded and notifications arriving before any
  window is on screen.
- **One notification per message**, with the sender, the text and the sender's
  picture on it, and a click that opens the conversation it came from and brings
  the window back from the tray.
- **Follows the desktop live** — dark or light from `color-scheme`, and a font
  changed in Settings is applied without a restart.
- Links open in the desktop's browser; downloads land in `~/Downloads` without a
  dialog; `Ctrl` `+`/`-`/`0` zoom and the size is remembered.

## Notifications

This is where nearly all of the first client's scar tissue lives, and it is
carried over line for line in `src/page/inject.js`. There are two halves, split
on where the focus is.

*While the window is away*, WhatsApp Web raises its own notification, and it is
by far the better judge: it knows the sender, the text, the mute state, and that
what arrived is a message rather than a typing indicator or something sent from
the phone. What it cannot do is dress one, or bring a window back from the tray.
So the page's `Notification` is intercepted, the sender's face is fetched, and
the app raises the banner itself.

*While the window is in front*, WhatsApp stays silent — it can see it has the
user's attention — so the client watches the chat list instead: one banner per
message, and none at all for the conversation already on screen. The document
title cannot do that job, because its number counts unread *chats*: a second and
third message from the same person leave `(1) WhatsApp` exactly as it was.

Three things then decide whether the message that just landed is in the chat on
screen, because being wrong there is silence rather than noise: `#main` exists
only while a conversation is open, `aria-selected` always resolves to exactly one
row, and a row still wearing an unread pill cannot be the chat on screen, since
WhatsApp clears that pill the moment it draws a chat in a focused window.

Two things had to be unlearned. **Unread is not the same as new** — the app asks
what arrived more often than messages land, and every ask the watcher could not
answer used to fall through to "the topmost unread row", which announced one
chat's last message over and over while the user sat reading another. And **a
group says it differently**: a direct chat leaves `typing...` in the list, a group
leaves `Mega is typing...`, and matching only the first shape made a group
announce somebody starting to write as though they had said something.

**Banners come down on the client's own clock.** GNOME reads the `expire_timeout`
of a notification and throws it away: a banner leaves the screen when the user has
been active *and* the pointer is not resting on it. Since the shell shows one at a
time, queues three behind it and drops the rest, a single banner parked under an
idle mouse pointer silently swallows every message that follows — measured on the
GTK client, six notifications with no banner and no sound between them, including
one sent at critical urgency, and the moment the stuck one went away the next one
rang. Each banner is closed after twelve seconds and the message posted again at
LOW urgency, which the shell files in the notification centre without a banner and
without a sound. Nothing is lost and nothing blocks.

## What Chromium made unnecessary

Three of the GTK client's fixes are simply gone, and it is worth writing down
which, so nobody adds them back:

- **The clipboard shim.** WebKitGTK handed the page an empty `clipboardData` for
  images — a real Ctrl+V fired `paste` with `types=[] items=[] files=[]` — so the
  bytes had to be lifted off the GTK clipboard and dispatched into the page by
  hand. Chromium's clipboard is not broken.
- **The `document.hasFocus` override.** WebKit reported a view in a window hidden
  in the tray as focused, and the truth had to be pushed in from the app; getting
  it wrong in either direction costs either every notification or every read
  receipt. Chromium reports it correctly — measured here: hidden gives
  `hasFocus: false`, shown gives `true`. Only the watcher's own idea of focus is
  pushed in now.
- **The emoji sprite cache.** Nothing kept WhatsApp's 152 sprite sheets between
  runs — WebKit's disk cache stored not one of them — so every launch pulled
  4.7 MB down again and the emoji panel sat full of blank squares. Chromium's HTTP
  cache keeps them.

## Memory

Measured on this machine, both sitting on the same signed-out `web.whatsapp.com`
page, summed PSS across every process of each:

| | |
|---|---|
| Zen (fresh profile, one tab) | **353 MB** |
| whatsapp-desktop | **247 MB** |

Electron is the lighter of the two here, which is the opposite of its reputation:
a browser carries a browser's UI, its extension machinery and its own process
model, and this carries one page. The number to watch is a signed-in session over
days rather than a login screen — but the starting point is not the handicap it is
usually assumed to be.

## Install

```sh
make install        # ~/.local, plus a desktop entry and icons
make autostart      # also start hidden at login
make no-autostart   # undo just the autostart part
make test           # replay a chat list past the watcher; no browser, no account
make run            # run it from the source tree
```

`make install` stages a self-contained tree under `$PREFIX/lib/whatsapp-desktop`:
a copy of Electron with its binary **renamed**, the app under `resources/app`
where that binary looks for it, and a two-line launcher in `bin`. The rename is
not cosmetic — Electron takes the application name from the name of the
executable, and that name becomes the window's `app_id`, which is how the desktop
matches a window to its `.desktop` file and so to its icon and its name in the
switcher. Left as `electron`, every window belongs to Electron.

It also drops 53 of Chromium's 55 UI translations, keeping `en-US` and `ar`.
They are 45 MB of a 290 MB tree, and this app shows no Chromium user interface
for them to translate -- no menu bar, no settings, no tabs.

`DESTDIR` and `PREFIX` are honoured, so the tree packages cleanly. It ships from
the [shinux repository](https://abdallah-shehawey.github.io/shinux/) as
`whatsapp-desktop`, beside the GTK client's `whatsapp`; the two install side by
side and share nothing, not even a state directory.

**The binary is `whatsapp-desktop` and the desktop entry says `WhatsApp`.** That
split is deliberate: the package has to be installable next to the older client,
and the name a user reads -- in the app grid, in the switcher, on a notification
-- should be the name of the thing, not the name of the package.

The launcher unsets `ELECTRON_RUN_AS_NODE` before exec. A terminal inside VS Code
exports it, and an Electron that inherits it starts as plain node — `app` comes
back `undefined` and nothing runs.

## Keys

| | |
|---|---|
| `Ctrl` `+` / `-` / `0` | zoom in, out, reset |
| `Ctrl+R` | reload |
| `Ctrl+Shift+I` | devtools |
| `Ctrl+W` | hide to the tray |
| `Ctrl+Q` | quit for real |
| window close | hides to the tray, stays connected |

## Layout

| | |
|---|---|
| `src/main.js` | window, session, tray, notifications, keys, the desktop |
| `src/preload.js` | the bridge: the page's world on one side, ipcRenderer on the other |
| `src/page/inject.js` | the chat-list watcher and the notification shim, in WhatsApp's own world |
| `src/style.js` | the user stylesheet — the font, and the room Arabic needs |
| `src/notify.js` | the banner policy, and pictures named from their own bytes |
| `src/tray.js`, `src/config.js`, `src/desktop.js`, `src/debug.js` | |
| `tools/make-icons.py` | regenerates `data/icons` — `make icons`, never hand-edit the PNGs |
| `tools/test-inject.js` | replays a chat list past the watcher — `make test` |

State lives in `~/.local/share/whatsapp-desktop`, config in
`~/.config/whatsapp-desktop` -- named for the project rather than the product,
because `~/.local/share/whatsapp` belongs to the GTK client and a signed-in
WebKit session and a signed-in Chromium session have no business sharing a
directory.

## Notifications, when they do not appear

A notification carries the id of a `.desktop` file, and GNOME reads the name and
the icon out of that file. Run from a source tree with nothing installed, there
is no file to read and the banner is titled `io.github.shehawey.whatsapp-desktop`
with a blank icon. `make install` is the fix, not a code change.

If a notification reaches the notification centre but never floats above the
screen, the client is not the place to look: check that a plain
`notify-send hello world` floats. If that does not either, it is the desktop --
GNOME suppresses every banner while a window on the primary monitor is
fullscreen, while the session presence is BUSY, and while `show-banners` is off,
and a shell extension that patches the message tray can do the same by accident.

## Configuration

`~/.config/whatsapp-desktop/whatsapp-desktop.conf`, every key optional:

| Key | Default | What it does |
|---|---|---|
| `[view] font` | the GNOME interface font | family for everything the client draws |
| `[view] font-size` | `16` | root font size in pixels — WhatsApp sizes in rem, so this scales the client |
| `[view] zoom` | `1.0` | also set with `Ctrl` `+`/`-` |
| `[view] force-font` | `true` | draw the page in one family, the way a browser told to ignore page fonts does |
| `[view] arabic-fix` | `true` | widen the boxes WhatsApp clips Arabic descenders against |
| `[window] width`, `height` | `1200x800` | remembered on exit |
| `[behaviour] close-to-tray` | `true` | closing the window leaves the client running |
| `[behaviour] minimize-to-tray` | `false` | minimise is not close |
| `[notifications] enabled` | `true` | off hands notifications back to Chromium's own handling |
| `[notifications] banner-seconds` | `12` | before a banner is taken down and filed silently |

### Arabic

A display face like PoetsenOne carries no Arabic at all, so Arabic arrives from a
fallback whose descenders reach further below the baseline than WhatsApp's line
boxes leave room for — the bowl of a final ن or ي gets shorn off, and "يعني" can
read as "يعن ،". `arabic-fix` answers that with a wider **clip**, never a taller
line: padding grows the box `overflow: hidden` cuts against and a negative margin
hands the space straight back, so every row keeps the height WhatsApp Web gave it.
Raising `line-height` instead does fix the tails, and it moves every Arabic line
off the rhythm the page was designed on — and inside a bubble it lands on a span
in a div pinned at 19px and shears five pixels off every line. That version
shipped once from the GTK client and came straight back out.

## Diagnosing it

Devtools are a `Ctrl+Shift+I` away, which the GTK client could never offer —
WebKitGTK's remote inspector never answered on its port. For the questions that
are about a window nobody is sitting in front of:

```sh
WHATSAPP_DEBUG_EVAL=/tmp/eval.js whatsapp-desktop
```

Whatever lands in that file is evaluated in the live page and the result logged.
Four words are commands to the app instead: `#snapshot` writes a PNG of the
window (a GNOME Wayland session will not hand a screenshot of this process to
anything outside it; `capturePage` is inside it), `#hide` and `#show` drive the
tray behaviour without a tray to click, and `#state` prints what the window
believes about itself.

Unset by default, and deliberately so — it is a way into a live WhatsApp session,
not a feature.

## Licence

GPL-3.0. Icon origins are recorded in `data/icons/NOTICE`.
