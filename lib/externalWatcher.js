/*
 * MacOS Workspaces — reconciling with changes the extension did not cause
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {debug, warn} from './log.js';

/** Extensions known to fight this one over the same windows. @type {Map<string, string>} */
const CONFLICTS = new Map([
    ['smart-workspace-manager@local',
        'it moves windows between workspaces to give each monitor its own, ' +
        'which is the same job as this extension'],
]);

/**
 * Which of the given extensions do the same job as this one.
 *
 * Separate from the reporting so it can be tested: GJS makes `console.warn`
 * non-configurable, so a test cannot capture what was logged.
 *
 * @param {string[]} uuids - enabled extension UUIDs
 * @returns {Array<[string, string]>} [uuid, why it conflicts] pairs
 */
export function findConflicts(uuids) {
    return uuids
        .filter(uuid => CONFLICTS.has(uuid))
        .map(uuid => [uuid, CONFLICTS.get(uuid)]);
}

/**
 * Keeps the extension's model honest when the world changes underneath it.
 *
 * Interception covers the swipe and the four directional shortcuts. Everything
 * else that can move GNOME's workspace does not go through us at all: an
 * Overview thumbnail click, a notification pulling focus, `wmctrl -s`,
 * `switch-to-workspace-1` through `-12`, another extension, or any path a future
 * GNOME adds. Without reconciliation each of those leaves every secondary
 * monitor showing the wrong workspace *and* leaves the recorded index disagreeing
 * with the screen — after which every later switch computes from a wrong
 * baseline and compounds the error, which is how windows end up parked on
 * workspaces the user cannot reach.
 *
 * ## Why there is no suppression flag
 *
 * The obvious design ignores workspace changes the extension caused, which needs
 * a flag held across an asynchronous animation and is a re-entrancy bug waiting
 * to happen. This compares instead: the primary monitor's recorded index is what
 * the extension believes the real workspace to be, so a change that **agrees**
 * with it came from us and needs nothing, and a change that **disagrees** came
 * from somewhere else. Self-correcting, and it cannot loop.
 *
 * All Shell access arrives through an injected interop bundle; this module
 * imports nothing from `resource://` or Mutter.
 */
export class ExternalChangeWatcher {
    /**
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     * @param {object} params.windowTracker - the `WindowTracker`
     * @param {object} params.reassigner - the `WorkspaceReassigner`
     * @param {object} params.driver - the shared `AnimationDriver`
     */
    constructor({interop, monitorState, windowTracker, reassigner, driver}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._windowTracker = windowTracker;
        this._reassigner = reassigner;
        this._driver = driver;

        this._workspaceManager = interop.workspaceManager;
        this._layoutManager = interop.layoutManager;

        this._activeId = this._workspaceManager.connect(
            'notify::active-workspace', () => this._onActiveWorkspaceChanged());
        this._countId = this._workspaceManager.connect(
            'notify::n-workspaces', () => this._onWorkspaceCountChanged());
        this._monitorsId = this._layoutManager.connect(
            'monitors-changed', () => this._onMonitorsChanged());

        this._unwatchPreferences = interop.watchPreferences(key => this._onPreference(key));

        this._deferredId = 0;

        /** @type {Array<[string, string]>} conflicting extensions found at startup */
        this.conflicts = [];
        this._warnAboutConflicts();
    }

    /**
     * Stops watching.
     */
    destroy() {
        if (this._activeId) {
            this._workspaceManager.disconnect(this._activeId);
            this._activeId = 0;
        }
        if (this._countId) {
            this._workspaceManager.disconnect(this._countId);
            this._countId = 0;
        }
        if (this._monitorsId) {
            this._layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }

        this._unwatchPreferences?.();
        this._unwatchPreferences = null;

        this._interop.cancelDeferred(this._deferredId);
        this._deferredId = 0;

        this._workspaceManager = null;
        this._layoutManager = null;
        debug('external change watcher stopped');
    }

