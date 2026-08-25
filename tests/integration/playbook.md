# Integration playbook

Everything the unit tests cannot reach, in the order it is worth doing. The unit
suite (`./scripts/test.sh`) covers the logic; this covers the parts that need a
real GNOME Shell, a real touchpad, or a human looking at the screen.

**Target:** Ubuntu 24.04 · GNOME Shell 46 · two monitors, one primary.
**Prerequisites:** `dynamic-workspaces=false`, at least 4 workspaces, and
"Workspaces on all displays" enabled (`workspaces-only-on-primary=false`).

```bash
gsettings set org.gnome.mutter dynamic-workspaces false
gsettings set org.gnome.desktop.wm.preferences num-workspaces 4
gsettings set org.gnome.mutter workspaces-only-on-primary false
```

> **A code change needs a logout and login.** GNOME scans extensions only at
> startup, and `gnome-extensions disable && … enable` reruns `enable()` without
> reloading changed modules. The one exception is `prefs.js`, which runs in its
> own process.

> **Open a window on each display before starting.** Several of these read as
> passing with nothing open, because there is nothing to move.

---

## 1 · Load and lifecycle

| | Check | How |
|---|---|---|
| ☐ | Enables with no error in the journal | `journalctl -f -o cat /usr/bin/gnome-shell` |
| ☑ | Existing windows are tracked at enable, not only new ones | `tracking N windows` where N > 0 |
| ☑ | 10 enable/disable cycles: no error, full teardown each time | loop `gnome-extensions disable`/`enable` |
| ☐ | No memory growth over those cycles | Looking Glass, `Main.extensionManager` |
| ☐ | `disable()` returns every window to its own workspace | move windows apart first |

## 2 · Swipe gestures

Needs a touchpad. `Super` + two-finger scroll reaches the same `SwipeTracker` as
a three-finger swipe, which is how this was tested on hardware without one.

| | Check | Expected |
|---|---|---|
| ☑ | Swipe on monitor A moves only A | B does not animate |
| ☑ | B stays on its own workspace during the gesture | frozen, not merely un-animated |
| ☑ | Rapid back-to-back swipes do not crash | |
| ☑ | Swipe on the primary activates the matching global workspace | |
| ☐ | Swipe on a secondary shows different windows and **stays** | the Phase 5 behaviour |
| ☐ | Swiping the primary does not drag the secondary's contents | |
| ☐ | No flicker at the **start** of a secondary swipe | staging must be invisible |
| ☐ | A second swipe mid-settle lands one workspace on, not two | |
| ☐ | Swiping A while B is still settling leaves B where it was heading | |

## 3 · Keyboard

| | Check | Expected |
|---|---|---|
| ☑ | `Ctrl`+`Alt`+`Right` with focus on A moves only A | |
| ☑ | Focus on B, cursor on A: the keypress affects **B** | focus wins, as macOS does |
| ☑ | With nothing focused, it falls back to the cursor's monitor | |
| ☑ | At either end it is a no-op and says so in the journal | |
| ☑ | A swipe then a keypress on one monitor continue from the same index | |
| ☐ | `Ctrl`+`Alt`+`Up`/`Down` do **nothing** on a single-row layout | stock GNOME ignores them too |
| ☐ | A rapid double keypress lands two workspaces on, not one | |
| ☐ | `move-to-workspace-*` behaves exactly as stock | untouched by this extension |

## 4 · Per-monitor persistence

| | Check | Expected |
|---|---|---|
| ☐ | A window opened on the secondary is still there after switching away and back | |
| ☐ | The primary monitor's windows never change workspace | |
| ☐ | Sticky (on-all-workspaces) windows stay visible on both monitors | |
| ☐ | Moving a window between workspaces by hand updates the record | not undone |
| ☐ | A fullscreen window on the secondary is not stranded or lost | |

## 5 · Settings

Open with the gear in Extension Manager, or `gnome-extensions prefs …`.

| | Check | Expected |
|---|---|---|
| ☑ | The window opens and both rows build | `Wrap around`, `Slide duration` |
| ☑ | Both keys readable and writable outside the window | `gsettings get` / `range` |
| ☐ | A change takes effect on the next switch, no restart | |
| ☐ | `wrap-around`: a secondary steps from the last workspace to the first, animated | |
| ☐ | `wrap-around`: the wrapped-to workspace shows the right windows | exercises `signedOffset` |
| ☐ | `wrap-around`: the primary still stops at either end | |
| ☐ | `animation-duration: 600` slower; a fast flick still fast | |
| ☐ | `animation-duration: 50`: no flicker or torn frame | |

## 6 · Reconciling changes we did not cause

**These cannot be scripted.** `wmctrl` and `xdotool` need root, and an EWMH
`_NET_CURRENT_DESKTOP` message to the XWayland root is accepted by X and ignored
by mutter, which takes no workspace changes from X clients under Wayland.

| | Check | Expected |
|---|---|---|
| ☐ | Click a workspace thumbnail in the Overview | journal: `workspace changed to N without us … re-anchoring`; the secondary holds its own workspace |
| ☐ | `Super`+`2` — an absolute jump this extension does not intercept | same |
| ☐ | A notification pulling focus to another workspace | same |
| ☐ | No loop and no runaway window movement after any of the above | |
| ☐ | Open the Overview mid-animation | no window stranded on a staging workspace |

## 7 · The world changing underneath

Scriptable. **Restore every setting afterwards**, or the next session starts with
persistence silently refusing to run. Persistence stays off until the extension
is re-enabled, so recycle it between tests.

| | Check | Command |
|---|---|---|
| ☑ | Fewer than 4 workspaces: persistence stops, windows come back | `gsettings set org.gnome.desktop.wm.preferences num-workspaces 2` |
| ☑ | `dynamic-workspaces` on: same, naming that cause | `gsettings set org.gnome.mutter dynamic-workspaces true` |
| ☑ | Workspaces confined to primary: same, naming that cause | `gsettings set org.gnome.mutter workspaces-only-on-primary true` |
| ☑ | Unplug a monitor: no crash, windows re-attributed | `ApplyMonitorsConfig` over `org.gnome.Mutter.DisplayConfig` |
| ☑ | Plug it back in: managed immediately | |
| ☑ | A conflicting extension is named in the journal | enable `smart-workspace-manager@local` |
| ☐ | Lock and unlock: each monitor returns to its own workspace | needs a **non-zero** index to prove anything |
| ☐ | Toggle "Workspaces on all displays" back off: no crash | |

## 8 · Locale and layout

| | Check | Expected |
|---|---|---|
| ☐ | Right-to-left locale: swipe direction is correct | `LANG=ar_EG.UTF-8` session |
| ☐ | Right-to-left: `Ctrl`+`Alt`+`Left` moves to the **higher** index | matches mutter's own strip |
| ☐ | Vertical layout: up/down switch, left/right do nothing | `layout_rows = -1` |

---

## Recording a run

Note the Shell build and the date, and keep the journal. A check that passed
with nothing open on the secondary has not been tested — say so rather than
ticking it.

```bash
gnome-shell --version && date
journalctl -b -o short-precise /usr/bin/gnome-shell | grep macos-workspaces > run.log
```
