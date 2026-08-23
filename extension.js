/*
 * MacOS Workspaces — GNOME Shell 46 extension
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {getCursorMonitorIndex} from './lib/cursorMonitor.js';
import {GestureHandler} from './lib/gestureHandler.js';
import {KeybindingHandler} from './lib/keybindingHandler.js';
import {MonitorStateManager} from './lib/monitorState.js';
import {checkCompatibility, createInterop} from './lib/shellInterop.js';

/**
 * Entry point for the MacOS Workspaces extension.
 *
 * As of Phase 4 both input paths are per-monitor: swipe gestures and the
 * directional workspace keybindings. The new workspace does not yet persist on a
 * secondary monitor — that is Phase 5.
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
        this._gestureHandler = new GestureHandler({
            interop: this._interop,
            monitorState: this._monitorState,
        });
        this._keybindingHandler = new KeybindingHandler({
            interop: this._interop,
            monitorState: this._monitorState,
        });

        console.log(`[macos-workspaces] enabled (v${this.metadata['version-name']}) — ` +
            `cursor on monitor ${getCursorMonitorIndex(this._interop)}`);
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

        this._monitorState?.destroy();
        this._monitorState = null;

        this._interop = null;

        console.log('[macos-workspaces] disabled');
    }
}
