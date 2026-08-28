#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
ARCH=${ARCH:-amd64}
DIST=${DIST:-$ROOT/dist}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$DIST"
rm -f "$DIST"/whatsapp-desktop_"$VERSION"_"$ARCH".deb

if [[ ! -x "$ROOT/node_modules/electron/dist/electron" ]]; then
  (cd "$ROOT" && npm ci --no-audit --no-fund)
fi

# The Makefile is the single source of truth for the installed application tree.
make -C "$ROOT" DESTDIR="$STAGE/root" PREFIX=/usr install
# Autostart is shipped system-wide rather than written into a home directory, so
# the package can cleanly remove it again. It starts hidden, in the tray.
sed 's|@BINDIR@|/usr/bin|g' \
  "$ROOT/data/io.github.shehawey.whatsapp-desktop-autostart.desktop" \
  > "$STAGE/autostart.desktop"
install -Dm644 "$STAGE/autostart.desktop" \
  "$STAGE/root/etc/xdg/autostart/io.github.shehawey.whatsapp-desktop.desktop"

install -Dm644 "$ROOT/LICENSE" "$STAGE/root/usr/share/doc/whatsapp-desktop/LICENSE"
install -Dm644 "$ROOT/README.md" "$STAGE/root/usr/share/doc/whatsapp-desktop/README.md"

mkdir -p "$STAGE/root/DEBIAN"
INSTALLED_SIZE=$(du -sk "$STAGE/root" | awk '{print $1}')
cat > "$STAGE/root/DEBIAN/control" <<CONTROL
Package: whatsapp-desktop
Version: $VERSION
Section: net
Priority: optional
Architecture: $ARCH
Maintainer: Abdallah Shehawey <shehawey9@gmail.com>
Homepage: https://github.com/abdallah-shehawey/whatsapp-desktop
Installed-Size: $INSTALLED_SIZE
Depends: libasound2, libatk-bridge2.0-0, libatk1.0-0, libatspi2.0-0, libc6, libcairo2, libcups2, libdbus-1-3, libdrm2, libexpat1, libfontconfig1, libfreetype6, libgbm1, libgdk-pixbuf-2.0-0, libglib2.0-0, libgtk-3-0, libnspr4, libnss3, libpango-1.0-0, libwayland-client0, libwayland-cursor0, libwayland-egl1, libx11-6, libx11-xcb1, libxcb1, libxcomposite1, libxcursor1, libxdamage1, libxext6, libxfixes3, libxi6, libxinerama1, libxkbcommon0, libxrandr2, libxshmfence1
Recommends: libsecret-1-0, fonts-noto-color-emoji, fonts-noto-core
Description: WhatsApp Web desktop client for Linux
 WhatsApp Web in a dedicated Chromium window with a system tray,
 desktop notifications, desktop font integration, and Arabic text fixes.
CONTROL

dpkg-deb --build --root-owner-group "$STAGE/root" "$DIST/whatsapp-desktop_${VERSION}_${ARCH}.deb" >/dev/null
printf 'Created %s\n' "$DIST/whatsapp-desktop_${VERSION}_${ARCH}.deb"
