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
              │  AnimationDriver (Phase 6)        │  ◀── one slide, both inputs
              │  stage → anchor → ease → settle   │
              └────────┬───────────────┬─────────┘
                       │               │
   ┌───────────────────▼──┐  ┌─────────▼─────────────────────┐
   │  Per-monitor state    │  │  WorkspaceReassigner (Phase 5) │
   │  monitor → virtual ws │  │  parks windows so a secondary  │
   └───────────────────────┘  │  really shows its own workspace│
                              └────────────────────────────────┘
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

### Manual Verification Checklist — ✅ complete
- [x] `gnome-extensions enable macos-workspaces@macosworkspaces.dev` succeeds in nested Wayland session
- [x] `journalctl -f -o cat /usr/bin/gnome-shell` shows no errors on enable or disable
- [x] Prefs window opens without crash — confirmed via the AT-SPI tree (`[frame] 'MacOS Workspaces'` → page `General` → group `MacOS Workspaces`); `org.gnome.Shell.Screenshot` is access-denied on GNOME 46, so accessibility is the way to prove window content
- [x] `glib-compile-schemas schemas/` exits with code 0 (`--strict`)

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
> unit-testable (see Phase 9).

### Manual Verification Checklist — 3 of 4 complete
Verified on real hardware (LVDS-1 + VGA-1, GNOME Shell 46.0), not a nested session.

- [x] One state entry per connected monitor initialised at `enable()` time — `state initialised — 2 monitors, 1 workspaces: [0]=0 [1]=0`
- [x] Unplugging a monitor removes its entry; re-plugging adds it at index 0 — driven through `org.gnome.Mutter.DisplayConfig.ApplyMonitorsConfig`, which produces a genuine `monitors-changed`; a nested session's dummy monitors cannot be hotplugged
- [ ] Adding/removing a workspace clamps all out-of-range indices to `[0, n-1]` — **deferred to Phase 3.** Unobservable by construction until something sets a non-zero index: with every entry at 0 the clamp has nothing to clamp. The `notify::n-workspaces` handler is confirmed live, and the arithmetic has unit coverage.
- [x] Log output confirms correct monitor index when cursor is on each display — pointer physically on the Dell → `monitor 1`; on the laptop → `monitor 0`

> **Testing note:** pointer injection under Wayland is not available to us.
> `XWarpPointer` via XWayland moves only X's shadow of the pointer (and GDK reads
> back that same shadow, so the result is circular and misleading), and Mutter's
> `RemoteDesktop` API ignores input from a session not authorised through the
> portal. Cursor-position tests need a human to move the mouse.

---


## Phase 3 — Swipe Gesture Interception

**Goal:** Intercept the `WorkspaceAnimationController` swipe tracker and reroute gestures per-monitor.

### Deliverables
- `lib/shellInterop.js` — the **only** module permitted to touch GNOME Shell internals
  - `checkCompatibility()` — verifies every symbol this extension depends on exists, returning a reason string when it does not, so `enable()` can bail out cleanly (Risk Register: renamed internals)
  - Accessors for `Main.wm._workspaceAnimation`, its `_swipeTracker`, `Main.layoutManager`, `global.workspace_manager`, and the pointer
  - Phase 2's `monitorState.js` and `cursorMonitor.js` are refactored to take their dependencies from here rather than reaching into `Main`/`global` directly
  - Every dependency is injectable, which is what makes the Phase 9 unit tests possible at all
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
layouts internally, which is why Phase 6 only has to *verify* those cases.

### Manual Verification Checklist — ✅ complete
Verified on real hardware (LVDS-1 primary + VGA-1, GNOME Shell 46.0) across ~80
gestures with zero JS errors. Driven by `Super`+two-finger-scroll, which reaches
the same SwipeTracker as a three-finger swipe (`swipeTracker.js:463` leaves
`allowScroll` true); the tracker rejects mouse-wheel scroll, so a touchpad is
required either way.

- [x] Three-finger swipe on monitor A moves **only** monitor A
- [x] Monitor B remains frozen on its current virtual workspace during the gesture
- [x] Rapid back-to-back swipes on the same monitor do not crash the Shell
- [x] `disable()` restores original global-switch behavior immediately — `gesture handlers restored`, then both monitors move together again
- [x] Swipe on the primary monitor still activates the matching global workspace

