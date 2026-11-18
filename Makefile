# whatsapp-desktop -- WhatsApp Web in a window of its own.
#
# There is no compile step. `make install` stages a self-contained tree: a copy
# of Electron with its binary renamed, the app under resources/app where that
# binary looks for it, and a two-line launcher in bin.
#
# The rename is not cosmetic. Electron takes the application name from the name
# of the executable, and that name becomes the window's app_id -- which is how
# the desktop matches a window to its .desktop file, and so to its icon and its
# name in the switcher. Left as "electron", every window belongs to Electron.

PREFIX  ?= $(HOME)/.local
DESTDIR ?=
VERSION ?= $(shell node -p "require('./package.json').version")

# Which name, application id and artwork the installed copy carries. The
# project's own packages are the default brand: data/brand.json, data/icons and
# the data/<id>.* desktop entries. A build for a store or a distribution archive,
# where neither a vendor's name nor its logo may stand on a client that vendor
# did not make, passes BRAND=dardasha and takes all of those from
# data/brands/dardasha instead. src/brand.js reads whichever brand.json was
# installed; nothing is decided at run time.
BRAND ?= whatsapp
BRAND_DIR = $(if $(filter whatsapp,$(BRAND)),data,data/brands/$(BRAND))
brand_field = $(shell sed -n 's/^ *"$(1)": *"\([^"]*\)".*/\1/p' $(BRAND_DIR)/brand.json)
APP_ID  := $(call brand_field,id)
BIN     := $(call brand_field,bin)
MANPAGE  = $(if $(filter whatsapp,$(BRAND)),packaging/official/whatsapp-desktop.1,$(BRAND_DIR)/$(BIN).1)
ifeq ($(APP_ID),)
$(error no brand "$(BRAND)": $(BRAND_DIR)/brand.json is missing or has no id)
endif

bindir       = $(PREFIX)/bin
libdir       = $(PREFIX)/lib/$(BIN)
appdir       = $(PREFIX)/share/applications
icontheme    = $(PREFIX)/share/icons/hicolor
autostartdir = $(HOME)/.config/autostart

ELECTRON  = node_modules/electron/dist
SYSTEM_ELECTRON ?= /usr/bin/electron
# Inside a Flatpak, Chromium's sandbox can use neither the setuid helper nor
# user namespaces of its own; the Electron BaseApp's zypak carries it through
# the Flatpak sandbox instead, so the binary has to be started through it. A
# Flatpak build passes SANDBOX_WRAPPER=zypak-wrapper. Empty everywhere else,
# where the launcher runs the binary directly, as it always has.
SANDBOX_WRAPPER ?=
systemappdir = $(PREFIX)/share/$(BIN)
ICON_SIZES = 16 22 24 32 48 64 128 256

# Chromium ships 55 translations of a user interface this app never shows: no
# menu bar, no settings, no tabs. They are 45 MB of the 290 MB tree, and what is
# actually read from them is the odd context menu and file dialog, which fall
# back to en-US. Arabic is kept because the user reads it.
LOCALES = en-US ar

all: $(ELECTRON)/electron
	@echo "  nothing to build -- run 'make install' or 'npm start'"

$(ELECTRON)/electron:
	npm install --no-audit --no-fund

# What the app itself is: everything the runtime reads, and nothing else.
APP_FILES = package.json src data

# Lays the app down in $(1). Other brands' files are not the runtime's. Under a
# brand other than the default, that brand's brand.json and icons stand where
# the default's would, and the default brand's desktop entries and metadata are
# not copied at all.
BRAND_EXCLUDES = --exclude=./brands $(if $(filter whatsapp,$(BRAND)),,--exclude=./icons \
                 --exclude='./*.desktop' --exclude='./*.metainfo.xml')
