# Source-only application for Fedora Rawhide's system Electron 43 runtime.
# This package does not bundle or download the Electron runtime.
%global review_tag packaging-review-%{version}-fedora43
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
%global electron_major 43
%global electron_next 44
%global electron_dep (electron >= %{electron_major} with electron < %{electron_next})
Name:           whatsapp-desktop
Version:        1.10.3
Release:        1%{?dist}
Summary:        Independent desktop client for WhatsApp Web
License:        GPL-3.0-or-later AND GPL-3.0-only AND CC0-1.0
URL:            https://github.com/abdallah-shehawey/whatsapp-desktop
Source0:        https://github.com/abdallah-shehawey/whatsapp-desktop/releases/download/%{review_tag}/%{name}-%{version}.tar.gz
BuildArch:      noarch

BuildRequires:  make
# The application needs no Node.js at run time -- Electron carries its own --
# but the test suite this package runs in %check does. tools/test-x11.js
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
Independent WhatsApp Web client with system tray integration, desktop
notifications, themes, configurable fonts and privacy controls. Requires an
existing WhatsApp account and an Internet connection. This project is not
affiliated with Meta or WhatsApp.

%prep
%autosetup
# No compiled runtime, npm install, or network access is needed by this app.
test ! -d node_modules

%build
# The application is uncompiled JavaScript; Electron is a separate dependency.

%install
%{__make} install-system DESTDIR=%{buildroot} PREFIX=%{_prefix} SYSTEM_ELECTRON=%{_bindir}/electron
# Fedora's Electron 43 honors the class passed by our system launcher.
sed -i 's/^StartupWMClass=WhatsApp$/StartupWMClass=io.github.shehawey.whatsapp-desktop/' \
  %{buildroot}%{_datadir}/applications/io.github.shehawey.whatsapp-desktop.desktop
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
desktop-file-validate %{buildroot}%{_datadir}/applications/io.github.shehawey.whatsapp-desktop.desktop
appstreamcli validate --no-net %{buildroot}%{_datadir}/metainfo/io.github.shehawey.whatsapp-desktop.metainfo.xml

%files
%license LICENSE data/icons/NOTICE data/CC0-1.0.txt
%doc README.md
%{_bindir}/%{name}
%{_datadir}/%{name}/
%{_datadir}/applications/io.github.shehawey.whatsapp-desktop.desktop
%{_datadir}/metainfo/io.github.shehawey.whatsapp-desktop.metainfo.xml
%{_datadir}/icons/hicolor/*/apps/*.png
%{_datadir}/icons/hicolor/*/status/*.png
%{_mandir}/man1/%{name}.1*

%changelog
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
