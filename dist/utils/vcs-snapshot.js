/**
 * vcs-snapshot.ts — opt-in, git-native per-turn snapshots.
 *
 * Mirrors the idea behind OpenCode v2's `plugin/vcs/git.ts` and `vcs/patch.ts`:
 * a snapshot is a real git object hung off `refs/bitacode/snapshots/<id>`, so
 * it survives process restarts and needs no private patch format.
 *
 * Safety is the whole point of this helper:
 *  - it reads git only (`status`, `stash create`, `commit-tree`, `update-ref`);
 *    it never runs `add`, `commit` on the working tree, or `stash push`;
 *  - outside a git repo every function is a no-op result;
 *  - restore defaults to a dry run and refuses a dirty working tree;
 *  - no `git` command is ever given `--force`.
 *
 * Metadata (capture time, changed paths, apply strategy) is kept in a small
 * JSON file inside the repository's git dir, keyed by the validated id. The
 * refs remain the source of truth for which snapshots exist: a missing meta
 * file degrades gracefully to fields derived from the ref itself.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const SNAPSHOT_PREFIX = 'refs/bitacode/snapshots';
const ID_PATTERN = /^[A-Za-z0-9._-]{1,60}$/;
const OID_PATTERN = /^[0-9a-fA-F]{40,64}$/;
const MAX_FILES = 500;
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 1024 * 1024;
/** True when `id` is a safe, git-ref-compatible snapshot identifier. */
export function isValidSnapshotId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id))
        return false;
    // Git rejects these even though the slug grammar above would allow them.
    if (id === '.' || id === '..' || id.startsWith('.') || id.endsWith('.lock'))
        return false;
    return true;
}
/**
 * Build a snapshot id: a sanitised label prefix plus a timestamp and a short
 * random suffix for uniqueness. Always matches `isValidSnapshotId`.
 */
