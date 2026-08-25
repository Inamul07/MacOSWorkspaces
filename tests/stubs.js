/*
 * MacOS Workspaces — doubles for the Shell objects the extension talks to
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * The pieces of GNOME Shell this extension drives, in fake form.
 *
 * Standalone `gjs` cannot import `resource:///org/gnome/shell/*` and has no
 * typelib for Mtk, Meta, Clutter or Shell, so none of the real objects exist out
 * here. Every module except `shellInterop.js` takes its Shell access as an
 * injected bundle precisely so these can stand in.
 *
 * These are deliberately thin. A double that grows behaviour of its own starts
 * testing itself rather than the code, and it will drift from the real object
 * without anything failing to say so.
 */

/**
 * A GObject-style signal source, without needing GObject.
 *
 * Enough for `connect`/`disconnect`/emit, which is all the extension uses on
 * `workspace_manager` and `layoutManager`. Handler ids count from 1 so that a
 * falsy id means "not connected", matching how the real ones are checked.
 */
export class Signaller {
    constructor() {
        this._handlers = new Map();
        this._nextId = 1;
    }

    /**
     * @param {string} name - signal name
     * @param {Function} fn - handler
     * @returns {number} handler id
     */
    connect(name, fn) {
        const id = this._nextId++;
        this._handlers.set(id, {name, fn});
        return id;
    }

    /**
     * @param {number} id - handler id from `connect`
     */
    disconnect(id) {
        this._handlers.delete(id);
    }

    /**
     * Fires every handler attached to one signal.
     *
     * Iterates a copy, so a handler that disconnects itself cannot corrupt the
     * walk — which the real GObject also tolerates.
     *
     * @param {string} name - signal name
     * @param {...any} args - handler arguments
     */
    emit(name, ...args) {
        for (const handler of [...this._handlers.values()]) {
            if (handler.name === name)
                handler.fn(...args);
        }
    }

    /**
     * How many handlers are attached, for leak checks after `destroy()`.
     *
     * @returns {number} handler count
     */
    get handlerCount() {
        return this._handlers.size;
    }
}

/**
 * A strip of workspaces that remembers which one is active.
 *
 * `Meta.Workspace` exposes `index()` as a method and `active` as a property,
 * and the extension calls `activate()` on exactly one of them, so the doubles
 * keep those shapes.
 *
 * @param {number} count - how many workspaces
 * @param {number} [active] - which one starts active
 * @returns {object} a workspace table
 */
export function makeWorkspaces(count, active = 0) {
    const table = {
        active,
        activations: [],
        workspaces: new Map(),

        /**
         * @param {number} index - workspace index
         * @returns {?object} the workspace, or null when out of range
         */
        at(index) {
            if (index < 0 || index >= count)
                return null;

            if (!this.workspaces.has(index)) {
                this.workspaces.set(index, {
                    index: () => index,
                    get active() {
                        return table.active === index;
                    },
                    activate(time) {
                        table.activations.push([index, time]);
                        table.active = index;
                    },
                });
            }

            return this.workspaces.get(index);
        },
    };

    return table;
}

/**
 * A `MonitorGroup` double whose progress is measured in whole workspaces.
 *
 * The real one converts progress to pixels and back, and handles right-to-left
 * and vertical layouts on the way. None of that is ours to test — the extension
 * drives `getWorkspaceProgress()` and `findClosestWorkspace()` precisely so the
 * Shell keeps doing it. Making progress equal the workspace index keeps the
 * assertions about *which workspace*, which is what the extension decides.
 *
 * @param {number} index - monitor index
 * @param {object} workspaces - from `makeWorkspaces()`
 * @returns {object} a MonitorGroup double
 */
export function makeMonitorGroup(index, workspaces) {
    return {
        index,
        progress: null,
        eased: null,
        cleared: 0,
        baseDistance: 100,
        updates: [],

        getSnapPoints: () => [0, 1, 2, 3],
        getWorkspaceProgress: workspace => workspace.index(),
        findClosestWorkspace: progress => workspaces.at(Math.round(progress)),

        updateSwipeForMonitor(progress) {
            this.updates.push(progress);
            this.progress = progress;
        },

        ease_property(property, target, params) {
            this.eased = {property, target, params};
        },

        /**
         * Clutter stops a running transition here, so the callback fires with
         * `isFinished` false — which is exactly the case the driver has to
         * handle, and the reason it settles from `onStopped`.
         */
        remove_all_transitions() {
            this.cleared++;
            const running = this.eased;
            this.eased = null;
            running?.params.onStopped?.(false);
        },
    };
}
