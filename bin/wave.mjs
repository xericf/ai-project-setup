#!/usr/bin/env node
/**
 * `agent-wave` — run the integrator as a loop of short-lived sessions.
 * See src/wave.js for the design and WAVE_USAGE for the flags.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { extractConfigFlag, loadConfig } from '../src/config.js';
import { locateClaude } from '../src/claude-usage.js';
import { locateCodex } from '../src/codex-usage.js';
import { runAdmin, formatAdmin } from '../src/admin.js';
import { runGuard, formatGuard, gitOutput, splitRecords } from '../src/guard.js';
import { buildProgress, currentMilestone, formatProgress } from '../src/progress.js';
import {
  WAVE_USAGE, appendLedger, composePrompt, loadState, parseWaveArgs, readNow, runnerInvocation, saveState, sleepSync, stamp,
} from '../src/wave.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function progressText(root, { records, guard }, milestone, since) {
  const tasksPath = path.join(root, records.tasksFile);
  if (!existsSync(tasksPath)) return '(no task graph at ' + records.tasksFile + ')';
  const taskFile = JSON.parse(readFileSync(tasksPath, 'utf8'));
  const leasesPath = path.join(root, records.leasesFile);
  const leaseFile = existsSync(leasesPath) ? JSON.parse(readFileSync(leasesPath, 'utf8')) : null;
  let integrations = [];
  if (since) {
    try {
      integrations = splitRecords(gitOutput(['log', `--format=%h %s%x1f%(trailers:key=${guard.integratesTrailer},valueonly)%x1e`, `${since}..HEAD`], { cwd: root }))
        .map(l => l.split('\x1f')).filter(([, t]) => (t ?? '').trim()).map(([s, t]) => `${s.trim()} [${t.trim()}]`);
    } catch { integrations = []; }
  }
  const head = gitOutput(['rev-parse', '--short', 'HEAD'], { cwd: root }).trim();
  return formatProgress(buildProgress({ taskFile, leaseFile, milestone, integrations, since, head }, records), records);
}

function pacingText(configPath) {
  const args = [path.join(PACKAGE_ROOT, 'bin', 'pacing.mjs'), '--dispatch', ...(configPath ? ['--config', configPath] : [])];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), parked: /parked/i.test(r.stdout ?? '') && !/not parked/i.test(r.stdout ?? '') };
}

async function main(argv) {
  let configPath; let rest; let config; let root;
  try {
    ({ configPath, rest } = extractConfigFlag(argv));
    ({ config, root } = loadConfig({ configPath }));
  } catch (error) { process.stderr.write(`${error.message}\n`); return 2; }
  let o;
  try { o = parseWaveArgs(rest, config.wave); } catch (error) { process.stderr.write(`${error.message}\n\n${WAVE_USAGE}\n`); return 2; }
  if (o.help) { process.stdout.write(`${WAVE_USAGE}\n`); return 0; }

  const { records, guard, wave } = config;
  const stateDir = path.join(root, wave.stateDir);
  const stateFile = path.join(stateDir, 'state.json');
  const ledgerFile = path.join(stateDir, 'WAVES.md');
  const stopFile = path.join(stateDir, 'STOP');
  const templatePath = path.isAbsolute(o.template) ? o.template : path.join(root, o.template);
  const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf8') : readFileSync(path.join(PACKAGE_ROOT, 'templates', 'WAVE_PROMPT.md'), 'utf8');
  const git = args => gitOutput(args, { cwd: root }).trim();
  const state = loadState(stateFile);
  const tasksPath = path.join(root, records.tasksFile);
  const milestoneName = o.milestone === 'auto' && existsSync(tasksPath)
    ? (currentMilestone(JSON.parse(readFileSync(tasksPath, 'utf8')), records) ?? 'auto')
    : o.milestone;

  for (let i = 0; i < o.maxWaves; i += 1) {
    if (existsSync(stopFile)) { process.stdout.write(`STOP file present (${stopFile}); exiting.\n`); return 0; }
    const dirty = git(['status', '--porcelain']);
    if (dirty && !o.dryRun && !o.allowDirty) { process.stdout.write(`working tree is dirty; the previous session left work behind.\n${dirty}\n`); return 2; }

    if (wave.preflight.includes('admin')) {
      const admin = runAdmin({ root, records });
      if (!admin.ok && !o.dryRun) { process.stdout.write(`preflight failed; fix the records before the next wave.\n${formatAdmin(admin)}\n`); return 5; }
    }

    const pacing = pacingText(configPath);
    if (pacing.parked && o.runner === 'codex' && !o.dryRun) {
      state.parkedStreak += 1; saveState(stateFile, state);
      process.stdout.write(`Codex parked (${state.parkedStreak}/3); sleeping ${o.sleepMinutes} min.\n`);
      if (state.parkedStreak >= 3) { process.stdout.write('parked three checks in a row; exiting.\n'); return 0; }
      sleepSync(o.sleepMinutes * 60_000); continue;
    }
    state.parkedStreak = 0;

    const prevHead = state.lastHead;
    const guardText = prevHead
      ? formatGuard(runGuard({ since: prevHead, cwd: root, guard }))
      : `Guard baseline established at ${git(['rev-parse', '--short', 'HEAD'])}; the integration-trailer rule applies to every commit after this wave.`;
    state.wave += 1;
    state.lastHead = git(['rev-parse', 'HEAD']);
    const prefix = path.join(stateDir, 'waves', `${stamp()}-wave-${state.wave}`);
    const priorityPath = path.join(root, records.priorityFile);
    const prompt = composePrompt(template, {
      WAVE: String(state.wave), MILESTONE: milestoneName, REPO: root, HEAD: state.lastHead.slice(0, 9), STARTED: new Date().toISOString(),
      NOW: readNow(path.join(root, records.resumeFile), records.nowHeading),
      PROGRESS: progressText(root, config, o.milestone, prevHead),
      HANDOFF: state.lastMessageFile && existsSync(state.lastMessageFile) ? readFileSync(state.lastMessageFile, 'utf8').trim() : '(first wave of this loop)',
      PRIORITY: existsSync(priorityPath) ? readFileSync(priorityPath, 'utf8').trim() : '(no priority file; follow the task graph)',
      PACING: pacing.text, GUARD: guardText, BUDGET: String(o.budget),
    });
    saveState(stateFile, state);
    if (o.dryRun) { process.stdout.write(`${prompt}\n`); return 0; }
    writeFileSync(`${prefix}-prompt.md`, prompt);
    process.stdout.write(`wave ${state.wave}: prompt ${prompt.length} chars -> ${prefix}-prompt.md\n`);

    let exe = o.runnerExe;
    if (!exe) {
      try { exe = o.runner === 'codex' ? locateCodex() : locateClaude(); } catch (error) {
        process.stdout.write(`runner "${o.runner}" was not found (${error.category ?? 'not-found'}). Install it or pass --runner-exe.\n`); return 3;
      }
    }
    const { args } = runnerInvocation({ runner: o.runner, exe, model: o.model, effort: o.effort, repo: root, lastMessageFile: `${prefix}-last.md`, extra: o.runnerArgs });
    const started = Date.now();
    const run = spawnSync(exe, args, { cwd: root, input: prompt, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: o.waveTimeoutMinutes * 60_000, killSignal: 'SIGTERM' });
    writeFileSync(`${prefix}-stdout.log`, run.stdout ?? '');
    writeFileSync(`${prefix}-stderr.log`, run.stderr ?? '');
    if (run.error?.code === 'ENOENT') { process.stdout.write(`runner executable could not be spawned: ${exe}\n`); return 3; }
    const timedOut = run.error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM';
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    const after = runGuard({ since: state.lastHead, cwd: root, guard });
    const head = git(['rev-parse', '--short', 'HEAD']);
    const commits = git(['rev-list', '--count', `${state.lastHead}..HEAD`]);
    const summary = `wave ${state.wave}: exit ${timedOut ? `timeout after ${o.waveTimeoutMinutes} min` : run.status} after ${minutes} min, ${commits} commit(s), HEAD ${head}${after.violations.length ? ', GUARD VIOLATION' : ''}`;
    const lastMessage = existsSync(`${prefix}-last.md`) ? readFileSync(`${prefix}-last.md`, 'utf8') : (run.stdout ?? '').slice(-4000);
    if (!existsSync(`${prefix}-last.md`)) writeFileSync(`${prefix}-last.md`, lastMessage);
    state.lastMessageFile = `${prefix}-last.md`;
    const progress = progressText(root, config, o.milestone, state.lastHead);
    writeFileSync(`${prefix}-summary.txt`, `${summary}\n\n${progress}\n\n${formatGuard(after)}\n\n${lastMessage}\n`);
    appendLedger(ledgerFile, `## Wave ${state.wave} · ${new Date().toISOString()}\n\n${summary}\n\n${progress}\n\n${lastMessage.trim()}\n\n`);
    saveState(stateFile, state);
    process.stdout.write(`${summary}\n${formatGuard(after)}\n`);
    if (after.violations.length) { process.stdout.write('integrator implemented directly; loop stopped so the next prompt leads with the finding.\n'); return 4; }
    if (git(['status', '--porcelain'])) { process.stdout.write('session left the tree dirty; loop stopped.\n'); return 2; }
    if (i + 1 < o.maxWaves) { process.stdout.write(`sleeping ${o.sleepMinutes} min before the next wave\n`); sleepSync(o.sleepMinutes * 60_000); }
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
