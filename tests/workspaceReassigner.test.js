/*
 * MacOS Workspaces — workspace reassigner tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {WorkspaceReassigner} from '../lib/workspaceReassigner.js';
import {suite} from './harness.js';

const {check, section} = suite('workspace reassigner');

function harness({count = 4, active = 0, wrap = false} = {}) {
    const moves = [], windows = [];
    const interop = {
        getPrimaryIndex: () => 0,
        getActiveWorkspaceIndex: () => active,
        getWorkspaceByIndex: i => (i >= 0 && i < count ? {idx: i} : null),
        getWindowWorkspaceIndex: w => w.parked,
        changeWorkspace: (w, i) => { moves.push([w.id, i]); w.parked = i; },
        currentEventTime: () => 1,
    };
    const monitorState = {
        map: new Map([[0, active], [1, 0]]),
        getWorkspaceCount: () => count,
        getVirtualIndex(m) { return this.map.get(m) ?? 0; },
        getSnapshot() { return this.map; },
    };
    const windowTracker = {
        suppress(fn) { fn(); },
        entries: () => windows,
        forMonitor: m => windows.filter(([, r]) => r.monitor === m),
    };
    const settings = {wrapAround: wrap};
    const r = new WorkspaceReassigner({interop, monitorState, windowTracker, settings});
    const mk = (id, monitor, virtualWorkspace, parked) => {
        const w = {id, parked};
        windows.push([w, {monitor, virtualWorkspace}]);
        return w;
    };
    const at = id => windows.find(([w]) => w.id === id)[0].parked;
    return {r, mk, at, moves, monitorState};
}

section('the reported bug: moving LEFT with the primary on workspace 1');
{
    // Primary sits on workspace index 0, so there is nothing to its left. This
    // is exactly the case that made the Dell permanently one-directional.
    const h = harness({count: 4, active: 0});
    h.mk('trash', 1, 0, 3);   // Dell's workspace 1, currently hidden
    h.mk('files', 1, 1, 0);   // Dell's workspace 2, currently visible
    h.monitorState.map.set(1, 1);

    const origin = h.r.stageMonitor(1);
    check('staging centre has a left neighbour', origin - 1 >= 0);
    check('what is on screen is staged at the centre', h.at('files') === origin,
        `(files at ${h.at('files')}, centre ${origin})`);
    check('the workspace to its LEFT holds the previous one', h.at('trash') === origin - 1,
        `(trash at ${h.at('trash')})`);
    check('a left slide is now possible at all', origin - 1 >= 0 && h.at('trash') === 0);
}

section('and moving RIGHT still works');
{
    const h = harness({count: 4, active: 0});
    h.mk('a', 1, 1, 0);   // visible
    h.mk('b', 1, 2, 3);   // one to the right
    h.monitorState.map.set(1, 1);
    const origin = h.r.stageMonitor(1);
    check('next workspace staged to the right', h.at('b') === origin + 1, `(b at ${h.at('b')})`);
}

section('the primary is never touched');
{
    const h = harness({count: 4, active: 0});
    h.mk('p1', 0, 0, 0);
    h.r.stageMonitor(0);
    h.r.syncMonitor(0);
    h.r.syncAll();
    check('no moves on the primary at all', h.moves.length === 0, JSON.stringify(h.moves));
    check('stageMonitor returns the real active workspace for the primary',
        h.r.stageMonitor(0) === 0);
}

section('unreachable windows are parked clear of the staging window');
{
    const h = harness({count: 4, active: 0});
    h.mk('far', 1, 3, 0);   // three away, cannot be reached by one slide
    h.monitorState.map.set(1, 0);
    h.r.stageMonitor(1);
    const staging = h.r.getStagingIndex();
    check('parked outside [centre-1, centre+1]',
        h.at('far') < staging - 1 || h.at('far') > staging + 1, `(far at ${h.at('far')})`);
}

section('settling back to rest puts the new workspace on screen');
{
    const h = harness({count: 4, active: 0});
    h.mk('trash', 1, 0, 0);
    h.mk('files', 1, 1, 1);
    h.monitorState.map.set(1, 0);
    h.r.syncMonitor(1);
    check('the monitor’s own workspace lands on the active one',
        h.at('trash') === 0, `(trash at ${h.at('trash')})`);
    check('the other is off the active workspace', h.at('files') !== 0);
}

section('the primary moving must NOT drag a secondary');
{
    // Active workspace 0. The Dell shows its own workspace 1 (window "files"),
    // parked on 0. The laptop then switches to workspace 1.
    const h = harness({count: 4, active: 0});
    h.mk('trash', 1, 0, 3);
    h.mk('files', 1, 1, 0);
    h.monitorState.map.set(1, 1);

    h.r.syncAll(1);   // the primary just moved the displayed workspace to 1

    check('the Dell’s window moved onto the new displayed workspace',
        h.at('files') === 1, `(files at ${h.at('files')})`);
    check('so the Dell still shows its own workspace, not the laptop’s',
        h.at('files') === 1 && h.at('trash') !== 1);
}

section('an explicit index beats reading it back');
{
    const h = harness({count: 4, active: 0});
    h.mk('a', 1, 0, 0);
    h.monitorState.map.set(1, 0);
    h.r.syncAll(2);
    check('parked against the index passed in, not the stale active one',
        h.at('a') === 2, `(a at ${h.at('a')})`);
}

section('room and disable');
{
    check('4 workspaces is enough', harness({count: 4}).r.hasRoom() === true);
    check('3 is not', harness({count: 3}).r.hasRoom() === false);
    const h = harness({count: 4, active: 0});
    h.mk('d', 1, 2, 0);
    h.r.disable('test');
    check('disable restores the window to its own workspace', h.at('d') === 2);
    const before = h.moves.length;
    h.r.syncMonitor(1);
    check('no work once disabled', h.moves.length === before);
}

section('staging with wrap-around on');
{
    // The Dell sits on its LAST workspace. With wrap-around, its right-hand
    // neighbour is workspace 0 — plain subtraction calls those three apart and
    // would park it out of reach.
    const h = harness({count: 4, active: 0, wrap: true});
    h.mk('last', 1, 3, 0);    // what is on screen
    h.mk('first', 1, 0, 2);   // the wrap-around neighbour
    h.monitorState.map.set(1, 3);

    const origin = h.r.stageMonitor(1);
    check('the current workspace is at the centre', h.at('last') === origin,
        `(at ${h.at('last')})`);
    check('the first workspace is staged as the RIGHT neighbour of the last',
        h.at('first') === origin + 1, `(at ${h.at('first')})`);
}
{
    const h = harness({count: 4, active: 0, wrap: false});
    h.mk('last', 1, 3, 0);
    h.mk('first', 1, 0, 2);
    h.monitorState.map.set(1, 3);

    const origin = h.r.stageMonitor(1);
    check('with wrap-around off it is parked out of reach instead',
        h.at('first') !== origin + 1 && h.at('first') !== origin - 1,
        `(at ${h.at('first')}, centre ${origin})`);
}

