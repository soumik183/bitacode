/**
 * doctor.ts — one offline diagnostic report.
 *
 * Answers "why is this not working" without spending a token or a network call:
 * which config files were read, which provider/model resolved, whether a key is
 * present (a boolean only — never the key), which permission rules and hooks are
 * loaded (and which were refused because the project is untrusted), where logs,
 * sessions, spills and journals live, and what the terminal can render.
 *
 * `--online` is the only thing that touches the network, and it is opt-in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { readConfig } from '../config.js';
import { getActiveRuntimeConfigPath } from '../runtime-config.js';
import { getProvider } from '../providers/index.js';
import { resolveApiKey } from '../config.js';
import { loadSettings } from '../settings.js';
import { loadHooks, describeHooks } from './hooks.js';
import { describeRuleSet, parseRuleSet } from './permission-rules.js';
import { isProjectTrusted, listTrustedProjects, trustStorePath } from './project-trust.js';
import { describeTerminalProfile, detectTerminalProfile } from './terminal.js';
import { detectChecks } from './autoverify.js';
import { listJournals } from './session-journal.js';
import { getLogFilePath } from './logger.js';
import { getWorkingDirectory } from './path-validation.js';
function dataDir() {
    const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'bitacode');
}
function countSessions() {
    for (const directory of [path.join(dataDir(), 'sessions'), path.join(os.homedir(), '.bitacode', 'sessions')]) {
        try {
            return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).length;
        }
        catch {
            // try the next location
        }
    }
    return 0;
}
function configSection(cwd, warnings) {
    const lines = [];
    let config = null;
    try {
        config = readConfig('active');
    }
    catch (err) {
        warnings.push(`could not read config: ${String(err instanceof Error ? err.message : err)}`);
    }
    lines.push(`cwd: ${getWorkingDirectory()}`);
    lines.push(`config file: ${getActiveRuntimeConfigPath() ?? '(none found)'}`);
    if (!config) {
        lines.push('provider/model: (not configured — run `bitacode configure`)');
        lines.push('api key: missing');
        warnings.push('no provider/model configured');
        return { title: 'config', lines };
    }
    const provider = getProvider(config.provider);
    lines.push(`provider/model: ${config.provider} / ${config.model}`);
    lines.push(`provider name: ${provider?.name ?? '(unknown provider id)'}`);
    if (!provider)
        warnings.push(`unknown provider "${config.provider}"`);
    const key = resolveApiKey(config);
    lines.push(`api key: ${key ? 'present' : 'missing'}`);
    if (!key)
        warnings.push(`no API key for ${config.provider}${provider?.apiKeyEnvVar ? ` (expected ${provider.apiKeyEnvVar})` : ''}`);
    if (provider?.baseURL)
        lines.push(`base url: ${provider.baseURL}`);
    if (!config.model.trim())
        warnings.push('model id is empty');
    const settings = loadSettings();
    lines.push(`approval mode: ${settings.approvalMode}`);
    lines.push(`compact threshold: ${settings.compactThreshold ?? 'default'}`);
    lines.push(`cwd source: ${cwd === getWorkingDirectory() ? 'process' : 'overridden'}`);
    return { title: 'config', lines };
}
function permissionsSection(cwd, warnings) {
    const lines = [];
    const trusted = isProjectTrusted(cwd);
    lines.push(`project trusted: ${trusted ? 'yes' : 'no'}`);
    if (!trusted)
        lines.push('  (project permission rules, hooks and commands are ignored until `bitacode permissions trust`)');
    const settings = loadSettings();
    const settingsRules = parseRuleSet(settings.permissions);
    lines.push('rules (settings):');
    for (const line of describeRuleSet(settingsRules))
        lines.push(`  ${line}`);
    const projectFile = path.join(cwd, '.bitacode', 'permissions.json');
    if (fs.existsSync(projectFile)) {
        if (!trusted) {
            lines.push(`rules (project): ignored — ${projectFile}`);
        }
        else {
            try {
                const projectRules = parseRuleSet(JSON.parse(fs.readFileSync(projectFile, 'utf8')));
                lines.push(`rules (project): ${projectFile}`);
                for (const line of describeRuleSet(projectRules))
                    lines.push(`  ${line}`);
            }
            catch (err) {
                warnings.push(`could not parse ${projectFile}: ${String(err instanceof Error ? err.message : err)}`);
            }
        }
    }
    for (const error of settingsRules.errors)
        warnings.push(error);
    lines.push(`trust store: ${trustStorePath()} (${listTrustedProjects().length} entries)`);
    return { title: 'permissions', lines };
}
function hooksSection(cwd, warnings) {
    const trusted = isProjectTrusted(cwd);
    const loaded = loadHooks({ cwd, trusted });
    const lines = describeHooks(loaded.hooks);
    lines.push(`files: ${loaded.files.length > 0 ? loaded.files.join(', ') : '(none)'}`);
    for (const error of loaded.errors) {
        lines.push(`warning: ${error}`);
        if (!error.includes('not trusted'))
            warnings.push(error);
    }
    return { title: 'hooks', lines };
}
function storageSection() {
    const journals = listJournals();
    const spillDir = path.join(dataDir(), 'spill');
    let spillCount = 0;
    try {
        spillCount = fs.readdirSync(spillDir).reduce((total, entry) => {
            try {
                return total + fs.readdirSync(path.join(spillDir, entry)).length;
            }
            catch {
                return total;
            }
        }, 0);
    }
    catch {
        // no spills yet
    }
    return {
        title: 'storage',
        lines: [
            `data dir: ${dataDir()}`,
            `logs: ${getLogFilePath()}`,
            `sessions: ${countSessions()}`,
            `journals: ${journals.length}`,
            `spill files: ${spillCount}`,
        ],
    };
}
function environmentSection() {
    const profile = detectTerminalProfile();
    return {
        title: 'environment',
        lines: [
            `node: ${process.version}`,
            `platform: ${process.platform} ${process.arch}`,
            `termux: ${process.env.TERMUX_VERSION ? 'yes' : 'no'}`,
            ...describeTerminalProfile(profile),
            `no colour: ${process.env.NO_COLOR ? 'yes' : 'no'}`,
        ],
    };
}
async function checksSection(cwd) {
    const checks = await detectChecks({ cwd }).catch(() => []);
    return {
        title: 'project checks',
        lines: checks.length === 0
            ? ['none detected']
            : checks.map((check) => `${check.name}: ${check.command}  (from ${check.source})`),
    };
}
/** Collect the report. Never throws. */
export async function collectDoctorReport(options) {
    const cwd = options.cwd ?? process.cwd();
    const warnings = [];
    const sections = [
        { title: 'bitacode', lines: [`version: ${options.version}`, `pid: ${process.pid}`] },
        configSection(cwd, warnings),
        permissionsSection(cwd, warnings),
        hooksSection(cwd, warnings),
        storageSection(),
        environmentSection(),
    ];
    if (options.detectProjectChecks !== false) {
        sections.push(await checksSection(cwd));
    }
    return { ok: warnings.length === 0, sections, warnings };
}
export function renderDoctorReport(report) {
    const out = [];
    for (const section of report.sections) {
        out.push(`── ${section.title} ${'─'.repeat(Math.max(0, 46 - section.title.length))}`);
        for (const line of section.lines)
            out.push(`  ${line}`);
        out.push('');
    }
    if (report.warnings.length > 0) {
        out.push('── warnings ──');
        for (const warning of report.warnings)
            out.push(`  ! ${warning}`);
        out.push('');
    }
    else {
        out.push('No problems detected.');
    }
    return out.join('\n');
}
