# Goal policy ablation runbook

This procedure compares two initiation policies and two termination policies.
It does not test an attention scheduler. It does not show a scheduler gain.

Use this procedure in three stages:

1. Run the no-model smoke test.
2. Run one bounded live pilot.
3. Freeze the protocol and run the formal experiment.

Do not use official hidden grader feedback during a run. Run the official
hidden grader one time after you freeze each result.

## 1. Define the four arms

Use the same number of agents in all arms. The examples use three agents.

| Arm | Initiation policy | Termination policy | Policy seed |
| --- | --- | --- | --- |
| `all-first` | `all` | `first` | none |
| `random-first` | `random-single` | `first` | required |
| `all-all` | `all` | `all-agents` | none |
| `random-all` | `random-single` | `all-agents` | required |

The `all` policy starts all agents. Do not give `--policy-seed` to this
policy.

The `random-single` policy starts one agent. Give it a recorded
`--policy-seed`. The seed must be an integer from 0 through 4294967295. Use the
same seed for `random-first` and `random-all` in one task and repeat. This rule
keeps the selected starter constant across the two termination policies.

The `first` policy keeps the legacy stop rule. A scheduled semantic verifier
that starts to pass can close the Room before an agent says `DONE`. Otherwise,
the first valid completion claim runs the verifier and can close the Room.

The `all-agents` policy does not close on a scheduled verifier pass. It waits
for one valid completion claim from each agent. It then runs a new semantic
check. Thus, this termination contrast includes both the completion quorum and
the scheduled-check rule. Report it as a bundled termination-policy contrast.
Do not combine `all-agents` with a `message` or `mention` end condition. The
CLI rejects these conditions because they can bypass the completion quorum.

Use the exact completion trigger `--until 'said /^DONE$/'`. Do not use a
substring trigger.

Do not combine these flags with `--harness-mode`. The published `@1` harness
modes have frozen initiation and termination rules. Use the explicit Room and
routing flags in this document.

## 2. Freeze the controls

Write the values below in the preregistration before a live run. Keep the
values equal in all four arms. Give an exact value for each control. Do not use
a range.

| Control | Required value or rule |
| --- | --- |
| Task | One frozen task snapshot and one SHA-256 |
| Agent count | `N=3` |
| Driver and model | Three copies of `codex:gpt-6.1-sol` |
| Reasoning effort | One pinned value in the agent image; verify it in the raw trace |
| Agent image | One immutable image digest, in `name@sha256:...` form |
| Room type | `board` |
| Message routing | `mentions` |
| Web search | `off` |
| Semantic verifier | `./experiment/semantic-verifier.sh` |
| Check interval | `1m` |
| Fresh-token stopping threshold | Soft team threshold of `400k tokens` |
| Wall-time bound | `45m` |
| Turn-time bound | `45m` |
| CPU | One preregistered worker quota; use the same quota in all arms |
| Memory | One preregistered worker limit; use the same limit in all arms |
| Reference queries | One exact limit; enforce it in `./experiment/reference-query` |

The SharedNet CLI records the task, model, image, routing, token threshold, and
time bounds. The CLI does not set the host CPU quota, the host memory limit,
the model reasoning effort, or the reference-query limit. The experiment
worker and the task fixture must enforce these four controls.

The token threshold is not a strict allocation. The runner reads token use
after a turn ends. Concurrent turns can take the total above 400k before the
runner stops the team. This overshoot can differ between initiation policies.
Preregister an overshoot rule. Report the actual token total and the amount
above the threshold for every run. If the experiment requires a strict fixed
token budget, enforce it outside the current runner at each model call.

Do not start a formal run if the worker cannot show its CPU quota and memory
limit. Do not start a formal run if the image cannot show the pinned reasoning
effort. Do not start a formal run if the reference wrapper cannot count and
limit queries. The wrapper must append one record for each query to
`./experiment/reference-queries.ndjson`. It must read its limit from
`./experiment/reference-query-limit`. It must refuse a query after that limit.
Do not expose an unmetered path to the reference program. Save this evidence
with the run.

Use a semantic verifier that checks the delivered behavior. Do not use only a
compile check or a file-existence check. Freeze the verifier before the pilot.
Give the same agent-visible verifier to every arm.

## 3. Prepare one task cell

Set these values for one task and one repeat. Use a new `RUN_ROOT` for each
experiment batch.

