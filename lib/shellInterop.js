/*
 * MacOS Workspaces — the single seam onto GNOME Shell internals
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * Every GNOME Shell and Mutter import in this extension lives in this file.
 *
 * Two reasons, both load-bearing:
 *
 * 1. Version guarding. Internal symbols carry no stability promise, so there is
 *    exactly one place to check them and one place to fix when they move.
 * 2. Testability. Standalone `gjs` cannot resolve `resource:///org/gnome/shell/*`
 *    at all, and has no typelib for Mtk, Clutter, Meta or Shell — those ship in
 *    `/usr/lib/x86_64-linux-gnu/mutter-14/` and `/usr/lib/gnome-shell/`, outside
 *    the default search path. Any module importing them is untestable outside a
 *    running Shell. Keeping them here lets every other module take an injected
 *    interop object and be exercised with plain fakes.
 */

/** Human-readable name used in compatibility diagnostics. @type {string} */
const TARGET = 'GNOME Shell 46';

/**
 * Verifies every internal symbol this extension drives actually exists.
 *
 * Called before anything is patched. Returns a reason string rather than
 * throwing, so `enable()` can log and bail out leaving the Shell untouched.
 *
 * @returns {?string} null when compatible, otherwise why it is not
 */
export function checkCompatibility() {
    // GNOME INTERNAL: js/ui/main.js:wm
    const wm = Main.wm;
    if (!wm)
        return 'Main.wm is missing';

    // GNOME INTERNAL: js/ui/main.js:wm._workspaceAnimation
    const wac = wm._workspaceAnimation;
    if (!wac)
        return 'Main.wm._workspaceAnimation is missing';

    // GNOME INTERNAL: js/ui/workspaceAnimation.js:338 — the interception point.
    const tracker = wac._swipeTracker;
    if (!tracker)
        return 'WorkspaceAnimationController._swipeTracker is missing';

    // These stay untouched by us, but destroy() reconnects them, so a rename
    // would leave the Shell without its own gesture handling after disable().
    for (const name of ['_switchWorkspaceBegin', '_switchWorkspaceUpdate',
        '_switchWorkspaceEnd']) {
        if (typeof wac[name] !== 'function')
            return `WorkspaceAnimationController.${name} is missing`;
    }

    // GNOME INTERNAL: js/ui/workspaceAnimation.js:448
    if (typeof wac._findMonitorGroup !== 'function')
        return 'WorkspaceAnimationController._findMonitorGroup is missing';

    if (typeof tracker.confirmSwipe !== 'function')
        return 'SwipeTracker.confirmSwipe is missing';

    // GNOME INTERNAL: js/ui/windowManager.js:1095 — keyboard interception point.
    if (typeof wm.setCustomKeybindingHandler !== 'function')
        return 'Main.wm.setCustomKeybindingHandler is missing';

    // GNOME INTERNAL: js/ui/windowManager.js:560 — restore target on disable.
    if (typeof wm._showWorkspaceSwitcher !== 'function')
        return 'Main.wm._showWorkspaceSwitcher is missing';

    return null;
}

/**
 * Builds the dependency bundle every other module is constructed with.
 *
 * Nothing here is stateful; it is a narrow view onto the Shell that fakes can
 * stand in for.
 *
 * @returns {object} injectable Shell capabilities
 */
