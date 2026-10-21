# SharedNet planner/quorum experiment client

Local, independent runtime fork of the **deployed SharedNet 0.1.12 exact-DONE client**.
The older local TypeScript checkout is 0.1.10 and was not used as the runtime base.
Original file hashes and source location are in `baseline-provenance.json`; Git's
initial commit preserves the deployed files. This package edits the published
JavaScript directly; it is not a build of a corresponding upstream TypeScript tree.
Do not run an upstream build over these files.

No flags means the original simultaneous startup and any-agent/check completion
path. The original local checkout and the installed server client are unchanged.
This package is private and has no Git remote.

## Enable the experiment

Use this package's absolute entry point, not the globally installed `sharednet`:

```bash
node /path/to/sharednet-planner-experiment/bin/sharednet.js goal run goal.md \
  --agent codex:gpt-6-astra \
  --agent codex:gpt-6-luna \
  --agent codex:gpt-6-luna \
  --agent codex:gpt-6-luna \
  --startup-mode planner-first \
  --completion-policy all-agents-done \
  --until 'said /^DONE$/' \
  --until 'check bash check.sh' \
  --until 'after 45m' \
  --until 'budget 5M tokens' \
  --workspace /path/to/prepared-workspace \
  --out /path/to/fresh-run-record \
  --image YOUR_EXISTING_EXPERIMENT_IMAGE
```

The example does not select a reasoning effort or change the existing image,
task pack, scoring configuration, CPU allocation, or model credentials. Retain
the experiment harness's existing settings for those. No experiment was started
as part of this local change. Before server use, the queue must explicitly point
at this client and preserve the new status/coordination fields in its manifest.

| Option | Default | Effect |
| --- | --- | --- |
| `--startup-mode` | `simultaneous` | `planner-first` gates initial model calls behind a planning turn. |
| `--completion-policy` | `any-agent` | `all-agents-done` requires the surviving quorum and final checks. |
| `--planner-seed` | Fresh cryptographic random seed per run | Optional reproducibility seed; recorded with every selection. |

The switches are independent. For the requested experimental condition enable
both. `planner-first` alone retains the original completion triggers. Reusing a
seed with an identical ordered roster repeats the selection; omit it for fresh
randomization. Selection is uniform over **agents**, not model families: a
1-Astra/3-Luna roster gives Astra a 1/4 chance of being planner.

## Startup and completion protocol

1. All containers join the room and obtain member IDs. Only the randomly selected
   planner receives a model call. Its prompt contains the task and full roster,
   including names and models, and requests explicit ownership, dependencies and
   verification responsibilities for every active member.
2. The planner publishes a plan, then a separate exact `PLAN_READY` message, and
   ends its turn. The runner requires a preceding nonempty planner message and a
   successful planning turn before releasing the workers. Plan quality and actual
   assignment coverage are model responsibilities, not semantically certified by
   the runner. The planner also participates in subsequent task execution.
3. Each member publishes an exact `DONE` message, then ends its turn. It is
   temporarily paused, and may be reopened using the explicit protocol below.
   Substrings, outsiders' claims and planning-phase DONEs do not satisfy the quorum.
4. When all active members are DONE, every turn has exited, and room messages have
   drained, the runner executes **all** configured final checks. Every check must
   pass. Scheduled checks and single-member claims cannot finish this mode.
5. A failed final check clears all DONE votes and wakes every active member with
   the check output, including when `--quiet-checks` suppresses room feedback.

### Reopening temporarily completed members (version 0.1.12-planner-quorum.2)

An active member can send a standalone Room post:

```text
@codex-2 REOPEN verify-001: Verify the revised figure and correct its caption.
```

Use the exact case-sensitive roster name (e.g. `codex-2` or `claude-code-1`).
`REOPEN` is uppercase. The request ID is 1–64 ASCII letters/digits/dots/underscores/
hyphens, starts with a letter or digit, and is unique per sender for the entire
run. The `: ` separator and nonempty instruction are required. One post addresses
one recipient; use separate IDs/posts for multiple recipients. Reposting a sender's
ID, even with different text/recipient or after completion, is ignored. A different
sender may use the same ID independently. Receipt sequence replay is also ignored.

Only this explicit syntax reopens DONE; natural-language requests, broadcasts,
casual/embedded mentions, self-requests, outsiders, exited senders and exited
recipients do not. This interpretation is enabled only by `all-agents-done`.
The agent prompt documents the protocol on every turn.

Accepted requests invalidate the recipient's DONE immediately and are queued.
The runner never overlaps turns for one member. Requests arriving during a turn
are delivered in the next turn, even if that member reads them manually earlier;
that old turn's DONE cannot satisfy queued work. Multiple requests are delivered
together. Pending instructions remain available after turn failure or another
ordinary turn without DONE. After a successful turn and a new valid DONE, the
delivered requests are recorded as completed. Exit recovery still uses the random
replacement planner; requests cannot resurrect an exited member.

Final checks capture a coordination revision. Their results cannot close the room
until a subsequent Room poll drains messages posted during the checks. A new
accepted request invalidates these results, even if they passed; the requested
work must finish, DONE must be renewed, and fresh checks must run. Service outages
do not bypass the post-check drain; time/token bounds still take precedence.
This is a client-side barrier using the existing Room API, not a server-side
atomic compare-and-close operation: the completion decision is made at the last
successful post-check empty poll. No stronger service-level atomicity is claimed.

`coordination.ndjson` includes `request_queued`, `done_revoked`,
`agent_reawakened`, `request_completed`, `request_duplicate`, `request_ignored`,
`done_deferred` and `final_check_invalidated`. Request events carry sender and
recipient names/member IDs, request ID and source message sequence. Summaries
include the protocol, accepted-request count, coordination revision and each
agent's outstanding requests. A reawaken event is dispatch evidence; the following
turn completion/failure supplies execution evidence.

