/** Pure helpers that turn file tool results into UI-friendly data. */
import { isAbsolute, relative, resolve } from 'node:path';
const FILE_TOOLS = new Set(['edit_file', 'write_file']);
function isSuccessfulMutation(result) {
    return /^Successfully (edited|wrote)\b/i.test(result.trim());
}
/** File metadata that makes a terminal diff noisier than it needs to be. */
function isMetadataLine(line) {
    return (line.startsWith('Index: ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('\\ No newline') ||
        /^=+$/.test(line));
}
function parseArgs(args) {
    if (!args)
        return {};
    if (typeof args === 'object')
        return args;
    try {
        const parsed = JSON.parse(args);
        return parsed && typeof parsed === 'object' ? parsed : {};
    }
    catch {
        return {};
    }
}
function argFilePath(args) {
    const filePath = parseArgs(args).file_path;
    return typeof filePath === 'string' && filePath.trim() ? filePath : undefined;
}
/** Path relative to the project folder, so file boxes stay short. */
export function displayFilePath(filePath) {
    const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
    const rel = relative(process.cwd(), absolute).replace(/\\/g, '/');
    return rel && !rel.startsWith('..') ? rel : filePath;
}
/**
 * Returns the header, unified diff and relative file path for a successful
 * file mutation. Errors, cancellations and unrelated tools return null so
 * callers can fall back to their normal one-line result rendering.
 */
export function parseFileMutationDiff(toolName, args, result) {
    if (!FILE_TOOLS.has(toolName) || !isSuccessfulMutation(result))
        return null;
    const filePath = argFilePath(args);
    const operation = toolName === 'write_file' ? 'Wrote' : 'Edited';
    const text = result.trim();
    const lines = text.split('\n');
    const start = lines.findIndex((line) => line.startsWith('Index: ') || line.startsWith('--- ') || line.startsWith('@@'));
    if (start !== -1) {
        const header = lines
            .slice(0, start)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !/^=+$/.test(line))
            .join(' ');
        return { header: header || text, diff: lines.slice(start).join('\n'), filePath, operation };
    }
    // Older write_file results had no diff: show the write as pure additions.
    if (toolName === 'write_file') {
        const { content } = parseArgs(args);
        if (typeof content === 'string') {
            const contentLines = content.replace(/\r\n/g, '\n').split('\n');
            if (contentLines[contentLines.length - 1] === '')
                contentLines.pop();
            return {
                header: text,
                diff: contentLines.map((line) => `+${line}`).join('\n'),
                filePath,
                operation,
            };
        }
    }
    return { header: text, diff: '', filePath, operation };
}
/** Adds old/new file line numbers to unified diff lines. */
export function annotateDiff(diff) {
    const raw = diff ? diff.split('\n') : [];
    const lines = raw.filter((line, index) => !isMetadataLine(line) && !(index === raw.length - 1 && line === ''));
    let oldLine = 0;
    let newLine = 0;
    let fallbackLine = 1;
    let sawHunk = false;
    return lines.map((line) => {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
            sawHunk = true;
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            return { kind: 'hunk', text: line };
        }
        if (line.startsWith('+')) {
            const number = sawHunk ? newLine++ : fallbackLine++;
            return { kind: 'add', number, text: line.slice(1) };
        }
        if (line.startsWith('-')) {
            const number = sawHunk ? oldLine++ : fallbackLine++;
            return { kind: 'remove', number, text: line.slice(1) };
        }
        if (line.startsWith(' ')) {
            const number = sawHunk ? newLine : fallbackLine++;
            if (sawHunk) {
                oldLine++;
                newLine++;
            }
            return { kind: 'context', number, text: line.slice(1) };
        }
        return { kind: 'meta', text: line };
    });
}
/**
 * Turns a read_file result into a compact preview. Handles both a single
 * offset/limit read and range sections like "[lines 2-50]". Large reads are
 * capped by the caller so one file cannot flood the scrollback.
 */
