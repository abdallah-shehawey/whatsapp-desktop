# Maintainer: Abdallah Shehawey <shehawey9@gmail.com>
pkgname=whatsapp-desktop
pkgver=1.6.5
pkgrel=1
pkgdesc='WhatsApp Web desktop client for Linux with tray integration, notifications, and Arabic text fixes'
arch=('x86_64')
url='https://github.com/abdallah-shehawey/whatsapp-desktop'
license=('GPL-3.0-only')
depends=('electron')
makedepends=()
source=("$pkgname-$pkgver.tar.gz::https://github.com/abdallah-shehawey/whatsapp-desktop/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('SKIP')

package() {
  cd "$srcdir/$pkgname-$pkgver"

  # Install the app files
  install -d "$pkgdir/usr/lib/$pkgname"
  cp -a package.json src data "$pkgdir/usr/lib/$pkgname/"

  # Create the launcher script
  install -d "$pkgdir/usr/bin"
  cat > "$pkgdir/usr/bin/$pkgname" << 'EOF'
#!/bin/sh
# A terminal inside VS Code exports ELECTRON_RUN_AS_NODE=1, and an Electron
# that inherits it starts as plain node instead.
unset ELECTRON_RUN_AS_NODE

# The desktop font is imposed through fontconfig, and fontconfig is read once,
# early -- before any of the app's own code runs.
wa_fonts="${XDG_DATA_HOME:-$HOME/.local/share}/whatsapp-desktop/fonts.conf"
[ -f "$wa_fonts" ] && export FONTCONFIG_FILE="$wa_fonts"

exec electron /usr/lib/whatsapp-desktop "$@"
EOF
  chmod 755 "$pkgdir/usr/bin/$pkgname"

  # Install icons
  for size in 16 22 24 32 48 64 128 256; do
    for f in apps/io.github.shehawey.whatsapp-desktop.png \
             apps/io.github.shehawey.whatsapp-desktop-tray.png \
             apps/whatsapp-desktop.png apps/whatsapp-desktop-tray.png \
             apps/WhatsApp.png \
             status/io.github.shehawey.whatsapp-desktop-tray.png \
             status/io.github.shehawey.whatsapp-desktop-tray-attention.png \
             status/whatsapp-desktop-tray.png \
             status/whatsapp-desktop-tray-attention.png; do
      install -Dm644 "data/icons/$size/$f" \
        "$pkgdir/usr/share/icons/hicolor/${size}x${size}/$f"
    done
  done

  # Install .desktop file
  install -d "$pkgdir/usr/share/applications"
  sed 's|@BINDIR@|/usr/bin|g' data/io.github.shehawey.whatsapp-desktop.desktop \
    > "$pkgdir/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop"
  chmod 644 "$pkgdir/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop"

  # Install autostart .desktop file
  install -d "$pkgdir/etc/xdg/autostart"
  sed 's|@BINDIR@|/usr/bin|g' data/io.github.shehawey.whatsapp-desktop-autostart.desktop \
    > "$pkgdir/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop"
  chmod 644 "$pkgdir/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop"

  # Install license and documentation
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
}
