# ai-project-setup

Dependency-free Node tools for running long autonomous development on Claude Code and
Codex subscription plans without burning the weekly allowance on context re-reads.

**Meters and accounting**

- `agent-pacing` — how many parallel implementation slots the scarce provider can
  carry right now, from its session and weekly meters.
- `agent-ledger` — where your tokens actually went: run and token shares per
  provider, model, reasoning effort and agent, plus the cache-read ratio.

**The wave loop** (see [docs/WAVE_LOOP.md](docs/WAVE_LOOP.md); why, in
[docs/LEARNINGS.md](docs/LEARNINGS.md))

- `agent-init` — drop the policy file, prompt templates, guidance folder and config into a
  project.
- `agent-wave` — run the integrator as a loop of short-lived sessions: preflight the records,
  read the meters, fill the wave prompt from state files, launch one fresh session, verify
  no code reached the branch outside a reviewed integration.
- `agent-progress` — packets done, ready to dispatch, open leases with remaining work, and
  status/lease mismatches.
- `agent-admin` — the administrative records stay consistent with each other and the policy.
- `agent-board` — a generated task board that cannot drift from the task graph.
- `agent-guard` — the integrator did not implement: implementation commits carry an
  `Integrates:` trailer or they are violations.
- `agent-manifest` — evidence manifests with hashes so raw captures stay out of git.

```sh
npm i -g ai-project-setup
cd my-project && agent-init && agent-admin && agent-wave --dry-run --once
```

No network calls, no API keys, no model turns. Nothing prints prompts, transcript
text, review prose, environment values, tokens or account identifiers — only ids,
file paths, labels, percentages and integer counts.

Requires Node ≥ 20. Runs on Windows, macOS and Linux.

## Install

```sh
npm i -g ai-project-setup      # then: agent-pacing / agent-ledger
npx ai-project-setup agent-pacing --dispatch
```

Or clone and run `node bin/pacing.mjs` / `node bin/ledger.mjs` directly.

## What each tool reads

**`agent-pacing`**

| Source | How |
|---|---|
| Claude meters | runs the installed Claude CLI's local `/usage` command (`--print /usage --output-format json`), which spends no model turn |
| Codex rate limits | spawns `codex app-server` and performs one JSON-RPC `account/rateLimits/read` over stdio |

