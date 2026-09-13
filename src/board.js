/**
 * Task board renderer: a deterministic human view of the task graph so the board can
 * never drift from the record. No timestamps; identical input gives identical output.
 */
import path from 'node:path';

export function renderBoard(taskFile, { records, boardDir = 'execution' } = {}) {
  const tasks = taskFile.tasks ?? [];
  const sequence = taskFile.primary_delivery_sequence ?? [...new Set(tasks.map(t => t.milestone))];
  const deferred = Object.keys(taskFile.deferred_milestones ?? {});
  const milestones = [...sequence, ...deferred.filter(m => !sequence.includes(m))];
  const count = (list, status) => list.filter(t => t.status === status).length;
  const s = records.statuses;
  const lines = [
    '# Task board',
    '',
    'Generated from tasks.json by `agent-board`; do not edit by hand. Status is the integrator\'s record.',
    `Delivery order is ${sequence.join(' → ')}${deferred.length ? `; ${deferred.join(', ')} is deferred, ineligible until explicitly activated.` : '.'}`,
    '',
    `${tasks.length} packets: ${count(tasks, s.done)} done, ${count(tasks, s.implementing)} implementing, ${count(tasks, s.planned)} planned.`,
    '',
  ];
  for (const m of milestones) {
    const list = tasks.filter(t => t.milestone === m);
    if (!list.length) continue;
    lines.push(`## ${m}${deferred.includes(m) ? ' (deferred)' : ''} — ${count(list, s.done)}/${list.length} done`, '');
    lines.push('| ID | Lane | Deliverable | Status | Prerequisites |', '|---|---|---|---|---|');
    for (const t of list) {
      const title = String(t.title ?? t.id).replace(/\|/g, '/');
      const deliverable = t.packet ? `[${title}](${path.posix.relative(boardDir, t.packet)})` : title;
      const sched = t.scheduling === records.deferredScheduling ? ' (deferred)' : '';
      lines.push(`| ${t.id} | ${t.lane ?? ''} | ${deliverable} | ${t.status}${sched} | ${(t.depends_on ?? []).join(', ') || 'None'} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export const BOARD_USAGE = `Usage: agent-board [--check] [--config path]

Writes records.taskBoardFile from records.tasksFile. --check exits 1 when the committed
board differs from what tasks.json renders.
`;
