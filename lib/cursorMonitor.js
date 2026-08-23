/*
 * MacOS Workspaces — cursor to monitor mapping
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/**
 * Resolves which physical monitor the pointer is currently over.
 *
 * A swipe carries no monitor of its own, so the pointer position is what
 * decides which display a gesture belongs to. Mutter maps regions rather than
 * points, hence the 1x1 rectangle.
 *
 * Takes its Shell access from an injected interop bundle so this module stays
 * importable — and testable — outside a running Shell.
 *
 * @param {object} interop - from `shellInterop.createInterop()`
 * @returns {number} zero-based monitor index, or -1 if it cannot be resolved
 */
export function getCursorMonitorIndex(interop) {
    const [x, y] = interop.getPointer();
    const index = interop.getMonitorIndexForRect(x, y, 1, 1);

    // Mutter returns -1 when the point falls outside every monitor, which can
    // happen momentarily during a hotplug reconfiguration.
    return Number.isInteger(index) ? index : -1;
}