```bash
set -eu
export TASK_ID='doxygen__doxygen.966d98e'
export REPEAT='01'
export POLICY_SEED='21001'
export ORDER_SEED='91001'
export IMAGE_DIGEST='sharednet-goal-agents@sha256:REPLACE_WITH_VERIFIED_DIGEST'
export FIXTURE='/absolute/path/to/frozen-task-fixture'
export RUN_ROOT='/absolute/path/to/results/goal-policy-v1'
export WORK_ROOT='/absolute/path/to/workspaces/goal-policy-v1'
export CLI_REPO='/absolute/path/to/sharednet-client'
export CLI_TARBALL='/absolute/path/to/sharednet-VERSION.tgz'
export WORKER_CONTROL_EVIDENCE='/absolute/path/to/worker-control-evidence.txt'
export REASONING_EFFORT='high'
export CPU_QUOTA='1.35'
export MEMORY_LIMIT_MIB='5120'
export REFERENCE_QUERY_LIMIT='100'
export SHAREDNET_BIN="$RUN_ROOT/$TASK_ID/r$REPEAT/cli/bin/sharednet.js"
```

Replace the image value before you continue. Use an immutable digest. Do not
use a mutable tag. The numeric values above are the example protocol. Change a
value only before you freeze the preregistration.

Create the cell record. The worker-control file must show the enforced CPU and
memory values. The task fixture must use the recorded reference-query limit.

```bash
set -eu
CELL="$RUN_ROOT/$TASK_ID/r$REPEAT"
if [ -e "$CELL" ]; then
  echo "Refuse existing result cell: $CELL" >&2
  exit 1
fi
mkdir -p "$CELL/frozen-inputs" "$CELL/commands"

test -f "$FIXTURE/workspace/TASK.md"
test -x "$FIXTURE/workspace/experiment/semantic-verifier.sh"
test -x "$FIXTURE/workspace/experiment/reference-query"
test -f "$FIXTURE/workspace/experiment/reference-queries.ndjson"
test -s "$CLI_TARBALL"
test -s "$WORKER_CONTROL_EVIDENCE"
test -z "$(git -C "$CLI_REPO" status --porcelain)"

cp "$FIXTURE/workspace/TASK.md" "$CELL/frozen-inputs/TASK.md"
cp "$FIXTURE/workspace/experiment/semantic-verifier.sh" \
  "$CELL/frozen-inputs/semantic-verifier.sh"
cp "$FIXTURE/workspace/experiment/reference-query" \
  "$CELL/frozen-inputs/reference-query"
cp "$WORKER_CONTROL_EVIDENCE" "$CELL/worker-control-evidence.txt"
docker image inspect "$IMAGE_DIGEST" > "$CELL/image-inspect.json"
git -C "$CLI_REPO" rev-parse HEAD > "$CELL/client-commit.txt"
sha256sum "$CLI_TARBALL" > "$CELL/cli-tarball.sha256"
mkdir -p "$CELL/cli"
tar -xzf "$CLI_TARBALL" -C "$CELL/cli" --strip-components=1
node "$SHAREDNET_BIN" --version > "$CELL/cli-version.txt"

# Bind every arm to one explicit owner Instance. A machine can have several
# usable local Instances, in which case implicit selection is intentionally
# rejected. Keep the full session response in memory because it may contain a
# credential; record only the non-secret Instance id.
session_json=$(node "$SHAREDNET_BIN" session start --runtime custom --new --json \
  2> "$CELL/private-session-start.log")
SESSION_ID=$(printf '%s' "$session_json" | \
  python3 -c 'import json,re,sys; value=json.load(sys.stdin)["session_id"]; assert re.fullmatch(r"i_[A-Za-z0-9_-]+", value); print(value)')
unset session_json
export SESSION_ID
printf '%s\n' "$SESSION_ID" > "$CELL/session-id.txt"
chmod 0600 "$CELL/private-session-start.log" "$CELL/session-id.txt"
(cd "$FIXTURE/workspace" && \
  find . -type f -print0 | sort -z | xargs -0 sha256sum) \
  > "$CELL/fixture-files.sha256"

python3 - <<'PY' > "$CELL/controls.json"
import json
import os
import re

image = os.environ["IMAGE_DIGEST"]
if re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", image) is None:
    raise SystemExit("IMAGE_DIGEST is not an immutable SHA-256 digest")

controls = {
    "task_id": os.environ["TASK_ID"],
    "repeat": os.environ["REPEAT"],
    "agent_count": 3,
    "driver_model": "codex:gpt-6.1-sol",
    "reasoning_effort": os.environ["REASONING_EFFORT"],
    "image": image,
    "room_type": "board",
    "message_routing": "mentions",
    "web_search": "off",
    "semantic_verifier": "./experiment/semantic-verifier.sh",
    "check_interval_s": 60,
    "fresh_token_soft_threshold": 400000,
    "wall_time_s": 2700,
    "turn_time_s": 2700,
    "cpu_quota": os.environ["CPU_QUOTA"],
    "memory_limit_mib": int(os.environ["MEMORY_LIMIT_MIB"]),
    "reference_query_limit": int(os.environ["REFERENCE_QUERY_LIMIT"]),
    "policy_seed": int(os.environ["POLICY_SEED"]),
    "order_seed": int(os.environ["ORDER_SEED"]),
}
print(json.dumps(controls, indent=2, sort_keys=True))
PY
```

