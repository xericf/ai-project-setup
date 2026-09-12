import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  buildReport, computeGap, decideSlots, formatDispatch, parseArgs, selectBand, weekElapsedFrom,
} from '../src/pacing.js';
import { codexParkedFrom, parseCodexRateLimits, windowLabel } from '../src/codex-usage.js';

const pacing = DEFAULT_CONFIG.pacing;
const healthy = { gap: 0, sessionPct: 20, weekAllPct: 33, weekModelPct: 29 };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// 2026-09-13 15:00 America/New_York (EDT, UTC-4) is 2026-09-13T19:00:00Z.
const RESET = 'Sep 13, 3pm (America/New_York)';
const RESET_AT = Date.parse('2026-09-13T19:00:00Z');

test('the gap is the all-model weekly spend less the elapsed fraction, or unavailable', () => {
  assert.equal(computeGap(33, 87), -54);
  assert.equal(computeGap(50, 50), 0);
  for (const [weekly, elapsed] of [[null, 50], [33, null], [undefined, undefined], [101, 50], [33, -1], ['33', 50]]) {
    assert.equal(computeGap(weekly, elapsed), null, `${weekly}/${elapsed} must be unavailable, not zero`);
  }
});

test('each pacing band boundary lands on the configured slot count', () => {
  assert.equal(decideSlots({ ...healthy, gap: -10.1 }, pacing).slots, 2);
  assert.equal(decideSlots({ ...healthy, gap: -54 }, pacing).slots, 2);
  assert.equal(decideSlots({ ...healthy, gap: -10 }, pacing).slots, 1, 'exactly -10 is inside the band');
  assert.equal(decideSlots({ ...healthy, gap: 0 }, pacing).slots, 1);
  assert.equal(decideSlots({ ...healthy, gap: 10 }, pacing).slots, 1, 'exactly +10 is inside the band');
  assert.equal(decideSlots({ ...healthy, gap: 10.1 }, pacing).slots, 0);
  const reviewOnly = decideSlots({ ...healthy, gap: 25 }, pacing);
  assert.equal(reviewOnly.slots, 0);
  assert.equal(reviewOnly.waived, null, 'review-only pacing is not a quota waiver');
});

test('bands come from config, so a different policy changes the decision', () => {
  const custom = {
    ...pacing,
    bands: [{ gapBelow: 0, slots: 4 }, { slots: 1 }],
  };
  assert.equal(decideSlots({ ...healthy, gap: -1 }, custom).slots, 4);
  assert.equal(decideSlots({ ...healthy, gap: 0 }, custom).slots, 1);
  assert.equal(selectBand(custom.bands, 99).slots, 1, 'the last band is the fallback');
  assert.equal(selectBand(pacing.bands, -11).slots, 2);
});

test('session headroom below the configured block overrides the band', () => {
  const blocked = decideSlots({ ...healthy, gap: -54, sessionPct: 80 }, pacing);
  assert.equal(blocked.slots, 0);
  assert.equal(blocked.waived, 'quota-blocked');
  assert.equal(decideSlots({ ...healthy, gap: -54, sessionPct: 79 }, pacing).slots, 2);
  assert.equal(decideSlots({ ...healthy, gap: -54, sessionPct: 99 }, pacing).waived, 'quota-blocked');
  const lenient = decideSlots({ ...healthy, gap: -54, sessionPct: 80 }, { ...pacing, sessionBlockUsedPct: 95 });
  assert.equal(lenient.slots, 2, 'the block threshold is configurable');
});

test('the weekly reserve blocks before the band is consulted', () => {
  const spent = decideSlots({ ...healthy, gap: -54, weekAllPct: 90 }, pacing);
  assert.equal(spent.slots, 0);
  assert.equal(spent.waived, 'quota-blocked');
  assert.equal(decideSlots({ ...healthy, gap: -54, weekAllPct: 89.9 }, pacing).slots, 2);
});

test('a per-model weekly ahead of the all-model weekly keeps the slot and lowers the tier', () => {
  const ahead = decideSlots({ ...healthy, gap: -54, weekAllPct: 29, weekModelPct: 32 }, pacing);
  assert.equal(ahead.slots, 2, 'the advice never changes the slot count');
  assert.equal(ahead.advice, 'lower');
  assert.equal(decideSlots({ ...healthy, weekAllPct: 33, weekModelPct: 29 }, pacing).advice, 'hold');
  assert.equal(decideSlots({ ...healthy, weekAllPct: 30, weekModelPct: 30 }, pacing).advice, 'hold');
  assert.equal(decideSlots({ ...healthy, weekModelPct: null }, pacing).advice, 'hold');
});

