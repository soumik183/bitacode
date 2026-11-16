import { jsx as _jsx } from "react/jsx-runtime";
import { Text } from 'ink';
/**
 * Normalize text for transcript display.
 * - Collapses multiple consecutive newlines into a single newline
 * - Trims leading/trailing whitespace
 * - Returns empty string if text is empty/whitespace only
 */
export function normalizeTranscriptText(text) {
    if (!text || !text.trim()) {
        return '';
    }
    // Collapse multiple newlines to single, trim ends
    return text.replace(/\n{2,}/g, '\n').trim();
}
function parseSegments(text) {
    const segments = [];
    // Strip markdown headers
    const cleaned = text.replace(/^#+\s+/gm, '');
    // Pattern to match ***bold italic***, **bold**, *italic*
    const pattern = /(\*\*\*[^*]+?\*\*\*|\*\*[^*]+?\*\*|\*[^\s*][^*]*?\*)/g;
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(cleaned)) !== null) {
        // Add plain text before match
        if (match.index > lastIndex) {
            segments.push({ text: cleaned.slice(lastIndex, match.index) });
        }
        const fullMatch = match[0];
        let content;
        let bold = false;
        let italic = false;
        if (fullMatch.startsWith('***')) {
            content = fullMatch.slice(3, -3);
            bold = true;
            italic = true;
        }
        else if (fullMatch.startsWith('**')) {
            content = fullMatch.slice(2, -2);
            bold = true;
        }
        else {
            content = fullMatch.slice(1, -1);
            italic = true;
        }
        segments.push({ text: content, bold, italic });
        lastIndex = pattern.lastIndex;
    }
    // Add remaining plain text
    if (lastIndex < cleaned.length) {
        segments.push({ text: cleaned.slice(lastIndex) });
    }
    return segments.length > 0 ? segments : [{ text: cleaned }];
}
/**
 * Render formatted text as Ink Text elements.
 * Returns an array of <Text> components that can be nested inside a parent <Text>.
 */
export function renderFormattedText(text) {
    const segments = parseSegments(text);
    if (segments.length === 1 && !segments[0].bold && !segments[0].italic) {
        return segments[0].text;
    }
    return segments.map((seg, i) => (_jsx(Text, { bold: seg.bold, italic: seg.italic, children: seg.text }, i)));
}
