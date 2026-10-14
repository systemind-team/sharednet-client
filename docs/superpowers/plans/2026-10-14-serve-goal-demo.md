# Serve-first Goal demo

## Goal

Add a separate experimental CLI path that runs exactly three Codex agents in separate Docker containers. Each container owns a persistent Codex thread and a real `sharednet serve` listener. The runner waits until all three seats report `listening`, then starts the Goal and either mentions all three seats or only the coordinator.

This demo must not reuse Goal's runner-owned `seatLoop`, `wait`, routing, or acknowledgement logic. `serve` owns message delivery and session resume. The Goal runner only provisions the containers, starts the Goal, posts the initial mention, evaluates end conditions, records the run, and cleans up.

## Interface

```sh
sharednet goal serve-demo TASK.md \
  --agent codex --agent codex --agent codex \
  --kickoff first \
  --until 'said /^SERVE_DEMO_DONE$/' \
  --until 'after 20m'
```

- `--kickoff first` mentions only agent 1. Its persistent session is instructed to delegate to agents 2 and 3 with exact mentions.
- `--kickoff all` mentions all three seats once. Later turns remain mention-triggered.
- The first version accepts exactly three Codex agents. It rejects token budgets because the watcher does not own model calls and cannot enforce a live spend bound.
- Every run uses a fresh Room and containers. Each agent has its own `HOME`, `CODEX_HOME`, seat, thread, listener, and serve log. The workspace is shared, matching current Goal mode.

## Implementation

1. Add `goal-serve-demo.ts` with validation, static session instructions, kickoff rendering, container provisioning, listener health checks, Goal start/kickoff, watcher integration, record enrichment, and cleanup.
2. Wire `goal serve-demo` into `cli.ts` with the same preflight ordering as `goal run`: validate task/triggers/workspace/auth/Docker before creating a Room.
3. Copy a mounted ChatGPT login into the container-owned Codex home with mode 0600. A read-only host login is often UID-private on Linux, so a symlink is not sufficient.
4. Add focused unit and fake-Docker integration tests. Assert all listeners are healthy before Goal start, `first` and `all` mentions are exact, real `serve` is started, and the runner never calls `wait` or `ack` for an agent.
5. Document the experiment and the boundary with prior Goal runs: those used a real persistent Room but harness-controlled delivery, not production `serve` and not agent-chosen polling.
6. Add intentional files to the export manifest and run unit tests, typecheck, export checks, package smoke, and one live three-container run when credentials permit.

## Research interpretation

This command creates a real-serve condition. Current `goal run` is a runner-delivery condition. A claim about agents deciding when or whether to listen requires a third self-polling condition; the old broadcast baseline is not that control.
