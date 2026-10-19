# Prometheus local v1 design

**Status:** Approved for implementation

**Date:** 2026-10-18

## Purpose

Prometheus local v1 adds a top-level `sharednet prometheus` workflow for one
long-lived local Codex team. It gives one workspace three stable roles, reuses
their Codex homes, threads, and production `sharednet serve` listeners across
runs, and gives every run a fresh compiled Goal Room.

The command is an opinionated local product path. It is separate from Goal
mode's research harnesses. It does not change any frozen `research/*@1` mode or
claim either reserved `runtime/*@1` mode.

## Command surface

Local v1 exposes four actions:

```sh
sharednet prometheus run GOAL.md \
  --model <codex-model> \
  --check '<semantic check command>' \
  --timeout 2h

sharednet prometheus status
sharednet prometheus resume
sharednet prometheus cancel
```

The ordinary global `--session` and `--json` options continue to work. `run`,
`status`, `resume`, and `cancel` accept `--workspace`; it defaults to the
current directory. The workspace's real path identifies its one local team.

The first `run` creates the team. `--model` applies to all three roles and is
recorded with the team. Later runs must name the same model; changing the model
or rebuilding the team is outside v1. `--check` and `--timeout` are required on
every new run. The timeout is a hard bound between one minute and 24 hours and
is stored as an absolute deadline, so `resume` cannot reset it.

`run` refuses when that workspace already has an active run and points to
`status`, `resume`, and `cancel`. `resume` takes over an active run whose prior
monitor is gone. It does not create a Room, join another seat, make a new Codex
thread, repost the goal, or extend the deadline. `cancel` is idempotent and may
be issued from a second terminal while a monitor is running.

There is no local-v1 command to add a fourth role, replace a role, discover
other teams, or operate a team on another machine.

## Workspace contract

`PROMETHEUS.md` is required at the workspace root before any Docker or network
work. It is UTF-8, no larger than 64 KiB, and must contain these level-two
headings exactly once, in this order, with non-empty content:

```markdown
## Motto

## Rules

## Preferences

## Handoff

## Completion
```

Other prose and headings are allowed. A heading inside a fenced code block is
not a section. The parser rejects missing, duplicated, reordered, or
case-changed required headings. A run records the SHA-256 of the exact file
bytes and gives the complete current file to every role. A later run may use a
changed `PROMETHEUS.md`; the persistent threads are told that the new hash and
content supersede the earlier run's policy.

`GOAL.md` remains the run-specific objective. It must not address `@all`, a
role name, or a remembered member id. The Goal line is deliberately
unaddressed. The runner's later kickoff is the only initial wake.

## Fixed team

Every workspace has exactly these roles:

| Role | Stable seat name | Responsibility |
| --- | --- | --- |
| Coordinator | `coordinator` | Decompose the goal, issue typed work, route exact handoffs, resolve the final work, and synthesize the result. |
| Builder | `builder` | Accept the typed work, change the shared workspace, upload exactly one workspace-rooted tar artifact named `submission`, and report its result reference and digest. |
| Reviewer | `reviewer` | Independently download and inspect the exact submitted artifact, upload review evidence, and issue `verification.pass` for the current result. |

All three roles use Codex in v1. One model is shared by the team. The number of
roles, role names, drivers, and topology are constants rather than flags.

Each role owns a stable Docker container and persistent Docker volume. Its
volume holds its Codex home, thread, SharedNet seat files, checkpoints, and
listener logs. The host's existing Codex login is mounted read-only; it is not
copied into Prometheus state. Each role has its own SharedNet storage root, so
its seat credentials and cursor cannot be selected by another role.

The initial bootstrap turn creates one Codex thread per role and returns
`READY`; it does no Goal work. One production `sharednet serve` process then
runs for that role without a `--rooms` filter. The listener persists after a
run and discovers the role's seat in each later Room. If a container or
listener stopped, the next action may restart it around the same persistent
home and thread. It must never silently replace a missing thread with a new
one.

## One fresh compiled Room per run

A new run proceeds in this order:

