/**
 * accounts.ts — optional multi-account credential store.
 *
 * This is deliberately separate from bitacode's single active key in its main
 * config: nothing here reads or writes that config, so `bitacode auth` keeps
 * working exactly as before until a caller explicitly opts into this store.
 *
 * Records live in one JSON file at
 * `${XDG_DATA_HOME || <home>/.local/share}/bitacode/accounts.json` with a
 * private directory (0700), private file (0600) and atomic tmp+rename writes.
 * Every public function returns an `AccountResult` and never throws; a corrupt
 * store is reported with its path and is never overwritten.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from './logger.js';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_ACCOUNTS = 64;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_HEADER_NAME_CHARS = 256;
const MAX_BASE_URL_CHARS = 2048;
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isSlug(value) {
    return typeof value === 'string' && SLUG_PATTERN.test(value);
}
function errorMessage(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Resolve the store path without consulting (or touching) the main config. */
export function accountStorePath(home) {
    const base = process.env.XDG_DATA_HOME?.trim() || path.join(home ?? os.homedir(), '.local', 'share');
    return path.join(base, 'bitacode', 'accounts.json');
}
function storeOptions(options) {
    return options ?? {};
}
function storeFile(options) {
    return accountStorePath(storeOptions(options).home);
}
function harden(target, mode) {
    if (process.platform === 'win32')
        return;
    try {
        fs.chmodSync(target, mode);
    }
    catch (err) {
        logger.warn('Account store: could not set permissions', { target, error: String(err) });
    }
}
/** Atomic write: private temp file, then rename. No temp file survives failure. */
function writeStoreFile(file, store) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE });
        fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE });
        harden(tmp, FILE_MODE);
        fs.renameSync(tmp, file);
        harden(file, FILE_MODE);
        harden(path.dirname(file), DIR_MODE);
    }
    catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // Best effort cleanup; the original error is what matters.
        }
        throw err;
    }
}
/**
 * Normalize one untrusted record. Missing/invalid createdAt metadata is
 * synthesized rather than discarding otherwise usable credentials.
 */
