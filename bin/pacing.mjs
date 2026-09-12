#!/usr/bin/env node
/**
 * `agent-pacing` — read the local subscription meters and print the pacing decision.
 *
 * Exit codes: 0 success, 1 a required source could not be read (the category is
 * printed, never the provider output), 2 bad arguments.
 */
import process from 'node:process';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { locateClaude, readClaudeUsage } from '../src/claude-usage.js';
import { locateCodex, readCodexRateLimits } from '../src/codex-usage.js';
import { PACING_USAGE, buildReport, classify, formatDispatch, parseArgs } from '../src/pacing.js';

async function main(argv) {
  let options;
  let configPath;
  let rest;
  try {
    ({ configPath, rest } = extractConfigFlag(argv));
    options = parseArgs(rest);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${PACING_USAGE}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${PACING_USAGE}\n`);
    return 0;
  }

  let config;
  try {
    ({ config } = loadConfig({ configPath }));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const pacing = config.pacing ?? {};
  const notes = [];

  let claude = null;
  if (!options.codexOnly) {
    try {
      const quota = readClaudeUsage(locateClaude(), { pacing });
      claude = {
        session: quota.session.usedPercentage,
        weekAll: quota.weekAll.usedPercentage,
        weekModel: quota.weekModel?.usedPercentage ?? null,
        modelMeterLabel: quota.weekModel?.label ?? pacing.tierAdvice?.perModelMeter ?? 'per-model week',
        weekResets: quota.weekAll.resets ?? null,
        weekElapsedPct: null,
        source: 'usage',
      };
    } catch (error) {
      // The categories are already sanitized; no provider output is carried here.
      claude = { error: error.category ?? classify(error.message) };
      notes.push('The Claude usage reading failed; its meters are unavailable, not zero.');
    }
  }

  let codex = null;
  if (!options.claudeOnly) {
    try {
      const limits = await readCodexRateLimits(locateCodex());
      codex = limits.error
        ? { error: limits.error }
        : { windows: limits.windows, weekly: limits.weekly, session: limits.session, reached: limits.reached ?? null, source: 'app-server' };
    } catch (error) {
      codex = { error: error.category ?? 'not-found' };
    }
    if (codex.error) notes.push('The Codex rate-limit reading failed; its meters are unavailable, not zero.');
    else if (!codex.weekly) notes.push('Codex reported no weekly window; treat its weekly meter as unavailable.');
  }

  const report = buildReport({ claude, codex, weekElapsedOverride: options.weekElapsed, notes }, pacing);
  process.stdout.write(`${options.dispatch ? formatDispatch(report, pacing) : JSON.stringify(report, null, 2)}\n`);

  // One failed provider still reports the other. The scarce-provider reading is
  // required unless it was not requested, in which case Codex is the only reading.
  const claudeFailed = !options.codexOnly && Boolean(claude?.error);
  const codexFailed = !options.claudeOnly && Boolean(codex?.error);
  return claudeFailed || (options.codexOnly && codexFailed) ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
