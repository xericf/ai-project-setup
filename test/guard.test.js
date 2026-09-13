import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { formatGuard, isImplementationPath, parseGuardArgs, parseLogLine, runGuard } from '../src/guard.js';

const guard = { ...DEFAULT_CONFIG.guard, implementationRoots: ['src/'], ownedPrefixes: ['src/assembly/'] };

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  const commit = (file, message) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), `${message}\n`);
    git(dir, 'add', file);
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

test('isImplementationPath honours roots and owned prefixes', () => {
  assert.equal(isImplementationPath('src/feature/a.js', guard), true);
  assert.equal(isImplementationPath('src/assembly/root.js', guard), false);
  assert.equal(isImplementationPath('docs/x.md', guard), false);
});

test('parseLogLine splits fields and detects merges', () => {
  const line = ['abc', 'p1 p2', 'merge it', '', ''].join('\x1f');
  assert.deepEqual(parseLogLine(line), { sha: 'abc', merge: true, subject: 'merge it', integrates: '', reviewedBy: '' });
});

test('a direct implementation commit without the trailer is a violation; a trailered one is not', () => {
  const { dir, commit } = repo();
  const base = commit('README.md', 'chore: start');
  commit('src/feature/a.js', 'feat: direct edit');
  commit('src/feature/b.js', 'feat: integrated\n\nIntegrates: F01 task/F01 deadbeef\nReviewed-by: reviewer');
  commit('src/assembly/root.js', 'chore: assembly wiring (owned)');
  commit('docs/notes.md', 'docs: notes');
  const report = runGuard({ since: base, cwd: dir, guard });
  assert.equal(report.commits, 4);
  assert.equal(report.integrations, 1);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].subject, 'feat: direct edit');
  assert.deepEqual(report.violations[0].files, ['src/feature/a.js']);
  assert.equal(report.warnings.length, 0);
  assert.match(formatGuard(report), /VIOLATION .* feat: direct edit/);
});

test('an integration without Reviewed-by warns, and evidence floods warn', () => {
  const { dir, commit } = repo();
  const base = commit('README.md', 'chore: start');
  commit('src/x.js', 'feat: unreviewed\n\nIntegrates: F02 task/F02 cafebabe');
  const report = runGuard({ since: base, cwd: dir, guard: { ...guard, evidenceWarnFiles: 0 }, files: () => ['src/x.js', 'docs/evidence/run/a.png'] });
  assert.equal(report.violations.length, 0);
  assert.equal(report.warnings.length, 2);
});

test('parseGuardArgs reads flags and rejects unknown ones', () => {
  assert.deepEqual(parseGuardArgs(['--since', 'abc', '--strict', '--json']), { since: 'abc', json: true, strict: true, help: false });
  assert.throws(() => parseGuardArgs(['--nope']), /Unknown argument/);
});