See `MIGRATION.md` for deployment and queue pinning. This fix does not change
Claude authentication or address `oauth_not_allowed_for_organization`.

Quorum mode requires at least one `check` trigger. Only `after`, `at`, `budget`,
`check`, and optional `said /^DONE$/` triggers are allowed. Other message/count/
idle triggers are rejected before room creation, because they could bypass the
completion barrier. The service still receives its usual check trigger when
closing the room; the detailed completion status is stored locally.

## Member failure and degraded completion

- A 429 inside a turn does not remove the member. The model CLI first uses its
  normal retries; if the entire harness turn fails, the runner retries that
  member (1-second and 2-second backoff before attempts 2 and 3).
- Three consecutive failed turns mark the member exited. The original configured
  roster remains in the record. Exits carry a reason, last exit code, whether
  rate-limiting was observed, and a relative trace reference. No replacement agent
  is silently added.
- All old DONE votes are cleared. In-flight turns drain, then a new planner is
  selected uniformly from survivors. It must publish a redistribution plan and
  `PLAN_READY` before survivors execute the next round. This also covers loss of
  the original planner. Other running agents are not killed to force replanning.
- Survivors must all finish again and pass the final checks. Such a run is
  `completed_degraded`. If everyone exits, the run is `failed`. Time/budget
  exhaustion is `timeout` / `budget_exhausted`, never degraded completion.
- Model CLI processes have the existing turn limit; experimental Claude turns
  also use the Linux `timeout` wrapper, like Codex. A container/setup/join failure
  before coordination initializes still aborts the entire startup.

This is a client-side scheduler and prompt protocol, not an access-control
boundary against an agent deliberately launching its own background processes.
Token limits retain upstream accounting: measured at completed turns, so an
in-flight turn can overshoot. No new fine-grained token cancellation is claimed.

## Evidence and status

Existing `episode.json`, room/wake/check logs, per-agent turns, homes and workspace
snapshots remain. Experimental runs additionally write:

- `coordination.ndjson`: timestamped selections, round changes, starts/exits,
  plan release, DONE votes, check failures and terminal status.
- `coordination.json`: terminal summary, fixed configured roster, active survivors,
  random seed and selection candidates, exits, counts and model compositions.
- `episode.json.status` and `.coordination`: the same completion provenance;
  also returned in CLI JSON for downstream queues.

`started_count` counts agents that attempted a model turn. `participating_count`
counts agents with at least one successful harness turn **or** nonzero reported
fresh tokens; it does not prove a useful contribution. `remaining_count` counts
survivors. `participating_models` and `remaining_models` distinguish their model
compositions. Per-agent original usage and trace records support deeper audits.
Defaults omit these additional episode fields.

The runner is not crash-resumable. Use a fresh record directory and room for each
attempt. On a handled runner error it writes a stopped coordination summary and
removes its containers; abrupt process termination may leave a partial journal.

## Local verification and packaging

Node >=22.18 is required. Runtime and tests use only Node standard libraries.

```bash
npm run check
npm test
npm pack --pack-destination artifacts
```

Tests cover the state machine, actual `runGoal`/`goalWatch` integration with fake
Docker and room APIs, early CLI validation, and default/exact-DONE regressions.
They do not certify a live Linux Docker deployment or real provider retries.
Before paid use, validate a controlled live room separately. Independent release
deployment and host/container offline validation are recorded in the release-root
`deployment.json`. Offline tests do not make paid model calls.

Primary changes: `dist/coordination.js` (scheduler), `dist/goal-run.js` (runner
wiring), `dist/goal.js` (quorum/check barrier), and `dist/cli.js` (optional flags).


### Local recovery fix: 0.1.12-planner-quorum.3

When a member exits after three failed turns, the optional coordinator invalidates
old DONE states, selects a surviving recovery planner uniformly, and posts a
runner notice naming the exited member. Old turns have 30 seconds to save and
return. This window starts at the first exit and is not extended by later exits.
At expiry, only still-busy seats are cancelled. The runner stops the seat's
container (5-second Docker grace), verifies it is stopped, and restarts the same
container, retaining home/session files and the shared workspace. Any loopback
forwarder is restored. No new planning/work turn starts until cancellation
operations AND old turn promises have settled. A failed stop/confirmation/restart
fails closed as a runner error instead of allowing overlapping turns.

Recovery cancellations are not model failures or successful contributions and do
not evict members. They are recorded in wakes.ndjson as cancelled_for_recovery,
and coordination.ndjson records recovery_started, recovery_turn_cancel_requested,
recovery_turn_cancel_confirmed, turn_cancelled_for_recovery and failure events.
Outstanding REOPEN requests survive; exited members remain exited. All survivors
must finish again after PLAN_READY. Successful recovery is completed_degraded;
original roster/model provenance and the original time/token bounds remain.
Forced cancellation can interrupt file writes, so recovery planning must inspect
existing artifacts and revalidate them; there is no rollback or snapshot restore.
The notice is advisory, not a guarantee an in-flight model reads it immediately.
Default legacy mode is unchanged. This version was deployed independently and exercised in Earth_001 experiments; it does not change the repository default CLI.


## Upstream review boundary

This directory preserves the independently tested 0.1.12 JavaScript experimental client, version 0.1.12-planner-quorum.3. It is outside the pnpm workspace and is not an npm release. The maintained TypeScript CLI in packages/cli remains unchanged. Use `node experiments/planner-quorum-client/bin/sharednet.js` explicitly from the repository root. This snapshot is intended for mechanism review and experiment reproduction; integration into the current TypeScript CLI is separate work.
