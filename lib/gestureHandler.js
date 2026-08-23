/*
 * MacOS Workspaces — per-monitor swipe gesture interception
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';

/** Signals on the SwipeTracker this extension takes over. @type {string[]} */
const SIGNALS = ['begin', 'update', 'end'];

/** Sentinel for "no gesture in progress". @type {number} */
const NO_MONITOR = -1;

/**
 * Reroutes workspace swipe gestures so they affect only one monitor.
 *
 * The Shell connects its SwipeTracker to `.bind(this)` copies of its handlers
 * in the WorkspaceAnimationController constructor, so reassigning those methods
 * cannot intercept anything — the tracker keeps the original function forever.
 * This class therefore disconnects the Shell's handlers and installs its own,
 * leaving the controller's methods untouched so `destroy()` can reconnect them
 * verbatim.
 *
 * All Shell access arrives through an injected interop bundle; this module
 * imports nothing from `resource://` or Mutter.
 */
export class GestureHandler {
    /**
     * Takes over the swipe tracker.
     *
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     * @param {object} params.reassigner - the `WorkspaceReassigner`
     */
    constructor({interop, monitorState, reassigner}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._reassigner = reassigner;
        this._tracker = interop.getSwipeTracker();
        this._activeMonitor = NO_MONITOR;
        this._stagedAt = 0;
        this._handlerIds = [];

        this._takeOver();
    }

    /**
     * Restores the Shell's own gesture handling.
     *
     * Safe to call more than once.
     */
    destroy() {
        if (!this._tracker)
            return;

        for (const id of this._handlerIds)
            this._tracker.disconnect(id);
        this._handlerIds = [];

        // The controller's methods were never modified, so rebinding them
        // restores stock behaviour exactly.
        const wac = this._interop.getWorkspaceAnimation();
        if (wac) {
            this._tracker.connect('begin', wac._switchWorkspaceBegin.bind(wac));
            this._tracker.connect('update', wac._switchWorkspaceUpdate.bind(wac));
            this._tracker.connect('end', wac._switchWorkspaceEnd.bind(wac));
        } else {
            console.error(
                '[macos-workspaces] cannot restore gesture handlers — controller gone');
        }

        this._tracker = null;
        this._activeMonitor = NO_MONITOR;
        console.log('[macos-workspaces] gesture handlers restored');
    }

    /**
     * Disconnects the Shell's handlers and installs ours.
     *
     * @private
     */
    _takeOver() {
        if (!this._tracker) {
            console.error('[macos-workspaces] no swipe tracker — gestures not intercepted');
            return;
        }

        for (const name of SIGNALS) {
            const removed = this._disconnectSignal(name);

            // A silent no-op is the dangerous failure here: the extension would
            // load, log nothing unusual, and never intercept a gesture. Anything
            // other than exactly one stock handler means the Shell was rewired
            // or another extension got here first.
            if (removed !== 1) {
                console.warn(`[macos-workspaces] expected 1 '${name}' handler on the ` +
                    `swipe tracker, found ${removed} — another extension may conflict`);
            }
        }

        this._handlerIds = [
            this._tracker.connect('begin', this._onBegin.bind(this)),
            this._tracker.connect('update', this._onUpdate.bind(this)),
            this._tracker.connect('end', this._onEnd.bind(this)),
        ];

        console.log('[macos-workspaces] swipe tracker taken over');
    }

    /**
     * Removes every handler attached to one signal on the tracker.
     *
     * The Shell never stored its handler ids, so they can only be matched by
     * signal rather than by function.
     *
     * @param {string} name - signal name
     * @returns {number} how many handlers were removed
     * @private
     */
    _disconnectSignal(name) {
        const signalId = GObject.signal_lookup(name, this._tracker.constructor.$gtype);
        if (!signalId) {
            console.warn(`[macos-workspaces] swipe tracker has no '${name}' signal`);
            return 0;
        }

        return GObject.signal_handlers_disconnect_matched(
            this._tracker, GObject.SignalMatchType.ID, signalId, 0, null, null, null);
    }