1. Validate all arguments, `PROMETHEUS.md`, `GOAL.md`, owner credentials,
   Docker, the saved team, and the absence of an active run.
2. Atomically reserve the active-run slot in local state.
3. Ensure the three persistent containers, threads, and listeners are healthy.
4. Create a new Room with `type: "compiled"` and a Goal whose only server end
   condition is the stored hard timeout.
5. Join the three existing threads as fresh `coordinator`, `builder`, and
   `reviewer` seats. Bind their existing threads and let their existing
   listeners discover the new seats.
6. Wait until all three exact Room seats report `listening` under
   `wake-plugins-v1`.
7. Post one runner message addressed only to the coordinator's exact member id.

The kickoff contains the run id, Goal sequence, exact member-id roster,
`PROMETHEUS.md` content and hash, the typed-work recipe, the terminal-receipt
format, the semantic-check description, and the absolute deadline. No kickoff
uses `@all` or an addressable name. Every inter-role request, answer, correction,
and handoff uses one exact `@<member_id>` supplied by that run's roster.

The coordinator creates a run-scoped compiled work item addressed to the
builder. It requires a deliverable named `submission` and a `verified_by`
requirement naming the reviewer member id. The builder accepts it and publishes
`work.result` with the uploaded artifact. The reviewer downloads the artifact,
checks the returned SHA-256, uploads a review report, and publishes
`verification.pass` with the current `result_ref` and report artifact id. The
coordinator then publishes `work.resolve`.

Compiled work cannot replace a result in place. If review or the semantic check
finds a defect, the coordinator creates a successor work item using
`supersedes`; the old item remains terminal evidence. A candidate is the unique
unsuperseded head of this chain.

## Terminal receipts

Chat remains nonbinding, including the word `DONE`. A role declares that it has
finished with a single-line structured message:

```text
[sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"<run-id>","role":"builder","revision_sha256":"<64 lowercase hex>"}
```

The three allowed role values are `coordinator`, `builder`, and `reviewer`.
The runner accepts a receipt only when:

- the Room message sender is that run's saved member id for the claimed role;
- the JSON has exactly the v1 fields and values shown above;
- `run_id` is the active run;
- `revision_sha256` is the runner's current candidate revision.

A malformed line, a forged role field, an old run id, a stale revision, free
text such as `DONE`, or a model's ordinary final response has no completion
effect. After the coordinator resolves the final head, it directly asks the
builder and reviewer for terminal receipts, then posts its own. A change to
compiled state creates a different candidate revision and makes all older
receipts stale.

## Candidate revision

The client keeps its protocol parsing independent of the hosted service source.
It validates the public compiled-state wire object returned by
`GET /rooms/<room>/state` and fails closed on an unknown or malformed shape.

For the unique head work item, the client finds the canonical `work.result`
event whose event hash equals `projection.work[work_id].result`. It requires an
artifact id for every declared deliverable and a matching
`refs.artifact_receipts[artifact_id]` object with that id and a 64-character
SHA-256. It also finds, for every `verify` requirement on the head, an accepted
`verification.pass` event that:

- was authored by the saved reviewer member id;
- names that work item and requirement;
- names the head's exact current `result_ref`;
- carries a review-evidence artifact receipt with an exact SHA-256; and
- corresponds to a requirement whose projected status is `satisfied`.

The compiled protocol's `result_ref` is the canonical result-event hash. That
event contains the artifact ids and the service-attested artifact receipts, so
the review is transitively tied to the exact delivered hashes rather than a
filename or a mutable workspace path.

The runner computes `revision_sha256` as SHA-256 over canonical JSON containing:

- compiled state digest;
- head work id and `result_ref`;
- sorted deliverable name, artifact id, and artifact SHA-256 triples; and
- sorted verification event hash, requirement id, evidence artifact id, and
  evidence SHA-256 tuples.

All non-head work must be terminal. The head must be `RESOLVED`, have at least
one deliverable, and have every requirement satisfied. `OPEN`, `COMMITTED`, or
`REVIEW` work anywhere in the run keeps the barrier closed. A rejected,
cancelled, declined, or expired head is not success.

