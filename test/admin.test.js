import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.js';
import { expandDocs, formatAdmin, nowBlock, packetIds, runAdmin } from '../src/admin.js';
import { renderBoard } from '../src/board.js';

const records = { ...DEFAULT_CONFIG.records, archivedDocs: ['OLD_PLAYBOOK.md'] };
const taskFile = { primary_delivery_sequence: ['I0'], tasks: [
  { id: 'F00', milestone: 'I0', status: 'implementing', depends_on: [], title: 'Start', lane: 'CORE', packet: 'execution/tasks/F00.md' },
  { id: 'F01', milestone: 'I0', status: 'planned', depends_on: ['F00'], title: 'Next', lane: 'UI', packet: 'execution/tasks/F01.md' },
] };

function project({ now, priority, board = true, archivedCitation = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-admin-'));
  const write = (rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
  write('AGENTS.md', `# Policy\n\nSee \`execution/tasks.json\` and [guidance](execution/guidance/README.md).${archivedCitation ? ' Read OLD_PLAYBOOK.md.' : ''}\n`);
  write('execution/tasks.json', JSON.stringify(taskFile));
  write('execution/tasks/F00.md', '# F00\n');
  write('execution/tasks/F01.md', '# F01\n');
  write('execution/leases.json', JSON.stringify({ leases: [{ taskId: 'F00', state: 'active' }] }));
  write('execution/RESUME_STATUS.md', `# Resume\n\n## Now\n\n${now ?? '- Root HEAD abc.\n- Next packet: F00.'}\n\n## Boundaries\n\nnone\n`);
  write('execution/guidance/PRIORITY.md', priority ?? '1. F00 first.\n2. F01 is frozen.\n');
  write('execution/guidance/README.md', '# Guidance\n');
  if (board) write('execution/TASK_BOARD.md', `${renderBoard(taskFile, { records, boardDir: 'execution' })}\n`);
  return root;
}

test('nowBlock and packetIds', () => {
  assert.equal(nowBlock('# R\n\n## Now\n\n- a\n- b\n\n## Boundaries\n\nx', '## Now'), '\n- a\n- b\n');
  assert.equal(nowBlock('no block', '## Now'), null);
  assert.deepEqual(packetIds('F12, G4 and F101 but not X9 or F1234'), ['F12', 'G4', 'F101']);
});

test('a consistent project passes', () => {
  const result = runAdmin({ root: project(), records });
  assert.deepEqual(result.failures, []);
  assert.match(formatAdmin(result), /admin check: ok/);
});

test('failures: frozen next packet, mismatch, stale board, broken link, archived citation, missing cited path', () => {
  const root = project({ now: '- Next packet: F01.\n- See [gone](missing.md).', archivedCitation: true });
  writeFileSync(path.join(root, 'execution/leases.json'), JSON.stringify({ leases: [] }));
  writeFileSync(path.join(root, 'execution/TASK_BOARD.md'), 'hand edited\n');
  const { failures } = runAdmin({ root, records });
  const text = failures.join('\n');
  assert.match(text, /names F01 as next packet .* freezes it/);
  assert.match(text, /F00 is implementing but has no lease/);
  assert.match(text, /TASK_BOARD.md is stale/);
  assert.match(text, /broken link in execution\/RESUME_STATUS.md: missing.md/);
  assert.match(text, /AGENTS.md cites archived document OLD_PLAYBOOK.md/);
});

test('the Now block line limit and a missing next packet fail', () => {
  const lines = Array.from({ length: 26 }, (_, i) => `- line ${i}`).join('\n');
  const { failures } = runAdmin({ root: project({ now: lines }), records });
  assert.match(failures.join('\n'), /Now block has 26 lines/);
  assert.match(failures.join('\n'), /names no "next packet"/);
});

test('expandDocs lists files and directory markdown, skipping absent entries', () => {
  const root = project();
  const docs = expandDocs(root, ['AGENTS.md', 'execution/guidance', 'nope']);
  assert.deepEqual(docs.sort(), ['AGENTS.md', 'execution/guidance/PRIORITY.md', 'execution/guidance/README.md']);
});
