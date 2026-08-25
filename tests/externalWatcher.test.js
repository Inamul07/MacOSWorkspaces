/*
 * MacOS Workspaces — external change watcher tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {ExternalChangeWatcher, findConflicts} from '../lib/externalWatcher.js';
import {suite} from './harness.js';
import {Signaller} from './stubs.js';

const {check, section} = suite('external change watcher');

function harness({active = 0, primaryVirtual = 0, count = 4, monitors = 2,
    enabled = true, session = null, extensions = [], dynamic = false,
    onlyOnPrimary = false} = {}) {
    const workspaceManager = new Signaller();
    const layoutManager = new Signaller();
    const deferred = [];
    const log = {syncAll: [], disabled: [], retracked: 0};

    let prefsCallback = null;
    const interop = {
        workspaceManager,
        layoutManager,
        getPrimaryIndex: () => 0,
        getActiveWorkspaceIndex: () => active,
        getEnabledExtensions: () => extensions,
        isDynamicWorkspaces: () => dynamic,
        isWorkspacesOnlyOnPrimary: () => onlyOnPrimary,
        watchPreferences: cb => { prefsCallback = cb; return () => { prefsCallback = null; }; },
        defer: fn => { deferred.push(fn); return deferred.length; },
        cancelDeferred: id => { if (id) deferred[id - 1] = null; },
    };

    const monitorState = {
        map: new Map(Array.from({length: monitors}, (_, i) => [i, i === 0 ? primaryVirtual : 0])),
        getMonitorCount: () => monitors,
        getWorkspaceCount: () => count,
        getVirtualIndex(m) { return this.map.get(m) ?? 0; },
        setVirtualIndex(m, v) { this.map.set(m, v); return v; },
        getSnapshot() { return this.map; },
        describe: () => 'state',
    };

    const reassigner = {
        get enabled() { return enabled; },
        hasRoom: () => count >= 4,
        syncAll: i => log.syncAll.push(i),
        disable: reason => { enabled = false; log.disabled.push(reason); },
    };

    const windowTracker = {retrackAll: () => { log.retracked++; return 0; }};
    const driver = {get session() { return session; }};

    const watcher = new ExternalChangeWatcher(
        {interop, monitorState, windowTracker, reassigner, driver});

    return {
        watcher, log, monitorState, workspaceManager, layoutManager, deferred,
        runDeferred() {
            const pending = deferred.splice(0);
            for (const fn of pending) {
                if (fn)
                    fn();
            }
        },
        setActive: i => { active = i; },
        setCount: i => { count = i; },
        setDynamic: v => { dynamic = v; },
        setOnlyOnPrimary: v => { onlyOnPrimary = v; },
        prefs: key => prefsCallback?.(key),
        get enabled() { return enabled; },
    };
}

section('a workspace change we did not cause');
{
    const h = harness({active: 0, primaryVirtual: 0});
    h.setActive(2);                       // as if by wmctrl -s 2
    h.workspaceManager.emit('notify::active-workspace');
    check('the primary is re-anchored on what is really on screen',
        h.monitorState.getVirtualIndex(0) === 2,
        `(got ${h.monitorState.getVirtualIndex(0)})`);
    check('every secondary is re-parked against it',
        JSON.stringify(h.log.syncAll) === '[2]', JSON.stringify(h.log.syncAll));
}

section('our own change is recognised by agreement, not by a flag');
{
    // settle() writes the index before activating, so by the time the signal
    // arrives the model already agrees.
    const h = harness({active: 1, primaryVirtual: 1});
    h.workspaceManager.emit('notify::active-workspace');
    check('nothing is re-anchored', h.monitorState.getVirtualIndex(0) === 1);
    check('and nothing is moved', h.log.syncAll.length === 0,
        JSON.stringify(h.log.syncAll));
}

section('reconciliation cannot fight an animation in flight');
{
    const h = harness({active: 2, primaryVirtual: 0, session: {monitor: 0}});
    h.workspaceManager.emit('notify::active-workspace');
    check('a live switch settles itself; the watcher stands back',
        h.log.syncAll.length === 0 && h.monitorState.getVirtualIndex(0) === 0);
}

section('and it does nothing at all once persistence is off');
{
    const h = harness({active: 2, primaryVirtual: 0, enabled: false});
    h.workspaceManager.emit('notify::active-workspace');
    h.layoutManager.emit('monitors-changed');
    h.runDeferred();
    check('no re-anchoring, no re-tracking',
        h.log.syncAll.length === 0 && h.log.retracked === 0);
}

section('losing workspaces takes persistence with them');
{
    const h = harness({count: 4});
    h.setCount(2);
    h.workspaceManager.emit('notify::n-workspaces');
    check('persistence is turned off, with a reason', !h.enabled &&
        h.log.disabled.length === 1, JSON.stringify(h.log.disabled));
    check('the reason says the windows were put back',
        /put back/.test(h.log.disabled[0] ?? ''), h.log.disabled[0]);
}
{
    const h = harness({count: 4, active: 1});
    h.workspaceManager.emit('notify::n-workspaces');
    check('a count change that leaves room only re-syncs',
        h.enabled && JSON.stringify(h.log.syncAll) === '[1]',
        JSON.stringify(h.log.syncAll));
}

section('a display appearing or vanishing renumbers everything');
{
    const h = harness({active: 2, monitors: 2});
    h.monitorState.map.set(1, 3);
    h.layoutManager.emit('monitors-changed');

    check('nothing is re-attributed while the Shell is still mid-change',
        h.log.retracked === 0);

    h.runDeferred();
    check('window attribution is rebuilt once it has settled', h.log.retracked === 1);
    check('every display is reset to what is actually on screen',
        h.monitorState.getVirtualIndex(0) === 2 &&
        h.monitorState.getVirtualIndex(1) === 2,
        JSON.stringify([...h.monitorState.map]));
}
{
    // Displays often change several times in a row as mutter settles.
    const h = harness({active: 0, monitors: 2});
    h.layoutManager.emit('monitors-changed');
    h.layoutManager.emit('monitors-changed');
    h.layoutManager.emit('monitors-changed');
    h.runDeferred();
    check('a burst of changes rebuilds once, not once each',
        h.log.retracked === 1, `(got ${h.log.retracked})`);
}
{
    const h = harness({active: 0, monitors: 2});
    h.layoutManager.emit('monitors-changed');
    h.watcher.destroy();
    h.runDeferred();
    check('work queued before destroy does not run afterwards',
        h.log.retracked === 0, `(got ${h.log.retracked})`);
}

section('preferences that make persistence unsafe');
{
    const h = harness();
    h.setDynamic(true);
    h.prefs('dynamic-workspaces');
    check('dynamic workspaces turn it off', !h.enabled &&
        /dynamic/i.test(h.log.disabled[0] ?? ''), JSON.stringify(h.log.disabled));
}
{
    const h = harness();
    h.setOnlyOnPrimary(true);
    h.prefs('workspaces-only-on-primary');
    check('confining workspaces to the primary turns it off', !h.enabled,
        JSON.stringify(h.log.disabled));
}
{
    const h = harness();
    h.prefs('dynamic-workspaces');          // changed, but back to false
    h.prefs('workspaces-only-on-primary');
    check('a preference changing back to a safe value leaves it running',
        h.enabled && h.log.disabled.length === 0);
}

section('a conflicting extension is called out by name');
{
    const h = harness({extensions: ['smart-workspace-manager@local', 'ubuntu-dock@ubuntu.com']});
    check('the conflict is found and carries a reason',
        h.watcher.conflicts.length === 1 &&
        h.watcher.conflicts[0][0] === 'smart-workspace-manager@local' &&
        h.watcher.conflicts[0][1].length > 0,
        JSON.stringify(h.watcher.conflicts));
}
{
    const h = harness({extensions: ['ubuntu-dock@ubuntu.com', 'ding@rastersoft.com']});
    check('harmless extensions are not flagged', h.watcher.conflicts.length === 0,
        JSON.stringify(h.watcher.conflicts));
}
{
    check('the detection is a plain function over UUIDs',
        findConflicts([]).length === 0 &&
        findConflicts(['smart-workspace-manager@local']).length === 1);
}
{
    // Reading the list can fail; that must not stop the extension loading.
    const h = harness({extensions: ['ubuntu-dock@ubuntu.com']});
    check('a watcher was still built', h.watcher instanceof ExternalChangeWatcher);
}

section('teardown');
{
    const h = harness();
    check('watching while alive',
        h.workspaceManager.handlerCount === 2 && h.layoutManager.handlerCount === 1);
    h.watcher.destroy();
    check('every signal disconnected',
        h.workspaceManager.handlerCount === 0 && h.layoutManager.handlerCount === 0);
    h.setActive(3);
    h.workspaceManager.emit('notify::active-workspace');
    h.layoutManager.emit('monitors-changed');
    h.runDeferred();
    check('and nothing reacts afterwards',
        h.log.syncAll.length === 0 && h.log.retracked === 0);
    h.watcher.destroy();
    check('destroy is safe twice', true);
}

