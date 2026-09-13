import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildManifest, checkManifest, walkArtifacts } from '../src/manifest.js';

function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-manifest-'));
  mkdirSync(path.join(root, 'browser'), { recursive: true });
  mkdirSync(path.join(root, 'samples'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), 'readme');
  writeFileSync(path.join(root, 'browser', 'a.png'), 'x');
  writeFileSync(path.join(root, 'dump.json'), '{}');
  writeFileSync(path.join(root, 'samples', 'b.png'), 'y');
  return root;
}

test('walkArtifacts skips README and manifest, marks samples, sorts by path', () => {
  const root = run();
  const files = walkArtifacts(root);
  assert.deepEqual(files.map(f => f.path), ['browser/a.png', 'dump.json', 'samples/b.png']);
  assert.deepEqual(files.map(f => f.committed), [false, false, true]);
  assert.equal(files[0].sha256, '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
});

test('buildManifest totals and checkManifest detects change, loss and additions', () => {
  const root = run();
  const manifest = buildManifest(root, { now: () => '2026-01-01T00:00:00.000Z', cwd: root });
  assert.deepEqual(manifest.totals, { files: 3, bytes: 4, committedSamples: 1 });
  assert.deepEqual(checkManifest(root, manifest), { missing: [], changed: [], unlisted: [] });
  writeFileSync(path.join(root, 'browser', 'a.png'), 'zz');
  writeFileSync(path.join(root, 'new.txt'), 'n');
  const result = checkManifest(root, manifest);
  assert.deepEqual(result, { missing: [], changed: ['browser/a.png'], unlisted: ['new.txt'] });
});
