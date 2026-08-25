#!/usr/bin/env bash
# Runs the unit test suite. Needs gjs; nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v gjs >/dev/null 2>&1; then
    echo "gjs is not installed. On Debian/Ubuntu: sudo apt install gjs" >&2
    exit 127
fi

exec gjs -m tests/run.js
