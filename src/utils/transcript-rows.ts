/**
 * Row-count resolution for one transcript entry.
 *
 * A card keeps two prebuilt nodes (collapsed and expanded) and swaps them on
 * click. Ink measures whichever node is currently rendered, so a single
 * per-id height cache made collapse behave wrongly: the id still carried the
 * expanded measurement until the next render, and the transcript reserved that
 * tall block — the "box stays long after I close it" bug.
 *
 * Heights are therefore keyed per node first. The id cache is only a fallback
 * for the very first paint of a node that has not been measured yet.
 */
export interface ItemRowInput {
  /** Estimate for live content that changes every frame. */
  live?: number;
  /** Previously measured height of this exact node. */
  node?: number;
  /** Last height measured for this transcript id. */
  measured?: number;
  /** Structural guess when nothing has been measured. */
  fallback: number;
}

/** Priority: live estimate → node measurement → id measurement → fallback. */
export function resolveItemRows(input: ItemRowInput): number {
  for (const candidate of [input.live, input.node, input.measured, input.fallback]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return Math.max(1, Math.round(candidate));
    }
  }
  return 1;
}
