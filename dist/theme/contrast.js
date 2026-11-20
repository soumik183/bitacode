/**
 * Colour maths for the palettes.
 *
 * A terminal theme is judged by two things: does text stay readable, and do the
 * semantic colours stay distinguishable from each other. Both are measurable,
 * so the palettes are audited rather than eyeballed.
 *
 * Uses WCAG 2.1 relative luminance and contrast ratio. Body text targets AA
 * (4.5:1); chrome (borders, dim captions) only needs to be visible, so it is
 * held to 2.2:1 — below that it disappears on a phone in daylight.
 */
export function parseHex(hex) {
    const value = hex.trim().replace(/^#/, '');
    const full = value.length === 3 ? value.split('').map((ch) => ch + ch).join('') : value;
    if (!/^[0-9a-f]{6}$/i.test(full)) {
        throw new Error(`Not a hex colour: ${hex}`);
    }
    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
    };
}
/** WCAG relative luminance, 0 (black) … 1 (white). */
export function relativeLuminance(hex) {
    const { r, g, b } = parseHex(hex);
    const channel = (raw) => {
        const c = raw / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** WCAG contrast ratio between two colours, 1 … 21. */
export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}
/** Perceptual distance between two accents, so success/warning cannot coincide. */
export function colorDistance(a, b) {
    const ca = parseHex(a);
    const cb = parseHex(b);
    // Redmean approximation — cheap and close enough to CIE for "are these
    // obviously different colours" decisions.
    const rMean = (ca.r + cb.r) / 2;
    const dr = ca.r - cb.r;
    const dg = ca.g - cb.g;
    const db = ca.b - cb.b;
    return Math.sqrt((2 + rMean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rMean) / 256) * db * db);
}
/** Roles that must stay readable as body text. */
const TEXT_KEYS = ['text', 'userText', 'muted', 'placeholder', 'accent', 'error', 'success', 'info'];
/** Minimum ratios: body text is AA, chrome just has to be visible. */
const MIN_TEXT = 4.5;
const MIN_CHROME = 2.2;
/** Two semantic colours closer than this read as the same colour. */
const MIN_ACCENT_DISTANCE = 60;
/**
 * Audit one palette against the surfaces it is actually used on. Borders and
 * dim text are compared against both `bg` and `surface` because dialogs paint
 * `surface` behind most captions.
 */
export function auditTheme(theme) {
    const issues = [];
    let minTextRatio = Number.POSITIVE_INFINITY;
    for (const key of TEXT_KEYS) {
        const ratio = contrastRatio(theme[key], theme.bg);
        minTextRatio = Math.min(minTextRatio, ratio);
        const required = key === 'placeholder' ? MIN_CHROME + 0.8 : MIN_TEXT;
        if (ratio < required)
            issues.push({ pair: `${key} on bg`, ratio, required });
    }
    for (const key of ['border', 'dim']) {
        for (const surface of ['bg', 'surface']) {
            const ratio = contrastRatio(theme[key], theme[surface]);
            if (ratio < MIN_CHROME)
                issues.push({ pair: `${key} on ${surface}`, ratio, required: MIN_CHROME });
        }
    }
    const semantic = ['accent', 'success', 'error', 'info'];
    let minAccentDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < semantic.length; i++) {
        for (let j = i + 1; j < semantic.length; j++) {
            const distance = colorDistance(theme[semantic[i]], theme[semantic[j]]);
            minAccentDistance = Math.min(minAccentDistance, distance);
            if (distance < MIN_ACCENT_DISTANCE) {
                issues.push({ pair: `${String(semantic[i])} vs ${String(semantic[j])}`, ratio: distance, required: MIN_ACCENT_DISTANCE });
            }
        }
    }
    return {
        ok: issues.length === 0,
        minTextRatio: Number.isFinite(minTextRatio) ? minTextRatio : 0,
        minAccentDistance: Number.isFinite(minAccentDistance) ? minAccentDistance : 0,
        issues: issues.map((issue) => ({ ...issue, ratio: Number(issue.ratio.toFixed(2)) })),
    };
}
/** Human-readable audit line, used by `bitacode doctor`-style output. */
export function describeThemeAudit(name, audit) {
    const status = audit.ok ? 'ok' : `FAIL (${audit.issues.length})`;
    return `${name}: ${status} · min text ${audit.minTextRatio.toFixed(1)}:1 · accent spread ${audit.minAccentDistance.toFixed(0)}`;
}
