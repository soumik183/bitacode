import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { registerDynamicHandler, registerDynamicTool, unregisterDynamicHandler, unregisterDynamicTool, } from './tools/index.js';
import { setAllowedPathRoots } from './utils/path-validation.js';
import { logger } from './utils/logger.js';
const ACTIVATE_SKILL_TOOL_NAME = 'activate_skill';
const VALID_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_RESOURCE_FILES = 200;
const MAX_SKILL_FILE_BYTES = 256 * 1024;
// Discovery is expensive and happens once for the system prompt and again on
// every activateSkill(). Cache the promise (not just the result) so concurrent
// callers with the same roots share a single filesystem scan. Callers get a
// shallow array copy so they cannot mutate what is stored here.
const skillsCache = new Map();
export function clearSkillsCache() {
    skillsCache.clear();
}
function skillCacheKey(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const homeDir = options.homeDir ?? os.homedir();
    return JSON.stringify({ cwd, homeDir, roots: getSkillRoots(options) });
}
function getSkillRoots(options = {}) {
    const cwd = options.cwd ?? process.cwd();
    const homeDir = options.homeDir ?? os.homedir();
    return [
        { dir: path.join(homeDir, '.agents', 'skills'), source: 'user' },
        { dir: path.join(homeDir, '.bitacode', 'skills'), source: 'user' },
        { dir: path.join(homeDir, '.config', 'bitacode', 'skills'), source: 'user' },
        { dir: path.join(cwd, '.agents', 'skills'), source: 'project' },
        { dir: path.join(cwd, '.bitacode', 'skills'), source: 'project' },
    ];
}
function parseFrontmatter(rawContent) {
    const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) {
        throw new Error('SKILL.md must begin with YAML frontmatter delimited by --- lines.');
    }
    const document = YAML.parse(match[1]);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
        throw new Error('Frontmatter must parse to an object.');
    }
    return {
        frontmatter: document,
        body: match[2].trim(),
    };
}
function isValidSkillName(name) {
    return name.length >= 1 && name.length <= 64 && VALID_SKILL_NAME.test(name);
}
// normalizeMetadata ensures the metadata field is an object with string values, or undefined if not provided or invalid
function normalizeMetadata(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const entries = Object.entries(value).filter(([, entryValue]) => typeof entryValue === 'string');
    if (entries.length === 0)
        return undefined;
    return Object.fromEntries(entries);
}
function validateSkill(parsed, skillDir, source, location) {
    const name = typeof parsed.frontmatter.name === 'string' ? parsed.frontmatter.name.trim() : '';
    const description = typeof parsed.frontmatter.description === 'string'
        ? parsed.frontmatter.description.trim()
        : '';
    const compatibility = typeof parsed.frontmatter.compatibility === 'string'
        ? parsed.frontmatter.compatibility.trim()
        : undefined;
    const license = typeof parsed.frontmatter.license === 'string'
        ? parsed.frontmatter.license.trim()
        : undefined;
    const allowedToolsValue = typeof parsed.frontmatter['allowed-tools'] === 'string'
        ? parsed.frontmatter['allowed-tools'].trim()
        : undefined;
    if (!isValidSkillName(name)) {
        throw new Error(`Skill name "${name}" is invalid.`);
    }
    if (path.basename(skillDir) !== name) {
        throw new Error(`Skill name "${name}" must match directory name "${path.basename(skillDir)}".`);
    }
    if (!description || description.length > 1024) {
        throw new Error('Skill description is required and must be 1-1024 characters.');
    }
    if (compatibility !== undefined && (compatibility.length === 0 || compatibility.length > 500)) {
        throw new Error('Skill compatibility must be 1-500 characters when provided.');
    }
    return {
        name,
        description,
        source,
        location,
        skillDir,
        body: parsed.body,
        compatibility,
        license,
        metadata: normalizeMetadata(parsed.frontmatter.metadata),
        allowedTools: allowedToolsValue ? allowedToolsValue.split(/\s+/).filter(Boolean) : undefined,
    };
}
async function loadSkillFromDirectory(skillDir, source) {
    const location = path.join(skillDir, 'SKILL.md');
    try {
        const stats = await fs.stat(location);
        if (stats.size > MAX_SKILL_FILE_BYTES) {
            logger.warn(`Skipping oversized SKILL.md at ${location} (${stats.size} bytes > ${MAX_SKILL_FILE_BYTES} bytes).`);
            return null;
        }
        const rawContent = await fs.readFile(location, 'utf8');
        const parsed = parseFrontmatter(rawContent);
        const skill = validateSkill(parsed, skillDir, source, location);
        logger.info(`Loaded skill: ${skill.name} (${source})`, { location });
        return skill;
    }
    catch (error) {
        logger.warn(`Skipping invalid skill at ${location}`, {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}
async function discoverSkillsInRoot(root) {
    let entries = [];
    try {
        entries = await fs.readdir(root.dir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const loaded = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => loadSkillFromDirectory(path.join(root.dir, entry.name), root.source)));
    return loaded.filter((skill) => skill !== null);
}
async function discoverAllSkills(options) {
    const roots = getSkillRoots(options);
    const merged = new Map();
    for (const root of roots) {
        const skills = await discoverSkillsInRoot(root);
        for (const skill of skills) {
            if (merged.has(skill.name)) {
                logger.warn(`Skill collision detected for "${skill.name}". Using ${skill.source}-level version.`, {
                    location: skill.location,
                });
            }
            merged.set(skill.name, skill);
        }
    }
    return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}
export async function loadSkills(options = {}) {
    const key = skillCacheKey(options);
    let cached = skillsCache.get(key);
    if (!cached) {
        cached = discoverAllSkills(options);
        skillsCache.set(key, cached);
    }
    return [...(await cached)];
}
function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
export function buildSkillsCatalogSection(skills) {
    if (skills.length === 0)
        return '';
    const catalog = skills
        .map((skill) => [
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(skill.location)}</location>`,
        '  </skill>',
    ].join('\n'))
        .join('\n');
    return `AVAILABLE SKILLS

The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, call the ${ACTIVATE_SKILL_TOOL_NAME} tool with the skill's name before proceeding.
After activation, treat paths listed in the skill output as readable resources and resolve relative paths against the skill directory.

<available_skills>
${catalog}
</available_skills>`;
}
function isPathInside(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function listSkillResources(skillDir) {
    const files = [];
    let realSkillDir;
    try {
        realSkillDir = await fs.realpath(skillDir);
    }
    catch {
        return [];
    }
    async function walk(relativeDir) {
        if (files.length >= MAX_RESOURCE_FILES)
            return;
        const absoluteDir = path.join(skillDir, relativeDir);
        let realDir;
        try {
            realDir = await fs.realpath(absoluteDir);
        }
        catch {
            return;
        }
        // A top-level resource dir symlinked to an outside location must not be walked.
        if (!isPathInside(realSkillDir, realDir))
            return;
        let entries = [];
        try {
            entries = await fs.readdir(absoluteDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (files.length >= MAX_RESOURCE_FILES)
                return;
            const nextRelative = path.join(relativeDir, entry.name);
            if (entry.isDirectory()) {
                await walk(nextRelative);
            }
            else {
                // Dirent.isDirectory() is false for symlinks, so a symlinked file (or
                // dir) would be listed above. Verify its real target stays in the skill.
                let realFile;
                try {
                    realFile = await fs.realpath(path.join(absoluteDir, entry.name));
                }
                catch {
                    continue;
                }
                if (!isPathInside(realSkillDir, realFile))
                    continue;
                files.push(nextRelative.split(path.sep).join('/'));
            }
        }
    }
    for (const dir of ['scripts', 'references', 'assets']) {
        await walk(dir);
    }
    return [...new Set(files)].sort();
}
export async function activateSkill(skillName, options = {}) {
    const skills = await loadSkills(options);
    const skill = skills.find((entry) => entry.name === skillName);
    if (!skill) {
        return `Error: Unknown skill "${skillName}".`;
    }
    const resources = await listSkillResources(skill.skillDir);
    const resourcesBlock = resources.length > 0
        ? `<skill_resources>\n${resources.map((resource) => `  <file>${escapeXml(resource)}</file>`).join('\n')}\n</skill_resources>`
        : '<skill_resources />';
    return `<skill_content name="${escapeXml(skill.name)}">\n${skill.body}\n\nSkill directory: ${escapeXml(skill.skillDir)}\nRelative paths in this skill are relative to the skill directory. Use absolute paths in tool calls when needed.\n\n${resourcesBlock}\n</skill_content>`;
}
export async function initializeSkillsSupport(options = {}) {
    const skills = await loadSkills(options);
    await setAllowedPathRoots(skills.map((skill) => skill.skillDir));
    if (skills.length === 0) {
        unregisterDynamicTool(ACTIVATE_SKILL_TOOL_NAME);
        unregisterDynamicHandler(ACTIVATE_SKILL_TOOL_NAME);
        return [];
    }
    registerDynamicTool({
        type: 'function',
        function: {
            name: ACTIVATE_SKILL_TOOL_NAME,
            description: 'Load the full instructions for a discovered skill so you can follow it for the current task.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        enum: skills.map((skill) => skill.name),
                        description: 'The exact skill name to activate.',
                    },
                },
                required: ['name'],
            },
        },
    });
    registerDynamicHandler(ACTIVATE_SKILL_TOOL_NAME, async (args) => activateSkill(args.name, options));
    return skills;
}