export function parseFileReadResult(toolName, args, result) {
    if (toolName !== 'read_file' || /^(Error\b|File not found\b|Operation cancelled\b|\(no lines read\b)/i.test(result.trim())) {
        return null;
    }
    const parsedArgs = parseArgs(args);
    const offset = typeof parsedArgs.offset === 'number' && parsedArgs.offset > 0 ? Math.floor(parsedArgs.offset) : 0;
    const raw = result.split('\n');
    if (raw.length > 0 && raw[raw.length - 1] === '')
        raw.pop();
    const sections = [];
    let current = null;
    for (const line of raw) {
        const header = /^\[lines (\d+)-(\d+)\]$/.exec(line);
        if (header) {
            current = {
                startLine: Number(header[1]),
                endLine: Number(header[2]),
                lines: [],
            };
            sections.push(current);
            continue;
        }
        if (!current)
            continue;
        if (/^\.\.\. \(file ends at line \d+\)$/.test(line) || /^\((empty file|no lines: file has \d+ line\(s\))\)$/.test(line)) {
            current.note = line;
            continue;
        }
        current.lines.push(line);
    }
    if (sections.length > 0) {
        let totalLines;
        for (const section of sections) {
            const note = section.note ?? '';
            const ends = /file ends at line (\d+)/.exec(note);
            const noLines = /no lines: file has (\d+) line\(s\)/.exec(note);
            if (ends)
                totalLines = Number(ends[1]);
            else if (noLines)
                totalLines = Number(noLines[1]);
            else if (note === '(empty file)')
                totalLines = 0;
        }
        return { filePath: argFilePath(args), sections, totalLines };
    }
    const lines = [...raw];
    const moreMatch = /^\.\.\. \((\d+) more line\(s\); use offset=\d+ to continue\)$/.exec(lines[lines.length - 1] ?? '');
    const moreLines = moreMatch ? Number(moreMatch[1]) : 0;
    if (moreMatch)
        lines.pop();
    if (lines.length === 1 && lines[0] === '')
        lines.pop();
    return {
        filePath: argFilePath(args),
        totalLines: offset + lines.length + moreLines,
        sections: [
            {
                startLine: offset + 1,
                endLine: offset + lines.length,
                lines,
                note: moreLines > 0 ? `… ${moreLines} more line${moreLines === 1 ? '' : 's'}` : undefined,
            },
        ],
    };
}
/** Describes a parsed read as one of: whole file, line range, or empty. */
export function describeRead(display) {
    const filePath = display?.filePath ? displayFilePath(display.filePath) : 'file';
    const sections = Array.isArray(display?.sections) ? display.sections : [];
    const readLines = sections.reduce((total, section) => total + (Array.isArray(section?.lines) ? section.lines.length : 0), 0);
    if (readLines === 0)
        return { filePath, empty: true };
    const total = display?.totalLines;
    if (typeof total === 'number' && total > 0) {
        const covered = sections
            .filter((section) => section && Array.isArray(section.lines) && section.lines.length > 0 && typeof section.startLine === 'number')
            .map((section) => ({ start: section.startLine, end: section.startLine + section.lines.length - 1 }))
            .sort((a, b) => a.start - b.start);
        let cursor = 1;
        let whole = covered.length > 0;
        for (const segment of covered) {
            if (segment.start > cursor) {
                whole = false;
                break;
            }
            cursor = Math.max(cursor, segment.end + 1);
        }
        if (whole && cursor - 1 >= total)
            return { filePath, total };
    }
    const range = sections
        .filter((section) => section && typeof section.startLine === 'number')
        .map((section) => {
        const count = Array.isArray(section.lines) ? section.lines.length : 0;
        if (count > 0)
            return `${section.startLine}-${section.startLine + count - 1}`;
        if (typeof section.endLine === 'number' && section.endLine > 0)
            return `${section.startLine}-${section.endLine}`;
        return `${section.startLine}`;
    })
        .join(', ');
    return range ? { filePath, range } : { filePath, empty: true };
}
