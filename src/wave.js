/**
 * Wave supervisor.
 *
 * Runs an integrator as a loop of short-lived sessions instead of one long thread. Each
 * wave: check the records, read the meters, build a prompt from the template with the
 * state files filled in, launch one fresh runner session with the prompt on stdin, then
 * verify that no implementation code reached the branch outside a reviewed integration.
 * State between waves lives in files (the Now block, the previous session's final
 * message, the ledger), never in a conversation.
 *
 * The runner is spawned shell-free from a located executable; `.cmd` shims are refused
 * like everywhere else in this package. Prompts, transcripts and outputs are written to
 * the state directory only; this module prints paths, counts and exit codes.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nowBlock } from './admin.js';

export const WAVE_USAGE = `Usage: agent-wave [options]

  --runner codex|claude        session runner (config wave.runner)
  --model <id>                 runner model (config wave.model.<runner>)
  --effort <level>             reasoning effort (config wave.effort)
  --budget <n>                 tool-call budget written into the prompt (config wave.budget)
  --max-waves <n>  --once      waves per run (config wave.maxWaves)
  --sleep-minutes <n>          pause between waves (config wave.sleepMinutes)
  --wave-timeout-minutes <n>   safety net for a hung session (config wave.waveTimeoutMinutes)
  --milestone auto|<id>        milestone for the progress block (config wave.milestone)
  --template <path>            prompt template (config wave.promptTemplate)
  --runner-exe <path>          explicit runner executable
  --runner-args "<extra>"      appended to the runner command line
  --allow-dirty                start even when the working tree is dirty
  --dry-run                    print the composed prompt and exit
  --config <path>              config file

Stop a running loop by creating <stateDir>/STOP. Exit codes: 0 ok, 2 dirty tree,
3 runner missing, 4 guard violation, 5 preflight failed.
`;

export function parseWaveArgs(argv, wave) {
  const o = {
    runner: wave.runner, model: null, effort: wave.effort, budget: wave.budget, maxWaves: wave.maxWaves,
    sleepMinutes: wave.sleepMinutes, waveTimeoutMinutes: wave.waveTimeoutMinutes, milestone: wave.milestone,
    template: wave.promptTemplate, runnerExe: null, runnerArgs: [], allowDirty: false, dryRun: false, help: false,
  };
  const num = (name, value) => { const n = Number(value); if (!Number.isFinite(n) || n < 0) throw new Error(`${name} needs a non-negative number.`); return n; };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value.`); return v; };
    switch (arg) {
      case '--runner': o.runner = next(); break;
      case '--model': o.model = next(); break;
      case '--effort': o.effort = next(); break;
      case '--budget': o.budget = num(arg, next()); break;
      case '--max-waves': o.maxWaves = num(arg, next()); break;
      case '--once': o.maxWaves = 1; break;
      case '--sleep-minutes': o.sleepMinutes = num(arg, next()); break;
      case '--wave-timeout-minutes': o.waveTimeoutMinutes = num(arg, next()); break;
      case '--milestone': o.milestone = next(); break;
      case '--template': o.template = next(); break;
      case '--runner-exe': o.runnerExe = next(); break;
      case '--runner-args': o.runnerArgs = next().split(' ').filter(Boolean); break;
      case '--allow-dirty': o.allowDirty = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--help': case '-h': o.help = true; break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!['codex', 'claude'].includes(o.runner)) throw new Error(`--runner must be codex or claude, got ${o.runner}.`);
  o.model ??= wave.model?.[o.runner] ?? null;
  return o;
}

/** Fills `{{KEY}}` placeholders; the template may wrap the prompt in a ```text fence. */
export function composePrompt(template, fill) {
  const fenced = template.match(/```text\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : template;
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => fill[key] ?? `{{${key}}}`);
}

/** Runner command line. The prompt travels on stdin, never in argv. */
export function runnerInvocation({ runner, exe, model, effort, repo, lastMessageFile, extra = [] }) {
  if (runner === 'codex') {
    return { exe, args: ['exec', '--full-auto', '-C', repo, '--sandbox', 'workspace-write', ...(model ? ['-m', model] : []), '-c', `model_reasoning_effort="${effort}"`, '-o', lastMessageFile, ...extra, '-'] };
  }
  return { exe, args: ['-p', '--permission-mode', 'acceptEdits', ...(model ? ['--model', model] : []), '--output-format', 'text', ...extra] };
}

export function readNow(resumeFile, heading) {
  if (!existsSync(resumeFile)) return '(no resume file)';
  const block = nowBlock(readFileSync(resumeFile, 'utf8'), heading);
  return (block ?? '(no Now block)').trim();
}

export const stamp = (date = new Date()) => date.toISOString().replace(/[:.]/g, '-');

export function loadState(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { wave: 0, lastHead: null, lastMessageFile: null, parkedStreak: 0 };
}

export function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

export function appendLedger(file, entry) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, entry);
}

/** Blocks the current process for `ms` without a shell or a busy loop. */
export function sleepSync(ms) {
  if (ms <= 0) return;
  spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${Math.floor(ms)})`], { stdio: 'ignore' });
}