define install_app_files
	@cp -a package.json src $(1)/
	@install -d $(1)/data
	@tar -C data $(BRAND_EXCLUDES) -cf - . | tar -C $(1)/data -xf -
	$(if $(filter whatsapp,$(BRAND)),,@cp -a $(BRAND_DIR)/icons $(1)/data/icons)
	$(if $(filter whatsapp,$(BRAND)),,@cp $(BRAND_DIR)/brand.json $(1)/data/brand.json)
endef

install: $(ELECTRON)/electron install-assets
	@install -d $(DESTDIR)$(libdir)
	@cp -a $(ELECTRON)/. $(DESTDIR)$(libdir)/
	@rm -f $(DESTDIR)$(libdir)/electron
	@# Removed rather than written over: install(1) writes through an existing
	@# file, and the binary being replaced is the one a running copy of the app
	@# is executing from. Unlinking it first leaves that copy with its own inode
	@# and gives the new one a fresh file, which is the difference between an
	@# upgrade over a running client working and it dying with a bus error.
	@rm -f $(DESTDIR)$(libdir)/$(BIN)
	@install -m755 $(ELECTRON)/electron $(DESTDIR)$(libdir)/$(BIN)
	@for f in $(DESTDIR)$(libdir)/locales/*.pak; do \
	  keep=""; for l in $(LOCALES); do [ "$$(basename $$f .pak)" = "$$l" ] && keep=1; done; \
	  [ -n "$$keep" ] || rm -f "$$f"; \
	done
	@# Cleared first, so a file that has been deleted from the source tree --
	@# a module that was split up, a page that was renamed -- does not survive
	@# in an installed tree as a stale copy that still gets required.
	@rm -rf $(DESTDIR)$(libdir)/resources/app
	@install -d $(DESTDIR)$(libdir)/resources/app
	$(call install_app_files,$(DESTDIR)$(libdir)/resources/app)
	@# Chromium's sandbox uses unprivileged user namespaces where they are
	@# allowed, and falls back to this setuid helper where they are not --
	@# Ubuntu confines the first behind AppArmor, so there it is the helper or
	@# no start at all. Electron ships it 0755, so the bit is set here, on the
	@# staged tree too: the package records the mode, and every install and
	@# every upgrade lays it down again. Root ownership is the packaging's
	@# (dpkg-deb --root-owner-group, rpmbuild, makepkg under fakeroot); a local
	@# install has only the user's, which Chromium rejects -- and does not need,
	@# since a system that allows namespaces never looks at the helper. Under
	@# SANDBOX_WRAPPER the helper is never used, and a Flatpak takes no setuid
	@# file, so the bit is left off.
	$(if $(SANDBOX_WRAPPER),,@chmod 4755 $(DESTDIR)$(libdir)/chrome-sandbox 2>/dev/null || true)
	@install -d $(DESTDIR)$(bindir)
	@printf '#!/bin/sh\n'                                                     >  $(DESTDIR)$(bindir)/$(BIN)
	@printf '# A terminal inside VS Code exports ELECTRON_RUN_AS_NODE=1, and\n' >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# an Electron that inherits it starts as plain node instead.\n'   >> $(DESTDIR)$(bindir)/$(BIN)
	@printf 'unset ELECTRON_RUN_AS_NODE\n'                                    >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '\n'                                                              >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# The desktop font is imposed through fontconfig, and fontconfig is\n' >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# read once, early -- before any of the app%ss own code runs. So the\n' "'" >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# variable has to be in the environment the binary is executed with.\n'   >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# The file itself is written by the app; the first ever launch has\n'     >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '# none, notices, and restarts itself once.\n'                    >> $(DESTDIR)$(bindir)/$(BIN)
	@printf 'wa_fonts="$${XDG_DATA_HOME:-$$HOME/.local/share}/whatsapp-desktop/fonts.conf"\n' >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '[ -f "$$wa_fonts" ] && export FONTCONFIG_FILE="$$wa_fonts"\n'    >> $(DESTDIR)$(bindir)/$(BIN)
	@printf '\n'                                                              >> $(DESTDIR)$(bindir)/$(BIN)
	@printf 'exec %s%s/%s "$$@"\n' "$(if $(SANDBOX_WRAPPER),$(SANDBOX_WRAPPER) )" "$(libdir)" "$(BIN)" >> $(DESTDIR)$(bindir)/$(BIN)
	@chmod 755 $(DESTDIR)$(bindir)/$(BIN)
	@echo "  INSTALL  $(DESTDIR)$(bindir)/$(BIN)  ($$(du -sh $(DESTDIR)$(libdir) | cut -f1))"

# Distribution packages contain only our application source. The distribution
# owns Electron, its sandbox, libraries, translations and security updates.
# This target has no dependency on npm or a downloaded Electron executable.
install-system: install-assets
	@install -d $(DESTDIR)$(systemappdir)
	$(call install_app_files,$(DESTDIR)$(systemappdir))
	@install -d $(DESTDIR)$(bindir)
	@sed -e 's|@ELECTRON_BIN@|$(SYSTEM_ELECTRON)|g' \
	      -e 's|@APPDIR@|$(systemappdir)|g' \
	      -e 's|@VERSION@|$(VERSION)|g' \
	      -e 's|@APP_ID@|$(APP_ID)|g' \
	      -e 's|@BIN@|$(BIN)|g' \
	      packaging/official/whatsapp-desktop.in > $(DESTDIR)$(bindir)/$(BIN)
	@chmod 755 $(DESTDIR)$(bindir)/$(BIN)
	@install -d $(DESTDIR)$(PREFIX)/share/metainfo
	@# Releases are recorded once, in the default brand's metadata; another
	@# brand's file marks with @RELEASES@ where the same block goes.
	@awk 'FNR == NR { if (/<releases>/) keep = 1; if (keep) block = block $$0 "\n"; if (/<\/releases>/) keep = 0; next } \
	      /@RELEASES@/ { printf "%s", block; next } { print }' \
	      data/io.github.shehawey.whatsapp-desktop.metainfo.xml $(BRAND_DIR)/$(APP_ID).metainfo.xml \
	      > $(DESTDIR)$(PREFIX)/share/metainfo/$(APP_ID).metainfo.xml
	@chmod 644 $(DESTDIR)$(PREFIX)/share/metainfo/$(APP_ID).metainfo.xml
	@install -Dm644 $(MANPAGE) $(DESTDIR)$(PREFIX)/share/man/man1/$(BIN).1
	@echo "  INSTALL  source application using $(SYSTEM_ELECTRON)"

install-assets:
	@# Tray icons land in both contexts: SNI hosts disagree on which they search.
	@for s in $(ICON_SIZES); do \
	  for f in $$(cd $(BRAND_DIR)/icons/$$s && ls apps/*.png status/*.png); do \
	    install -Dm644 $(BRAND_DIR)/icons/$$s/$$f $(DESTDIR)$(icontheme)/$${s}x$${s}/$$f; \
	  done; \
	done
	@install -d $(DESTDIR)$(appdir)
	@sed 's|@BINDIR@|$(bindir)|g' $(BRAND_DIR)/$(APP_ID).desktop > $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@chmod 644 $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@# Skipped when staging for a package; packaging scripts run them.
	@test -n "$(DESTDIR)" || update-desktop-database $(appdir) 2>/dev/null || true
	@test -n "$(DESTDIR)" || gtk-update-icon-cache -qtf $(icontheme) 2>/dev/null || true

# Start hidden at login: connected and in the tray, no window on screen.
autostart: install
	@install -d $(autostartdir)
	@sed 's|@BINDIR@|$(bindir)|g' $(BRAND_DIR)/$(APP_ID)-autostart.desktop > $(autostartdir)/$(APP_ID).desktop
	@chmod 644 $(autostartdir)/$(APP_ID).desktop
	@echo "  AUTOSTART  $(autostartdir)/$(APP_ID).desktop"

no-autostart:
	rm -f $(autostartdir)/$(APP_ID).desktop

uninstall: no-autostart
	rm -rf $(DESTDIR)$(libdir)
	rm -f $(DESTDIR)$(bindir)/$(BIN) $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@for s in $(ICON_SIZES); do \
	  for f in $$(cd $(BRAND_DIR)/icons/$$s && ls apps/*.png status/*.png); do \
	    rm -f $(DESTDIR)$(icontheme)/$${s}x$${s}/$$f; \
	  done; \
	done

icons:
	python3 tools/make-icons.py $(filter-out whatsapp,$(BRAND))

# The link-preview card the landing page advertises. Committed under docs/, so
# run this only when the wording or the launcher icon changes.
og:
	python3 tools/make-og.py

# The pictures of the client's own windows, for the README and the site. Real
# windows with their real preloads, grown to their full content -- so run this
# whenever one of them gains or loses a row, and commit what comes out. The site
# reads the same files: docs/ is served from main, and nothing fetches them from
# elsewhere.
SHOTS = settings fonts about
screenshots:
	@env -u ELECTRON_RUN_AS_NODE npx electron tools/capture-windows.js
	@for s in $(SHOTS); do cp screenshots/$$s.png docs/assets/$$s.png; done
	@echo "  SHOTS  screenshots/ and docs/assets/"

# Replays page, notification and desktop behavior in plain node -- no browser,
# account or live desktop session.
test:
	@node tools/test-relaunch.js
	@node tools/test-connection.js
	@node tools/test-inject.js
	@node tools/test-navigation.js
	@node tools/test-motion.js
	@node tools/test-wallpaper.js
	@node tools/test-warmup.js
	@node tools/test-find.js
	@node tools/test-keys.js
	@node tools/test-portal-keys.js
	@node tools/test-bidi.js
	@node tools/test-wording.js
	@node tools/test-style.js
	@node tools/test-themes.js
	@node tools/test-fonts.js
	@node tools/test-settings.js
	@node tools/test-links.js
	@node tools/test-tray.js
	@node tools/test-window.js
	@node tools/test-x11.js
	@node tools/test-display.js
	@node tools/test-desktop.js
	@node tools/test-mpris.js
	@node tools/test-config.js
	@node tools/test-privacy.js
	@node tools/test-lock.js
	@node tools/test-update.js

run:
	@env -u ELECTRON_RUN_AS_NODE npm start

package-deb:
	packaging/build-deb.sh

package-rpm:
	packaging/build-rpm.sh

package-arch:
	@mkdir -p dist
	@cp packaging/PKGBUILD dist/PKGBUILD
	@sed -i 's/^pkgver=.*/pkgver=$(VERSION)/' dist/PKGBUILD
	@cd dist && makepkg --clean --cleanbuild --syncdeps --noconfirm
	@rm -f dist/PKGBUILD

# A single file that runs on a distribution this project has no package for.
# It carries its own copy of Electron, so it is large; that is the trade.
package-appimage:
	@packaging/build-appimage.sh

# Not built here: flatpak-builder wants a runtime and an SDK installed, which is
# a gigabyte of download the other targets do not need. The manifest is kept
# with them so it stays in step with what `make install` lays down -- it builds
# through that same target.
package-flatpak:
	@echo "  flatpak-builder --force-clean build-dir packaging/io.github.abdallah_shehawey.dardasha.yml"

package-source:
	@mkdir -p dist
	@git archive --format=tar.gz --prefix=whatsapp-desktop-$(VERSION)/ -o dist/whatsapp-desktop-$(VERSION)-source.tar.gz HEAD
	@sha256sum dist/* > dist/SHA256SUMS
	@echo "  SOURCE  dist/whatsapp-desktop-$(VERSION)-source.tar.gz"

package: package-deb package-rpm package-arch package-appimage package-source

clean:
	rm -rf node_modules

.PHONY: all install install-system install-assets autostart no-autostart uninstall icons og screenshots test run package-deb package-rpm package-arch package-appimage package-flatpak package-source package clean
