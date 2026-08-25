/*
 * MacOS Workspaces — per-monitor state tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {MonitorStateManager} from '../lib/monitorState.js';
import {suite} from './harness.js';
import {Signaller} from './stubs.js';

const {check, section} = suite('per-monitor state');

/**
 * A workspace manager and layout manager whose counts can be changed.
 *
 * These were once tested under Node with a stub for `Main`, because this module
 * reached into the Shell directly. It takes an injected bundle now, so it runs
 * under plain `gjs` with the rest — one runner, one language.
 *
 * @param {object} params - starting sizes
 * @param {number} params.workspaces - workspace count
 * @param {number} params.monitors - monitor count
 * @returns {object} the manager under test, plus the levers to move
 */
function harness({workspaces = 4, monitors = 2} = {}) {
    const workspaceManager = Object.assign(new Signaller(), {n_workspaces: workspaces});
    const layoutManager = Object.assign(new Signaller(), {
        monitors: Array.from({length: monitors}, (_, index) => ({index})),
    });

    const state = new MonitorStateManager({workspaceManager, layoutManager});

    return {
        state, workspaceManager, layoutManager,

        setWorkspaceCount(count) {
            workspaceManager.n_workspaces = count;
            workspaceManager.emit('notify::n-workspaces');
        },

        setMonitorCount(count) {
            layoutManager.monitors = Array.from({length: count}, (_, index) => ({index}));
            layoutManager.emit('monitors-changed');
        },

        pairs() {
            return JSON.stringify([...state.getSnapshot().entries()]);
        },
    };
}

section('initial state');
{
    const h = harness();
    check('one entry per connected monitor', h.pairs() === '[[0,0],[1,0]]', h.pairs());
    check('workspace count comes from the manager', h.state.getWorkspaceCount() === 4);
    check('monitor count comes from the layout', h.state.getMonitorCount() === 2);
}

section('recording an index');
{
    const h = harness();
    check('a value in range is stored as given',
        h.state.setVirtualIndex(1, 3) === 3 && h.state.getVirtualIndex(1) === 3);
    check('above the last workspace it clamps', h.state.setVirtualIndex(1, 99) === 3);
    check('below the first it clamps', h.state.setVirtualIndex(0, -5) === 0);
    check('a fraction is truncated, not rounded', h.state.setVirtualIndex(0, 2.7) === 2);
    check('nonsense becomes 0 rather than propagating',
        h.state.setVirtualIndex(0, NaN) === 0);
    check('an unknown monitor is refused, not invented',
        h.state.setVirtualIndex(7, 1) === 0 && !h.state.getSnapshot().has(7));
    check('reading an unknown monitor answers 0', h.state.getVirtualIndex(9) === 0);
}

section('asking without recording');
{
    const h = harness();
    check('clampIndex stops at either end',
        h.state.clampIndex(9) === 3 && h.state.clampIndex(-2) === 0);
    check('wrapIndex carries round instead',
        h.state.wrapIndex(4) === 0 && h.state.wrapIndex(-1) === 3 &&
        h.state.wrapIndex(5) === 1);
    check('neither one stores anything', h.state.getVirtualIndex(0) === 0);
}

section('the workspace count changes underneath');
{
    const h = harness();
    h.state.setVirtualIndex(0, 3);
    h.state.setVirtualIndex(1, 2);
    h.setWorkspaceCount(2);
    check('every out-of-range index is pulled back in', h.pairs() === '[[0,1],[1,1]]',
        h.pairs());
}
{
    const h = harness();
    h.state.setVirtualIndex(1, 3);
    h.setWorkspaceCount(8);
    check('growing the strip leaves indices alone', h.state.getVirtualIndex(1) === 3);
}
{
    const h = harness({workspaces: 0});
    check('a count of zero still leaves one workspace to be on',
        h.state.getWorkspaceCount() === 1);
}

section('a display is plugged or unplugged');
{
    const h = harness({monitors: 2});
    h.state.setVirtualIndex(0, 2);
    h.setMonitorCount(3);
    check('the new display starts at the first workspace, others keep theirs',
        h.pairs() === '[[0,2],[1,0],[2,0]]', h.pairs());
}
{
    const h = harness({monitors: 3});
    h.state.setVirtualIndex(0, 1);
    h.setMonitorCount(1);
    check('departed displays lose their entry, the survivor keeps its index',
        h.pairs() === '[[0,1]]', h.pairs());
    h.setMonitorCount(2);
    check('one plugged back in comes back at the first workspace',
        h.pairs() === '[[0,1],[1,0]]', h.pairs());
}

section('teardown');
{
    const h = harness();
    check('listening while alive',
        h.workspaceManager.handlerCount === 1 && h.layoutManager.handlerCount === 1);

    h.state.destroy();
    check('both signals disconnected',
        h.workspaceManager.handlerCount === 0 && h.layoutManager.handlerCount === 0);
    check('and the map is dropped', h.state.getSnapshot().size === 0);

    // Nothing should reach a destroyed manager, but a stray emission must not
    // take the Shell down with it.
    h.workspaceManager.emit('notify::n-workspaces');
    h.layoutManager.emit('monitors-changed');
    check('a late signal after destroy does not throw', true);
}
