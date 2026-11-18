# Official archive packaging proposal

This directory and `debian/` prepare the application for distribution review.
They do **not** mean it has been accepted into Fedora, Debian or Ubuntu.

The normal release packages contain a downloaded Electron binary. The separate
`make install-system` target installs our JavaScript and data under
`/usr/share/<command>` and starts a distribution-owned `/usr/bin/electron`.
It preserves the existing application, settings locations, fonts and URL
handling. It neither downloads Electron nor disables its sandbox.

## Name in the archives: Dardasha

The archives, like Flathub, do not take the WhatsApp name or logo on a client
WhatsApp did not make. The Fedora and Debian packages are therefore named
`dardasha` and install the project's Dardasha brand:

- the name Dardasha (دردشة, "chat"), the command `dardasha` and the
  application id `io.github.abdallah_shehawey.dardasha`
- original artwork: a white speech bubble holding the letter D on a green
  plate, in `data/brands/dardasha/icons`
- its own desktop entries, AppStream metadata, manual page and README

`make install-system BRAND=dardasha` selects it, and both packagings pass that.
Installed under it, `data/brand.json` names Dardasha, and `src/brand.js`
gives that name to the window titles, the tray, notifications, the media card
and the client's own pages. The default brand's icons, desktop entries and
metadata are not installed. The project's own channels keep the default
brand, with its name, icon and application id unchanged: the shinux-repo
packages, the AppImage, GitHub releases, AUR and npm. The upstream source
archive, the settings directory `~/.config/whatsapp-desktop` and the data
directory `~/.local/share/whatsapp-desktop` keep the upstream name, so moving
between the two builds keeps the signed-in session.

The `<releases>` list is recorded once, in the default brand's metadata, and
`make install-system` copies it into Dardasha's, so the two cannot drift.
`tools/test-system-package.py` installs both brands and checks each.

## Runtime dependency

The initial published proposal requires Electron 40 (`>= 40, < 41`), matching the
bundled application's major version. On 2026-10-09, Fedora devel feedback
identified the official Rawhide runtime as `nodejs-electron` 43.2.0-1.fc46:
<https://packages.fedoraproject.org/pkgs/nodejs-electron/nodejs-electron/>.
It provides `electron` and `/usr/bin/electron`. After basic runtime checks,
Fedora SPEC revision 2 required Electron `>= 43, < 44` and matched the
runtime's observed window class. On 2026-11-17 Bodhi marked
`nodejs-electron-44.11.3-1.fc46` stable in Rawhide, replacing 43. After the same
checks against it, the SPEC (1.10.5-2) requires Electron `>= 44, < 45`. See
[the runtime check](fedora-runtime-check.md) for the evidence and its limits.
Later major versions require further validation. Rawhide availability does not
establish availability in existing stable Fedora releases. The normal bundled
release continues to use Electron 40.

The SPEC states that range as one rich dependency,
`(electron >= 44 with electron < 45)`, so a single installed Electron has to
satisfy both bounds. Written as two separate `Requires` lines each bound was
satisfied on its own and the range never held. The same dependency is also a
`BuildRequires`: once Fedora's runtime leaves the range this package stops
building, where both its maintainers and ours see it, rather than installing
against a runtime it was never run on. Reviewed on the Fedora devel thread on
2026-10-26:
<https://lists.fedoraproject.org/archives/list/devel@lists.fedoraproject.org/message/U3A4APO5RW77LU6RI7G2LUIQAIJ4JYML/>.

Debian expresses the same range as `electron (>= 40), electron (<< 41)`, where
both relations name one real package and dpkg applies them to the version it
installs, so they do not need combining.

Debian's runtime request remains <https://bugs.debian.org/842420>. A source-built
application package alone is insufficient for archive installation: its runtime
must also be packaged, reviewed and maintained, including Chromium dependencies
and security updates. No prebuilt runtime may be substituted in these source
packages. The published application proposal does not package the runtime.

## Build-time Node.js

The application needs no Node.js at run time; Electron carries its own. The
test suite that both source packages run during the build does. One of its
checks, `tools/test-x11.js`, stands up a fake X server on an abstract unix
socket, which Node refuses with `EINVAL` before 18.20, so both packages name
`nodejs (>= 20)` rather than accept whatever the buildroot carries. Verified by
running that check on 18.20.8, 20.20.2 and 22.23.4, all passing, against
Ubuntu 24.04's archive `nodejs` 18.19.1, which fails. Ubuntu 24.04 therefore
cannot build these sources from its own archive; a distribution release with
`nodejs` 20 or newer can. Debian 13 (trixie), whose archive carries `nodejs`
20.19.2, builds the `.dsc` with the whole suite passing and no Lintian errors,
and CI builds the Debian package in that container rather than on its Ubuntu
runner for the same reason.

## Review artifacts and builds

From a committed checkout with Node.js, Python, make, `dpkg-source` and
`rpmbuild` installed:

```sh
packaging/official/build-source-packages.sh
```

