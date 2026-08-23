/*
 * MacOS Workspaces — per-monitor keyboard workspace switching
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {getCursorMonitorIndex} from './cursorMonitor.js';

/**
 * Keybindings this extension re-registers, and the workspace delta each means.
 *
 * Only relative motion is handled. The absolute jumps (`switch-to-workspace-1`
 * through `-12`, and `-last`) and the window-moving `move-to-workspace-*` family
 * keep the Shell's own handler.
 *
 * @type {Map<string, number>}
 */
const BINDINGS = new Map([
    ['switch-to-workspace-left', -1],
    ['switch-to-workspace-right', 1],
    ['switch-to-workspace-up', -1],
    ['switch-to-workspace-down', 1],
]);

/** Bindings whose direction flips under a right-to-left locale. @type {Set<string>} */
const HORIZONTAL = new Set(['switch-to-workspace-left', 'switch-to-workspace-right']);

/**
 * Makes Ctrl+Alt+arrow act on a single monitor.
 *
 * Keyboard switching never reaches the SwipeTracker, so the gesture takeover
 * does nothing for it. The Shell routes these bindings to
 * `_showWorkspaceSwitcher()`, which calls `Meta.Workspace.activate()` — a change
 * to the *single global* workspace. Acting per-monitor therefore means replacing
 * the binding handler outright, before activation happens.
 *
 * All Shell access arrives through an injected interop bundle; this module
 * imports nothing from `resource://` or Mutter.
 */
export class KeybindingHandler {
    /**
     * Re-registers the directional workspace keybindings.
     *
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     */
    constructor({interop, monitorState}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._taken = [];

        for (const name of BINDINGS.keys()) {
            this._interop.setKeybindingHandler(name,
                (display, window, binding) => this._onSwitch(binding));
            this._taken.push(name);
        }

        console.log(`[macos-workspaces] keybindings taken over (${this._taken.length})`);
    }

    /**
     * Hands the keybindings back to the Shell.
     *
     * Safe to call more than once.
     */
    destroy() {
        for (const name of this._taken)
            this._interop.restoreKeybindingHandler(name);

        if (this._taken.length)
            console.log('[macos-workspaces] keybindings restored');

        this._taken = [];
    }

    /**
     * Chooses which monitor a keystroke refers to.
     *
     * A keystroke carries no position, so focus decides — matching macOS, where
     * the focused display is the one that moves. The pointer is the fallback for
     * when nothing is focused, and the primary monitor the last resort.
     *
     * @returns {number} monitor index
     * @private
     */
    _resolveMonitor() {
        const focused = this._interop.getFocusWindowMonitor();
        if (focused >= 0)
            return focused;

        const cursor = getCursorMonitorIndex(this._interop);
        if (cursor >= 0)
            return cursor;

        return this._interop.getPrimaryIndex();
    }

    /**
     * Converts a binding name into a workspace delta.
     *
     * @param {string} name - keybinding name
     * @returns {number} -1 or 1
     * @private
     */
    _deltaFor(name) {
        const delta = BINDINGS.get(name) ?? 0;

        // Left and right swap meaning in a right-to-left locale; up and down do
        // not, which is why only the horizontal pair is flipped.
        if (HORIZONTAL.has(name) && this._interop.isRtl())
            return -delta;

        return delta;
    }

    /**
     * Advances one monitor by one workspace.
     *
     * @param {object} binding - the Meta.KeyBinding that fired
     * @private
     */
    _onSwitch(binding) {
        const delta = this._deltaFor(binding.get_name());
        if (delta === 0)
            return;

        const monitor = this._resolveMonitor();
        const primary = this._interop.getPrimaryIndex();

        // Anchor on the workspace the monitor is actually showing, which today is
        // always GNOME's global one — nothing renders `V[m]` yet. Deriving the
        // target from `V[m]` instead makes the group ease from the global
        // position toward a virtual one, and the slide runs backwards whenever
        // the two disagree. Phase 5 moves this anchor to `V[m]`, once `V[m]` is
        // what the monitor renders and the two can no longer diverge.
        const from = this._interop.getActiveWorkspaceIndex();
        const to = this._monitorState.setVirtualIndex(monitor, from + delta);

        if (to === from) {
            // Clamped at the first or last workspace. Stock GNOME also refuses to
            // go further, but say so rather than doing nothing silently.
            console.log(`[macos-workspaces] key: monitor ${monitor} already at ` +
                `workspace ${from}, no move (wrap-around arrives in Phase 7)`);
            return;
        }

        this._switchMonitor(monitor, from, to, monitor === primary);
    }

    /**
     * Animates one monitor onto a workspace and settles the Shell's state.
     *
     * @param {number} monitor - monitor index to move
     * @param {number} fromIndex - workspace the monitor is showing now
     * @param {number} workspaceIndex - workspace to settle on
     * @param {boolean} isPrimary - whether this monitor drives the global workspace
     * @private
     */
    _switchMonitor(monitor, fromIndex, workspaceIndex, isPrimary) {
        const targetWs = this._interop.getWorkspaceByIndex(workspaceIndex);
        const fromWs = this._interop.getWorkspaceByIndex(fromIndex);
        if (!targetWs || !fromWs)
            return;

        this._interop.prepareWorkspaceSwitch();
        const switchData = this._interop.getSwitchData();
        if (!switchData)
            return;

        // Marking the switch activated makes the Shell's own `_shouldAnimate()`
        // return false, so activating the workspace below cannot kick off a
        // second animation across every monitor.
        switchData.gestureActivated = true;

        const monitorGroup = this._interop.findMonitorGroup(monitor);
        if (!monitorGroup) {
            this._interop.finishWorkspaceSwitch(switchData);
            return;
        }

        switchData.baseMonitorGroup = monitorGroup;

        // Pin the start of the slide explicitly, the way the Shell's own
        // animateSwitch does, so the direction never depends on whatever the
        // group happened to be initialised to.
        monitorGroup.progress = monitorGroup.getWorkspaceProgress(fromWs);

        console.log(`[macos-workspaces] key: monitor ${monitor} -> workspace ` +
            `${workspaceIndex}${isPrimary ? ' (primary, activating globally)' : ''}`);

        // Same easing and duration as the gesture path and as the Shell's own
        // animateSwitch; Phase 6 lifts this into the shared animation driver.
        monitorGroup.ease_property('progress',
            monitorGroup.getWorkspaceProgress(targetWs), {
                duration: this._interop.switchDuration,
                mode: this._interop.easeOutCubic,
                onComplete: () => {
                    if (isPrimary && !targetWs.active)
                        targetWs.activate(this._interop.currentEventTime());
                    this._interop.finishWorkspaceSwitch(switchData);
                },
            });
    }
}
