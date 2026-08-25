/*
 * MacOS Workspaces — animation driver tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {AnimationDriver} from '../lib/animationDriver.js';
import {suite} from './harness.js';

const {check, section} = suite('animation driver');

const COUNT = 4;

/** A world: fake workspaces, monitor groups and a switch, rebuilt per scenario. */
function makeWorld({primary = 0, virtual = new Map([[0, 0], [1, 0]]), active = 0,
    settings = null} = {}) {
    const workspaces = new Map();
    const workspaceAt = i => {
        if (i < 0 || i >= COUNT)
            return null;
        if (!workspaces.has(i)) {
            workspaces.set(i, {
                index: () => i,
                get active() { return world.active === i; },
                activate(t) { world.activated.push([i, t]); world.active = i; },
            });
        }
        return workspaces.get(i);
    };

    const makeGroup = index => ({
        index,
        progress: null,
        eased: null,
        cleared: 0,
        destroyed: false,
        baseDistance: 100,
        getSnapPoints: () => [0, 1, 2, 3],
        // Progress is the workspace index in this world, which keeps the
        // assertions readable — the real MonitorGroup's mapping is its own.
        getWorkspaceProgress: ws => ws.index(),
        findClosestWorkspace: p => workspaceAt(Math.round(p)),
        updateSwipeForMonitor(p) { this.progress = p; },
        ease_property(prop, target, params) { this.eased = {prop, target, params}; },
        remove_all_transitions() {
            this.cleared++;
            // Clutter stops the transition, so the callback fires with
            // isFinished false — exactly what the real one does.
            const e = this.eased;
            this.eased = null;
            e?.params.onStopped?.(false);
        },
    });

    const groups = {0: makeGroup(0), 1: makeGroup(1)};
    let switchData = null;

    const world = {
        active,
        activated: [],
        finished: [],
        staged: [],
        synced: [],
        syncedAll: [],
        groups,
        workspaceAt,
        get switchData() { return switchData; },

        /** Simulates the Overview tearing the switch down mid-ease. */
        shellTearsDown() {
            const doomed = switchData;
            switchData = null;
            for (const g of Object.values(groups)) {
                g.destroyed = true;
                const e = g.eased;
                g.eased = null;
                e?.params.onStopped?.(false);
            }
            return doomed;
        },
    };

    const interop = {
        getPrimaryIndex: () => primary,
        getActiveWorkspaceIndex: () => world.active,
        getWorkspaceByIndex: workspaceAt,
        findMonitorGroup: i => (switchData ? groups[i] ?? null : null),
        prepareWorkspaceSwitch: () => {
            switchData ??= {monitors: Object.values(groups), gestureActivated: false};
        },
        getSwitchData: () => switchData,
        finishWorkspaceSwitch: d => { world.finished.push(d); switchData = null; },
        currentEventTime: () => 4242,
        easeOutCubic: 'EASE_OUT_CUBIC',
        switchDuration: 250,
    };

    const monitorState = {
        virtual: new Map(virtual),
        getWorkspaceCount: () => COUNT,
        getVirtualIndex(m) { return this.virtual.get(m) ?? 0; },
        clampIndex: i => Math.min(Math.max(i, 0), COUNT - 1),
        wrapIndex: i => ((i % COUNT) + COUNT) % COUNT,
        setVirtualIndex(m, w) {
            const c = this.clampIndex(w);
            this.virtual.set(m, c);
            return c;
        },
    };

    const reassigner = {
        stageMonitor(m) { world.staged.push(m); return 1; },
        syncMonitor(m, a) { world.synced.push([m, a]); },
        syncAll(a) { world.syncedAll.push(a); },
    };

    world.interop = interop;
    world.monitorState = monitorState;
    world.driver = new AnimationDriver({interop, monitorState, reassigner, settings});
    return world;
}

