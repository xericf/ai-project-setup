/**
 * Local, zero-cost usage ledger for a mixed Codex + Claude Code workflow.
 *
 * It reads only local, already-written log files and reports run/token shares per
 * provider, model and reasoning effort, the cache-read ratio per run, and
 * observed-vs-requested model mismatches. It makes no model calls and opens no
 * network socket.
 *
 * It never prints prompts, transcript content, review prose, environment values or
 * credentials: only session ids, file paths, model/effort labels and integer token
 * counts leave this module.
 *
 * SCHEMA NOTES (verified against real logs, not assumed):
 *
 * Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), one thread per file:
 *   * `session_meta.payload` carries `id`, `parent_thread_id` and `thread_source`
 *     ("user" | "subagent" | "guardian_review"), so the primary session, spawned
 *     subagent threads and the internal auto-review thread are reported apart.
 *   * `turn_context.payload` carries `model` and `effort`;
 *     `event_msg/thread_settings_applied` carries `thread_settings.model` and
 *     `.reasoning_effort`. Both spellings are accepted, and a usage event is
 *     attributed to whatever was in effect at the time.
 *   * `token_usage_record.payload.usage` is per response, while
 *     `turn_token_usage` / `thread_token_usage` are cumulative. Summing the
 *     per-response `usage` reproduced the final cumulative total exactly in every
 *     rollout checked, so this tool sums `usage` and never sums a cumulative field.
 *     `event_msg/token_count` is a fallback only, for threads that carry no
 *     `token_usage_record` at all: its LAST cumulative value is taken, because
 *     compaction resets it and summing its per-turn value over-counts.
 *   * Codex `input_tokens` INCLUDES `cached_input_tokens`, so fresh input is
 *     input - cached.
 *
 * Claude transcripts (~/.claude/projects/<dir>/*.jsonl, one dir per checkout):
 *   * assistant lines carry `message.model` and `message.usage` with cache-exclusive
 *     `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` and
 *     `output_tokens`; the total is the sum of those four.
 *   * One response is written as several lines sharing `requestId` / `message.id`
 *     and differing only in `apiBlockIndex`, each repeating the identical usage
 *     object, so usage is counted once per (requestId, message.id).
 *   * `message.model === "<synthetic>"` lines are local bookkeeping with no usage.
 *   * assistant lines may carry a top-level `effort`; the documented fallbacks are
 *     the agent definition frontmatter and the settings file. The effort source is
 *     labelled "transcript", "agent-def", "settings" or "unknown".
 *
 * Review summaries (configurable directories, *.json): `observedModels`, `usage`
 * (per-model camel-cased buckets), `exitCode`, `finishedAt`, optional
 * `requestedModel` and `effort`. A run without a requested model reports mismatch
 * `null` (unknown), never a false mismatch.
 *
 * Model and effort names are whatever the logs contain: nothing here is hard-coded
 * to one plan's model line-up. Percentages are shares of what was found locally.
 * This is not a bill and not a quota meter.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { homeDir, localDateKey, shiftDay, utcDateKey } from './platform.js';

export const CAVEAT =
  'Caveat: shares are of locally logged activity only; subscription meters are billed separately and this ledger is not a bill.';

const TOKEN_KEYS = ['freshInput', 'cacheRead', 'cacheWrite', 'output', 'total', 'reasoning'];

export function emptyTokens() {
  return { freshInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, reasoning: 0, reasoningKnown: false };
}

export function addTokens(target, delta) {
  for (const key of TOKEN_KEYS) target[key] += Number.isFinite(delta?.[key]) ? delta[key] : 0;
  if (delta?.reasoningKnown === true) target.reasoningKnown = true;
  return target;
}

const int = value => (Number.isFinite(value) ? Math.trunc(value) : 0);

/** Codex reports cache-inclusive input; total_tokens is authoritative when present. */
export function codexUsageTokens(usage) {
  const input = int(usage?.input_tokens);
  const cacheRead = int(usage?.cached_input_tokens);
  const cacheWrite = int(usage?.cache_write_input_tokens);
  const output = int(usage?.output_tokens);
  const freshInput = Math.max(0, input - cacheRead);
  const total = Number.isFinite(usage?.total_tokens) ? int(usage.total_tokens) : input + output;
  // Codex logs reasoning tokens as a subset of output; Claude usage does not split them.
  const reasoning = Number.isFinite(usage?.reasoning_output_tokens) ? int(usage.reasoning_output_tokens) : null;
  return { freshInput, cacheRead, cacheWrite, output, total, reasoning, reasoningKnown: reasoning !== null };
}

