/*
 * MacOS Workspaces — logging
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Prefix every line carries, so the journal can be filtered on it. */
const TAG = '[macos-workspaces]';

/** Whether the verbose channel is open. @type {boolean} */
let verbose = false;

/**
 * Opens or closes the verbose channel.
 *
 * Follows the `debug-logging` setting. Off by default: this extension acts on
 * every workspace switch and every window it re-parks, and narrating all of that
 * into a user's journal forever is not a reasonable default. The lines are worth
 * keeping, though — nearly every bug found in this project was found by reading
 * them — so they are one `gsettings` command away rather than deleted.
 *
 * @param {boolean} enabled - whether to emit debug lines
 */
export function setVerbose(enabled) {
    verbose = !!enabled;
}

/**
 * A line that only matters when something is being diagnosed.
 *
 * Per-switch and per-window detail belongs here.
 *
 * @param {string} message - what happened
 */
export function debug(message) {
    if (verbose)
        console.log(`${TAG} ${message}`);
}

/**
 * A line worth keeping in every user's journal.
 *
 * Reserved for lifecycle: enabling, disabling, and whether the feature that
 * moves windows is running at all. Someone reading an unfamiliar journal should
 * be able to tell those three things and nothing more.
 *
 * @param {string} message - what happened
 */
export function info(message) {
    console.log(`${TAG} ${message}`);
}

/**
 * Something the user probably needs to act on.
 *
 * @param {string} message - what is wrong
 */
export function warn(message) {
    console.warn(`${TAG} ${message}`);
}

/**
 * Something that stopped this extension working.
 *
 * @param {string} message - what failed
 */
export function error(message) {
    console.error(`${TAG} ${message}`);
}
