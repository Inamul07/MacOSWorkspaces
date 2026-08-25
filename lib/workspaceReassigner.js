/*
 * MacOS Workspaces — makes a secondary monitor hold its own workspace
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {shellFromVirtual, signedOffset} from './windowTracker.js';
import {debug, warn} from './log.js';

/**
 * Parks every monitor's windows so each shows its own workspace.
 *
 * GNOME renders one workspace across all displays, so a monitor cannot simply
 * "be" on a different one. Instead each monitor's windows are rotated across the
 * workspace ring until the set belonging to its virtual workspace lands on the
 * one GNOME is displaying. Because a window is attributed to a monitor by
 * geometry, moving it between workspaces changes which display shows it without
 * moving it on screen.
 *
 * The primary monitor is never touched: its virtual index tracks GNOME's active
 * workspace, so the rotation is the identity there. A bug in here cannot scatter
 * the windows on the display the user is most likely working on.
 *
 * ## Staging, and why it exists
 *
 * A monitor at rest displays the active workspace `G`. Sliding needs a real
 * workspace next to the one on display, and at `G = 0` there is nothing to the
 * left — which once left a secondary monitor permanently unable to move left,
 * since `G` is wherever the primary happens to be.
 *
 * During a switch the Shell's `MonitorGroup` covers the monitor with clones and
 * this extension drives its `progress` directly, so the group need not sit at
 * `G` at all. `stageMonitor()` re-parks that monitor's windows around a central
 * staging index which always has both neighbours; the group is pointed there and
 * slides one step either way. `syncMonitor()` then parks back to rest before the
 * clones are torn down. `G` never moves, and the primary never notices.
 */
export class WorkspaceReassigner {
    /**
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     * @param {object} params.windowTracker - the `WindowTracker`
     * @param {object} [params.settings] - the `SettingsManager`
     */
    constructor({interop, monitorState, windowTracker, settings}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._windowTracker = windowTracker;
        this._settings = settings;
        this._enabled = true;
    }

    /**
     * Workspace index a staged slide is centred on.
     *
     * Always has a neighbour on both sides, which is the entire point: it is
     * what lets a monitor slide left even when the active workspace is the
     * first one.
     *
     * @returns {number} the staging centre
     */
    getStagingIndex() {
        return 1;
    }

    /**
     * Whether there are enough workspaces to stage a slide.
     *
     * Three for the staging window itself, plus one to park everything else on
     * so unrelated workspaces cannot drift into view mid-slide.
     *
     * @returns {boolean} true when staging is possible
     */
    hasRoom() {
        return this._monitorState.getWorkspaceCount() >= 4;
    }

    /**
     * Re-parks one monitor's windows around the staging centre, ready to slide.
     *
     * Call immediately before the Shell builds its clones: the clones are made
     * from wherever the windows are at that moment, and this arrangement is what
     * they must capture.
     *
     * @param {number} monitorIndex - monitor about to move
     * @returns {number} workspace index the monitor's group should start at
     */
    stageMonitor(monitorIndex) {
        const staging = this.getStagingIndex();
        if (!this._enabled || monitorIndex === this._interop.getPrimaryIndex())
            return this._interop.getActiveWorkspaceIndex();

        const virtualIndex = this._monitorState.getVirtualIndex(monitorIndex);
        const count = this._monitorState.getWorkspaceCount();

        // Anything further than one step away cannot be reached by this slide,
        // so park it clear of the staging window entirely.
        const elsewhere = count - 1;

        // With wrap-around on, the workspace past either end is a real
        // neighbour and has to be staged as one.
        const wrap = this._settings?.wrapAround ?? false;

        this._windowTracker.suppress(() => {
            for (const [window, record] of this._windowTracker.forMonitor(monitorIndex)) {
                const offset = wrap
                    ? signedOffset(record.virtualWorkspace, virtualIndex, count)
                    : record.virtualWorkspace - virtualIndex;
                const target = Math.abs(offset) <= 1 ? staging + offset : elsewhere;

                if (this._interop.getWindowWorkspaceIndex(window) !== target)
                    this._interop.changeWorkspace(window, target);
            }
        });

        return staging;
    }

    /**
     * Whether reassignment is running.
     *
     * @returns {boolean} true when windows are being parked
     */
    get enabled() {
        return this._enabled;
    }

    /**
     * Turns reassignment off, restoring every window first.
     *
     * @param {string} reason - why, for the log
     */
    disable(reason) {
        if (!this._enabled)
            return;

        this.restoreAll();
        this._enabled = false;
        warn(`per-monitor persistence off — ${reason}`);
    }

    /**
     * Parks one monitor's windows for its current virtual workspace.
     *
     * @param {number} monitorIndex - monitor to bring into line
     * @param {number} [activeIndex] - workspace being displayed; pass explicitly
     *   when the caller has just changed it, rather than relying on read-back
     */
    syncMonitor(monitorIndex, activeIndex) {
        if (!this._enabled || monitorIndex === this._interop.getPrimaryIndex())
            return;

        const count = this._monitorState.getWorkspaceCount();
        const globalIndex = activeIndex ?? this._interop.getActiveWorkspaceIndex();
        const virtualIndex = this._monitorState.getVirtualIndex(monitorIndex);

        const candidates = this._windowTracker.forMonitor(monitorIndex);
        let moved = 0;
        this._windowTracker.suppress(() => {
            for (const [window, record] of candidates) {
                const target = shellFromVirtual(
                    record.virtualWorkspace, virtualIndex, globalIndex, count);

                if (this._interop.getWindowWorkspaceIndex(window) === target)
                    continue;

                this._interop.changeWorkspace(window, target);
                moved++;
            }
        });

        // Logged even when nothing moved: a sync that finds no candidates means
        // the tracker is empty, which looks exactly like the feature being off.
        debug(`monitor ${monitorIndex} showing virtual ` +
            `workspace ${virtualIndex}: parked ${moved} of ${candidates.length} window(s)`);
    }

    /**
     * Brings every secondary monitor into line.
     *
     * Call this after the primary moves GNOME's workspace. Every monitor renders
     * whatever sits on the active workspace, so once it changes, each secondary
     * must be re-parked against the new one or it is dragged along with the
     * primary instead of holding its own position.
     *
     * @param {number} [activeIndex] - the workspace now being displayed
     */
    syncAll(activeIndex) {
        if (!this._enabled)
            return;

        const primary = this._interop.getPrimaryIndex();
        for (const monitorIndex of this._monitorState.getSnapshot().keys()) {
            if (monitorIndex !== primary)
                this.syncMonitor(monitorIndex, activeIndex);
        }
    }

    /**
     * Returns every window to the workspace its record says it belongs to.
     *
     * Called on `disable()`. Without it the rotation would be left in place and
     * windows would sit on workspaces the user never chose.
     */
    restoreAll() {
        const primary = this._interop.getPrimaryIndex();
        let moved = 0;

        this._windowTracker.suppress(() => {
            for (const [window, record] of this._windowTracker.entries()) {
                if (record.monitor === primary)
                    continue;

                if (this._interop.getWindowWorkspaceIndex(window) === record.virtualWorkspace)
                    continue;

                this._interop.changeWorkspace(window, record.virtualWorkspace);
                moved++;
            }
        });

        if (moved)
            debug(`restored ${moved} window(s) to their own workspace`);
    }

    /**
     * Restores every window and stops.
     */
    destroy() {
        this.restoreAll();
        this._interop = null;
        this._monitorState = null;
        this._windowTracker = null;
        this._settings = null;
    }
}
