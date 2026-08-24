# AGENTS.md — MacOS Workspaces GNOME Extension

> This file is the authoritative reference for AI agents working on this codebase.
> Read it **in full** before writing, modifying, or deleting any file.

---

## Project Overview

**MacOS Workspaces** is a GNOME Shell 46 extension for Ubuntu 24.04 LTS (Noble Numbat) that replicates macOS-style **per-monitor independent workspace switching**.

### The Problem
When GNOME is configured with "Workspaces on All Displays" (`org.gnome.mutter workspaces-only-on-primary = false`), a three-finger touchpad swipe switches workspaces **globally** — every monitor advances simultaneously. macOS instead maintains a separate workspace stack per monitor: swiping on display A only affects display A.

### What This Extension Does
- Intercepts the `WorkspaceAnimationController`'s swipe tracker before it resolves gestures
- Determines which monitor the swipe originated on via cursor position
- Drives **only that monitor's** `MonitorGroup` slide animation
- Keeps all other monitors frozen on their current virtual workspace
- Maintains an independent `Map<monitorIndex, virtualWorkspaceIndex>` as the source of truth
- Only activates the matching GNOME global workspace when the gesture is on the **primary monitor**

### Technology Stack
- **Language:** GJS (GNOME JavaScript) — ES modules (mandatory for GNOME 45+)
- **Runtime:** GNOME Shell 46, Ubuntu 24.04 LTS, Wayland session (primary target)
- **UI:** `gi://Adw` (libadwaita) for preferences, `gi://St` for any Shell UI
- **Settings:** `gi://Gio` GSettings with a compiled XML schema
- **Build:** No bundler — only `glib-compile-schemas` is required
- **Test runner:** GJS (`gjs tests/run.js`)

### Key Internal GNOME Shell APIs Used
| Symbol | File | Purpose |
|--------|------|---------|
| `Main.wm._workspaceAnimation` | `js/ui/main.js` | Entry point to the animation controller |
| `WorkspaceAnimationController` | `js/ui/workspaceAnimation.js` | Owns `SwipeTracker` and `MonitorGroup` actors |
| `SwipeTracker` | `js/ui/swipeTracker.js` | Emits `begin(monitor)`, `update(progress)`, `end(duration, endProgress)` |
| `wac._swipeTracker` | `js/ui/workspaceAnimation.js:338` | **The interception point** — we take over its three signals |
| `MonitorGroup.updateSwipeForMonitor()` | `js/ui/workspaceAnimation.js:310` | Per-monitor progress; handles RTL and vertical layouts for us |
| `MonitorGroup.index` | `js/ui/workspaceAnimation.js:261` | Monitor identity the state map is keyed on |
| `Main.wm.setCustomKeybindingHandler()` | `js/ui/windowManager.js:1095` | Keyboard interception point (Phase 4) |
| `Main.wm._showWorkspaceSwitcher` | `js/ui/windowManager.js:560-596` | Stock keybinding handler; restore target on disable |
| `MonitorGroup` | `js/ui/workspaceAnimation.js` | Per-physical-monitor slide actor; `.progress` drives animation |
| `wac._findMonitorGroup()` | `js/ui/workspaceAnimation.js:448` | Dereferences `_switchData` unguarded — **throws** when no switch is in flight, so guard before calling |
| `Main.overview` `showing` handler | `js/ui/workspaceAnimation.js:322` | Tears down a gesture-activated switch outright; our ease must settle from `onStopped`, not `onComplete` |
| `workspaceManager.layout_rows` / `layout_columns` | Mutter GObject | `-1` means unbounded on that axis; the Shell uses both to decide which arrow keys a layout answers (`windowManager.js:637-645`) |
| `global.workspace_manager` | Mutter GObject | Logical workspace creation/activation |
| `global.display.get_monitor_index_for_rect()` | Mutter | Maps cursor coordinates to monitor index |

