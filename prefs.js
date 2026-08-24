/*
 * MacOS Workspaces — preferences window
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Preferences window for the MacOS Workspaces extension.
 *
 * Both rows are bound straight to GSettings, and the extension reads every value
 * at the moment it uses it, so a change takes effect on the next switch with no
 * restart and nothing to notify.
 */
export default class MacOSWorkspacesPreferences extends ExtensionPreferences {
    /**
     * Builds the preferences UI.
     *
     * @param {Adw.PreferencesWindow} window - the window to populate
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._buildGeneralPage(settings));
        window.add(this._buildAboutPage());
    }

    /**
     * The one page of actual settings.
     *
     * @param {Gio.Settings} settings - this extension's settings
     * @returns {Adw.PreferencesPage} the page
     * @private
     */
    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const behaviour = new Adw.PreferencesGroup({
            title: 'Switching',
        });

        const wrap = new Adw.SwitchRow({
            title: 'Wrap around',
            subtitle: 'Continue past the last workspace to the first. ' +
                'The primary monitor always stops at either end, as GNOME does.',
        });
        settings.bind('wrap-around', wrap, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        behaviour.add(wrap);

        page.add(behaviour);

        const animation = new Adw.PreferencesGroup({
            title: 'Animation',
        });

        const duration = new Adw.SpinRow({
            title: 'Slide duration',
            subtitle: 'Milliseconds. 250 matches GNOME’s own workspace switch. ' +
                'Swipes are scaled by this, so a fast flick stays fast.',
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
            }),
        });
        settings.bind('animation-duration', duration, 'value',
            Gio.SettingsBindFlags.DEFAULT);
        animation.add(duration);

        page.add(animation);

        return page;
    }

    /**
     * The About page, including the divergence users should know about.
     *
     * @returns {Adw.PreferencesPage} the page
     * @private
     */
    _buildAboutPage() {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });

        const about = new Adw.PreferencesGroup({
            title: this.metadata.name,
            description: this.metadata.description,
        });

        about.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? 'unknown',
        }));

        page.add(about);

        // Users will notice this and reasonably file it as a bug, so say it
        // here rather than leaving them to discover it.
        const notes = new Adw.PreferencesGroup({
            title: 'Things to know',
        });

        notes.add(new Adw.ActionRow({
            title: 'Fixed workspaces are required',
            subtitle: 'Each monitor holds its own workspace by moving windows ' +
                'between GNOME’s workspaces. Dynamic workspaces are created and ' +
                'destroyed as you use them, which would strand those windows, so ' +
                'the feature stays off unless you set a fixed number of at least four.',
        }));

        notes.add(new Adw.ActionRow({
            title: 'The Overview shows where windows really are',
            subtitle: 'The Overview, the workspace switcher and Alt+Tab show the ' +
                'workspace a window is parked on, which is not always the one you ' +
                'see it on. This is how per-monitor workspaces are possible at all.',
        }));

        notes.add(new Adw.ActionRow({
            title: 'The primary monitor drives the real workspace',
            subtitle: 'Its windows are never moved. That is deliberate: a fault ' +
                'here cannot scatter the windows on the display you work on.',
        }));

        page.add(notes);

        return page;
    }
}
