/*
 * MacOS Workspaces — per-monitor keyboard workspace switching
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {getCursorMonitorIndex} from './cursorMonitor.js';

/**
 * Keybindings this extension re-registers, and how each moves.
 *
 * `delta` is the step along the workspace strip; `vertical` says which axis the
 * binding belongs to, which decides whether the current layout honours it at all.
 *
 * Only relative motion is handled. The absolute jumps (`switch-to-workspace-1`
 * through `-12`, and `-last`) and the window-moving `move-to-workspace-*` family
 * keep the Shell's own handler.
 *
 * @type {Map<string, {delta: number, vertical: boolean}>}
 */
const BINDINGS = new Map([
    ['switch-to-workspace-left', {delta: -1, vertical: false}],
    ['switch-to-workspace-right', {delta: 1, vertical: false}],
    ['switch-to-workspace-up', {delta: -1, vertical: true}],
    ['switch-to-workspace-down', {delta: 1, vertical: true}],
]);

/**
 * Makes Ctrl+Alt+arrow act on a single monitor.
 *
 * Keyboard switching never reaches the SwipeTracker, so the gesture takeover
 * does nothing for it. The Shell routes these bindings to
 * `_showWorkspaceSwitcher()`, which calls `Meta.Workspace.activate()` — a change
 * to the *single global* workspace. Acting per-monitor therefore means replacing
 * the binding handler outright, before activation happens.
 *
 * The animation itself belongs to `AnimationDriver`, shared with the gesture
 * path, so a keystroke and a swipe cannot look or count differently.
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
     * @param {object} params.driver - the shared `AnimationDriver`
     */
    constructor({interop, monitorState, driver}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._driver = driver;
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
     * Returns 0 when the layout does not run along the binding's axis. Stock
     * GNOME refuses those keystrokes outright (`windowManager.js:637-645`): with
     * a row of workspaces, up and down do nothing, and with a column, left and
     * right do nothing. Honouring them here would make the extension move
     * workspaces on keys the user's desktop otherwise ignores.
     *
     * @param {string} name - keybinding name
     * @returns {number} -1, 0 or 1
     * @private
     */
    _deltaFor(name) {
        const binding = BINDINGS.get(name);
        if (!binding)
            return 0;

        const {rows, columns} = this._interop.getWorkspaceLayout();
        if (rows === -1 && !binding.vertical)
            return 0;
        if (columns === -1 && binding.vertical)
            return 0;

        // Left and right swap meaning in a right-to-left locale, because the
        // workspace strip itself is laid out right-to-left — mutter's own
        // workspace layout does this, so `get_neighbor(LEFT)` returns the
        // *higher* index there and stock GNOME needs no flip of its own. Doing
        // index arithmetic instead of asking for the neighbour means doing it
        // here. Up and down are unaffected, which is why only the horizontal
        // pair is flipped.
        if (!binding.vertical && this._interop.isRtl())
            return -binding.delta;

        return binding.delta;
    }

    /**
     * Advances one monitor by one workspace.
     *
     * @param {object} binding - the Meta.KeyBinding that fired
     * @private
     */
    _onSwitch(binding) {
        const name = binding.get_name();
        const delta = this._deltaFor(name);
        if (delta === 0) {
            if (BINDINGS.has(name)) {
                console.log(`[macos-workspaces] key: ${name} does not apply to the ` +
                    'current workspace layout, ignoring (stock GNOME does the same)');
            }
            return;
        }

        if (this._monitorState.getWorkspaceCount() === 1)
            return;

        const monitor = this._resolveMonitor();

        // Read and clamp before opening a switch: a keystroke at either end of
        // the strip must not stage windows or build animation actors for a move
        // that is not going to happen.
        const from = this._driver.virtualIndexOf(monitor);
        const to = this._monitorState.clampIndex(from + delta);

        if (to === from) {
            // Stock GNOME also refuses to go further, but say so rather than
            // doing nothing silently.
            console.log(`[macos-workspaces] key: monitor ${monitor} already at ` +
                `workspace ${from}, no move (wrap-around arrives in Phase 7)`);
            return;
        }

        const session = this._driver.beginSwitch(monitor);
        if (!session)
            return;

        this._driver.settle(session, to);
    }
}