> **Known limitation carried out of this phase.** The gesture is routed correctly
> and `MonitorStateManager` records the right index, but nothing reads that index
> back: a non-primary monitor animates and then snaps to GNOME's global workspace,
> and a primary swipe drags every other monitor with it. See *Per-Monitor
> Persistence* below — no phase currently delivers this.

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
    `wrap-around` setting from Phase 7
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

### Manual Verification Checklist — ✅ complete

> **What "only monitor A" means before Phase 5.** Until persistence lands, this is
> a claim about the *animation*, not the resulting content. A keypress on a
> **secondary** monitor changes nothing anywhere else, because no workspace is
> activated — so "only that monitor" holds completely. A keypress on the
> **primary** activates GNOME's single global workspace, and with
> `workspaces-only-on-primary=false` every other monitor re-renders it: the
> secondary's content jumps, silently, with no animation. That is expected here
> and is exactly what Phase 5's `syncMonitor()` removes.

- [x] `Ctrl`+`Alt`+`Right` with focus on monitor A animates **only** monitor A
- [x] No monitor other than A animates at any point
- [x] Focus on monitor B while the cursor sits on monitor A: the keypress affects **B**
- [x] With no focused window, the keypress falls back to the cursor's monitor
- [x] At the first or last workspace the keypress is a no-op and says so in the log rather than failing silently (stock GNOME also refuses; wrap-around is Phase 7)
- [x] A swipe followed by a keypress on the same monitor continues from the same index — **fixed after first testing.** The keyboard originally derived its target from `V[m] + delta` while the gesture derived its from `baseMonitorGroup.findClosestWorkspace()`, which the Shell anchors to the *global active* workspace. The two diverged (keyboard reached workspace 2 where gestures never exceeded 1), and worse, `_switchMonitor` eased from the global-anchored position toward a `V[m]`-derived target — so the slide ran **backwards** whenever the two disagreed. Both paths now anchor on the active workspace, and `_switchMonitor` pins `monitorGroup.progress` to the from-workspace before easing, the way stock `animateSwitch` does. Phase 5 moves the anchor to `V[m]` for both paths at once.
- [x] Keyboard animation is visually identical to the swipe animation
- [x] Keypress on the primary monitor still activates the matching global workspace
- [x] Keypress on a **secondary** monitor leaves the primary untouched — no animation, no workspace change
- [x] Keypress on the **primary** changes the secondary's content without animating it (expected until Phase 5)
- [x] `disable()` restores global keyboard switching immediately — both monitors move together again
- [ ] `move-to-workspace-*` still behaves exactly as stock (untouched this phase)

---

## Phase 5 — Per-Monitor Persistence (non-primary)

**Goal:** Make a secondary monitor actually *display* its own virtual workspace
instead of collapsing back to GNOME's global one.

> **Why this phase exists.** Phases 3-4 route input correctly and record the right
> index, but nothing reads that index back, so a secondary monitor animates and
> then snaps to the global workspace. GNOME has exactly one global workspace and
> binds windows to workspaces globally, with no per-monitor concept. The Shell's
> own switch animation renders `Clutter.Clone` actors
> (`workspaceAnimation.js:_createClone`), so keeping those actors alive past the
> gesture would leave a frozen, non-interactive image — that route is closed.

### Mechanism

Only the global workspace `G` is ever rendered. For a secondary monitor `m` whose
virtual index is `V[m]`, move the windows belonging to `(m, V[m])` onto `G`, and
move the rest of that monitor's windows off it. The primary monitor keeps using
GNOME's real workspace exactly as it does today and its windows are **never**
moved — that is what keeps the blast radius small.

### Deliverables
- `lib/windowTracker.js` — `WindowTracker`
  - `Map<Meta.Window, {monitor, virtualWorkspace}>` recording where each window
    really belongs, independent of the workspace it is currently parked on
  - Attributes windows to monitors by frame-rect ∩ monitor geometry, matching
    `WorkspaceGroup._windowIsOnThisMonitor` so our view agrees with the Shell's
    (deliberately *not* `Meta.Window.get_monitor()`)
  - Ignores sticky (`is_on_all_workspaces()`), override-redirect and
    `Meta.WindowType.DESKTOP` windows
  - Follows `window-created`, `unmanaged`, `workspace-changed` and monitor-enter
    or -leave so user-initiated moves update our record rather than fighting it
- `lib/workspaceReassigner.js` — `WorkspaceReassigner`
  - `syncMonitor(monitorIndex)` — brings `(m, V[m])` windows onto `G` and moves
    the others away, via `Meta.Window.change_workspace_by_index()`
  - Refuses to touch any window on the primary monitor
  - Suppresses its own `workspace-changed` notifications so reassignment cannot
    feed back into `WindowTracker`
  - Never runs while a gesture is in flight
  - `restoreAll()` — on `disable()`, returns every window to the workspace our
    records say it belongs to