section('a secondary monitor slides around the staging centre');
{
    const w = makeWorld();
    const s = w.driver.beginSwitch(1);
    check('the monitor was staged before the clones were built',
        JSON.stringify(w.staged) === '[1]', JSON.stringify(w.staged));
    check('the group starts pinned to the staging centre, not the active workspace',
        w.groups[1].progress === 1, `(got ${w.groups[1].progress})`);
    check('the anchor records both the real and the virtual origin',
        s.originIndex === 1 && s.originVirtual === 0);

    // One step right from the staging centre lands on real workspace 2.
    const recorded = w.driver.settle(s, 1, 250);
    check('virtual index is one step on, not the real index it slid onto',
        recorded === 1, `(got ${recorded})`);
    check('eased with the Shell curve and duration',
        w.groups[1].eased.params.mode === 'EASE_OUT_CUBIC' &&
        w.groups[1].eased.params.duration === 250);
    check('the frozen monitor was never eased', w.groups[0].eased === null);

    w.groups[1].eased.params.onStopped(true);
    check('no workspace was activated', w.activated.length === 0,
        JSON.stringify(w.activated));
    check('the monitor was parked back to rest',
        JSON.stringify(w.synced) === '[[1,null]]', JSON.stringify(w.synced));
    check('the switch was torn down once', w.finished.length === 1);
    check('the session is closed', w.driver.session === null);
}

section('the primary drives the real workspace and drags nobody');
{
    const w = makeWorld();
    const s = w.driver.beginSwitch(0);
    check('the primary is never staged', w.staged.length === 0);
    check('the primary anchors on the active workspace', s.originIndex === 0);

    w.driver.settle(s, 1, 250);
    w.groups[0].eased.params.onStopped(true);

    check('the real workspace was activated',
        JSON.stringify(w.activated) === '[[1,4242]]', JSON.stringify(w.activated));
    check('every secondary was re-parked against the NEW workspace',
        JSON.stringify(w.syncedAll) === '[1]', JSON.stringify(w.syncedAll));
    check('the index was passed explicitly, not read back after activate()',
        w.syncedAll[0] === 1);
    check('the primary itself was not re-parked', w.synced.length === 0);
}

section('an interrupted switch does not count itself twice');
{
    const w = makeWorld();
    const first = w.driver.beginSwitch(1);
    w.driver.settle(first, 1, 250);
    check('first switch recorded virtual workspace 1',
        w.monitorState.getVirtualIndex(1) === 1);

    // Second gesture arrives mid-settle, on the same monitor.
    const second = w.driver.beginSwitch(1);
    check('the same session is reused', second === first);
    check('the running ease was stopped', w.groups[1].cleared === 1);
    check('the monitor was NOT staged again', w.staged.length === 1,
        JSON.stringify(w.staged));
    check('the anchor is still the original one',
        second.originIndex === 1 && second.originVirtual === 0);

    const recorded = w.driver.settle(second, 2, 250);
    check('two steps from the anchor is virtual workspace 2, not 3',
        recorded === 2, `(got ${recorded})`);
}

section('switching monitors mid-settle closes the first one out');
{
    const w = makeWorld();
    const first = w.driver.beginSwitch(1);
    w.driver.settle(first, 1, 250);

    const second = w.driver.beginSwitch(0);
    check('a fresh session was opened for the other monitor', second !== first &&
        second?.monitor === 0);
    check('the first monitor was parked back before the new switch',
        w.synced.some(([m]) => m === 1), JSON.stringify(w.synced));
    check('the first switch was torn down', w.finished.length === 1);
}

section('the Shell tearing the switch down cannot strand staged windows');
{
    const w = makeWorld();
    const s = w.driver.beginSwitch(1);
    w.driver.settle(s, 1, 250);

    // What Main.overview 'showing' does to a gesture-activated switch.
    w.shellTearsDown();

    check('the windows were still parked back to rest',
        JSON.stringify(w.synced) === '[[1,null]]', JSON.stringify(w.synced));
    check('we did not try to destroy actors the Shell already destroyed',
        w.finished.length === 0, JSON.stringify(w.finished.length));
    check('the session was dropped', w.driver.session === null);
}

