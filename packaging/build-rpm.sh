#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
DIST=${DIST:-$ROOT/dist}
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

mkdir -p "$DIST"
rm -f "$DIST"/whatsapp-desktop-"$VERSION"-*.rpm

if [[ ! -x "$ROOT/node_modules/electron/dist/electron" ]]; then
  (cd "$ROOT" && npm ci --no-audit --no-fund)
fi

# RPM builds from a self-contained tree. The Electron runtime is build input,
# not project source, and is included only in this temporary package tree.
SOURCE_TREE="$BUILD/whatsapp-desktop-$VERSION"
mkdir -p "$SOURCE_TREE"
git -C "$ROOT" archive HEAD | tar -x -C "$SOURCE_TREE"
cp -a "$ROOT/node_modules" "$SOURCE_TREE/node_modules"
TARBALL="$BUILD/whatsapp-desktop-$VERSION.tar.gz"
tar -C "$BUILD" -czf "$TARBALL" "whatsapp-desktop-$VERSION"

mkdir -p "$BUILD/rpmbuild"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cp "$TARBALL" "$BUILD/rpmbuild/SOURCES/"
cp "$ROOT/packaging/whatsapp-desktop.spec" "$BUILD/rpmbuild/SPECS/"

rpmbuild -bb \
  --define "_topdir $BUILD/rpmbuild" \
  --define "version $VERSION" \
  --define "_build_id_links none" \
  "$BUILD/rpmbuild/SPECS/whatsapp-desktop.spec" >/dev/null

cp "$BUILD"/rpmbuild/RPMS/*/whatsapp-desktop-"$VERSION"-*.rpm "$DIST/"
printf 'Created %s\n' "$DIST/whatsapp-desktop-$VERSION-*.rpm"
