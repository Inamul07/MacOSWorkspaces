/*
 * MacOS Workspaces — the shared per-monitor slide animation
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * Owns the slide animation, so a swipe and a keystroke cannot drift apart.
 *
 * Both input paths do the same three things: stage the monitor's windows, point
 * its `MonitorGroup` at where the slide starts, then ease `progress` onto the
 * workspace it settles on. Phases 3-5 grew two copies of that, which had already
 * diverged once — the keyboard path anchored on `V[m]` while the gesture path
 * anchored on the active workspace, and the slide ran backwards whenever the two
 * disagreed. There is one copy now.
 *
 * ## Sessions, and why the anchor is frozen
 *
 * A switch is a *session*: opened by `beginSwitch()`, closed when the ease
 * finishes. The session records where the slide started — both the real
 * workspace index (`originIndex`) and the monitor's virtual one
 * (`originVirtual`) — and every later calculation is measured against those,
 * never against whatever the monitor state says at the time.
 *
 * That matters for interruption. A second swipe arriving mid-settle reuses the
 * actors already on screen, because the clones were built from the staged layout
 * and re-staging now would leave them showing windows that have since moved. The
 * previous `settle()` has already written a new virtual index, so measuring the
 * second swipe against *that* would count the first one twice: staged at 1 with
 * `V=0`, two rightward flicks would land on virtual workspace 3 instead of 2.
 * Freezing the anchor at `beginSwitch()` is what makes rapid switches add up
 * correctly.
 *
 * All Shell access arrives through an injected interop bundle; this module
 * imports nothing from `resource://` or Mutter.
 */
export class AnimationDriver {
    /**
     * @param {object} params - dependencies
     * @param {object} params.interop - from `shellInterop.createInterop()`
     * @param {object} params.monitorState - the `MonitorStateManager`
     * @param {object} params.reassigner - the `WorkspaceReassigner`
     */
    constructor({interop, monitorState, reassigner}) {
        this._interop = interop;
        this._monitorState = monitorState;
        this._reassigner = reassigner;
        this._session = null;
    }

    /**
     * The switch currently in flight, or null.
     *
     * @returns {?object} the live session
     */
    get session() {
        return this._liveSession();
    }

    /**
     * The virtual workspace a monitor is showing right now.
     *
     * The primary is re-anchored from GNOME's active workspace, because it does
     * not have a workspace of its own — it *is* the real one, and something
     * outside this extension may have moved it. A monitor mid-switch keeps the
     * index its session already recorded.
     *
     * @param {number} monitorIndex - zero-based monitor index
     * @returns {number} virtual workspace index
     */
    virtualIndexOf(monitorIndex) {
        if (!this._liveSession() &&
            monitorIndex === this._interop.getPrimaryIndex()) {
            return this._monitorState.setVirtualIndex(monitorIndex,
                this._interop.getActiveWorkspaceIndex());
        }

        return this._monitorState.getVirtualIndex(monitorIndex);
    }

    /**
     * Opens a switch on one monitor, staging its windows and building the actors.
     *
     * @param {number} monitorIndex - monitor about to move
     * @returns {?object} the session, or null when the switch cannot start
     */
    beginSwitch(monitorIndex) {
        const interop = this._interop;
        const live = this._liveSession();

        if (live?.monitor === monitorIndex) {
            // Reuse what is already on screen. Re-staging would move windows the
            // clones were built from, so the slide would finish showing an
            // arrangement that no longer exists.
            for (const group of live.switchData.monitors)
                group.remove_all_transitions();
            return live;
        }

        // A different monitor is mid-settle. Its clones cover it and its windows
        // are staged, so close it out rather than interleaving two switches
        // through one shared `_switchData`.
        if (live)
            this._finishSession(live, {snap: true});

        const isPrimary = monitorIndex === interop.getPrimaryIndex();
        const originVirtual = this.virtualIndexOf(monitorIndex);

        // Staging must happen before the clones are built: they capture wherever
        // the windows are at that moment, and this is the arrangement they must
        // show. Both run in the same callback, so no frame is drawn in between
        // and the rearrangement is never visible.
        const originIndex = isPrimary
            ? interop.getActiveWorkspaceIndex()
            : this._reassigner?.stageMonitor(monitorIndex) ??
              interop.getActiveWorkspaceIndex();

        interop.prepareWorkspaceSwitch();

        const switchData = interop.getSwitchData();
        if (!switchData) {
            console.warn('[macos-workspaces] no switch data — cannot animate');
            // Staging already moved the windows. Bailing out without undoing it
            // would leave them parked on the staging workspaces with nothing on
            // screen to explain where they went.
            this._reassigner?.syncMonitor(monitorIndex);
            return null;
        }

        const group = interop.findMonitorGroup(monitorIndex);
        if (!group) {
            console.warn(`[macos-workspaces] no monitor group for ${monitorIndex}`);
            interop.finishWorkspaceSwitch(switchData);
            this._reassigner?.syncMonitor(monitorIndex);
            return null;
        }

        // The base group anchors the progress math for the whole switch.
        switchData.baseMonitorGroup = group;

        // Pin where the slide starts, the way the Shell's own animateSwitch
        // does, so the direction never depends on whatever the group happened to
        // be initialised to. For a secondary that is the staging centre, which
        // always has a neighbour on both sides.
        const originWs = interop.getWorkspaceByIndex(originIndex);
        if (originWs)
            group.progress = group.getWorkspaceProgress(originWs);

        this._session = {
            monitor: monitorIndex,
            isPrimary,
            group,
            switchData,
            originIndex,
            originVirtual,
            targetWs: null,
            settledIndex: originIndex,
            closed: false,
        };

        return this._session;
    }