- `gestureHandler._onEnd` and Phase 4's keybinding handler call `syncMonitor()`
  once a switch settles

### Hard requirement: static workspaces
Dynamic workspaces are created and destroyed as they are used, which reindexes
everything and corrupts the mapping. Detect `org.gnome.mutter dynamic-workspaces`
at enable time; if true, log a clear warning and leave persistence off rather
than risk stranding windows. The published prior art carries the same restriction.

### Accepted divergence
Reassignment means the Overview, workspace switcher and alt-tab show windows on
the workspace they are *parked* on, not the one the user perceives. This is
inherent to the approach — the only alternative GNOME offers is
`workspaces-only-on-primary`, which gives secondaries no stacks at all. Document
it in the README rather than pretending it is a bug to fix.

> **Known exposure until Phase 8.** Until `syncOnExternalSwitch` lands, any
> workspace change this extension did not cause — `Ctrl`+`Alt`+arrow before Phase 4,
> an Overview thumbnail click, a notification stealing focus, `wmctrl` — leaves the
> secondary monitor showing the wrong virtual workspace *and* leaves `V[m]`
> disagreeing with what is on screen. Subsequent swipes then compute from a wrong
> baseline and compound the error, which is how windows end up parked on
> workspaces the user cannot reach. Worth logging a warning on detected desync
> during this phase even though the fix arrives later.

### Manual Verification Checklist — core behaviour ✅, edge cases carried forward
Verified on real hardware (LVDS-1 primary + VGA-1 Dell, GNOME Shell 46.0,
`dynamic-workspaces=false`, `num-workspaces=4`).

- [x] Swipe on the secondary: it shows a different set of windows and **stays** there
- [x] The primary monitor's windows never change workspace
- [x] Swiping on the primary no longer drags the secondary's contents with it — **fixed twice.** See *Two rejected designs* below.
- [ ] A window opened on the secondary while it shows virtual workspace 2 is still there after switching away and back
- [ ] Sticky (on-all-workspaces) windows stay visible on both monitors throughout
- [ ] Moving a window between workspaces by hand updates the record instead of being undone
- [ ] `disable()` returns every window to its original workspace
- [ ] With `dynamic-workspaces=true`, persistence stays off and logs a clear warning
- [ ] Fullscreen window on the secondary does not strand or lose the window

> The five unticked items are **not** blockers on the mechanism — each is guarded
> in code (sticky and desktop windows are refused by `isTrackableWindow`,
> `restoreAll()` runs from `destroy()`, `dynamic-workspaces` is checked at
> `enable()`) and covered by unit tests, but none has been exercised by hand on
> hardware. They move to the Phase 9 integration playbook rather than being
> claimed here.

### Two rejected designs, and why the third works

1. **Rotate the whole ring.** `shellFromVirtual` wraps modularly, so a secondary
   at global workspace 0 has no left neighbour to slide onto: windows landed on
   workspace 4 and the monitor could not move left again. Rejected on hardware.
2. **Pin the displayed workspace.** Holding `G` still for the primary and
   rotating everything else. Rejected outright by the user as unusable.
3. **Staging** (shipped). During a switch the `MonitorGroup` covers the monitor
   with clones, so the group need not sit at `G` at all. The monitor's windows
   are re-parked around a central staging index that always has both neighbours,
   the group slides one step, and `syncMonitor()` parks back to rest before the
   clones are torn down.

> **The `syncAll` invariant.** Every monitor renders whatever sits on the active
> workspace, so the moment the *primary* activates a new one, every secondary is
> parked against a workspace that is no longer displayed and is dragged along.
> The primary path must therefore call `syncAll(newIndex)` on settle, with the
> index passed **explicitly** rather than read back after `activate()`. Dropping
> that call is what made "moving the laptop moves the Dell too" reappear.

---

## Phase 6 — Animation & Visual Polish

**Goal:** One animation path for both inputs, correct under interruption, and
matching GNOME's native slide.