Make four independent workspace copies. Do not let two arms use the same
writable workspace.

```bash
set -eu
for ARM in all-first random-first all-all random-all; do
  DEST="$WORK_ROOT/$TASK_ID/r$REPEAT/$ARM"
  if [ -e "$DEST" ]; then
    echo "Refuse existing workspace: $DEST" >&2
    exit 1
  fi
  mkdir -p "$DEST"
  cp -a "$FIXTURE/workspace/." "$DEST/"
  printf '%s\n' "$REFERENCE_QUERY_LIMIT" \
    > "$DEST/experiment/reference-query-limit"
  (cd "$DEST" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$CELL/$ARM-input-files.sha256"
done
```

Record the task and workspace digests. Record the CLI commit and package
tarball digest. Record the worker CPU quota, memory limit, model reasoning
effort, and reference-query limit in `controls.json`.

Randomize the arm order. Use an order seed that is different from the policy
seed.

```bash
set -eu
python3 - "$ORDER_SEED" <<'PY' > "$CELL/arm-order.txt"
import random
import sys

arms = ["all-first", "random-first", "all-all", "random-all"]
random.Random(int(sys.argv[1])).shuffle(arms)
print("\n".join(arms))
PY
cat "$CELL/arm-order.txt"
```

Run the arms in the saved order. Do not select the order after you see a
result.

## 4. Run the no-model smoke test

Run the client tests first. These tests use a fake service and fake Docker.
They do not start a model.

```bash
set -eu
pnpm exec vitest run \
  packages/cli/src/goal-run.test.ts \
  packages/cli/src/goal.test.ts \
  packages/cli/src/cli.test.ts
pnpm typecheck
pnpm check:export
```

The smoke test must cover one task for all four policy combinations. It must
also cover these cases:

- The `all` policy starts all agents.
- The `random-single` policy starts one deterministic agent.
- The same seed selects the same starter.
- The `all` policy rejects `--policy-seed`.
- The `random-single` policy rejects a missing seed.
- The `first` policy keeps the legacy scheduled-check and first-claim rules.
- The `all-agents` policy ignores duplicate claims and non-agent claims.
- The `all-agents` policy does not close before all agents claim completion.
- A failed semantic check clears the completion set for the next repair round.
- A hard time or token bound can stop the run without a completion quorum.

Stop if one test fails. Do not replace the smoke test with a paid run.

## 5. Run the bounded live pilot

Use one task and one repeat. Run all four arms. Use the randomized order from
`arm-order.txt`. Do not use official hidden grader feedback in this stage.

The commands below are the complete 2-by-2 command set. Each command has a
unique workspace and output path.

Create all four command files before you run an arm. Do not change a command
file after the first run starts. This rule makes the exact command part of the
evidence.

### Arm: `all-first`

```bash
set -eu
cat > "$CELL/commands/all-first.sh" <<'SH'
#!/bin/sh
set -eu
node "$SHAREDNET_BIN" goal run "$WORK_ROOT/$TASK_ID/r$REPEAT/all-first/TASK.md" \
  --session "$SESSION_ID" \
  --type board \
  --workspace "$WORK_ROOT/$TASK_ID/r$REPEAT/all-first" \
  --out "$RUN_ROOT/$TASK_ID/r$REPEAT/all-first" \
  --name "$TASK_ID-r$REPEAT-all-first" \
  --image "$IMAGE_DIGEST" \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --message-routing mentions \
  --initiation-policy all \
  --termination-policy first \
  --web-search off \
  --turn-limit 45m \
  --check-every 1m \
  --until 'check: ./experiment/semantic-verifier.sh' \
  --until 'said /^DONE$/' \
  --until 'budget: 400k tokens' \
  --until 'after: 45m'
SH
chmod 0555 "$CELL/commands/all-first.sh"
```

