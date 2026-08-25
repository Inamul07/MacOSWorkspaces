/*
 * MacOS Workspaces — settings tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {SettingsManager} from '../lib/settings.js';
import {suite} from './harness.js';

const {check, section} = suite('settings');

function fakeSettings(values) {
    return {
        values,
        handlers: new Map(),
        nextId: 1,
        get_boolean(k) { return this.values[k]; },
        get_int(k) { return this.values[k]; },
        connect(name, fn) {
            const id = this.nextId++;
            this.handlers.set(id, {name, fn});
            return id;
        },
        disconnect(id) { this.handlers.delete(id); },
        emitChange(key) {
            for (const {name, fn} of this.handlers.values()) {
                if (name === 'changed')
                    fn(this, key);
            }
        },
    };
}

section('reading');
{
    const gio = fakeSettings({'wrap-around': true, 'animation-duration': 400});
    const s = new SettingsManager(gio);
    check('wrap-around read from the schema', s.wrapAround === true);
    check('duration read from the schema', s.animationDuration === 400);

    // Values are read at the point of use, never cached, so a change needs no
    // notification to take effect.
    gio.values['wrap-around'] = false;
    check('a changed value is seen immediately', s.wrapAround === false);
    s.destroy();
}

section('duration');
{
    const s = new SettingsManager(fakeSettings({'animation-duration': 400}));
    check('a keystroke gets the configured duration outright',
        s.durationFor(undefined) === 400, `(got ${s.durationFor(undefined)})`);
    check('a swipe keeps its velocity, scaled by the preference',
        s.durationFor(125) === 200, `(got ${s.durationFor(125)})`);
    check('null is treated as no gesture duration', s.durationFor(null) === 400);
    s.destroy();
}
{
    const s = new SettingsManager(fakeSettings({'animation-duration': 250}));
    check('at the default the scaling is the identity', s.durationFor(137) === 137,
        `(got ${s.durationFor(137)})`);
    check('a very fast flick never rounds down to zero', s.durationFor(0) === 1,
        `(got ${s.durationFor(0)})`);
    s.destroy();
}

section('debug logging');
{
    const gio = fakeSettings({'debug-logging': true});
    const s = new SettingsManager(gio);
    check('the hidden key is read like any other', s.debugLogging === true);
    gio.values['debug-logging'] = false;
    check('and read again at the point of use', s.debugLogging === false);
    s.destroy();
}
{
    const s = new SettingsManager(fakeSettings({}));
    check('a missing key is off, not undefined', s.debugLogging === false);
    s.destroy();
}

section('without a schema');
{
    const s = new SettingsManager(null);
    check('falls back to stock behaviour rather than throwing',
        s.wrapAround === false && s.animationDuration === 250);
    s.destroy();
}

section('teardown');
{
    const gio = fakeSettings({'wrap-around': false, 'animation-duration': 250});
    const s = new SettingsManager(gio);
    check('listening while alive', gio.handlers.size === 1);
    gio.emitChange('wrap-around');
    s.destroy();
    check('disconnected on destroy', gio.handlers.size === 0);
    s.destroy();
    check('destroy is safe twice', true);
}

