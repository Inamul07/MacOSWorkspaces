#!/usr/bin/env bash
# Compiles the GSettings schema with --strict, so a warning is an error.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "glib-compile-schemas is not installed. On Debian/Ubuntu: sudo apt install libglib2.0-dev-bin" >&2
    exit 127
fi

glib-compile-schemas --strict --dry-run schemas/
echo "schema is valid"
