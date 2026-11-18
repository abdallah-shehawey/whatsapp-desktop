# Source-only application for Fedora Rawhide's system Electron 44 runtime.
# This package does not bundle or download the Electron runtime.
# Fedora owns the Electron runtime and this application tracks one major
# version of it at a time. Both bounds belong in a single rich dependency:
# written as two Requires lines, each one is satisfied on its own, so any
# Electron at all satisfies the lower bound while anything else that provides
# electron is free to satisfy the upper one -- the pair never held the runtime
# inside the range it was written for. The same range is required at build
# time, which is the assertion: the range is not a note left in the metadata
# for someone to read, it has to resolve against the Electron Fedora actually
# has, and a Fedora that has moved its runtime on fails this build -- where
# its maintainers and ours both see it -- rather than shipping an application
# onto a runtime it was never run on.
%global electron_major 44
%global electron_next 45
%global electron_dep (electron >= %{electron_major} with electron < %{electron_next})
# Each review snapshot is published under a tag naming the package and the
# Electron major it was built and run against, so moving the range moves the
# tag with it.
%global review_tag packaging-review-%{name}-%{version}-fedora%{electron_major}
# The archive does not take the WhatsApp name or logo on a client WhatsApp did
# not make, so this package installs the project's Dardasha brand: its own
# name, application id and artwork (BRAND=dardasha, data/brands/dardasha).
# The upstream project, its source archive and its settings directories keep
# the upstream name.
%global upstream whatsapp-desktop
%global app_id io.github.abdallah_shehawey.dardasha
Name:           dardasha
Version:        1.10.5
Release:        3%{?dist}
Summary:        Independent desktop client for WhatsApp Web
# The Dardasha artwork is GPL-3.0-or-later and the AppStream metadata CC0-1.0.
# The upstream archive also carries other artwork that this package does not
# install.
License:        GPL-3.0-or-later AND CC0-1.0
URL:            https://github.com/abdallah-shehawey/whatsapp-desktop
Source0:        https://github.com/abdallah-shehawey/whatsapp-desktop/releases/download/%{review_tag}/%{upstream}-%{version}.tar.gz
BuildArch:      noarch

BuildRequires:  make
# The application needs no Node.js at run time -- Electron carries its own --
# but the test suite this package runs in %%check does. tools/test-x11.js
# stands up a fake X server on an abstract socket, which Node refuses with
# EINVAL before 18.20, so the version is named rather than left to whatever
# the buildroot happens to carry.
BuildRequires:  nodejs >= 20
BuildRequires:  python3
BuildRequires:  fontconfig
BuildRequires:  desktop-file-utils
BuildRequires:  appstream
BuildRequires:  util-linux-core
BuildRequires:  %{electron_dep}
Requires:       %{electron_dep}
Requires:       dbus
Requires:       %{_bindir}/gdbus
Requires:       fontconfig
Recommends:     google-noto-emoji-color-fonts

%description
Dardasha is an independent desktop client for WhatsApp Web, with system tray
integration, desktop notifications, themes, configurable fonts and privacy
controls. It requires an existing WhatsApp account and an Internet
connection. Dardasha is not affiliated with Meta or WhatsApp.

%prep
%autosetup -n %{upstream}-%{version}
# No compiled runtime, npm install, or network access is needed by this app.
test ! -d node_modules

%build
# The application is uncompiled JavaScript; Electron is a separate dependency.

%install
%{__make} install-system BRAND=dardasha DESTDIR=%{buildroot} PREFIX=%{_prefix} \
  SYSTEM_ELECTRON=%{_bindir}/electron
# These notices are installed below through %%license rather than duplicated
# inside the application data directory.
rm -f %{buildroot}%{_datadir}/%{name}/data/CC0-1.0.txt
rm -f %{buildroot}%{_datadir}/%{name}/data/icons/NOTICE
# Preserve icon aliases and application-relative paths without storing
# duplicate copies. Keep ownership/mode distinctions and ignore timestamps.
hardlink --ignore-time %{buildroot}%{_datadir}

%check
make test
python3 tools/test-system-package.py
desktop-file-validate %{buildroot}%{_datadir}/applications/%{app_id}.desktop
appstreamcli validate --no-net %{buildroot}%{_datadir}/metainfo/%{app_id}.metainfo.xml
# The installed copy is the Dardasha brand throughout.
grep -q '"id": "%{app_id}"' %{buildroot}%{_datadir}/%{name}/data/brand.json

%files
%license LICENSE data/brands/dardasha/icons/NOTICE data/CC0-1.0.txt
%doc data/brands/dardasha/README.md
%{_bindir}/%{name}
%{_datadir}/%{name}/
%{_datadir}/applications/%{app_id}.desktop
%{_datadir}/metainfo/%{app_id}.metainfo.xml
%{_datadir}/icons/hicolor/*/apps/*.png
%{_datadir}/icons/hicolor/*/status/*.png
%{_mandir}/man1/%{name}.1*

%changelog
* Wed Nov 18 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.5-3
- Rename the package to dardasha and install the project's Dardasha brand:
  its own name, application id (io.github.abdallah_shehawey.dardasha) and
  original artwork, since the archive does not take the WhatsApp name or logo
  on an independent client
- Drop GPL-3.0-only from License: the artwork it covered is not installed

* Wed Nov 18 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.5-2
- Move to Fedora Rawhide's Electron 44 runtime, which replaced 43 there;
  the build and runtime dependency is now (electron >= 44 with electron < 45)
- Publish the review source under a tag naming the Electron major

* Sat Nov 14 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.5-1
- Bind the global keys through the desktop's GlobalShortcuts portal on
  Wayland, so they reach the client from any window, XWayland included

* Sat Nov 14 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.4-1
- Answer the window's own shortcuts -- quit, close, reload, zoom,
  settings, devtools -- with the Arabic keyboard layout active

* Sun Nov 01 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.3-1
- Take the reply bar over where WhatsApp now moves it, so opening and
  dismissing it no longer lay out the whole conversation on every frame

* Mon Oct 26 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.2-1
- Stop the desktop settings monitor when the client exits

* Mon Oct 26 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.1-1
- Update to 1.10.1

* Mon Oct 26 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.10.0-1
- Update to 1.10.0

* Mon Oct 26 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.21-1
- Update to 1.9.21

* Sun Oct 25 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.20-2
- Publish the review source under a version-specific review tag

* Sat Oct 24 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.20-1
- Update to 1.9.20

* Tue Oct 20 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.19-1
- Update to 1.9.19

* Sat Oct 17 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.18-1
- Update to 1.9.18

* Sat Oct 17 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.17-1
- Update to 1.9.17

* Sat Oct 17 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.16-1
- Update to 1.9.16

* Sat Oct 17 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.15-1
- Update to 1.9.15

* Sun Oct 11 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.14-1
- Update to 1.9.14

* Sat Oct 10 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.13-1
- Update to 1.9.13

* Sat Oct 10 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.12-2
- Use Fedora Rawhide's official Electron 43 runtime
- Match the desktop entry to the runtime's observed window class
- Consolidate duplicate icon and metadata files with hardlinks

* Fri Oct 09 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.12-1
- Initial source-only packaging proposal, pending the Electron runtime
