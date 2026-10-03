#!/bin/sh
# build-appimage.sh -- package whatsapp-desktop as a standalone AppImage
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -p "require('$DIR/package.json').version")
ARCH=$(uname -m)
APPDIR="$DIR/dist/AppDir"
OUTDIR="$DIR/dist"

echo "Building AppImage for whatsapp-desktop $VERSION ($ARCH)..."

rm -rf "$APPDIR"
mkdir -p "$APPDIR" "$OUTDIR"

# Stage via Makefile
make -C "$DIR" install DESTDIR="$APPDIR" PREFIX=/usr

# AppRun entrypoint
cat << 'EOF' > "$APPDIR/AppRun"
#!/bin/sh
HERE="$(dirname "$(readlink -f "${0}")")"
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${HERE}/usr/lib/whatsapp-desktop:${LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="${HERE}/usr/share:${XDG_DATA_DIRS}"
exec "${HERE}/usr/bin/whatsapp-desktop" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# Desktop file and icon at root of AppDir
cp "$APPDIR/usr/share/applications/io.github.shehawey.whatsapp-desktop.desktop" "$APPDIR/"
cp "$DIR/data/icons/256/apps/io.github.shehawey.whatsapp-desktop.png" "$APPDIR/io.github.shehawey.whatsapp-desktop.png"
ln -sf io.github.shehawey.whatsapp-desktop.png "$APPDIR/.DirIcon"

echo "AppDir staged at: $APPDIR"
if command -v appimagetool >/dev/null 2>&1; then
  appimagetool "$APPDIR" "$OUTDIR/WhatsApp-Desktop-$VERSION-$ARCH.AppImage"
  echo "AppImage created: $OUTDIR/WhatsApp-Desktop-$VERSION-$ARCH.AppImage"
else
  echo "Note: 'appimagetool' not found in PATH. Staged AppDir is ready at dist/AppDir."
fi
