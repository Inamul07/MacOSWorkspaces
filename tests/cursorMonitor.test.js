/*
 * MacOS Workspaces — cursor to monitor mapping tests
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import {getCursorMonitorIndex} from '../lib/cursorMonitor.js';
import {suite} from './harness.js';

const {check, section} = suite('cursor to monitor mapping');

/**
 * An interop whose pointer and monitor lookup are both under the test's control.
 *
 * @param {number[]} pointer - where the pointer is
 * @param {*} answer - what mutter returns for the lookup
 * @returns {object} the interop double, and the rectangle it was asked about
 */
function harness(pointer, answer) {
    const asked = [];
    return {
        asked,
        interop: {
            getPointer: () => pointer,
            getMonitorIndexForRect: (x, y, width, height) => {
                asked.push([x, y, width, height]);
                return answer;
            },
        },
    };
}

section('resolving the pointer');
{
    const h = harness([1400, 300], 1);
    check('the monitor mutter names is the answer',
        getCursorMonitorIndex(h.interop) === 1);
    check('asked about a 1x1 rectangle at the pointer, since mutter maps regions',
        JSON.stringify(h.asked) === '[[1400,300,1,1]]', JSON.stringify(h.asked));
}
{
    const h = harness([0, 0], 0);
    check('the origin resolves like anywhere else',
        getCursorMonitorIndex(h.interop) === 0);
}

section('when it cannot be resolved');
{
    // Mutter answers -1 for a point on no monitor, which happens for a moment
    // while a display is being reconfigured.
    check('a point on no monitor stays -1',
        getCursorMonitorIndex(harness([9999, 9999], -1).interop) === -1);
    check('null is reported as unresolved rather than passed on',
        getCursorMonitorIndex(harness([0, 0], null).interop) === -1);
    check('undefined likewise',
        getCursorMonitorIndex(harness([0, 0], undefined).interop) === -1);
    check('a non-integer answer is refused, not rounded',
        getCursorMonitorIndex(harness([0, 0], 1.5).interop) === -1);
}