> ⚠️ **Internal API Warning:** All APIs above are GNOME Shell internals with no stability guarantee. They are verified correct for GNOME 46. The version-guard shim in `lib/shellInterop.js` must check for their existence and disable the extension gracefully if they are absent or renamed.

---

### Reading the Shell's own source
The GNOME 46 JS is **not** on disk and **not** in any `/usr/share/gnome-shell/*.gresource`.
It is linked into `libshell-14.so`:

```bash
ssh UbuntuHP 'mkdir -p /tmp/gs-src && cd /tmp/gs-src && \
  gresource extract /usr/lib/gnome-shell/libshell-14.so \
    /org/gnome/shell/ui/workspaceAnimation.js > workspaceAnimation.js'
```

`gresource list /usr/bin/gnome-shell` says `Can't find resource section`, and
`/usr/lib/gnome-shell/libgnome-shell.so` does not exist on Ubuntu 24.04 — neither
means the source is unavailable. Check assumptions about Shell behaviour against
this rather than against memory; three separate bugs in this project came from
guessing what stock GNOME does.

---

## Build and Test Commands

```bash
# ── Schema compilation (required after any schema change) ──────────────────
glib-compile-schemas schemas/

# ── Install extension to user directory ───────────────────────────────────
make install
# Equivalent manual:
cp -r . ~/.local/share/gnome-shell/extensions/macos-workspaces@macosworkspaces.dev/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/macos-workspaces@macosworkspaces.dev/schemas/

# ── Uninstall ──────────────────────────────────────────────────────────────
make uninstall

# ── Start a nested Wayland test session (requires a Wayland host) ──────────
./scripts/dev-session.sh
# Equivalent (GNOME 48 and earlier):
dbus-run-session gnome-shell --nested --wayland

# ── Enable / disable / reload inside the nested session ───────────────────
gnome-extensions enable  macos-workspaces@macosworkspaces.dev
gnome-extensions disable macos-workspaces@macosworkspaces.dev
gnome-extensions reset   macos-workspaces@macosworkspaces.dev

# ── Open preferences window ───────────────────────────────────────────────
gnome-extensions prefs macos-workspaces@macosworkspaces.dev

# ── Run unit tests ────────────────────────────────────────────────────────
gjs tests/run.js

# ── Lint ──────────────────────────────────────────────────────────────────
./scripts/lint.sh
# Requires: npm install -g eslint  (one-time setup)

# ── Validate schema (strict mode) ─────────────────────────────────────────
./scripts/validate-schema.sh

# ── Package for distribution ──────────────────────────────────────────────
make pack
# Produces: macos-workspaces@macosworkspaces.dev.zip

# ── Monitor Shell logs in real time ───────────────────────────────────────
journalctl -f -o cat /usr/bin/gnome-shell

# ── GNOME Looking Glass (in-Shell JS REPL for debugging) ──────────────────
# Press Alt+F2 → type: lg
```

---


## Code Style Guidelines

### Language & Module Format
- **ES modules only.** Every file uses `import`/`export`. Never use `const X = imports.Y`.
- Use `import Foo from 'gi://Foo'` for GI bindings; `import * as Bar from './bar.js'` for local modules.
- Top-level `import` declarations must appear before any executable code.

### Class Conventions
- Extension entry point: `export default class` extending `Extension` from `resource:///org/gnome/shell/extensions/extension.js`.
- GObject subclasses: `GObject.registerClass({ ... }, class Foo extends GObject.Object { ... })`.
- Private fields use `_` prefix. All signal connection IDs must be disconnected in `destroy()` / `disable()`.

### Naming
- Files: `camelCase.js` — Classes: `PascalCase` — Methods/variables: `camelCase` — Private: `_camelCase`
- GSettings keys: `kebab-case` — Constants: `UPPER_SNAKE_CASE`