/** Claude reports cache-exclusive input; the total is the sum of the four buckets. */
export function claudeUsageTokens(usage) {
  const freshInput = int(usage?.input_tokens);
  const cacheRead = int(usage?.cache_read_input_tokens);
  const cacheWrite = int(usage?.cache_creation_input_tokens);
  const output = int(usage?.output_tokens);
  return { freshInput, cacheRead, cacheWrite, output, total: freshInput + cacheRead + cacheWrite + output, reasoning: null, reasoningKnown: false };
}

/** Review summaries use the camel-cased SDK spelling of the same four buckets. */
export function reviewUsageTokens(usage) {
  const freshInput = int(usage?.inputTokens);
  const cacheRead = int(usage?.cacheReadInputTokens);
  const cacheWrite = int(usage?.cacheCreationInputTokens);
  const output = int(usage?.outputTokens);
  return { freshInput, cacheRead, cacheWrite, output, total: freshInput + cacheRead + cacheWrite + output, reasoning: null, reasoningKnown: false };
}

/** Strips the CLI context-window suffix and a dated release suffix so models compare equal. */
export function normalizeModelName(model) {
  if (typeof model !== 'string') return '';
  return model.trim().replace(/\[\d+[a-z]\]$/i, '').replace(/-\d{8}$/, '');
}

/** Inclusive calendar-date range test; `since`/`until` are YYYY-MM-DD or null. */
export function inRange(timestamp, { since = null, until = null, dateKey = localDateKey } = {}) {
  const key = dateKey(timestamp);
  if (!key) return false;
  if (since && key < since) return false;
  if (until && key > until) return false;
  return true;
}

/** Reasoning tokens as a share of output, or null when the provider does not report them. */
export function reasoningShare(tokens) {
  if (!tokens?.reasoningKnown || !(tokens.output > 0)) return null;
  return (tokens.reasoning / tokens.output) * 100;
}

export function cacheReadRatio(tokens) {
  const denominator = tokens.cacheRead + tokens.freshInput + tokens.cacheWrite;
  return denominator > 0 ? (tokens.cacheRead / denominator) * 100 : null;
}

/**
 * True when the requested model is demonstrably not among the observed ones, false
 * when it is, null when no model was requested. Cheap bookkeeping models named in
 * `ignoreObserved` are not accepted as evidence of the requested model.
 */
export function detectMismatch(requestedModel, observedModels, { ignoreObserved = [/^claude-haiku-/] } = {}) {
  const requested = normalizeModelName(requestedModel);
  if (!requested) return null;
  const observed = (Array.isArray(observedModels) ? observedModels : [])
    .map(normalizeModelName)
    .filter(model => model && !ignoreObserved.some(pattern => pattern.test(model)));
  return !observed.includes(requested);
}

/** Reads `model`/`effort` out of an agent definition's YAML frontmatter. */
export function parseAgentDefinition(text) {
  const match = typeof text === 'string' ? text.match(/^---\r?\n([\s\S]*?)\r?\n---/) : null;
  if (!match) return {};
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^(name|model|effort):\s*(.+?)\s*$/);
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, '');
  }
  return fields;
}

/** Reads `modelSettings[model].effortLevel` out of a parsed settings file. */
export function parseSettingsEfforts(settings) {
  const modelSettings = settings?.modelSettings;
  if (!modelSettings || typeof modelSettings !== 'object') return {};
  return Object.fromEntries(Object.entries(modelSettings)
    .filter(([, value]) => typeof value?.effortLevel === 'string')
    .map(([model, value]) => [model, value.effortLevel]));
}

