#!/usr/bin/env node
/** `agent-guard` — verify implementation code reached HEAD only through reviewed integrations. */
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { GUARD_USAGE, formatGuard, parseGuardArgs, runGuard } from '../src/guard.js';

function main(argv) {
  let options; let config; let root;
  try {
    const { configPath, rest } = extractConfigFlag(argv);
    options = parseGuardArgs(rest);
    ({ config, root } = loadConfig({ configPath }));
  } catch (error) { process.stderr.write(`${error.message}\n\n${GUARD_USAGE}\n`); return 2; }
  if (options.help) { process.stdout.write(`${GUARD_USAGE}\n`); return 0; }
  let report;
  try { report = runGuard({ since: options.since, cwd: root, guard: config.guard }); } catch (error) { process.stderr.write(`${error.message}\n`); return 1; }
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatGuard(report)}\n`);
  return options.strict && report.violations.length ? 1 : 0;
}
process.exitCode = main(process.argv.slice(2));
