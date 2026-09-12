import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONFIG_FILENAME, ConfigError, DEFAULT_CONFIG, extractConfigFlag, findConfigFile, loadConfig, mergeConfig,
} from '../src/config.js';

function fixture(config, { depth = 0 } = {}) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-config-'));
  if (config) writeFileSync(path.join(base, CONFIG_FILENAME), JSON.stringify(config, null, 2));
  const nested = path.join(base, ...Array.from({ length: depth }, (_, index) => `level-${index}`));
  if (depth) mkdirSync(nested, { recursive: true });
  return { base, nested };
}

test('the defaults stand on their own when no config file exists', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-empty-'));
  const deep = path.join(base, 'a', 'b');
  mkdirSync(deep, { recursive: true });
  // The search walks to the filesystem root, so only assert on what it returns.
  const { config, source } = loadConfig({ cwd: deep });
  if (source === null) {
    assert.deepEqual(config, DEFAULT_CONFIG);
  }
  assert.equal(config.pacing.bands.length >= 1, true);
  assert.equal(typeof config.claudeProjectDirGlob, 'string');
});

test('the search walks upward from the working directory', () => {
  const { base, nested } = fixture({ claudeProjectDirGlob: '*Demo*' }, { depth: 3 });
  const found = findConfigFile(nested);
  assert.equal(found, path.join(base, CONFIG_FILENAME));
  const { config, root } = loadConfig({ cwd: nested });
  assert.equal(config.claudeProjectDirGlob, '*Demo*');
  assert.equal(root, base);
});

test('a file merges over the defaults key by key without dropping the rest', () => {
  const { base } = fixture({
    reviewSummaryDirs: ['.dev/reviews'],
    pacing: { sessionBlockUsedPct: 70, tierAdvice: { perModelMeter: 'Current week (Opus)' } },
  });
  const { config, source } = loadConfig({ cwd: base });
  assert.equal(source, path.join(base, CONFIG_FILENAME));
  assert.deepEqual(config.reviewSummaryDirs, ['.dev/reviews']);
  assert.equal(config.pacing.sessionBlockUsedPct, 70);
  assert.equal(config.pacing.weeklyReserveUsedPct, 90, 'untouched keys keep their default');
  assert.equal(config.pacing.tierAdvice.perModelMeter, 'Current week (Opus)');
  assert.equal(config.pacing.tierAdvice.allModelMeter, DEFAULT_CONFIG.pacing.tierAdvice.allModelMeter);
  assert.deepEqual(config.pacing.bands, DEFAULT_CONFIG.pacing.bands);
  assert.deepEqual(DEFAULT_CONFIG.reviewSummaryDirs, [], 'the defaults are not mutated');
});

test('arrays replace rather than merge', () => {
  const merged = mergeConfig(DEFAULT_CONFIG, { pacing: { bands: [{ slots: 3 }] } });
  assert.deepEqual(merged.pacing.bands, [{ slots: 3 }]);
});

test('--config overrides the search and must name an existing file', () => {
  const { base } = fixture({ claudeProjectDirGlob: '*Found*' });
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-other-'));
  const { config } = loadConfig({ configPath: path.join(base, CONFIG_FILENAME), cwd: elsewhere });
  assert.equal(config.claudeProjectDirGlob, '*Found*');
  assert.throws(
    () => loadConfig({ configPath: path.join(elsewhere, 'nope.json') }),
    error => error instanceof ConfigError && /not found/.test(error.message),
  );
});

test('invalid JSON and invalid values are rejected with a config error', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-bad-'));
  const broken = path.join(base, 'broken.json');
  writeFileSync(broken, '{ not json');
  assert.throws(() => loadConfig({ configPath: broken }), ConfigError);

  const cases = [
    { pacing: { bands: [] } },
    { pacing: { bands: [{ slots: -1 }] } },
    { pacing: { bands: [{ gapBelow: 'soon', slots: 1 }, { slots: 0 }] } },
    { pacing: { bands: [{ gapBelow: 0, slots: 1 }] } },
    { pacing: { sessionBlockUsedPct: 140 } },
    { reviewSummaryDirs: 'reviews' },
    { claudeProjectDirGlob: '' },
  ];
  for (const [index, value] of cases.entries()) {
    const file = path.join(base, `case-${index}.json`);
    writeFileSync(file, JSON.stringify(value));
    assert.throws(() => loadConfig({ configPath: file }), ConfigError, `case ${index} must be rejected`);
  }
});

test('--config is extracted out of argv in both spellings', () => {
  assert.deepEqual(extractConfigFlag(['--json', '--config', 'a.json', '--runs']),
    { configPath: 'a.json', rest: ['--json', '--runs'] });
  assert.deepEqual(extractConfigFlag(['--config=b.json']), { configPath: 'b.json', rest: [] });
  assert.deepEqual(extractConfigFlag(['--json']), { configPath: null, rest: ['--json'] });
  assert.throws(() => extractConfigFlag(['--config']), ConfigError);
  assert.throws(() => extractConfigFlag(['--config', '--json']), ConfigError);
});

test('the shipped example config is valid and loads', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const { config } = loadConfig({ configPath: path.join(repoRoot, CONFIG_FILENAME) });
  assert.deepEqual(config, DEFAULT_CONFIG);
});
