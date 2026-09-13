#!/usr/bin/env node
/** `agent-admin` — administrative records consistent with each other and the policy file. */
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { ADMIN_USAGE, formatAdmin, runAdmin } from '../src/admin.js';

function main(argv) {
  let config; let root; let rest;
  try {
    const flags = extractConfigFlag(argv);
    rest = flags.rest;
    ({ config, root } = loadConfig({ configPath: flags.configPath }));
  } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { process.stdout.write(`${ADMIN_USAGE}\n`); return 0; }
  const result = runAdmin({ root, records: config.records });
  process.stdout.write(`${rest.includes('--json') ? JSON.stringify(result, null, 2) : formatAdmin(result)}\n`);
  return result.ok ? 0 : 1;
}
process.exitCode = main(process.argv.slice(2));
