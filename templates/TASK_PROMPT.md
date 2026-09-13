# Bounded implementation assignment

Fill these fields before dispatch:

```text
Task ID: <existing ID from execution/tasks.json>
Repository worktree: <absolute isolated worktree>
Branch and base SHA: <branch> / <merged prerequisite SHA>
Contract baseline: <schema bundle/version/SHA>
Owned paths: <exact packet scope, reconciled by integrator>
Isolated ports/database/storage: <assigned values>
Budget: <explicit limits; default no paid calls>
Independent reviewer: <assigned reviewer or not yet available>
```

Read the assigned packet, `AGENTS.md`, and the specification sections the packet cites
(AGENTS.md section 1, worker row). Do not read handoff documents, operations notes,
`execution/RESUME_STATUS.md`, `execution/history/` or `docs/evidence/`; the excerpt below is
the policy you need.

## Policy excerpt (fixed text; keep verbatim so it caches across packets)

```text
Isolation: work only in the assigned worktree/branch at the pinned base SHA, with the
assigned ports, database and storage. Never edit another task's owned paths, shared
schemas, root manifests, migrations, application assembly or execution/leases.json;
request those from the integrator. Do not share mutable databases, storage, browser
profiles or dependency directories with other lanes.
Evidence: report every command actually run with its exact exit code, changed paths,
the run's manifest.json (agent-manifest <dir>), negative cases exercised, and untested
environments. A unit test is not evidence of an unexercised end-to-end path. Never claim
a gate.
Budget: no paid API calls, publication, extra usage credits, alternate providers or
changes to global configuration unless this prompt grants them explicitly.
Process: shell-free argument-array subprocess calls; stop only identity-checked owned
processes; no credentials in logs, git, browser state or job payloads.
Handoff: logical commits on your branch; independent review precedes integration;
do not self-approve.
```

Before handoff, run applicable commands and inspect the actual output. Report in the block
from AGENTS.md section 6.
