/**
 * Evidence manifest: records path, size and sha256 of every artifact in a run directory
 * so raw captures can stay local (gitignored) while the commit still proves what existed.
 * `README.md` and `manifest.json` are excluded; files under `samples/` are marked as the
 * committed samples.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['manifest.json', 'README.md']);

export function walkArtifacts(root) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (SKIP.has(rel)) continue;
      out.push({ path: rel, bytes: statSync(full).size, sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), committed: rel.startsWith('samples/') });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function buildManifest(root, { now = () => new Date().toISOString(), cwd = process.cwd() } = {}) {
  const files = walkArtifacts(root);
  return {
    schemaVersion: 1,
    root: path.relative(cwd, root).split(path.sep).join('/'),
    generatedAt: now(),
    totals: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), committedSamples: files.filter(f => f.committed).length },
    files,
  };
}

/** Compares the directory against a previous manifest. */
export function checkManifest(root, previous) {
  const files = walkArtifacts(root);
  const prev = new Map(previous.files.map(f => [f.path, f.sha256]));
  return {
    missing: previous.files.filter(f => !files.some(g => g.path === f.path)).map(f => f.path),
    changed: files.filter(f => prev.has(f.path) && prev.get(f.path) !== f.sha256).map(f => f.path),
    unlisted: files.filter(f => !prev.has(f.path)).map(f => f.path),
  };
}

export const MANIFEST_USAGE = `Usage: agent-manifest <run-dir> [--check]

Writes <run-dir>/manifest.json (path, bytes, sha256 per artifact). --check verifies the
directory against the committed manifest and exits 1 on missing or changed files.
`;
