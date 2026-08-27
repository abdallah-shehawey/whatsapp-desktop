Name:           whatsapp-desktop
Version:        %{?version}%{!?version:0.1.0}
Release:        %{?release}%{!?release:1}%{?dist}
Summary:        WhatsApp Web desktop client for Linux
License:        GPL-3.0-only
URL:            https://github.com/abdallah-shehawey/whatsapp-desktop
Source0:        %{name}-%{version}.tar.gz

Requires:       alsa-lib
Requires:       atk
Requires:       at-spi2-atk
Requires:       cairo
Requires:       cups-libs
Requires:       dbus-libs
Requires:       gtk3
Requires:       libX11
Requires:       libXcomposite
Requires:       libXdamage
Requires:       libXext
Requires:       libXfixes
Requires:       libXrandr
Requires:       libdrm
Requires:       mesa-libgbm
Requires:       nspr
Requires:       nss
Requires:       pango
Requires:       zlib

%description
WhatsApp Web in a dedicated Chromium window with a system tray, desktop
notifications, desktop font integration, and Arabic text fixes.

%prep
%setup -q

%build
# Electron is downloaded and installed by the packaging helper before rpmbuild.
:

%install
rm -rf %{buildroot}
install -d %{buildroot}/usr/lib/%{name}/resources/app
install -d %{buildroot}/usr/bin
install -d %{buildroot}/usr/share/applications
install -d %{buildroot}/usr/share/icons/hicolor
cp -a node_modules/electron/dist/. %{buildroot}/usr/lib/%{name}/
rm -f %{buildroot}/usr/lib/%{name}/electron
install -m 0755 node_modules/electron/dist/electron %{buildroot}/usr/lib/%{name}/%{name}
for locale in %{buildroot}/usr/lib/%{name}/locales/*.pak; do
  case "$(basename "$locale")" in
    ar.pak|en-US.pak) ;;
    *) rm -f "$locale" ;;
  esac
done
cp -a package.json src data %{buildroot}/usr/lib/%{name}/resources/app/
printf '#!/bin/sh\nunset ELECTRON_RUN_AS_NODE\nexec /usr/lib/%{name}/%{name} "$@"\n' > %{buildroot}/usr/bin/%{name}
chmod 0755 %{buildroot}/usr/bin/%{name}
for size in 16 22 24 32 48 64 128 256; do
  install -d %{buildroot}/usr/share/icons/hicolor/${size}x${size}/apps
  install -d %{buildroot}/usr/share/icons/hicolor/${size}x${size}/status
  install -m 0644 data/icons/${size}/apps/io.github.shehawey.whatsapp-desktop.png %{buildroot}/usr/share/icons/hicolor/${size}x${size}/apps/
  install -m 0644 data/icons/${size}/status/io.github.shehawey.whatsapp-desktop-tray.png %{buildroot}/usr/share/icons/hicolor/${size}x${size}/status/
  install -m 0644 data/icons/${size}/status/io.github.shehawey.whatsapp-desktop-tray-attention.png %{buildroot}/usr/share/icons/hicolor/${size}x${size}/status/
done
sed 's|@BINDIR@|/usr/bin|g' data/io.github.shehawey.whatsapp-desktop.desktop > %{buildroot}/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop
install -D -m 0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
install -D -m 0644 README.md %{buildroot}%{_docdir}/%{name}/README.md

%files
/usr/bin/%{name}
/usr/lib/%{name}
/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop
/usr/share/icons/hicolor/*/apps/io.github.shehawey.whatsapp-desktop.png
/usr/share/icons/hicolor/*/status/io.github.shehawey.whatsapp-desktop-tray.png
/usr/share/icons/hicolor/*/status/io.github.shehawey.whatsapp-desktop-tray-attention.png
%license %{_licensedir}/%{name}/LICENSE
%doc %{_docdir}/%{name}/README.md

%changelog
* Thu Aug 27 2026 Abdallah Shehawey <shehawey9@gmail.com> - 0.1.0-1
- Initial package.