### Arm: `random-first`

```bash
set -eu
cat > "$CELL/commands/random-first.sh" <<'SH'
#!/bin/sh
set -eu
node "$SHAREDNET_BIN" goal run "$WORK_ROOT/$TASK_ID/r$REPEAT/random-first/TASK.md" \
  --session "$SESSION_ID" \
  --type board \
  --workspace "$WORK_ROOT/$TASK_ID/r$REPEAT/random-first" \
  --out "$RUN_ROOT/$TASK_ID/r$REPEAT/random-first" \
  --name "$TASK_ID-r$REPEAT-random-first" \
  --image "$IMAGE_DIGEST" \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --message-routing mentions \
  --initiation-policy random-single \
  --termination-policy first \
  --policy-seed "$POLICY_SEED" \
  --web-search off \
  --turn-limit 45m \
  --check-every 1m \
  --until 'check: ./experiment/semantic-verifier.sh' \
  --until 'said /^DONE$/' \
  --until 'budget: 400k tokens' \
  --until 'after: 45m'
SH
chmod 0555 "$CELL/commands/random-first.sh"
```

### Arm: `all-all`

```bash
set -eu
cat > "$CELL/commands/all-all.sh" <<'SH'
#!/bin/sh
set -eu
node "$SHAREDNET_BIN" goal run "$WORK_ROOT/$TASK_ID/r$REPEAT/all-all/TASK.md" \
  --session "$SESSION_ID" \
  --type board \
  --workspace "$WORK_ROOT/$TASK_ID/r$REPEAT/all-all" \
  --out "$RUN_ROOT/$TASK_ID/r$REPEAT/all-all" \
  --name "$TASK_ID-r$REPEAT-all-all" \
  --image "$IMAGE_DIGEST" \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --message-routing mentions \
  --initiation-policy all \
  --termination-policy all-agents \
  --web-search off \
  --turn-limit 45m \
  --check-every 1m \
  --until 'check: ./experiment/semantic-verifier.sh' \
  --until 'said /^DONE$/' \
  --until 'budget: 400k tokens' \
  --until 'after: 45m'
SH
chmod 0555 "$CELL/commands/all-all.sh"
```

### Arm: `random-all`

```bash
set -eu
cat > "$CELL/commands/random-all.sh" <<'SH'
#!/bin/sh
set -eu
node "$SHAREDNET_BIN" goal run "$WORK_ROOT/$TASK_ID/r$REPEAT/random-all/TASK.md" \
  --session "$SESSION_ID" \
  --type board \
  --workspace "$WORK_ROOT/$TASK_ID/r$REPEAT/random-all" \
  --out "$RUN_ROOT/$TASK_ID/r$REPEAT/random-all" \
  --name "$TASK_ID-r$REPEAT-random-all" \
  --image "$IMAGE_DIGEST" \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --agent codex:gpt-6.1-sol \
  --message-routing mentions \
  --initiation-policy random-single \
  --termination-policy all-agents \
  --policy-seed "$POLICY_SEED" \
  --web-search off \
  --turn-limit 45m \
  --check-every 1m \
  --until 'check: ./experiment/semantic-verifier.sh' \
  --until 'said /^DONE$/' \
  --until 'budget: 400k tokens' \
  --until 'after: 45m'
SH
chmod 0555 "$CELL/commands/random-all.sh"
```

Stop after these four pilot runs. Inspect the policy behavior before you start
more model calls.

Run one position from the randomized order. Then copy the fixed protocol into
the run record. Start with `POSITION=1`. Repeat the block with positions 2, 3,
and 4. Do not change the order after you see a result.

