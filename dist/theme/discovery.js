/**
 * Discovery and validation of user-supplied theme files.
 *
 * Themes are deliberately treated as opaque validated records: this module
 * never interprets a colour value, it only decides whether a JSON/JSONC file
 * is structurally safe enough to hand to the rest of the UI. Broken files are
 * logged and skipped so a bad theme can never stop the TUI from starting.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
const MAX_THEME_FILES = 100;
const MAX_THEME_BYTES = 256 * 1024;
/**
 * Keys that make a record look like a theme. Any one of them holding a string
 * is enough; the rest of the palette is the caller's responsibility.
 */
const COLOR_KEYS = [
    'background',
    'foreground',
    'primary',
    'accent',
    'text',
    'bg',
    'fg',
    'surface',
    'surfaceAlt',
    'border',
    'borderFocus',
    'muted',
    'dim',
    'error',
    'success',
    'info',
    'userText',
    'userBorder',
    'placeholder',
];
let cachedJsoncParser;
/**
 * `jsonc-parser` is a declared dependency, but discovery must still work if it
 * is unavailable (e.g. a stripped-down install). Resolve it lazily so a
 * missing module never breaks importing this file.
 */
function getJsoncParser() {
    if (cachedJsoncParser !== undefined)
        return cachedJsoncParser;
    try {
        const require = createRequire(import.meta.url);
        const parser = require('jsonc-parser').parse;
        cachedJsoncParser = typeof parser === 'function' ? parser : null;
    }
    catch {
        cachedJsoncParser = null;
    }
    return cachedJsoncParser;
}
function isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Minimal JSONC fallback used only when `jsonc-parser` cannot be loaded. It
 * strips comments and trailing commas without touching comment-like sequences
 * inside string literals.
 */
function stripJsonc(text) {
    const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    let out = '';
    let inString = false;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        const next = source[i + 1];
        if (lineComment) {
            if (char === '\n' || char === '\r') {
                lineComment = false;
                out += char;
            }
            continue;
        }
        if (blockComment) {
            if (char === '*' && next === '/') {
                blockComment = false;
                i += 1;
            }
            else if (char === '\n' || char === '\r') {
                out += char;
            }
            continue;
        }
        if (inString) {
            out += char;
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === '/' && next === '/') {
            lineComment = true;
            i += 1;
            continue;
        }
        if (char === '/' && next === '*') {
            blockComment = true;
            i += 1;
            continue;
        }
        out += char;
    }
    // Drop trailing commas, again only outside strings.
    let cleaned = '';
    inString = false;
    escaped = false;
    for (let i = 0; i < out.length; i += 1) {
        const char = out[i];
        if (inString) {
            cleaned += char;
            if (escaped)
                escaped = false;
            else if (char === '\\')
                escaped = true;
            else if (char === '"')
                inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            cleaned += char;
            continue;
        }
        if (char === ',') {
            let lookahead = i + 1;
            while (lookahead < out.length && /\s/.test(out[lookahead]))
                lookahead += 1;
            if (out[lookahead] === '}' || out[lookahead] === ']')
                continue;
        }
        cleaned += char;
    }
    return cleaned;
}
/** Parse a theme file into a plain record; returns `null` for any bad input. */
function parseThemeText(text, jsonc) {
    try {
        // Node's UTF-8 decoder keeps a leading BOM as U+FEFF, which neither
        // JSON.parse nor jsonc-parser accepts. Strip it in every parse branch.
        const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
        let value;
        if (jsonc) {
            const parser = getJsoncParser();
            if (parser) {
                const errors = [];
                value = parser(source, errors, { allowTrailingComma: true });
                if (errors.length > 0)
                    return null;
            }
            else {
                value = JSON.parse(stripJsonc(source));
            }
        }
        else {
            value = JSON.parse(source);
        }
        return isPlainObject(value) ? value : null;
    }
    catch {
        return null;
    }
}
/** True when `target` resolves to `root` or something beneath it. */
function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function isThemeFileName(name) {
    if (name.startsWith('.'))
        return false;
    const extension = path.extname(name).toLowerCase();
    return extension === '.json' || extension === '.jsonc';
}
/**
 * Check that a parsed value can be used as a theme.
 *
 * A theme must be a plain object carrying at least one recognised colour key
 * with a string value. Values stay opaque: hex, ANSI and named colours are all
 * accepted here so this module has no dependency on a colour library.
 */