## Completion barrier

Prometheus never passes `said: DONE` to Goal mode and never scans raw chat for
completion. It closes a run successfully only after one candidate satisfies
all of these conditions in order:

1. Compiled state has one resolved head, no nonterminal work, complete artifact
   receipts, and reviewer-authored verification bound to the exact current
   result.
2. Coordinator, builder, and reviewer each have an authenticated terminal
   receipt for the computed candidate revision.
3. Each active-room seat is `listening`; none is `starting`, `working`,
   `retrying`, or `stopped` in `sharednet serve --status --json`.
4. `sharednet handed --json` reports no unsettled handoff for any of the three
   active-room seats.
5. The user-supplied semantic check has passed for this revision.
6. A post-check read returns the same compiled digest and candidate revision,
   the same three receipts, and the same idle/no-handoff state.

Local v1 accepts exactly one deliverable named `submission`, encoded as a tar
archive rooted at the workspace to check. The runner downloads that exact
artifact and verifies its bytes against the compiled artifact receipt. It announces the candidate
revision and the deterministic artifact-snapshot digest so each role has an
actionable receipt value. The semantic check runs only after conditions 1
through 4 hold. It runs in a fresh, network-disabled checker container with a
read-only root: the tar is mounted read-only and extracted into disposable
`/workspace` tmpfs, while a separate writable `/tmp` tmpfs supports ordinary
test and build tools. The snapshot manifest remains in the read-only
`/prometheus-input` mount. The mutable shared workspace is never mounted. The
checker receives these non-secret environment variables:

```text
SHAREDNET_PROMETHEUS_RUN_ID
SHAREDNET_PROMETHEUS_WORK_ID
SHAREDNET_PROMETHEUS_RESULT_REF
SHAREDNET_PROMETHEUS_REVISION_SHA256
SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256
```

The run record stores its start and finish times, exit code, bounded output,
output SHA-256, candidate revision, and artifact-snapshot SHA-256. A nonzero check blocks that exact
revision and produces one bounded, exact-`@coordinator` feedback message. It is
not retried until compiled work produces a different revision. A passing check
is discarded if the post-check read sees a different revision or any new
working/unsettled turn.

This barrier proves a coherent terminal snapshot. It does not claim that a
model understood every Room message or that the semantic check is sufficient
for every project.

## Local state and concurrency

The workspace key is the first 24 hex characters of SHA-256 over the
workspace's real absolute path. Non-secret Prometheus metadata lives at:

```text
$XDG_STATE_HOME/sharednet/prometheus/local-v1/<workspace-key>/
  team.json
  active.json
  lock.json
  runs/<run-id>/run.json
  runs/<run-id>/events.ndjson
  runs/<run-id>/checks.ndjson
```

On systems without `XDG_STATE_HOME`, the existing SharedNet default
`~/.local/state/sharednet` applies. Directories are mode `0700`, files are mode
`0600`, writes are atomic, and reads reject symlinks, non-owner files, and
group/other permissions. The short-held state lock records a random lock id,
PID, and OS process start identity; PID reuse cannot authorize stale-lock
recovery.

`team.json` stores schema version, workspace path/key, fixed model, stable
container and volume names, three thread ids, policy hash last seen, and
timestamps. `run.json` stores the run configuration, Room id, role member ids,
absolute deadline, monitor lease, outcome, candidate, and check summaries.
`active.json` contains only the active run id and monitor identity. None of
these files stores a SharedNet API key, instance token, member token, invite,
Codex token, or copied `auth.json`.

Existing credential owners remain responsible for credentials: the host CLI
reads its ordinary owner-only SharedNet credential/session files, the invite is
passed only to each `join` process, each role's ordinary seat credential stays
inside that role's persistent home, and Codex reads the host login through a
read-only mount. Logs redact known capability formats and never serialize
process environments or Docker arguments containing a secret. Agent-generated
Room or tool content is still sensitive and the entire state root should be
treated as private.