```bash
set -eu
POSITION='1'
ARM=$(sed -n "${POSITION}p" "$CELL/arm-order.txt")
sh "$CELL/commands/$ARM.sh"
OUT="$RUN_ROOT/$TASK_ID/r$REPEAT/$ARM"
test -s "$CELL/commands/$ARM.sh"
mkdir -p "$OUT/protocol"
cp "$CELL/controls.json" "$OUT/protocol/controls.json"
cp "$CELL/arm-order.txt" "$OUT/protocol/arm-order.txt"
cp "$CELL/client-commit.txt" "$OUT/protocol/client-commit.txt"
cp "$CELL/cli-tarball.sha256" "$OUT/protocol/cli-tarball.sha256"
cp "$CELL/cli-version.txt" "$OUT/protocol/cli-version.txt"
cp "$CELL/session-id.txt" "$OUT/protocol/session-id.txt"
cp "$CELL/image-inspect.json" "$OUT/protocol/image-inspect.json"
cp "$CELL/worker-control-evidence.txt" \
  "$OUT/protocol/worker-control-evidence.txt"
cp "$CELL/fixture-files.sha256" "$OUT/protocol/fixture-files.sha256"
cp "$CELL/$ARM-input-files.sha256" "$OUT/protocol/input-files.sha256"
cp "$CELL/commands/$ARM.sh" "$OUT/protocol/command.sh"
cp -a "$CELL/frozen-inputs" "$OUT/protocol/frozen-inputs"
test -f "$WORK_ROOT/$TASK_ID/r$REPEAT/$ARM/experiment/reference-queries.ndjson"
cp "$WORK_ROOT/$TASK_ID/r$REPEAT/$ARM/experiment/reference-queries.ndjson" \
  "$OUT/protocol/reference-queries.ndjson"
(cd "$OUT/protocol" && \
  find . -type f ! -name evidence-sha256.txt -print0 | sort -z | \
  xargs -0 sha256sum) > "$OUT/protocol/evidence-sha256.txt"
chmod -R a-w "$OUT/protocol"
```

Repeat this step for all four positions.

## 6. Check the pilot evidence

For each arm, confirm that the output directory is unique and complete. At a
minimum, keep these files:

- `episode.json`
- `policy.ndjson`
- `room.ndjson`
- `checks.ndjson`
- `wakes.ndjson`
- `routing.ndjson`
- `workspace.git`
- `agents/<seat>/turn-NNN.jsonl`
- `protocol/`, with the frozen task, verifier, command, controls, arm order,
  hashes, image record, worker-control evidence, and reference-query log

Check `episode.json`. Confirm the initiation policy, termination policy, policy
seed, agents, model, image, routing, web setting, token bound, time bound, and
end reason. `policy_seed` must be `null` for the two `all` arms.

Check `policy.ndjson`. Confirm the applicable facts:

- `starter_selected` records the selected starter for `random-single`.
- `agent_started` records every initial start for `all`.
- `agent_started` records the selected starter and each later wake-started
  agent for `random-single`.
- In an `all-agents` arm, `completion_confirmed` records each accepted claim.
- In an `all-agents` arm, `completion_ignored` records a claim from a
  non-required sender.
- In an `all-agents` arm, `completion_duplicate_ignored` records a duplicate
  claim.
- In an `all-agents` arm, `completion_quorum` records the required quorum.
- In an `all-agents` arm, `completion_reset_after_check_failure` records a
  reset after a failed semantic verifier.

Check the Room log and the raw traces. Confirm that an agent did not start
before the policy allowed it. Confirm that the Room did not close before the
termination policy allowed it. Confirm that each accepted completion line is
exactly `DONE`.

Reject a run if required evidence is absent. Reject a run if a control differs
from another arm. Do not repair an output directory and call it the same run.
Create a new repeat.

## 7. Freeze and run the formal experiment

Write the formal protocol before you run it. Register these items:

- the task set and task snapshot hashes;
- the number of repeats;
- the four arms;
- the seed schedule and arm-order schedule;
- all controls in section 2;
- the primary semantic score;
- the token, time, and reference-query costs;
- the exclusion rules;
- the statistical analysis;
- the stop rule.

Use the complete run as the experimental unit. Pair the four arms by task and
repeat. Use a new workspace and a new output path for each run. Do not replace
a failed run without the preregistered exclusion rule.

Run the official hidden grader only after the artifact is frozen. Run it one
time for each frozen artifact. Do not give its result to an agent. Do not edit
the artifact after grading. Save the grader result outside the agent workspace.

Report the semantic score with the preregistered soft token threshold and
overshoot rule. Report the actual fresh tokens, threshold overshoot, cached
tokens, output tokens, model calls, reference queries, wall time, and CPU time.
If an external system enforces a strict total budget, describe and verify that
system before you call the comparison fixed-budget. Report initiation and
termination events as mechanism measures.

Do not infer task-quality improvement from fewer messages, fewer unread items,
fewer duplicate edits, or a later close. These values can explain a result,
but they are not the result. Do not claim a scheduler gain from this ablation.
The experiment changes initiation and termination policies only.