test('a missing per-model meter means no tier advice, not a zero reading', () => {
  const decision = decideSlots({ ...healthy, weekModelPct: null }, pacing);
  assert.equal(decision.advice, 'hold');
  assert.equal(decision.slots, 1, 'the slot count still comes from the band');
  assert.ok(decision.notes.some(note => /no per-model weekly meter/i.test(note)));
  assert.ok(!decision.notes.some(note => /\b0%/.test(note)));
});

test('an unreadable meter yields an unavailable slot count, never zero', () => {
  assert.equal(decideSlots({ ...healthy, sessionPct: null }, pacing).slots, null);
  assert.equal(decideSlots({ ...healthy, weekAllPct: null }, pacing).slots, null);
  assert.equal(decideSlots({ ...healthy, gap: null }, pacing).slots, null);
  assert.equal(decideSlots({ ...healthy, gap: Number.NaN }, pacing).slots, null);
  assert.equal(decideSlots(undefined, pacing).slots, null);
  for (const decision of [decideSlots({ ...healthy, gap: null }, pacing), decideSlots(undefined, pacing)]) {
    assert.equal(decision.waived, null, 'an unavailable reading is not a waiver');
    assert.ok(decision.notes.length, 'every decision explains itself');
  }
});

test('the weekly elapsed fraction comes from the reset string and clamps to 0..100', () => {
  assert.equal(weekElapsedFrom(RESET, RESET_AT - WEEK_MS), 0);
  assert.equal(weekElapsedFrom(RESET, RESET_AT - WEEK_MS / 2), 50);
  assert.equal(weekElapsedFrom(RESET, RESET_AT), 100);
  assert.equal(weekElapsedFrom('Sep 13, 3:00pm (America/New_York)', RESET_AT - WEEK_MS / 4), 75);
  assert.equal(weekElapsedFrom(RESET, RESET_AT - WEEK_MS * 3), 0, 'clamped low, not negative');
  assert.equal(weekElapsedFrom(RESET, RESET_AT + WEEK_MS * 3), 100, 'clamped high, not above 100');
  const observed = weekElapsedFrom(RESET, Date.parse('2026-09-12T20:00:00Z'));
  assert.ok(observed > 85 && observed < 89, `the recorded Sep 12 reading is ~87%, got ${observed}`);
});

test('an unparseable or absent reset string is unavailable rather than a guess', () => {
  for (const value of [null, undefined, '', '   ', 'resets soon', 'Smarch 40, 3pm (America/New_York)',
    'Sep 13, 13pm (America/New_York)', 'Sep 32, 3pm (America/New_York)', 42, {}]) {
    assert.equal(weekElapsedFrom(value, RESET_AT - WEEK_MS / 2), null, `${String(value)} must be unavailable`);
  }
  assert.notEqual(weekElapsedFrom('Sep 13, 2026, 3pm (Not/AZone)', RESET_AT - WEEK_MS / 2), null,
    'an unknown zone falls back to local time rather than failing');
});

test('codex windows are labelled from their duration, not from an assumed line-up', () => {
  assert.equal(windowLabel(10080), 'weekly');
  assert.equal(windowLabel(20160), 'weekly');
  assert.equal(windowLabel(300), 'session');
  assert.equal(windowLabel(360), 'session');
  assert.equal(windowLabel(720), '12h');
  assert.equal(windowLabel(2880), '2d');
  assert.equal(windowLabel(400), '400m');
  assert.equal(windowLabel(null), 'unknown');
});

test('the live Codex snapshot reduces to the windows it actually reports', () => {
  const live = {
    rateLimits: {
      limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 1789822893 },
      secondary: null, planType: 'pro', rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1789264128 },
        secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1789850928 },
      },
    },
  };
  const parsed = parseCodexRateLimits(live);
  assert.equal(parsed.weekly.usedPercent, 10);
  assert.equal(parsed.weekly.resetsAt, new Date(1789822893 * 1000).toISOString());
  assert.equal(parsed.session, null, 'an absent short window is null, not zero');
  assert.equal(parsed.windows.length, 1);
  const byId = parseCodexRateLimits({ rateLimitsByLimitId: live.rateLimitsByLimitId });
  assert.equal(byId.weekly.usedPercent, 7);
  assert.equal(byId.session.usedPercent, 4);
});

test('missing, malformed and snake_case Codex payloads degrade to unavailable windows', () => {
  for (const value of [undefined, null, {}, { rateLimits: null }, { rateLimits: 'nope' }]) {
    assert.deepEqual(parseCodexRateLimits(value), { windows: [], weekly: null, session: null, reached: null });
  }
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 5 } } }).weekly, null,
    'a window without a duration cannot be assigned to a meter');
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { windowDurationMins: 10080 } } }).weekly, null);
  assert.equal(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 101, windowDurationMins: 10080 } } }).weekly, null);
  const snake = parseCodexRateLimits({ rate_limits: { primary: { used_percent: 12, windowDurationMins: 10080, resets_at: null } } });
  assert.equal(snake.weekly.usedPercent, 12);
  assert.equal(snake.weekly.resetsAt, null, 'a missing reset is null, not now');
  const ms = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: 1789822893000 } } });
  assert.equal(ms.weekly.resetsAt, new Date(1789822893000).toISOString());
});

