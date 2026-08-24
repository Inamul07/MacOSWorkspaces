/*
 * MacOS Workspaces — per-monitor virtual workspace state
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * Tracks an independent virtual workspace index for every physical monitor.
 *
 * This map is the source of truth for the whole extension: GNOME keeps one
 * global workspace index, and this class is what lets each display remember a
 * different one. Later phases read and advance these values; nothing here
 * touches the Shell's own workspace state.
 *
 * The map is kept consistent against two moving targets — the number of
 * workspaces, which the user can change at any time, and the set of connected
 * monitors, which changes on hotplug.
 *
 * All Shell access arrives through an injected interop bundle, so this module
 * imports nothing from `resource://` or Mutter and can be unit tested with
 * plain fakes.
 */
export class MonitorStateManager {
    /**
     * Builds the initial map and starts listening for changes.
     *
     * @param {object} interop - from `shellInterop.createInterop()`
     */
    constructor(interop) {
        /** @type {Map<number, number>} monitor index to virtual workspace index */
        this._state = new Map();

        this._workspaceManager = interop.workspaceManager;
        this._layoutManager = interop.layoutManager;

        this._nWorkspacesId = this._workspaceManager.connect(
            'notify::n-workspaces', () => this._onWorkspaceCountChanged());
        this._monitorsChangedId = this._layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());

        this._syncMonitors();
        console.log(`[macos-workspaces] state initialised — ${this.describe()}`);
    }

    /**
     * Returns the number of workspaces GNOME currently has.
     *
     * @returns {number} workspace count, always at least 1
     */
    getWorkspaceCount() {
        return Math.max(1, this._workspaceManager.n_workspaces);
    }

    /**
     * Returns the number of monitors currently connected.
     *
     * @returns {number} monitor count
     */
    getMonitorCount() {
        return this._layoutManager.monitors.length;
    }

    /**
     * Reads the virtual workspace index a monitor is currently showing.
     *
     * @param {number} monitorIndex - zero-based monitor index
     * @returns {number} virtual workspace index, or 0 for an unknown monitor
     */
    getVirtualIndex(monitorIndex) {
        const index = this._state.get(monitorIndex);
        if (index === undefined) {
            console.warn(
                `[macos-workspaces] no state for monitor ${monitorIndex}, assuming 0`);
            return 0;
        }
        return index;
    }

    /**
     * Records the virtual workspace index a monitor is showing.
     *
     * The value is clamped to the valid workspace range, so callers may pass a
     * raw result of index arithmetic without checking bounds first.
     *
     * @param {number} monitorIndex - zero-based monitor index
     * @param {number} workspaceIndex - desired virtual workspace index
     * @returns {number} the value actually stored after clamping
     */
    setVirtualIndex(monitorIndex, workspaceIndex) {
        if (!this._state.has(monitorIndex)) {
            console.warn(
                `[macos-workspaces] ignoring state for unknown monitor ${monitorIndex}`);
            return 0;
        }

        const clamped = this._clamp(workspaceIndex);
        this._state.set(monitorIndex, clamped);
        return clamped;
    }

    /**
     * Clamps a workspace index into the currently valid range, without storing it.
     *
     * Lets a caller find out what a move *would* settle on before committing to
     * it — a keystroke at either end of the strip has to be recognised as a
     * no-op before any windows are staged.
     *
     * @param {number} workspaceIndex - value to clamp
     * @returns {number} value within [0, workspaceCount - 1]
     */
    clampIndex(workspaceIndex) {
        return this._clamp(workspaceIndex);
    }

    /**
     * Wraps a workspace index around the ends of the strip, without storing it.
     *
     * Where `clampIndex` stops at either end, this carries on round: one step
     * past the last workspace is the first. Which of the two a switch uses is
     * the `wrap-around` preference, decided by the caller — the primary monitor
     * never wraps regardless of it.
     *
     * @param {number} workspaceIndex - value to wrap
     * @returns {number} value within [0, workspaceCount - 1]
     */
    wrapIndex(workspaceIndex) {
        if (!Number.isFinite(workspaceIndex))
            return 0;
        const count = this.getWorkspaceCount();
        return ((Math.trunc(workspaceIndex) % count) + count) % count;
    }

    /**
     * Returns a snapshot of the current map, safe for callers to keep.
     *
     * @returns {Map<number, number>} copy of monitor index to workspace index
     */
    getSnapshot() {
        return new Map(this._state);
    }

    /**
     * Renders the current map as a single log-friendly line.
     *
     * @returns {string} e.g. "2 monitors, 4 workspaces: [0]=0 [1]=2"
     */
    describe() {
        const pairs = [...this._state.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([monitor, workspace]) => `[${monitor}]=${workspace}`)
            .join(' ');
        return `${this._state.size} monitors, ` +
            `${this.getWorkspaceCount()} workspaces: ${pairs}`;
    }

    /**
     * Disconnects every signal and drops all state.
     */
    destroy() {
        if (this._nWorkspacesId) {
            this._workspaceManager.disconnect(this._nWorkspacesId);
            this._nWorkspacesId = 0;
        }
        if (this._monitorsChangedId) {
            this._layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this._state.clear();
        this._workspaceManager = null;
        this._layoutManager = null;
        console.log('[macos-workspaces] state destroyed');
    }

    /**
     * Clamps a workspace index into the currently valid range.
     *
     * @param {number} workspaceIndex - value to clamp
     * @returns {number} value within [0, workspaceCount - 1]
     * @private
     */
    _clamp(workspaceIndex) {
        if (!Number.isFinite(workspaceIndex))
            return 0;
        const last = this.getWorkspaceCount() - 1;
        return Math.min(Math.max(Math.trunc(workspaceIndex), 0), last);
    }

    /**
     * Adds entries for new monitors and drops entries for departed ones.
     *
     * Monitor indices are positional, so a hotplug can renumber the displays
     * that remain. Surviving indices keep their workspace; anything beyond the
     * new count is dropped and anything newly present starts at workspace 0.
     *
     * @private
     */
    _syncMonitors() {
        const count = this.getMonitorCount();

        for (const monitorIndex of [...this._state.keys()]) {
            if (monitorIndex >= count)
                this._state.delete(monitorIndex);
        }

        for (let monitorIndex = 0; monitorIndex < count; monitorIndex++) {
            if (!this._state.has(monitorIndex))
                this._state.set(monitorIndex, 0);
        }
    }

    /**
     * Handles a monitor being connected or disconnected.
     *
     * @private
     */
    _onMonitorsChanged() {
        this._syncMonitors();
        console.log(`[macos-workspaces] monitors changed — ${this.describe()}`);
    }

    /**
     * Re-clamps every stored index after the workspace count changes.
     *
     * @private
     */
    _onWorkspaceCountChanged() {
        for (const [monitorIndex, workspaceIndex] of this._state) {
            const clamped = this._clamp(workspaceIndex);
            if (clamped !== workspaceIndex)
                this._state.set(monitorIndex, clamped);
        }
        console.log(`[macos-workspaces] workspace count changed — ${this.describe()}`);
    }
}
