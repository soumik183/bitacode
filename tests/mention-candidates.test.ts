import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectMentionCandidates } from '../src/utils/mention-candidates.js';
import type { MentionCandidate } from '../src/utils/mention-candidates.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitacode-mention-candidates-'));
const cwd = path.join(root, 'workspace');
const homeDir = path.join(root, 'home');

fs.mkdirSync(path.join(cwd, 'src', 'components'), { recursive: true });
fs.mkdirSync(path.join(cwd, 'assets'), { recursive: true });
fs.writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export {};\n');
fs.writeFileSync(path.join(cwd, 'src', 'components', 'Button.tsx'), 'export {};\n');

function writeSkill(base: string, name: string, description: string): void {
  const skillDir = path.join(base, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    'utf8',
  );
}

writeSkill(path.join(homeDir, '.agents', 'skills'), 'reviewer', 'Review code changes thoroughly.');
writeSkill(path.join(cwd, '.agents', 'skills'), 'releaser', 'Prepare releases and changelogs.');
writeSkill(path.join(homeDir, '.agents', 'skills'), 'guidebook', 'Alpha beta gamma '.repeat(6).trim());

after(() => fs.rmSync(root, { recursive: true, force: true }));

function ofKind(candidates: MentionCandidate[], kind: MentionCandidate['kind']): MentionCandidate[] {
  return candidates.filter((candidate) => candidate.kind === kind);
}

test('empty token returns immediate folder entries and all skills', async () => {
  const result = await collectMentionCandidates(cwd, '', { homeDir });

  assert.equal(result.error, undefined);
  const labels = result.candidates.map((candidate) => candidate.label);
  assert.ok(labels.includes('src/'));
  assert.ok(labels.includes('assets/'));
  assert.ok(labels.includes('README.md'));
  assert.ok(!labels.includes('src/components/Button.tsx'));

  const directories = ofKind(result.candidates, 'directory');
  const files = ofKind(result.candidates, 'file');
  const skills = ofKind(result.candidates, 'skill');
  assert.deepEqual(directories.map((candidate) => candidate.id), ['file:assets', 'file:src']);
  assert.deepEqual(files.map((candidate) => candidate.id), ['file:README.md']);
  assert.deepEqual(skills.map((candidate) => candidate.label), ['guidebook', 'releaser', 'reviewer']);

  const lastSkillIndex = Math.max(
    ...result.candidates.map((candidate, index) => (candidate.kind === 'skill' ? index : -1)),
  );
  const firstFsIndex = result.candidates.findIndex((candidate) => candidate.kind !== 'skill');
  assert.ok(lastSkillIndex < firstFsIndex, 'skills must precede files');

  assert.equal(skills.find((candidate) => candidate.label === 'reviewer')?.source, 'user');
  assert.equal(skills.find((candidate) => candidate.label === 'releaser')?.source, 'project');
  const longDetail = skills.find((candidate) => candidate.label === 'guidebook')?.detail ?? '';
  assert.equal(longDetail.length, 70);
  assert.ok(longDetail.endsWith('…'));
});

test('skills are returned before files with their kind and source intact', async () => {
  const result = await collectMentionCandidates(cwd, '', { homeDir });
  const firstFileIndex = result.candidates.findIndex((candidate) => candidate.kind !== 'skill');

  assert.ok(firstFileIndex > 0, 'the result mixes skills and files');
  const skills = result.candidates.slice(0, firstFileIndex);
  assert.ok(skills.every((candidate) => candidate.kind === 'skill'));
  assert.deepEqual(
    skills.map((candidate) => candidate.id).sort(),
    ['skill:guidebook', 'skill:releaser', 'skill:reviewer'],
  );
  assert.equal(skills.find((candidate) => candidate.id === 'skill:reviewer')?.source, 'user');
  assert.equal(skills.find((candidate) => candidate.id === 'skill:releaser')?.source, 'project');
  assert.ok(result.candidates.slice(firstFileIndex).every((candidate) => candidate.kind !== 'skill'));
});

test('typed token finds a nested file with its full relative-path label', async () => {
  const result = await collectMentionCandidates(cwd, 'Button', { homeDir });

  const button = result.candidates.find((candidate) => candidate.label === 'src/components/Button.tsx');
  assert.ok(button);
  assert.equal(button.id, 'file:src/components/Button.tsx');
  assert.equal(button.kind, 'file');
  assert.equal(button.detail, 'File');
  assert.deepEqual(ofKind(result.candidates, 'skill'), []);
});

test('token normalization strips @ and ./ for matching', async () => {
  const pathResult = await collectMentionCandidates(cwd, '@./src/index', { homeDir });
  assert.ok(pathResult.candidates.some((candidate) => candidate.label === 'src/index.ts'));

  const skillResult = await collectMentionCandidates(cwd, '@review', { homeDir });
  assert.deepEqual(ofKind(skillResult.candidates, 'skill').map((candidate) => candidate.label), ['reviewer']);
  assert.ok(ofKind(skillResult.candidates, 'skill').every((candidate) => candidate.detail !== 'skill'));
});

test('token filters both files and skills', async () => {
  const files = await collectMentionCandidates(cwd, 'index', { homeDir });
  assert.deepEqual(
    ofKind(files.candidates, 'file').map((candidate) => candidate.label),
    ['src/index.ts'],
  );
  assert.deepEqual(ofKind(files.candidates, 'skill'), []);

  const skills = await collectMentionCandidates(cwd, 'releaser', { homeDir });
  assert.deepEqual(
    ofKind(skills.candidates, 'skill').map((candidate) => candidate.label),
    ['releaser'],
  );
  assert.deepEqual(
    ofKind(skills.candidates, 'file').concat(ofKind(skills.candidates, 'directory')),
    [],
  );
});

test('missing cwd still returns skills and an aggregated error', async () => {
  const result = await collectMentionCandidates(path.join(root, 'not-a-directory'), 'review', { homeDir });

  assert.ok(result.error);
  assert.match(result.error!, /^Could not read files: /);
  assert.deepEqual(ofKind(result.candidates, 'skill').map((candidate) => candidate.label), ['reviewer']);
  assert.equal(result.candidates.length, 1);
});

test('limit caps file candidates but not skills', async () => {
  const result = await collectMentionCandidates(cwd, '', { homeDir, limit: 1 });

  assert.equal(ofKind(result.candidates, 'file').length + ofKind(result.candidates, 'directory').length, 1);
  assert.equal(ofKind(result.candidates, 'skill').length, 3);
});
