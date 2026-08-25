/*
 * MacOS Workspaces — swipe gesture handler tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import {AnimationDriver} from '../lib/animationDriver.js';
import {GestureHandler} from '../lib/gestureHandler.js';
import {suite} from './harness.js';

const {check, section} = suite('swipe gesture handler');

// A stand-in SwipeTracker with the same three signals.
const FakeTracker = GObject.registerClass({
    Signals: {
        'begin': {param_types: [GObject.TYPE_INT]},
        'update': {param_types: [GObject.TYPE_DOUBLE]},
        'end': {param_types: [GObject.TYPE_INT, GObject.TYPE_DOUBLE]},
    },
}, class FakeTracker extends GObject.Object {
    confirmSwipe(...args) { this.confirmed = args; }
});

const COUNT = 4;
const workspaces = new Map();
let activeIndex = 0;
const workspaceAt = i => {
    if (i < 0 || i >= COUNT)
        return null;
    if (!workspaces.has(i)) {
        workspaces.set(i, {
            index: () => i,
            get active() { return activeIndex === i; },
            activate(t) { activated.push([i, t]); activeIndex = i; },
        });
    }
    return workspaces.get(i);
};
const activated = [];

function makeGroup(index) {
    return {
        index,
        progress: null,
        updated: [],
        eased: null,
        baseDistance: 100,
        getSnapPoints: () => [0, 1, 2, 3],
        findClosestWorkspace: p => workspaceAt(Math.round(p)),
        getWorkspaceProgress: ws => ws.index(),
        updateSwipeForMonitor(p) { this.updated.push(p); },
        ease_property(prop, target, params) { this.eased = {prop, target, params}; },
        remove_all_transitions() { this.eased?.params.onStopped?.(false); this.eased = null; },
    };
}

const groups = {0: makeGroup(0), 1: makeGroup(1)};
let switchData = null;
const finished = [];

const tracker = new FakeTracker();
const stockRuns = [];
tracker.connect('begin', () => stockRuns.push('stock-begin'));
tracker.connect('update', () => stockRuns.push('stock-update'));
tracker.connect('end', () => stockRuns.push('stock-end'));

const wac = {
    _switchWorkspaceBegin() { stockRuns.push('restored-begin'); },
    _switchWorkspaceUpdate() { stockRuns.push('restored-update'); },
    _switchWorkspaceEnd() { stockRuns.push('restored-end'); },
};

const interop = {
    getSwipeTracker: () => tracker,
    getWorkspaceAnimation: () => wac,
    isWorkspacesOnlyOnPrimary: () => false,
    getPrimaryIndex: () => 0,
    isHorizontalLayout: () => true,
    orientationFor: h => (h ? 'H' : 'V'),
    prepareWorkspaceSwitch: () => {
        switchData ??= {monitors: Object.values(groups), gestureActivated: false};
    },
    getSwitchData: () => switchData,
    findMonitorGroup: i => (switchData ? groups[i] ?? null : null),
    currentEventTime: () => 4242,
    getActiveWorkspaceIndex: () => activeIndex,
    getWorkspaceByIndex: workspaceAt,
    easeOutCubic: 'EASE_OUT_CUBIC',
    switchDuration: 250,
    finishWorkspaceSwitch: d => { finished.push(d); switchData = null; },
};

const monitorState = {
    virtual: new Map([[0, 0], [1, 0]]),
    getWorkspaceCount: () => COUNT,
    clampIndex: i => Math.min(Math.max(i, 0), COUNT - 1),
    wrapIndex: i => ((i % COUNT) + COUNT) % COUNT,
    getVirtualIndex(m) { return this.virtual.get(m) ?? 0; },
    setVirtualIndex(m, w) {
        const c = this.clampIndex(w);
        this.virtual.set(m, c);
        return c;
    },
};

const staged = [], synced = [], syncedAll = [];
const reassigner = {
    stageMonitor(m) { staged.push(m); return 1; },
    syncMonitor(m) { synced.push(m); },
    syncAll(a) { syncedAll.push(a); },
};

const driver = new AnimationDriver({interop, monitorState, reassigner});

section('takeover');
const handler = new GestureHandler({interop, driver});
tracker.emit('begin', 1);
check('stock begin handler was displaced', !stockRuns.includes('stock-begin'),
    `(ran: ${stockRuns})`);
check('our begin ran: confirmSwipe called', tracker.confirmed !== undefined);
check('tracker orientation set from layout', tracker.orientation === 'H');
check('the gesture staged the monitor it began on',
    JSON.stringify(staged) === '[1]', JSON.stringify(staged));
check('confirmSwipe was scoped to the staged centre, not the active workspace',
    tracker.confirmed[2] === 1, JSON.stringify(tracker.confirmed));

section('update touches only the active monitor');
tracker.emit('update', 0.5);
check('active monitor 1 advanced', groups[1].updated.length === 1);
check('monitor 0 stayed frozen', groups[0].updated.length === 0,
    `(got ${groups[0].updated.length})`);

section('end on a NON-primary monitor');
tracker.emit('end', 250, 2.0);
check('active group eased to target', groups[1].eased?.prop === 'progress');
check('frozen group not eased', groups[1].eased !== null && groups[0].eased === null);
check('the gesture duration was used, not the fixed one',
    groups[1].eased.params.duration === 250);
check('virtual index recorded relative to the staging centre',
    monitorState.getVirtualIndex(1) === 1,
    `(got ${monitorState.getVirtualIndex(1)})`);
groups[1].eased.params.onStopped(true);
check('switch finished', finished.length === 1);
check('no workspace activated; the monitor was re-parked instead',
    activated.length === 0 && JSON.stringify(synced) === '[1]', JSON.stringify(synced));

section('end on the PRIMARY monitor');
tracker.emit('begin', 0);
check('the primary was not staged', JSON.stringify(staged) === '[1]',
    JSON.stringify(staged));
tracker.emit('update', 0.5);
tracker.emit('end', 250, 1.0);
groups[0].eased.params.onStopped(true);
check('the real workspace was activated',
    JSON.stringify(activated) === '[[1,4242]]', JSON.stringify(activated));
check('every secondary was re-parked against the new workspace',
    JSON.stringify(syncedAll) === '[1]', JSON.stringify(syncedAll));

section('a gesture on a monitor the Shell ignores does nothing');
{
    const before = staged.length;
    groups[1].eased = null;
    groups[1].updated.length = 0;
    interop.isWorkspacesOnlyOnPrimary = () => true;
    tracker.emit('begin', 1);
    tracker.emit('update', 0.5);
    tracker.emit('end', 250, 2.0);
    check('nothing was staged, advanced or eased',
        staged.length === before && groups[1].eased === null &&
        groups[1].updated.length === 0);
    interop.isWorkspacesOnlyOnPrimary = () => false;
}

section('restore');
handler.destroy();
stockRuns.length = 0;
tracker.emit('begin', 0);
tracker.emit('update', 0.1);
tracker.emit('end', 10, 0.0);
check('stock handlers reconnected',
    JSON.stringify(stockRuns) === '["restored-begin","restored-update","restored-end"]',
    `(got ${JSON.stringify(stockRuns)})`);

