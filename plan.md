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
libinput ──▶ Mutter ──▶ Clutter TOUCHPAD_SWIPE event
                               │
                    SwipeTracker (workspaceAnimation.js)
                               │ begin(monitorIndex)
                               │ update(progress)
                               │ end(duration, endProgress)
                               │
              ┌────────────────▼─────────────────┐
              │   WorkspaceAnimationController   │  ◀── we patch this
              │   _switchWorkspaceBegin/Update/  │
              │   End                            │
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

### Manual Verification Checklist
- [ ] One state entry per connected monitor initialised at `enable()` time
- [ ] Unplugging a monitor removes its entry; re-plugging adds it at index 0
- [ ] Adding/removing a workspace clamps all out-of-range indices to `[0, n-1]`
- [ ] Log output confirms correct monitor index when cursor is on each display

---


## Phase 3 — Swipe Gesture Interception

**Goal:** Intercept the `WorkspaceAnimationController` swipe tracker and reroute gestures per-monitor.

### Deliverables
- `lib/gestureHandler.js` — `GestureHandler` class that monkey-patches three methods on `Main.wm._workspaceAnimation`:
  - **`_onBegin(tracker, monitorIndex)`** — records active monitor; calls `tracker.confirmSwipe()` scoped to that monitor's snap points; does NOT call the original handler
  - **`_onUpdate(tracker, progress)`** — updates `.progress` on the active monitor's `MonitorGroup` only; all others remain frozen
  - **`_onEnd(tracker, duration, endProgress)`** — animates active monitor to `endProgress`; updates `MonitorStateManager`; activates global workspace only when the gesture is on the **primary monitor**
  - `destroy()` — restores all three original methods

### Patch Pattern
```js
const wac = Main.wm._workspaceAnimation;
this._origBegin  = wac._switchWorkspaceBegin.bind(wac);
this._origUpdate = wac._switchWorkspaceUpdate.bind(wac);
this._origEnd    = wac._switchWorkspaceEnd.bind(wac);
wac._switchWorkspaceBegin  = this._onBegin.bind(this);
wac._switchWorkspaceUpdate = this._onUpdate.bind(this);
wac._switchWorkspaceEnd    = this._onEnd.bind(this);
```

### Manual Verification Checklist
- [ ] Three-finger swipe on monitor A moves **only** monitor A
- [ ] Monitor B remains frozen on its current virtual workspace during the gesture
- [ ] Rapid back-to-back swipes on the same monitor do not crash the Shell
- [ ] `disable()` restores original global-switch behavior immediately
- [ ] Swipe on the primary monitor still activates the matching global workspace

---


## Phase 4 — Animation & Visual Polish

**Goal:** Make per-monitor animation visually match GNOME's native slide quality and feel.

### Deliverables
- `lib/animationDriver.js` — `AnimationDriver` class
  - Wraps `MonitorGroup.ease_property('progress', ...)` with `EASE_OUT_CUBIC` curve and duration constants matching stock `_switchWorkspaceEnd`
  - Handles gesture interruption: if a second swipe begins before the first animation completes, snaps the in-progress animation then starts cleanly
- Sticky-window groups (windows on all workspaces) remain visible on all monitors throughout any transition
- `WorkspaceBackground` actors created/destroyed correctly per virtual workspace change
- RTL locale support — `Clutter.get_default_text_direction() === RTL` respected in progress direction math
- Vertical workspace layout support — `workspace_manager.layout_rows === -1` respected

### Manual Verification Checklist
- [ ] Slide animation on the active monitor is smooth and matches native feel
- [ ] No visual glitches or flicker on inactive monitors during a transition
- [ ] Sticky (pinned) windows appear correctly on all monitors throughout
- [ ] Swipe direction is correct with a right-to-left locale active
- [ ] Vertical workspace layout (4-finger swipe up/down if configured) works correctly

---

## Phase 5 — Settings & Preferences UI

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


## Phase 6 — Edge Cases & Robustness

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

## Phase 7 — Testing & QA

**Goal:** Repeatable, documented test suite covering unit and integration scenarios.

### Deliverables
- `tests/run.js` — GJS test runner entry point
- `tests/monitorState.test.js`, `tests/cursorMonitor.test.js`, `tests/settings.test.js` — unit tests
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

## Phase 8 — Packaging & Distribution

**Goal:** Package for GNOME Extensions (EGO) submission and direct install.

### Deliverables
- `Makefile` targets: `all`, `install`, `uninstall`, `pack`, `schemas`, `lint`, `test`, `clean`
- `scripts/pack.sh` — produces `macos-workspaces@macosworkspaces.dev.zip`
- Compiled `gschemas.compiled` included in zip
- `CHANGELOG.md` (Keep a Changelog format), `LICENSE` (GPL-2.0), final `README.md` with screenshots
- EGO submission checklist verified against review guidelines

### Manual Verification Checklist
- [ ] `make pack` produces a valid `.zip`
- [ ] `gnome-extensions validate macos-workspaces@macosworkspaces.dev.zip` passes
- [ ] Manual install from zip on a **clean** Ubuntu 24.04 VM works with no extra steps
- [ ] `CHANGELOG.md` entry exists for the release version
- [ ] `LICENSE` file present with GPL-2.0 text

---


## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `Main.wm._workspaceAnimation` renamed in GNOME 47/48 | Medium | High | Version-guard shim + graceful disable |
| Ubuntu Canonical patches alter `MonitorGroup` behavior | Low | High | Test on stock Ubuntu 24.04, not only upstream |
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
│   ├── animationDriver.js
│   └── settings.js
├── schemas/
│   └── org.gnome.shell.extensions.macos-workspaces.gschema.xml
├── tests/
│   ├── run.js
│   ├── monitorState.test.js
│   ├── cursorMonitor.test.js
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

