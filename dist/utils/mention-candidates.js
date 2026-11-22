/**
 * mention-candidates.ts — data source for the `@` picker.
 *
 * Combines a bounded filesystem search with installed skills. Each source is
 * independent: a failure in one still yields candidates from the other, plus
 * an aggregated human-readable error.
 */
import fs from 'node:fs/promises';
import { loadSkills } from '../skills.js';
import { searchMentionFiles } from './mentions.js';
const SKILL_DETAIL_LENGTH = 70;
const MAX_SKILL_CANDIDATES = 8;
function isSubsequence(needle, haystack) {
    let index = 0;
    for (const char of haystack) {
        if (char === needle[index])
            index++;
        if (index === needle.length)
            return true;
    }
    return needle.length === 0;
}
function matchesSkill(skill, query) {
    if (!query)
        return true;
    const name = skill.name.toLowerCase();
    const searchable = `${name} ${skill.description.toLowerCase()}`;
    return searchable.includes(query) || isSubsequence(query, name) || isSubsequence(query, searchable);
}
function truncate(value, length) {
    return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Collect file, directory and skill candidates for the current `@` token. */
export async function collectMentionCandidates(cwd, token, options = {}) {
    const errors = [];
    const normalized = token.trim().replace(/^@+/, '').replace(/^\.\//, '').toLowerCase();
    let fileMatches = [];
    try {
        const stats = await fs.stat(cwd);
        if (!stats.isDirectory())
            throw new Error(`${cwd} is not a directory`);
        fileMatches = await searchMentionFiles(cwd, normalized, options.limit ?? 30);
    }
    catch (error) {
        errors.push(`Could not read files: ${messageOf(error)}`);
    }
    const fileCandidates = fileMatches.map((match) => ({
        id: `file:${match.relativePath}`,
        label: match.isDirectory ? `${match.relativePath}/` : match.relativePath,
        kind: match.isDirectory ? 'directory' : 'file',
        detail: match.isDirectory ? 'Directory' : 'File',
    }));
    let skills = [];
    try {
        skills = await loadSkills({ cwd, homeDir: options.homeDir });
    }
    catch (error) {
        errors.push(`Could not load skills: ${messageOf(error)}`);
    }
    const skillCandidates = skills
        .filter((skill) => matchesSkill(skill, normalized))
        .slice(0, MAX_SKILL_CANDIDATES)
        .map((skill) => ({
        id: `skill:${skill.name}`,
        label: skill.name,
        kind: 'skill',
        detail: truncate(skill.description, SKILL_DETAIL_LENGTH),
        source: skill.source,
    }));
    const seen = new Set();
    // Files/folders first, installed skills last. The popup reserves rows for
    // both groups so skills stay reachable even when the folder has many files.
    const candidates = [...fileCandidates, ...skillCandidates].filter((candidate) => {
        if (seen.has(candidate.id))
            return false;
        seen.add(candidate.id);
        return true;
    });
    return errors.length > 0
        ? { candidates, error: errors.join('; ') }
        : { candidates };
}
