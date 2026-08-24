/*
 * MacOS Workspaces — per-monitor swipe gesture interception
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';

/** Signals on the SwipeTracker this extension takes over. @type {string[]} */
const SIGNALS = ['begin', 'update', 'end'];

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
 * Everything about the animation itself — staging, anchoring, easing, settling —
 * belongs to `AnimationDriver`, which the keyboard path shares. What is left
 * here is only the gesture: which monitor it began on, and where it let go.
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
     * @param {object} params.driver - the shared `AnimationDriver`
     */
    constructor({interop, driver}) {
        this._interop = interop;
        this._driver = driver;
        this._tracker = interop.getSwipeTracker();
        this._session = null;
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
        this._session = null;
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
        this._session = null;

        // With workspaces confined to the primary monitor there is nothing
        // per-monitor to do, and the Shell itself ignores other monitors here.
        if (this._interop.isWorkspacesOnlyOnPrimary() &&
            monitorIndex !== this._interop.getPrimaryIndex())
            return;

        // Matches the Shell's own `_switchWorkspaceBegin`: a column layout is
        // swiped vertically. `MonitorGroup` reads the same setting for its
        // progress math, so the two cannot disagree.
        tracker.orientation =
            this._interop.orientationFor(this._interop.isHorizontalLayout());

        const session = this._driver.beginSwitch(monitorIndex);
        if (!session)
            return;

        this._session = session;

        const {group} = session;
        const progress = group.progress;
        const closestWs = group.findClosestWorkspace(progress);

        tracker.confirmSwipe(group.baseDistance, group.getSnapPoints(),
            progress, group.getWorkspaceProgress(closestWs));
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
        const session = this._session;
        if (!session || this._driver.session !== session)
            return;

        session.group.updateSwipeForMonitor(progress,
            session.switchData.baseMonitorGroup);
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
        const session = this._session;
        this._session = null;

        if (!session || this._driver.session !== session)
            return;

        const newWs = session.switchData.baseMonitorGroup
            .findClosestWorkspace(endProgress);

        // How far the slide actually travelled, in workspaces. The driver turns
        // that into a virtual index, which is where wrap-around and clamping
        // are decided.
        this._driver.settle(session, newWs.index() - session.originIndex, duration);
    }
}