### Error Handling & Safety
- All access to `Main.wm._workspaceAnimation` and other internal paths **must** be guarded:
  ```js
  const wac = Main.wm?._workspaceAnimation;
  if (!wac || typeof wac._switchWorkspaceBegin !== 'function') {
      console.warn('[macos-workspaces] Incompatible GNOME Shell version — disabling.');
      return;
  }
  ```
- Never `throw` from `enable()` or `disable()`. Log via `console.error()` and return early.
- Always clean up signal connections in `disable()` to prevent memory leaks.

### Logging
- `console.log('[macos-workspaces] ...')` — info level
- `console.warn('[macos-workspaces] ...')` — non-fatal issues
- `console.error('[macos-workspaces] ...')` — errors
- Remove or gate all debug logs behind a GSettings flag before packaging.

### Formatting
- 4-space indentation (spaces, not tabs) · Single quotes · Semicolons required
- Max line length: 100 characters · Trailing comma in multi-line objects/arrays

### Comments
- Every exported class and public method must have JSDoc (`/** ... */`).
- Mark all internal API touch-points with: `// GNOME INTERNAL: <filename>:<symbol>`
- Inline comments explain *why*, not *what*.

---


## Testing Instructions

### Test Environment

Development is split across two machines. **The macOS workstation cannot run any
GNOME runtime check** — `gjs`, `gnome-shell` and `gnome-extensions` do not exist
there. Never report a runtime item as passing from macOS.

| Role | Host | What it can verify |
|------|------|--------------------|
| Source & editing | macOS workstation | `glib-compile-schemas` (via `brew install glib`), ESLint. Schema + lint only. |
| Runtime & verification | `ssh UbuntuHP` | Everything: extension load, enable/disable, prefs window, integration checklists. |

`UbuntuHP` is Ubuntu 24.04.4 LTS · GNOME Shell 46.0 · mutter 46.2 · Wayland ·
uid 1000 · `XDG_RUNTIME_DIR=/run/user/1000`. It has a live desktop session on
tty2 that **must be left exactly as found** — see *Protecting the live session*.

#### Syncing source to the test machine

```bash
rsync -av --exclude 'schemas/gschemas.compiled' --exclude '.git' \
    ./ UbuntuHP:~/MacOSWorkspaces/
```

`rsync -a` preserves the executable bit; `scp` does **not** — `chmod +x` anything
you copy with `scp` or it fails with "Permission denied".

#### Option A — nested session, started by the user (preferred)

**Ask the user to start it**, from a terminal on the desktop itself:

```bash
cd ~/MacOSWorkspaces && ./scripts/dev-session.sh
```

This is the reliable path on this machine, and the one the integration checklists
below assume — it is also the only way to actually perform touchpad gestures.
Mutter's `--nested` backend is `MetaBackendX11Nested`, so it needs `DISPLAY` (the
session's XWayland) — **not** `WAYLAND_DISPLAY`. A desktop terminal has it; an SSH
session does not. Never try to launch this path over SSH: it nests into an X
server that is not presenting frames and hangs partway through startup.

An agent **can** drive a user-started nested session over SSH, by reading the
session's bus address out of the running shell's environment:

```bash
NPID=$(pgrep -u "$USER" -x gnome-shell | while read -r p; do
    grep -q -- '--nested' /proc/$p/cmdline 2>/dev/null && echo $p
done | head -1)
export DBUS_SESSION_BUS_ADDRESS=$(tr '\0' '\n' < /proc/$NPID/environ |
    grep '^DBUS_SESSION_BUS_ADDRESS=' | cut -d= -f2-)
export DCONF_PROFILE=$HOME/.config/dconf/profile/macos_workspaces_dev
```

From there the whole CLI works normally — see *Talking to the test shell*. Its
log goes to the user's terminal rather than a file, so ask them to read back the
`[macos-workspaces]` lines, and rely on `gnome-extensions info … | grep State`
for machine-checkable evidence.

#### Option B — headless session (fallback; unreliable on this box)

