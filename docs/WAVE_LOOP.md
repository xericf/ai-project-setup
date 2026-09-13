# The wave loop

How to run a long-running development goal through short-lived agent sessions. Written for
the person setting up a new project; the rationale is in [LEARNINGS.md](LEARNINGS.md).

## Bootstrap a project

```sh
npm i -g ai-project-setup
cd my-project
agent-init                      # AGENTS.md, templates/, execution/guidance/, config, gitignore lines
```

Then, once:

1. Fill `AGENTS.md` sections 1 and 3 with your agent names and limits, and section 8 with
   what is pre-authorized. Everything else in the template is provider-neutral policy.
2. Create `execution/tasks.json` in the shape `agent-progress --help` describes: packets with
   `id`, `milestone`, `status`, `depends_on`, optional `title`, `lane`, `packet`,
   `scheduling`, plus `primary_delivery_sequence`. One markdown packet per task under
   `execution/tasks/`.
3. Set `guard.ownedPrefixes` in `agent-meters.config.json` to the assembly files the
   integrator may edit directly; everything else under `guard.implementationRoots` must
   arrive through a reviewed integration.
4. Write `execution/guidance/PRIORITY.md` in prose and fill the Now block of
   `execution/RESUME_STATUS.md`.
5. `agent-admin` until it is green, `agent-board` to generate the board, then
   `agent-wave --dry-run --once` to read the prompt a session would receive.

## One wave

```text
agent-wave --once
```

1. **Preflight.** Stop file? Dirty tree? `agent-admin` green? Any failure stops with a
   distinct exit code (2 dirty, 5 records) so a watcher can report it.
2. **Meters.** `agent-pacing --dispatch` runs outside the model. If the default provider is
   parked the loop sleeps; three parked checks in a row end it.
3. **Guard.** Commits since the previous wave are checked for implementation changes without
   an `Integrates:` trailer. The first wave records a baseline instead.
4. **Prompt.** `templates/WAVE_PROMPT.md` is filled with the Now block, the progress report
   (packets done, ready, open leases with remaining work, mismatches), the previous session's
   final message, the priority file, the pacing block, the guard report and the tool budget.
   About 7k characters.
5. **Session.** The runner (`codex exec` or `claude -p`) is spawned shell-free with the prompt
   on stdin and a wall-clock timeout. The session collects, integrates at most one reviewed
   packet, dispatches, records and writes a 15-line final message.
6. **Post-check.** Guard again in strict mode; clean tree; summary file with the exit code,
   commit count, progress and final message; one entry appended to `WAVES.md`. A violation
   stops the loop (exit 4) so the next prompt leads with the finding.

State lives in `.agent-waves/` (gitignored): `state.json`, `WAVES.md`, `waves/*-prompt.md`,
`*-summary.txt`, `*-last.md`, logs. Create `.agent-waves/STOP` to end a run at the next
boundary.

## Timeouts and budgets

Two bounds apply to a session. The **tool-call budget** in the prompt (config `wave.budget`,
default 250) is the working bound: the integrator is told to record state and stop when it
reaches it. The **wall-clock timeout** (config `wave.waveTimeoutMinutes`, default 180) is a
safety net for a hung session, not a work allowance. A session that dispatches workers and
waits for them can legitimately run for hours, so set the timeout generously and let the
budget do the limiting. A timed-out session is killed; its uncommitted work leaves the tree
dirty, the loop stops with exit 2, and the summary records the timeout so the next wave's
handoff says what happened. If sessions routinely approach the timeout, lower the budget or
split the wave rather than raising the timeout.

## Roles at a glance

| Who | Does | Never |
|---|---|---|
| Creator | edits `guidance/`, answers `decisions/`, reads `WAVES.md` and `agent-progress` | edits the Now block, leases or history by hand |
| Watcher (cheap app session) | runs `agent-wave --once` per turn, reports 12 lines | edits files, reads history or evidence |
| Integrator (one session per wave) | collects, integrates one reviewed packet, dispatches, records | implements, runs pacing, views screenshots, reads history |
| Workers | implement one packet in an isolated worktree, hand back an evidence manifest | touch shared contracts, records or other packets |
| Reviewers | replay a check, report findings and a verdict | fix anything |

## The tools

| Command | Purpose |
|---|---|
| `agent-init` | copy policy, templates, guidance and config into a project |
| `agent-wave` | run waves |
| `agent-progress` | packets done, ready, open leases with remaining work, mismatches |
| `agent-admin` | records consistent, board fresh, links resolve, no archived citations |
| `agent-board` | generate the human task board from the graph |
| `agent-guard` | implementation code reached HEAD only via reviewed integrations |
| `agent-manifest` | evidence manifest with hashes |
| `agent-pacing`, `agent-ledger` | meters and token accounting (see README) |