/**
 * Claude effort is not a usage field: prefer the transcript's own effort, then the
 * agent definition for a known subagent type, then the session default in settings.
 */
export function resolveClaudeEffort({
  model, transcriptEffort, subagentType, agentDefinitions = {}, settingsEfforts = {},
} = {}) {
  if (typeof transcriptEffort === 'string' && transcriptEffort) {
    return { effort: transcriptEffort, effortSource: 'transcript' };
  }
  const definition = subagentType ? agentDefinitions[subagentType] : null;
  if (definition?.effort) return { effort: definition.effort, effortSource: 'agent-def' };
  const normalized = normalizeModelName(model);
  for (const key of [model, normalized]) {
    if (key && settingsEfforts[key]) return { effort: settingsEfforts[key], effortSource: 'settings' };
  }
  const fromNormalized = Object.entries(settingsEfforts)
    .find(([key]) => normalizeModelName(key) === normalized && normalized);
  if (fromNormalized) return { effort: fromNormalized[1], effortSource: 'settings' };
  return { effort: 'unknown', effortSource: 'unknown' };
}

const runKey = parts => parts.map(part => part ?? '').join(' ');

const runsFromBuckets = buckets => [...buckets.values()]
  .map(run => ({ ...run, tokens: { ...run.tokens }, cacheReadRatio: cacheReadRatio(run.tokens), reasoningShare: reasoningShare(run.tokens) }));

/* ------------------------------------------------------------------- parsers */

function recordCodexUsage(buckets, tokens, { timestamp, model, effort }) {
  const modelLabel = model ?? 'unknown';
  const effortLabel = effort ?? 'unknown';
  const key = runKey([modelLabel, effortLabel]);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { model: modelLabel, effort: effortLabel, start: timestamp, tokens: emptyTokens(), events: 0 };
    buckets.set(key, bucket);
  }
  addTokens(bucket.tokens, tokens);
  bucket.events += 1;
}

/** Parses one Codex rollout file into one run per (model, effort) observed in it. */
export function parseCodexRollout(text, { fileName = '', range = {} } = {}) {
  const named = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/.exec(path.basename(fileName));
  const fileStart = named ? `${named[1]}T${named[2]}:${named[3]}:${named[4]}` : null;
  const fileSessionId = named ? named[5] : path.basename(fileName, '.jsonl');

  const buckets = new Map();
  let malformedLines = 0;
  let model = null;
  let effort = null;
  let threadSource = null;
  let sessionId = fileSessionId;
  let parentThreadId = null;
  let sawUsageRecord = false;
  const fallback = [];

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
    const timestamp = event?.timestamp ?? payload.timestamp ?? fileStart;

    if (event?.type === 'session_meta') {
      sessionId = payload.id ?? payload.session_id ?? sessionId;
      parentThreadId = payload.parent_thread_id ?? null;
      threadSource = payload.thread_source ?? threadSource;
      continue;
    }
    if (event?.type === 'turn_context') {
      if (payload.model) model = payload.model;
      const turnEffort = payload.effort ?? payload.reasoning_effort;
      if (turnEffort) effort = turnEffort;
      continue;
    }
    if (event?.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      const settings = payload.thread_settings ?? {};
      if (settings.model) model = settings.model;
      const settingsEffort = settings.reasoning_effort ?? settings.effort;
      if (settingsEffort) effort = settingsEffort;
      continue;
    }
    if (event?.type === 'token_usage_record') {
      sawUsageRecord = true;
      if (!inRange(timestamp, range)) continue;
      recordCodexUsage(buckets, codexUsageTokens(payload.usage), { timestamp, model, effort });
      continue;
    }
    if (event?.type === 'event_msg' && payload.type === 'token_count') {
      const info = payload.info ?? {};
      if (info.total_token_usage) fallback.push({ timestamp, model, effort, usage: info.total_token_usage });
    }
  }

  // Fallback only: a thread with no per-response record keeps its last cumulative reading.
  if (!sawUsageRecord && fallback.length) {
    const last = fallback[fallback.length - 1];
    if (inRange(last.timestamp, range)) recordCodexUsage(buckets, codexUsageTokens(last.usage), last);
  }

  const agent = threadSource === 'guardian_review' ? 'auto-review'
    : threadSource === 'subagent' ? 'subagent'
      : threadSource === 'user' ? 'main' : (threadSource ?? 'unknown');

  const runs = runsFromBuckets(buckets).map(run => ({
    ...run,
    id: `${sessionId}#${run.model}/${run.effort}`,
    sessionId,
    parentThreadId,
    provider: 'codex',
    agent,
    effortSource: 'rollout',
    mismatch: null,
    source: fileName,
  }));
  return { runs, malformedLines, sessionId, start: fileStart };
}