    /**
     * Warns when an extension doing the same job is also enabled.
     *
     * Two extensions moving the same windows corrupt each other's model, and the
     * symptom — windows on the wrong workspace, exceptions from deep inside the
     * Shell — looks like a bug in whichever one the user suspects first.
     *
     * @private
     */
    _warnAboutConflicts() {
        let enabled;
        try {
            enabled = this._interop.getEnabledExtensions();
        } catch {
            // Not being able to read the extension list is no reason to refuse
            // to run; the conflict warning is advice, not a guard.
            return;
        }

        this.conflicts = findConflicts(enabled);

        for (const [uuid, reason] of this.conflicts) {
            warn(`'${uuid}' is also enabled and ${reason}. ` +
                'Running both will move windows to workspaces neither expects. ' +
                'Disable one of them.');
        }
    }

    /**
     * Reconciles after GNOME's active workspace changed.
     *
     * @private
     */
    _onActiveWorkspaceChanged() {
        if (!this._reassigner?.enabled)
            return;

        // Our own switch is still animating; its settle does this reconciliation
        // itself, with the index it is about to land on.
        if (this._driver?.session)
            return;

        const primary = this._interop.getPrimaryIndex();
        const actual = this._interop.getActiveWorkspaceIndex();
        const believed = this._monitorState.getVirtualIndex(primary);

        // Agreeing means the change was ours. Only a disagreement is news.
        if (actual === believed)
            return;

        debug('workspace changed to ' +
            `${actual} without us (expected ${believed}) — re-anchoring`);

        this._monitorState.setVirtualIndex(primary, actual);
        this._reassigner.syncAll(actual);
    }

    /**
     * Re-evaluates whether persistence can still run after a count change.
     *
     * @private
     */
    _onWorkspaceCountChanged() {
        if (!this._reassigner?.enabled)
            return;

        if (!this._reassigner.hasRoom()) {
            this._reassigner.disable(
                'there are no longer at least 4 workspaces. Every window has been ' +
                'put back. Gestures and shortcuts still work.');
            return;
        }

        // Surviving indices may have been clamped by `MonitorStateManager`, so
        // what each monitor shows has to be brought back into line with them.
        this._reassigner.syncAll(this._interop.getActiveWorkspaceIndex());
    }

    /**
     * Rebuilds window attribution after a display was plugged or unplugged.
     *
     * @private
     */
    _onMonitorsChanged() {
        if (!this._reassigner?.enabled)
            return;

        // Deferred for two reasons. Mutter emits this several times as it
        // settles a display change, and rebuilding once at the end is both
        // cheaper and less likely to catch a half-applied layout. Whether
        // windows have already been moved off a departing display by the time
        // this fires is not something the Shell promises — on this hardware they
        // had been, but an idle tick later costs nothing and does not depend on
        // it. A window that maps to no monitor is dropped, and `retrackAll()`
        // reports it, so the assumption is at least observable if it breaks.
        this._interop.cancelDeferred(this._deferredId);
        this._deferredId = this._interop.defer(() => {
            this._deferredId = 0;
            this._rebuildAfterMonitorChange();
        });
    }

    /**
     * Re-attributes windows and resets every display, once the Shell has settled.
     *
     * @private
     */
    _rebuildAfterMonitorChange() {
        if (!this._reassigner?.enabled)
            return;

        // Monitor indices are positional, so the records now name the wrong
        // displays. Nothing can be synced until they are rebuilt.
        this._windowTracker.retrackAll();

        // Every monitor is showing whatever is on the active workspace right
        // now, so that is the only honest starting point for all of them.
        const active = this._interop.getActiveWorkspaceIndex();
        for (const monitorIndex of this._monitorState.getSnapshot().keys())
            this._monitorState.setVirtualIndex(monitorIndex, active);

        debug('monitors changed — every display reset to ' +
            `workspace ${active}`);
    }

    /**
     * Turns persistence off when a mutter preference makes it unsafe.
     *
     * @param {string} key - the preference that changed
     * @private
     */
    _onPreference(key) {
        if (!this._reassigner?.enabled)
            return;

        if (key === 'dynamic-workspaces' && this._interop.isDynamicWorkspaces()) {
            this._reassigner.disable(
                'dynamic workspaces were turned on. They are created and destroyed ' +
                'as you use them, which would strand windows on workspaces you ' +
                'cannot reach. Every window has been put back.');
            return;
        }

        if (key === 'workspaces-only-on-primary' &&
            this._interop.isWorkspacesOnlyOnPrimary()) {
            this._reassigner.disable(
                'workspaces were confined to the primary monitor, so the other ' +
                'displays no longer have workspaces to keep. Every window has ' +
                'been put back.');
        }
    }
}
