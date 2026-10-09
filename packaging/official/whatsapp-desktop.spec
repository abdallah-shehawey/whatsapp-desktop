# Packaging proposal: Electron 40 must first be packaged for Fedora.
# This package does not bundle or download the Electron runtime.
Name:           whatsapp-desktop
Version:        1.9.12
Release:        1%{?dist}
Summary:        Independent desktop client for WhatsApp Web
License:        GPL-3.0-or-later AND GPL-3.0-only AND CC0-1.0
URL:            https://github.com/abdallah-shehawey/whatsapp-desktop
Source0:        https://github.com/abdallah-shehawey/whatsapp-desktop/releases/download/packaging-review-2026-10-09/%{name}-%{version}.tar.gz
BuildArch:      noarch

BuildRequires:  make
BuildRequires:  nodejs
BuildRequires:  python3
BuildRequires:  fontconfig
BuildRequires:  desktop-file-utils
BuildRequires:  appstream
Requires:       electron >= 40
Requires:       electron < 41
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
# These notices are installed below through %%license rather than duplicated
# inside the application data directory.
rm -f %{buildroot}%{_datadir}/%{name}/data/CC0-1.0.txt
rm -f %{buildroot}%{_datadir}/%{name}/data/icons/NOTICE

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
* Fri Oct 09 2026 Abdallah Shehawey <shehawey9@gmail.com> - 1.9.12-1
- Initial source-only packaging proposal, pending the Electron runtime
