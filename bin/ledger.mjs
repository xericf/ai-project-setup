#!/usr/bin/env node
/**
 * `agent-ledger` — aggregate the local Codex and Claude Code logs.
 *
 * Exit codes: 0 success, 1 no configured source could be read at all, 2 bad
 * arguments. Only ids, paths, labels and integer counts are printed.
 */
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { LEDGER_USAGE, collectLedger, formatTable, parseArgs } from '../src/ledger.js';

function main(argv) {
  let options;
  let configPath;
  let rest;
  try {
    ({ configPath, rest } = extractConfigFlag(argv));
    options = parseArgs(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${LEDGER_USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${LEDGER_USAGE}\n`);
    return 0;
  }

  let config;
  let root;
  try {
    ({ config, root } = loadConfig({ configPath }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const report = collectLedger({
    range: { since: options.since, until: options.until },
    by: options.by,
    root: configPath ? process.cwd() : root,
    config,
  });
  process.stdout.write(options.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${formatTable(report, { runs: options.runs })}\n`);

  if (!report.sources.scanned.length && report.sources.missing.length && !report.sources.skipped.length) {
    process.stderr.write('No local log source could be read (category: not-found).\n');
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
