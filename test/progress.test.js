import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { buildProgress, currentMilestone, formatProgress, parseProgressArgs } from '../src/progress.js';

const records = DEFAULT_CONFIG.records;
const taskFile = {
  primary_delivery_sequence: ['I0', 'I1', 'I2'],
  deferred_milestones: { IX: {} },
  tasks: [
    { id: 'F00', milestone: 'I0', status: 'done', depends_on: [] },
    { id: 'G0', milestone: 'I0', status: 'done', depends_on: ['F00'] },
    { id: 'F10', milestone: 'I1', status: 'done', depends_on: ['G0'] },
    { id: 'F11', milestone: 'I1', status: 'implementing', depends_on: ['G0'] },
    { id: 'F12', milestone: 'I1', status: 'planned', depends_on: ['F10'] },
    { id: 'F13', milestone: 'I1', status: 'planned', depends_on: ['F11'] },
    { id: 'G1', milestone: 'I1', status: 'planned', depends_on: ['F10', 'F11', 'F12', 'F13'] },
    { id: 'F20', milestone: 'I2', status: 'planned', depends_on: ['G1'] },
    { id: 'F90', milestone: 'IX', status: 'planned', depends_on: [], scheduling: 'deferred-stretch' },
  ],
};
const leaseFile = { leases: [
  { taskId: 'F11', state: 'paused', branch: 'task/F11', headSha: 'abcdef1234', remaining: 'acceptance run' },
  { taskId: 'F11-integration', state: 'done' },
  { taskId: 'studio-local', state: 'active', kind: 'runtime-allocation' },
] };

test('currentMilestone is the first in sequence with unfinished, non-deferred packets', () => {
  assert.equal(currentMilestone(taskFile, records), 'I1');
  const allDone = { ...taskFile, tasks: taskFile.tasks.map(t => ({ ...t, status: t.milestone === 'IX' ? t.status : 'done' })) };
  assert.equal(currentMilestone(allDone, records), 'I2');
});

test('buildProgress counts, finds the gate, honours cross-milestone prerequisites and lists leases', () => {
  const r = buildProgress({ taskFile, leaseFile, head: 'abc1234' }, records);
  assert.equal(r.milestone, 'I1');
  assert.deepEqual(r.byStatus, { done: 1, implementing: 1, planned: 3 });
  assert.equal(r.gate, 'G1');
  assert.deepEqual(r.gateRemainingIds, ['F11', 'F12', 'F13']);
  assert.deepEqual(r.readyToDispatch, ['F12']);
  assert.equal(r.openLeases, 1);
  assert.equal(r.openLeaseDetail[0].headSha, 'abcdef123');
  assert.deepEqual(r.statusLeaseMismatches, []);
  const later = buildProgress({ taskFile, leaseFile, milestone: 'I2' }, records);
  assert.deepEqual(later.readyToDispatch, [], 'G1 is not done, so F20 is not ready');
});

test('status and lease disagreements are reported', () => {
  const tf = { ...taskFile, tasks: taskFile.tasks.map(t => (t.id === 'F12' ? { ...t, status: 'implementing' } : t)) };
  const lf = { leases: [{ taskId: 'F13', state: 'active' }, { taskId: 'F10', state: 'active' }] };
  const r = buildProgress({ taskFile: tf, leaseFile: lf }, records);
  assert.deepEqual(r.statusLeaseMismatches.sort(), [
    'F10 is done but lease(s) still open: F10(active)',
    'F11 is implementing but has no lease',
    'F12 is implementing but has no lease',
    'F13 is planned but has lease(s) F13',
  ].sort());
  assert.match(formatProgress(r, records), /Status\/lease mismatches \(4\)/);
});

test('parseProgressArgs', () => {
  assert.deepEqual(parseProgressArgs(['--milestone', 'I2', '--since', 'abc', '--json']), { milestone: 'I2', since: 'abc', json: true, help: false });
  assert.throws(() => parseProgressArgs(['--since']), /needs a ref/);
});
