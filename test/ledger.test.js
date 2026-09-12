import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregate, cacheReadRatio, collectLedger, detectMismatch, formatTable, globToRegExp,
  mainCheckoutFromGitFile, matchesProjectGlob, parseAgentDefinition, parseArgs,
  parseClaudeTranscript, parseCodexRollout, parseReviewSummary, parseSettingsEfforts,
  resolveClaudeEffort, utcDateKey,
} from '../src/ledger.js';

// Fixtures are inline and synthetic: no real transcript, prompt or user text is read here.
const utc = { dateKey: utcDateKey };
const lines = (...entries) => entries.map(entry => JSON.stringify(entry)).join('\n');

const codexUsage = (input, cached, output, at) => ({
  timestamp: at, type: 'token_usage_record',
  payload: {
    usage: {
      input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0,
      output_tokens: output, total_tokens: input + output,
    },
    thread_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, total_tokens: 999999 },
  },
});

const mainRollout = lines(
  { timestamp: '2026-09-12T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-main', thread_source: 'user' } },
  { timestamp: '2026-09-12T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'xhigh' } },
  codexUsage(1000, 600, 100, '2026-09-12T12:00:02.000Z'),
  codexUsage(2000, 1400, 200, '2026-09-12T12:05:00.000Z'),
);

test('codex per-response usage is summed and the cumulative thread total is never added in', () => {
  const { runs } = parseCodexRollout(mainRollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-main.jsonl', range: utc });
  assert.equal(runs.length, 1);
  const [run] = runs;
  // 3000 input includes 2000 cached, so fresh input is 1000 and the total is 3300, not 999999.
  assert.deepEqual(run.tokens, { freshInput: 1000, cacheRead: 2000, cacheWrite: 0, output: 300, total: 3300 });
  assert.equal(run.model, 'gpt-6-astra');
  assert.equal(run.effort, 'xhigh');
  assert.equal(run.agent, 'main');
  assert.equal(run.sessionId, 'sess-main');
});

test('a thread without per-response records falls back to the last cumulative token_count', () => {
  const rollout = lines(
    { timestamp: '2026-09-12T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-cum', thread_source: 'user' } },
    { timestamp: '2026-09-12T12:00:01.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra', reasoning_effort: 'medium' } } },
    { timestamp: '2026-09-12T12:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, total_tokens: 550 } } } },
    { timestamp: '2026-09-12T12:01:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 400, output_tokens: 80, total_tokens: 980 } } } },
  );
  const { runs } = parseCodexRollout(rollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-cum.jsonl', range: utc });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].tokens, { freshInput: 500, cacheRead: 400, cacheWrite: 0, output: 80, total: 980 });
  assert.equal(runs[0].effort, 'medium');
});

test('the internal auto-review thread is reported apart from the primary session', () => {
  const review = lines(
    { timestamp: '2026-09-12T12:10:00.000Z', type: 'session_meta', payload: { id: 'sess-review', parent_thread_id: 'sess-main', thread_source: 'guardian_review' } },
    { timestamp: '2026-09-12T12:10:01.000Z', type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } },
    codexUsage(100, 0, 10, '2026-09-12T12:10:02.000Z'),
  );
  const primary = parseCodexRollout(mainRollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-main.jsonl', range: utc }).runs;
  const auto = parseCodexRollout(review, { fileName: 'rollout-2026-09-12T08-10-00-sess-review.jsonl', range: utc }).runs;
  assert.equal(auto[0].agent, 'auto-review');
  assert.equal(auto[0].parentThreadId, 'sess-main');
  const report = aggregate([...primary, ...auto], { by: ['model'] });
  assert.deepEqual(report.groups.map(group => group.label), ['gpt-6-astra', 'codex-auto-review']);
  assert.equal(report.groups[0].tokens.total, 3300);
  assert.equal(report.groups[1].tokens.total, 110);
  assert.equal(report.totals.runs, 2);
});

test('one codex thread that switches model or effort is split into separate runs', () => {
  const rollout = lines(
    { timestamp: '2026-09-12T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-split', thread_source: 'subagent' } },
    { timestamp: '2026-09-12T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'medium' } },
    codexUsage(100, 0, 10, '2026-09-12T12:00:02.000Z'),
    { timestamp: '2026-09-12T12:00:03.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol', effort: 'high' } },
    codexUsage(200, 0, 20, '2026-09-12T12:00:04.000Z'),
  );
  const { runs } = parseCodexRollout(rollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-split.jsonl', range: utc });
  assert.deepEqual(runs.map(run => [run.model, run.effort, run.tokens.total, run.agent]), [
    ['gpt-6-astra', 'medium', 110, 'subagent'],
    ['gpt-5.6-sol', 'high', 220, 'subagent'],
  ]);
});

const assistantLine = (overrides = {}) => ({
  type: 'assistant', sessionId: 'claude-sess', isSidechain: false, requestId: 'req-1', apiBlockIndex: 0,
  timestamp: '2026-09-12T12:00:00.000Z',
  message: {
    id: 'msg-1', model: 'claude-opus-5',
    usage: { input_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 190, output_tokens: 100 },
  },
  ...overrides,
});

test('repeated content blocks of one claude response are counted once and synthetic lines ignored', () => {
  const transcript = lines(
    assistantLine(),
    assistantLine({ apiBlockIndex: 1 }),
    assistantLine({ apiBlockIndex: 2 }),
    assistantLine({ requestId: 'req-2', timestamp: '2026-09-12T12:01:00.000Z', message: { id: 'msg-2', model: '<synthetic>', usage: { input_tokens: 5000 } } }),
    { type: 'user', timestamp: '2026-09-12T12:00:30.000Z', message: { role: 'user', content: 'ignored' } },
  );
  const { runs } = parseClaudeTranscript(transcript, { fileName: 'claude-sess.jsonl', range: utc });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].tokens, { freshInput: 10, cacheRead: 800, cacheWrite: 190, output: 100, total: 1100 });
  assert.equal(runs[0].events, 1);
  assert.equal(runs[0].agent, 'main');
});