export function createInterop() {
    return {
        target: TARGET,

        // GNOME INTERNAL: js/ui/main.js:layoutManager
        layoutManager: Main.layoutManager,

        // GNOME INTERNAL: meta/meta-workspace-manager.h
        workspaceManager: global.workspace_manager,

        /**
         * Index of the primary monitor.
         *
         * @returns {number} primary monitor index
         */
        getPrimaryIndex: () => Main.layoutManager.primaryIndex,

        /**
         * Current pointer position in stage coordinates.
         *
         * @returns {number[]} [x, y]
         */
        getPointer: () => {
            // GNOME INTERNAL: shell/shell-global.c:shell_global_get_pointer
            const [x, y] = global.get_pointer();
            return [x, y];
        },

        /**
         * Maps a rectangle to the monitor containing it.
         *
         * @param {number} x - rectangle origin x
         * @param {number} y - rectangle origin y
         * @param {number} width - rectangle width
         * @param {number} height - rectangle height
         * @returns {number} monitor index, or -1 when it maps to none
         */
        getMonitorIndexForRect: (x, y, width, height) => {
            // GNOME INTERNAL: meta/display.h:meta_display_get_monitor_index_for_rect
            const rect = new Mtk.Rectangle({x, y, width, height});
            return global.display.get_monitor_index_for_rect(rect);
        },

        /**
         * The Shell's workspace animation controller.
         *
         * @returns {?object} the controller, or null if absent
         */
        getWorkspaceAnimation: () => Main.wm?._workspaceAnimation ?? null,

        /**
         * The SwipeTracker whose signals this extension takes over.
         *
         * @returns {?object} the tracker, or null if absent
         */
        getSwipeTracker: () => Main.wm?._workspaceAnimation?._swipeTracker ?? null,

        /**
         * Looks up the MonitorGroup actor driving one monitor's slide.
         *
         * @param {number} monitorIndex - zero-based monitor index
         * @returns {?object} the MonitorGroup, or null when no switch is in flight
         */
        findMonitorGroup: monitorIndex => {
            // GNOME INTERNAL: js/ui/workspaceAnimation.js:448
            const wac = Main.wm?._workspaceAnimation;
            // `_findMonitorGroup` dereferences `_switchData` unguarded, so it
            // throws rather than returning null when no switch is in flight.
            if (!wac?._switchData)
                return null;
            return wac._findMonitorGroup(monitorIndex) ?? null;
        },

        /**
         * Clutter orientation constant for a workspace layout.
         *
         * @param {boolean} horizontal - true for a row layout
         * @returns {number} Clutter.Orientation value
         */
        orientationFor: horizontal => horizontal
            ? Clutter.Orientation.HORIZONTAL
            : Clutter.Orientation.VERTICAL,

        /**
         * Timestamp of the event being processed, for workspace activation.
         *
         * @returns {number} event time
         */
        currentEventTime: () => Clutter.get_current_event_time(),

        /** Easing curve matching the Shell's own workspace switch. @type {number} */
        easeOutCubic: Clutter.AnimationMode.EASE_OUT_CUBIC,

        /**
         * Whether GNOME is configured to confine workspaces to the primary monitor.
         *
         * When true there is nothing per-monitor to do and stock behaviour applies.
         *
         * @returns {boolean} true when workspaces are primary-only
         */
        isWorkspacesOnlyOnPrimary: () => Meta.prefs_get_workspaces_only_on_primary(),

        /**
         * Whether workspaces are laid out in a row rather than a column.
         *
         * @returns {boolean} true for a horizontal layout
         */
        isHorizontalLayout: () => global.workspace_manager.layout_rows !== -1,

        /**
         * The workspace grid's shape, as mutter reports it.
         *
         * A `-1` means "unbounded on that axis": `rows === -1` is a single
         * column, `columns === -1` a single row. The Shell uses exactly these
         * two tests to decide which arrow keys a layout responds to
         * (`windowManager.js:637-645`).
         *
         * @returns {{rows: number, columns: number}} the layout
         */
        getWorkspaceLayout: () => ({
            // GNOME INTERNAL: meta/meta-workspace-manager.h
            rows: global.workspace_manager.layout_rows,
            columns: global.workspace_manager.layout_columns,
        }),

        /**
         * Builds the Shell's per-monitor actors for a switch, if not already built.
         */
        prepareWorkspaceSwitch: () => {
            // GNOME INTERNAL: js/ui/workspaceAnimation.js:347
            Main.wm?._workspaceAnimation?._prepareWorkspaceSwitch();
        },

        /**
         * The in-flight switch state, or null when no switch is running.
         *
         * @returns {?object} the Shell's `_switchData`
         */
        getSwitchData: () => {
            // GNOME INTERNAL: js/ui/workspaceAnimation.js:318
            return Main.wm?._workspaceAnimation?._switchData ?? null;
        },

        /**
         * Tears the switch down and destroys its actors.
         *
         * @param {object} switchData - the state returned by `getSwitchData()`
         */
        finishWorkspaceSwitch: switchData => {
            // GNOME INTERNAL: js/ui/workspaceAnimation.js:381
            Main.wm?._workspaceAnimation?._finishWorkspaceSwitch(switchData);
        },

        /** Duration the Shell uses for a workspace switch, in ms. @type {number} */
        // GNOME INTERNAL: js/ui/workspaceAnimation.js:16 — WINDOW_ANIMATION_TIME
        switchDuration: 250,

        /**
         * Whether the current locale runs right-to-left.
         *
         * @returns {boolean} true for RTL
         */
        isRtl: () =>
            Clutter.get_default_text_direction() === Clutter.TextDirection.RTL,

        /**
         * Index of the workspace GNOME currently considers active.
         *
         * @returns {number} active workspace index
         */
        getActiveWorkspaceIndex: () =>
            global.workspace_manager.get_active_workspace_index(),

        /**
         * Looks up a workspace by index.
         *
         * @param {number} index - workspace index
         * @returns {?object} the Meta.Workspace, or null
         */
        getWorkspaceByIndex: index =>
            global.workspace_manager.get_workspace_by_index(index),

        /**
         * Monitor showing the currently focused window.
         *
         * macOS keys workspace shortcuts off focus rather than the pointer, so
         * this is the primary signal for which display a keystroke means.
         *
         * @returns {number} monitor index, or -1 when nothing is focused
         */
        getFocusWindowMonitor: () => {
            // GNOME INTERNAL: meta/display.h:meta_display_get_focus_window
            const window = global.display.get_focus_window();
            return window ? window.get_monitor() : -1;
        },

        /**
         * Installs a handler for a workspace-switching keybinding.
         *
         * @param {string} name - keybinding name
         * @param {Function} handler - called as (display, window, binding)
         */
        setKeybindingHandler: (name, handler) => {
            // GNOME INTERNAL: js/ui/windowManager.js:1095
            Main.wm.setCustomKeybindingHandler(name,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, handler);
        },

        /** The display, for window lifecycle signals. @type {object} */
        // GNOME INTERNAL: meta/display.h
        display: global.display,

        /**
         * Whether GNOME creates and destroys workspaces on demand.
         *
         * Per-monitor persistence rotates windows across a fixed ring of
         * workspaces, so a changing count corrupts the mapping.
         *
         * @returns {boolean} true when workspaces are dynamic
         */
        isDynamicWorkspaces: () => Meta.prefs_get_dynamic_workspaces(),

        /**
         * Every managed window, newest last.
         *
         * @returns {object[]} Meta.Window objects
         */
        getWindows: () =>
            global.get_window_actors().map(actor => actor.meta_window),

        /**
         * Whether a window sits on a given monitor.
         *
         * Uses frame-rect intersection rather than `Meta.Window.get_monitor()`
         * so our attribution agrees with the Shell's own
         * `WorkspaceGroup._windowIsOnThisMonitor`.
         *
         * @param {object} window - the Meta.Window
         * @param {number} monitorIndex - monitor to test against
         * @returns {boolean} true when the window overlaps that monitor
         */
        windowIsOnMonitor: (window, monitorIndex) => {
            // GNOME INTERNAL: js/ui/workspaceAnimation.js:98
            const geometry = global.display.get_monitor_geometry(monitorIndex);
            const [intersects] = window.get_frame_rect().intersect(geometry);
            return intersects;
        },

        /**
         * Whether a window should participate in per-monitor persistence.
         *
         * Sticky windows belong to every workspace by definition, and
         * override-redirect and desktop windows are not user workspace content.
         *
         * @param {object} window - the Meta.Window
         * @returns {boolean} true when the window may be reassigned
         */
        isTrackableWindow: window => {
            if (!window || window.is_override_redirect())
                return false;
            if (window.is_on_all_workspaces())
                return false;
            return window.get_window_type() !== Meta.WindowType.DESKTOP;
        },

        /**
         * The workspace a window currently sits on.
         *
         * @param {object} window - the Meta.Window
         * @returns {number} workspace index, or -1 when it has none
         */
        getWindowWorkspaceIndex: window => {
            const workspace = window.get_workspace();
            return workspace ? workspace.index() : -1;
        },

        /**
         * Runs a callback once a new window has actually been placed on screen.
         *
         * Mutter emits `window-created` before the window has a position or a
         * workspace, so attributing it to a monitor at that moment fails. The
         * compositor actor's first frame is the earliest reliable point.
         *
         * @param {object} window - the Meta.Window
         * @param {Function} callback - invoked once the window is placed
         */
        onWindowPlaced: (window, callback) => {
            // GNOME INTERNAL: meta/window.h:meta_window_get_compositor_private
            const actor = window.get_compositor_private();
            if (!actor) {
                callback();
                return;
            }
            const id = actor.connect('first-frame', () => {
                actor.disconnect(id);
                callback();
            });
        },

        /**
         * Moves a window to a workspace.
         *
         * @param {object} window - the Meta.Window
         * @param {number} workspaceIndex - destination workspace
         */
        changeWorkspace: (window, workspaceIndex) => {
            // GNOME INTERNAL: meta/window.h:meta_window_change_workspace_by_index
            window.change_workspace_by_index(workspaceIndex, false);
        },

        /**
         * Puts the Shell's own handler back on a keybinding.
         *
         * @param {string} name - keybinding name
         */
        restoreKeybindingHandler: name => {
            // GNOME INTERNAL: js/ui/windowManager.js:560-596
            const wm = Main.wm;
            wm.setCustomKeybindingHandler(name,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                wm._showWorkspaceSwitcher.bind(wm));
        },
    };
}
