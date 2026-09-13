#!/usr/bin/env node
/** `agent-init` — bootstrap the policy, templates, guidance folder and config into a project. */
import path from 'node:path';
import process from 'node:process';
import { INIT_USAGE, initProject } from '../src/init.js';

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${INIT_USAGE}\n`); return 0; }
  const target = path.resolve(argv.find(a => !a.startsWith('--')) ?? '.');
  const { written, kept } = initProject({ target, force: argv.includes('--force') });
  process.stdout.write(`initialised ${target}\n`);
  for (const w of written) process.stdout.write(`- wrote ${w}\n`);
  for (const k of kept) process.stdout.write(`- kept ${k}\n`);
  process.stdout.write('\nNext: fill AGENTS.md sections 1 and 3 for your lanes, create execution/tasks.json, then run agent-admin and agent-wave --dry-run --once.\n');
  return 0;
}
process.exitCode = main(process.argv.slice(2));