### Deliverables
- `lib/animationDriver.js` — `AnimationDriver`, now the only place a slide is
  driven. The gesture and keyboard handlers were each doing their own staging,
  anchoring and easing, and had already diverged once (Phase 4's backwards
  slide). What is left in each handler is the input itself.
  - **Sessions with a frozen anchor.** `beginSwitch()` records where the slide
    started — both the real workspace index and the monitor's virtual one — and
    every later calculation measures against those. This is what fixes
    interruption: a second swipe mid-settle reuses the actors on screen (the
    clones were built from the staged layout, so re-staging would leave them
    showing windows that have since moved), and the previous `settle()` has
    already written a new virtual index. Measuring against *that* counted the
    first switch twice — staged at 1 with `V=0`, two rightward flicks landed on
    virtual workspace 3 instead of 2.
  - Interruption on a *different* monitor closes the first switch out — snapping
    it to its target and un-staging it — rather than interleaving two switches
    through one shared `_switchData`.
  - Settles on `onStopped` rather than `onComplete`. `onComplete` fires only on a
    natural finish (`environment.js:61-66`), and the Shell tears a
    gesture-activated switch down outright when the Overview opens
    (`workspaceAnimation.js:322`), destroying the groups mid-ease. Under
    `onComplete` that stranded the monitor's windows on the staging workspaces
    with nothing on screen to explain where they went.
  - Un-stages on every bail-out path, for the same reason.
- `EASE_OUT_CUBIC` and `WINDOW_ANIMATION_TIME` (250ms) for both paths, matching
  stock `_switchWorkspaceEnd`; a gesture passes its own duration through, as the
  Shell does.
- Sticky-window groups remain visible on all monitors throughout — the Shell
  builds these itself in `_prepareWorkspaceSwitch()`, so this is a *verification*
  item, not something we construct.
- **Right-to-left.** The gesture path is inherited: `MonitorGroup.progress`,
  `getWorkspaceProgress()`, `getSnapPoints()` and `findClosestWorkspace()` each
  handle RTL internally (`workspaceAnimation.js:244, 253, 274`), and Phase 3
  drives those rather than computing progress itself. The keyboard path does
  index arithmetic instead of asking for a neighbour, so it flips left/right
  itself — mutter lays the workspace strip out right-to-left under RTL, which is
  why stock `_showWorkspaceSwitcher` needs no flip of its own and we do.
- **Vertical and grid layouts.** `_onBegin` sets the tracker's orientation from
  `layout_rows`, as stock does. The keyboard path now also honours the Shell's
  own axis guard (`windowManager.js:637-645`): a row of workspaces ignores up and
  down, a column ignores left and right. Without it the extension moved
  workspaces on keys the user's desktop otherwise ignores.
- `shellInterop.getWorkspaceLayout()` — exposes `layout_rows`/`layout_columns`
  for that guard. `findMonitorGroup()` now returns null instead of throwing when
  no switch is in flight; `_findMonitorGroup` dereferences `_switchData`
  unguarded.
- `monitorState.clampIndex()` — non-mutating, so a keystroke at either end of the
  strip is recognised as a no-op *before* any windows are staged.

> **Removed from this phase:** the original plan listed "`WorkspaceBackground`
> actors created/destroyed per virtual workspace change". `WorkspaceBackground`
> lives in `workspace.js:943` and is an **Overview** actor — it takes no part in
> the workspace switch animation, which uses `WorkspaceGroup` and `MonitorGroup`.
> There is nothing to do here.

### Automated coverage
136 checks, all passing: 36 driver, 38 keyboard, 18 gesture, 17 persistence,
8 tracker (`gjs`), 19 state (Node). ESLint clean.

### Manual Verification Checklist
- [ ] Slide animation on the active monitor is smooth and matches native feel
- [ ] No visual glitches or flicker on inactive monitors during a transition
- [ ] **No flicker at the *start* of a secondary swipe** — staging re-parks the
      windows in the same callback that builds the clones, so no frame should be
      drawn in between. A flicker here means that assumption is wrong
- [ ] A second swipe during the settle animation lands one workspace further, not two
- [ ] Swiping monitor A while monitor B is still settling leaves B where it was heading
- [ ] Opening the Overview mid-animation leaves no window stranded on a staging workspace
- [ ] Keyboard and swipe animations are indistinguishable
- [ ] Sticky (pinned) windows appear correctly on all monitors throughout
- [ ] Swipe direction is correct with a right-to-left locale active
- [ ] With the default single-row layout, `Ctrl`+`Alt`+`Up`/`Down` do nothing (as in stock GNOME)
- [ ] Vertical workspace layout: up/down switch, left/right do nothing

---

## Phase 7 — Settings & Preferences UI

**Goal:** Expose the choices that are genuinely the user's, and no others.

