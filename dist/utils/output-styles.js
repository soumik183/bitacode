/**
 * output-styles.ts — session voice/tone presets.
 *
 * A built-in style is one short prompt fragment. Custom styles are Markdown
 * files in `~/.config/bitacode/output-styles/` or
 * `<cwd>/.bitacode/output-styles/` with optional frontmatter `name` /
 * `description`. Project styles override user styles with the same id.
 *
 * Everything here is synchronous, cheap and never throws: a bad style file is
 * skipped, not fatal.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const DEFAULT_OUTPUT_STYLE = 'default';
const BUILTIN = [
    {
        id: 'default',
        name: 'Default',
        description: 'Balanced, direct engineering assistant.',
        body: '',
        source: 'builtin',
    },
    {
        id: 'concise',
        name: 'Concise',
        description: 'Shortest correct answer, no filler.',
        body: 'Be maximally concise. Lead with the result, skip preamble, and never restate the request. Prefer short sentences and flat lists.',
        source: 'builtin',
    },
    {
        id: 'explanatory',
        name: 'Explanatory',
        description: 'Explain the why and the tradeoffs.',
        body: 'Explain your reasoning and the tradeoffs behind non-obvious choices. Teach the mechanism, not just the change.',
        source: 'builtin',
    },
    {
        id: 'learning',
        name: 'Learning',
        description: 'Guide the user instead of doing everything.',
        body: 'Prefer guiding the user to the answer over handing it over. Explain concepts, point at the relevant code, and leave small deliberate gaps for them to complete.',
        source: 'builtin',
    },
    {
        id: 'proactive',
        name: 'Proactive',
        description: 'Anticipate follow-ups and next steps.',
        body: 'Anticipate the next likely request. Mention adjacent issues and offer one concrete next step, without doing unrequested work.',
        source: 'builtin',
    },
];
function userStyleDir(home) {
    return path.join(home, '.config', 'bitacode', 'output-styles');
}
function projectStyleDir(cwd) {
    return path.join(cwd, '.bitacode', 'output-styles');
}
function slug(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'style';
}
/** Split optional `---` frontmatter from a Markdown body. Tolerant by design. */
function parseStyleMarkdown(raw) {
    const text = raw.replace(/\r\n/g, '\n');
    if (!text.startsWith('---'))
        return { body: text.trim() };
    const end = text.indexOf('\n---', 3);
    if (end === -1)
        return { body: text.trim() };
    const header = text.slice(3, end).trim();
    const body = text.slice(end + 4).replace(/^\n/, '').trim();
    const meta = {};
    for (const line of header.split('\n')) {
        const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (match)
            meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
    return {
        ...(meta.name ? { name: meta.name } : {}),
        ...(meta.description ? { description: meta.description } : {}),
        body,
    };
}
function readDirStyles(dir, source) {
    let entries;
    try {
        entries = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const styles = [];
    for (const entry of entries.sort()) {
        if (!entry.endsWith('.md'))
            continue;
        try {
            const raw = fs.readFileSync(path.join(dir, entry), 'utf8');
            const parsed = parseStyleMarkdown(raw);
            if (!parsed.body)
                continue;
            const id = slug(entry.slice(0, -3));
            styles.push({
                id,
                name: parsed.name ?? id,
                description: parsed.description ?? '',
                body: parsed.body,
                source,
            });
        }
        catch {
            // Unreadable or malformed style file — skip it.
        }
    }
    return styles;
}
/**
 * Every style visible from `cwd`, nearest wins: project overrides user
 * overrides built-in. Built-ins keep their canonical order first.
 */
export function listOutputStyles(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const home = options.home ?? os.homedir();
    const byId = new Map();
    for (const style of BUILTIN)
        byId.set(style.id, style);
    for (const style of readDirStyles(userStyleDir(home), 'user'))
        byId.set(style.id, style);
    for (const style of readDirStyles(projectStyleDir(cwd), 'project'))
        byId.set(style.id, style);
    return [...byId.values()];
}
export function getOutputStyle(id, options = {}) {
    const wanted = (id ?? DEFAULT_OUTPUT_STYLE).trim();
    const styles = listOutputStyles(options);
    return styles.find((style) => style.id === wanted)
        ?? styles.find((style) => style.id === DEFAULT_OUTPUT_STYLE)
        ?? BUILTIN[0];
}
/** Prompt section for the active style; empty for the default style. */
export function outputStyleSection(id, options = {}) {
    const style = getOutputStyle(id, options);
    if (!style.body)
        return '';
    return `\n# OUTPUT STYLE: ${style.name}\n${style.body}\n`;
}
