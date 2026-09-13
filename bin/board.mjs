#!/usr/bin/env node
/** `agent-board` — generate (or check) the human task board from tasks.json. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { BOARD_USAGE, renderBoard } from '../src/board.js';

function main(argv) {
  let config; let root; let rest;
  try {
    const flags = extractConfigFlag(argv);
    rest = flags.rest;
    ({ config, root } = loadConfig({ configPath: flags.configPath }));
  } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  if (rest.includes('--help') || rest.includes('-h')) { process.stdout.write(`${BOARD_USAGE}\n`); return 0; }
  const { records } = config;
  const tasksPath = path.join(root, records.tasksFile);
  if (!existsSync(tasksPath)) { process.stderr.write(`no task graph at ${records.tasksFile}\n`); return 1; }
  const rendered = renderBoard(JSON.parse(readFileSync(tasksPath, 'utf8')), { records, boardDir: path.posix.dirname(records.taskBoardFile) });
  const boardPath = path.join(root, records.taskBoardFile);
  if (rest.includes('--check')) {
    const current = existsSync(boardPath) ? readFileSync(boardPath, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current.trim() !== rendered.trim()) { process.stdout.write(`${records.taskBoardFile} is stale; run agent-board\n`); return 1; }
    process.stdout.write(`${records.taskBoardFile} is current\n`);
    return 0;
  }
  writeFileSync(boardPath, `${rendered}\n`);
  process.stdout.write(`wrote ${records.taskBoardFile} (${rendered.split('\n').length} lines)\n`);
  return 0;
}
process.exitCode = main(process.argv.slice(2));
