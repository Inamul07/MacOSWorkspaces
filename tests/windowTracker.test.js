/*
 * MacOS Workspaces — window tracker tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {WindowTracker} from '../lib/windowTracker.js';
import {suite} from './harness.js';

const {check, section} = suite('window tracker');

function harness({monitors = 2} = {}) {
    const placedCbs = new Map();
    const existing = [];
    let displayCb = null;
    const interop = {
        display: {connect: (sig, cb) => { displayCb = cb; return 1; }, disconnect: () => {}},
        getWindows: () => [...existing],
        getActiveWorkspaceIndex: () => 0,
        isTrackableWindow: w => w.trackable !== false,
        windowIsOnMonitor: (w, m) => w.monitor === m,
        getWindowWorkspaceIndex: w => (w.parked === undefined ? -1 : w.parked),
        onWindowPlaced: (w, cb) => placedCbs.set(w, cb),
    };
    const monitorState = {
        getMonitorCount: () => monitors,
        getWorkspaceCount: () => 4,
        getVirtualIndex: () => 0,
    };
    const t = new WindowTracker({interop, monitorState});
    // Fake windows need the GObject signal surface the tracker connects to.
    const asWindow = w => Object.assign(w, {connect: () => 1, disconnect: () => {}});
    return {
        t, placedCbs,
        create: w => displayCb(null, asWindow(w)),
        add(w) { const win = asWindow(w); existing.push(win); displayCb(null, win); return win; },
        setMonitors(n) { monitors = n; },
        recordFor: w => t.entries().find(([x]) => x === w)?.[1],
    };
}

section('a window created before it is placed');
{
    const h = harness();
    // Exactly what Mutter gives us on window-created: no position, no workspace.
    const w = {monitor: -1, parked: undefined};
    h.create(w);
    check('not tracked while unplaced', h.t.size === 0);
    check('a placement callback was registered', h.placedCbs.has(w));

    // The compositor places it: now it has a monitor and a workspace.
    w.monitor = 1;
    w.parked = 0;
    h.placedCbs.get(w)();
    check('tracked once placed', h.t.size === 1, `(size ${h.t.size})`);
    check('attributed to the right monitor', h.t.forMonitor(1).length === 1);
}

section('a window already placed at creation');
{
    const h = harness();
    h.create({monitor: 0, parked: 2});
    check('tracked immediately', h.t.size === 1);
    check('no deferred callback needed', h.placedCbs.size === 0);
}

section('untrackable windows are ignored');
{
    const h = harness();
    h.create({monitor: 0, parked: 0, trackable: false});
    check('sticky/desktop windows not tracked', h.t.size === 0);
}

section('placement callback is idempotent');
{
    const h = harness();
    const w = {monitor: -1, parked: undefined};
    h.create(w);
    w.monitor = 1; w.parked = 0;
    h.placedCbs.get(w)();
    h.placedCbs.get(w)();
    check('window tracked exactly once', h.t.size === 1, `(size ${h.t.size})`);
}

section('re-attribution after a monitor change');
{
    // One window per display. The second display is then unplugged, so the
    // window that was on it now sits on the only display left.
    const h = harness({monitors: 2});
    const kept = h.add({id: 'kept', monitor: 0, parked: 0});
    const moved = h.add({id: 'moved', monitor: 1, parked: 0});
    h.recordFor(kept).virtualWorkspace = 2;
    h.recordFor(moved).virtualWorkspace = 3;

    h.setMonitors(1);
    moved.monitor = 0;
    const size = h.t.retrackAll();

    check('every window is still tracked', size === 2, `(got ${size})`);
    check('a window whose display survived keeps its workspace',
        h.recordFor(kept).virtualWorkspace === 2,
        `(got ${h.recordFor(kept).virtualWorkspace})`);
    check('a window that changed display is re-attributed to it',
        h.recordFor(moved).monitor === 0, `(got ${h.recordFor(moved).monitor})`);
    check('and takes the workspace that display is showing, not its old one',
        h.recordFor(moved).virtualWorkspace === 0,
        `(got ${h.recordFor(moved).virtualWorkspace})`);
}
{
    // A window that no longer maps to any display must not be kept under a
    // monitor index that has ceased to exist.
    const h = harness({monitors: 2});
    const orphan = h.add({id: 'orphan', monitor: 1, parked: 0});
    check('tracked while its display exists', h.recordFor(orphan) !== undefined);
    h.setMonitors(1);
    h.t.retrackAll();
    check('dropped once its display is gone', h.recordFor(orphan) === undefined);
}

