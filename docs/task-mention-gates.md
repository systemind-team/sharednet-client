# Optional board controls

`goal run --mention-gate` and `goal run --task-gate` are independent, opt-in controls for `--type board`. Both off is the existing broadcast baseline; turn on either flag or both for a four-arm comparison. No server changes or new endpoints are involved.

`--mention-gate` defaults to the earlier targeted wake policy: known @names wake those seats; no mention, @all, and unknown-only mentions broadcast. Everyone receives the initial goal. Explicit reads always see the whole board. Override with `--message-routing broadcast` to isolate before-say checking without selective wakes; `--message-routing mentions` alone selects the earlier routing without the new gate. `--task-gate` alone retains broadcast wakes.

Use the same `goal run` command, model, budget and stopping conditions for all arms; add these flags and give every run a fresh `--out` and workspace:

| Arm | Additional flags |
| --- | --- |
| Broadcast baseline | none |
| @ | `--mention-gate` |
| Task | `--task-gate` |
| Both | `--mention-gate --task-gate` |

For example, append both flags to `sharednet goal run TASK.md --type board --agent codex --agent codex --workspace ./work --out ./runs/both --until 'said /^DONE$/' --until 'after 15m'`. Add your task's check and budget identically across arms. Task titles do not require a compiled Room.

```
sharednet task claim "Implement CLI parser"
sharednet task list
sharednet task done "Implement CLI parser"
```

A claim looks before it claims. When teammates have claimed or finished tasks since this agent last looked (its last `task list` or claim), `task claim` posts nothing and returns `review_tasks` with the most recent tasks, newest first (`SHAREDNET_TASK_RECENT`, default 20). The agent compares its title with them and repeats the claim if its work is different; only newer teammate tasks trigger another review. Claims that cross, committed between the last look and this claim, cannot be seen in advance: a successful claim returns them as `crossed`, so the agent can coordinate with their owners. Judging whether two titles mean the same work is left to the agents.

With `--task-gate`, claims and completions wake nobody: the runner drops them from wakes, and a wake that carried only task acts is acknowledged without starting a turn (`routing.ndjson` records what was skipped). Agents see tasks through `task list` and the claim review. Because a completion wakes nobody, the task help tells an agent to `say` when a teammate is waiting on its task; otherwise a teammate that ended its turn to wait sleeps until someone posts.

These commands append `[sharednet-task:v1]` JSON messages. Clients replay all pages in sequence order. Titles differing only by case or whitespace are identical. The first claim wins, including simultaneous claims; a claimant verifies its committed message before receiving success. Only the authenticated owner can mark the task done. Done titles stay reserved. This does not detect semantically overlapping tasks with different titles or prescribe roles.

With `--task-gate`, each agent container receives `/etc/profile.d/sharednet-task.sh`. Its login bash checks a local, per-room/per-seat held-task file before work commands. Standalone sharednet commands remain available; compound commands and shell substitutions cannot use that exception. There is no network request on this shell path. `task list` refreshes local ownership when recovering after an interrupted claim. Keep a task active through implementation and validation before marking it done.

Local task operations serialize history reads and state writes so stale snapshots cannot restore completed tasks. Completion revokes that task locally before posting; `task list` recovers after an uncertain response. Locks recover dead processes, including Linux zombies. A reused live PID conservatively delays recovery until that process exits. History pagination validates ordering and metadata and must include the claimant's committed post; it trusts the service's ordered, complete listing contract rather than assuming sequence numbers are contiguous.

Codex direct `apply_patch`, non-login shells and other non-shell tools do not pass through that profile; audit their traces separately. The control is cooperative, not a security sandbox against agents deliberately changing their environment or state files. Claude Code additionally receives a PreToolUse hook through `--settings`; it gates non-shell tools too. The hook uses the documented [PreToolUse decision interface](https://code.claude.com/docs/en/hooks#pretooluse-decision-control); shell validation does not execute the pending command. Live model evidence should distinguish Codex and Claude rather than assuming one validates the other.

With `--mention-gate`, `say`, `task claim` and `task done` check for newer messages explicitly addressing the sender (including @all). If any exist, the CLI posts nothing, returns `unread_mentions` with their contents and records them as read. The agent can revise or explicitly retry its post; it need not answer. Failed network reads fail closed. The original outgoing message is never retried automatically.

The watermark is `max(SHAREDNET_TURN_THROUGH, local read maximum)`. The runner supplies the first value separately for every turn; successful explicit `read` calls and gate injections update the latter. This local record does not change the existing wait/ack cursor. Read output is recorded when returned by the CLI, not verified as understood by a model. Filtered/tail reads can skip older messages below the maximum; truncated or transformed tool output can omit content. Therefore this is a watermark policy, not an exact proof that every older message entered context. The check and post are two requests: messages arriving between them wait for the next read/gate/wake.

Local evidence is saved under the agent's state directory in `sharednet/board-controls/<scope>/`: `held-tasks`, `read-through`, `events.ndjson`, and `shell-blocks.tsv`. These contain task/receipt metadata, not credentials. Goal records retain each agent home after scrubbing credentials, so the experiment can audit claims, gate events and bypassed edits.

For comparisons, keep task, model, image, budget and stop rules fixed. Historical runs with substring DONE matching are not matched controls for runs using standalone DONE. Count actual message receipts before actions; an automatic wake and an explicit read are both receipt paths. Report title-claim losses, gate interventions, direct-edit violations, tokens, duration and hidden task score separately. Fewer incidents or messages alone is not evidence of better task performance.
