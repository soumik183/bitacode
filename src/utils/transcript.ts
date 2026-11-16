import type { ReactNode } from 'react';

/** Alternate rendering for a transcript item the user can toggle in place. */
export interface StaticToggleContent {
  collapsed: ReactNode;
  expanded: ReactNode;
}

/** Append one row group to the transcript, optionally with expand/collapse. */
export type AddStaticFn = (node: ReactNode, toggle?: StaticToggleContent) => void;

export interface RowItem {
  id: string;
  rows: number;
}

/**
 * Map a terminal row inside the transcript viewport back to the item rendered
 * there. `topPad` blank rows come first, followed by the item boxes in order;
 * `trimTop` is an extra count of rows skipped before the first box.
 *
 * The viewport clips a partly scrolled-off first item with a negative margin
 * inside a fixed-height, overflow-hidden wrapper rather than drawing a spacer
 * for the trimmed rows. So the App passes that item with its hidden top rows
 * already removed from `rows` and `trimTop = 0`.
 */
export function itemAtViewportRow(
  items: RowItem[],
  viewportRow: number,
  topPad: number,
  trimTop: number
): string | null {
  let cursor = topPad + trimTop;
  for (const item of items) {
    const rows = Math.max(0, item.rows);
    if (viewportRow >= cursor && viewportRow < cursor + rows) return item.id;
    cursor += rows;
  }
  return null;
}
