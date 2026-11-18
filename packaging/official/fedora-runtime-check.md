# Fedora Electron runtime checks

## Dardasha package on Electron 44, 2026-11-18

After the package was renamed `dardasha` and set to install the Dardasha brand
(see [the README](README.md#name-in-the-archives-dardasha)), `dardasha-1.10.5-3`
was checked the same way, in the same container and against the same signed
`nodejs-electron-44.11.3-1.fc46`:

- The SRPM rebuilt with `%check`. That now includes
  `tools/test-system-package.py` installing both brands, and every suite
  passed. rpmlint 2.10.0 reported 0 errors and 0 warnings on the SRPM and on
  the RPM.
- The package installs `/usr/bin/dardasha`, `io.github.abdallah_shehawey.dardasha`'s
  desktop entry and metadata, and `dardasha.1`, and no file whose name carries
  the default brand. The range for 45 still fails to resolve.
- Running as an unprivileged user, the native `WM_CLASS` was
  `io.github.abdallah_shehawey.dardasha`. The windows were titled
  "Dardasha Settings", "Dardasha Fonts" and "About Dardasha", their pages
  named the default brand nowhere, and About reported the name Dardasha. The
  logged-out page and its QR code loaded as before.

The Debian `.dsc` for `dardasha` built in Debian 13 with the whole suite
passing. Lintian 2.122.0 reported no errors and one warning,
`newer-standards-version` (4.7.4 against Lintian's 4.7.2), which predates the
rename.

## Electron 44, 2026-11-18

Bodhi marked `nodejs-electron-44.11.3-1.fc46` stable in Rawhide on 2026-11-17.
At the time of this check the Rawhide compose still served 43.2.0, so the
runtime was installed from the copy that Koji signs with the Fedora 46 key
(`91211fce`). `rpm -K` reported `digests signatures OK` before it was installed.
Koji's unsigned buildroot copy was not used. Everything else came from the
Rawhide compose.

The 1.10.5-2 source RPM, with the rich dependency
`(electron >= 44 with electron < 45)` as both `BuildRequires` and `Requires`,
was rebuilt, linted, installed and run in a rootless Podman Rawhide container,
with a private Xvfb X11 display, private XDG directories and GPU acceleration
disabled, as before:

- `dnf builddep` resolved the range to the installed Electron 44. `rpmbuild
  --rebuild` ran `%check`, and 27 application test suites passed.
- rpmlint 2.10.0 reported 0 errors and 0 warnings on both the source and the
  binary package.
- The installed package carries the single rich `Requires`. The same SPEC
  written for the next major, `(electron >= 45 with electron < 46)`, stops at
  `nothing provides requested`, so the build fails once Fedora moves past 44.

The application's real About IPC returned:

| Component | Version |
| --- | --- |
| Application | 1.10.5 |
| Electron | 44.11.3 |
| Chromium | 152.0.7977.169 |
| Embedded Node.js | 24.22.2 |

The runtime check from the Electron 43 run passed unchanged, apart from the
expected major version. The main renderer loaded the logged-out
`https://web.whatsapp.com/` page and drew its QR canvas. Settings, Fonts and
About rendered through their real preloads and IPC, and a private preference
was written and read back. Hide and show completed. The native `WM_CLASS` was
still `io.github.shehawey.whatsapp-desktop`.

Electron 44's breaking changes were checked against the source. Two touch
this application, and neither needed a change:

- The main process's `clipboard.writeText` now returns a Promise. The
  link menu's "Copy link" ignores the return value. A minimal Electron 44
  program wrote and read back a URL through it.
- Electron removed `app.isUnityRunning()` and documents the Linux badge as
  gone. This application never called the former. Fedora's Electron 44 still
  emitted `com.canonical.Unity.LauncherEntry.Update` with `count` and
  `count-visible` for `app.badgeCount`, observed with `dbus-monitor` on a
  private session bus under both `XDG_CURRENT_DESKTOP=GNOME` and `Unity`,
  without libunity installed. The badge stays best-effort, as it was.

The log showed GPU, zygote and network-service errors, ending in a Chromium
`FATAL`. All of them came after the last check, when the harness sent
`SIGTERM` to the application's whole process group. A second run that
terminated only the main process logged none of them.

The limits are the same as for 43: no signed-in messaging or calls, no native
Wayland, no hardware acceleration and no complete portal validation.

## Electron 43, 2026-10-10

Following the 2026-10-09 Fedora devel feedback, application 1.9.12 was run with
the official Rawhide package `nodejs-electron-43.2.0-1.fc46.x86_64`. DNF obtained
the runtime and dependencies from Fedora's official Rawhide repository.
This reuses Fedora's runtime packaging; this project does not build or bundle
another Electron copy.

The check used a rootless Podman Rawhide container, a private Xvfb X11 display,
a private D-Bus session and private XDG directories. It did not open or migrate
the maintainer's signed-in application data. GPU acceleration was disabled for
this display check. The system launcher added no global `--no-sandbox` option;
the application's existing per-window webPreferences were preserved.

The application's real About IPC returned:

| Component | Version |
| --- | --- |
| Application | 1.9.12 |
| Electron | 43.2.0 |
| Chromium | 150.0.7871.129 |
| Embedded Node.js | 24.18.0 |

Observed behavior:

- The main renderer loaded `https://web.whatsapp.com/`, including its logged-out
  QR login page.
- The real Settings, Fonts and About windows rendered with their actual
  preloads and IPC bridges. A private notification-sound preference was changed
  and read back through Settings IPC. The font catalogue was populated.
- The main window's hide/show actions completed.
- The native main-window `WM_CLASS` was
  `io.github.shehawey.whatsapp-desktop`, matching the Fedora SPEC revision 2
  desktop entry. Electron 40's earlier observed class was `WhatsApp`.
- The existing application tests and source-only installation checks passed
  in Rawhide. The staged application contained no bundled runtime.

The application JavaScript was unchanged from commit
`d22f667ad217af631ce63243b7d404684df5aa52`; the Fedora revision changes the runtime
dependency and desktop metadata. The upper dependency bound retains the tested
major version. New Electron major versions need further checks.

This is a basic runtime compatibility check. It does not validate signed-in
message sending, calls, native Wayland, hardware acceleration, or all desktop
portal behavior. Review, sponsorship and archive acceptance remain pending.
Rawhide availability does not establish availability in stable Fedora releases,
and does not resolve Debian's separate Electron prerequisite.
