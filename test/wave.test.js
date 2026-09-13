import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { composePrompt, loadState, parseWaveArgs, readNow, runnerInvocation, saveState } from '../src/wave.js';

const wave = DEFAULT_CONFIG.wave;

test('parseWaveArgs applies config defaults, flags and the per-runner model', () => {
  const a = parseWaveArgs([], wave);
  assert.equal(a.runner, 'codex');
  assert.equal(a.model, wave.model.codex);
  assert.equal(a.maxWaves, wave.maxWaves);
  const b = parseWaveArgs(['--runner', 'claude', '--once', '--budget', '10', '--runner-args', '--foo bar'], wave);
  assert.equal(b.model, wave.model.claude);
  assert.equal(b.maxWaves, 1);
  assert.equal(b.budget, 10);
  assert.deepEqual(b.runnerArgs, ['--foo', 'bar']);
  assert.throws(() => parseWaveArgs(['--runner', 'gpt'], wave), /codex or claude/);
  assert.throws(() => parseWaveArgs(['--budget', '-1'], wave), /non-negative/);
  assert.throws(() => parseWaveArgs(['--bogus'], wave), /Unknown argument/);
});

test('composePrompt fills placeholders inside a text fence and leaves unknown keys visible', () => {
  const template = 'ignored\n```text\nWave {{WAVE}} · {{NOW}}\n{{MISSING}}\n```\n';
  assert.equal(composePrompt(template, { WAVE: '3', NOW: 'state' }), 'Wave 3 · state\n{{MISSING}}\n');
  assert.equal(composePrompt('plain {{X}}', { X: 'y' }), 'plain y');
});

test('runnerInvocation puts the prompt on stdin and never in argv', () => {
  const codex = runnerInvocation({ runner: 'codex', exe: 'C:/codex.exe', model: 'm', effort: 'high', repo: '/r', lastMessageFile: '/r/last.md', extra: ['--x'] });
  assert.equal(codex.exe, 'C:/codex.exe');
  assert.deepEqual(codex.args, ['exec', '--full-auto', '-C', '/r', '--sandbox', 'workspace-write', '-m', 'm', '-c', 'model_reasoning_effort="high"', '-o', '/r/last.md', '--x', '-']);
  const claude = runnerInvocation({ runner: 'claude', exe: '/bin/claude', model: null, effort: 'high', repo: '/r', lastMessageFile: '/r/last.md' });
  assert.deepEqual(claude.args, ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text']);
});

test('readNow extracts the Now block and state round-trips', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-wave-'));
  const resume = path.join(dir, 'RESUME_STATUS.md');
  writeFileSync(resume, '# R\r\n\r\n## Now\r\n\r\n- a\r\n- b\r\n\r\n## Boundaries\r\n\r\nx\r\n');
  assert.equal(readNow(resume, '## Now'), '- a\r\n- b');
  assert.equal(readNow(path.join(dir, 'missing.md'), '## Now'), '(no resume file)');
  const stateFile = path.join(dir, 'nested', 'state.json');
  const state = loadState(stateFile);
  assert.deepEqual(state, { wave: 0, lastHead: null, lastMessageFile: null, parkedStreak: 0 });
  state.wave = 2;
  saveState(stateFile, state);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).wave, 2);
});
