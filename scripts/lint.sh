#!/usr/bin/env bash
# Lints every JavaScript file the extension ships, plus its tests.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npm >/dev/null 2>&1; then
    echo "npm is not installed; it is needed for eslint but for nothing else." >&2
    echo "The unit tests and packaging do not need it: try 'make test' or 'make pack'." >&2
    exit 127
fi

if [ ! -d node_modules ]; then
    echo "installing lint dependencies..." >&2
    npm install --no-audit --no-fund
fi

exec npx eslint extension.js prefs.js lib tests "$@"
