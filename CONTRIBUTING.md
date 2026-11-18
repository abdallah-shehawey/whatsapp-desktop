# Contributing

Thanks for helping. Bug reports, fixes and testing on other desktops are all welcome.

## Setup

You need Linux, Node.js 22 or newer, npm, and the system libraries Electron needs.

```sh
git clone https://github.com/abdallah-shehawey/whatsapp-desktop
cd whatsapp-desktop
make        # installs the dependencies and downloads Electron
make run    # runs the client from the source tree
```

`make install` puts your build in `~/.local` with a desktop entry and icons.
If you run the client without installing it, notifications have no name or
icon.

## Checks

Run these before you open a pull request. CI runs the same checks.

```sh
make test
find src tools -name '*.js' -print0 | xargs -0 -n1 node --check
```

`make test` replays the page, notification and desktop logic in plain Node. It
needs no browser and no WhatsApp account, and it only writes to a temporary
directory.

## Project layout

| Path | What's there |
|---|---|
| `src/main.js` | Main process: window, session, tray, notifications, command-line switches |
| `src/preload.js` | Bridge between the WhatsApp page and IPC |
| `src/page/` | Code that runs inside WhatsApp Web: chat-list watcher, notifications, animations, search |
| `src/*.html`, `src/window.css` | The Settings, Fonts, About, lock and connection windows |
| `src/themes/`, `src/lock/`, `src/mpris/` | Color palettes and accent, passcode storage, media controls |
| `data/` | Desktop entries, AppStream metadata, icons. `data/brands/dardasha/` holds the brand used in distribution archives. |
| `packaging/` | Package recipes. `packaging/official/` is for the Fedora and Debian reviews. |
| `tools/` | Tests (`test-*.js`) and the scripts that generate icons, screenshots and the website's preview image |
| `docs/` | The website (served by GitHub Pages) and the user docs |

Some files are generated, so don't edit them by hand. Run the `make` target
instead:

- `make icons` rebuilds `data/icons` from the SVG masters.
- `make screenshots` captures the three windows again, into `screenshots/` and `docs/assets/`.
- `make og` rebuilds the website's link-preview image.

## Debugging a live session

```sh
WHATSAPP_DEBUG_EVAL=/tmp/eval.js whatsapp-desktop
```

The client runs whatever you write to that file inside the live page. A line
that starts with `#` is a command for the client instead, for example `#state`,
`#gpu`, `#snapshot settings`, `#scroll <selector>` or `#update 1.0.0`. The full
list is in [`src/debug.js`](src/debug.js). This gives full access to a
signed-in session, so never leave it set.

## Pull requests

- Keep each change focused, and say in the commit message what users will notice.
- If you change config keys, shortcuts, packaging or notification behavior, update `README.md` or `docs/configuration.md` in the same change.
- The default build is branded "WhatsApp" (`io.github.shehawey.whatsapp-desktop`). Don't change its name, icon or app ID. The Dardasha brand is only for distribution archives.
- Never include account data, session files, phone numbers or screenshots of private chats.

By contributing, you agree to license your work under the project's
[GPL-3.0-or-later](LICENSE) license.
