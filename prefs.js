/*
 * MacOS Workspaces — preferences window
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Preferences window for the MacOS Workspaces extension.
 *
 * Phase 1 ships an intentional stub: the window builds and presents cleanly so
 * `gnome-extensions prefs` can be verified, but exposes no settings rows. The
 * real toggle, switch and spin rows are added in Phase 5 once the GSettings
 * schema carries keys.
 */
export default class MacOSWorkspacesPreferences extends ExtensionPreferences {
    /**
     * Builds the preferences UI.
     *
     * @param {Adw.PreferencesWindow} window - the window to populate
     */
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'MacOS Workspaces',
            description: 'Each monitor keeps its own workspace stack. ' +
                'There is nothing to configure yet — settings arrive in a later release.',
        });

        page.add(group);
        window.add(page);
    }
}
