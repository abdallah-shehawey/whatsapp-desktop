pkgname=whatsapp-desktop
pkgver=1.6.5
pkgrel=1
pkgdesc='WhatsApp Web desktop client for Linux with tray integration, notifications, and Arabic text fixes'
arch=('x86_64')
url='https://github.com/abdallah-shehawey/whatsapp-desktop'
license=('GPL-3.0-or-later')
depends=('electron' 'hicolor-icon-theme')
makedepends=('gcc' 'make')
source=("https://github.com/abdallah-shehawey/whatsapp-desktop/archive/refs/tags/v${pkgver}.tar.gz")
sha256sums=('SKIP')

build() {
  cd "${srcdir}/${pkgname}-${pkgver}"
  make
}

package() {
  cd "${srcdir}/${pkgname}-${pkgver}"
  make DESTDIR="${pkgdir}" PREFIX=/usr install
  install -Dm644 LICENSE "${pkgdir}/usr/share/licenses/${pkgname}/LICENSE"
  install -Dm644 README.md "${pkgdir}/usr/share/doc/${pkgname}/README.md"
}

# vim: set ft=sh:

# Maintainer: Abdallah Shehawey <shehawey9@gmail.com>
# The package builds the same source tree used by the RPM and DEB releases.
# For a local checkout, replace source=() with the checkout path or run makepkg
# from the tagged source archive downloaded by GitHub.
