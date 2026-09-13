/**
 * Admin check: the administrative records stay consistent with each other and with the
 * policy file. Every check is skipped when its file is absent, so a project adopts them
 * one at a time. Local files only; prints paths and counts, never file contents.
 *
 * Checks: the Now block size and that its "next packet" is not frozen in the priority
 * file; packet status agrees with lease state; the task board is generated from
 * tasks.json; relative links in live documents resolve; every repository path the policy
 * file cites in backticks exists; no live document cites an archived one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildProgress } from './progress.js';
import { renderBoard } from './board.js';

const readText = file => readFileSync(file, 'utf8');
const readJson = file => JSON.parse(readText(file));

export function nowBlock(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`${escaped}\\r?\\n([\\s\\S]*?)(?:\\r?\\n## |$)`));
  return match ? match[1] : null;
}

export function packetIds(text) {
  return text.match(/\b[FG]\d{1,3}\b/g) ?? [];
}

/** Lists markdown files for each `liveDocs` entry: a file is itself, a directory is its *.md children. */
export function expandDocs(root, entries) {
  const docs = [];
  for (const entry of entries) {
    const full = path.join(root, entry);
    if (!existsSync(full)) continue;
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) if (name.endsWith('.md')) docs.push(`${entry}/${name}`.replace(/^\.\//, ''));
    } else docs.push(entry);
  }
  return docs;
}

export function runAdmin({ root, records, agentDefDirs = ['.claude/agents', '.codex/agents'] }) {
  const failures = [];
  const notes = [];
  const at = rel => path.join(root, rel);

  // 1. Now block.
  if (existsSync(at(records.resumeFile))) {
    const resume = readText(at(records.resumeFile));
    const now = nowBlock(resume, records.nowHeading);
    if (now === null) failures.push(`${records.resumeFile} has no "${records.nowHeading}" block`);
    else {
      const lines = now.split(/\r?\n/).filter(l => l.trim());
      if (lines.length > records.nowMaxLines) failures.push(`Now block has ${lines.length} lines (limit ${records.nowMaxLines})`);
      const next = lines.find(l => /next packet/i.test(l)) ?? '';
      if (!next) failures.push('Now block names no "next packet"');
      if (existsSync(at(records.priorityFile))) {
        const frozen = new Set();
        for (const line of readText(at(records.priorityFile)).split(/\r?\n/)) if (/frozen/i.test(line)) for (const id of packetIds(line)) frozen.add(id);
        for (const id of packetIds(next)) if (frozen.has(id)) failures.push(`Now block names ${id} as next packet but ${records.priorityFile} freezes it`);
        notes.push(`frozen: ${[...frozen].join(', ') || 'none'}`);
      }
    }
    if (statSync(at(records.resumeFile)).size > records.resumeMaxBytes) failures.push(`${records.resumeFile} exceeds ${records.resumeMaxBytes} bytes`);
  }

  // 2 and 3. Status versus leases; board freshness.
  if (existsSync(at(records.tasksFile))) {
    const taskFile = readJson(at(records.tasksFile));
    const leaseFile = existsSync(at(records.leasesFile)) ? readJson(at(records.leasesFile)) : null;
    const report = buildProgress({ taskFile, leaseFile }, records);
    for (const m of report.statusLeaseMismatches) failures.push(`status/lease mismatch: ${m}`);
    notes.push(`${report.milestone}: ${report.byStatus[records.statuses.done] ?? 0}/${report.packets} done`);
    if (existsSync(at(records.taskBoardFile))) {
      const board = readText(at(records.taskBoardFile)).replace(/\r\n/g, '\n').trim();
      const rendered = renderBoard(taskFile, { records, boardDir: path.posix.dirname(records.taskBoardFile) }).trim();
      if (board !== rendered) failures.push(`${records.taskBoardFile} is stale or hand-edited; run agent-board`);
    }
  }

  // 4. Links.
  const docs = expandDocs(root, records.liveDocs);
  let links = 0;
  for (const doc of docs) {
    const text = readText(at(doc)).replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      links += 1;
      if (!existsSync(path.resolve(root, path.dirname(doc), target))) failures.push(`broken link in ${doc}: ${target}`);
    }
  }
  notes.push(`${links} links in ${docs.length} documents`);

  // 5. Policy citations.
  if (existsSync(at(records.policyFile))) {
    const policy = readText(at(records.policyFile));
    for (const m of policy.matchAll(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.<>*-]+)+\/?)`/g)) {
      const p = m[1];
      if (/[<>*]/.test(p) || p.startsWith('.')) continue;
      if (!existsSync(at(p))) failures.push(`${records.policyFile} cites missing path: ${p}`);
    }
  }

  // 6. Archived documents are not cited by live documents or agent definitions.
  if (records.archivedDocs.length) {
    const enforce = [...docs];
    for (const dir of agentDefDirs) if (existsSync(at(dir))) for (const name of readdirSync(at(dir))) enforce.push(`${dir}/${name}`);
    for (const doc of enforce) {
      const text = readText(at(doc));
      for (const archived of records.archivedDocs) if (text.includes(archived)) failures.push(`${doc} cites archived document ${archived}`);
    }
  }

  return { ok: failures.length === 0, failures, notes };
}

export function formatAdmin(result) {
  const lines = [`admin check: ${result.failures.length ? `${result.failures.length} failure(s)` : 'ok'} (${result.notes.join('; ')})`];
  for (const f of result.failures) lines.push(`- ${f}`);
  return lines.join('\n');
}

export const ADMIN_USAGE = `Usage: agent-admin [--json] [--config path]

Checks the records named in the config (records.*) for consistency. Exit 1 on failure.
`;
