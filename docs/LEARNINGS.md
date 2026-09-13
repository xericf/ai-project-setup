# Learnings: running long autonomous development on subscription plans

Recorded 2026-09-13 from a Windows-first video studio project (95 task packets, two AI
providers, about three weeks of work). Numbers come from the local usage ledger, which reads
the CLIs' own logs; they are shares of what was logged, not a bill.

## What the tokens were actually spent on

One integrator session ran as a single goal thread for 22 hours with 21 context compactions.
It made about 2,060 model calls, each carrying 145k to 245k tokens of context, 97% of it
cache reads. Output was under one percent of the total. Two such threads consumed about 60%
of 1.5 billion logged tokens in a week.

| Consumer | Share |
|---|---|
| The integrator's own session | 72% |
| Its spawned subagents | 11% |
| Cross-provider reviews it launched | 10% |
| Everything else | 7% |

What those calls did: 1,721 shell commands, of which about 650 were file reads and searches,
266 git operations, 165 browser fixture runs, 132 quota checks, and only 33 test runs. The
integrator applied 396 patches itself. Screenshot viewing produced the largest tool outputs.

What it produced: 516 commits, 31k lines of source, 84k lines of tests and 519k lines of
docs and evidence, a 17 to 1 ratio of paperwork to product. Most of a day went into slicing
one packet into seven sub-lanes while the milestone's critical path had no integrations.

## The principles that follow

1. **Context length times call count is the cost, not effort.** Reasoning tokens were 0.1%
   of the total. A 200k-token context re-read on every trivial command is what burns a
   weekly allowance. Effort is the wrong dial to turn first.
2. **Sessions are waves, not threads.** One session does one unit of coordination and exits.
   State lives in files, never in the conversation. A fresh 7k-character prompt costs a fifth
   of a mature thread's per-call price.
3. **Bookkeeping runs outside the model.** Pacing, guard checks, progress counting, board
   generation and record validation are plain scripts. They run before the session and their
   output is pasted into the prompt. The model never spends a call to compute them.
4. **The orchestrator does not implement.** An integrator at high effort writing feature code
   is the most expensive possible worker. It integrates reviewed lease branches and
   dispatches; the guard enforces this from git history via an `Integrates:` trailer.
5. **One measure of progress.** Packet status transitions in the task graph and integrations
   landed. Commit counts, evidence volume and history prose are not progress and are not
   shown to the model as if they were.
6. **One policy file.** Four overlapping policy documents produced three direct
   contradictions and a fifth copy nobody maintained. One binding file with a reading-set
   table per role, changed only through a decision entry, and an admin check that fails when
   any live document cites an archived one.
7. **Reading sets are the onboarding.** Each role reads exactly its row. Workers get a fixed
   policy excerpt in their dispatch so it caches across packets. Nobody reads the product
   handoff, history or evidence during work.
8. **Records have one writer.** Task status, leases, the Now block and history are written by
   the integrator only, with explicit transitions. A consistency check compares status to
   lease state so a forgotten transition surfaces in the next prompt.
9. **Evidence is a manifest, not a dump.** Commit a README, a manifest of hashes and a few
   samples; keep raw captures local. Reviewers cite the manifest and a replayed check.
10. **The human steers through two small files.** A priority file in prose and a config of
    loop defaults. Decisions the integrator asks for go in a decisions folder and stop the
    loop until answered.
11. **Observability through a cheap watcher.** A small-model app session runs one wave per
    turn and reports twelve lines. The expensive reasoning happens in the child process that
    starts fresh each wave.
12. **The timeout is a safety net, not a budget.** The tool-call budget in the prompt bounds
    the work; the wall-clock timeout only catches a hung session. Set it generously and make
    the session record and stop on its own.

## Things that bit us

- Recursive `grep -r` from the repository root hung for minutes: agent worktrees under a
  dotfolder held full checkouts with dependency directories. Use `git grep` or exclude them.
- Mixed line endings in policy files defeated scripted edits. Inspect the anchor line's bytes
  before a replacement, and preserve the file's endings.
- Lease branches that were "ahead of main" had in fact been integrated by squash; ahead-ness
  is not unmerged work. The lease record's `remaining` field is the truth, not git topology.
- A generated task board was the only way to stop the hand-maintained one from going stale.
- Provider CLIs are not always installed where the desktop app is; locate the executable and
  refuse shell shims rather than guessing.