### Two planned settings were dropped, deliberately

- **`sync-primary-workspace`** — setting it false would stop the primary
  activating GNOME's real workspace, which means the primary needs its own stack,
  which means rotating its windows around a fixed display workspace. That is the
  pinned-display design rejected on hardware during Phase 5. Shipping it as a
  toggle would revive a design already found unusable, and would put the risky
  half of the extension on the display the user works on. The primary always
  drives the real workspace; documented as a deliberate limit, not an oversight.
- **`gesture-threshold`** — the swipe's confirm velocity lives in a module
  constant (`swipeTracker.js:25`, `VELOCITY_THRESHOLD_TOUCHPAD = 0.6`), not an
  instance property. Changing it means overriding `SwipeTracker._getEndProgress`
  and copying ~25 lines of the Shell's deceleration-projection math — internals
  we would then own and have to track across releases, to move one number. The
  gesture keeps GNOME's own feel; `animation-duration` covers what we actually
  control.

`enabled` was dropped too: GNOME already has an extension toggle, and a second
one that means something subtly different is a trap.

### Deliverables
- `schemas/org.gnome.shell.extensions.macos-workspaces.gschema.xml`:
  - `wrap-around` (boolean, default `false`) — a **secondary** monitor may step
    past either end of the strip. The primary never wraps, whatever the setting
    says: it has no staging, so wrapping it would slide backwards across every
    workspace to reach the first one. Enforced in `AnimationDriver.resolveVirtual()`.
  - `animation-duration` (int, 50–1000, default `250`) — matches the Shell's
    `WINDOW_ANIMATION_TIME`. A keystroke uses it outright; a **swipe is scaled**
    by it rather than fixed to it, so a fast flick stays fast and keeps feeling
    attached to the fingers.
- `lib/settings.js` — `SettingsManager`. Reads every value at the point of use
  rather than caching, so a preference takes effect on the next switch with
  nothing to notify and no subscription to leak. Takes an injected `Gio.Settings`,
  which is what makes it testable. Falls back to stock behaviour when the schema
  is missing rather than throwing.
- `prefs.js` — `Adw.PreferencesPage` with an `Adw.SwitchRow` and an
  `Adw.SpinRow`, both `Gio.Settings.bind()`-ed, plus an **About** page that
  states the three divergences users would otherwise file as bugs: fixed
  workspaces are required, the Overview shows where windows really are, and the
  primary monitor's windows are never moved.
- `lib/windowTracker.js` — `signedOffset()`, the shorter way round the ring.
  With wrap on, a monitor on the last workspace has the first as its right-hand
  neighbour; plain subtraction calls them `count - 1` apart and would park that
  neighbour out of reach mid-slide. `stageMonitor()` uses it only when wrapping
  is on, so the non-wrap case is unchanged.
- `lib/monitorState.js` — `wrapIndex()` beside `clampIndex()`; which one a switch
  uses is the preference, decided by the caller.

### A defect the step-based API exposed
Settling now takes a **step** rather than an absolute virtual index, because a
wrapped switch moves one workspace while its index jumps the other way round the
strip — the two can no longer be derived from each other. The keyboard path was
then passing its per-press delta, which the driver applied to the session's
frozen anchor, so a second keypress mid-settle repeated the first instead of
continuing it. Sessions now carry the distance travelled so far, and a keystroke
adds to it. Caught by the Phase 6 interruption test, which is why it was written.

### Automated coverage
165 checks, all passing: 45 driver, 42 keyboard, 20 persistence, 18 gesture,
12 settings, 8 tracker (`gjs`), 20 state (Node). ESLint clean;
`glib-compile-schemas --strict` clean.

### Manual Verification Checklist
- [x] `glib-compile-schemas schemas/` passes with no errors or warnings
- [x] Both settings readable and writable outside the prefs window
      (`gsettings get/range` against the installed schema)
- [x] Prefs window opens and both rows build — confirmed through the AT-SPI tree:
      `[frame] 'MacOS Workspaces'` → pages `General` and `About`, rows
      `Wrap around` and `Slide duration`. `org.gnome.Shell.Screenshot` is
      access-denied on GNOME 46, so accessibility remains the way to prove content
- [ ] Changing either setting takes effect on the next switch, with no restart
- [ ] `wrap-around: true`: a secondary steps from the last workspace to the first, animated
- [ ] `wrap-around: true`: the primary still stops at either end
- [ ] `wrap-around: true`: the wrapped-to workspace shows the right windows, not an empty one
- [ ] `animation-duration: 600`: keystrokes visibly slower; a fast flick still fast
- [ ] `animation-duration: 50`: no flicker or torn frame at either end of the slide