Use a separate `DIST` output directory to preserve existing review snapshots.
Fedora review sources use a release tag naming the package, the application
version and the Electron major in the SPEC,
`packaging-review-<package>-<application version>-fedora<electron major>`
(for example `packaging-review-dardasha-1.10.5-fedora44`; the snapshots
before the rename used `packaging-review-1.10.5-fedora44` and earlier forms).
The builder reads the package name from `dardasha.spec` and `debian/control`
and refuses to build if they disagree. It reads the range from the SPEC,
checks the committed package version and the tag against the expanded SPEC
`Source0`, and records the exact URL, tag and range in `build-manifest.json`.
The upstream source archive keeps its name, `whatsapp-desktop-<version>.tar.gz`;
Debian's copy of it is `dardasha_<version>.orig.tar.gz`. Publish every generated review
artifact together under that tag, then verify anonymous downloads against
`SHA256SUMS` before linking the snapshot in the distribution review. A normal
application release does not publish a new review snapshot automatically.
`RPM_DIST=.fc46` labels a source RPM intended for Rawhide; build and test its
binary package in Rawhide before publishing it. The Debian proposal retains
its separate Electron 40 dependency.

The script exports the application source, SVG icon masters, generated icons,
tests and build inputs. It excludes `node_modules`, npm's downloaded runtime,
the separate website and its web fonts. The Debian packaging is stored in the
quilt source difference. `dist/official/build-manifest.json` records the exact
Git commit and the unresolved runtime dependency; `SHA256SUMS` covers the
source review artifacts.

Build the Debian application package from its `.dsc` with `dpkg-source -x`
followed by `dpkg-buildpackage -us -uc -b`. Build the Fedora application package
by importing the SRPM with `rpm -i`, then running `rpmbuild -ba` on its SPEC.
Both execute the application tests and a staged launcher/metadata check without
an npm installation. These builds test application packaging, not a complete
Electron source build or a working install from an official repository.

## Submission route

Fedora requires a Package Review ticket from an account tied to the contributor's
Fedora Account System email, plus sponsorship for a new packager:
<https://docs.fedoraproject.org/en-US/package-maintainers/Package_Review_Process/>.
The SPEC and SRPM must be publicly downloadable. The runtime and eligibility of
this independent client must be resolved with the reviewers.

For Debian, file an intent-to-package (ITP) with WNPP and record the runtime
blocker, then obtain package review/sponsorship before an archive upload:
<https://www.debian.org/devel/wnpp/>. Ubuntu recommends Debian inclusion first
for most new packages:
<https://documentation.ubuntu.com/project/contributors/new-package/create-a-new-package/>.
Acceptance and release migration belong to the distributions; they do not
automatically make the package available in every existing release.

## Submission status, 2026-10-10

Application packaging was merged and the source review artifacts were published:
<https://github.com/abdallah-shehawey/whatsapp-desktop/releases/tag/packaging-review-2026-10-09>.
The Fedora revision 2 review snapshot uses the existing Rawhide runtime:
<https://github.com/abdallah-shehawey/whatsapp-desktop/releases/tag/packaging-review-2026-10-10-fedora43>.
The first snapshot remains unchanged. Publishing review artifacts does not
update the submitted Bugzilla description or obtain review approval.
Debian acknowledged ITP <https://bugs.debian.org/1150415> and registered its
dependency on Electron request #842420. This is an intent to package, not archive
acceptance. The Ubuntu MOTU proposal is awaiting mailing-list moderator approval.

The maintainer's Fedora/FAS account `abdallah-shehawey` has been created, and
the maintainer personally signed the Fedora Project Contributor Agreement
(FPCA) on 2026-10-09. This completes the agreement step, not packager sponsorship
or archive acceptance.
The proposal is publicly posted to Fedora's devel list:
<https://lists.fedoraproject.org/archives/list/devel@lists.fedoraproject.org/thread/2L7VRATKFL4CDYQWCE5GXZHEFLLAG62P/>.
Seven replies from Neal Gompa, Nicolas Chauvet and Michael J Gruber were read
on 2026-10-09. Neal identified the existing Rawhide runtime and recommended
updating the application for Fedora's newer Electron version. Multiple runtime
versions, COPR and Flatpak were discussed as alternatives; this discussion does
not grant review approval or sponsorship. Official APT/DNF inclusion remains
the target.
Fedora Package Review <https://bugzilla.redhat.com/show_bug.cgi?id=2548541> has
been filed and blocks `FE-NEEDSPONSOR`, requesting sponsorship for the new
packager. Review and sponsorship remain unresolved. Basic compatibility with
the existing Rawhide runtime was checked; further signed-in and desktop
integration validation remains. Debian's separate runtime prerequisite remains
unresolved.
The separate sponsorship request is open at
<https://forge.fedoraproject.org/packaging/sponsors/issues/802>; it asks for a
mentor and guidance on the runtime prerequisite and does not claim readiness
for archive acceptance.
`fedora-review-request.txt` records the submitted description and public artifact
URLs. Track current progress and prerequisites in
<https://github.com/abdallah-shehawey/whatsapp-desktop/issues/7>.