    /**
     * Starts a gesture, scoping it to the monitor it began on.
     *
     * @param {object} tracker - the SwipeTracker
     * @param {number} monitorIndex - monitor the gesture started on
     * @private
     */
    _onBegin(tracker, monitorIndex) {
        // With workspaces confined to the primary monitor there is nothing
        // per-monitor to do, and the Shell itself ignores other monitors here.
        if (this._interop.isWorkspacesOnlyOnPrimary() &&
            monitorIndex !== this._interop.getPrimaryIndex())
            return;

        tracker.orientation =
            this._interop.orientationFor(this._interop.isHorizontalLayout());

        const existing = this._interop.getSwitchData();
        if (existing?.gestureActivated) {
            // An interrupting gesture reuses the groups already on screen; the
            // clones were built from the staged layout, so leave it alone.
            for (const group of existing.monitors)
                group.remove_all_transitions();
        } else {
            // Stage BEFORE the Shell builds its clones — they capture wherever
            // the windows are at that moment, and this is the arrangement they
            // must show. Both happen in one callback, so no frame is drawn in
            // between and the rearrangement is never visible.
            this._stagedAt = this._reassigner?.stageMonitor(monitorIndex) ??
                this._interop.getActiveWorkspaceIndex();
            this._interop.prepareWorkspaceSwitch();
        }

        const monitorGroup = this._interop.findMonitorGroup(monitorIndex);
        if (!monitorGroup) {
            console.warn(`[macos-workspaces] no monitor group for ${monitorIndex}`);
            return;
        }

        this._activeMonitor = monitorIndex;

        // Point the group at the staged centre, which always has a neighbour on
        // both sides — that is what allows a leftward slide from workspace 1.
        const stagedWs = this._interop.getWorkspaceByIndex(this._stagedAt);
        if (stagedWs)
            monitorGroup.progress = monitorGroup.getWorkspaceProgress(stagedWs);

        const progress = monitorGroup.progress;
        const closestWs = monitorGroup.findClosestWorkspace(progress);

        // The base group anchors the progress math for the whole gesture.
        const switchData = this._interop.getSwitchData();
        if (switchData)
            switchData.baseMonitorGroup = monitorGroup;

        tracker.confirmSwipe(monitorGroup.baseDistance, monitorGroup.getSnapPoints(),
            progress, monitorGroup.getWorkspaceProgress(closestWs));
    }

    /**
     * Advances the gesture on the active monitor only.
     *
     * The Shell's own handler loops over every monitor group here; driving just
     * one is what leaves the other displays frozen.
     *
     * @param {object} tracker - the SwipeTracker
     * @param {number} progress - gesture progress
     * @private
     */
    _onUpdate(tracker, progress) {
        const switchData = this._interop.getSwitchData();
        if (!switchData || this._activeMonitor === NO_MONITOR)
            return;

        const monitorGroup = this._interop.findMonitorGroup(this._activeMonitor);
        monitorGroup?.updateSwipeForMonitor(progress, switchData.baseMonitorGroup);
    }

    /**
     * Settles the gesture and records the monitor's new virtual workspace.
     *
     * @param {object} tracker - the SwipeTracker
     * @param {number} duration - animation duration in ms
     * @param {number} endProgress - progress to settle on
     * @private
     */
    _onEnd(tracker, duration, endProgress) {
        const switchData = this._interop.getSwitchData();
        if (!switchData || this._activeMonitor === NO_MONITOR)
            return;

        switchData.gestureActivated = true;

        const monitor = this._activeMonitor;
        this._activeMonitor = NO_MONITOR;

        const newWs = switchData.baseMonitorGroup.findClosestWorkspace(endProgress);
        const monitorGroup = this._interop.findMonitorGroup(monitor);
        if (!monitorGroup) {
            this._interop.finishWorkspaceSwitch(switchData);
            return;
        }

        const isPrimary = monitor === this._interop.getPrimaryIndex();
        const endTime = this._interop.currentEventTime();

        // The primary is untouched by persistence: it drives GNOME's real
        // workspace exactly as the Shell does, so the index it lands on IS its
        // workspace. A secondary slid relative to the staged centre instead.
        const origin = isPrimary
            ? this._interop.getActiveWorkspaceIndex()
            : this._stagedAt;
        const wasVirtual = this._monitorState.getVirtualIndex(monitor);
        const newVirtual = this._monitorState.setVirtualIndex(monitor,
            wasVirtual + (newWs.index() - origin));

        // Settle on the workspace matching the index actually recorded; the two
        // differ when the virtual index was clamped at either end.
        const settleWs =
            this._interop.getWorkspaceByIndex(origin + (newVirtual - wasVirtual)) ?? newWs;

        console.log(`[macos-workspaces] monitor ${monitor} -> workspace ` +
            `${newVirtual}${isPrimary ? ' (primary, activating globally)' : ''}`);

        monitorGroup.ease_property('progress',
            monitorGroup.getWorkspaceProgress(settleWs), {
                duration,
                mode: this._interop.easeOutCubic,
                onComplete: () => {
                    if (isPrimary) {
                        if (!settleWs.active)
                            settleWs.activate(endTime);
                        // The displayed workspace just moved, so every secondary
                        // must be re-parked against it or it follows the primary.
                        this._reassigner?.syncAll(settleWs.index());
                    } else {
                        // Park back to rest before the clones are torn down, so
                        // what is revealed underneath is already correct.
                        this._reassigner?.syncMonitor(monitor);
                    }
                    this._interop.finishWorkspaceSwitch(switchData);
                },
            });
    }
}