---

## Phase 8 — Edge Cases & Robustness

**Goal:** Stay correct when the world changes without going through this extension.

### Deliverables
- `lib/externalWatcher.js` — `ExternalChangeWatcher`. Delivers
  `syncOnExternalSwitch` and the rest of the reconciliation. Placed in its own
  module rather than inside `workspaceReassigner.js` as first planned: the
  reassigner moves windows, and giving it signal wiring and lifecycle as well
  would have made the one class that can strand windows the hardest to reason
  about.

  **No suppression flag.** The obvious design ignores workspace changes the
  extension caused, which needs a flag held across an asynchronous animation and
  is a re-entrancy bug waiting to happen — the original plan called this out as
  something that "re-triggers the handler and loops". This compares instead: the
  primary monitor's recorded index *is* what the extension believes the real
  workspace to be, so a change that **agrees** with it came from us and needs
  nothing, and a change that **disagrees** came from somewhere else. Verified:
  `settle()` writes the index before `activate()` fires the signal, so the model
  always already agrees by the time we hear about our own switch. Self-correcting
  and impossible to loop.

  It watches four things:
  - `workspace_manager::notify::active-workspace` — re-anchors the primary and
    re-parks every secondary. Covers Overview thumbnail clicks, a notification
    pulling focus, `wmctrl -s`, `switch-to-workspace-1` … `-12` and `-last`
    (Phase 4 only overrides the four directional bindings), other extensions,
    and any path a future GNOME adds. Stands back while one of our own switches
    is still animating, since its settle does this itself.
  - `notify::n-workspaces` — turns persistence off, restoring every window, when
    the count drops below the four that staging needs; otherwise re-syncs,
    because `MonitorStateManager` may have clamped the surviving indices.
  - `monitors-changed` — monitor indices are positional, so a hotplug renumbers
    the displays and every window record names the wrong one. Rebuilds
    attribution via `WindowTracker.retrackAll()` and resets every display to the
    workspace actually on screen, which is the only honest starting point.
  - `org.gnome.mutter` `dynamic-workspaces` and `workspaces-only-on-primary` —
    either turning on makes persistence unsafe or meaningless, so it stops and
    puts every window back. `Meta.prefs_get_*` reads these but offers GJS no
    change notification, so the settings are watched directly.
- `lib/windowTracker.js` — `retrackAll()`. Preserves each window's virtual
  workspace where its monitor survived, and resets it where the window landed on
  a different display, because a window that has moved displays belongs to what
  that display is showing.
- **Conflict detection** — `findConflicts()`, a plain function over UUIDs so it
  is testable (GJS makes `console.warn` non-configurable, so a test cannot
  capture a log line). Currently names `smart-workspace-manager@local`, which
  describes itself as keeping "workspace independence per monitor" by shifting
  windows — the same job, and the source of the `record is undefined` exceptions
  wrongly blamed on this extension during Phase 5. Extend the list as conflicts
  are observed; the behavioural check on the SwipeTracker's handler count from
  Phase 3 catches the rest.
- **State across the lock screen** — `session-modes: ["user"]` means GNOME calls
  `disable()` on lock and `enable()` on unlock. Without help, every lock silently
  collapses all displays onto one workspace, which reads as a bug rather than a
  lifecycle event. `disable()` now remembers the indices and `enable()` restores
  them, but **only after the window tracker is built**: the tracker works out
  where each window belongs by measuring it against what its monitor is showing,
  so it has to do that while the rotation is still the identity. Discards the
  saved state when the display or workspace count changed while locked.

### Already covered, and why nothing was added
- **Overview during a gesture** — handled in Phase 6 by settling from
  `onStopped`. The Shell disables the swipe tracker on `showing` and re-enables
  it on `hiding` from its own constructor (`workspaceAnimation.js:325-334`),
  which this extension never touches, so that continues to work.
- **Lock screen** — `session-modes: ["user"]` already means every patch is
  inactive while locked. Nothing to add beyond preserving state across it.
- **Version guard** — `checkCompatibility()` since Phase 3.

### Automated coverage
196 checks, all passing: 45 driver, 42 keyboard, 25 watcher, 20 persistence,
18 gesture, 14 tracker, 12 settings (`gjs`), 20 state (Node). ESLint clean.

