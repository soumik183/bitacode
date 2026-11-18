/**
 * Decide the next expansion state when the "reasoning is live" flag changes.
 *
 * - reasoning starts  -> expand and clear any stale manual pin
 * - reasoning ends    -> collapse, unless the user pinned it this phase
 * - no change         -> leave everything untouched
 */
export function nextThinkingExpansion({ active, wasActive, pinned, expanded, }) {
    if (active === wasActive) {
        return { expanded, pinned };
    }
    if (active) {
        return { expanded: true, pinned: false };
    }
    if (pinned) {
        return { expanded, pinned };
    }
    return { expanded: false, pinned };
}
