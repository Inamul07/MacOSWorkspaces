/*
 * MacOS Workspaces — GNOME Shell 46 extension
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getCursorMonitorIndex} from './lib/cursorMonitor.js';
import {MonitorStateManager} from './lib/monitorState.js';

/**
 * Entry point for the MacOS Workspaces extension.
 *
 * As of Phase 2 this owns the per-monitor state engine and nothing else: no
 * gesture is intercepted and no workspace is switched. Gesture interception
 * arrives in Phase 3 and will read from the same state manager built here.
 */
export default class MacOSWorkspacesExtension extends Extension {
    /**
     * Called when the extension is enabled by GNOME Shell.
     */
    enable() {
        this._monitorState = new MonitorStateManager();

        console.log(`[macos-workspaces] enabled (v${this.metadata['version-name']}) — ` +
            `cursor on monitor ${getCursorMonitorIndex()}`);
    }

    /**
     * Called when the extension is disabled, and on session lock and unlock.
     * Must leave the Shell in exactly the state it was in before `enable()`.
     */
    disable() {
        this._monitorState?.destroy();
        this._monitorState = null;

        console.log('[macos-workspaces] disabled');
    }
}
