#!/usr/bin/env bash
# Lints every JavaScript file the extension ships, plus its tests.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
    echo "installing lint dependencies..." >&2
    npm install --no-audit --no-fund
fi

exec npx eslint extension.js prefs.js lib tests "$@"