section('settling past the end of the strip');
{
    const w = makeWorld({virtual: new Map([[0, 0], [1, 3]])});
    const s = w.driver.beginSwitch(1);
    const recorded = w.driver.settle(s, 1, 250);
    check('the virtual index is clamped to the last workspace', recorded === 3,
        `(got ${recorded})`);
    check('and it settles on the workspace matching that clamp, not the one asked for',
        w.groups[1].eased.target === 1, `(got ${w.groups[1].eased.target})`);
}

section('disable() closes a switch still in flight');
{
    const w = makeWorld();
    const s = w.driver.beginSwitch(1);
    w.driver.settle(s, 1, 250);
    w.driver.destroy();
    check('the windows were un-staged', w.synced.length === 1, JSON.stringify(w.synced));
    check('the switch was torn down', w.finished.length === 1);
    check('the group was snapped to where it was heading',
        w.groups[1].progress === 2, `(got ${w.groups[1].progress})`);
}

section('no switch data means no session, and no half-built state');
{
    const w = makeWorld();
    w.interop.prepareWorkspaceSwitch = () => {};
    check('beginSwitch returns null rather than throwing',
        w.driver.beginSwitch(1) === null);
    check('and leaves nothing in flight', w.driver.session === null);
    check('the staged windows were put back rather than stranded',
        JSON.stringify(w.synced) === '[[1,null]]', JSON.stringify(w.synced));
}

section('wrap-around carries a secondary past the end');
{
    const w = makeWorld({virtual: new Map([[0, 0], [1, 3]]),
        settings: {wrapAround: true, durationFor: d => d ?? 250}});
    const s = w.driver.beginSwitch(1);
    const recorded = w.driver.settle(s, 1, 250);
    check('one step past the last workspace is the first', recorded === 0,
        `(got ${recorded})`);
    check('and the slide is still a single step from the staging centre',
        w.groups[1].eased.target === 2, `(got ${w.groups[1].eased.target})`);
}
{
    const w = makeWorld({virtual: new Map([[0, 0], [1, 0]]),
        settings: {wrapAround: true, durationFor: d => d ?? 250}});
    const s = w.driver.beginSwitch(1);
    const recorded = w.driver.settle(s, -1, 250);
    check('one step before the first workspace is the last', recorded === 3,
        `(got ${recorded})`);
    check('sliding left, one step from the staging centre',
        w.groups[1].eased.target === 0, `(got ${w.groups[1].eased.target})`);
}

section('the primary never wraps, whatever the setting says');
{
    const w = makeWorld({active: 3, virtual: new Map([[0, 3], [1, 0]]),
        settings: {wrapAround: true, durationFor: d => d ?? 250}});
    const s = w.driver.beginSwitch(0);
    const recorded = w.driver.settle(s, 1, 250);
    check('it clamps at the last workspace', recorded === 3, `(got ${recorded})`);
    check('and the slide returns to where it started',
        w.groups[0].eased.target === 3, `(got ${w.groups[0].eased.target})`);
    w.groups[0].eased.params.onStopped(true);
    check('nothing was activated, because nothing moved',
        w.activated.length === 0, JSON.stringify(w.activated));
}

section('the duration preference reaches both paths');
{
    const w = makeWorld({settings: {wrapAround: false,
        durationFor: d => (d === undefined ? 400 : Math.round(d * 400 / 250))}});
    const s = w.driver.beginSwitch(1);
    w.driver.settle(s, 1);
    check('a keystroke uses the configured duration outright',
        w.groups[1].eased.params.duration === 400,
        `(got ${w.groups[1].eased.params.duration})`);
}
{
    const w = makeWorld({settings: {wrapAround: false,
        durationFor: d => (d === undefined ? 400 : Math.round(d * 400 / 250))}});
    const s = w.driver.beginSwitch(1);
    w.driver.settle(s, 1, 120);
    check('a swipe keeps its velocity, scaled by the preference',
        w.groups[1].eased.params.duration === 192,
        `(got ${w.groups[1].eased.params.duration})`);
}

