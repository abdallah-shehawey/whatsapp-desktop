# Official archive packaging

This directory and `debian/` package the client for review by Fedora and Debian.
Neither archive has accepted it yet. See [Status](#status).

The project's own packages bundle Electron. These packages work differently:
`make install-system` installs only the application, under
`/usr/share/<command>`, and runs it with the distribution's
`/usr/bin/electron`. Nothing is downloaded, and Electron's sandbox stays on.

## Name in the archives: Dardasha

Distribution archives don't accept the WhatsApp name or logo on a client that
WhatsApp didn't make, so the Fedora and Debian packages are named `dardasha`:

- name Dardasha (دردشة, "chat"), command `dardasha`, application ID `io.github.abdallah_shehawey.dardasha`
- original artwork, in `data/brands/dardasha/icons`
- separate desktop entries, AppStream metadata, manual page and README

`make install-system BRAND=dardasha` selects this brand, and `src/brand.js`
uses the name in window titles, the tray, notifications and the client's own
pages. The project's own channels keep the default WhatsApp brand: the shinux
repository, GitHub releases, the AppImage and npm. Both builds use the same
settings folder (`~/.config/whatsapp-desktop`) and session folder
(`~/.local/share/whatsapp-desktop`), so switching between them keeps you signed
in.

The release list is kept only in the default brand's metadata, and
`make install-system` copies it into Dardasha's. `tools/test-system-package.py`
installs both brands and checks each one.

## Electron runtime

| Package | Runtime dependency |
|---|---|
| Fedora (`dardasha.spec`) | `(electron >= 44 with electron < 45)`, as both `Requires` and `BuildRequires` |
| Debian (`debian/control`) | `electron (>= 44), electron (<< 45)` |

Fedora Rawhide ships `nodejs-electron` 44, which has been stable there since
2026-11-17. [fedora-runtime-check.md](fedora-runtime-check.md) has the evidence
and its limits. The rich dependency means a single installed Electron has to
satisfy both bounds. Because it's also a `BuildRequires`, the package stops
building as soon as Rawhide moves past Electron 44, where both maintainers will
notice. Debian doesn't package Electron yet
([#842420](https://bugs.debian.org/842420)), and that blocks the Debian upload.

## Build-time Node.js

At run time the client uses the Node.js that comes with Electron. The build
needs Node.js only to run the test suite. Both packages require
`nodejs (>= 20)`, because `tools/test-x11.js` uses abstract unix sockets, which
Node.js versions before 18.20 reject. That rules out Ubuntu 24.04's Node.js
18.19. Debian 13's Node.js 20.19 works, and CI builds the Debian package in a
Debian 13 container.

## Building the review artifacts

From a clean, committed checkout with Node.js, Python, make, `dpkg-source` and
`rpmbuild` installed:

```sh
packaging/official/build-source-packages.sh
```

The script writes the SRPM, the Debian source package, `build-manifest.json`
(commit, tag and runtime range) and `SHA256SUMS` to `dist/official`. Set `DIST`
to write them somewhere else, and set `RPM_DIST=.fc46` to build a Rawhide SRPM.
Before building, the script checks that `dardasha.spec`, `debian/control` and
the release tag agree. Review tags follow the pattern
`packaging-review-<package>-<version>-fedora<electron major>`, for example
`packaging-review-dardasha-1.10.5-fedora44`.

To build binary packages from those sources:

- **Debian:** run `dpkg-source -x` on the `.dsc`, then `dpkg-buildpackage -us -uc -b`
- **Fedora:** install the SRPM with `rpm -i`, then run `rpmbuild -ba` on its SPEC

Both builds run the test suite and check the launcher and metadata. They don't
build Electron from source.

## Status

- **Fedora:** [package review #2548541](https://bugzilla.redhat.com/show_bug.cgi?id=2548541) is waiting for a sponsor ([sponsorship request](https://forge.fedoraproject.org/packaging/sponsors/issues/802)). [`fedora-review-request.txt`](fedora-review-request.txt) is the description that was submitted.
- **Debian:** [ITP #1150415](https://bugs.debian.org/1150415) is blocked until Debian has an Electron package ([#842420](https://bugs.debian.org/842420)).
- **Ubuntu:** Ubuntu usually picks up new packages from Debian.

Progress and history are tracked in
[issue #7](https://github.com/abdallah-shehawey/whatsapp-desktop/issues/7).
