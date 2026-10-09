# Official archive packaging proposal

This directory and `debian/` prepare the application for distribution review.
They do **not** mean it has been accepted into Fedora, Debian or Ubuntu.

The normal release packages contain a downloaded Electron binary. The separate
`make install-system` target installs our JavaScript and data under
`/usr/share/whatsapp-desktop` and starts a distribution-owned `/usr/bin/electron`.
It preserves the existing application, settings locations, fonts and URL
handling. It neither downloads Electron nor disables its sandbox.

## Runtime dependency

The proposal requires Electron 40 (`>= 40, < 41`), matching the upstream
application's major version. There is currently no corresponding runtime in the
target official archives. Debian's runtime request is
<https://bugs.debian.org/842420>. A source-built application package alone is
therefore insufficient for archive installation: the runtime must also be
packaged, reviewed and maintained, including its Chromium dependencies and
security updates. No prebuilt runtime may be substituted in these source
packages. Runtime source packaging is not completed by this proposal.

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

The maintainer's Fedora/FAS account `abdallah-shehawey` has been created.
The proposal is publicly posted to Fedora's devel list:
<https://lists.fedoraproject.org/archives/list/devel@lists.fedoraproject.org/thread/2L7VRATKFL4CDYQWCE5GXZHEFLLAG62P/>.
No formal Fedora Package Review ticket has been filed yet: Bugzilla login is
pending. `fedora-review-request.txt` contains the prepared review text and public
artifact URLs for that next step. Track current progress and prerequisites in
<https://github.com/abdallah-shehawey/whatsapp-desktop/issues/7>.