### One claim retracted
A hotplug test logged `re-attributed 0 window(s)`, which was read as
re-attribution dropping every window and led to `monitors-changed` being
deferred. Re-running it with two windows actually open gave
`re-attributed 2 window(s)`: the zero meant nothing had been tracked, because no
applications were running. **The bug was not real.** The deferral was kept — it
coalesces the several `monitors-changed` mutter emits while settling, and costs
an idle tick — but on that basis, not on evidence of loss. `retrackAll()` now
reports how many records it lost, so if the ordering assumption ever does break
it says so instead of going quiet.

### Manual Verification Checklist
Run on the target session over SSH; the three settings and the extension list
were captured before each test and restored afterwards, and the restoration
verified.

- [x] The four watched keys exist on the target
- [x] Unplug a monitor mid-session: no crash; **`re-attributed 2 window(s)`** with
      both windows kept. Driven by a genuine `ApplyMonitorsConfig`, not a fake signal
- [x] Plug it back in mid-session: managed immediately, no stranded windows
- [x] Set `num-workspaces` to 2 while running: `per-monitor persistence off —
      there are no longer at least 4 workspaces. Every window has been put back.`
- [x] Turn on `dynamic-workspaces` while running: same, naming that cause
- [x] Turn on "Workspaces on all displays" while running: same, naming that cause
- [x] Enable `smart-workspace-manager@local` alongside: the journal names it and
      says why. Its `enable()` only connects signals, so the exposure was seconds
      with no workspace switch
- [x] Enable/disable 10 times: no JS error and no warning from this extension.
      Each cycle logs a full teardown — watcher stopped, keybindings restored,
      gesture handlers restored, tracking stopped, state destroyed — and the
      Phase 3 handler-count check never fired, so exactly one stock handler was
      found on the tracker every time
- [x] Existing windows are tracked at `enable()`, not only newly created ones
      (`tracking 2 windows` on a mid-session re-enable)
- [ ] Secondary holds its own workspace when the global one changes externally.
      **Could not be driven remotely** — see below. Needs an Overview thumbnail
      click or `Super`+`2`
- [ ] Reassignment does not re-trigger itself — same test
- [ ] Lock and unlock: each monitor comes back on the workspace it was showing.
      The restore path runs and logs on every re-enable, but only ever with all
      indices at 0, so preservation of a *non-zero* index is still unproven
- [ ] Memory growth across cycles, in Looking Glass

> **Triggering an external workspace switch is not possible from a script.**
> `wmctrl` and `xdotool` are absent and installing them needs root; an EWMH
> `_NET_CURRENT_DESKTOP` client message sent to the XWayland root is accepted by
> the X server and then ignored by mutter, which under Wayland does not take
> workspace changes from X clients. Input injection was already ruled out in
> Phase 2. This one needs a human.

---

## Phase 9 — Testing & QA

**Goal:** One command runs everything, from a checkout, with nothing to remember.

> **Constraint discovered in Phase 3:** standalone `gjs` cannot import
> `resource:///org/gnome/shell/...` — those resources exist only inside the running
> Shell process. Any module that imports them directly is untestable outside GNOME.
> This is why every Shell dependency is injected through `lib/shellInterop.js`:
> tests construct the modules with fakes and never touch a real Shell. Every
> module except `shellInterop.js` itself is covered.

### The problem this phase solves
Phases 2-8 grew 200-odd checks in a session scratchpad under names like
`ad.test.js` and `p5.test.js`, split across two runtimes — most under `gjs`, and
`monitorState` under Node with a stub for `Main`. None of it was in the
repository. A fresh checkout had no tests at all, and the scratchpad disappears
with the session.

### Deliverables
- `tests/run.js` — the runner. A test file **is** its side effect: importing it
  runs its checks, each registering with the harness, and the runner totals them
  and sets the exit status. Files are **listed, not discovered**: a file that
  fails to load must be a hard error, and a suite that silently shrinks is worse
  than one that breaks.
- `tests/harness.js` — `suite()`, `section()`, `check()` and the tally. Replaces
  the `let pass = 0, fail = 0` block that had been copy-pasted into all seven
  files.
- `tests/stubs.js` — the shared doubles: `Signaller` (a GObject-style signal
  source that needs no typelib), `makeWorkspaces()`, `makeMonitorGroup()`. Kept
  deliberately thin; a double that grows behaviour of its own starts testing
  itself, and drifts from the real object without anything failing to say so.
- Nine suites, one per module: `animationDriver`, `cursorMonitor`,
  `externalWatcher`, `gestureHandler`, `keybindingHandler`, `monitorState`,
  `settings`, `windowTracker`, `workspaceReassigner`.
