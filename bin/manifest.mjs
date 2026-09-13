#!/usr/bin/env node
/** `agent-manifest` — write or check an evidence run's manifest.json. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { MANIFEST_USAGE, buildManifest, checkManifest } from '../src/manifest.js';

function main(argv) {
  const dir = argv.find(a => !a.startsWith('--'));
  if (!dir || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${MANIFEST_USAGE}\n`); return dir ? 0 : 2; }
  const root = path.resolve(dir);
  const target = path.join(root, 'manifest.json');
  if (argv.includes('--check')) {
    const result = checkManifest(root, JSON.parse(readFileSync(target, 'utf8')));
    process.stdout.write(`manifest check: ${result.missing.length} missing, ${result.changed.length} changed, ${result.unlisted.length} unlisted\n`);
    for (const m of result.missing) process.stdout.write(`- missing ${m}\n`);
    for (const c of result.changed) process.stdout.write(`- changed ${c}\n`);
    for (const a of result.unlisted) process.stdout.write(`- unlisted ${a}\n`);
    return result.missing.length || result.changed.length ? 1 : 0;
  }
  const manifest = buildManifest(root);
  writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`wrote ${path.relative(process.cwd(), target)}: ${manifest.totals.files} artifacts, ${(manifest.totals.bytes / 1048576).toFixed(1)} MB, ${manifest.totals.committedSamples} committed sample(s)\n`);
  return 0;
}
process.exitCode = main(process.argv.slice(2));
