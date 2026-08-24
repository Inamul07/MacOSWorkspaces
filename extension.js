/*
 * MacOS Workspaces — GNOME Shell 46 extension
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AnimationDriver} from './lib/animationDriver.js';
import {getCursorMonitorIndex} from './lib/cursorMonitor.js';
import {GestureHandler} from './lib/gestureHandler.js';
import {KeybindingHandler} from './lib/keybindingHandler.js';
import {MonitorStateManager} from './lib/monitorState.js';
import {checkCompatibility, createInterop} from './lib/shellInterop.js';
import {WindowTracker} from './lib/windowTracker.js';
import {WorkspaceReassigner} from './lib/workspaceReassigner.js';

/**
 * Entry point for the MacOS Workspaces extension.
 *
 * As of Phase 6 a secondary monitor keeps its own workspace: both input paths
 * are per-monitor, the windows underneath are rotated so the monitor really
 * shows the workspace it claims to, and both paths run through one shared
 * animation driver so they cannot look — or count — differently.
 */
export default class MacOSWorkspacesExtension extends Extension {
    /**
     * Called when the extension is enabled by GNOME Shell.
     */
    enable() {
        // Internal APIs carry no stability promise. Bail out loudly rather than
        // half-patching a Shell we do not understand.
        const incompatible = checkCompatibility();
        if (incompatible) {
            console.error(`[macos-workspaces] incompatible GNOME Shell — ${incompatible}. ` +
                'Extension disabled; the Shell is untouched.');
            return;
        }

        this._interop = createInterop();
        this._monitorState = new MonitorStateManager(this._interop);
        this._windowTracker = new WindowTracker({
            interop: this._interop,
            monitorState: this._monitorState,
        });
        this._reassigner = new WorkspaceReassigner({
            interop: this._interop,
            monitorState: this._monitorState,
            windowTracker: this._windowTracker,
        });

        // Persistence rotates windows across a fixed ring of workspaces. Dynamic
        // workspaces are created and destroyed as they are used, which reindexes
        // that ring and would strand windows on workspaces the user cannot reach.
        if (this._interop.isDynamicWorkspaces()) {
            this._reassigner.disable(
                'dynamic workspaces are enabled. Set a fixed number of workspaces ' +
                '(org.gnome.mutter dynamic-workspaces false) to keep each monitor ' +
                'on its own workspace. Gestures and shortcuts still work.');
        } else if (!this._reassigner.hasRoom()) {
            // Staging needs three adjacent workspaces to slide within, plus one
            // to park everything else clear of them.
            this._reassigner.disable(
                'at least 4 workspaces are needed to keep each monitor on its own ' +
                'workspace. Gestures and shortcuts still work.');
        } else {
            this._startPersistence();
        }

        // One driver, shared: a swipe and a keystroke are the same switch seen
        // through different inputs, and the two diverged once already.
        this._driver = new AnimationDriver({
            interop: this._interop,
            monitorState: this._monitorState,
            reassigner: this._reassigner,
        });

        this._gestureHandler = new GestureHandler({
            interop: this._interop,
            driver: this._driver,
        });
        this._keybindingHandler = new KeybindingHandler({
            interop: this._interop,
            monitorState: this._monitorState,
            driver: this._driver,
        });

        console.log(`[macos-workspaces] enabled (v${this.metadata['version-name']}) — ` +
            `cursor on monitor ${getCursorMonitorIndex(this._interop)}`);
    }

    /**
     * Starts every monitor on the workspace the user is already looking at.
     *
     * Nothing needs moving at that point — each monitor's virtual workspace is
     * the active one, so the rotation is the identity — but it establishes the
     * baseline the first switch is measured against.
     *
     * @private
     */
    _startPersistence() {
        const current = this._interop.getActiveWorkspaceIndex();
        for (const monitorIndex of this._monitorState.getSnapshot().keys())
            this._monitorState.setVirtualIndex(monitorIndex, current);

        console.log('[macos-workspaces] per-monitor persistence on — every monitor ' +
            `starting on workspace ${current}, primary untouched`);
    }

    /**
     * Called when the extension is disabled, and on session lock and unlock.
     * Must leave the Shell in exactly the state it was in before `enable()`.
     */
    disable() {
        // Restore the Shell's own input handling before dropping the state it reads.
        this._keybindingHandler?.destroy();
        this._keybindingHandler = null;

        this._gestureHandler?.destroy();
        this._gestureHandler = null;

        // Close any switch still animating: it un-stages the windows, so the
        // restore below has them where the records expect them.
        this._driver?.destroy();
        this._driver = null;

        // Put every window back on its own workspace before the records that say
        // where that is are thrown away.
        this._reassigner?.destroy();
        this._reassigner = null;

        this._windowTracker?.destroy();
        this._windowTracker = null;

        this._monitorState?.destroy();
        this._monitorState = null;

        this._interop = null;

        console.log('[macos-workspaces] disabled');
    }
}
