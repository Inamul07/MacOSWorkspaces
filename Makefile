# MacOS Workspaces — development and packaging
#
# The extension itself needs no build step; `schemas` is the only compilation
# involved, and even that is only needed for a local install.

UUID     := $(shell python3 -c 'import json;print(json.load(open("metadata.json"))["uuid"])')
EXTDIR   := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
ZIP      := $(UUID).shell-extension.zip
SOURCES  := extension.js prefs.js metadata.json lib schemas

.PHONY: all schemas install uninstall enable disable pack lint test check clean help

all: check

help:
	@echo "make install    install for the current user (then log out and back in)"
	@echo "make uninstall  remove it"
	@echo "make pack       build $(ZIP) for extensions.gnome.org"
	@echo "make check      lint, schema validation and unit tests"
	@echo "make test       unit tests only"
	@echo "make lint       eslint only"
	@echo "make clean      remove build artefacts"

schemas:
	glib-compile-schemas --strict schemas/

install: schemas
	@mkdir -p "$(EXTDIR)"
	@cp -r $(SOURCES) "$(EXTDIR)/"
	@echo "installed to $(EXTDIR)"
	@echo "GNOME only scans extensions at startup — log out and back in, then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	@rm -rf "$(EXTDIR)"
	@echo "removed $(EXTDIR)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Deliberately not dependent on `lint`: packaging must work on a machine with
# no npm and no network. pack.sh gates on the schema and the unit tests, which
# need only gjs.
pack:
	./scripts/pack.sh

lint:
	./scripts/lint.sh

test:
	./scripts/test.sh

check: lint
	./scripts/validate-schema.sh
	./scripts/test.sh

clean:
	rm -f $(ZIP) schemas/gschemas.compiled