test('Codex parks on its own reserve or a reported limit, and never on an unavailable read', () => {
  assert.equal(codexParkedFrom({ weekly: { usedPercent: 90 } }, pacing), true);
  assert.equal(codexParkedFrom({ weekly: { usedPercent: 89.9 } }, pacing), false);
  assert.equal(codexParkedFrom({ weekly: { usedPercent: 3 }, reached: 'rate_limit_reached' }, pacing), true);
  assert.equal(codexParkedFrom({ error: 'network' }, pacing), false);
  assert.equal(codexParkedFrom(null, pacing), false);
  assert.equal(codexParkedFrom({ weekly: null }, pacing), false);
});

test('flags parse into the documented options and reject contradictions', () => {
  assert.deepEqual(parseArgs([]), { claudeOnly: false, codexOnly: false, weekElapsed: null, dispatch: true, help: false });
  assert.equal(parseArgs(['--json']).dispatch, false);
  assert.equal(parseArgs(['--json', '--dispatch']).dispatch, true);
  assert.equal(parseArgs(['--week-elapsed', '87']).weekElapsed, 87);
  assert.equal(parseArgs(['--claude-only']).claudeOnly, true);
  assert.equal(parseArgs(['--help']).help, true);
  for (const argv of [['--claude-only', '--codex-only'], ['--week-elapsed', '120'],
    ['--week-elapsed', 'soon'], ['--week-elapsed'], ['--bogus']]) {
    assert.throws(() => parseArgs(argv));
  }
});

test('the dispatch rendering states unavailable meters instead of implying zero', () => {
  const report = {
    readAt: '2026-09-12T20:00:00.000Z',
    claude: {
      session: 20, weekAll: 33, weekModel: 29, modelMeterLabel: 'Current week (Fable)',
      weekResets: RESET, weekElapsedPct: 87, source: 'usage',
    },
    codex: {
      windows: [{ label: 'weekly', usedPercent: 10, windowDurationMins: 10080, resetsAt: '2026-09-20T15:41:33.000Z' }],
      weekly: { label: 'weekly', usedPercent: 10 }, session: null, source: 'app-server',
    },
    gap: -54, claudeSlots: 2, claudeWaived: null, claudeModelAdvice: 'hold', codexParked: false, notes: ['band note'],
  };
  const text = formatDispatch(report, pacing);
  assert.match(text, /`claudeSlots: 2`/);
  assert.match(text, /session 20%, all-model week 33%, Current week \(Fable\) 29%/);
  assert.match(text, /approximately 87%, giving a gap near -54 points/);
  assert.match(text, /weekly 10%/);
  assert.match(text, /- band note/);

  const blind = formatDispatch({
    ...report, claude: { error: 'authentication' }, codex: { error: 'timeout' },
    gap: null, claudeSlots: null, claudeWaived: null, notes: [],
  }, pacing);
  assert.match(blind, /`claudeSlots: unavailable`/);
  assert.match(blind, /Claude meters unavailable \(authentication\)/);
  assert.match(blind, /Codex meters unavailable \(timeout\)/);
  assert.doesNotMatch(blind, /\b0%/);
  assert.match(formatDispatch({ ...report, claudeSlots: 0, claudeWaived: 'quota-blocked' }, pacing), /`claudeWaived: quota-blocked`/);
});

test('buildReport derives the elapsed fraction, honours the override and parks Codex', () => {
  const claude = { session: 20, weekAll: 33, weekModel: 29, weekResets: RESET };
  const overridden = buildReport({ claude: { ...claude }, codex: null, weekElapsedOverride: 87 }, pacing);
  assert.equal(overridden.gap, -54);
  assert.equal(overridden.claudeSlots, 2);
  assert.ok(overridden.notes.some(note => /--week-elapsed \(87%\)/.test(note)));

  const unparseable = buildReport({ claude: { ...claude, weekResets: 'soon' }, codex: null }, pacing);
  assert.equal(unparseable.gap, null);
  assert.equal(unparseable.claudeSlots, null, 'unavailable, not zero');

  const parked = buildReport({ claude: { error: 'network' }, codex: { weekly: { usedPercent: 95 } } }, pacing);
  assert.equal(parked.codexParked, true);
  assert.equal(parked.claudeSlots, null);
});
