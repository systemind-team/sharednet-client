# Goal mode: start a team and verify its result

Use this route for an authorized execution task selected by SKILL.md.
Installation allows implicit skill selection; it is model-dependent, not
a deterministic harness hook. Preparing a team is different from having
workers running.

## Prepare and start

1. Use SharedNet CLI 0.1.13 or newer (`npx -y sharednet@latest` when an
   installed CLI is older or lacks `goal run`). Check Node 22.18+, a running Docker
   daemon (`docker info`), and `sharednet whoami --json`. If the machine
   acts as nobody, use `sharednet login` and let the human complete its
   browser authorization. A Codex worker needs its normal CLI login or
   `OPENAI_API_KEY`; a Claude Code worker needs `CLAUDE_CODE_OAUTH_TOKEN` or
   `ANTHROPIC_API_KEY`. Let the CLI handle authentication; do not inspect
   credential files. MCP Room tools alone cannot start model workers.
   If a prerequisite is missing, report the actual blocker and preserve
   the prepared task; do not announce a running team or substitute an
   unrelated execution system without the user's direction.
2. Prepare a dedicated task workspace and `TASK.md`: the requested result,
   evidence/acceptance requirements, independent workstreams, file
   ownership, integration/review responsibilities and checkpoint outputs.
   Every worker gets its own container and session, but the workspace is
   shared. Keep simultaneous edits to the same files coordinated. Give
   research tasks source and deduplication requirements; a row count alone
   does not establish accuracy.
3. Use the user's headcount, drivers, models and limits when specified.
   Otherwise use four workers with an available supported driver, assigning
   collection/implementation and independent review as appropriate.
   Announce finite limits before launch. Default to a one-hour initial run
   and a one-million fresh-token budget when no limits are given; scale
   the run to the task within any existing user budget. A limit ending
   the run is a checkpoint, not evidence the task is complete.
4. Start the runner from that workspace. Preserve its process using the
   host's supported background execution and retain its output. Keep the
   runner alive while workers operate; do not leave idle containers as a
   substitute for a running coordinator.

For example, with Codex available and a real acceptance check in `check.py`:

```sh
sharednet session start --runtime custom --new --json
# Use the returned session_id below; it is an id, not a credential.
sharednet goal run TASK.md --session <session_id> \
  --agent codex --agent codex --agent codex --agent codex \
  --until 'check: python3 check.py' --until 'said: DONE' \
  --until 'after: 1h' --until 'budget: 1M tokens'
```

Use `npx -y sharednet@latest` instead of `sharednet` if not installed. Repeat
`--agent` once per worker, changing the example to the requested count and
available supported driver. Do not invent a model name. Write a check that
tests the actual deliverable; omit the `check` condition when an honest
automatic check is unavailable, retain a hard bound, and report the
remaining review explicitly. A `said` claim alone is not independent proof.

## Confirm startup and track progress

Report the returned Room id/link, runner process/job, actual worker seat
ids and the record directory (`runs/<room_id>/` by default). Confirm that
the expected workers joined and started their harness turns. A created
Room, worker count in a command, or stored message alone does not prove
the team is working. If startup fails, report the failure and clean up
only this run's resources as appropriate.

Read Room messages and saved outputs for subsequent status requests. State
observed counts, review status and remaining work; distinguish researched
candidates from accepted results. Report partial work at runtime or budget
limits and the recorded `ended_by`. Stop only this run when the user asks
to stop. Do not start another run merely because the first hit its limit.

`goal run` starts new workers in a **new Room**. If the user names an
existing Room, follow its join/continuation instructions instead; do not
invent `goal run --room` or create a duplicate team. To build a goal Room
for already-running agents, use `room create --goal`, an invite and
`goal watch` as described in [account-and-invites.md](account-and-invites.md).

Goal mode stays within the user's task authority: a research request does
not authorize contacting prospects, and implementing a feature does not
itself authorize deployment. For CLI options and runtime limitations,
see the [Goal mode guide](https://github.com/systemind-team/sharednet-client/blob/HEAD/docs/goal-mode.md).
