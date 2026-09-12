/**
 * Claude subscription meter reading.
 *
 * The installed Claude Code CLI answers `/usage` as a *local* command: it costs no
 * model turn and returns the same percentages the interactive `/usage` panel shows.
 * This module locates the binary, runs that one command with tools disabled, and
 * parses the meter lines.
 *
 * Meter labels differ by plan ("Current week (Opus)", "Current week (Fable)", or no
 * per-model line at all), so labels come from config and are matched case
 * insensitively by prefix. A missing meter is null — "unavailable" — never zero.
 *
 * Failures are reduced to a category. Provider output, environment values, tokens
 * and account identifiers are never logged or re-thrown.
 */
import { spawnSync } from 'node:child_process';
import { claudeKnownPaths, locateExecutable } from './platform.js';

export const CLAUDE_EXE_ENV = 'AGENT_METERS_CLAUDE_EXE';

/** Reduce any diagnostic text to one of a small set of safe categories. */
export function classify(text) {
  const value = String(text ?? '');
  if (/usage.limit|rate.limit|quota|exhausted/i.test(value)) return 'allowance-or-rate-limit';
  if (/EACCES|EPERM|access.denied|permission.denied/i.test(value)) return 'local-access';
  if (/ECONN|ENOTFOUND|fetch.failed|network|connect|timed.out|timeout/i.test(value)) return 'network';
  if (/auth|login|credential|unauthorized/i.test(value)) return 'authentication';
  return 'unclassified';
}

export class ProbeError extends Error {
  constructor(message, category = 'unclassified') {
    super(message);
    this.name = 'ProbeError';
    this.category = category;
  }
}

/** Locate the Claude CLI: env override, then PATH, then the known install paths. */
export function locateClaude(options = {}) {
  return locateExecutable({
    name: 'claude',
    envVar: CLAUDE_EXE_ENV,
    knownPaths: claudeKnownPaths(options),
    label: 'Claude CLI',
    ...options,
  });
}

/** Run the CLI with no shell. Never echoes stdout, stderr or arguments on failure. */
export function call(executable, args, { cwd = process.cwd(), input, timeoutMs = 180_000 } = {}) {
  const result = spawnSync(executable, args, {
    cwd, input, encoding: 'utf8', shell: false, windowsHide: true,
    timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const category = classify(`${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error?.code ?? ''}`);
    throw new ProbeError(
      `Claude command failed (exit ${result.status ?? 'unknown'}, category ${category}). No reading is recorded.`,
      category,
    );
  }
  return result.stdout;
}

export function jsonCall(executable, args, options) {
  const output = call(executable, args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new ProbeError('Claude output is missing or not valid JSON. No reading is recorded.', 'protocol');
  }
}

const METER_LINE = /^(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*[·|-]\s*resets\s+(.+?))?\s*$/;

/** Every `Label: N% used · resets X` line in the `/usage` text, in order. */
export function parseMeterLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => METER_LINE.exec(line.trim()))
    .filter(Boolean)
    .map(match => ({
      label: match[1].trim(),
      usedPercentage: Number(match[2]),
      resets: match[3]?.trim() || null,
    }))
    .filter(meter => Number.isFinite(meter.usedPercentage) && meter.usedPercentage <= 100);
}

const matchLabel = (meters, label) => {
  if (typeof label !== 'string' || !label.trim()) return null;
  const wanted = label.trim().toLowerCase();
  return meters.find(meter => meter.label.toLowerCase().startsWith(wanted)) ?? null;
};

/**
 * Reduce a `/usage` result to the three meters the pacing bands use. `session` and
 * `weekAll` are required; `weekModel` is optional and its absence means "no tier
 * advice", never zero.
 */
export function parseQuota(result, { pacing = {} } = {}) {
  if (result?.type !== 'result' || result.subtype !== 'success' || result.is_error !== false) {
    throw new ProbeError('Claude did not return a successful final result.', 'protocol');
  }
  if (result.permission_denials?.length) {
    throw new ProbeError('Claude reported permission denials; the reading is incomplete.', 'local-access');
  }
  const value = result.result;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProbeError('The usage reading returned no text.', 'protocol');
  }
  if (result.local_command !== undefined && result.local_command !== 'usage') {
    throw new ProbeError('The usage reading did not run as a local command.', 'protocol');
  }
  if (Number.isFinite(result.num_turns) && result.num_turns !== 0) {
    throw new ProbeError('The usage reading consumed model turns; it is not the local command.', 'protocol');
  }
  if (/last.known|rate.limited|unable to|failed to/i.test(value)) {
    throw new ProbeError('A fresh subscription usage reading is required; this one is stale.', 'allowance-or-rate-limit');
  }

  const meters = parseMeterLines(value);
  const session = matchLabel(meters, pacing.sessionMeter ?? 'Current session');
  const weekAll = matchLabel(meters, pacing.tierAdvice?.allModelMeter ?? 'Current week (all models)');
  const weekModel = matchLabel(meters, pacing.tierAdvice?.perModelMeter);
  if (!session || !weekAll) {
    throw new ProbeError('The usage reading did not contain the configured session and weekly meters.', 'protocol');
  }
  return { session, weekAll, weekModel, meters };
}

const USAGE_ARGS = [
  '--safe-mode', '--strict-mcp-config', '--tools', '',
  '--print', '/usage', '--output-format', 'json',
];

/** The zero-model-turn local `/usage` reading. */
export function readClaudeUsage(executable, { pacing = {}, cwd = process.cwd(), timeoutMs } = {}) {
  return parseQuota(jsonCall(executable, USAGE_ARGS, { cwd, timeoutMs }), { pacing });
}