export function validateTheme(raw) {
    if (!isPlainObject(raw)) {
        return { ok: false, error: 'Theme must be a JSON object' };
    }
    const hasColor = COLOR_KEYS.some((key) => typeof raw[key] === 'string');
    if (!hasColor) {
        return {
            ok: false,
            error: `Theme must define at least one string colour key (${COLOR_KEYS.join(', ')})`,
        };
    }
    return { ok: true };
}
/**
 * Discover user theme files from the standard roots plus any extra directories.
 *
 * Roots (in order): `<home>/.config/bitacode/themes/`,
 * `<home>/.bitacode/themes/`, then `options.extraDirs` in the given order.
 * Dotfiles, symlinks escaping their root, non-JSON files, files over 256 KB and
 * invalid themes are skipped with a warning. At most 100 files are returned.
 */
export function discoverThemeFiles(options) {
    let home;
    if (typeof options?.home === 'string' && options.home.length > 0) {
        home = options.home;
    }
    else {
        try {
            home = os.homedir();
        }
        catch (error) {
            return { ok: false, error: `Could not resolve home directory: ${errorMessage(error)}` };
        }
    }
    const configuredExtras = options?.extraDirs;
    if (configuredExtras !== undefined && !Array.isArray(configuredExtras)) {
        logger.warn('Ignoring non-array extraDirs in theme discovery');
    }
    const extraDirs = Array.isArray(configuredExtras) ? configuredExtras : [];
    const roots = [];
    const seenRoots = new Set();
    const candidates = [
        path.join(home, '.config', 'bitacode', 'themes'),
        path.join(home, '.bitacode', 'themes'),
        ...extraDirs.filter((dir) => typeof dir === 'string' && dir.trim().length > 0),
    ];
    for (const candidate of candidates) {
        const resolved = path.resolve(candidate);
        if (seenRoots.has(resolved))
            continue;
        seenRoots.add(resolved);
        roots.push(resolved);
    }
    const found = [];
    const seenFiles = new Set();
    let capped = false;
    for (const root of roots) {
        let rootReal;
        try {
            if (!fs.existsSync(root))
                continue;
            rootReal = fs.realpathSync(root);
        }
        catch (error) {
            logger.warn('Could not open theme directory', { root, error: errorMessage(error) });
            continue;
        }
        let entries;
        try {
            entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        }
        catch (error) {
            logger.warn('Could not list theme directory', { root, error: errorMessage(error) });
            continue;
        }
        for (const entry of entries) {
            if (found.length >= MAX_THEME_FILES) {
                capped = true;
                break;
            }
            if (!isThemeFileName(entry.name))
                continue;
            const filePath = path.join(root, entry.name);
            let resolvedPath;
            let size;
            if (entry.isSymbolicLink()) {
                let target;
                try {
                    target = fs.realpathSync(filePath);
                }
                catch (error) {
                    logger.warn('Could not resolve theme symlink', { path: filePath, error: errorMessage(error) });
                    continue;
                }
                if (!isInside(rootReal, target)) {
                    logger.warn('Skipping theme symlink outside its root', { path: filePath, target });
                    continue;
                }
                try {
                    const stat = fs.statSync(target);
                    if (!stat.isFile())
                        continue;
                    size = stat.size;
                }
                catch (error) {
                    logger.warn('Could not stat theme symlink target', { path: filePath, error: errorMessage(error) });
                    continue;
                }
                resolvedPath = target;
            }
            else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(filePath);
                    if (!stat.isFile())
                        continue;
                    size = stat.size;
                    resolvedPath = fs.realpathSync(filePath);
                }
                catch (error) {
                    logger.warn('Could not stat theme file', { path: filePath, error: errorMessage(error) });
                    continue;
                }
            }
            else {
                continue;
            }
            if (seenFiles.has(resolvedPath))
                continue;
            seenFiles.add(resolvedPath);
            if (size > MAX_THEME_BYTES) {
                logger.warn('Skipping oversized theme file', { path: filePath, bytes: size });
                continue;
            }
            let text;
            try {
                text = fs.readFileSync(filePath, 'utf8');
            }
            catch (error) {
                logger.warn('Could not read theme file', { path: filePath, error: errorMessage(error) });
                continue;
            }
            const raw = parseThemeText(text, path.extname(entry.name).toLowerCase() === '.jsonc');
            if (raw === null) {
                logger.warn('Skipping theme file with invalid JSON', { path: filePath });
                continue;
            }
            const validation = validateTheme(raw);
            if (!validation.ok) {
                logger.warn('Skipping invalid theme file', { path: filePath, error: validation.error });
                continue;
            }
            found.push({
                name: path.basename(entry.name, path.extname(entry.name)),
                path: filePath,
                raw,
            });
        }
        if (capped)
            break;
    }
    return { ok: true, value: found };
}
