# Guidance — what the creator edits

This folder is the creator's steering input to the autonomous wave loop. Everything here is
read by `agent-wave` when it builds a wave prompt; nothing here is written by agents.

| File | Purpose | Edit when |
|---|---|---|
| `PRIORITY.md` | Dispatch order and freezes for the current milestone, in plain prose. Pasted into every wave prompt. | The critical path changes, a packet should be frozen or reopened, or a new milestone starts. |
| `../../agent-meters.config.json` (`wave`, `records`, `guard`) | Loop defaults, record paths, integrator-owned prefixes. | Switching provider or model, tightening the budget, changing where records live. |

## Source of truth

| Question | Read |
|---|---|
| The rules, who owns what, who reads what | `../../AGENTS.md`, the only binding policy. It changes only through an `../decisions/` entry. |
| Packet status and graph | `../tasks.json`; generated human view `../TASK_BOARD.md` (`agent-board`) |
| Who holds what, and what remains per packet | `../leases.json`, summarised by `agent-progress` |
| Where the last wave stopped | the Now block of `../RESUME_STATUS.md` |
| Are the records consistent | `agent-admin` |
| What each wave did | `.agent-waves/WAVES.md` (local) and `../history/` (committed) |

Other creator inputs: `../decisions/` for decisions the integrator asked for, `../tasks/<ID>.md`
for packet scope, `../../templates/WAVE_PROMPT.md` for the fixed wording of a wave (change
rarely), and the file `.agent-waves/STOP` to end a loop at the next wave boundary.
