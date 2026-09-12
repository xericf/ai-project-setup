import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.js';
import { ProbeError, classify, parseMeterLines, parseQuota } from '../src/claude-usage.js';

// Synthetic `/usage` payloads only: nothing here runs a CLI or reads a real login.
const pacing = DEFAULT_CONFIG.pacing;

const usageText = (...meterLines) => [
  'Claude Code usage, using your subscription',
  '',
  ...meterLines,
].join('\n');

const result = (text, overrides = {}) => ({
  type: 'result', subtype: 'success', is_error: false, local_command: 'usage', num_turns: 0,
  result: text, ...overrides,
});

const maxPlan = usageText(
  'Current session: 20% used · resets Sep 12, 11pm (America/New_York)',
  'Current week (all models): 33% used · resets Sep 13, 3pm (America/New_York)',
  'Current week (Fable): 29% used · resets Sep 13, 3pm (America/New_York)',
);

test('meter lines are parsed with their reset strings, and nonsense is dropped', () => {
  const meters = parseMeterLines(maxPlan);
  assert.equal(meters.length, 3);
  assert.deepEqual(meters[0], {
    label: 'Current session', usedPercentage: 20, resets: 'Sep 12, 11pm (America/New_York)',
  });
  assert.equal(parseMeterLines('Current session: 140% used').length, 0, 'over 100% is not a percentage');
  assert.deepEqual(parseMeterLines('Current session: 5% used'), [
    { label: 'Current session', usedPercentage: 5, resets: null },
  ]);
  assert.deepEqual(parseMeterLines(null), []);
});

test('the three configured meters are matched case insensitively by prefix', () => {
  const quota = parseQuota(result(maxPlan), { pacing });
  assert.equal(quota.session.usedPercentage, 20);
  assert.equal(quota.weekAll.usedPercentage, 33);
  assert.equal(quota.weekModel.usedPercentage, 29);
  assert.equal(quota.weekAll.resets, 'Sep 13, 3pm (America/New_York)');

  const lowercase = parseQuota(result(usageText(
    'current session: 1% used',
    'CURRENT WEEK (ALL MODELS): 2% used',
  )), { pacing });
  assert.equal(lowercase.session.usedPercentage, 1);
  assert.equal(lowercase.weekAll.usedPercentage, 2);
});

test('a different plan names its per-model meter differently and still reads', () => {
  const opusPlan = usageText(
    'Current session: 10% used · resets tomorrow',
    'Current week (all models): 40% used · resets Sep 13, 3pm (America/New_York)',
    'Current week (Opus): 55% used',
  );
  const quota = parseQuota(result(opusPlan), {
    pacing: { ...pacing, tierAdvice: { ...pacing.tierAdvice, perModelMeter: 'Current week (Opus)' } },
  });
  assert.equal(quota.weekModel.usedPercentage, 55);
  assert.equal(quota.weekModel.label, 'Current week (Opus)');
});

test('a missing per-model meter is null, never zero', () => {
  const quota = parseQuota(result(usageText(
    'Current session: 10% used',
    'Current week (all models): 40% used · resets Sep 13, 3pm (America/New_York)',
  )), { pacing });
  assert.equal(quota.weekModel, null);
  assert.notEqual(quota.weekModel?.usedPercentage, 0);
});

test('an unsuccessful, stale or turn-consuming reading is refused with a category', () => {
  const cases = [
    [undefined, 'protocol'],
    [result(maxPlan, { is_error: true }), 'protocol'],
    [result(maxPlan, { subtype: 'error_max_turns' }), 'protocol'],
    [result(maxPlan, { permission_denials: [{ tool: 'Bash' }] }), 'local-access'],
    [result(maxPlan, { local_command: 'cost' }), 'protocol'],
    [result(maxPlan, { num_turns: 2 }), 'protocol'],
    [result('Showing last known usage; unable to refresh'), 'allowance-or-rate-limit'],
    [result(usageText('Nothing useful here')), 'protocol'],
    [result(''), 'protocol'],
  ];
  for (const [value, category] of cases) {
    assert.throws(() => parseQuota(value, { pacing }), error => {
      assert.ok(error instanceof ProbeError);
      assert.equal(error.category, category);
      return true;
    }, JSON.stringify(value ?? null).slice(0, 60));
  }
});

test('diagnostics are reduced to categories and never carry provider text', () => {
  assert.equal(classify('Error: usage limit reached for this account'), 'allowance-or-rate-limit');
  assert.equal(classify('EACCES: permission denied'), 'local-access');
  assert.equal(classify('fetch failed: ENOTFOUND api.example'), 'network');
  assert.equal(classify('Invalid credential, please login'), 'authentication');
  assert.equal(classify('something else entirely'), 'unclassified');
  assert.equal(classify(undefined), 'unclassified');
});
