#!/usr/bin/env bash
# Builds the extensions.gnome.org submission bundle.
set -euo pipefail
cd "$(dirname "$0")/.."

UUID=$(python3 -c 'import json;print(json.load(open("metadata.json"))["uuid"])')
SCHEMA=schemas/org.gnome.shell.extensions.macos-workspaces.gschema.xml

if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "gnome-extensions is not installed. On Debian/Ubuntu: sudo apt install gnome-shell" >&2
    exit 127
fi

# Refuse to ship something that does not pass its own checks. A bundle is the
# one artefact that reaches other people's machines.
./scripts/validate-schema.sh
./scripts/test.sh >/dev/null && echo "unit tests pass"

rm -f "${UUID}.shell-extension.zip"

# `pack` bundles extension.js, prefs.js, metadata.json and stylesheet.css by
# itself; lib/ has to be named, and --schema both includes and compiles.
gnome-extensions pack \
    --extra-source=lib \
    --schema="${SCHEMA}" \
    --force .

echo
echo "built ${UUID}.shell-extension.zip"
unzip -l "${UUID}.shell-extension.zip"