/** Parses one Claude transcript into one run per (model, effort, agent) observed. */
export function parseClaudeTranscript(text, {
  fileName = '', range = {}, agentDefinitions = {}, settingsEfforts = {}, subagentType = null,
} = {}) {
  const buckets = new Map();
  const seenResponses = new Set();
  const spawnedAgents = new Set();
  let malformedLines = 0;
  let sessionId = path.basename(fileName, '.jsonl');
  let start = null;

  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (entry?.sessionId) sessionId = entry.sessionId;
    const message = entry?.message && typeof entry.message === 'object' ? entry.message : null;
    if (Array.isArray(message?.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_use' && block.name === 'Agent' && block.input?.subagent_type) {
          spawnedAgents.add(String(block.input.subagent_type));
        }
      }
    }
    if (entry?.type !== 'assistant' || !message) continue;

    const model = message.model;
    if (typeof model !== 'string' || !model || model === '<synthetic>') continue;
    const responseKey = runKey([entry.requestId, message.id]);
    if (seenResponses.has(responseKey)) continue;
    seenResponses.add(responseKey);
    if (!inRange(entry.timestamp, range)) continue;

    const isSidechain = entry.isSidechain === true;
    const agentType = entry.agentType ?? entry.subagentType ?? subagentType ?? null;
    const agent = isSidechain ? (agentType ?? 'sidechain') : (agentType ?? 'main');
    const { effort, effortSource } = resolveClaudeEffort({
      model,
      transcriptEffort: typeof entry.effort === 'string' ? entry.effort : null,
      subagentType: isSidechain ? agentType : null,
      agentDefinitions,
      settingsEfforts,
    });

    const key = runKey([model, effort, agent]);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { model, effort, effortSource, agent, start: entry.timestamp, tokens: emptyTokens(), events: 0 };
      buckets.set(key, bucket);
    }
    addTokens(bucket.tokens, claudeUsageTokens(message.usage));
    bucket.events += 1;
    if (!start) start = entry.timestamp;
  }

  const runs = runsFromBuckets(buckets).map(run => ({
    ...run,
    id: `${sessionId}#${run.model}/${run.effort}/${run.agent}`,
    sessionId,
    provider: 'claude',
    mismatch: null,
    source: fileName,
  }));
  return { runs, malformedLines, sessionId, start, spawnedAgents: [...spawnedAgents] };
}

