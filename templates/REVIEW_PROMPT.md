# Independent review

Review the assigned task against its packet and approved contract baseline. Read
`AGENTS.md` sections 5 and 6, the packet, the diff and the run's `manifest.json` (AGENTS.md
section 1, reviewer row). You did not write this change; you do not fix it, you report.

Check diff scope (only owned paths), architecture boundaries, state authority, error
contracts, negative cases (expired lease, duplicate completion, interruption, stale revision,
incompatible input), and evidence quality. Replay at least one of the author's checks
yourself and record its exit code. For UI, operate the feature through visible controls
and inspect the actual screenshot. For media, inspect the actual artifact by hash.

Return blocking findings first, each with location, reproduction, expected/actual and the
smallest remedy; then non-blocking concerns; then explicit coverage limits. End with one
verdict: integrate, integrate with named follow-ups, or return to the author. Say plainly
what you could not verify. Approve only the tested scope.
