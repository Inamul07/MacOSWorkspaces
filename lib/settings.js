/*
 * MacOS Workspaces — user preferences
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {debug, setVerbose} from './log.js';

/** Slide length GNOME itself uses, and the baseline swipes are scaled against. */
const DEFAULT_DURATION = 250;

/**
 * Reads the extension's settings.
 *
 * Every value is read at the moment it is used rather than cached, which is why
 * there is no change signal to subscribe to: a preference takes effect on the
 * next switch without anything having to be told about it. The `changed`
 * handler here exists only so the journal records what the user altered and when.
 *
 * The `Gio.Settings` object is injected rather than constructed, both because
 * only `extension.js` can call `getSettings()` and because it keeps this module
 * testable with a plain fake.
 */
export class SettingsManager {
    /**
     * @param {object} settings - a `Gio.Settings` for this extension's schema
     */
    constructor(settings) {
        this._settings = settings;
        this._changedId = settings?.connect('changed',
            (_, key) => this._onChanged(key)) ?? 0;
    }

    /**
     * Whether a secondary monitor may step past either end of the strip.
     *
     * The primary is excluded by the code that reads this, not by the setting:
     * it drives GNOME's real workspace, and wrapping it would slide backwards
     * across every workspace to arrive at the first one.
     *
     * @returns {boolean} true when wrapping is allowed
     */
    get wrapAround() {
        return this._settings?.get_boolean('wrap-around') ?? false;
    }

    /**
     * How long a slide should take, in milliseconds.
     *
     * @returns {number} duration in ms
     */
    get animationDuration() {
        return this._settings?.get_int('animation-duration') ?? DEFAULT_DURATION;
    }

    /**
     * Whether to write per-switch detail to the journal.
     *
     * Not exposed in the preferences window. It exists for diagnosing a
     * problem, and a user who needs it will be following instructions that
     * include the `gsettings` command anyway.
     *
     * @returns {boolean} true when verbose logging is on
     */
    get debugLogging() {
        return this._settings?.get_boolean('debug-logging') ?? false;
    }

    /**
     * Scales a gesture's own duration by the configured one.
     *
     * A swipe's length comes from how fast the fingers were moving, which is
     * what makes it feel attached to them. Replacing that with a fixed number
     * would throw the feel away, so the preference scales it instead: at the
     * default this is the identity.
     *
     * @param {number} [gestureDuration] - the tracker's duration, if any
     * @returns {number} duration to animate for, in ms
     */
    durationFor(gestureDuration) {
        const configured = this.animationDuration;
        if (gestureDuration === undefined || gestureDuration === null)
            return configured;

        return Math.max(1,
            Math.round(gestureDuration * configured / DEFAULT_DURATION));
    }

    /**
     * Stops listening.
     */
    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._settings = null;
    }

    /**
     * Records a preference change in the journal.
     *
     * @param {string} key - the key that changed
     * @private
     */
    _onChanged(key) {
        if (key === 'wrap-around')
            debug(`wrap-around now ${this.wrapAround}`);
        else if (key === 'animation-duration')
            debug(`slide duration now ${this.animationDuration}ms`);
        else if (key === 'debug-logging')
            setVerbose(this.debugLogging);
    }
}
