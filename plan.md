# MacOS Workspaces — GNOME Extension Implementation Plan

> **Target:** GNOME Shell 46 · Ubuntu 24.04 LTS (Noble Numbat) · Wayland-first

---

## Background & Problem Statement

In GNOME, when **Workspaces on All Displays** is enabled (`org.gnome.mutter workspaces-only-on-primary = false`), a three-finger horizontal swipe switches workspaces **globally** — every monitor jumps to the same new workspace simultaneously.

macOS instead keeps an **independent workspace stack per monitor**: swiping on display A advances only that display's workspace; display B is unaffected.

This extension replicates that behavior inside GNOME 46 by intercepting the `WorkspaceAnimationController`'s `SwipeTracker` before it resolves the gesture, determining which monitor the swipe originated on, and driving only that monitor's `MonitorGroup` animation while leaving every other monitor frozen.

---

## Architecture Overview

```
libinput ──▶ Mutter ──▶ Clutter TOUCHPAD_SWIPE event      keybinding
                               │                     (Ctrl+Alt+arrow)
                    SwipeTracker (workspaceAnimation.js)        │
                               │ begin(monitorIndex)            │ setCustomKeybinding-
                               │ update(progress)               │ Handler override
                               │ end(duration, endProgress)     │ (Phase 4)
                               │◀───────────────────────────────┘
              ┌────────────────▼─────────────────┐
              │   SwipeTracker signal handlers    │  ◀── we take these over
              │   begin / update / end            │      (NOT the controller's
              │                                   │       methods — see Phase 3)
              └────────────────┬─────────────────┘
                               │
              ┌────────────────▼─────────────────┐
              │  Per-monitor state map            │
              │  monitorIndex → virtualWorkspace  │
              └───────────────────────────────────┘
```

Key GNOME Shell internal objects (stable in GNOME 46):

| Symbol | File | Role |
|--------|------|------|
| `WorkspaceAnimationController` | `js/ui/workspaceAnimation.js` | Owns swipe tracker & `MonitorGroup` actors |
| `SwipeTracker` | `js/ui/swipeTracker.js` | Emits `begin(monitor)`, `update(progress)`, `end(duration, endProgress)` |
| `MonitorGroup` | `js/ui/workspaceAnimation.js` | One per physical monitor; `.progress` drives the slide animation |
| `global.workspace_manager` | Mutter GObject | Creates/activates logical workspaces |
| `Main.wm._workspaceAnimation` | `js/ui/main.js` | Extension entry point |

---


## Phase 1 — Project Scaffold & Dev Environment

**Goal:** A loadable, no-op extension that round-trips `enable()` / `disable()` cleanly with zero side effects.

### Deliverables
- Extension directory at `~/.local/share/gnome-shell/extensions/macos-workspaces@macosworkspaces.dev/`
- `metadata.json` — UUID, name, description, `"shell-version": ["46"]`
- `extension.js` — ES-module class extending `Extension` with empty `enable()` / `disable()`
- `prefs.js` — stub `Adw.PreferencesWindow`
- `schemas/` — GSettings schema skeleton (compiles cleanly)
- `README.md` — developer quick-start guide
- `scripts/dev-session.sh` — one-command nested Wayland test session launcher