test('cache-read ratio counts cache reads against fresh input plus cache writes', () => {
  const { runs } = parseClaudeTranscript(lines(assistantLine()), { fileName: 'claude-sess.jsonl', range: utc });
  // 800 / (800 + 10 + 190) = 80%; output tokens are not part of the ratio.
  assert.equal(runs[0].cacheReadRatio, 80);
  assert.equal(cacheReadRatio({ cacheRead: 0, freshInput: 0, cacheWrite: 0 }), null);
  assert.equal(cacheReadRatio({ cacheRead: 1, freshInput: 1, cacheWrite: 2 }), 25);
});

test('claude effort comes from the transcript, else an agent definition, else settings', () => {
  const agentDefinitions = {
    'implementer-deep': parseAgentDefinition([
      '---', 'name: implementer-deep', 'model: claude-opus-5', 'effort: high', '---', '', 'body text',
    ].join('\n')),
  };
  const settingsEfforts = parseSettingsEfforts({
    model: 'claude-fable-5-1',
    modelSettings: { 'claude-fable-5-1': { effortLevel: 'high' }, 'claude-opus-5': { effortLevel: 'medium' } },
  });
  assert.deepEqual(agentDefinitions['implementer-deep'], { name: 'implementer-deep', model: 'claude-opus-5', effort: 'high' });
  assert.deepEqual(settingsEfforts, { 'claude-fable-5-1': 'high', 'claude-opus-5': 'medium' });

  assert.deepEqual(
    resolveClaudeEffort({ model: 'claude-opus-5', transcriptEffort: 'low', subagentType: 'implementer-deep', agentDefinitions, settingsEfforts }),
    { effort: 'low', effortSource: 'transcript' },
  );
  assert.deepEqual(
    resolveClaudeEffort({ model: 'claude-opus-5', subagentType: 'implementer-deep', agentDefinitions, settingsEfforts }),
    { effort: 'high', effortSource: 'agent-def' },
  );
  assert.deepEqual(
    resolveClaudeEffort({ model: 'claude-opus-5[1m]', settingsEfforts }),
    { effort: 'medium', effortSource: 'settings' },
  );
  assert.deepEqual(
    resolveClaudeEffort({ model: 'gpt-6-astra', settingsEfforts }),
    { effort: 'unknown', effortSource: 'unknown' },
  );

  const sidechain = lines(assistantLine({
    isSidechain: true, agentType: 'implementer-deep', requestId: 'req-side', message: {
      id: 'msg-side', model: 'claude-opus-5',
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
    },
  }));
  const { runs } = parseClaudeTranscript(sidechain, { fileName: 'side.jsonl', range: utc, agentDefinitions, settingsEfforts });
  assert.deepEqual([runs[0].agent, runs[0].effort, runs[0].effortSource], ['implementer-deep', 'high', 'agent-def']);
});

