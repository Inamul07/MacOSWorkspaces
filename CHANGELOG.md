# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-25

First release. Every monitor keeps its own workspace, the way macOS does.

### Added
- **Per-monitor swipe gestures.** A three-finger horizontal swipe advances only
  the display the gesture began on; every other monitor stays where it is.
- **Per-monitor keyboard switching.** `Ctrl`+`Alt`+arrow acts on the display
  holding the focused window, falling back to the pointer's display and then to
  the primary. Off-axis arrows are ignored on a single-row layout, as in stock
  GNOME.
- **Per-monitor persistence.** A secondary monitor really shows its own
  workspace, not just an animation towards one. Windows are rotated across
  GNOME's workspaces so the right set is on screen. The primary monitor's
  windows are never moved.
- **Reconciliation.** A workspace change this extension did not cause — an
  Overview thumbnail, a notification stealing focus, `Super`+`2`, another
  extension — re-anchors the primary and re-parks every secondary, so the
  displays keep their own positions instead of drifting.
- **Settings**: `wrap-around` (secondary monitors only) and `animation-duration`
  (a swipe is scaled by it rather than fixed to it, so a fast flick stays fast).
- A hidden `debug-logging` key for diagnosing problems.
- Warns when an extension doing the same job is enabled alongside this one.

### Requirements
- GNOME Shell 46, Wayland or X11.
- A fixed number of workspaces, at least four. Dynamic workspaces are created
  and destroyed as they are used, which would strand windows on workspaces you
  cannot reach, so persistence stays off and says so.
- "Workspaces on all displays" enabled.

### Known limitations
- The Overview, the workspace switcher and Alt+Tab show the workspace a window
  is *parked* on, which is not always the one you see it on. This is inherent to
  how per-monitor workspaces are possible at all under GNOME.
- The primary monitor never wraps, even with `wrap-around` on: it drives GNOME's
  real workspace, and wrapping it would slide backwards across every workspace.
- Per-monitor positions are preserved across a screen lock, but reset if a
  display or workspace appears or disappears while locked.

[Unreleased]: https://github.com/Inamul07/MacOSWorkspaces/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Inamul07/MacOSWorkspaces/releases/tag/v0.1.0
