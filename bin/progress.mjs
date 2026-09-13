#!/usr/bin/env node
/** `agent-progress` — packets done, ready, open leases and remaining work, status/lease mismatches. */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { gitOutput, splitRecords } from '../src/guard.js';
import { PROGRESS_USAGE, buildProgress, formatProgress, parseProgressArgs } from '../src/progress.js';

function main(argv) {
  let options; let config; let root;
  try {
    const { configPath, rest } = extractConfigFlag(argv);
    options = parseProgressArgs(rest);
    ({ config, root } = loadConfig({ configPath }));
  } catch (error) { process.stderr.write(`${error.message}\n\n${PROGRESS_USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${PROGRESS_USAGE}\n`); return 0; }
  const { records, guard } = config;
  const tasksPath = path.join(root, records.tasksFile);
  if (!existsSync(tasksPath)) { process.stderr.write(`no task graph at ${records.tasksFile}\n`); return 1; }
  const taskFile = JSON.parse(readFileSync(tasksPath, 'utf8'));
  const leasesPath = path.join(root, records.leasesFile);
  const leaseFile = existsSync(leasesPath) ? JSON.parse(readFileSync(leasesPath, 'utf8')) : null;
  let head = null;
  let integrations = [];
  try {
    head = gitOutput(['rev-parse', '--short', 'HEAD'], { cwd: root }).trim();
    if (options.since) {
      integrations = splitRecords(gitOutput(['log', `--format=%h %s%x1f%(trailers:key=${guard.integratesTrailer},valueonly)%x1e`, `${options.since}..HEAD`], { cwd: root }))
        .map(l => l.split('\x1f')).filter(([, t]) => (t ?? '').trim()).map(([s, t]) => `${s.trim()} [${t.trim()}]`);
    }
  } catch { /* not a git repository: report without git facts */ }
  const report = buildProgress({ taskFile, leaseFile, milestone: options.milestone, integrations, since: options.since, head }, records);
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatProgress(report, records)}\n`);
  return 0;
}
process.exitCode = main(process.argv.slice(2));