It computes `gap = all_model_weekly_pct − week_elapsed_pct`, where the elapsed
fraction comes from the weekly meter's own reset string (`Sep 13, 3pm
(America/New_York)`), converted with `Intl` — no timezone dependency. Two hard stops
come before the bands: the session block and the weekly reserve. **An unreadable
meter is reported as `unavailable`, never as `0`.**

```text
$ agent-pacing --dispatch
`claudeSlots: 0`; `claudeAssignments`: <fill in the assigned packets or reviews>.
`claudeWaived: quota-blocked` — this wave only; it does not carry forward.
Claude meters: session 88%, all-model week 38%, Current week (Fable) 31%, weekly reset Sep 13, 3pm (America/New_York).
The weekly elapsed fraction is approximately 87%, giving a gap near -49 points.
Codex windows: weekly 13% (resets 2026-09-19T13:01:33.000Z); not parked.
Model tier: hold.
- Session meter at 88% used, at or above the 80% block: no implementation slots.
```

**`agent-ledger`**

| Source | Path |
|---|---|
| Codex rollouts | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Claude transcripts | `~/.claude/projects/<dir>/*.jsonl` (filtered by `claudeProjectDirGlob`) |
| Effort fallbacks | `claudeAgentDefsDir` frontmatter, then `claudeSettingsFile` `modelSettings[model].effortLevel` |
| Review summaries | each entry in `reviewSummaryDirs`, `*.json` (optional; empty by default) |

Per-response Codex `usage` objects are summed and cumulative fields are never added
in; repeated Claude content blocks of one response are counted once per
`(requestId, message.id)`; Codex input is cache-inclusive and Claude input is not,
and both are normalised to the same four buckets. `reason%` is reasoning tokens as a
share of output; Codex reports them per response, Claude usage does not, so Claude rows
show `-`. Compare it across effort levels: a high-effort group whose reasoning share
matches a medium group is not getting more thinking for its cost.

```text
$ agent-ledger --last 7d --table
Agent usage ledger  (2026-09-05 .. now, grouped by provider + model + effort)

group                              runs   run%   fresh in  cache read  cache write   output      total  total%  cache%  reason%
---------------------------------  ----  -----  ---------  ----------  -----------  -------  ---------  ------  ------  -------
codex / <model> / ultra               9   9.5%  21,190,435 730,306,176           0  3,806,102 755,302,713  67.0%   97.2%    27.6%
codex / <auto-review> / low          33  34.7%  21,174,926  77,927,936           0    127,631  99,230,493   8.8%   78.6%    38.9%
claude / <model> / high               1   1.1%       4,432  65,785,593    2,092,412   263,036  68,145,473   6.0%   96.9%        -

totals: 95 runs, 1,127,369,966 tokens, cache-read ratio 95.4%, 0 model mismatch(es)

sources: 79 file(s) scanned, 13 skipped, 0 malformed line(s)
Caveat: shares are of locally logged activity only; subscription meters are billed separately and this ledger is not a bill.
```

Model and effort names are **whatever the logs contain**, so this works on any plan
and any model line-up. The only opinionated part is the pacing bands, and they live
in config.

## CLI

```text
agent-pacing [--dispatch|--json] [--claude-only|--codex-only]
             [--week-elapsed N] [--config path] [--help]

agent-ledger [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--last Nd]
             [--by provider,model,effort,agent] [--runs] [--json|--table]
             [--config path] [--help]
```

`--last 7d` is shorthand for `--since (today − 7 days)`. The ledger's default range
is today only. Exit codes: `0` success, `1` a required source could not be read (the
failure is reported as a category such as `authentication`, `network`,
`allowance-or-rate-limit`, `local-access`, `timeout` or `not-found` — never as
provider output), `2` bad arguments.

## Config

`agent-meters.config.json` is searched for from the working directory upward to the
filesystem root and merged over the defaults; `--config <path>` overrides the search.

```json
{
  "claudeProjectDirGlob": "*",
  "reviewSummaryDirs": [],
  "claudeAgentDefsDir": ".claude/agents",
  "claudeSettingsFile": ".claude/settings.json",
  "pacing": {
    "scarceProvider": "claude",
    "bands": [
      { "gapBelow": -10, "slots": 2 },
      { "gapBelow": 10, "inclusive": true, "slots": 1 },
      { "slots": 0 }
    ],
    "sessionBlockUsedPct": 80,
    "weeklyReserveUsedPct": 90,
    "tierAdvice": {
      "perModelMeter": "Current week (Fable)",
      "allModelMeter": "Current week (all models)"
    },
    "sessionMeter": "Current session"
  }
}
```

| Key | Meaning |
|---|---|
| `claudeProjectDirGlob` | which `~/.claude/projects` directories to scan. `*` is all; `*MyRepo*` scopes to one checkout and its worktrees. A pattern with no `*` is treated as a substring. Matching is case insensitive. |
| `reviewSummaryDirs` | extra directories of `*.json` run summaries, relative to the working directory. From inside a linked git worktree the main checkout is also tried. |
| `claudeAgentDefsDir` / `claudeSettingsFile` | where to look up reasoning effort when a transcript does not record it |
| `pacing.bands` | ordered; the first match wins. `gapBelow` is an exclusive upper bound, `"inclusive": true` makes it inclusive, and the last band omits `gapBelow` and is the fallback. |
| `pacing.sessionBlockUsedPct` | session usage at or above this blocks all slots (`quota-blocked`) |
| `pacing.weeklyReserveUsedPct` | all-model weekly usage at or above this blocks all slots, and is also what parks Codex |
| `pacing.sessionMeter` / `tierAdvice.*Meter` | meter **labels** to look for, matched case insensitively by prefix |

Meter labels differ by plan: the per-model weekly line may read `Current week
(Opus)`, `Current week (Fable)`, or be absent entirely. A missing per-model meter
means *no tier advice*, never a zero reading. Codex windows are classified by their
reported `windowDurationMins` — at least 7 days is `weekly`, at most 6 hours is
`session`, anything else is labelled by its duration — so no particular window is
assumed to exist.

Environment overrides: `AGENT_METERS_CLAUDE_EXE` and `AGENT_METERS_CODEX_EXE` (each
must be an existing absolute path to a real binary).

The wave-loop tools read three more sections, all with defaults (see `src/config.js`):

| Key | Meaning |
|---|---|
| `records.*` | where the administrative records live (`tasksFile`, `leasesFile`, `resumeFile`, `priorityFile`, `taskBoardFile`, `policyFile`), the Now block heading and limits, the `liveDocs` whose links are checked, the `archivedDocs` no live document may cite, and the status vocabulary. Checks whose file is absent are skipped. |
| `guard.*` | `implementationRoots` the integrator may not edit directly, `ownedPrefixes` it may, the trailer names, and the evidence-flood warning threshold. |
| `wave.*` | runner, per-runner model, effort, tool-call `budget`, `maxWaves`, `sleepMinutes`, `waveTimeoutMinutes` (a safety net, default 180), `milestone`, `promptTemplate`, `stateDir`, `preflight`. Flags override. |

## Platform discovery order

1. `AGENT_METERS_CLAUDE_EXE` / `AGENT_METERS_CODEX_EXE`.
2. `PATH`, walked directly — split on `path.delimiter`, with `PATHEXT` applied on
   Windows. No shell is spawned, so a `.cmd` shim is recognised rather than executed.
3. Known locations:

| | Claude | Codex |
|---|---|---|
| all | `~/.local/bin/claude[.exe]`, VS Code bundle `~/.vscode/extensions/anthropic.claude-code-<ver>-<platform>/resources/native-binary/claude[.exe]` (newest version, matching platform tag), `~/.npm-global/bin/claude[.exe]` | `~/.codex/bin/codex[.exe]`, `~/.local/bin/codex[.exe]` |
| Windows | — | `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, newest by mtime, skipping hash directories without the exe |
| macOS / Linux | `/usr/local/bin/claude`, `/opt/homebrew/bin/claude` | `/usr/local/bin/codex`, `/opt/homebrew/bin/codex` |

Platform tags recognised for the VS Code bundle: `win32-x64`, `darwin-arm64`,
`darwin-x64`, `linux-x64`, `linux-arm64`.

A npm global JS entry point such as
`/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js` is **not** a native
binary and is deliberately not used. On Windows, a `.cmd` shim would need
`shell: true` to spawn, which these tools refuse; the real binary beside the shim is
used if there is one, otherwise you are told to set the `*_EXE` override.

## What it is not

**This is not a bill.** Percentages are shares of what was logged locally, and the
token counts are what the CLIs recorded, not what you were charged. Your provider's
subscription meters are the authoritative record for quota and billing; the pacing
bands are a scheduling convention, not a limit anyone enforces.

## Development

```sh
npm test          # node --test, no dependencies, no network, no logins
```

Tests are OS-independent: simulated platforms use `path.win32` / `path.posix`, and
on-disk fixtures use `os.tmpdir()`. CI runs the suite on ubuntu-latest, macos-latest
and windows-latest against Node 20 and 22.

## Licence

MIT © xericf
