/*
 * MacOS Workspaces — GNOME Shell 46 extension
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/**
 * Entry point for the MacOS Workspaces extension.
 *
 * Phase 1 deliberately performs no work: `enable()` and `disable()` are a
 * clean round trip with zero side effects, which is the scaffold's whole
 * contract. The per-monitor state engine, gesture interception and animation
 * driver arrive in later phases and will be constructed and torn down here.
 */
export default class MacOSWorkspacesExtension extends Extension {
    /**
     * Called when the extension is enabled by GNOME Shell.
     */
    enable() {
        console.log(`[macos-workspaces] enabled (v${this.metadata['version-name']})`);
    }

    /**
     * Called when the extension is disabled, and on session lock and unlock.
     * Must leave the Shell in exactly the state it was in before `enable()`.
     */
    disable() {
        console.log('[macos-workspaces] disabled');
    }
}