`--headless --virtual-monitor` needs no X display and serves the real
`gnome-extensions` CLI, which makes it the only fully agent-driven option. But it
stalls during startup on `UbuntuHP` far more often than it succeeds — see *Known
flakiness* below. Prefer Option A and only fall back to this when no one is at
the machine. Write the launcher on the test machine:

```bash
cat > /tmp/hl.sh <<'EOF'
#!/usr/bin/env bash
export DCONF_PROFILE="$HOME/.config/dconf/profile/macos_workspaces_dev"
export XDG_RUNTIME_DIR=/run/user/1000
exec dbus-run-session -- bash -c '
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell enabled-extensions "['"'"'macos-workspaces@macosworkspaces.dev'"'"']"
  printf "%s" "$DBUS_SESSION_BUS_ADDRESS" > /tmp/nested-bus
  exec gnome-shell --headless --virtual-monitor 1024x576
'
EOF
chmod +x /tmp/hl.sh
rm -f /run/user/1000/gnome-shell-disable-extensions /tmp/headless.log /tmp/nested-bus
nohup /tmp/hl.sh > /tmp/headless.log 2>&1 &
```

The dconf profile it references is created by `scripts/dev-session.sh`; run that
once first, or write `user-db:macos_workspaces_dev` to that path yourself.

**Wait for real startup before testing anything.** The only readiness signal is
the shell logging `GNOME Shell started at …`. Until that appears the shell owns
the `org.gnome.Shell` bus name but exports no Shell API, and *nothing* works:
`gnome-extensions` fails with "Failed to connect to GNOME Shell", and even
changing `enabled-extensions` produces no reaction because the main loop has not
reached that point.

```bash
until grep -q 'GNOME Shell started' /tmp/headless.log; do sleep 2; done
```

Do **not** treat `[macos-workspaces] enabled` as readiness. Extensions are
enabled early, so that line is logged even by a shell that then stalls and never
becomes usable.

##### Known flakiness — headless startup stalls

On `UbuntuHP` this startup frequently hangs. The log runs normally through
extension enable and `xdg-desktop-portal` activation, then stops dead at
`Successfully activated service 'org.freedesktop.portal.Desktop'` and
`GNOME Shell started` never arrives. Symptoms of a stalled shell:

- `gnome-extensions <anything>` → "Failed to connect to GNOME Shell"
- `gdbus introspect --dest org.gnome.Shell --object-path /org/gnome/Shell` lists
  only the three `org.freedesktop.DBus.*` interfaces, with no `org.gnome.Shell`
- writing `enabled-extensions` produces no log lines at all

**No confirmed root cause.** Ruled out by testing: logind inhibitor exhaustion
(only 2 were held), a missing portal backend (`xdg-desktop-portal-gnome` 46.2 is
installed), and an unset `XDG_CURRENT_DESKTOP`/`XDG_SESSION_TYPE` (setting both
to `GNOME`/`wayland` changed nothing). It has succeeded on this box, so it is a
race rather than a hard incompatibility, and it appeared to worsen after repeated
`kill -9` of compositor processes — which can leave DRM/GBM state wedged. Note
that a user-started **nested** session on the same machine starts cleanly and
serves the CLI every time, so the stall is specific to headless mode, not to the
extension or to GNOME Shell generally.

If a launch stalls: kill it, and retry a few times. If it keeps stalling, stop
retrying and ask the user to log out and back in (or reboot) before continuing —
piling up more killed compositors makes it worse, not better. Report the phase
item as unverified rather than reporting a stalled shell as a pass.

#### Talking to the test shell

Every command must target that session's private bus **and** its dconf profile:

```bash
export DBUS_SESSION_BUS_ADDRESS=$(cat /tmp/nested-bus)
export DCONF_PROFILE=$HOME/.config/dconf/profile/macos_workspaces_dev

gnome-extensions list --enabled
gnome-extensions info    macos-workspaces@macosworkspaces.dev
gnome-extensions enable  macos-workspaces@macosworkspaces.dev
gnome-extensions disable macos-workspaces@macosworkspaces.dev
```

