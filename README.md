# MacOS Workspaces

A GNOME Shell 46 extension that gives every monitor its own independent workspace
stack, the way macOS does.

With GNOME's **Workspaces on All Displays** enabled, a three-finger swipe moves
*every* monitor to the same new workspace at once. This extension intercepts the
gesture, works out which display the cursor is on, and slides only that display —
leaving the others exactly where they were.

> **Status: Phase 2 — state engine.** The extension tracks an independent
> workspace index per monitor but does not yet act on it. Gesture interception
> lands in Phase 3, keyboard switching in Phase 4.
> See [plan.md](plan.md) for the full roadmap.

---

## Requirements

| Requirement | Version |
|-------------|---------|
| GNOME Shell | 46 (Ubuntu 24.04 LTS) |
| Session     | Wayland (X11 is best-effort) |
| GJS         | ≥ 1.78 (ships with GNOME 46) |
| Build tools | `glib-compile-schemas` only |

There are no npm, pip or apt dependencies beyond what Ubuntu 24.04 ships.

---

## Quick start

Clone the repository, then launch a nested Wayland session with the extension
installed and enabled:

```bash
./scripts/dev-session.sh
```

The nested Shell opens in its own window. Close that window to end the session.
The nested window defaults to 1024x576 so it fits on a 1366x768 display; override
it with `NESTED_RES=1440x900 ./scripts/dev-session.sh` on a larger monitor.

The nested session runs against a private dconf database
(`~/.config/dconf/macos-workspaces-dev`) rather than your own. `dconf` is keyed on
the user and not on the D-Bus session, so without that isolation every setting the
script applies would land on your live desktop. A side effect is that the nested
Shell starts from stock GNOME defaults, with none of your distro's extensions
loaded — Ubuntu's Desktop Icons NG (`DING:` log lines) included.

Launch from an unconfined terminal. Snap and Flatpak confinement is inherited by
every process the nested Shell spawns, which surfaces as helper processes failing
to load `libc.so.6`; the script refuses to start in that case.

### Manual install

```bash
UUID=macos-workspaces@macosworkspaces.dev
DEST=~/.local/share/gnome-shell/extensions/$UUID
mkdir -p "$DEST"
cp -r extension.js prefs.js metadata.json schemas "$DEST/"
glib-compile-schemas "$DEST/schemas/"
gnome-extensions enable "$UUID"
```

On Wayland the Shell cannot be restarted in place, so log out and back in for a
fresh install to be picked up. Inside a nested session, just relaunch the script.

---

## Day-to-day commands

```bash
# Enable / disable / reset
gnome-extensions enable  macos-workspaces@macosworkspaces.dev
gnome-extensions disable macos-workspaces@macosworkspaces.dev
gnome-extensions reset   macos-workspaces@macosworkspaces.dev

# Open the preferences window
gnome-extensions prefs macos-workspaces@macosworkspaces.dev

# Recompile the settings schema after editing it
glib-compile-schemas --strict schemas/

# Watch the Shell log while you test
journalctl -f -o cat /usr/bin/gnome-shell
```

For interactive poking at Shell internals, press <kbd>Alt</kbd>+<kbd>F2</kbd>,
type `lg`, and hit Enter to open Looking Glass.

---

## Verifying a clean load

Everything the extension logs is prefixed with `[macos-workspaces]`:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep macos-workspaces
```

A healthy enable/disable cycle prints exactly two lines and no warnings:

```
[macos-workspaces] enabled (v0.1.0)
[macos-workspaces] disabled
```

---

## Layout

```
extension.js   Shell-side entry point (enable / disable lifecycle)
prefs.js       Adw.PreferencesWindow — stub until Phase 6
metadata.json  UUID, target shell-version, settings-schema id
schemas/       GSettings schema; keys are defined in Phase 6
scripts/       Developer tooling, not shipped to users
plan.md        Phase-by-phase implementation plan
AGENTS.md      Authoritative reference for agents working on this codebase
```

`lib/` arrives with Phase 2. Per the Phase 1 key decisions, **all GNOME Shell
internal API access is confined to `lib/shellInterop.js`** — no other module may
reach into `Main.wm`, `WorkspaceAnimationController` or `MonitorGroup` directly.
That single choke point is what makes the version-guard shim possible.

---

## A note on internal APIs

This extension depends on GNOME Shell internals (`Main.wm._workspaceAnimation`
and friends) that carry no stability guarantee. They are verified correct for
GNOME Shell 46. On any other version the version guard logs a warning and the
extension disables itself rather than breaking your session.

---

## License

GPL-2.0-or-later. See `LICENSE` (added in Phase 9).
