# Fedora Electron 43 runtime check

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