/** Parses one review summary into one run per model it actually used. */
export function parseReviewSummary(summary, { fileName = '', range = {} } = {}) {
  if (!summary || typeof summary !== 'object') return { runs: [], malformedLines: 1 };
  const finishedAt = summary.finishedAt ?? null;
  if (finishedAt && !inRange(finishedAt, range)) return { runs: [], malformedLines: 0, outsideRange: true };
  const name = typeof summary.review === 'string' ? summary.review : path.basename(fileName, '.json');
  const observedModels = Array.isArray(summary.observedModels) ? summary.observedModels : [];
  const mismatch = detectMismatch(summary.requestedModel, observedModels);
  const usage = summary.usage && typeof summary.usage === 'object' ? summary.usage : {};
  const models = Object.keys(usage).length ? Object.keys(usage) : observedModels;

  const runs = models.map(model => {
    const tokens = reviewUsageTokens(usage[model]);
    return {
      id: `review:${name}#${model}`,
      sessionId: `review:${name}`,
      provider: 'claude',
      model,
      effort: typeof summary.effort === 'string' && summary.effort ? summary.effort : 'unknown',
      effortSource: typeof summary.effort === 'string' && summary.effort ? 'review-summary' : 'unknown',
      agent: 'cross-provider-review',
      start: finishedAt,
      tokens,
      cacheReadRatio: cacheReadRatio(tokens),
      reasoningShare: reasoningShare(tokens),
      events: 1,
      mismatch,
      requestedModel: summary.requestedModel ?? null,
      observedModels,
      exitCode: Number.isFinite(summary.exitCode) ? summary.exitCode : null,
      source: fileName,
    };
  });
  return { runs, malformedLines: 0 };
}

/* ---------------------------------------------------------------- aggregation */

export const GROUP_FIELDS = { provider: 'provider', model: 'model', effort: 'effort', agent: 'agent' };

/** Groups runs and computes run/token shares plus each group's cache-read ratio. */
export function aggregate(runs, { by = ['provider', 'model', 'effort'] } = {}) {
  const fields = (Array.isArray(by) ? by : [by]).filter(field => field in GROUP_FIELDS);
  const groupFields = fields.length ? fields : ['provider', 'model', 'effort'];
  const totals = emptyTokens();
  const groups = new Map();

  for (const run of runs) {
    const key = runKey(groupFields.map(field => run[field] ?? 'unknown'));
    let group = groups.get(key);
    if (!group) {
      group = {
        ...Object.fromEntries(groupFields.map(field => [field, run[field] ?? 'unknown'])),
        label: groupFields.map(field => run[field] ?? 'unknown').join(' / '),
        runs: 0,
        tokens: emptyTokens(),
        mismatches: 0,
      };
      groups.set(key, group);
    }
    group.runs += 1;
    if (run.mismatch === true) group.mismatches += 1;
    addTokens(group.tokens, run.tokens);
    addTokens(totals, run.tokens);
  }

  const runCount = runs.length;
  const rows = [...groups.values()].map(group => ({
    ...group,
    runShare: runCount ? (group.runs / runCount) * 100 : 0,
    totalShare: totals.total ? (group.tokens.total / totals.total) * 100 : 0,
    cacheReadRatio: cacheReadRatio(group.tokens),
    reasoningShare: reasoningShare(group.tokens),
  })).sort((a, b) => b.tokens.total - a.tokens.total || a.label.localeCompare(b.label));

  return {
    by: groupFields,
    groups: rows,
    totals: {
      runs: runCount,
      ...totals,
      cacheReadRatio: cacheReadRatio(totals),
      reasoningShare: reasoningShare(totals),
      mismatches: runs.filter(run => run.mismatch === true).length,
    },
  };
}

