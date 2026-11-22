/**
 * Geometry for mouse-clicking a row in a centred DialogList picker.
 *
 * Yoga centres an odd leftover half-row UP, while JS `Math.floor` rounds DOWN.
 * Keeping the arithmetic here (and tested against real rendered frames) avoids
 * an off-by-one that opened the wrong subagent on roughly half terminal sizes.
 */
export interface PickerClickGeometry {
  /** Terminal rows. */
  rows: number;
  /** Number of items in the picker. */
  count: number;
  /** Currently selected index. */
  pickerIndex: number;
  /** Max visible rows (8 for DialogList). */
  maxVisible: number;
  /** 1-based row from the SGR mouse report. */
  pressY: number;
}

/** Map a click to an item index, or null when it landed outside the window. */
export function pickerClickIndex({
  rows, count, pickerIndex, maxVisible, pressY,
}: PickerClickGeometry): number | null {
  if (count <= 0 || rows <= 10) return null;
  const windowSize = Math.max(3, Math.min(8, maxVisible));
  const start = Math.max(
    0,
    Math.min(pickerIndex - Math.floor(windowSize / 2), count - windowSize),
  );
  const visibleCount = Math.min(windowSize, count - start);
  const hiddenAbove = start > 0 ? 1 : 0;
  const hiddenBelow = count - start - visibleCount > 0 ? 1 : 0;
  const counter = count > windowSize ? 1 : 0;
  const cardHeight = 6 + visibleCount + hiddenAbove + hiddenBelow + counter;
  const cardTop = Math.max(0, Math.ceil((rows - cardHeight) / 2));
  const firstRowY = cardTop + 3 + hiddenAbove;
  const clicked = start + (pressY - 1 - firstRowY);
  return clicked >= start && clicked < start + visibleCount ? clicked : null;
}
