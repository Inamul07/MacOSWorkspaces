#!/usr/bin/env bash
#
# dev-session.sh — install this working tree and launch a nested Wayland
# GNOME Shell session with the extension already enabled.
#
# Run from a Wayland GNOME session on Ubuntu 24.04 / GNOME Shell 46.
# The nested Shell opens in its own window; close it to end the session.

set -euo pipefail

UUID='macos-workspaces@macosworkspaces.dev'
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"
# Sized to fit inside a 1366x768 panel once the host top bar and the nested
# window's own decorations are accounted for. Override for a larger display.
NESTED_RES="${NESTED_RES:-1024x576}"

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
# dconf derives a D-Bus object path from this name, and path elements admit
# only [A-Za-z0-9_] — a hyphen here makes every write hang on an invalid path.
DCONF_DB='macos_workspaces_dev'

die() { echo "dev-session: $*" >&2; exit 1; }

# ── Preflight ─────────────────────────────────────────────────────────────
command -v gnome-shell >/dev/null || die 'gnome-shell not found on PATH.'
command -v glib-compile-schemas >/dev/null || die 'glib-compile-schemas not found (install libglib2.0-dev-bin).'
command -v dbus-run-session >/dev/null || die 'dbus-run-session not found (install dbus-daemon).'

# Mutter's --nested backend is MetaBackendX11Nested: it parents itself to an X
# display, which on a Wayland desktop means the session's XWayland server. So
# DISPLAY is the hard requirement here, not WAYLAND_DISPLAY.
#
# Supplying DISPLAY by hand over ssh is not a workaround: the session that
# results starts far enough to load extensions but never finishes, leaving a
# shell that answers no D-Bus calls. Run this from the desktop instead.
if [[ -z "${DISPLAY:-}" ]]; then
    echo 'dev-session: DISPLAY is not set — the nested backend needs an X display.' >&2
    echo 'dev-session: run this from a terminal inside the desktop session.' >&2
    exit 1
fi

if [[ "${XDG_SESSION_TYPE:-}" != 'wayland' ]]; then
    echo "dev-session: note — session type is '${XDG_SESSION_TYPE:-unknown}'; using DISPLAY=${DISPLAY}." >&2
fi

SHELL_MAJOR="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
if [[ "${SHELL_MAJOR}" != '46' ]]; then
    echo "dev-session: warning — GNOME Shell ${SHELL_MAJOR} detected, extension targets 46." >&2
fi

# Snap and Flatpak confinement is inherited by everything the nested Shell
# spawns, which breaks helper processes in ways that look like Shell bugs.
if [[ -n "${SNAP:-}" || -n "${FLATPAK_ID:-}" ]]; then
    die 'running inside snap/flatpak confinement — launch from an unconfined terminal.'
fi

# ── Install ───────────────────────────────────────────────────────────────
echo "dev-session: installing ${SRC_DIR} -> ${DEST_DIR}"
rm -rf "${DEST_DIR}"
mkdir -p "${DEST_DIR}"
# Ship only what the Shell loads; leave docs, scripts and VCS metadata behind.
for item in extension.js prefs.js metadata.json stylesheet.css lib schemas; do
    [[ -e "${SRC_DIR}/${item}" ]] && cp -r "${SRC_DIR}/${item}" "${DEST_DIR}/"
done
glib-compile-schemas --strict "${DEST_DIR}/schemas/"

# ── Isolate settings ──────────────────────────────────────────────────────
# dconf is keyed on the user, not the bus: a fresh session bus still reads and
# writes ~/.config/dconf/user, so configuring the nested Shell would overwrite
# the live desktop's settings. A private profile points the nested session at
# its own database, which also means it starts from stock GNOME defaults with
# no distro extensions (Ubuntu's DING included) inherited from the host.
# A bare name in DCONF_PROFILE is resolved against /etc/dconf/profile, which we
# cannot write to; passing an absolute path is what makes a user-owned profile
# work. The user-db line inside it is still relative to ~/.config/dconf/.
DCONF_PROFILE_PATH="${CONFIG_HOME}/dconf/profile/${DCONF_DB}"
mkdir -p "${CONFIG_HOME}/dconf/profile"
printf 'user-db:%s\n' "${DCONF_DB}" > "${DCONF_PROFILE_PATH}"
echo "dev-session: using private dconf database ${CONFIG_HOME}/dconf/${DCONF_DB}"

# ── Launch ────────────────────────────────────────────────────────────────
echo "dev-session: launching nested Wayland session (${NESTED_RES})"
exec env DCONF_PROFILE="${DCONF_PROFILE_PATH}" dbus-run-session -- bash -c "
    gsettings set org.gnome.shell enabled-extensions \"['${UUID}']\"
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.mutter workspaces-only-on-primary false
    exec env MUTTER_DEBUG_DUMMY_MODE_SPECS='${NESTED_RES}' \
        gnome-shell --nested --wayland
"