    /**
     * Converts a real workspace index the slide landed on into a virtual one.
     *
     * @param {object} session - from `beginSwitch()`
     * @param {number} shellIndex - real workspace index
     * @returns {number} the virtual workspace index it corresponds to
     */
    virtualFor(session, shellIndex) {
        return session.originVirtual + (shellIndex - session.originIndex);
    }

    /**
     * Eases the monitor onto a workspace and settles the Shell's state.
     *
     * @param {object} session - from `beginSwitch()`
     * @param {number} virtualIndex - virtual workspace to settle on
     * @param {number} [duration] - animation length in ms
     * @returns {number} the virtual index actually recorded, after clamping
     */
    settle(session, virtualIndex, duration) {
        if (session.closed || this._session !== session)
            return this._monitorState.getVirtualIndex(session.monitor);

        const interop = this._interop;
        const recorded = this._monitorState.setVirtualIndex(session.monitor, virtualIndex);

        // Settle on the workspace matching the index actually recorded; the two
        // differ when the virtual index was clamped at either end.
        const shellIndex = session.originIndex + (recorded - session.originVirtual);
        const targetWs = interop.getWorkspaceByIndex(shellIndex);
        if (!targetWs) {
            this._finishSession(session, {snap: false});
            return recorded;
        }

        session.targetWs = targetWs;
        session.settledIndex = shellIndex;

        // Marking the switch activated makes the Shell's own `_shouldAnimate()`
        // return false, so activating the workspace below cannot start a second
        // animation across every monitor.
        session.switchData.gestureActivated = true;

        console.log(`[macos-workspaces] monitor ${session.monitor} -> workspace ` +
            `${recorded}${session.isPrimary ? ' (primary, activating globally)' : ''}`);

        session.group.ease_property('progress',
            session.group.getWorkspaceProgress(targetWs), {
                duration: duration ?? interop.switchDuration,
                mode: interop.easeOutCubic,
                // `onStopped` rather than `onComplete`: the latter fires only on
                // a natural finish (environment.js:61-66), and the Shell tears a
                // gesture-activated switch down outright when the Overview opens
                // (workspaceAnimation.js:322), destroying the groups mid-ease.
                // Settling from here means the windows are un-staged either way
                // instead of being stranded on the staging workspaces.
                onStopped: isFinished => {
                    if (isFinished || !this._isCurrent(session))
                        this._finishSession(session, {snap: false});
                },
            });

        return recorded;
    }

    /**
     * Closes any switch still in flight, then stops.
     */
    destroy() {
        const live = this._liveSession();
        if (live)
            this._finishSession(live, {snap: true});

        this._session = null;
        this._interop = null;
        this._monitorState = null;
        this._reassigner = null;
    }

    /**
     * Whether a session is still the one this driver is running.
     *
     * @param {object} session - session to test
     * @returns {boolean} true when it is current and its actors still exist
     * @private
     */
    _isCurrent(session) {
        return this._session === session && !session.closed &&
            this._interop.getSwitchData() === session.switchData;
    }

    /**
     * The session in flight, dropping it if the Shell tore the switch down.
     *
     * @returns {?object} the live session
     * @private
     */
    _liveSession() {
        const session = this._session;
        if (!session)
            return null;

        if (this._isCurrent(session))
            return session;

        // The Shell discarded the switch without telling us. The ease's
        // `onStopped` settles the windows; all that is left here is to stop
        // handing out a session whose actors are gone.
        this._session = null;
        return null;
    }

    /**
     * Puts the windows back where they belong and tears the switch down.
     *
     * Idempotent: the Overview can destroy the actors at the same moment the
     * ease ends, so this runs at most once per session.
     *
     * @param {object} session - session to close
     * @param {object} params - options
     * @param {boolean} params.snap - jump to the settle position first
     * @private
     */
    _finishSession(session, {snap}) {
        if (session.closed)
            return;
        session.closed = true;

        const interop = this._interop;
        const stillOurs = interop.getSwitchData() === session.switchData;

        if (snap && stillOurs && session.targetWs) {
            session.group.remove_all_transitions();
            session.group.progress = session.group.getWorkspaceProgress(session.targetWs);
        }

        if (session.isPrimary) {
            if (session.targetWs && !session.targetWs.active)
                session.targetWs.activate(interop.currentEventTime());

            // The displayed workspace just moved, so every secondary has to be
            // re-parked against it — otherwise each is still parked relative to
            // the old one and gets dragged along with the primary.
            this._reassigner?.syncAll(session.settledIndex);
        } else {
            // Park back to rest before the clones are torn down, so what is
            // revealed underneath is already correct.
            this._reassigner?.syncMonitor(session.monitor);
        }

        // Only ours to destroy if the Shell has not already done it.
        if (stillOurs)
            interop.finishWorkspaceSwitch(session.switchData);

        if (this._session === session)
            this._session = null;
    }
}