Only state mutation holds the short lock. A monitor owns a renewable lease in
`active.json`, so `status` can read and `cancel` can set `cancel_requested`
without waiting for a long-running process. A second `run` always loses the
atomic active-slot race. `resume` may replace a monitor lease only after the
recorded process identity is no longer alive.

## Outcomes and recovery

A run has one of these persisted states:

| State | Meaning |
| --- | --- |
| `starting` | The active slot is reserved and the fresh Room/team seats are being prepared. |
| `running` | The kickoff was posted and the completion monitor is active or resumable. |
| `succeeded` | The full completion barrier passed and the Room was closed with the candidate revision. |
| `timed_out` | The original absolute deadline arrived before success. |
| `cancelled` | An explicit `prometheus cancel` closed the Room. |
| `failed` | Startup, protocol, checker, listener, or Room state made safe continuation impossible. |

`succeeded`, `timed_out`, `cancelled`, and `failed` are terminal. The terminal
record includes `finished_at` and a bounded reason. Clearing `active.json` is
the last state transition; a crash before that is repaired idempotently by
`status` or the next command.

SIGINT, SIGTERM, loss of the terminal, or a monitor crash does not cancel a
run, remove the team containers, close the Room, or clear the active slot. The
monitor lease becomes stale and `resume` continues from `run.json`, the Room,
compiled state, listener status, and handed records. Startup is step-recorded,
so resume can distinguish a Room that was never created, a Room created before
seats joined, and a kickoff already committed; it never repeats a committed
external write with a new idempotency key.

Timeout and cancel attempt to close the Room, write the terminal record, and
leave the persistent team healthy for its next fresh Room. An unexpected Room
closure is `failed` unless its recorded close trigger is the stored timeout or
cancel request. Semantic-check failure alone is not `failed`; it blocks the
candidate and lets the team create a successor until timeout or cancellation.

## PR 48 and existing modes

PR 48 (`feat/serve-goal-demo`) is rebased onto the current client before the
Prometheus work. Its reviewed real-listener ordering, exact-member kickoff,
Codex bootstrap, checker container, auth boundary, and fake-Docker tests become
the starting point. The implementation then extracts reusable runtime helpers
instead of copying the 519-line runner.

`goal serve-demo` keeps its one-run experimental behavior and cleanup contract.
Prometheus uses stable role containers, all-room listeners, durable state, and
resume semantics through the extracted layer. Refactoring must preserve the PR
48 tests before adding Prometheus behavior.

The following compatibility constraints are absolute:

- The six `research/{baseline,mentions,tasks,both,routing-only,receipt-only}@1`
  specs, profiles, hashes, and behavior do not change.
- `runtime/serve-first@1` and `runtime/serve-all@1` remain reserved and
  unavailable through `goal run --harness-mode`. Prometheus does not execute or
  report either mode.
- Immutable registry provenance, including the reviewed PR 48 dependency head,
  is not rewritten to describe Prometheus.
- The mutable catalog text may say that PR 48 code is present while the two
  runtime modes remain unwired; it must not present them as runnable.
- Existing `goal run`, `goal serve-demo`, `serve`, compiled Room commands, and
  credential paths retain their public behavior.

## Deferred work

Local v1 deliberately defers:

- a Prometheus Cloud control plane or hosted durable runner;
- global team discovery, team listing, naming, sharing, or marketplace flows;
- cross-machine role placement, synchronization, or failover;
- variable team size, custom roles, non-Codex drivers, or per-role models;
- simultaneous runs for one team or scheduling/queuing multiple goals;
- automatic team reset, model migration, container-volume garbage collection,
  or import/export of a team;
- making either reserved `runtime/*@1` harness mode available; and
- a server-owned scheduler beyond the minimal replay-safe write and
  conditional-close contract required by local v1.

Those features require their own versioned design. Local v1 implements and
locally verifies the fixed three-role lifecycle and completion barrier. It is
not production-runnable until the coordinated server write/CAS contract and a
no-model hosted smoke test pass.
