# This package ships a prebuilt tree -- a copy of Electron -- rather than
# sources, so three of rpm's automatic passes have to be switched off.
#
# Debuginfo extraction has nothing to work from and fails the build outright on
# the Electron binary: "GDB exited with exit status 1 during index generation".
%global debug_package %{nil}
# And the rest of the post-install brp scripts must not strip or rewrite a
# 194 MB Chromium binary that was shipped ready to run.
%global __os_install_post %{nil}

# The bundled Chromium libraries live in a private directory and are nobody
# else's to depend on: without the first line this package would advertise
# Provides: libvulkan.so.1 and libEGL.so to the whole system, and dnf could
# satisfy another package's dependency with a copy meant only for this app. The
# second line is the other half -- the electron binary genuinely does require
# those SONAMEs, and once they stop being provided the package cannot install
# itself.
%global __provides_exclude_from ^%{_prefix}/lib/whatsapp-desktop/.*$
%global __requires_exclude ^(libffmpeg|libEGL|libGLESv2|libvk_swiftshader|libvulkan)\.so.*$

Name:           whatsapp-desktop
Version:        %{?version}%{!?version:1.2.1}
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
# One source of truth for what "installed" means: the Makefile. It renames the
# Electron binary (the name becomes the Wayland app_id, and so the icon and the
# name in the switcher), drops the 53 Chromium translations of a user interface
# this app never shows, and writes the launcher -- which has to export
# FONTCONFIG_FILE, because fontconfig is read before any of the app's own code
# runs and that is how the desktop font is imposed without a stylesheet.
make install DESTDIR=%{buildroot} PREFIX=/usr

# Autostart is shipped system-wide rather than written into a home directory, so
# the package can cleanly remove it again. It starts hidden, in the tray.
install -Dm644 data/io.github.shehawey.whatsapp-desktop-autostart.desktop \
  %{buildroot}/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop
sed -i 's|@BINDIR@|/usr/bin|g' %{buildroot}/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop

install -D -m 0644 LICENSE %{buildroot}%{_licensedir}/%{name}/LICENSE
install -D -m 0644 README.md %{buildroot}%{_docdir}/%{name}/README.md

%files
/usr/bin/%{name}
/usr/lib/%{name}
/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop
/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop
/usr/share/icons/hicolor/*/apps/io.github.shehawey.whatsapp-desktop.png
# The tray icon is installed into both contexts on purpose: SNI hosts disagree
# on which of them they search.
/usr/share/icons/hicolor/*/apps/io.github.shehawey.whatsapp-desktop-tray.png
/usr/share/icons/hicolor/*/status/io.github.shehawey.whatsapp-desktop-tray.png
/usr/share/icons/hicolor/*/status/io.github.shehawey.whatsapp-desktop-tray-attention.png
%license %{_licensedir}/%{name}/LICENSE
%doc %{_docdir}/%{name}/README.md

%changelog
* Thu Aug 27 2026 Abdallah Shehawey <shehawey9@gmail.com> - 0.1.0-1
- Initial package.
