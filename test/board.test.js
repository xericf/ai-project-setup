import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { renderBoard } from '../src/board.js';

const records = DEFAULT_CONFIG.records;
const taskFile = {
  primary_delivery_sequence: ['I0', 'I1'],
  deferred_milestones: { I3: {} },
  tasks: [
    { id: 'F00', milestone: 'I0', status: 'done', depends_on: [], title: 'Recon | setup', lane: 'INT', packet: 'execution/tasks/F00.md' },
    { id: 'F10', milestone: 'I1', status: 'planned', depends_on: ['F00'], title: 'Core', lane: 'CORE', packet: 'execution/tasks/F10.md' },
    { id: 'F30', milestone: 'I3', status: 'planned', depends_on: [], title: 'Offload', lane: 'PLAT', packet: 'execution/tasks/F30.md', scheduling: 'deferred-stretch' },
  ],
};

test('renderBoard is deterministic and reflects counts, order, deferral and links', () => {
  const a = renderBoard(taskFile, { records, boardDir: 'execution' });
  const b = renderBoard(taskFile, { records, boardDir: 'execution' });
  assert.equal(a, b);
  assert.match(a, /3 packets: 1 done, 0 implementing, 2 planned/);
  assert.match(a, /Delivery order is I0 → I1; I3 is deferred/);
  assert.match(a, /## I0 — 1\/1 done/);
  assert.match(a, /## I3 \(deferred\) — 0\/1 done/);
  assert.match(a, /\| F00 \| INT \| \[Recon \/ setup\]\(tasks\/F00.md\) \| done \| None \|/);
  assert.match(a, /\| F30 \| PLAT \| .* \| planned \(deferred\) \| None \|/);
  assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}T/, 'no timestamps');
});