/* ------------------------------------------------------- local collection (io) */

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function listFiles(dir, predicate) {
  try {
    return readdirSync(dir)
      .filter(predicate)
      .map(name => path.join(dir, name))
      .filter(file => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

/** `*` matches any run of characters; everything else is literal and case-insensitive. */
export function globToRegExp(glob) {
  const escaped = String(glob ?? '*').replace(/[.*+?^${}()|[\]\\]/g, match => (match === '*' ? ' ' : `\\${match}`));
  return new RegExp(`^${escaped.split(' ').join('.*')}$`, 'i');
}

/** True when the project directory name matches the configured glob. */
export function matchesProjectGlob(name, glob) {
  if (!glob || glob === '*') return true;
  // A bare substring with no wildcard is treated as a substring match.
  const pattern = glob.includes('*') ? glob : `*${glob}*`;
  return globToRegExp(pattern).test(name);
}

function codexDayDirs(root, range) {
  const dirs = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      const next = path.join(dir, entry.name);
      if (depth === 3) dirs.push(next);
      else walk(next, depth + 1);
    }
  };
  walk(root, 1);
  // Day directories are named in local time; keep one day of slack on each side.
  return dirs.filter(dir => {
    const parts = dir.split(path.sep).slice(-3);
    if (parts.length !== 3) return true;
    const key = `${parts[0]}-${parts[1]}-${parts[2]}`;
    if (range.since && key < shiftDay(range.since, -1)) return false;
    if (range.until && key > shiftDay(range.until, 1)) return false;
    return true;
  });
}

/**
 * A linked worktree's `.git` is a file pointing at `<main>/.git/worktrees/<name>`;
 * review summaries live in the main checkout, so resolve that path rather than
 * reporting them missing.
 */
export function mainCheckoutFromGitFile(text) {
  const match = typeof text === 'string' ? text.match(/^gitdir:\s*(.+?)\s*$/m) : null;
  if (!match) return null;
  const gitDir = match[1].replace(/\\/g, '/');
  const worktrees = gitDir.match(/^(.*)\/\.git\/worktrees\/[^/]+$/);
  return worktrees ? path.resolve(worktrees[1]) : null;
}

function projectRoots(root) {
  const roots = [root];
  const gitPath = path.join(root, '.git');
  try {
    if (statSync(gitPath).isFile()) {
      const main = mainCheckoutFromGitFile(readFileSafe(gitPath) ?? '');
      if (main && main !== path.resolve(root)) roots.push(main);
    }
  } catch {
    // A missing or unreadable .git simply means there is no linked main checkout.
  }
  return roots;
}

export function loadAgentDefinitions(dir) {
  const definitions = {};
  for (const file of listFiles(dir, name => name.endsWith('.md'))) {
    const parsed = parseAgentDefinition(readFileSafe(file) ?? '');
    const name = parsed.name ?? path.basename(file, '.md');
    definitions[name] = parsed;
  }
  return definitions;
}

export function loadSettingsEfforts(file) {
  const text = readFileSafe(file);
  if (!text) return {};
  try {
    return parseSettingsEfforts(JSON.parse(text));
  } catch {
    return {};
  }
}

/** Scans every configured local source and builds the full report object. */
export function collectLedger({
  range = {},
  by = ['provider', 'model', 'effort'],
  home = homeDir(),
  root = process.cwd(),
  config = {},
} = {}) {
  const scanned = [];
  const skipped = [];
  const missing = [];
  const runs = [];
  let malformedLines = 0;

  const note = (file, kind, result) => {
    malformedLines += result.malformedLines ?? 0;
    if (result.runs.length) {
      scanned.push({ path: file, kind, runs: result.runs.length });
      runs.push(...result.runs);
    } else if ((result.malformedLines ?? 0) > 0) {
      skipped.push({ path: file, reason: 'unparseable' });
    } else {
      skipped.push({ path: file, reason: 'outside range or no usage recorded' });
    }
  };

  const codexRoot = path.join(home, '.codex', 'sessions');
  if (!existsSync(codexRoot)) missing.push(codexRoot);
  else {
    for (const dir of codexDayDirs(codexRoot, range)) {
      for (const file of listFiles(dir, name => name.startsWith('rollout-') && name.endsWith('.jsonl'))) {
        const text = readFileSafe(file);
        if (text === null) {
          skipped.push({ path: file, reason: 'unreadable' });
          continue;
        }
        note(file, 'codex-rollout', parseCodexRollout(text, { fileName: file, range }));
      }
    }
  }

  const agentDefinitions = loadAgentDefinitions(path.resolve(root, config.claudeAgentDefsDir ?? '.claude/agents'));
  const settingsEfforts = loadSettingsEfforts(path.resolve(root, config.claudeSettingsFile ?? '.claude/settings.json'));

  const projectsRoot = path.join(home, '.claude', 'projects');
  const glob = config.claudeProjectDirGlob ?? '*';
  if (!existsSync(projectsRoot)) missing.push(projectsRoot);
  else {
    let projectDirs = [];
    try {
      projectDirs = readdirSync(projectsRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && matchesProjectGlob(entry.name, glob))
        .map(entry => path.join(projectsRoot, entry.name))
        .sort();
    } catch {
      projectDirs = [];
    }
    if (!projectDirs.length) missing.push(`${projectsRoot} (no project directory matching ${glob})`);
    for (const dir of projectDirs) {
      for (const file of listFiles(dir, name => name.endsWith('.jsonl'))) {
        const text = readFileSafe(file);
        if (text === null) {
          skipped.push({ path: file, reason: 'unreadable' });
          continue;
        }
        note(file, 'claude-transcript', parseClaudeTranscript(text, {
          fileName: file, range, agentDefinitions, settingsEfforts,
        }));
      }
    }
  }

  for (const relative of config.reviewSummaryDirs ?? []) {
    const candidates = projectRoots(root).map(base => path.resolve(base, relative));
    const reviewsDir = candidates.find(dir => existsSync(dir)) ?? null;
    if (!reviewsDir) {
      missing.push(candidates[0]);
      continue;
    }
    for (const file of listFiles(reviewsDir, name => name.endsWith('.json'))) {
      const text = readFileSafe(file);
      let summary;
      try {
        summary = text === null ? null : JSON.parse(text);
      } catch {
        summary = null;
      }
      if (!summary) {
        skipped.push({ path: file, reason: 'unparseable' });
        continue;
      }
      note(file, 'review-summary', parseReviewSummary(summary, { fileName: file, range }));
    }
  }

  const report = aggregate(runs, { by });
  return {
    generatedAt: new Date().toISOString(),
    range: { since: range.since ?? null, until: range.until ?? null },
    ...report,
    runs: runs.map(run => ({
      id: run.id,
      sessionId: run.sessionId,
      start: run.start ?? null,
      provider: run.provider,
      model: run.model,
      effort: run.effort,
      effortSource: run.effortSource ?? 'unknown',
      agent: run.agent ?? 'unknown',
      responses: run.events ?? 0,
      tokens: run.tokens,
      cacheReadRatio: run.cacheReadRatio,
      mismatch: run.mismatch,
      source: run.source,
    })),
    mismatches: runs.filter(run => run.mismatch === true).map(run => ({
      id: run.id, requestedModel: run.requestedModel ?? null, observedModels: run.observedModels ?? [],
    })),
    sources: { scanned, skipped, missing, malformedLines },
    caveat: CAVEAT,
  };
}

/* ------------------------------------------------------------------------ cli */

export const LEDGER_USAGE = `Usage: agent-ledger [options]

  --since <YYYY-MM-DD>   first calendar day to include (default: today)
  --until <YYYY-MM-DD>   last calendar day to include (default: open ended)
  --last <N>d            convenience for --since (today - N days)
  --all                  no lower bound
  --table                human-readable table (default)
  --json                 structured report including a sources block
  --by <keys>            group by provider|model|effort|agent (comma separated;
                         default provider,model,effort)
  --runs                 list individual runs
  --config <path>        use this agent-meters.config.json
  --help                 show this message

Reads only local log files. No network, no model calls, no credentials or prompt text.`;

export function parseArgs(argv, { today = localDateKey(new Date()) } = {}) {
  const options = {
    since: today, until: null, format: 'table', by: ['provider', 'model', 'effort'], runs: false, help: false,
  };
  const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? '');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const valueOf = () => argv[index + 1];
    if (arg === '--json') options.format = 'json';
    else if (arg === '--table') options.format = 'table';
    else if (arg === '--runs') options.runs = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--all') options.since = null;
    else if (arg === '--last') {
      const value = String(valueOf() ?? '');
      const match = /^(\d{1,4})d$/.exec(value);
      if (!match) throw new Error('--last needs a day count such as 7d or 30d');
      options.since = shiftDay(today, -Number(match[1]));
      index += 1;
    } else if (arg === '--since' || arg === '--until') {
      const value = valueOf();
      if (!isDay(value)) throw new Error(`${arg} needs a YYYY-MM-DD date`);
      options[arg.slice(2)] = value;
      index += 1;
    } else if (arg === '--by') {
      const fields = String(valueOf() ?? '').split(',').map(field => field.trim()).filter(Boolean);
      if (!fields.length || fields.some(field => !(field in GROUP_FIELDS))) {
        throw new Error('--by accepts provider, model, effort or agent');
      }
      options.by = fields;
      index += 1;
    } else if (arg?.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (options.since && options.until && options.until < options.since) {
    throw new Error('--until is before --since');
  }
  return options;
}

const number = value => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '-');
const percent = value => (Number.isFinite(value) ? `${value.toFixed(1)}%` : '-');

