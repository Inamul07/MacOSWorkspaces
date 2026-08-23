/*
 * MacOS Workspaces — cursor to monitor mapping
 * Copyright (C) 2026  MacOS Workspaces contributors
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Mtk from 'gi://Mtk';

/**
 * Resolves which physical monitor the pointer is currently over.
 *
 * A swipe carries no monitor of its own, so the pointer position is what
 * decides which display a gesture belongs to. Mutter maps regions rather than
 * points, hence the 1x1 rectangle.
 *
 * @returns {number} zero-based monitor index, or -1 if it cannot be resolved
 */
export function getCursorMonitorIndex() {
    // GNOME INTERNAL: shell/shell-global.c:shell_global_get_pointer
    const [x, y] = global.get_pointer();

    // GNOME INTERNAL: meta/display.h:meta_display_get_monitor_index_for_rect
    const pointerRect = new Mtk.Rectangle({x, y, width: 1, height: 1});
    const index = global.display.get_monitor_index_for_rect(pointerRect);

    // Mutter returns -1 when the point falls outside every monitor, which can
    // happen momentarily during a hotplug reconfiguration.
    return Number.isInteger(index) ? index : -1;
}
