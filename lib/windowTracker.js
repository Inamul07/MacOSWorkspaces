/*
 * MacOS Workspaces — where each window really belongs
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * Positive modulo. JavaScript's `%` keeps the sign of the dividend, which would
 * put windows on negative workspace indices when rotating backwards.
 *
 * @param {number} value - dividend
 * @param {number} modulus - divisor, must be positive
 * @returns {number} value mod modulus, always in [0, modulus)
 */
function mod(value, modulus) {
    return ((value % modulus) + modulus) % modulus;
}

/**
 * Where a window must be parked so a monitor showing `virtualIndex` displays it.
 *
 * GNOME renders exactly one workspace across every monitor. To make monitor `m`
 * appear to sit on its own workspace, its stack is rotated so that the monitor's
 * current virtual workspace lines up with the global one. For the primary
 * monitor `virtualIndex === globalIndex`, so this is the identity and its
 * windows are never moved.
 *
 * @param {number} workspace - the window's own virtual workspace
 * @param {number} virtualIndex - the monitor's current virtual workspace
 * @param {number} globalIndex - GNOME's active workspace
 * @param {number} count - total workspaces
 * @returns {number} workspace index to park the window on
 */
export function shellFromVirtual(workspace, virtualIndex, globalIndex, count) {
    return mod(workspace - virtualIndex + globalIndex, count);
}

/**
 * Inverse of `shellFromVirtual` — which virtual workspace a parked window means.
 *
 * @param {number} parked - workspace the window actually sits on
 * @param {number} virtualIndex - the monitor's current virtual workspace
 * @param {number} globalIndex - GNOME's active workspace
 * @param {number} count - total workspaces
 * @returns {number} the window's virtual workspace
 */
export function virtualFromShell(parked, virtualIndex, globalIndex, count) {
    return mod(parked - globalIndex + virtualIndex, count);
}

/**
 * How far one workspace is from another, by the shorter way round.
 *
 * With wrap-around on, the workspace after the last one is the first, so a
 * monitor sitting on the last workspace has the first as its right-hand
 * neighbour. Plain subtraction says they are `count - 1` apart and would park
 * that neighbour out of reach; this says they are one step apart.
 *
 * @param {number} workspace - the workspace being measured
 * @param {number} from - the workspace to measure from
 * @param {number} count - total workspaces
 * @returns {number} signed distance in [-count/2, count/2]
 */
export function signedOffset(workspace, from, count) {
    const forward = mod(workspace - from, count);
    return forward > count / 2 ? forward - count : forward;
}

/**
 * Records which monitor and virtual workspace each window belongs to.
 *
 * The workspace a window is parked on is an implementation detail of the
 * rotation; this map holds the truth the user perceives. It follows the user's
 * own window moves rather than fighting them, and ignores the extension's own
 * reassignments while they are in flight.
 *
 * All Shell access arrives through an injected interop bundle.
 */
export class WindowTracker {
    /**
     * Starts tracking every existing window and watches for new ones.
     *
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     */
    constructor({interop, monitorState}) {
        this._interop = interop;
        this._monitorState = monitorState;

        /** @type {Map<object, {monitor: number, virtualWorkspace: number}>} */
        this._records = new Map();

        /** @type {Map<object, number[]>} per-window signal handler ids */
        this._windowSignals = new Map();

        this._suppressed = false;

        this._createdId = this._interop.display.connect('window-created',
            (display, window) => this._onWindowCreated(window));

        for (const window of this._interop.getWindows())
            this._track(window);

        console.log(`[macos-workspaces] tracking ${this._records.size} windows`);
    }

    /**
     * Runs a function without reacting to the window moves it performs.
     *
     * Reassignment changes workspaces itself; without this the resulting
     * `workspace-changed` signals would be read back as user intent and the
     * records would chase their own tail.
     *
     * @param {Function} fn - work to perform
     */
    suppress(fn) {
        const previous = this._suppressed;
        this._suppressed = true;
        try {
            fn();
        } finally {
            this._suppressed = previous;
        }
    }

    /**
     * Every tracked window on one monitor.
     *
     * @param {number} monitorIndex - monitor to filter by
     * @returns {Array<[object, object]>} [window, record] pairs
     */
    forMonitor(monitorIndex) {
        return [...this._records.entries()]
            .filter(([, record]) => record.monitor === monitorIndex);
    }