function renderTable(headers, rows) {
  const widths = headers.map((header, column) => Math.max(
    header.length,
    ...rows.map(row => String(row[column] ?? '').length),
  ));
  const line = cells => cells.map((cell, column) => (column === 0
    ? String(cell ?? '').padEnd(widths[column])
    : String(cell ?? '').padStart(widths[column]))).join('  ');
  return [line(headers), widths.map(width => '-'.repeat(width)).join('  '), ...rows.map(line)].join('\n');
}

/** Formats the report as plain text; emits no prompt, transcript or review content. */
export function formatTable(report, { runs = false } = {}) {
  const out = [];
  const range = `${report.range.since ?? 'all'} .. ${report.range.until ?? 'now'}`;
  out.push(`Agent usage ledger  (${range}, grouped by ${report.by.join(' + ')})`);
  out.push('');
  out.push(renderTable(
    ['group', 'runs', 'run%', 'fresh in', 'cache read', 'cache write', 'output', 'total', 'total%', 'cache%', 'reason%'],
    report.groups.map(group => [
      group.label, number(group.runs), percent(group.runShare), number(group.tokens.freshInput),
      number(group.tokens.cacheRead), number(group.tokens.cacheWrite), number(group.tokens.output),
      number(group.tokens.total), percent(group.totalShare), percent(group.cacheReadRatio),
      group.reasoningShare === null ? '-' : percent(group.reasoningShare),
    ]),
  ));
  out.push('');
  out.push(`totals: ${number(report.totals.runs)} runs, ${number(report.totals.total)} tokens, `
    + `cache-read ratio ${percent(report.totals.cacheReadRatio)}, ${report.totals.mismatches} model mismatch(es)`);

  if (report.mismatches.length) {
    out.push('');
    out.push('model mismatches (requested vs observed):');
    for (const mismatch of report.mismatches) {
      out.push(`  ${mismatch.id}: requested ${mismatch.requestedModel ?? 'unknown'}, observed ${mismatch.observedModels.join(', ') || 'none'}`);
    }
  }

  if (runs) {
    out.push('');
    out.push(renderTable(
      ['run', 'start', 'provider', 'model', 'effort', 'effort src', 'agent', 'total', 'cache%', 'reason%', 'mismatch'],
      report.runs.map(run => [
        run.id, run.start ?? '-', run.provider, run.model, run.effort, run.effortSource, run.agent,
        number(run.tokens.total), percent(run.cacheReadRatio),
        run.reasoningShare === null ? '-' : percent(run.reasoningShare),
        run.mismatch === null ? 'unknown' : String(run.mismatch),
      ]),
    ));
  }

  out.push('');
  out.push(`sources: ${report.sources.scanned.length} file(s) scanned, ${report.sources.skipped.length} skipped, `
    + `${report.sources.malformedLines} malformed line(s)`);
  for (const dir of report.sources.missing) out.push(`  missing (not fatal): ${dir}`);
  out.push(report.caveat);
  return out.join('\n');
}

export { localDateKey, utcDateKey, shiftDay };
