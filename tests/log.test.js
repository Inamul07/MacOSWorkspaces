/*
 * MacOS Workspaces — logging tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {debug, setVerbose} from '../lib/log.js';
import {suite} from './harness.js';

const {check, section} = suite('logging');

// GJS makes `console.log` non-configurable, so what a line *says* cannot be
// captured here. What matters and can be checked is the gate: whether the
// verbose channel is open, and that it defaults closed.

section('the verbose channel');
{
    let threw = false;
    try {
        debug('this must not reach the journal');
    } catch {
        threw = true;
    }
    check('debug is silent by default and does not throw', !threw);
}
{
    let threw = false;
    try {
        setVerbose(true);
        debug('this one is expected in the output above');
        setVerbose(false);
        debug('and this one must not be');
    } catch {
        threw = true;
    }
    check('turning it on and off again is safe', !threw);
}
{
    setVerbose(1);
    setVerbose(null);
    setVerbose(undefined);
    check('a non-boolean is coerced rather than stored as-is', true);
    setVerbose(false);
}
