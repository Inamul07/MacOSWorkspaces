# MacOS Workspaces

A GNOME Shell 46 extension that gives every monitor its own independent workspace
stack, the way macOS does.

With GNOME's **Workspaces on All Displays** enabled, a three-finger swipe moves
*every* monitor to the same new workspace at once. This extension intercepts the
gesture, works out which display the cursor is on, and slides only that display —
leaving the others exactly where they were.

It does the same for `Ctrl`+`Alt`+arrow, and the workspace a secondary monitor
lands on **stays** — it really shows its own windows, rather than animating and
snapping back.

> **Status: 0.1.0.** Feature-complete for GNOME 46 and pending submission to
> extensions.gnome.org. See [plan.md](plan.md) for how it was built and
> [CHANGELOG.md](CHANGELOG.md) for what is in this release.

---

## Requirements

| Requirement | Version |
|-------------|---------|
| GNOME Shell | 46 (Ubuntu 24.04 LTS) |
| Session     | Wayland (X11 is best-effort) |
| GJS         | ≥ 1.78 (ships with GNOME 46) |
| Build tools | `glib-compile-schemas` only |

There are no npm, pip or apt dependencies beyond what Ubuntu 24.04 ships. The
`package.json` in this repository carries lint tooling for development and is
not part of what gets installed.

### GNOME settings this needs

Per-monitor workspaces are built by moving windows between GNOME's own
workspaces, which only works if that set of workspaces holds still:

```bash
gsettings set org.gnome.mutter workspaces-only-on-primary false
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
```

Dynamic workspaces are created and destroyed as you use them, which would strand
windows on workspaces you cannot reach. If they are on, the extension leaves the
window-moving half switched off and says so in the journal; gestures and
shortcuts still work. Four is the minimum: three to slide within, and one to
park everything else clear of them.

---

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Wrap around | off | A secondary monitor continues past the last workspace to the first. The primary always stops at either end, as GNOME does — it drives the real workspace, and wrapping it would slide backwards across every workspace to get there. |
| Slide duration | 250 ms | How long a switch takes. A swipe is *scaled* by this rather than fixed to it, so a fast flick stays fast. |

There is also a hidden `debug-logging` key, off by default, for diagnosing a
problem:

```bash
gsettings --schemadir ~/.local/share/gnome-shell/extensions/macos-workspaces@inamul07.github.io/schemas \
    set org.gnome.shell.extensions.macos-workspaces debug-logging true
journalctl -f -o cat /usr/bin/gnome-shell | grep macos-workspaces
```

---

## Known limitations

These are consequences of how GNOME works, not bugs waiting to be fixed:

- **The Overview disagrees with your eyes.** GNOME has exactly one workspace at a
  time and binds windows to workspaces globally. Giving a second monitor its own
  workspace means moving its windows onto whichever workspace is on screen — so
  the Overview, the workspace switcher and Alt+Tab show where a window is
  *parked*, which is not always where you see it. The only alternative GNOME
  offers is confining workspaces to the primary monitor, which gives secondary
  displays no workspaces at all.
- **The primary monitor's windows are never moved.** That is deliberate: a fault
  in the window-moving code cannot scatter the windows on the display you are
  most likely working on.
- **Positions reset if displays change while the screen is locked.** They are
  preserved across an ordinary lock and unlock.

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
UUID=macos-workspaces@inamul07.github.io
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
gnome-extensions enable  macos-workspaces@inamul07.github.io
gnome-extensions disable macos-workspaces@inamul07.github.io
gnome-extensions reset   macos-workspaces@inamul07.github.io

# Open the preferences window
gnome-extensions prefs macos-workspaces@inamul07.github.io

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
prefs.js       Adw.PreferencesWindow — stub until Phase 7
metadata.json  UUID, target shell-version, settings-schema id
schemas/       GSettings schema; keys are defined in Phase 7
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

GPL-2.0-or-later. See `LICENSE` (added in Phase 10).
