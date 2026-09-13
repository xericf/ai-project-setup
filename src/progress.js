/**
 * Progress meter.
 *
 * The objective signal that a project is moving: packets done per milestone, gate
 * prerequisites left, packets ready to dispatch, open leases with their remaining work,
 * and packets whose status disagrees with their lease state.
 *
 * Expected task graph shape (`records.tasksFile`):
 *   { primary_delivery_sequence?: ["I0","I1",...], deferred_milestones?: {...},
 *     tasks: [{ id, milestone, status, depends_on: [], scheduling?, title?, lane?, packet? }] }
 * Expected lease ledger shape (`records.leasesFile`, optional):
 *   { leases: [{ taskId, state, branch?, headSha?, remaining?, note?, kind? }] }
 */

export function currentMilestone(taskFile, records) {
  const list = taskFile.tasks ?? [];
  const sequence = Array.isArray(taskFile.primary_delivery_sequence) && taskFile.primary_delivery_sequence.length
    ? taskFile.primary_delivery_sequence
    : [...new Set(list.map(t => t.milestone))];
  const unfinished = m => list.some(t => t.milestone === m && t.status !== records.statuses.done && t.scheduling !== records.deferredScheduling);
  return sequence.find(unfinished) ?? sequence.at(-1) ?? null;
}

const trim = (value, max) => {
  if (!value) return '';
  const text = String(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/**
 * Builds the report. `integrations` are commits with the integration trailer since a
 * ref; the caller supplies them (see agent-guard) so this module stays free of git.
 */
export function buildProgress({ taskFile, leaseFile = null, milestone = 'auto', integrations = [], since = null, head = null }, records) {
  const all = taskFile.tasks ?? [];
  const chosen = milestone === 'auto' ? currentMilestone(taskFile, records) : milestone;
  const packets = all.filter(t => t.milestone === chosen);
  const byStatus = {};
  for (const t of packets) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

  const doneAnywhere = new Set(all.filter(t => t.status === records.statuses.done).map(t => t.id));
  const known = new Set(all.map(t => t.id));
  const met = id => doneAnywhere.has(id) || !known.has(id);
  const gate = packets.find(t => /^G/.test(t.id)) ?? null;
  const gateRemaining = gate ? (gate.depends_on ?? []).filter(id => !doneAnywhere.has(id)) : [];
  const ready = packets
    .filter(t => t.status === records.statuses.planned && t.scheduling !== records.deferredScheduling && (t.depends_on ?? []).every(met))
    .map(t => t.id);

  const leases = (leaseFile?.leases ?? []).filter(l => l.kind !== records.runtimeAllocationKind);
  const open = leases.filter(l => l.state !== 'done');
  const openLeaseDetail = open.map(l => ({
    taskId: l.taskId, state: l.state, branch: l.branch ?? null,
    headSha: (l.headSha ?? '').slice(0, 9) || null, remaining: trim(l.remaining ?? l.note, 160),
  }));

  const mismatches = [];
  if (leaseFile) {
    const leasesFor = id => leases.filter(l => l.taskId === id || String(l.taskId).startsWith(`${id}-`));
    for (const t of packets) {
      const mine = leasesFor(t.id);
      const stillOpen = mine.filter(l => l.state !== 'done');
      if (t.status === records.statuses.implementing && !mine.length) mismatches.push(`${t.id} is implementing but has no lease`);
      if (t.status === records.statuses.planned && mine.length) mismatches.push(`${t.id} is planned but has lease(s) ${mine.map(l => l.taskId).join(', ')}`);
      if (t.status === records.statuses.done && stillOpen.length) mismatches.push(`${t.id} is done but lease(s) still open: ${stillOpen.map(l => `${l.taskId}(${l.state})`).join(', ')}`);
    }
  }

  return {
    milestone: chosen, head, packets: packets.length, byStatus,
    gate: gate?.id ?? null, gateRemaining: gateRemaining.length, gateRemainingIds: gateRemaining,
    readyToDispatch: ready, openLeases: open.length, openLeaseDetail, statusLeaseMismatches: mismatches,
    since, integrations,
  };
}

export function formatProgress(report, records) {
  const done = report.byStatus[records.statuses.done] ?? 0;
  const pct = report.packets ? Math.round((100 * done) / report.packets) : 0;
  const lines = [
    `${report.milestone ?? 'no milestone'}${report.head ? ` at ${report.head}` : ''}: ${done}/${report.packets} packets done (${pct}%), ${report.byStatus[records.statuses.implementing] ?? 0} implementing, ${report.byStatus[records.statuses.planned] ?? 0} planned` +
      (report.gate ? `; ${report.gate} waits on ${report.gateRemaining} prerequisites.` : '.'),
    `Ready to dispatch (prerequisites done): ${report.readyToDispatch.length ? report.readyToDispatch.join(', ') : 'none'}.`,
    `Open leases (${report.openLeases}), remaining work per lease (read the lease file only for a packet you touch):`,
  ];
  for (const l of report.openLeaseDetail) lines.push(`- ${l.taskId} [${l.state}] ${l.branch ?? ''}${l.headSha ? ` @${l.headSha}` : ''}${l.remaining ? ` — ${l.remaining}` : ''}`);
  if (!report.openLeaseDetail.length) lines.push('- none');
  if (report.statusLeaseMismatches.length) {
    lines.push(`Status/lease mismatches (${report.statusLeaseMismatches.length}), integrator to reconcile:`);
    for (const m of report.statusLeaseMismatches) lines.push(`- ${m}`);
  }
  if (report.since) {
    lines.push(`Integrations since ${report.since}: ${report.integrations.length}`);
    for (const i of report.integrations) lines.push(`- ${i}`);
  }
  return lines.join('\n');
}

export const PROGRESS_USAGE = `Usage: agent-progress [--milestone auto|<id>] [--since <ref>] [--json] [--config path]

Reads records.tasksFile (and records.leasesFile when present) from the config root.
--since lists commits carrying the integration trailer in <ref>..HEAD.
`;

export function parseProgressArgs(argv) {
  const options = { milestone: 'auto', since: null, json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--milestone') { options.milestone = argv[++i]; if (!options.milestone) throw new Error('--milestone needs a value.'); }
    else if (arg.startsWith('--milestone=')) options.milestone = arg.slice(12);
    else if (arg === '--since') { options.since = argv[++i]; if (!options.since) throw new Error('--since needs a ref.'); }
    else if (arg.startsWith('--since=')) options.since = arg.slice(8);
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}