### Key Decisions
- UUID: `macos-workspaces@macosworkspaces.dev`
- ES modules **only** — no legacy `imports.*` API
- `Adw.PreferencesWindow` for settings UI (ships with Ubuntu 24.04)
- All GNOME Shell internal API access isolated in `lib/shellInterop.js`
  (the module itself is built in Phase 3, once there is a version guard and a
  second consumer to justify it; Phase 2's modules are refactored through it then)

### Manual Verification Checklist
- [ ] `gnome-extensions enable macos-workspaces@macosworkspaces.dev` succeeds in nested Wayland session
- [ ] `journalctl -f -o cat /usr/bin/gnome-shell` shows no errors on enable or disable
- [ ] Prefs window opens without crash
- [ ] `glib-compile-schemas schemas/` exits with code 0

---

## Phase 2 — Monitor Detection & Per-Monitor State Engine

**Goal:** Build the data layer that tracks an independent "virtual workspace index" per physical monitor.

### Deliverables
- `lib/monitorState.js` — `MonitorStateManager` class
  - `Map<monitorIndex, virtualWorkspaceIndex>` as the source of truth
  - `getVirtualIndex(monitorIdx)` / `setVirtualIndex(monitorIdx, idx)`
  - `getWorkspaceCount()` — wraps `global.workspace_manager.n_workspaces`
  - Listens to `workspace_manager::notify::n-workspaces` — clamps all indices to `[0, n-1]`
  - Listens to `Main.layoutManager::monitors-changed` — adds/removes entries on hotplug
- `lib/cursorMonitor.js` — `getCursorMonitorIndex()` using `global.get_pointer()` + `global.display.get_monitor_index_for_rect()`

> Both modules initially read `Main`/`global` directly. Phase 3 refactors them to
> take those dependencies from `lib/shellInterop.js`, which is what makes them
> unit-testable (see Phase 8).

### Manual Verification Checklist
- [ ] One state entry per connected monitor initialised at `enable()` time
- [ ] Unplugging a monitor removes its entry; re-plugging adds it at index 0
- [ ] Adding/removing a workspace clamps all out-of-range indices to `[0, n-1]`
- [ ] Log output confirms correct monitor index when cursor is on each display

---


## Phase 3 — Swipe Gesture Interception

**Goal:** Intercept the `WorkspaceAnimationController` swipe tracker and reroute gestures per-monitor.

### Deliverables
- `lib/shellInterop.js` — the **only** module permitted to touch GNOME Shell internals
  - `checkCompatibility()` — verifies every symbol this extension depends on exists, returning a reason string when it does not, so `enable()` can bail out cleanly (Risk Register: renamed internals)
  - Accessors for `Main.wm._workspaceAnimation`, its `_swipeTracker`, `Main.layoutManager`, `global.workspace_manager`, and the pointer
  - Phase 2's `monitorState.js` and `cursorMonitor.js` are refactored to take their dependencies from here rather than reaching into `Main`/`global` directly
  - Every dependency is injectable, which is what makes the Phase 8 unit tests possible at all
- `lib/gestureHandler.js` — `GestureHandler` class that **takes over the SwipeTracker's signal handlers**:
  - **`_onBegin(tracker, monitorIndex)`** — records active monitor; calls `tracker.confirmSwipe()` scoped to that monitor's snap points
  - **`_onUpdate(tracker, progress)`** — drives `updateSwipeForMonitor()` on the active monitor's `MonitorGroup` only; all others remain frozen
  - **`_onEnd(tracker, duration, endProgress)`** — animates active monitor to `endProgress`; updates `MonitorStateManager`; activates global workspace only when the gesture is on the **primary monitor**
  - `destroy()` — disconnects our handlers and reconnects the Shell's own

### Interception Pattern

> **Do not reassign the `_switchWorkspace*` methods.** `workspaceAnimation.js:335-337`
> connects the tracker to `.bind(this)` copies captured in the constructor, so the
> SwipeTracker holds the *original* function forever. Reassigning the instance
> property is a silent no-op: the extension loads, logs nothing unusual, and never
> intercepts a single gesture. Verified on GNOME Shell 46.0 / mutter 46.2.

Take over the tracker's signals instead. The methods stay untouched, so restoration
is exact:

```js
const wac = Main.wm._workspaceAnimation;
const tracker = wac._swipeTracker;

// Drop the Shell's own handlers — we hold no ids for them, so match by signal.
for (const name of ['begin', 'update', 'end']) {
    const id = GObject.signal_lookup(name, tracker.constructor.$gtype);
    GObject.signal_handlers_disconnect_matched(
        tracker, GObject.SignalMatchType.ID, id, 0, null, null, null);
}

this._ids = [
    tracker.connect('begin', this._onBegin.bind(this)),
    tracker.connect('update', this._onUpdate.bind(this)),
    tracker.connect('end', this._onEnd.bind(this)),
];

// destroy(): disconnect this._ids, then reconnect the Shell's own methods —
// they were never modified, so this restores stock behaviour verbatim.
tracker.connect('begin', wac._switchWorkspaceBegin.bind(wac));
tracker.connect('update', wac._switchWorkspaceUpdate.bind(wac));
tracker.connect('end', wac._switchWorkspaceEnd.bind(wac));
```

Replacing `wac._swipeTracker` with our own `SwipeTracker` is **not** an acceptable
alternative: the constructor binds `compositor-modifiers` to that specific instance
(`workspaceAnimation.js:339-341`), and a substitute silently loses it.

### Reuse the Shell's progress math

`MonitorGroup` already exposes everything per-monitor switching needs —
`getSnapPoints()`, `getWorkspaceProgress()`, `findClosestWorkspace()`,
`updateSwipeForMonitor()` and an `index` getter. Drive those rather than computing
progress ourselves. They already handle right-to-left locales and vertical
layouts internally, which is why Phase 5 only has to *verify* those cases.

### Manual Verification Checklist
- [ ] Three-finger swipe on monitor A moves **only** monitor A
- [ ] Monitor B remains frozen on its current virtual workspace during the gesture
- [ ] Rapid back-to-back swipes on the same monitor do not crash the Shell
- [ ] `disable()` restores original global-switch behavior immediately
- [ ] Swipe on the primary monitor still activates the matching global workspace

---


## Phase 4 — Per-Monitor Keyboard Switching

**Goal:** Make `Ctrl`+`Alt`+arrow act on one monitor, matching the gesture behaviour.

> **Why this is a separate phase.** Keyboard switching never touches the
> `SwipeTracker`, so Phase 3's takeover does nothing for it. The keybinding runs
> `_showWorkspaceSwitcher()` (`windowManager.js:560-596`), which calls
> `Meta.Workspace.activate()` — a change to the *single global* active workspace —
> and only then does `switch-workspace` reach `animateSwitch()`
> (`windowManager.js:1634`). Per-monitor behaviour therefore requires intercepting
> the binding **before** it activates, not decorating the animation afterwards.

### Deliverables
- `lib/keybindingHandler.js` — `KeybindingHandler` class
  - Re-registers the four directional bindings through
    `Main.wm.setCustomKeybindingHandler()` (`windowManager.js:1095`) — the same
    public-ish entry point the Shell uses on itself:
    `switch-to-workspace-left`, `-right`, `-up`, `-down`,
    each with `Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW`
  - **Target monitor resolution**, in order: the focused window's monitor
    (`global.display.get_focus_window()?.get_monitor()`), else the cursor's monitor
    via `cursorMonitor.js`, else the primary. macOS keys off focus, so focus wins.
  - Advances that monitor's index in `MonitorStateManager`, honouring the
    `wrap-around` setting from Phase 6
  - Drives the same `MonitorGroup` animation as the gesture path, through the
    shared `animationDriver.js` — keyboard and swipe must not diverge visually
  - Calls `workspace.activate()` **only** when the target monitor is the primary
    one, exactly as the gesture path does
  - `destroy()` — re-registers `Main.wm._showWorkspaceSwitcher.bind(Main.wm)` for
    all four bindings, restoring stock behaviour

### Explicitly out of scope for this phase
- `move-to-workspace-*` (moving the focused window) — same handler upstream, but
  moving a window across a per-monitor workspace stack raises questions this phase
  does not answer. Record as a follow-up.
- `switch-to-workspace-1` … `-12` and `switch-to-workspace-last` — absolute jumps
  rather than relative motion; defer until the relative case is proven.

### Manual Verification Checklist
- [ ] `Ctrl`+`Alt`+`Right` with focus on monitor A advances **only** monitor A
- [ ] Monitor B stays on its current virtual workspace throughout
- [ ] Focus on monitor B while the cursor sits on monitor A: the keypress affects **B**
- [ ] With no focused window, the keypress falls back to the cursor's monitor
- [ ] A swipe followed by a keypress on the same monitor continues from the same index
- [ ] Keyboard animation is visually identical to the swipe animation
- [ ] Keypress on the primary monitor still activates the matching global workspace
- [ ] `disable()` restores global keyboard switching immediately
- [ ] `move-to-workspace-*` still behaves exactly as stock (untouched this phase)

---

## Phase 5 — Animation & Visual Polish

**Goal:** Make per-monitor animation visually match GNOME's native slide quality and feel.

### Deliverables
- `lib/animationDriver.js` — `AnimationDriver` class
  - Wraps `MonitorGroup.ease_property('progress', ...)` with `EASE_OUT_CUBIC` curve and duration constants matching stock `_switchWorkspaceEnd`
  - Handles gesture interruption: if a second swipe begins before the first animation completes, snaps the in-progress animation then starts cleanly
- Sticky-window groups (windows on all workspaces) remain visible on all monitors throughout any transition — the Shell builds these itself in `_prepareWorkspaceSwitch()`, so this is a *verification* item, not something we construct
- **Verify** right-to-left locales behave correctly. `MonitorGroup` already handles RTL internally (`workspaceAnimation.js:204, 244, 253, 274, 412`) and so does `swipeTracker.js:660`, so this is inherited for free *provided Phase 3 drives the Shell's progress math instead of computing its own*. Only if that assumption breaks does this become implementation work.
- **Verify** vertical workspace layouts (`workspace_manager.layout_rows === -1`). Stock `_switchWorkspaceBegin` already sets `tracker.orientation` from this; our `_onBegin` must preserve that logic.

> **Removed from this phase:** the original plan listed "`WorkspaceBackground` actors created/destroyed per virtual workspace change". `WorkspaceBackground` lives in `workspace.js:943` and is an **Overview** actor — it takes no part in the workspace switch animation, which uses `WorkspaceGroup` and `MonitorGroup`. There is nothing to do here.

### Manual Verification Checklist
- [ ] Slide animation on the active monitor is smooth and matches native feel
- [ ] No visual glitches or flicker on inactive monitors during a transition
- [ ] Sticky (pinned) windows appear correctly on all monitors throughout
- [ ] Swipe direction is correct with a right-to-left locale active
- [ ] Vertical workspace layout (4-finger swipe up/down if configured) works correctly

---

## Phase 6 — Settings & Preferences UI

**Goal:** Allow runtime configuration of all meaningful behaviors without editing code.

### Deliverables
- `schemas/org.gnome.shell.extensions.macos-workspaces.gschema.xml`:
  - `enabled` (boolean, default `true`)
  - `sync-primary-workspace` (boolean, default `true`) — primary monitor gesture activates global workspace
  - `wrap-around` (boolean, default `false`) — swiping past last workspace wraps to first
  - `gesture-threshold` (double, default `0.3`) — minimum swipe velocity to confirm a switch
- `prefs.js` — `Adw.PreferencesWindow` with toggle rows, spin row (0.1–1.0, step 0.05), and About page
- `lib/settings.js` — `SettingsManager` wrapping `Gio.Settings`; emits change notifications consumed by `GestureHandler` at runtime

### Manual Verification Checklist
- [ ] All settings readable and writable from the prefs window
- [ ] Setting changes take effect immediately without extension restart
- [ ] `wrap-around: true` allows swiping from the last workspace to the first
- [ ] `sync-primary-workspace: false` prevents global workspace activation on primary-monitor swipe
- [ ] `glib-compile-schemas schemas/` passes with no errors or warnings

---


## Phase 7 — Edge Cases & Robustness

**Goal:** Harden the extension against real-world runtime scenarios and lifecycle events.

### Deliverables
- Monitor hotplug/unplug mid-session — no crash; state added/removed cleanly
- Workspace creation/deletion via keyboard shortcuts or other extensions — indices clamped
- Overview open/close — swipe tracker disabled when Overview is showing; re-enabled on hide
- Lock screen transitions — all patches inactive during the locked state
- `gnome-shell --replace` / extension reload — no session restart required
- `workspaces-only-on-primary` runtime toggle — graceful deactivation of per-monitor logic
- Rapid enable/disable cycling — no memory leaks (verified in GNOME Looking Glass)
- Version-guard shim — logs clear warning and disables gracefully if patched methods are absent/renamed

### Manual Verification Checklist
- [ ] Plug in a second monitor mid-session: extension detects and manages it immediately
- [ ] Unplug a monitor mid-session: no crash; state entry removed
- [ ] Open the Overview during a gesture: gesture cancelled gracefully, no stuck animation
- [ ] Lock and unlock the screen: normal behavior on both sides of the lock
- [ ] Enable/disable 10 times: no memory growth visible in Looking Glass
- [ ] Toggle "Workspaces on all displays" in GNOME Settings while extension is active: no crash

---

## Phase 8 — Testing & QA

**Goal:** Repeatable, documented test suite covering unit and integration scenarios.

> **Constraint discovered in Phase 3:** standalone `gjs` cannot import
> `resource:///org/gnome/shell/...` — those resources exist only inside the running
> Shell process. Any module that imports them directly is untestable outside GNOME.
> This is why every Shell dependency is injected through `lib/shellInterop.js`
> (Phase 3): tests construct the modules with fakes and never touch a real Shell.

### Deliverables
- `tests/run.js` — GJS test runner entry point
- `tests/stubs.js` — fake `layoutManager`, `workspaceManager`, `swipeTracker` and `MonitorGroup` doubles, injected in place of the real interop module
- `tests/monitorState.test.js`, `tests/cursorMonitor.test.js`, `tests/gestureHandler.test.js`, `tests/settings.test.js` — unit tests
- `tests/integration/playbook.md` — manual integration checklist (consolidates all phase checklists)
- `scripts/lint.sh` — ESLint with GNOME Shell globals preset
- `scripts/validate-schema.sh` — `glib-compile-schemas --strict schemas/` dry-run
- `.github/workflows/ci.yml` — GitHub Actions: lint + schema validation on every push

### Manual Verification Checklist
- [ ] `gjs tests/run.js` exits 0 with all tests passing
- [ ] `scripts/lint.sh` produces zero errors or warnings
- [ ] `scripts/validate-schema.sh` exits 0
- [ ] Integration playbook fully executed on Ubuntu 24.04 + GNOME 46

---

## Phase 9 — Packaging & Distribution

**Goal:** Package for GNOME Extensions (EGO) submission and direct install.

### Deliverables
- `Makefile` targets: `all`, `install`, `uninstall`, `pack`, `schemas`, `lint`, `test`, `clean`
- `scripts/pack.sh` — produces `macos-workspaces@macosworkspaces.dev.zip`
- Compiled `gschemas.compiled` included in zip
- `CHANGELOG.md` (Keep a Changelog format), `LICENSE` (GPL-2.0), final `README.md` with screenshots
- EGO submission checklist verified against review guidelines

### Manual Verification Checklist
- [ ] `make pack` produces a valid `.zip`
- [ ] `gnome-extensions install --force macos-workspaces@macosworkspaces.dev.zip` succeeds, then the extension enables cleanly (there is **no** `gnome-extensions validate` subcommand on GNOME 46 — the available commands are help, version, enable, disable, reset, uninstall, list, info, show, prefs, create, pack, install)
- [ ] Manual install from zip on a **clean** Ubuntu 24.04 VM works with no extra steps
- [ ] `CHANGELOG.md` entry exists for the release version
- [ ] `LICENSE` file present with GPL-2.0 text

---


## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `Main.wm._workspaceAnimation` renamed in GNOME 47/48 | Medium | High | Version-guard shim in `lib/shellInterop.js` + graceful disable |
| Shell rewires signals so our takeover silently stops intercepting | Medium | **High** | A patch that no-ops is worse than one that throws. `checkCompatibility()` must assert the tracker has exactly the handler count we expect *before* and *after* takeover, and log loudly on mismatch |
| Ubuntu Canonical patches alter `MonitorGroup` behavior | Low | High | Test on stock Ubuntu 24.04, not only upstream |
| Another extension also overrides `switch-to-workspace-*` keybindings | Medium | Medium | Detect a non-stock handler at enable time; log and skip the keyboard phase rather than clobbering |
| Conflict with another extension patching the same methods | Medium | Medium | Detect conflict at enable time; log clear warning |
| EGO review rejects internal API usage | Medium | Medium | Document rationale; provide full source |
| Wayland coordinate differences from X11 | Low | Low | Wayland-first design; X11 is best-effort |

---

## Final File Structure

```
macos-workspaces@macosworkspaces.dev/
├── extension.js
├── prefs.js
├── metadata.json
├── stylesheet.css
├── lib/
│   ├── shellInterop.js
│   ├── monitorState.js
│   ├── cursorMonitor.js
│   ├── gestureHandler.js
│   ├── keybindingHandler.js
│   ├── animationDriver.js
│   └── settings.js
├── schemas/
│   └── org.gnome.shell.extensions.macos-workspaces.gschema.xml
├── tests/
│   ├── run.js
│   ├── stubs.js
│   ├── monitorState.test.js
│   ├── cursorMonitor.test.js
│   ├── gestureHandler.test.js
│   ├── keybindingHandler.test.js
│   ├── settings.test.js
│   └── integration/
│       └── playbook.md
├── scripts/
│   ├── dev-session.sh
│   ├── lint.sh
│   ├── validate-schema.sh
│   └── pack.sh
├── .github/
│   └── workflows/
│       └── ci.yml
├── Makefile
├── CHANGELOG.md
├── LICENSE
├── README.md
├── AGENTS.md
└── plan.md
```

---

## Dependency Summary

| Dependency | Source | Notes |
|-----------|--------|-------|
| GJS ≥ 1.78 | Ubuntu 24.04 | Ships with GNOME 46 |
| `gi://Clutter` | Mutter | Gesture events, animations |
| `gi://Meta` | Mutter | Monitor geometry, workspace manager |
| `gi://Mtk` | Mutter | `Mtk.Rectangle` for coordinate → monitor mapping |
| `gi://GObject` | GLib | Signal/property system |
| `gi://Gio` | GLib | GSettings |
| `gi://Adw` ≥ 1.4 | libadwaita | Preferences UI |
| `gi://St` | GNOME Shell | Shell UI toolkit |
| GNOME Shell internals | `resource:///org/gnome/shell/ui/` | Accessed as ES module imports |

No external npm packages. The only required build step is `glib-compile-schemas`.

