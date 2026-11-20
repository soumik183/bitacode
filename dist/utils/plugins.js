/**
 * plugins.ts — discover and load local plugins.
 *
 * A plugin is a directory containing `plugin.json` and an ESM entry file that
 * exports `register(api)`:
 *
 *   {
 *     "name": "hello",
 *     "version": "1.0.0",
 *     "description": "Says hello",
 *     "entry": "index.mjs",
 *     "enabled": true
 *   }
 *
 * User plugins live in `~/.config/bitacode/plugins/` and always load. Project
 * plugins live in `<cwd>/.bitacode/plugins/` and only load for a trusted project:
 * opening a clone must never execute its code. Enable/disable choices are stored
 * outside the project in a small JSON registry.
 *
 * Loading is best-effort: a bad manifest, a missing entry or a throwing plugin
 * is reported in `errors`, never thrown to the caller.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadSettings } from '../settings.js';
import { HOOK_EVENTS } from './hooks.js';
import { logger } from './logger.js';
import { isProjectTrusted } from './project-trust.js';
const NAME_PATTERN = /^[A-Za-z0-9][\w.-]*$/;
const REGISTRY_VERSION = 1;
const PLUGIN_HOOK_TIMEOUT_MS = 5_000;
/** Validate one `plugin.json`. Pure: no filesystem access. */
export function parsePluginManifest(raw, source) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `${source}: plugin.json must be an object` };
    }
    const value = raw;
    const name = value.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        return { error: `${source}: "name" must be alphanumeric with dots, dashes or underscores` };
    }
    const version = value.version;
    if (typeof version !== 'string' || !version.trim()) {
        return { error: `${source}: "version" must be a non-empty string` };
    }
    const description = value.description === undefined ? '' : value.description;
    if (typeof description !== 'string') {
        return { error: `${source}: "description" must be a string` };
    }
    const entry = value.entry;
    if (typeof entry !== 'string' ||
        !/\.m?js$/i.test(entry) ||
        path.isAbsolute(entry) ||
        entry.split(/[\\/]/).includes('..')) {
        return { error: `${source}: "entry" must be a relative .js/.mjs file inside the plugin directory` };
    }
    const enabled = value.enabled === undefined ? true : value.enabled;
    if (typeof enabled !== 'boolean') {
        return { error: `${source}: "enabled" must be a boolean` };
    }
    return { name, version, description, entry, enabled };
}
/** Normalize arbitrary JSON into a registry; invalid entries are dropped. */
export function normalizePluginRegistry(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const source = value.overrides && typeof value.overrides === 'object'
        ? value.overrides
        : {};
    const overrides = {};
    for (const [name, enabled] of Object.entries(source)) {
        if (typeof enabled === 'boolean' && NAME_PATTERN.test(name))
            overrides[name] = enabled;
    }
    return { version: REGISTRY_VERSION, overrides };
}
/** Pure state change used by `bitacode plugins enable/disable`. */
export function setPluginEnabled(registry, name, enabled) {
    return { version: REGISTRY_VERSION, overrides: { ...registry.overrides, [name]: enabled } };
}
export function isPluginEnabled(plugin, registry) {
    return registry.overrides[plugin.name] ?? plugin.enabled;
}
function userConfigDir() {
    const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config');
    return path.join(configHome, 'bitacode');
}
function defaultUserPluginsDir() {
    return path.join(userConfigDir(), 'plugins');
}
function defaultProjectPluginsDir(cwd) {
    return path.join(cwd, '.bitacode', 'plugins');
}
export function pluginsRegistryPath() {
    return path.join(userConfigDir(), 'plugins.json');
}
export function readPluginRegistry(file = pluginsRegistryPath()) {
    try {
        return normalizePluginRegistry(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
    catch (err) {
        if (err?.code !== 'ENOENT') {
            logger.warn('Could not read plugin registry', { file, error: String(err) });
        }
        return { version: REGISTRY_VERSION, overrides: {} };
    }
}
/** Write atomically so a crash cannot leave a half-written registry. */
export function writePluginRegistry(registry, file = pluginsRegistryPath()) {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, `${JSON.stringify(normalizePluginRegistry(registry), null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    }
    catch (err) {
        logger.warn('Could not write plugin registry', { file, error: String(err) });
        try {
            fs.rmSync(tmp, { force: true });
        }
        catch {
            // ignore
        }
        return false;
    }
}
function errorCode(err) {
    return err?.code;
}
function readPluginDir(dir, scope, registry, result) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        if (errorCode(err) !== 'ENOENT')
            result.errors.push(`${dir}: ${String(err)}`);
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const pluginDir = path.join(dir, entry.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        }
        catch (err) {
            if (errorCode(err) !== 'ENOENT') {
                result.errors.push(`${manifestPath}: ${String(err instanceof Error ? err.message : err)}`);
            }
            continue;
        }
        const parsed = parsePluginManifest(raw, manifestPath);
        if ('error' in parsed) {
            result.errors.push(parsed.error);
            continue;
        }
        const entryFile = path.resolve(pluginDir, parsed.entry);
        if (entryFile !== pluginDir && !entryFile.startsWith(`${pluginDir}${path.sep}`)) {
            result.errors.push(`${manifestPath}: "entry" escapes the plugin directory`);
            continue;
        }
        if (!fs.existsSync(entryFile)) {
            result.errors.push(`${manifestPath}: entry file not found: ${parsed.entry}`);
            continue;
        }
        result.plugins.push({
            name: parsed.name,
            version: parsed.version,
            description: parsed.description,
            entry: entryFile,
            dir: pluginDir,
            manifestPath,
            scope,
            enabled: isPluginEnabled(parsed, registry),
        });
    }
}
/** Discover plugins from the user dir and (when trusted) the project dir. */
export function discoverPlugins(options = {}) {
    const result = { plugins: [], errors: [] };
    const cwd = options.cwd ?? process.cwd();
    const trusted = options.trusted ?? isProjectTrusted(cwd);
    const registry = options.registry ?? readPluginRegistry();
    const userDir = options.userDir ?? defaultUserPluginsDir();
    const projectDir = options.projectDir ?? defaultProjectPluginsDir(cwd);
    readPluginDir(userDir, 'user', registry, result);
    if (trusted) {
        readPluginDir(projectDir, 'project', registry, result);
    }
    else if (fs.existsSync(projectDir)) {
        result.errors.push(`${projectDir}: ignored because this project is not trusted (run: bitacode permissions trust)`);
    }
    // Project plugins win over user plugins with the same name, like commands.
    const seen = new Map();
    for (const plugin of result.plugins)
        seen.set(plugin.name.toLowerCase(), plugin);
    result.plugins = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    return result;
}
/** Pure filter used before loading. */
export function filterEnabledPlugins(plugins) {
    return plugins.filter((plugin) => plugin.enabled);
}
function logArg(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? String(value);
    }
    catch {
        return String(value);
    }
}
/** Build the API a plugin registers against, recording into `sink`. */
export function createPluginApi(descriptor, sink) {
    const label = `plugin:${descriptor.name}`;
    return {
        registerCommand(name, description, handler) {
            if (typeof name !== 'string' || !/^[A-Za-z0-9][\w:-]*$/.test(name)) {
                sink.errors.push(`${label}: invalid command name "${String(name)}"`);
                return;
            }
            if (typeof description !== 'string' || typeof handler !== 'function') {
                sink.errors.push(`${label}: registerCommand needs a description and a handler function`);
                return;
            }
            sink.commands.push({
                name,
                description,
                body: description || `/${name}`,
                source: descriptor.entry,
                handler,
            });
        },
        onHook(event, handler) {
            if (!HOOK_EVENTS.includes(event)) {
                sink.errors.push(`${label}: unknown hook event "${String(event)}"`);
                return;
            }
            if (typeof handler !== 'function') {
                sink.errors.push(`${label}: onHook needs a handler function`);
                return;
            }
            sink.hooks.push({
                event,
                command: `${label}:${event}`,
                timeoutMs: PLUGIN_HOOK_TIMEOUT_MS,
                source: descriptor.entry,
                handler,
            });
        },
        getSettings: () => loadSettings(),
        log: (...args) => logger.info(`[${label}] ${args.map(logArg).join(' ')}`),
    };
}
const defaultImporter = async (file) => (await import(pathToFileURL(file).href));
/** Load every enabled plugin. Never throws: failures land in `errors`. */
export async function loadPlugins(options = {}) {
    const result = { loaded: [], commands: [], hooks: [], errors: [] };
    const discovered = options.plugins
        ? { plugins: [...options.plugins], errors: [] }
        : discoverPlugins(options);
    result.errors.push(...discovered.errors);
    const importer = options.importer ?? defaultImporter;
    for (const descriptor of discovered.plugins) {
        if (!descriptor.enabled) {
            result.errors.push(`${descriptor.manifestPath}: plugin "${descriptor.name}" is disabled`);
            continue;
        }
        try {
            const module = await importer(descriptor.entry);
            const candidate = module.register
                ?? module.default?.register;
            if (typeof candidate !== 'function') {
                result.errors.push(`${descriptor.entry}: plugin "${descriptor.name}" does not export register(api)`);
                continue;
            }
            await candidate(createPluginApi(descriptor, result));
            result.loaded.push(descriptor.name);
        }
        catch (err) {
            result.errors.push(`${descriptor.entry}: plugin "${descriptor.name}" failed to load: ${String(err instanceof Error ? err.message : err)}`);
        }
    }
    return result;
}