Allow **60s+** timeouts. Cold-activating `org.gnome.Shell.Extensions` waits on
`xdg-desktop-portal`, which takes ~40s on this box. A short timeout looks
identical to a hard failure.

Extension output goes to the launcher's log, not the journal:

```bash
grep 'macos-workspaces' /tmp/headless.log
```

A healthy enable/disable cycle is one line each, alternating, with no `JS ERROR`,
`JS WARNING` or stack trace anywhere in the file.

#### Verifying the preferences window

`org.gnome.Shell.Screenshot` is access-denied in GNOME 46, so prove the window
through the accessibility tree instead — it confirms the actual content, not just
that a process survived:

```bash
gnome-extensions prefs macos-workspaces@macosworkspaces.dev &
sleep 10
GTK_A11Y=atspi python3 - <<'EOF'
import pyatspi
def walk(n, d=0):
    print('  ' * d + f'[{n.getRoleName()}] {n.name!r}')
    if d < 16:
        for c in n:
            if c: walk(c, d + 1)
for app in pyatspi.Registry.getDesktop(0):
    if app.name == 'org.gnome.Shell.Extensions':
        walk(app)
EOF
```

Expect a `[frame] 'MacOS Workspaces'` containing the page and group titles the
current `prefs.js` defines. Missing-Adwaita-icon `Gtk-WARNING` lines are a system
theme artifact and are not a failure.

#### Protecting the live session

`dconf` is keyed on the **user**, not the D-Bus session: a fresh bus from
`dbus-run-session` still reads and writes `~/.config/dconf/user`. Without a
private profile, configuring a test shell silently rewrites the live desktop's
settings. Two rules follow from that:

- Always export `DCONF_PROFILE` (an **absolute path**; a bare name resolves
  against the unwritable `/etc/dconf/profile`) and keep the db name to
  `[A-Za-z0-9_]` — dconf builds a D-Bus object path from it, and a hyphen makes
  every write hang on an invalid path.
- Snapshot before, restore after, and diff:

```bash
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus; unset DCONF_PROFILE
gsettings get org.gnome.shell enabled-extensions          # snapshot first
gsettings get org.gnome.mutter workspaces-only-on-primary
```

A write that reports `rc=0` but reads back unchanged means a stray test shell is
racing you — find and kill it before retrying.

#### Teardown

```bash
pgrep -u $USER -x gnome-shell | while read p; do
    grep -q -- '--headless' /proc/$p/cmdline 2>/dev/null && kill -9 $p
done
rm -f /tmp/hl.sh /tmp/headless.log /tmp/nested-bus
```

Never use `pgrep -f '<pattern>'` where the pattern also appears in your own
command line — it matches your SSH shell and kills the connection. Match on
`/proc/$p/cmdline` as above.

#### What cannot be tested without a re-login

GNOME Shell scans the extensions directory **only at startup**, and Wayland
cannot restart the shell in place. An extension installed while the live session
is running stays invisible to it (`gnome-extensions info` → *"doesn't exist"*)
until the user logs out and back in. Use a headless or nested shell instead of
asking for a re-login.

### Unit Tests
```bash
gjs tests/run.js
```
All files matching `tests/*.test.js` are auto-discovered. Tests must exit code 0 on success.

### Integration Tests (Manual)
Execute inside a nested Wayland session (`./scripts/dev-session.sh`):

#### Phase 1 — Basic Load
- [ ] Extension enables without errors in `journalctl`
- [ ] Extension disables without errors
- [ ] Prefs window opens and closes cleanly

#### Phase 2 — State Engine
- [ ] Two monitors connected: each has its own state entry; correct index logged when cursor moves
- [ ] Workspace added/removed: no index out-of-bounds errors

#### Phase 3 — Gesture Interception
- [ ] Three-finger swipe on monitor A: only monitor A changes workspace
- [ ] Monitor B: unchanged during the above swipe
- [ ] After `disable`: global swipe behavior restored (both monitors switch together)
- [ ] After `disable` + re-`enable`: per-monitor behavior resumes

