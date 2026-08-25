/*
 * MacOS Workspaces — keyboard switching tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {AnimationDriver} from '../lib/animationDriver.js';
import {KeybindingHandler} from '../lib/keybindingHandler.js';
import {suite} from './harness.js';

const {check, section} = suite('keyboard switching');

function makeGroup(index) {
    return {index, progress: 0, eased: null,
        getWorkspaceProgress: ws => ws.idx,
        ease_property(p, t, params) { this.eased = {p, t, params}; },
        remove_all_transitions() {
            const e = this.eased;
            this.eased = null;
            e?.params.onStopped?.(false);
        }};
}

function harness({focusMonitor = -1, cursorMonitor = 0, rtl = false, active = 0,
    nWs = 4, layout = {rows: 1, columns: -1}, wrap = false} = {}) {
    const groups = {0: makeGroup(0), 1: makeGroup(1)};
    const state = {map: new Map([[0, 0], [1, 0]]), finished: [], activated: []};
    let switchData = null;
    const workspaces = Array.from({length: nWs}, (_, i) => ({
        idx: i, active: i === active,
        activate() { state.activated.push(this.idx); },
    }));
    const registered = new Map();

    const interop = {
        getPrimaryIndex: () => 0,
        getFocusWindowMonitor: () => focusMonitor,
        getPointer: () => [0, 0],
        getMonitorIndexForRect: () => cursorMonitor,
        isRtl: () => rtl,
        getWorkspaceLayout: () => layout,
        getActiveWorkspaceIndex: () => active,
        getWorkspaceByIndex: i => workspaces[i] ?? null,
        prepareWorkspaceSwitch: () => {
            // The Shell returns early when a switch is already in flight.
            switchData ??= {monitors: Object.values(groups), gestureActivated: false};
        },
        getSwitchData: () => switchData,
        findMonitorGroup: i => (switchData ? groups[i] ?? null : null),
        finishWorkspaceSwitch: d => { state.finished.push(d); switchData = null; },
        currentEventTime: () => 99,
        easeOutCubic: 'EOC',
        switchDuration: 250,
        setKeybindingHandler: (n, h) => registered.set(n, h),
        restoreKeybindingHandler: n => registered.set(n, 'STOCK'),
    };
    const monitorState = {
        getWorkspaceCount: () => nWs,
        clampIndex: v => Math.min(Math.max(v, 0), nWs - 1),
        wrapIndex: v => ((v % nWs) + nWs) % nWs,
        getSnapshot: () => state.map,
        getVirtualIndex: m => state.map.get(m) ?? 0,
        setVirtualIndex: (m, v) => {
            const c = Math.min(Math.max(v, 0), nWs - 1);
            if (state.map.has(m)) state.map.set(m, c);
            return c;
        },
    };
    const synced = [], staged = [], syncedAll = [];
    const reassigner = {
        getStagingIndex: () => 1,
        stageMonitor: m => { staged.push(m); return 1; },
        syncMonitor: m => synced.push(m),
        syncAll: g => syncedAll.push(g),
    };
    state.synced = synced; state.staged = staged; state.syncedAll = syncedAll;
    const settings = {wrapAround: wrap, durationFor: d => d ?? 250};
    const driver = new AnimationDriver({interop, monitorState, reassigner, settings});
    const handler = new KeybindingHandler({interop, monitorState, driver});
    return {
        handler, registered, groups, state,
        press: name => registered.get(name)(null, null, {get_name: () => name}),
    };
}

section('registration');
{
    const h = harness();
    check('four directional bindings taken over', h.registered.size === 4,
        `(got ${h.registered.size})`);
    check('absolute jumps left to the Shell',
        !h.registered.has('switch-to-workspace-1') && !h.registered.has('move-to-workspace-left'));
    h.handler.destroy();
    check('destroy restores all four',
        [...h.registered.values()].every(v => v === 'STOCK'));
}

section('focus decides the monitor');
{
    const h = harness({focusMonitor: 1, cursorMonitor: 0});
    h.press('switch-to-workspace-right');
    check('focused monitor 1 moved, not the cursor’s monitor 0',
        h.state.map.get(1) === 1 && h.state.map.get(0) === 0,
        `(map ${JSON.stringify([...h.state.map])})`);
    check('only monitor 1 animated', h.groups[1].eased !== null && h.groups[0].eased === null);
    check('non-primary did not activate globally', h.state.activated.length === 0);
}

section('cursor is the fallback');
{
    const h = harness({focusMonitor: -1, cursorMonitor: 1});
    h.press('switch-to-workspace-right');
    check('with no focus, cursor monitor 1 moved', h.state.map.get(1) === 1);
}

section('the primary keeps its native path');
{
    const h = harness({focusMonitor: 0});
    h.press('switch-to-workspace-right');
    h.groups[0].eased.params.onStopped(true);
    check('primary activates the real workspace', JSON.stringify(h.state.activated) === '[1]',
        `(got ${JSON.stringify(h.state.activated)})`);
    check('primary is never staged', h.state.staged.length === 0,
        JSON.stringify(h.state.staged));
    check('primary is never re-parked', h.state.synced.length === 0,
        JSON.stringify(h.state.synced));
    check('but secondaries ARE re-parked against the new workspace',
        JSON.stringify(h.state.syncedAll) === '[1]', JSON.stringify(h.state.syncedAll));
    check('switch torn down', h.state.finished.length === 1);
    check('animation matches the Shell', h.groups[0].eased.params.duration === 250 &&
        h.groups[0].eased.params.mode === 'EOC');
}

section('direction and bounds');
{
    const h = harness({focusMonitor: 1});
    h.press('switch-to-workspace-left');
    check('left at workspace 0 clamps, no animation',
        h.state.map.get(1) === 0 && h.groups[1].eased === null);
    h.press('switch-to-workspace-right');
    check('right advances', h.state.map.get(1) === 1);
}
{
    // Up and down only mean anything when the workspaces are a column.
    const h = harness({focusMonitor: 1, layout: {rows: -1, columns: 1}});
    h.press('switch-to-workspace-down');
    check('down advances', h.state.map.get(1) === 1);
    h.press('switch-to-workspace-up');
    check('up retreats', h.state.map.get(1) === 0);
}

section('right-to-left flips horizontal only');
{
    const h = harness({focusMonitor: 1, rtl: true, active: 2});
    h.state.map.set(1, 2);
    h.press('switch-to-workspace-right');
    check('RTL: right goes backwards', h.state.map.get(1) === 1,
        `(got ${h.state.map.get(1)})`);
}
{
    const h = harness({focusMonitor: 1, rtl: true, active: 2,
        layout: {rows: -1, columns: 1}});
    h.state.map.set(1, 2);
    h.press('switch-to-workspace-down');
    check('RTL: down still advances — only the horizontal pair flips',
        h.state.map.get(1) === 3, `(got ${h.state.map.get(1)})`);
}

section('the slide runs between the display workspace and its neighbour');
{
    const h = harness({focusMonitor: 1, nWs: 4});
    h.state.map.set(1, 2);
    h.press('switch-to-workspace-left');
    const staging = 1;
    check('slide starts at the staging centre',
        h.groups[1].progress === staging, `(got ${h.groups[1].progress})`);
    check('slide ends at its LEFT neighbour, which always exists',
        h.groups[1].eased.t === staging - 1, `(got ${h.groups[1].eased.t})`);
    check('virtual index moved 2 -> 1', h.state.map.get(1) === 1);
    check('the secondary was staged first', JSON.stringify(h.state.staged) === '[1]');
}

section('animation direction (earlier regression)');
{
    const h = harness({focusMonitor: 1, nWs: 4});
    h.state.map.set(1, 0);
    h.press('switch-to-workspace-right');
    const e = h.groups[1].eased;
    check('slide starts at the staging centre (1)', h.groups[1].progress === 1,
        `(got ${h.groups[1].progress})`);
    check('slide ends one workspace to the RIGHT (2)', e && e.t === 2, `(got ${e && e.t})`);
}

section('clamp at the last workspace is announced, not silent');
{
    const h = harness({focusMonitor: 0, active: 3, nWs: 4});
    h.state.map.set(0, 3);
    h.press('switch-to-workspace-right');
    check('no animation at the last workspace', h.groups[0].eased === null);
    check('nothing activated', h.state.activated.length === 0);
}

section('a secondary advances from its OWN index, not the global one');
{
    // Global is 1, the Dell sits on its own virtual workspace 0. Pressing Right
    // must take it to ITS workspace 1, independent of where the primary is.
    const h = harness({focusMonitor: 1, active: 1});
    h.state.map.set(1, 0);
    h.press('switch-to-workspace-right');
    check('virtual index advances 0 -> 1 regardless of the global workspace',
        h.state.map.get(1) === 1, `(got ${h.state.map.get(1)})`);
    check('but the slide animates around the staging centre (1 -> 2)',
        h.groups[1].progress === 1 && h.groups[1].eased.t === 2,
        `(from ${h.groups[1].progress} to ${h.groups[1].eased && h.groups[1].eased.t})`);
}

section('a layout only responds along its own axis');
{
    // The default GNOME layout is one row: columns === -1. Stock GNOME drops
    // up and down outright there (windowManager.js:637-645).
    const h = harness({focusMonitor: 1, layout: {rows: 1, columns: -1}});
    h.press('switch-to-workspace-down');
    check('a row layout ignores down', h.state.map.get(1) === 0 &&
        h.groups[1].eased === null, `(got ${h.state.map.get(1)})`);
    h.press('switch-to-workspace-right');
    check('but still honours right', h.state.map.get(1) === 1);
}
{
    const h = harness({focusMonitor: 1, layout: {rows: -1, columns: 1}});
    h.press('switch-to-workspace-right');
    check('a column layout ignores right', h.state.map.get(1) === 0 &&
        h.groups[1].eased === null, `(got ${h.state.map.get(1)})`);
    h.press('switch-to-workspace-down');
    check('but still honours down', h.state.map.get(1) === 1);
}

section('a single workspace is nothing to switch between');
{
    const h = harness({focusMonitor: 1, nWs: 1});
    h.press('switch-to-workspace-right');
    check('no switch is opened at all', h.state.staged.length === 0 &&
        h.groups[1].eased === null);
}

section('rapid keypresses add up, they do not compound');
{
    const h = harness({focusMonitor: 1, nWs: 4});
    h.press('switch-to-workspace-right');
    check('first press: virtual 0 -> 1', h.state.map.get(1) === 1);
    // Second press lands mid-settle: the session is reused and its anchor held.
    h.press('switch-to-workspace-right');
    check('second press: virtual 1 -> 2, not 3', h.state.map.get(1) === 2,
        `(got ${h.state.map.get(1)})`);
    check('the monitor was staged once, not twice',
        JSON.stringify(h.state.staged) === '[1]', JSON.stringify(h.state.staged));
    check('and the slide is two steps from the staging centre',
        h.groups[1].eased.t === 3, `(got ${h.groups[1].eased.t})`);
}

section('wrap-around, from the keyboard');
{
    const h = harness({focusMonitor: 1, wrap: true, nWs: 4});
    h.state.map.set(1, 3);
    h.press('switch-to-workspace-right');
    check('a secondary steps past the last workspace to the first',
        h.state.map.get(1) === 0, `(got ${h.state.map.get(1)})`);
    check('and it really animates, one step from the staging centre',
        h.groups[1].eased && h.groups[1].eased.t === 2,
        `(got ${h.groups[1].eased && h.groups[1].eased.t})`);
}
{
    const h = harness({focusMonitor: 0, active: 3, wrap: true, nWs: 4});
    h.state.map.set(0, 3);
    h.press('switch-to-workspace-right');
    check('the primary still refuses, wrap-around or not',
        h.state.map.get(0) === 3 && h.groups[0].eased === null,
        `(got ${h.state.map.get(0)})`);
}
{
    const h = harness({focusMonitor: 1, wrap: false, nWs: 4});
    h.state.map.set(1, 3);
    h.press('switch-to-workspace-right');
    check('with wrap-around off a secondary still stops at the end',
        h.state.map.get(1) === 3 && h.groups[1].eased === null);
}