- `tests/integration/playbook.md` — every manual checklist from Phases 1-8 in one
  document, grouped by what it exercises, with the commands that drive the
  scriptable parts and an explicit note on the parts no script can reach.
- `scripts/test.sh`, `scripts/lint.sh`, `scripts/validate-schema.sh`.
- `eslint.config.mjs` and a `package.json` carrying **only** devDependencies —
  the extension still ships no npm dependency and none of this is packaged.
- `.github/workflows/ci.yml` — lint, schema validation **and the unit tests** on
  every push. The tests run in CI precisely because dependency injection means
  they need no GNOME session: `apt install gjs` is the whole setup.

### Two things changed while porting
- **Node is gone.** `monitorState` was tested under Node because it once imported
  `Main` directly; Phase 3 made it take an injected bundle and nobody revisited
  the harness. Its 23 checks now run under `gjs` with everything else — one
  runner, one language, one command.
- **`cursorMonitor` had no tests at all.** It is small, but it is the fallback
  that decides which monitor a keystroke means when nothing is focused. Seven
  checks now cover it, including the non-integer answers mutter can give while a
  display is being reconfigured.

### Manual Verification Checklist
- [x] `scripts/lint.sh` produces zero errors or warnings across `extension.js`,
      `prefs.js`, `lib/` **and** `tests/`
- [x] `glib-compile-schemas --strict` passes
- [x] `gjs -m tests/run.js` exits 0 with all **206 checks passing** across 9
      suites, on GNOME 46 / gjs 1.80.2. `./scripts/test.sh` and
      `./scripts/validate-schema.sh` both exit 0 there too
- [x] A failing check actually fails the run — verified by injecting one: the
      suite is marked failed, the failure is listed with its detail, the process
      exits 1, and removing it returns the run to 0. A runner that cannot fail
      is worth nothing, so this is checked rather than assumed
- [ ] `.github/workflows/ci.yml` goes green on a push
- [ ] Integration playbook fully executed on Ubuntu 24.04 + GNOME 46

---

## Phase 10 — Packaging & Distribution

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
| External workspace change desyncs `V[m]` from screen, compounding on each swipe | ~~High~~ **closed** | **High** | Delivered in Phase 8: `ExternalChangeWatcher` reconciles on `notify::active-workspace`, recognising our own changes by agreement rather than by a suppression flag |
| Another per-monitor workspace extension runs alongside ours (e.g. Smart Workspace Manager) | Medium | **High** | Delivered in Phase 8: `findConflicts()` names `smart-workspace-manager@local` at enable time. SWM's delayed window moves race the Shell's animation and throw `record is undefined` from `_syncStacking` — errors wrongly blamed on this extension once already |
| Reassignment strands or loses windows if the Shell dies mid-sync | Low | **High** | `restoreAll()` on disable; never move primary-monitor windows; refuse to run under dynamic workspaces |
| The Shell tears a switch down mid-animation, leaving windows staged | Medium | **High** | Handled in Phase 6: the Overview does exactly this (`workspaceAnimation.js:322`), so the driver settles from `onStopped`, which fires on interruption too, and un-stages on every bail-out path |
| Overview / switcher / alt-tab disagree with what the user sees | High | Low | Inherent to reassignment; documented in the README as accepted divergence, not a defect |
| Another extension also moves windows between workspaces | Medium | Medium | `WindowTracker` follows `workspace-changed` and updates its record rather than fighting the other extension |
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
│   ├── windowTracker.js
│   ├── workspaceReassigner.js
│   ├── externalWatcher.js
│   ├── animationDriver.js
│   └── settings.js
├── schemas/
│   └── org.gnome.shell.extensions.macos-workspaces.gschema.xml
├── tests/
│   ├── run.js
│   ├── stubs.js
│   ├── monitorState.test.js
│   ├── cursorMonitor.test.js
│   ├── animationDriver.test.js
│   ├── gestureHandler.test.js
│   ├── keybindingHandler.test.js
│   ├── windowTracker.test.js
│   ├── workspaceReassigner.test.js
│   ├── settings.test.js
│   └── integration/
│       └── playbook.md
├── scripts/
│   ├── dev-session.sh
│   ├── test.sh
│   ├── lint.sh
│   ├── validate-schema.sh
│   └── pack.sh
├── .github/
│   └── workflows/
│       └── ci.yml
├── eslint.config.mjs
├── package.json
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