export function makeSnapshotId(label, now = Date.now(), nonce = Math.random()) {
    const base = String(label ?? '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[.-]+|[.-]+$/g, '')
        .slice(0, 40) || 'snapshot';
    const stamp = Math.trunc(Math.abs(now)).toString(36);
    const random = Math.trunc(Math.abs(nonce) * 0xffffff).toString(36).padStart(4, '0').slice(0, 6);
    return `${base}-${stamp}-${random}`.slice(0, 60);
}
function errorMessage(error) {
    const text = error instanceof Error ? error.message : String(error);
    return text.split('\n').map((line) => line.trim()).filter(Boolean).slice(-1)[0] || 'unknown error';
}
function gitError(stderr, fallback) {
    const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
    return lines.slice(-2).join(' ') || errorMessage(fallback);
}
/** Single controlled entry point for every git invocation in this module. */
function git(cwd, args) {
    return new Promise((resolve) => {
        try {
            execFile('git', args, {
                cwd,
                timeout: GIT_TIMEOUT_MS,
                maxBuffer: GIT_MAX_BUFFER,
                windowsHide: true,
            }, (error, stdout, stderr) => {
                if (error) {
                    resolve({ ok: false, error: gitError(String(stderr ?? ''), error) });
                    return;
                }
                resolve({
                    ok: true,
                    value: { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') },
                });
            });
        }
        catch (error) {
            resolve({ ok: false, error: errorMessage(error) });
        }
    });
}
function resolveCwd(options) {
    return options?.cwd?.trim() || process.cwd();
}
/** Best-effort parse of `git status --porcelain`, capped at 500 paths. */
function changedPaths(output) {
    const paths = [];
    for (const line of output.split('\n')) {
        if (line.length < 4 || paths.length >= MAX_FILES)
            continue;
        let target = line.slice(3);
        const arrow = target.indexOf(' -> '); // renames: keep the destination
        if (arrow >= 0)
            target = target.slice(arrow + 4);
        if (target.startsWith('"') && target.endsWith('"')) {
            try {
                const decoded = JSON.parse(target);
                if (typeof decoded === 'string')
                    target = decoded;
            }
            catch {
                // Git's \nnn escapes are not JSON; keep the raw quoted form.
            }
        }
        if (target && !paths.includes(target))
            paths.push(target);
    }
    return paths.slice(0, MAX_FILES);
}
async function gitDir(cwd) {
    const result = await git(cwd, ['rev-parse', '--absolute-git-dir']);
    if (!result.ok)
        return result;
    return { ok: true, value: result.value.stdout.trim() };
}
function metaPath(gitDirectory, id) {
    return path.join(gitDirectory, 'bitacode-snapshots', `${id}.json`);
}
async function readMeta(gitDirectory, id) {
    try {
        const raw = await fs.readFile(metaPath(gitDirectory, id), 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.id !== id)
            return null;
        if (typeof parsed.createdAt !== 'string' || !parsed.createdAt)
            return null;
        const kind = parsed.kind === 'stash' || parsed.kind === 'tree' ? parsed.kind : null;
        if (!kind)
            return null;
        const files = Array.isArray(parsed.files)
            ? parsed.files.filter((entry) => typeof entry === 'string').slice(0, MAX_FILES)
            : [];
        return { id, ref: `${SNAPSHOT_PREFIX}/${id}`, createdAt: parsed.createdAt, files, kind };
    }
    catch {
        return null;
    }
}
async function writeMeta(gitDirectory, meta) {
    const file = metaPath(gitDirectory, meta.id);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}
/** Whether a commit object looks like a stash (2+ parents) or a plain commit. */
async function inferKind(cwd, ref) {
    const result = await git(cwd, ['rev-list', '--parents', '-n', '1', ref]);
    if (!result.ok)
        return 'tree';
    const fields = result.value.stdout.trim().split(/\s+/).filter(Boolean);
    return fields.length - 1 >= 2 ? 'stash' : 'tree';
}
/** True when the cwd is inside a git work tree. Never throws. */
export async function isGitRepo(cwd) {
    try {
        const result = await git(resolveCwd({ cwd }), ['rev-parse', '--is-inside-work-tree']);
        return result.ok && result.value.stdout.trim() === 'true';
    }
    catch {
        return false;
    }
}
/**
 * Capture the current working-tree state as a git object and pin it under a
 * snapshot ref. The working tree, index and branch are never modified.
 *
 * A dirty tree uses `git stash create` (which only writes objects). A clean
 * tree gets a small `git commit-tree` object based on HEAD's tree so there is
 * still a ref to list and delete.
 */
export async function createSnapshot(label, options) {
    const cwd = resolveCwd(options);
    try {
        if (!(await isGitRepo(cwd)))
            return { ok: false, error: 'not a git repository' };
        let id = '';
        for (let attempt = 0; attempt < 5; attempt++) {
            const candidate = makeSnapshotId(label, Date.now(), Math.random());
            const existing = await git(cwd, ['show-ref', '--verify', '--quiet', `${SNAPSHOT_PREFIX}/${candidate}`]);
            if (!existing.ok) {
                id = candidate;
                break;
            }
        }
        if (!id)
            return { ok: false, error: 'could not allocate a unique snapshot id' };
        const ref = `${SNAPSHOT_PREFIX}/${id}`;
        const createdAt = new Date().toISOString();
        const status = await git(cwd, ['status', '--porcelain']);
        const files = status.ok ? changedPaths(status.value.stdout) : [];
        const stash = await git(cwd, ['stash', 'create']);
        const stashOid = stash.ok ? stash.value.stdout.trim() : '';
        let oid = OID_PATTERN.test(stashOid) ? stashOid : '';
        let kind = 'stash';
        if (!oid) {
            // Clean tree (or `stash create` unavailable): write a standalone commit
            // object without touching the working tree or the index.
            kind = 'tree';
            const head = await git(cwd, ['rev-parse', '--verify', 'HEAD']);
            const hasHead = head.ok && OID_PATTERN.test(head.value.stdout.trim());
            const treeResult = hasHead
                ? await git(cwd, ['rev-parse', '--verify', 'HEAD^{tree}'])
                : await git(cwd, ['mktree']);
            if (!treeResult.ok)
                return { ok: false, error: `git resolve tree: ${treeResult.error}` };
            const tree = treeResult.value.stdout.trim();
            if (!OID_PATTERN.test(tree))
                return { ok: false, error: 'could not resolve a tree object' };
            const message = `bitacode snapshot ${id}\n${JSON.stringify({ id, createdAt, files })}`;
            const committed = await git(cwd, [
                'commit-tree', tree, ...(hasHead ? ['-p', 'HEAD'] : []), '-m', message,
            ]);
            if (!committed.ok)
                return { ok: false, error: `git commit-tree: ${committed.error}` };
            oid = committed.value.stdout.trim();
        }
        if (!OID_PATTERN.test(oid))
            return { ok: false, error: 'git did not return a commit object' };
        const updated = await git(cwd, ['update-ref', ref, oid]);
        if (!updated.ok)
            return { ok: false, error: `git update-ref: ${updated.error}` };
        const meta = { id, ref, createdAt, files, kind };
        const directory = await gitDir(cwd);
        if (directory.ok) {
            try {
                await writeMeta(directory.value, meta);
            }
            catch {
                // Metadata is an optimisation; the ref alone is enough to list/delete.
            }
        }
        return { ok: true, value: { id, ref, createdAt, files } };
    }
    catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}
/** List snapshots from `refs/bitacode/snapshots`; empty output is not an error. */
export async function listSnapshots(options) {
    const cwd = resolveCwd(options);
    try {
        if (!(await isGitRepo(cwd)))
            return { ok: false, error: 'not a git repository' };
        const result = await git(cwd, [
            'for-each-ref',
            `--format=%(refname)%00%(objectname)%00%(creatordate:iso8601)%00%(contents:subject)`,
            SNAPSHOT_PREFIX,
        ]);
        if (!result.ok)
            return { ok: false, error: `git for-each-ref: ${result.error}` };
        const output = result.value.stdout.trim();
        if (!output)
            return { ok: true, value: [] };
        const directory = await gitDir(cwd);
        const snapshots = [];
        for (const line of output.split('\n')) {
            const fields = line.split('\0');
            const ref = fields[0] ?? '';
            if (!ref.startsWith(`${SNAPSHOT_PREFIX}/`))
                continue;
            const id = ref.slice(SNAPSHOT_PREFIX.length + 1);
            if (!isValidSnapshotId(id))
                continue;
            const meta = directory.ok ? await readMeta(directory.value, id) : null;
            snapshots.push({
                id,
                ref,
                createdAt: meta?.createdAt || fields[2] || new Date().toISOString(),
                files: meta?.files ?? [],
            });
        }
        snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
        return { ok: true, value: snapshots };
    }
    catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}
/**
 * Restore a snapshot. `dryRun` defaults to true: nothing is executed and the
 * explanation of the command that *would* run is returned in `error` (the
 * `VcsResult<void>` value type has no message channel).
 *
 * With `dryRun: false` the restore refuses to run on a dirty working tree,
 * then applies either a stash (`git stash apply <ref>`) or a tree-based
 * snapshot (`git restore --source <ref> -- <paths>`). No `--force` is used.
 */
export async function restoreSnapshot(id, options) {
    if (!isValidSnapshotId(id))
        return { ok: false, error: `invalid snapshot id: ${String(id).slice(0, 80)}` };
    const cwd = resolveCwd(options);
    const dryRun = options?.dryRun !== false;
    try {
        if (!(await isGitRepo(cwd)))
            return { ok: false, error: 'not a git repository' };
        const ref = `${SNAPSHOT_PREFIX}/${id}`;
        const resolved = await git(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
        if (!resolved.ok)
            return { ok: false, error: `unknown snapshot: ${id}` };
        const directory = await gitDir(cwd);
        const meta = directory.ok ? await readMeta(directory.value, id) : null;
        const kind = meta?.kind ?? (await inferKind(cwd, ref));
        const files = meta?.files ?? [];
        const command = kind === 'stash'
            ? `git stash apply ${ref}`
            : `git restore --source ${ref} -- ${files.join(' ') || '(no captured paths)'}`;
        if (dryRun) {
            return { ok: false, error: `dry-run: would run "${command}" — no changes were made` };
        }
        const status = await git(cwd, ['status', '--porcelain']);
        if (!status.ok)
            return { ok: false, error: `git status: ${status.error}` };
        if (status.value.stdout.trim()) {
            return { ok: false, error: 'working tree is dirty; refusing to restore (commit or stash your changes first)' };
        }
        if (kind === 'tree' && files.length === 0)
            return { ok: true, value: undefined };
        const args = kind === 'stash'
            ? ['stash', 'apply', ref]
            : ['restore', '--source', ref, '--', ...files];
        const applied = await git(cwd, args);
        if (!applied.ok)
            return { ok: false, error: `git ${args[0]}: ${applied.error}` };
        return { ok: true, value: undefined };
    }
    catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}
/** Delete a snapshot ref (only if it still points at the expected object). */
export async function deleteSnapshot(id, options) {
    if (!isValidSnapshotId(id))
        return { ok: false, error: `invalid snapshot id: ${String(id).slice(0, 80)}` };
    const cwd = resolveCwd(options);
    try {
        if (!(await isGitRepo(cwd)))
            return { ok: false, error: 'not a git repository' };
        const ref = `${SNAPSHOT_PREFIX}/${id}`;
        const resolved = await git(cwd, ['rev-parse', '--verify', ref]);
        if (!resolved.ok)
            return { ok: false, error: `unknown snapshot: ${id}` };
        const oid = resolved.value.stdout.trim();
        const deleted = await git(cwd, ['update-ref', '-d', ref, oid]);
        if (!deleted.ok)
            return { ok: false, error: `git update-ref -d: ${deleted.error}` };
        const directory = await gitDir(cwd);
        if (directory.ok) {
            try {
                await fs.rm(metaPath(directory.value, id), { force: true });
            }
            catch {
                // A stale meta file is harmless; list ignores refs that are gone.
            }
        }
        return { ok: true, value: undefined };
    }
    catch (error) {
        return { ok: false, error: errorMessage(error) };
    }
}