test('a mismatch ignores the [1m] context suffix and cheap bookkeeping usage', () => {
  assert.equal(detectMismatch('claude-opus-5', ['claude-opus-5[1m]', 'claude-haiku-4-5-20251001']), false);
  assert.equal(detectMismatch('claude-opus-5', ['claude-sonnet-5', 'claude-haiku-4-5-20251001']), true);
  assert.equal(detectMismatch('claude-opus-5', ['claude-haiku-4-5-20251001']), true);
  assert.equal(detectMismatch(undefined, ['claude-opus-5']), null);

  const requested = parseReviewSummary({
    review: 'speech', finishedAt: '2026-09-12T20:46:11.186Z', exitCode: 0,
    requestedModel: 'claude-opus-5', effort: 'high', observedModels: ['claude-opus-5[1m]'],
    usage: {
      'claude-haiku-4-5-20251001': { inputTokens: 1507, outputTokens: 16, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      'claude-opus-5': { inputTokens: 20, outputTokens: 30, cacheReadInputTokens: 900, cacheCreationInputTokens: 80 },
    },
    result: 'review prose that must never be printed',
  }, { fileName: 'speech.json', range: { ...utc, since: '2026-09-12' } });
  assert.deepEqual(requested.runs.map(run => [run.model, run.mismatch, run.tokens.total]), [
    ['claude-haiku-4-5-20251001', false, 1523],
    ['claude-opus-5', false, 1030],
  ]);
  assert.equal(requested.runs[0].agent, 'cross-provider-review');
  assert.equal(requested.runs[1].effort, 'high');

  const wrong = parseReviewSummary({
    review: 'controls', finishedAt: '2026-09-12T20:37:13.591Z', requestedModel: 'claude-opus-5',
    observedModels: ['claude-sonnet-5'], usage: { 'claude-sonnet-5': { inputTokens: 1, outputTokens: 1 } },
  }, { fileName: 'controls.json', range: utc });
  assert.equal(wrong.runs[0].mismatch, true);

  const unknown = parseReviewSummary({
    review: 'launcher', finishedAt: '2026-09-12T20:31:13.178Z', observedModels: ['claude-opus-5'],
    usage: { 'claude-opus-5': { inputTokens: 1, outputTokens: 1 } },
  }, { fileName: 'launcher.json', range: utc });
  assert.equal(unknown.runs[0].mismatch, null);
  assert.equal(unknown.runs[0].effort, 'unknown');
});

test('date filtering drops events outside the range without dropping the rest of a file', () => {
  const rollout = lines(
    { timestamp: '2026-09-11T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-span', thread_source: 'user' } },
    { timestamp: '2026-09-11T12:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'xhigh' } },
    codexUsage(100, 0, 10, '2026-09-11T12:00:02.000Z'),
    codexUsage(400, 0, 40, '2026-09-12T12:00:02.000Z'),
  );
  const name = 'rollout-2026-09-11T08-00-00-sess-span.jsonl';
  const today = parseCodexRollout(rollout, { fileName: name, range: { ...utc, since: '2026-09-12' } });
  assert.equal(today.runs[0].tokens.total, 440);
  const both = parseCodexRollout(rollout, { fileName: name, range: { ...utc, since: '2026-09-11', until: '2026-09-12' } });
  assert.equal(both.runs[0].tokens.total, 550);
  const before = parseCodexRollout(rollout, { fileName: name, range: { ...utc, since: '2026-09-13' } });
  assert.deepEqual(before.runs, []);

  const transcript = lines(
    assistantLine({ timestamp: '2026-09-11T23:00:00.000Z' }),
    assistantLine({ requestId: 'req-2', timestamp: '2026-09-12T01:00:00.000Z', message: { ...assistantLine().message, id: 'msg-2' } }),
  );
  const filtered = parseClaudeTranscript(transcript, { fileName: 'claude-sess.jsonl', range: { ...utc, since: '2026-09-12' } });
  assert.equal(filtered.runs[0].tokens.total, 1100);
  assert.equal(filtered.runs[0].start, '2026-09-12T01:00:00.000Z');
});

test('malformed lines are skipped and counted rather than aborting a file', () => {
  const rollout = `${mainRollout}\n{"timestamp": broken json\nnot json at all`;
  const parsed = parseCodexRollout(rollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-main.jsonl', range: utc });
  assert.equal(parsed.malformedLines, 2);
  assert.equal(parsed.runs[0].tokens.total, 3300);

  const transcript = parseClaudeTranscript(`{"nope\n${JSON.stringify(assistantLine())}`, { fileName: 'claude-sess.jsonl', range: utc });
  assert.equal(transcript.malformedLines, 1);
  assert.equal(transcript.runs.length, 1);

  assert.deepEqual(parseReviewSummary(null, { fileName: 'broken.json' }), { runs: [], malformedLines: 1 });
});

test('aggregation shares add up and the table output carries the not-a-bill caveat', () => {
  const codex = parseCodexRollout(mainRollout, { fileName: 'rollout-2026-09-12T08-00-00-sess-main.jsonl', range: utc }).runs;
  const claude = parseClaudeTranscript(lines(assistantLine()), { fileName: 'claude-sess.jsonl', range: utc }).runs;
  const report = aggregate([...codex, ...claude], { by: ['provider'] });
  assert.deepEqual(report.groups.map(group => [group.label, group.runs, Math.round(group.runShare), Math.round(group.totalShare)]), [
    ['codex', 1, 50, 75],
    ['claude', 1, 50, 25],
  ]);
  assert.equal(report.totals.total, 4400);
  assert.equal(Math.round(report.groups[0].runShare + report.groups[1].runShare), 100);

  const text = formatTable({
    ...report, range: { since: '2026-09-12', until: null }, runs: [], mismatches: [],
    sources: { scanned: [], skipped: [], missing: [path.join('C:', 'missing', 'dir')], malformedLines: 0 },
    caveat: 'Caveat: not a bill.',
  });
  assert.match(text, /grouped by provider/);
  assert.match(text, /missing \(not fatal\)/);
  assert.match(text, /not a bill/);
  assert.doesNotMatch(text, /review prose/);
});

test('a linked worktree resolves review summaries back to the main checkout', () => {
  const resolved = mainCheckoutFromGitFile('gitdir: C:/repo/Project/.git/worktrees/agent-1\n');
  assert.equal(resolved?.replace(/\\/g, '/').toLowerCase().replace(/^\/?[a-z]:/, 'c:'), 'c:/repo/project');
  assert.equal(mainCheckoutFromGitFile('gitdir: C:/repo/Project/.git'), null);
  assert.equal(mainCheckoutFromGitFile(''), null);
  assert.equal(mainCheckoutFromGitFile(null), null);
});

test('project-directory matching honours the configured glob', () => {
  assert.ok(matchesProjectGlob('anything-at-all', '*'));
  assert.ok(matchesProjectGlob('c--Users-me-Projects-CreatorOS', '*CreatorOS*'));
  assert.ok(matchesProjectGlob('c--Users-me-Projects-creatoros', '*CreatorOS*'), 'matching is case insensitive');
  assert.ok(!matchesProjectGlob('c--Users-me-Projects-Other', '*CreatorOS*'));
  assert.ok(matchesProjectGlob('x-CreatorOS-y', 'CreatorOS'), 'a bare name is a substring match');
  assert.ok(!matchesProjectGlob('a.b', 'a?b'), 'only * is a wildcard');
  assert.ok(globToRegExp('a*c').test('abbbc'));
});

test('argument parsing defaults to today and a table, supports --last and rejects bad input', () => {
  const defaults = parseArgs([], { today: '2026-09-12' });
  assert.deepEqual(defaults, { since: '2026-09-12', until: null, format: 'table', by: ['provider', 'model', 'effort'], runs: false, help: false });
  const custom = parseArgs(['--since', '2026-09-01', '--until', '2026-09-12', '--json', '--by', 'provider,agent', '--runs'], { today: '2026-09-12' });
  assert.deepEqual(custom, { since: '2026-09-01', until: '2026-09-12', format: 'json', by: ['provider', 'agent'], runs: true, help: false });
  assert.equal(parseArgs(['--last', '7d'], { today: '2026-09-12' }).since, '2026-09-05');
  assert.equal(parseArgs(['--last', '30d'], { today: '2026-09-12' }).since, '2026-08-13');
  assert.equal(parseArgs(['--all'], { today: '2026-09-12' }).since, null);
  assert.throws(() => parseArgs(['--last', '7'], { today: '2026-09-12' }), /--last needs/);
  assert.throws(() => parseArgs(['--since', 'yesterday'], { today: '2026-09-12' }), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--by', 'cost'], { today: '2026-09-12' }), /--by accepts/);
  assert.throws(() => parseArgs(['--since', '2026-09-12', '--until', '2026-09-01'], { today: '2026-09-12' }), /before/);
  assert.throws(() => parseArgs(['--bill'], { today: '2026-09-12' }), /Unknown option/);
});

test('collectLedger scans a synthetic home and honours the configured sources', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'agent-meters-'));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');

  const dayDir = path.join(home, '.codex', 'sessions', '2026', '09', '12');
  mkdirSync(dayDir, { recursive: true });
  writeFileSync(path.join(dayDir, 'rollout-2026-09-12T08-00-00-sess-main.jsonl'), mainRollout);

  const projectDir = path.join(home, '.claude', 'projects', 'c--tmp-SampleProject');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(path.join(projectDir, 'claude-sess.jsonl'), lines(assistantLine()));
  const otherDir = path.join(home, '.claude', 'projects', 'c--tmp-Unrelated');
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(path.join(otherDir, 'other.jsonl'), lines(assistantLine({
    sessionId: 'other-sess', requestId: 'req-other', message: { ...assistantLine().message, id: 'msg-other' },
  })));

  const reviewsDir = path.join(root, 'reviews');
  mkdirSync(reviewsDir, { recursive: true });
  writeFileSync(path.join(reviewsDir, 'speech.json'), JSON.stringify({
    review: 'speech', finishedAt: '2026-09-12T20:46:11.186Z', requestedModel: 'claude-opus-5',
    observedModels: ['claude-opus-5'], usage: { 'claude-opus-5': { inputTokens: 5, outputTokens: 5 } },
  }));

  const range = { since: '2026-09-12', until: '2026-09-12', dateKey: utcDateKey };
  const scoped = collectLedger({
    range, home, root, by: ['provider'],
    config: { claudeProjectDirGlob: '*SampleProject*', reviewSummaryDirs: ['reviews'] },
  });
  assert.equal(scoped.sources.scanned.length, 3, 'one rollout, one transcript, one review summary');
  assert.deepEqual(scoped.groups.map(group => group.label).sort(), ['claude', 'codex']);
  assert.equal(scoped.totals.total, 3300 + 1100 + 10);

  const all = collectLedger({
    range, home, root, by: ['provider'],
    config: { claudeProjectDirGlob: '*', reviewSummaryDirs: [] },
  });
  assert.equal(all.sources.scanned.length, 3, 'both project dirs, no review summaries');
  assert.equal(all.totals.total, 3300 + 1100 + 1100);
  assert.ok(!all.sources.scanned.some(entry => entry.kind === 'review-summary'));
});
