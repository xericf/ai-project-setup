import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_FILENAME } from '../src/config.js';
import { GITIGNORE_LINES, INIT_FILES, initProject } from '../src/init.js';

test('initProject copies every template, writes config and gitignore, and keeps existing files', () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'agent-init-'));
  writeFileSync(path.join(target, 'AGENTS.md'), 'mine\n');
  writeFileSync(path.join(target, '.gitignore'), 'node_modules/\n');
  const first = initProject({ target });
  assert.ok(first.kept.includes('AGENTS.md'));
  assert.equal(readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), 'mine\n');
  for (const dest of Object.keys(INIT_FILES)) if (dest !== 'AGENTS.md') assert.ok(existsSync(path.join(target, dest)), dest);
  assert.ok(existsSync(path.join(target, CONFIG_FILENAME)));
  const ignore = readFileSync(path.join(target, '.gitignore'), 'utf8');
  assert.ok(ignore.startsWith('node_modules/\n'));
  for (const line of GITIGNORE_LINES) assert.ok(ignore.includes(line), line);
  const second = initProject({ target });
  assert.deepEqual(second.written, []);
  assert.equal(readFileSync(path.join(target, '.gitignore'), 'utf8'), ignore, 'gitignore is not appended twice');
});

test('--force overwrites templates but never the config', () => {
  const target = mkdtempSync(path.join(os.tmpdir(), 'agent-init-force-'));
  initProject({ target });
  writeFileSync(path.join(target, 'AGENTS.md'), 'edited\n');
  writeFileSync(path.join(target, CONFIG_FILENAME), '{"claudeProjectDirGlob":"*Mine*"}\n');
  const result = initProject({ target, force: true });
  assert.ok(result.written.includes('AGENTS.md'));
  assert.notEqual(readFileSync(path.join(target, 'AGENTS.md'), 'utf8'), 'edited\n');
  assert.equal(readFileSync(path.join(target, CONFIG_FILENAME), 'utf8'), '{"claudeProjectDirGlob":"*Mine*"}\n');
});
