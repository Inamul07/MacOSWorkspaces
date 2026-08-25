/*
 * MacOS Workspaces — unit test runner
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Usage: gjs -m tests/run.js
 */

import System from 'system';

// Importing a test file runs it: the checks are the module's body, and each
// registers its results with the harness. They are listed rather than
// discovered so that a file which fails to load is a hard error here instead of
// silently contributing nothing — a test suite that quietly shrinks is worse
// than one that breaks.
import './animationDriver.test.js';
import './cursorMonitor.test.js';
import './externalWatcher.test.js';
import './gestureHandler.test.js';
import './keybindingHandler.test.js';
import './log.test.js';
import './monitorState.test.js';
import './settings.test.js';
import './windowTracker.test.js';
import './workspaceReassigner.test.js';

import {results} from './harness.js';

const suites = results();
const passed = suites.reduce((total, s) => total + s.passed, 0);
const failed = suites.reduce((total, s) => total + s.failed, 0);

print('\n' + '─'.repeat(60));
for (const s of suites) {
    const status = s.failed ? `\x1b[31m${s.failed} failed\x1b[0m` : '\x1b[32mok\x1b[0m';
    print(`  ${s.name.padEnd(34)} ${String(s.passed).padStart(3)} checks   ${status}`);
}
print('─'.repeat(60));

if (failed) {
    print(`\n\x1b[31m${failed} of ${passed + failed} checks failed:\x1b[0m`);
    for (const s of suites) {
        for (const failure of s.failures)
            print(`  · ${failure}`);
    }
    print('');
    System.exit(1);
}

print(`\n\x1b[32m${passed} checks passed\x1b[0m across ${suites.length} suites\n`);
