#!/usr/bin/env bash
# Build review artifacts from committed application source, without npm or a
# bundled Electron binary. This does not upload to any distribution archive.
set -euo pipefail

task_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
task_dist=${DIST:-$task_root/dist/official}
task_version=$(node -p "require('$task_root/package.json').version")
task_build=$(mktemp -d)
trap 'rm -rf "$task_build"' EXIT
mkdir -p "$task_dist"
task_dist=$(cd "$task_dist" && pwd)
export SOURCE_DATE_EPOCH=$(git -C "$task_root" show -s --format=%ct HEAD)

# Web-site fonts, screenshots and the third-party packaging helpers are not
# inputs to this application build. Their omission is recorded in the manifest.
git -C "$task_root" archive --format=tar.gz \
  --prefix="whatsapp-desktop-$task_version/" \
  -o "$task_dist/whatsapp-desktop-$task_version.tar.gz" HEAD \
  LICENSE README.md Makefile package.json src data tools packaging/official
cp "$task_dist/whatsapp-desktop-$task_version.tar.gz" \
   "$task_dist/whatsapp-desktop_$task_version.orig.tar.gz"

tar -xzf "$task_dist/whatsapp-desktop_$task_version.orig.tar.gz" -C "$task_build"
git -C "$task_root" archive HEAD debian | \
  tar -x -C "$task_build/whatsapp-desktop-$task_version"
cp "$task_dist/whatsapp-desktop_$task_version.orig.tar.gz" "$task_build/"
(cd "$task_build" && dpkg-source -b "whatsapp-desktop-$task_version")
cp "$task_build"/*.dsc "$task_build"/*.debian.tar.* "$task_dist/"

mkdir -p "$task_build/rpm"/{SOURCES,SPECS,SRPMS}
cp "$task_dist/whatsapp-desktop-$task_version.tar.gz" "$task_build/rpm/SOURCES/"
cp "$task_build/whatsapp-desktop-$task_version/packaging/official/whatsapp-desktop.spec" \
   "$task_build/rpm/SPECS/"
cp "$task_build/rpm/SPECS/whatsapp-desktop.spec" "$task_dist/"
task_rpm_options=(--define "_topdir $task_build/rpm")
if [[ -n "${RPM_DIST:-}" ]]; then
  task_rpm_options+=(--define "dist $RPM_DIST")
fi
rpmbuild -bs "${task_rpm_options[@]}" \
  "$task_build/rpm/SPECS/whatsapp-desktop.spec"
cp "$task_build"/rpm/SRPMS/*.src.rpm "$task_dist/"

node - "$task_root" "$task_dist" <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const [root, dist] = process.argv.slice(2);
const manifest = require(path.join(root, 'package.json'));
const audit = {
  project: manifest.name,
  version: manifest.version,
  git_commit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding:'utf8'}).trim(),
  included_paths: ['LICENSE', 'README.md', 'Makefile', 'package.json', 'src', 'data', 'tools', 'packaging/official'],
  debian_packaging_in_source_diff: true,
  bundled_runtime: false,
  runtime_dependency: 'Distribution-owned Electron: Fedora >= 43, < 44; Debian >= 40, < 41',
  archive_status: 'proposal; not accepted or installable from official archives',
  blocker: 'Fedora application review and packager sponsorship remain pending; Debian runtime request #842420 is open; no official application archive acceptance'
};
fs.writeFileSync(path.join(dist, 'build-manifest.json'), JSON.stringify(audit, null, 2) + '\n');
NODE
(cd "$task_dist" && sha256sum ./*.tar.gz ./*.tar.xz ./*.dsc ./*.src.rpm ./*.spec build-manifest.json > SHA256SUMS)
printf 'Source review artifacts: %s\n' "$task_dist"