function normalizeRecord(value) {
    if (!isRecord(value))
        return { ok: false, error: 'record must be an object' };
    const id = value.id;
    const provider = value.provider;
    const label = value.label;
    if (!isSlug(id))
        return { ok: false, error: 'invalid id slug' };
    if (!isSlug(provider))
        return { ok: false, error: 'invalid provider slug' };
    // Labels are human-readable display text, not identifiers — "Work laptop"
    // is valid. Keep them bounded, printable and single-line.
    if (typeof label !== 'string' || label.trim().length === 0) {
        return { ok: false, error: 'label must be a non-empty string' };
    }
    const cleanLabel = label.replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ').trim().slice(0, 80);
    if (!cleanLabel)
        return { ok: false, error: 'invalid label' };
    let apiKey;
    if (value.apiKey !== undefined) {
        if (typeof value.apiKey !== 'string' || value.apiKey.trim().length === 0) {
            return { ok: false, error: 'apiKey must be a non-empty string' };
        }
        apiKey = value.apiKey;
    }
    let headers;
    if (value.headers !== undefined) {
        if (!isRecord(value.headers))
            return { ok: false, error: 'headers must be an object' };
        headers = {};
        for (const [name, headerValue] of Object.entries(value.headers)) {
            if (name.length === 0 || name.length > MAX_HEADER_NAME_CHARS || /[\r\n\0]/.test(name)) {
                return { ok: false, error: 'invalid header name' };
            }
            if (typeof headerValue !== 'string' || headerValue.trim().length === 0) {
                return { ok: false, error: `header value for ${name} must be a non-empty string` };
            }
            if (Buffer.byteLength(headerValue, 'utf8') > MAX_HEADER_VALUE_BYTES) {
                return { ok: false, error: `header value for ${name} exceeds 8 KB` };
            }
            headers[name] = headerValue;
        }
        if (Object.keys(headers).length === 0) {
            return { ok: false, error: 'headers must contain at least one entry' };
        }
    }
    if (apiKey === undefined && headers === undefined) {
        return { ok: false, error: 'account requires apiKey or headers' };
    }
    let baseURL;
    if (value.baseURL !== undefined) {
        if (typeof value.baseURL !== 'string' || value.baseURL.trim().length === 0) {
            return { ok: false, error: 'baseURL must be a non-empty string' };
        }
        if (value.baseURL.length > MAX_BASE_URL_CHARS) {
            return { ok: false, error: 'baseURL is too long' };
        }
        baseURL = value.baseURL;
    }
    const createdAt = typeof value.createdAt === 'string'
        && value.createdAt.trim().length > 0
        && !Number.isNaN(Date.parse(value.createdAt))
        ? value.createdAt
        : new Date().toISOString();
    const record = { id, provider, label: cleanLabel, createdAt };
    if (apiKey !== undefined)
        record.apiKey = apiKey;
    if (headers !== undefined)
        record.headers = headers;
    if (baseURL !== undefined)
        record.baseURL = baseURL;
    return { ok: true, value: record };
}
/** Validate an add/import style input (id and timestamp are assigned by us). */
function validateInput(input) {
    if (!isRecord(input))
        return { ok: false, error: 'account input must be an object' };
    const checked = normalizeRecord({ ...input, id: 'placeholder', createdAt: new Date().toISOString() });
    if (!checked.ok)
        return checked;
    const { id: _id, createdAt: _createdAt, ...rest } = checked.value;
    return { ok: true, value: rest };
}
/** Keep the preferred active id when it still exists; otherwise pick the first. */
function pickActiveId(preferred, accounts) {
    if (preferred !== undefined && accounts.some((account) => account.id === preferred))
        return preferred;
    return accounts[0]?.id;
}
/** Parse and sanitize a store file. A missing file becomes an empty store. */
function readStoreFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    }
    catch (err) {
        if (err?.code === 'ENOENT') {
            const empty = { version: 1, accounts: [] };
            try {
                writeStoreFile(file, empty);
            }
            catch (writeErr) {
                logger.warn('Account store: could not create empty store', { file, error: String(writeErr) });
            }
            return { ok: true, value: empty };
        }
        return { ok: false, error: `Could not read account store ${file}: ${errorMessage(err)}` };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, error: `Corrupt account store ${file}: invalid JSON` };
    }
    const source = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.accounts)
            ? parsed.accounts
            : undefined;
    if (!source) {
        return { ok: false, error: `Corrupt account store ${file}: expected an account list` };
    }
    const accounts = [];
    const seen = new Set();
    for (let index = 0; index < source.length; index++) {
        const checked = normalizeRecord(source[index]);
        if (!checked.ok) {
            logger.warn('Account store: dropping invalid entry', { file, index, reason: checked.error });
            continue;
        }
        if (seen.has(checked.value.id)) {
            logger.warn('Account store: dropping duplicate id', { file, index, id: checked.value.id });
            continue;
        }
        if (accounts.length >= MAX_ACCOUNTS) {
            logger.warn('Account store: dropping entry beyond account limit', { file, index });
            continue;
        }
        seen.add(checked.value.id);
        accounts.push(checked.value);
    }
    const rawActiveId = !Array.isArray(parsed) && isRecord(parsed) && typeof parsed.activeId === 'string'
        ? parsed.activeId
        : undefined;
    if (rawActiveId !== undefined && !accounts.some((account) => account.id === rawActiveId)) {
        logger.warn('Account store: activeId does not match a stored account', { file });
    }
    const activeId = pickActiveId(rawActiveId, accounts);
    return { ok: true, value: { version: 1, accounts, activeId } };
}
/** Load all accounts. Invalid entries are dropped; a corrupt file is an error. */
export function loadAccounts(options) {
    try {
        const loaded = readStoreFile(storeFile(options));
        if (!loaded.ok)
            return loaded;
        return { ok: true, value: loaded.value.accounts };
    }
    catch (err) {
        return { ok: false, error: `Could not load account store ${storeFile(options)}: ${errorMessage(err)}` };
    }
}
/**
 * Replace the whole store. The previous active choice is kept when it still
 * exists in `accounts`; otherwise the first account becomes active.
 */
