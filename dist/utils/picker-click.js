/** Map a click to an item index, or null when it landed outside the window. */
export function pickerClickIndex({ rows, count, pickerIndex, maxVisible, pressY, }) {
    if (count <= 0 || rows <= 10)
        return null;
    const windowSize = Math.max(3, Math.min(8, maxVisible));
    const start = Math.max(0, Math.min(pickerIndex - Math.floor(windowSize / 2), count - windowSize));
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
