/*
 * MacOS Workspaces — the test harness
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * Every suite that has registered itself, in import order.
 *
 * A test file *is* its side effect: importing it runs its checks. `run.js`
 * imports them all and then reads this, which is why no file needs to know it
 * is being run as part of a suite rather than on its own.
 *
 * @type {Array<{name: string, passed: number, failed: number, failures: string[]}>}
 */
const suites = [];

/**
 * Opens a suite and returns the two functions its checks are written with.
 *
 * @param {string} name - what this file covers, e.g. 'animation driver'
 * @returns {{section: Function, check: Function}} the reporting functions
 */
export function suite(name) {
    const record = {name, passed: 0, failed: 0, failures: []};
    suites.push(record);

    print(`\n\x1b[1m▌ ${name}\x1b[0m`);

    return {
        /**
         * Announces a group of related checks.
         *
         * @param {string} title - what the group is about
         */
        section(title) {
            print(`\n  ── ${title}`);
        },

        /**
         * Records one check.
         *
         * @param {string} description - what should be true, in plain words
         * @param {boolean} condition - whether it is
         * @param {string} [detail] - what was seen instead, on failure
         */
        check(description, condition, detail = '') {
            if (condition) {
                record.passed++;
                print(`     \x1b[32mok\x1b[0m   ${description}`);
                return;
            }

            record.failed++;
            record.failures.push(`${name}: ${description} ${detail}`.trimEnd());
            print(`     \x1b[31mFAIL\x1b[0m ${description} ${detail}`);
        },
    };
}

/**
 * Every suite's results, for the runner to total up.
 *
 * @returns {Array<object>} suite records
 */
export function results() {
    return suites;
}
