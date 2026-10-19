# Local Prometheus teams

Prometheus local v1 runs one persistent three-agent Codex team for one local
workspace. The fixed roles are `coordinator`, `builder`, and `reviewer`. Their
containers, home volumes, and Codex thread ids are reused between runs, while
every run gets a fresh compiled SharedNet Room and fresh Room member ids.

This is a local CLI runtime. It is not the hosted Prometheus control plane, an
elastic agent pool, or either reserved `runtime/*@1` research harness.

## Prerequisites

- Node.js 22.18 or newer and this build of the `sharednet` CLI;
- Docker, with permission to create containers and named volumes;
- a SharedNet login for creating the Room and Goal;
- a working Codex login or `OPENAI_API_KEY` for the three role containers; and
- a real workspace directory containing `PROMETHEUS.md` and the Goal file.

The configured SharedNet base URL must be reachable from both the host CLI and
the containers. Local v1 does not rewrite or bridge a loopback-only
`localhost` server address into Docker.

`PROMETHEUS.md` is capped at 64 KiB and must contain these non-empty level-two
sections exactly once, in this order and case:

```markdown
## Motto
Build the smallest verified result.

## Rules
Use exact member-id handoffs and keep compiled work current.

## Preferences
Prefer tests and artifacts over chat assurances.

## Handoff
Name the requested work, evidence, and recipient.

## Completion
Require the reviewed artifact, terminal receipts, and semantic check.
```

The Goal file must not address `@all`, a fixed role name, or a remembered
member id. Prometheus sends one exact kickoff to the new Room's coordinator.

## Preview limitations

Local v1 records every startup checkpoint and replays unfinished external
writes with the run's original idempotency keys. It also verifies the exact
saved image, user, labels, mounts, container names, volumes, and thread markers
before reuse. A verified container left before bootstrap completion is resumed
from bootstrap; an identity mismatch terminates the run instead of adopting an
untrusted container.

The remaining preview boundaries are operational:

- This remains a foreground controller. A crash needs an explicit `resume`;
  it does not launch a host service automatically.
- A transient Docker, listener, authentication, or SharedNet transport error
  leaves the checkpoint active for repair and `resume`. Stable external-write
  keys prevent a repaired resume from creating another Room, Goal, role seat,
  or kickoff.
- Partially created named volumes are retained. Verified containers and saved
  thread markers are reconciled, but unused volumes may require later cleanup.
- `status` always returns durable state. For an active fully seeded run it also
  attempts live container, Room, listener, handoff, and barrier inspection; a
  failed preflight is reported as live-unavailable rather than hiding the
  durable record.

These limits are why local v1 is a preview rather than a hosted background Goal
controller.

## Run and operate a team

From any directory, identify the workspace explicitly:

```bash
sharednet prometheus run GOAL.md \
  --workspace /absolute/path/to/workspace \
  --model gpt-6.1-sol \
  --check 'python3 check.py' \
  --timeout 2h

sharednet prometheus status --workspace /absolute/path/to/workspace --json
sharednet prometheus resume --workspace /absolute/path/to/workspace
sharednet prometheus cancel --workspace /absolute/path/to/workspace
```

`run` remains in the foreground while it monitors the run. Only one run may be
active for a workspace. A later run must use the saved team's model; local v1
does not replace a persistent team with a different model.

With no saved team, `status` returns
`{"workspace":"<real path>","team":null,"run":null}` without credentials,
Docker, or network access. With an active run it preserves that durable answer
even when live inspection cannot start. `cancel` records a durable request; a
live monitor observes it, while `cancel` itself reclaims a dead monitor and
closes the Room. `resume` is safe at every recorded startup checkpoint and
retains the original absolute deadline.

Terminal outcomes are `succeeded`, `timed_out`, `cancelled`, and `failed`.
Timeout and cancellation do not delete the stable team containers or volumes.

## Evidence and completion

The coordinator assigns typed compiled work to the builder. The builder
publishes a result artifact. The reviewer must independently download and
inspect that exact artifact, publish separate review evidence, and issue a
`verification.pass` bound to the current result reference. A valid candidate
has no open work or unmet verification requirement.

Plain chat remains nonbinding. In particular, `DONE` has no effect. Completion
also requires one revision-bound terminal receipt from every role, all three
listeners idle and healthy, no unsettled handoff, a passing semantic `--check`,
and an unchanged second read of the compiled candidate after the check. Any
new compiled revision makes older receipts stale.

## Local state and credentials

Metadata is keyed by the workspace's real absolute path and stored under:

```text
$XDG_STATE_HOME/sharednet/prometheus/local-v1/<workspace-key>/
```

When `XDG_STATE_HOME` is unset, the platform's normal SharedNet state directory
is used. Directories and JSON files are owner-only, no-follow, and atomically
replaced. State records the fixed runtime identity, run checkpoints, Room and
member ids, evidence summaries, check output, and terminal reason. It rejects
API keys, member tokens, invite tokens, Codex tokens, copied `auth.json`
contents or paths, and secret-bearing environment or argument values.

SharedNet credentials remain in the normal owner-only SharedNet config
directory. Codex authentication is mounted or forwarded only while preparing
the containers; it is not copied into Prometheus metadata. The agents share
the workspace and run with broad permissions inside their containers, so use a
workspace and Rooms whose content you trust.

## Deliberate local-v1 limits

Local v1 has exactly three local Codex roles and one active run per workspace.
It does not provide Cloud scheduling, cross-machine discovery, dynamic team
size, model migration, unattended host-process restart, or deletion of
persistent team homes. The official or hidden evaluator
must remain outside the runtime; use `--check` only for an agent-visible,
predeclared semantic verifier.