#### Phase 4 — Keyboard Switching
- [ ] `Ctrl`+`Alt`+`Right` with focus on monitor A advances only monitor A
- [ ] Focus on B while cursor is on A: the keypress affects B
- [ ] Swipe then keypress on the same monitor continue from the same index
- [ ] After `disable`: global keyboard switching restored
- [ ] `move-to-workspace-*` unchanged from stock

#### Phase 5 — Per-Monitor Persistence
- [ ] Secondary monitor shows its own workspace and stays there
- [ ] Primary monitor's windows never change workspace
- [ ] Sticky windows visible on both monitors
- [ ] `disable()` returns every window to its original workspace
- [ ] Persistence refuses to run under dynamic workspaces, with a warning

#### Phase 6 — Animation Quality
- [ ] Slide animation speed and easing match native GNOME workspace switch
- [ ] No flicker at the **start** of a secondary swipe (staging must be invisible)
- [ ] A second swipe during the settle lands one workspace further, not two
- [ ] Swiping monitor A while B is still settling leaves B where it was heading
- [ ] Opening the Overview mid-animation strands no window on a staging workspace
- [ ] Interrupting a gesture mid-animation does not crash the Shell
- [ ] Sticky windows (on all workspaces) remain visible on all monitors
- [ ] With the default single-row layout, `Ctrl`+`Alt`+`Up`/`Down` do nothing, as in stock GNOME

#### Phase 7 — Settings
- [ ] Each settings change takes effect immediately (no restart needed)
- [ ] `wrap-around: true` enables circular navigation
- [ ] `sync-primary-workspace: false` decouples primary monitor from global workspace

#### Phase 8 — Robustness
- [ ] Connect a monitor mid-session: managed immediately
- [ ] Disconnect a monitor mid-session: no crash
- [ ] Lock/unlock screen cycle: normal behavior
- [ ] Open Overview during a swipe: gesture cancelled cleanly
- [ ] Toggle "Workspaces on all displays" in GNOME Settings while active: no crash
- [ ] Secondary holds its workspace when the global one changes externally (keyboard, Overview, `wmctrl`)
- [ ] Reassignment does not re-trigger itself
- [ ] Disable → enable × 10: no memory growth in Looking Glass

### Lint & Schema
```bash
./scripts/lint.sh            # must exit 0
./scripts/validate-schema.sh # must exit 0
```
Both must pass before any commit is considered complete.

---


## Security Considerations

### No Network Access
This extension has no network communication of any kind. It must never be modified to make HTTP/HTTPS requests, connect to sockets, or transmit data off-device.

### No Privilege Escalation
The extension runs entirely within the GJS sandbox of the GNOME Shell process. It must not:
- Execute shell commands via `GLib.spawn_*` or `Gio.Subprocess`
- Read or write files outside its own extension directory and the GSettings store
- Request D-Bus system bus services that require elevated permissions

### GSettings Schema Safety
- The schema must declare only the keys documented in `plan.md § Phase 7`.
- New settings keys must never expose raw JavaScript evaluation, shell command strings, or file paths from user input.

### Interception Scope
The extension takes over exactly **three signal handlers** on the
`WorkspaceAnimationController`'s `SwipeTracker` — `begin`, `update` and `end`. This
takeover:
- Must **always** be reverted in `disable()` / `destroy()`, even if `enable()` threw an error
- Must **never** suppress or swallow exceptions from GNOME Shell code
- Must leave `WorkspaceAnimationController`'s own methods untouched, so restoration is exact

> ⚠️ **Do not reassign `wac._switchWorkspaceBegin` / `Update` / `End`.**
> `workspaceAnimation.js:335-337` connects the tracker to `.bind(this)` copies made in
> the constructor. `.bind()` snapshots the function, so the tracker keeps calling the
> original no matter what you assign to the instance property afterwards. A patch
> written that way loads cleanly, logs nothing unusual, and silently never intercepts
> anything — the worst possible failure mode. Verified on GNOME Shell 46.0.