    /**
     * Every tracked window.
     *
     * @returns {Array<[object, object]>} [window, record] pairs
     */
    entries() {
        return [...this._records.entries()];
    }

    /**
     * Number of tracked windows.
     *
     * @returns {number} record count
     */
    get size() {
        return this._records.size;
    }

    /**
     * Disconnects every signal and drops all records.
     */
    destroy() {
        if (this._createdId) {
            this._interop.display.disconnect(this._createdId);
            this._createdId = 0;
        }

        for (const [window, ids] of this._windowSignals) {
            for (const id of ids)
                window.disconnect(id);
        }
        this._windowSignals.clear();
        this._records.clear();

        console.log('[macos-workspaces] window tracking stopped');
    }

    /**
     * Resolves which monitor a window sits on.
     *
     * @param {object} window - the Meta.Window
     * @returns {number} monitor index, or -1 when none matches
     * @private
     */
    _monitorFor(window) {
        const count = this._monitorState.getMonitorCount();
        for (let index = 0; index < count; index++) {
            if (this._interop.windowIsOnMonitor(window, index))
                return index;
        }
        return -1;
    }

    /**
     * Begins tracking one window.
     *
     * @param {object} window - the Meta.Window
     * @returns {boolean} true when the window is now tracked
     * @private
     */
    _track(window) {
        if (this._records.has(window))
            return true;

        if (!this._interop.isTrackableWindow(window))
            return false;

        const monitor = this._monitorFor(window);
        if (monitor < 0)
            return false;

        // A window appears on whatever the monitor is currently showing, so its
        // virtual workspace is that monitor's current index.
        const parked = this._interop.getWindowWorkspaceIndex(window);
        if (parked < 0)
            return false;

        const virtualWorkspace = virtualFromShell(parked,
            this._monitorState.getVirtualIndex(monitor),
            this._interop.getActiveWorkspaceIndex(),
            this._monitorState.getWorkspaceCount());

        this._records.set(window, {monitor, virtualWorkspace});

        this._windowSignals.set(window, [
            window.connect('unmanaged', () => this._untrack(window)),
            window.connect('workspace-changed', () => this._onWorkspaceChanged(window)),
            window.connect('position-changed', () => this._onPositionChanged(window)),
        ]);

        return true;
    }

    /**
     * Stops tracking one window.
     *
     * @param {object} window - the Meta.Window
     * @private
     */
    _untrack(window) {
        const ids = this._windowSignals.get(window);
        if (ids) {
            for (const id of ids)
                window.disconnect(id);
            this._windowSignals.delete(window);
        }
        this._records.delete(window);
    }

    /**
     * Handles a newly created window.
     *
     * `window-created` fires before the window has a position or a workspace, so
     * attribution usually fails on the first attempt. Retry once the compositor
     * has actually placed it — without this the tracker stays empty for every
     * window opened after the extension was enabled, which at login is all of
     * them.
     *
     * @param {object} window - the Meta.Window
     * @private
     */
    _onWindowCreated(window) {
        if (this._track(window))
            return;

        this._interop.onWindowPlaced(window, () => {
            if (this._records.has(window))
                return;
            if (this._track(window))
                console.log(`[macos-workspaces] tracking ${this._records.size} windows`);
        });
    }

    /**
     * Follows a workspace move the user made themselves.
     *
     * @param {object} window - the Meta.Window
     * @private
     */
    _onWorkspaceChanged(window) {
        if (this._suppressed)
            return;

        const record = this._records.get(window);
        if (!record)
            return;

        const parked = this._interop.getWindowWorkspaceIndex(window);
        if (parked < 0)
            return;

        record.virtualWorkspace = virtualFromShell(parked,
            this._monitorState.getVirtualIndex(record.monitor),
            this._interop.getActiveWorkspaceIndex(),
            this._monitorState.getWorkspaceCount());
    }

    /**
     * Re-attributes a window that was dragged to another monitor.
     *
     * @param {object} window - the Meta.Window
     * @private
     */
    _onPositionChanged(window) {
        if (this._suppressed)
            return;

        const record = this._records.get(window);
        if (!record)
            return;

        const monitor = this._monitorFor(window);
        if (monitor >= 0 && monitor !== record.monitor) {
            // Moving a window to another display makes it belong to whatever
            // that display is currently showing.
            record.monitor = monitor;
            record.virtualWorkspace = this._monitorState.getVirtualIndex(monitor);
        }
    }
}