export function saveAccounts(accounts, options) {
    const file = storeFile(options);
    try {
        if (!Array.isArray(accounts))
            return { ok: false, error: 'accounts must be an array' };
        if (accounts.length > MAX_ACCOUNTS) {
            return { ok: false, error: `Cannot store more than ${MAX_ACCOUNTS} accounts` };
        }
        const normalized = [];
        const seen = new Set();
        for (let index = 0; index < accounts.length; index++) {
            const checked = normalizeRecord(accounts[index]);
            if (!checked.ok) {
                return { ok: false, error: `Invalid account at index ${index}: ${checked.error}` };
            }
            if (seen.has(checked.value.id)) {
                return { ok: false, error: `Duplicate account id at index ${index}: ${checked.value.id}` };
            }
            seen.add(checked.value.id);
            normalized.push(checked.value);
        }
        const existing = readStoreFile(file);
        if (!existing.ok)
            return existing;
        writeStoreFile(file, {
            version: 1,
            accounts: normalized,
            activeId: pickActiveId(existing.value.activeId, normalized),
        });
        return { ok: true, value: undefined };
    }
    catch (err) {
        return { ok: false, error: `Could not save account store ${file}: ${errorMessage(err)}` };
    }
}
function newAccountId(existing) {
    const ids = new Set(existing.map((account) => account.id));
    let id = randomUUID();
    while (ids.has(id))
        id = randomUUID();
    return id;
}
/** Add a credential set. The first account in an empty store becomes active. */
export function addAccount(input, options) {
    const file = storeFile(options);
    try {
        const checkedInput = validateInput(input);
        if (!checkedInput.ok)
            return checkedInput;
        const loaded = readStoreFile(file);
        if (!loaded.ok)
            return loaded;
        if (loaded.value.accounts.length >= MAX_ACCOUNTS) {
            return { ok: false, error: `Cannot store more than ${MAX_ACCOUNTS} accounts` };
        }
        const record = {
            ...checkedInput.value,
            id: newAccountId(loaded.value.accounts),
            createdAt: new Date().toISOString(),
        };
        const accounts = [...loaded.value.accounts, record];
        writeStoreFile(file, {
            version: 1,
            accounts,
            activeId: pickActiveId(loaded.value.activeId, accounts),
        });
        return { ok: true, value: record };
    }
    catch (err) {
        return { ok: false, error: `Could not add account to ${file}: ${errorMessage(err)}` };
    }
}
/** Make an existing account the single active one. */
export function switchAccount(id, options) {
    const file = storeFile(options);
    try {
        if (!isSlug(id))
            return { ok: false, error: `Invalid account id: ${String(id)}` };
        const loaded = readStoreFile(file);
        if (!loaded.ok)
            return loaded;
        const record = loaded.value.accounts.find((account) => account.id === id);
        if (!record)
            return { ok: false, error: `Unknown account id: ${id}` };
        if (loaded.value.activeId !== id) {
            writeStoreFile(file, { version: 1, accounts: loaded.value.accounts, activeId: id });
        }
        return { ok: true, value: record };
    }
    catch (err) {
        return { ok: false, error: `Could not switch account in ${file}: ${errorMessage(err)}` };
    }
}
/** The active account, or undefined for an empty store. */
export function activeAccount(options) {
    try {
        const loaded = readStoreFile(storeFile(options));
        if (!loaded.ok)
            return loaded;
        const { accounts, activeId } = loaded.value;
        return { ok: true, value: accounts.find((account) => account.id === activeId) ?? accounts[0] };
    }
    catch (err) {
        return { ok: false, error: `Could not load active account from ${storeFile(options)}: ${errorMessage(err)}` };
    }
}
/** Return a copy with credentials masked; key names and metadata are kept. */
export function redactAccount(record) {
    const redacted = {
        id: record.id,
        provider: record.provider,
        label: record.label,
        createdAt: record.createdAt,
    };
    if (record.apiKey !== undefined)
        redacted.apiKey = '***';
    if (record.headers !== undefined) {
        const masked = {};
        for (const name of Object.keys(record.headers))
            masked[name] = '***';
        redacted.headers = masked;
    }
    if (record.baseURL !== undefined)
        redacted.baseURL = record.baseURL;
    return redacted;
}
/** Serialize accounts as JSON. Secrets are excluded unless explicitly asked for. */
export function exportAccounts(options) {
    try {
        const loaded = readStoreFile(storeFile(options));
        if (!loaded.ok)
            return loaded;
        const records = options?.includeSecrets === true
            ? loaded.value.accounts
            : loaded.value.accounts.map(redactAccount);
        return { ok: true, value: `${JSON.stringify(records, null, 2)}\n` };
    }
    catch (err) {
        return { ok: false, error: `Could not export accounts from ${storeFile(options)}: ${errorMessage(err)}` };
    }
}
/**
 * Import accounts from JSON, merging by id. Existing records win over imported
 * duplicates, and the first occurrence wins within the imported list. The
 * returned number counts newly added records. Malformed JSON changes nothing.
 */
export function importAccounts(json, options) {
    const file = storeFile(options);
    try {
        let parsed;
        try {
            parsed = JSON.parse(json);
        }
        catch (err) {
            return { ok: false, error: `Invalid accounts JSON: ${errorMessage(err)}` };
        }
        const source = Array.isArray(parsed)
            ? parsed
            : isRecord(parsed) && Array.isArray(parsed.accounts)
                ? parsed.accounts
                : undefined;
        if (!source) {
            return { ok: false, error: 'Invalid accounts JSON: expected an array of accounts' };
        }
        const incoming = [];
        const seen = new Set();
        for (let index = 0; index < source.length; index++) {
            const checked = normalizeRecord(source[index]);
            if (!checked.ok) {
                logger.warn('Accounts import: skipping invalid entry', { index, reason: checked.error });
                continue;
            }
            if (seen.has(checked.value.id)) {
                logger.warn('Accounts import: skipping duplicate id', { index, id: checked.value.id });
                continue;
            }
            seen.add(checked.value.id);
            incoming.push(checked.value);
        }
        const loaded = readStoreFile(file);
        if (!loaded.ok)
            return loaded;
        const merged = [...loaded.value.accounts];
        const existingIds = new Set(merged.map((account) => account.id));
        let imported = 0;
        for (const record of incoming) {
            if (existingIds.has(record.id))
                continue;
            if (merged.length >= MAX_ACCOUNTS) {
                return { ok: false, error: `Cannot import more than ${MAX_ACCOUNTS} accounts` };
            }
            merged.push(record);
            existingIds.add(record.id);
            imported++;
        }
        if (imported > 0) {
            writeStoreFile(file, {
                version: 1,
                accounts: merged,
                activeId: pickActiveId(loaded.value.activeId, merged),
            });
        }
        return { ok: true, value: imported };
    }
    catch (err) {
        return { ok: false, error: `Could not import accounts into ${file}: ${errorMessage(err)}` };
    }
}