```js
// Take over: drop the Shell's handlers (we hold no ids), then connect ours.
for (const name of ['begin', 'update', 'end']) {
    const id = GObject.signal_lookup(name, tracker.constructor.$gtype);
    GObject.signal_handlers_disconnect_matched(
        tracker, GObject.SignalMatchType.ID, id, 0, null, null, null);
}
this._ids = [tracker.connect('begin', this._onBegin.bind(this)), /* ... */];

// Restore: disconnect this._ids, then reconnect the Shell's own untouched methods.
tracker.connect('begin', wac._switchWorkspaceBegin.bind(wac));
```

Never substitute a different `SwipeTracker` instance for `wac._swipeTracker`: the
constructor binds `compositor-modifiers` to that specific object
(`workspaceAnimation.js:339-341`) and a replacement silently loses it.

### Dependency Policy
- **Zero external npm/pip/apt dependencies** beyond what ships with Ubuntu 24.04.
- All GI bindings are provided by the system. Any future dependency requires maintainer approval.

### Sensitive Data
- Only gesture coordinates (screen pixel positions) and workspace indices are processed.
- No PII is collected, stored, or logged.
- Log messages must never include window titles, application names, or user content.

---


## Agent Phase Execution Guidelines

> These rules apply to **all AI agents** working on any task in this codebase, regardless of the phase or feature involved.

### Rule 1 — One Phase at a Time
Implement exactly **one phase** (as defined in `plan.md`) per work session.  
**Do not begin the next phase** until the user provides explicit written permission — e.g., *"proceed to Phase 2"* or *"Phase 1 approved — move on"*.

### Rule 2 — Phase Completion Summary
When a phase is complete, provide a **short, bulleted summary** of what was built — no more than 8 bullet points. Do not explain implementation details unless explicitly asked. Example format:

```
✅ Phase 1 Complete

- Created extension scaffold at the correct UUID path
- metadata.json targets shell-version ["46"]
- extension.js loads and unloads cleanly (verified in journalctl)
- Stub prefs window opens without error
- GSettings schema compiles successfully
- dev-session.sh script working
```

### Rule 3 — Manual Verification Checklist
After every phase that includes a "Manual Verification Checklist" in `plan.md`, reproduce that checklist verbatim as **unchecked items** for the user to tick off before approving the next phase. Do not skip or abbreviate this step.

### Rule 4 — No Speculative Work
Do not implement features, refactors, or improvements that are not listed in the current phase's deliverables — even if they seem obviously helpful. Record them as a `<!-- TODO: ... -->` comment or a note in `CHANGELOG.md` for future phases.

### Rule 5 — No Placeholder Code
Every file delivered must be complete and functional. No `// TODO`, `// FIXME`, or stub implementations are acceptable in phase deliverables — unless the phase explicitly calls for a stub (e.g., Phase 1 prefs stub).

### Rule 6 — Preserve Existing Conventions
Before writing any new code, read all existing files in `lib/` and match the established patterns for imports, error handling, logging format, and signal management exactly.

### Rule 7 — Always Validate After Writing
After creating or modifying any file, run the relevant validator and report the result in your completion summary:

| File type changed | Command to run |
|-------------------|----------------|
| `schemas/*.xml` | `glib-compile-schemas schemas/` |
| Any `*.js` file | `./scripts/lint.sh` |
| `tests/*.test.js` | `gjs tests/run.js` |

If any command fails, fix the issue before declaring the phase complete.

### Rule 8 — Internal API Changes
If during implementation you discover that a GNOME Shell internal symbol documented in this file or in `plan.md` has moved, been renamed, or been removed: **stop immediately**, report the exact discrepancy to the user with the file path and expected vs. actual symbol name, and wait for guidance. Do not silently work around it with an undocumented hack.

