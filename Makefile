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

APP_ID  = io.github.shehawey.whatsapp-desktop
BIN     = whatsapp-desktop

bindir       = $(PREFIX)/bin
libdir       = $(PREFIX)/lib/$(BIN)
appdir       = $(PREFIX)/share/applications
icontheme    = $(PREFIX)/share/icons/hicolor
autostartdir = $(HOME)/.config/autostart

ELECTRON  = node_modules/electron/dist
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

install: $(ELECTRON)/electron
	@install -d $(DESTDIR)$(libdir)
	@cp -a $(ELECTRON)/. $(DESTDIR)$(libdir)/
	@rm -f $(DESTDIR)$(libdir)/electron
	@install -m755 $(ELECTRON)/electron $(DESTDIR)$(libdir)/$(BIN)
	@for f in $(DESTDIR)$(libdir)/locales/*.pak; do \
	  keep=""; for l in $(LOCALES); do [ "$$(basename $$f .pak)" = "$$l" ] && keep=1; done; \
	  [ -n "$$keep" ] || rm -f "$$f"; \
	done
	@install -d $(DESTDIR)$(libdir)/resources/app
	@cp -a $(APP_FILES) $(DESTDIR)$(libdir)/resources/app/
	@# Chromium's sandbox uses unprivileged user namespaces where they are
	@# allowed, and falls back to this setuid helper where they are not. It has
	@# to be owned by root to be either, so a staged package install leaves the
	@# mode and lets the packaging own it.
	@test -n "$(DESTDIR)" || chmod 4755 $(DESTDIR)$(libdir)/chrome-sandbox 2>/dev/null || true
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
	@printf 'exec %s/%s "$$@"\n' "$(libdir)" "$(BIN)"                         >> $(DESTDIR)$(bindir)/$(BIN)
	@chmod 755 $(DESTDIR)$(bindir)/$(BIN)
	@# Tray icons land in both contexts: SNI hosts disagree on which they search.
	@for s in $(ICON_SIZES); do \
	  for f in apps/$(APP_ID).png apps/$(APP_ID)-tray.png \
	           status/$(APP_ID)-tray.png status/$(APP_ID)-tray-attention.png; do \
	    install -Dm644 data/icons/$$s/$$f $(DESTDIR)$(icontheme)/$${s}x$${s}/$$f; \
	  done; \
	done
	@install -d $(DESTDIR)$(appdir)
	@sed 's|@BINDIR@|$(bindir)|g' data/$(APP_ID).desktop > $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@chmod 644 $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@# Skipped when staging for a package; packaging scripts run them.
	@test -n "$(DESTDIR)" || update-desktop-database $(appdir) 2>/dev/null || true
	@test -n "$(DESTDIR)" || gtk-update-icon-cache -qtf $(icontheme) 2>/dev/null || true
	@echo "  INSTALL  $(DESTDIR)$(bindir)/$(BIN)  ($$(du -sh $(DESTDIR)$(libdir) | cut -f1))"

# Start hidden at login: connected and in the tray, no window on screen.
autostart: install
	@install -d $(autostartdir)
	@sed 's|@BINDIR@|$(bindir)|g' data/$(APP_ID)-autostart.desktop > $(autostartdir)/$(APP_ID).desktop
	@chmod 644 $(autostartdir)/$(APP_ID).desktop
	@echo "  AUTOSTART  $(autostartdir)/$(APP_ID).desktop"

no-autostart:
	rm -f $(autostartdir)/$(APP_ID).desktop

uninstall: no-autostart
	rm -rf $(DESTDIR)$(libdir)
	rm -f $(DESTDIR)$(bindir)/$(BIN) $(DESTDIR)$(appdir)/$(APP_ID).desktop
	@for s in $(ICON_SIZES); do \
	  rm -f $(DESTDIR)$(icontheme)/$${s}x$${s}/apps/$(APP_ID).png \
	        $(DESTDIR)$(icontheme)/$${s}x$${s}/apps/$(APP_ID)-tray.png \
	        $(DESTDIR)$(icontheme)/$${s}x$${s}/status/$(APP_ID)-tray.png \
	        $(DESTDIR)$(icontheme)/$${s}x$${s}/status/$(APP_ID)-tray-attention.png; \
	done

icons:
	python3 tools/make-icons.py

# Replays a chat list past src/page/inject.js in plain node -- no browser, no
# account. Every notification bug this client has had lived in that file.
test:
	@node tools/test-inject.js
	@node tools/test-style.js

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

package-source:
	@mkdir -p dist
	@git archive --format=tar.gz --prefix=whatsapp-desktop-$(VERSION)/ -o dist/whatsapp-desktop-$(VERSION)-source.tar.gz HEAD
	@sha256sum dist/* > dist/SHA256SUMS
	@echo "  SOURCE  dist/whatsapp-desktop-$(VERSION)-source.tar.gz"

package: package-deb package-rpm package-arch package-source

clean:
	rm -rf node_modules

.PHONY: all install autostart no-autostart uninstall icons test run package-deb package-rpm package-arch package-source package clean
