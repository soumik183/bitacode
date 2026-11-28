/**
 * permissions command — `bitacode permissions [show|trust|untrust|list]`.
 *
 * The trust step is what makes project-local permission rules, hooks and slash
 * commands usable: opening a clone must never be enough to run its code.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadSettings } from '../settings.js';
import { describeRuleSet, evaluatePermission, matchRules, mergeRuleSets, parseRuleSet, } from '../utils/permission-rules.js';
import { canonicalProjectPath, isProjectTrusted, listTrustedProjects, trustProject, untrustProject, } from '../utils/project-trust.js';
function projectRulesPath(cwd) {
    return path.join(cwd, '.bitacode', 'permissions.json');
}
/** Effective rules: project rules (when trusted) override nothing, they add. */
export function loadEffectiveRules(cwd) {
    const settings = loadSettings();
    const settingsRules = parseRuleSet(settings.permissions);
    const trusted = isProjectTrusted(cwd);
    const file = projectRulesPath(cwd);
    if (!fs.existsSync(file))
        return { rules: settingsRules, projectLoaded: false };
    if (!trusted) {
        return {
            rules: settingsRules,
            projectLoaded: false,
            projectError: `${file} ignored: project is not trusted (run \`bitacode permissions trust\`)`,
        };
    }
    try {
        const projectRules = parseRuleSet(JSON.parse(fs.readFileSync(file, 'utf8')));
        return { rules: mergeRuleSets(settingsRules, projectRules), projectLoaded: true };
    }
    catch (err) {
        return {
            rules: settingsRules,
            projectLoaded: false,
            projectError: `${file}: ${String(err instanceof Error ? err.message : err)}`,
        };
    }
}
function buildTestCall(tool, argument, cwd) {
    const args = {};
    if (argument) {
        if (/^(bash|shell|terminal|run|start_process|background|watch)$/i.test(tool))
            args.command = argument;
        else if (/^(webfetch|fetch_url|open_url|web_search|websearch)$/i.test(tool))
            args.url = argument;
        else
            args.file_path = argument;
    }
    return { tool, args, cwd };
}
export function runPermissionsCommand(args, options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
    const sub = (args[0] ?? 'show').toLowerCase();
    switch (sub) {
        case 'test': {
            const tool = args[1]?.trim();
            if (!tool) {
                write('Usage: bitacode permissions test <tool> [argument]');
                return 1;
            }
            const argument = args.slice(2).join(' ').trim();
            const { rules, projectLoaded, projectError } = loadEffectiveRules(cwd);
            const call = buildTestCall(tool, argument, cwd);
            const evaluation = evaluatePermission(rules, call);
            const matches = matchRules(rules, call);
            if (options.json) {
                write(JSON.stringify({
                    tool,
                    argument: argument || null,
                    decision: evaluation.decision,
                    source: evaluation.source ?? null,
                    rule: evaluation.rule ?? null,
                    warning: evaluation.warning ?? null,
                    matches: {
                        deny: matches.deny.map((rule) => rule.raw),
                        ask: matches.ask.map((rule) => rule.raw),
                        allow: matches.allow.map((rule) => rule.raw),
                    },
                    projectRulesLoaded: projectLoaded,
                    projectError: projectError ?? null,
                }));
                return 0;
            }
            write(`tool: ${tool}${argument ? ` (${argument})` : ''}`);
            write(`decision: ${evaluation.decision}${evaluation.rule ? `  [matched: ${evaluation.rule}]` : ''}`);
            if (evaluation.warning)
                write(`warning: ${evaluation.warning}`);
            const bucket = (label, entries) => {
                if (entries.length === 0)
                    return;
                write(`${label}:`);
                for (const entry of entries)
                    write(`  ${entry.raw}`);
            };
            bucket('matched deny', matches.deny);
            bucket('matched ask', matches.ask);
            bucket('matched allow', matches.allow);
            if (projectError)
                write(`! ${projectError}`);
            return 0;
        }
        case 'trust': {
            const target = args[1] ?? cwd;
            const canonical = trustProject(target);
            if (options.json)
                write(JSON.stringify({ trusted: canonical }));
            else
                write(`Trusted ${canonical}`);
            return 0;
        }
        case 'untrust': {
            const target = args[1] ?? cwd;
            const removed = untrustProject(target);
            if (options.json)
                write(JSON.stringify({ untrusted: canonicalProjectPath(target), removed }));
            else
                write(removed ? `Removed trust for ${canonicalProjectPath(target)}` : `Not trusted: ${canonicalProjectPath(target)}`);
            return 0;
        }
        case 'list': {
            const entries = listTrustedProjects();
            if (options.json) {
                write(JSON.stringify({ directories: entries }));
            }
            else if (entries.length === 0) {
                write('No trusted projects.');
            }
            else {
                for (const entry of entries)
                    write(entry);
            }
            return 0;
        }
        case 'show':
        default: {
            const { rules, projectLoaded, projectError } = loadEffectiveRules(cwd);
            if (options.json) {
                write(JSON.stringify({
                    cwd: canonicalProjectPath(cwd),
                    trusted: isProjectTrusted(cwd),
                    projectRulesLoaded: projectLoaded,
                    projectError: projectError ?? null,
                    allow: rules.allow.map((rule) => rule.raw),
                    ask: rules.ask.map((rule) => rule.raw),
                    deny: rules.deny.map((rule) => rule.raw),
                    errors: rules.errors,
                }));
                return 0;
            }
            write(`project: ${canonicalProjectPath(cwd)} (${isProjectTrusted(cwd) ? 'trusted' : 'not trusted'})`);
            if (projectError)
                write(`! ${projectError}`);
            for (const line of describeRuleSet(rules))
                write(line);
            return 0;
        }
    }
}
