# Official archive packaging proposal

This directory and `debian/` prepare the application for distribution review.
They do **not** mean it has been accepted into Fedora, Debian or Ubuntu.

The normal release packages contain a downloaded Electron binary. The separate
`make install-system` target installs our JavaScript and data under
`/usr/share/whatsapp-desktop` and starts a distribution-owned `/usr/bin/electron`.
It preserves the existing application, settings locations, fonts and URL
handling. It neither downloads Electron nor disables its sandbox.

## Runtime dependency

The published proposal requires Electron 40 (`>= 40, < 41`), matching the
upstream application's major version. On 2026-10-09, Fedora devel feedback
identified the official Rawhide runtime as `nodejs-electron` 43.2.0-1.fc46:
<https://packages.fedoraproject.org/pkgs/nodejs-electron/nodejs-electron/>.
It provides `electron` and `/usr/bin/electron`, but its version cannot satisfy
the current proposal. The next Fedora step is to test application compatibility
with this distribution runtime and then revise the packaging accordingly.
Compatibility with Electron 43 has not yet been verified. Rawhide availability
does not establish availability in existing stable Fedora releases.

Debian's runtime request remains <https://bugs.debian.org/842420>. A source-built
application package alone is insufficient for archive installation: its runtime
must also be packaged, reviewed and maintained, including Chromium dependencies
and security updates. No prebuilt runtime may be substituted in these source
packages. The published application proposal does not package the runtime.

## Review artifacts and builds

From a committed checkout with Node.js, Python, make, `dpkg-source` and
`rpmbuild` installed:

```sh
packaging/official/build-source-packages.sh
```

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

## Submission status, 2026-10-09

Application packaging was merged and the source review artifacts were published:
<https://github.com/abdallah-shehawey/whatsapp-desktop/releases/tag/packaging-review-2026-10-09>.
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
packager. Review and sponsorship remain unresolved; the Fedora runtime work is
now compatibility with the existing Rawhide package. Debian's separate runtime
prerequisite remains unresolved.
The separate sponsorship request is open at
<https://forge.fedoraproject.org/packaging/sponsors/issues/802>; it asks for a
mentor and guidance on the runtime prerequisite and does not claim readiness
for archive acceptance.
`fedora-review-request.txt` records the submitted description and public artifact
URLs. Track current progress and prerequisites in
<https://github.com/abdallah-shehawey/whatsapp-desktop/issues/7>.
