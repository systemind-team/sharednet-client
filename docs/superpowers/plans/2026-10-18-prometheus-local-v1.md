# Prometheus Local v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `sharednet prometheus` as a resumable local workflow for exactly three persistent Codex roles, with a fresh compiled Goal Room and a fail-closed completion barrier for every run.

**Architecture:** Rebase PR 48 first and extract its tested Docker, Codex bootstrap, real-listener, and checker mechanics into a reusable runtime. A protocol module validates `PROMETHEUS.md`, compiled state, artifact receipts, reviewer verification, and terminal receipts; a separate owner-only XDG store holds non-secret team/run metadata and monitor leases. The command layer creates or resumes one active run and closes it only after the same candidate revision passes typed-state, terminal-receipt, listener-idle, handed-empty, and semantic-check gates.

**Tech Stack:** TypeScript 7, Node.js 22.18+ built-ins, Docker CLI, Codex CLI, existing SharedNet HTTP/compiled Room/serve interfaces, Vitest 4, pnpm 11.

**Spec:** `docs/plans/2026-10-18-prometheus-local-design.md`

## Global Constraints

- Expose exactly `sharednet prometheus run|status|resume|cancel`; local v1 has exactly `coordinator`, `builder`, and `reviewer`, all Codex, all on one saved model.
- Require a workspace-root `PROMETHEUS.md` with non-empty `## Motto`, `## Rules`, `## Preferences`, `## Handoff`, and `## Completion` sections before Docker or network work.
- Reuse persistent role homes, Codex threads, and real `sharednet serve` listeners across runs; create one fresh compiled Goal Room per run.
- Allow one active run per real workspace path. Persist its original absolute deadline and make interruption resumable rather than destructive.
- Address only exact run member ids. Do not use `@all`, role-name routing, broadcast kickoff, runner-owned `wait`, or runner-owned `ack` for role delivery.
- Never treat raw chat, a model final response, or `DONE` as completion. Accept only authenticated v1 terminal receipts matching the current candidate revision.
- Success requires a resolved compiled head, no nonterminal typed work, service-attested artifact SHA-256 receipts, reviewer-authored `verification.pass` for the exact current `result_ref`, three terminal receipts, no working seat, no unsettled handed wake, and a semantic check followed by an unchanged re-read.
- Store Prometheus metadata beneath `$XDG_STATE_HOME/sharednet/prometheus/local-v1`; use owner-only, no-follow, atomic files and never persist API keys, instance/member tokens, invites, Codex tokens, copied `auth.json`, or secret-bearing environments/arguments.
- Preserve the six frozen `research/*@1` profiles and hashes exactly. Keep `runtime/serve-first@1` and `runtime/serve-all@1` unavailable and do not report Prometheus as either mode.
- Keep the published CLI at zero runtime dependencies. Add every intentional file to `scripts/export-manifest.json`; do not import hosted service or protocol source.
- Keep PR 48's `goal serve-demo` behavior and tests while extracting shared implementation. Do not merge, publish, or change repository visibility as part of this plan.
- Deferred: Cloud, global team discovery, cross-machine operation/failover, variable team size, custom roles/drivers, concurrent runs, reset/migration, and runtime-mode activation.

## Review Focus

- Missing, duplicated, reordered, fenced, oversized, or case-changed `PROMETHEUS.md` sections must fail before Docker/network calls; Task 2 covers parsing and Task 5 proves CLI ordering.
- Concurrent `run` calls, PID reuse, a live monitor, and a dead monitor must never create two active Rooms or let `resume` steal a live lease; Task 3 pins the lock/lease races.
- Malformed compiled projections, missing artifact receipts, stale `result_ref`, forged reviewer actors, and ambiguous successor heads must keep the barrier closed; Task 2 covers each wire shape.
- Raw `DONE`, stale/forged terminal receipts, a revision change during a passing check, and a second check on a known-failing revision must never close the Room; Task 5 exercises all four cases.
- A `working`, `retrying`, or stopped seat, an unsettled handed wake, an interrupted monitor, and a previously posted kickoff must remain safe across `resume`; Tasks 4 and 5 test those lifecycle edges.

---

### Task 1: Rebase PR 48 and preserve the frozen registry

**Files:**
- Rebase/retain: `packages/cli/src/goal-serve-demo.ts`
- Rebase/retain: `packages/cli/src/goal-serve-demo.test.ts`
- Rebase/retain: `packages/cli/src/cli.ts`
- Rebase/retain: `packages/cli/src/cli.test.ts`
- Rebase/retain: `packages/cli/src/goal-run.ts`
- Rebase/retain: `packages/cli/src/goal-run.test.ts`
- Rebase/retain: `packages/cli/src/goal.ts`
- Rebase/retain: `packages/cli/src/goal.test.ts`
- Rebase/retain: `docs/goal-mode.md`
- Rebase/retain: `docs/superpowers/plans/2026-10-14-serve-goal-demo.md`
- Modify: `scripts/export-manifest.json`
- Verify unchanged: `packages/cli/src/harness-modes.ts`
- Verify unchanged: `packages/cli/src/harness-modes.test.ts`
- Verify unchanged: `docs/harness-modes.md`

**Interfaces:**
- Consumes: PR 48 commits `2d4cc36`, `e77597d`, `10aecb6`, and `8154322`; current `feat/prometheus-local-v1` based on `1f0ef66`.
- Produces: rebased `parseServeDemoAgents(raw)`, `assertServeDemoGoalUnaddressed(content)`, `serveKickoff(mode, seats, goalSequence)`, `serveSessionPrompt(seat, seats, until, kickoff)`, and `runServeGoalDemo(client, memberToken, apiKey, input, dependencies)` with their existing behavior.
- Preserves: all values returned by `harnessModeSpecHash`, and `resolveGoalRunHarnessMode("runtime/serve-first@1")` / `serve-all` continuing to throw `harness_mode_unavailable` before side effects.

- [ ] **Step 1: Record the pre-rebase registry contract**

Run:

```bash
pnpm exec vitest run packages/cli/src/harness-modes.test.ts packages/cli/src/cli.test.ts
```

Expected: PASS on the six research profiles, their exact hashes, and both unavailable runtime reservations.

- [ ] **Step 2: Rebase the existing PR 48 worktree onto this feature branch**

Run:

```bash
git -C /mnt/data0/xisen/workspace/repos/sharednet-client.worktrees/serve-goal-demo rebase feat/prometheus-local-v1
```

Resolve conflicts additively: retain the current harness-mode imports, validation, provenance, episode fields, read-only Codex-auth mount/copy fix, and export entries; then retain PR 48's `goal serve-demo` command and files. Do not change registry semantics or hashes.

- [ ] **Step 3: Fast-forward the Prometheus branch to the rebased PR head**

Run in this worktree:

```bash
git merge --ff-only feat/serve-goal-demo
```

Expected: the four PR 48 commits sit after the Prometheus design commit; no merge commit.

- [ ] **Step 4: Run the rebased focused suite**

Run:

```bash
pnpm exec vitest run packages/cli/src/goal-serve-demo.test.ts packages/cli/src/goal-run.test.ts packages/cli/src/goal.test.ts packages/cli/src/harness-modes.test.ts packages/cli/src/cli.test.ts
```

Expected: PASS, including listener-before-goal ordering, exact kickoff ids, cleanup, immutable research hashes, and early runtime-mode refusal.

- [ ] **Step 5: Check the rebase diff**

Run:

```bash
git diff --check 1f0ef66..HEAD
git diff 1f0ef66..HEAD -- packages/cli/src/harness-modes.ts packages/cli/src/harness-modes.test.ts
```

Expected: no whitespace errors; registry changes are conflict resolution only and preserve all frozen values.

### Task 2: Parse policy, compiled evidence, and terminal receipts

**Files:**
- Create: `packages/cli/src/prometheus-protocol.ts`
- Create: `packages/cli/src/prometheus-protocol.test.ts`
- Modify: `packages/cli/src/compiled.ts`

**Interfaces:**
- Consumes: `CompiledState` from `compiled.ts` and Room messages shaped as `{ sequence, content, sender_instance_id?, sender?: { member_id? } }`.
- Produces: `PROMETHEUS_ROLES`, `type PrometheusRole`, `parsePrometheusPolicy(raw: string): PrometheusPolicy`, `assertPrometheusGoalUnaddressed(raw: string): void`, `parsePrometheusCandidate(state: CompiledState, reviewerMemberId: string): CandidateResult`, `parseTerminalReceipts(messages: readonly PrometheusMessage[], roster: PrometheusRoster, runId: string, revisionSha256: string): TerminalReceiptResult`.
- `PrometheusPolicy` is `{ raw, sha256, sections: Record<"Motto" | "Rules" | "Preferences" | "Handoff" | "Completion", string> }`.
- A successful `CandidateResult` is `{ ok: true, candidate: { stateDigest, workId, resultRef, artifacts, verifications, revisionSha256 } }`; a refusal is `{ ok: false, reasons: string[] }` and never throws for merely incomplete work.

- [ ] **Step 1: Write failing policy and goal tests**

Add tests named:

```ts
it("parses the five ordered nonempty policy sections outside fences and hashes exact bytes", () => { /* assert exact sections and SHA-256 */ });
it.each(["missing", "duplicate", "reordered", "wrong-case", "empty", "oversized"])("rejects %s PROMETHEUS.md before side effects", ...);
it("rejects goals that address all, a fixed role name, or a remembered member id", () => { /* assert invalid_arguments */ });
```

- [ ] **Step 2: Run the policy tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-protocol.test.ts -t 'policy|goals'
```

Expected: FAIL because `prometheus-protocol.ts` does not exist.

- [ ] **Step 3: Implement the policy and unaddressed-goal parsers**

Use a fence-aware line scan with a 64 KiB byte limit and exact case-sensitive level-two headings. Hash the untouched UTF-8 bytes. Reject `@all`, `@coordinator`, `@builder`, `@reviewer`, and `@i_…`/`@mem_…` in the goal.

- [ ] **Step 4: Write failing candidate tests with public wire fixtures**

Build minimal `CompiledState` fixtures and assert:

```ts
it("derives one revision from a resolved successor head, exact result artifact receipts, and reviewer passes", ...);
it.each(["nonterminal-work", "ambiguous-head", "rejected-head", "missing-result-event", "missing-artifact-receipt", "bad-artifact-sha256", "stale-result-ref", "wrong-reviewer", "missing-review-evidence", "unsatisfied-requirement"])("keeps the candidate closed for %s", ...);
it("sorts work artifacts and verification evidence before hashing the revision", ...);
```

The passing fixture must include `work.result.refs.artifacts`, matching `refs.artifact_receipts`, a reviewer `verification.pass` whose `refs.result_ref` equals the projected result, and an evidence receipt.

- [ ] **Step 5: Run the candidate tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-protocol.test.ts -t 'candidate|revision'
```

Expected: FAIL because the candidate parser is absent.

- [ ] **Step 6: Implement strict standalone wire parsing and canonical revision hashing**

Do not import from the service/protocol repository. Validate objects, arrays, ids, event hashes, and lowercase 64-hex artifact SHA-256 values before use. Select the unique unsuperseded head; require every other item terminal and the head `RESOLVED`; bind every verify requirement to the saved reviewer and exact current result.

- [ ] **Step 7: Write and pass terminal-receipt tests**

Test one valid receipt from each saved sender and rejection of raw `DONE`, ordinary final text, malformed/extra JSON fields, a forged role, stale run id, stale revision, duplicate older receipts, and a receipt from an unknown member. The newest valid receipt per role wins.

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-protocol.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the protocol boundary**

```bash
git add packages/cli/src/prometheus-protocol.ts packages/cli/src/prometheus-protocol.test.ts packages/cli/src/compiled.ts
git commit -m "feat(cli): validate Prometheus completion evidence"
```

### Task 3: Add owner-only team and run state

**Files:**
- Create: `packages/cli/src/prometheus-state.ts`
- Create: `packages/cli/src/prometheus-state.test.ts`
- Modify: `packages/cli/src/storage.ts`
- Modify: `packages/cli/src/storage.test.ts`
- Modify: `packages/cli/src/process-identity.ts`
- Test: `packages/cli/src/process-identity.test.ts`

**Interfaces:**
- Consumes: `getStoragePaths(env).stateDir`, `ProcessProbe`, real workspace path, and `PrometheusRole`.
- Produces: `prometheusPaths(env, workspace): Promise<PrometheusPaths>`, `readTeam(paths): Promise<PrometheusTeamState | null>`, `writeTeam(paths, state): Promise<void>`, `readRun(paths, runId): Promise<PrometheusRunState | null>`, `writeRun(paths, state): Promise<void>`, `reserveActiveRun(paths, state, probe): Promise<void>`, `claimMonitor(paths, runId, probe): Promise<MonitorLease>`, `requestCancel(paths, runId): Promise<void>`, `finishRun(paths, finalState, lease): Promise<void>`.
- `PrometheusTeamState` schema v1 fixes workspace key/path, model, three container/volume/thread records, last policy hash, and timestamps.
- `PrometheusRunState` schema v1 holds configuration, startup checkpoint, Room/roster, deadline, monitor, outcome, candidate/check summaries, and never a credential.
- `readOwnerOnlyFile`, `writeOwnerOnlyJson`, and `ensureOwnerOnlyDirectory` become exported storage primitives with their existing no-follow/ownership semantics.

- [ ] **Step 1: Write failing path, mode, symlink, and redaction tests**

Assert the state root is `<stateDir>/prometheus/local-v1/<first-24-hex-of-realpath-sha256>`, directories are `0700`, files are `0600`, atomic replacement works, symlink/group-readable targets fail, malformed schema fails, and serialized team/run fixtures contain none of `snk_`, `sni_`, `rit_`, `member_token`, `api_key`, `invite`, `OPENAI_API_KEY`, or `auth.json` content.

- [ ] **Step 2: Run state tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-state.test.ts packages/cli/src/storage.test.ts
```

Expected: FAIL on missing state APIs.

- [ ] **Step 3: Export the existing secure-file primitives and implement schemas**

Keep credential callers unchanged. Validate every enum, id, absolute path, timestamp, role key, and terminal transition on read; use temporary file, `fsync`, chmod, atomic rename, and parent-directory `fsync` on write.

- [ ] **Step 4: Write failing one-active-run and monitor-lease races**

Use concurrent promises plus a fake `ProcessProbe` to assert:

```ts
it("lets exactly one concurrent caller reserve the active slot", ...);
it("refuses a second run while an active or resumable run exists", ...);
it("does not let resume replace a live monitor or a reused pid", ...);
it("lets resume replace a dead exact process identity without changing the deadline", ...);
it("lets cancel set cancel_requested while the monitor lease is live", ...);
it("clears active only after the matching lease writes a terminal run", ...);
```

- [ ] **Step 5: Implement the short lock and renewable monitor lease**

The lock record is `{ schema_version: 1, lock_id, pid, start_identity, created_at }`. Recover it only when the same process identity is provably dead; never treat a live/reused PID as the owner. Hold the lock only around local state reads/writes.

- [ ] **Step 6: Run focused state tests**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-state.test.ts packages/cli/src/storage.test.ts packages/cli/src/process-identity.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit secure state**

```bash
git add packages/cli/src/prometheus-state.ts packages/cli/src/prometheus-state.test.ts packages/cli/src/storage.ts packages/cli/src/storage.test.ts packages/cli/src/process-identity.ts packages/cli/src/process-identity.test.ts
git commit -m "feat(cli): persist local Prometheus state"
```

### Task 4: Refactor PR 48 into a persistent three-role runtime

**Files:**
- Create: `packages/cli/src/prometheus-runtime.ts`
- Create: `packages/cli/src/prometheus-runtime.test.ts`
- Modify: `packages/cli/src/goal-serve-demo.ts`
- Modify: `packages/cli/src/goal-serve-demo.test.ts`
- Modify: `packages/cli/src/goal-run.ts`

**Interfaces:**
- Consumes: `DockerRunner`, `RunPlan`/image/auth preflight pieces from `goal-run.ts`, `PrometheusTeamState`, `PrometheusRunState`, and PR 48's tested container mechanics.
- Produces: `ensurePrometheusTeam(input: EnsureTeamInput, deps: PrometheusRuntimeDependencies): Promise<PrometheusTeamState>`, `attachPrometheusRoom(team, input: AttachRoomInput, deps): Promise<PrometheusRoster>`, `inspectPrometheusRuntime(team, roomId, deps): Promise<PrometheusRuntimeStatus>`, `runPrometheusCheck(team, check, env, deps): Promise<SemanticCheckResult>`.
- `PrometheusRoster` is an exact record keyed by the three roles with `{ memberId, threadId, containerName }`.
- `PrometheusRuntimeStatus` reports each active seat's serve state and room-scoped `unanswered` handed entries; no caller parses Docker stdout itself.

- [ ] **Step 1: Write failing stable-team and second-run tests**

Starting from PR 48's fake Docker, assert the first call creates exactly three stable containers/volumes, bootstraps exactly three threads, starts one unfiltered `sharednet serve` per role, and stores no secret in Docker args or Prometheus state. A second Room call must reuse the same containers, volumes, thread ids, and listener processes while joining three fresh member ids; it must not issue another `codex exec` bootstrap or another listener start.

- [ ] **Step 2: Run the runtime tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-runtime.test.ts
```

Expected: FAIL because the persistent runtime does not exist.

- [ ] **Step 3: Extract PR 48's reusable mechanics**

Move shared Docker exec, wrapper, host-forwarder, Codex-config, join/wake, listener-health, and checker code behind `prometheus-runtime.ts`. Leave thin adapters in `goal-serve-demo.ts` so its per-run names, `first|all` kickoff, copy-out, signal cleanup, and removal behavior stay unchanged.

- [ ] **Step 4: Implement stable roles and listener reuse**

Use fixed role constants and workspace-keyed container/volume names. Mount the host Codex login read-only and keep credential bytes out of XDG state. Run each role under the host numeric uid/gid. Start `sharednet serve` with no `--rooms` filter and require the exact new seat to reach `listening` before returning. Refuse a missing/mismatched saved thread rather than bootstrapping over it.

- [ ] **Step 5: Add runtime-status and checker tests**

Assert `inspectPrometheusRuntime` distinguishes `listening`, `working`, `retrying`, and `stopped`, filters handed records by active Room/seat, and returns malformed status as unhealthy. Assert the checker gets only the four documented non-secret environment variables and bounded output.

- [ ] **Step 6: Run PR 48 and runtime regression suites**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-runtime.test.ts packages/cli/src/goal-serve-demo.test.ts packages/cli/src/goal-run.test.ts
```

Expected: PASS; PR 48 still removes only containers it created, while Prometheus leaves stable team containers and volumes running.

- [ ] **Step 7: Commit the runtime refactor**

```bash
git add packages/cli/src/prometheus-runtime.ts packages/cli/src/prometheus-runtime.test.ts packages/cli/src/goal-serve-demo.ts packages/cli/src/goal-serve-demo.test.ts packages/cli/src/goal-run.ts
git commit -m "refactor(cli): reuse persistent Codex team runtime"
```

### Task 5: Add the CLI, completion barrier, and recovery lifecycle

**Files:**
- Create: `packages/cli/src/prometheus.ts`
- Create: `packages/cli/src/prometheus.test.ts`
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/cli.test.ts`
- Modify: `packages/cli/src/prometheus-protocol.ts`
- Modify: `packages/cli/src/prometheus-protocol.test.ts`
- Modify: `packages/cli/src/prometheus-state.ts`
- Modify: `packages/cli/src/prometheus-state.test.ts`

**Interfaces:**
- Consumes: protocol, state, and runtime interfaces from Tasks 2-4; `ApiClient`, `startGoal`, `readGoalFile`, `parseDuration`, `resolveApiKey`, and the selected owner session.
- Produces: `prometheusCommand(action: string | undefined, args: string[], context: PrometheusCommandContext): Promise<PrometheusCommandResult>`, `startPrometheusRun(input, deps): Promise<PrometheusRunState>`, `evaluatePrometheusBarrier(input): PrometheusBarrierResult`, `monitorPrometheusRun(run, deps): Promise<PrometheusRunState>`, `resumePrometheusRun(workspace, deps)`, `cancelPrometheusRun(workspace, deps)`, and `prometheusStatus(workspace, deps)`.
- CLI syntax: `prometheus run GOAL.md --model MODEL --check COMMAND --timeout DURATION [--workspace DIR]`; `status`, `resume`, and `cancel` accept only `--workspace`.
- `PrometheusBarrierResult` is `{ ready: false, reasons, revisionSha256? }` or `{ ready: true, candidate, receipts }`. Terminal run outcomes are `succeeded | timed_out | cancelled | failed`.

- [ ] **Step 1: Write failing early-validation and fresh-run tests**

For missing/duplicate options, bad duration, missing or malformed policy,
addressed goal, missing workspace/login/Docker, saved-model mismatch, and an
active run, assert nonzero exit, no HTTP requests, and no Docker calls. Add one
successful test that asserts this exact order: reserve active state; ensure
team; create `{ type: "compiled" }` Room; start a Goal with only the stored
`after` bound; mint invite; attach the three existing roles; observe all exact
seats `listening`; post one kickoff containing only
`@<coordinator-member-id>`. Assert no runner `wait` or `ack`.

- [ ] **Step 2: Run the CLI/start tests to verify they fail**

Run:

```bash
pnpm exec vitest run packages/cli/src/cli.test.ts packages/cli/src/prometheus.test.ts -t 'prometheus|fresh compiled run'
```

Expected: FAIL with `unknown_command` or missing Prometheus functions.

- [ ] **Step 3: Implement top-level parsing and checkpointed startup**

Route `resource === "prometheus"` without changing global `--session` or
credential rules. Validate all local inputs before side effects. Persist
`reserved`, `room_created`, `goal_started`, `roles_joined`,
`listeners_ready`, and `kickoff_posted` with returned ids/sequences and stable
idempotency keys. Per-run prompts include exact roster, policy/goal hashes,
compiled successor recipe, receipt JSON, check description, and deadline.

- [ ] **Step 4: Write the failing completion truth table**

Start with a valid candidate and remove one condition at a time: resolved head,
terminal prior work, artifact receipt/hash, reviewer pass/evidence, each role's
receipt, listening state, and empty handed state. Assert each returns
`ready: false` with a stable reason. Assert raw `DONE`, an ordinary final
response, and stale/forged receipts never affect readiness.

- [ ] **Step 5: Write failing semantic-check and post-check race tests**

Add tests named:

```ts
it("runs the check only after typed, receipt, and idle gates are ready", ...);
it("posts one bounded exact-coordinator failure and never reruns the same failed revision", ...);
it("discards a passing check when result, artifact, digest, receipt, working, or handed state changes", ...);
it("closes success only after an identical post-check candidate and records the exact revision", ...);
```

- [ ] **Step 6: Implement the barrier and revision-keyed check cache**

Combine already parsed evidence in the pure evaluator. The monitor records a
check before feedback or close. A nonzero result blocks that revision and posts
one bounded exact-`@coordinator` message. A zero result triggers a complete
state/messages/status/handed re-read; only an identical snapshot closes with
`trigger: "prometheus_success"` and the revision in bounded detail.

- [ ] **Step 7: Write failing resume and outcome tests**

For each startup checkpoint, assert `resume` performs only missing steps,
reuses idempotency keys, never creates a second Room/thread/seat or reposts a
committed kickoff, and retains the deadline. Assert a live monitor cannot be
stolen; dead exact identity can be. Assert timeout, concurrent/idempotent
cancel, unexpected Room close, malformed protocol, checker launch failure, and
irreparable team map respectively to the specified outcome; a failed semantic
check remains `running`; every terminal transition preserves the team and
clears `active.json` last.

- [ ] **Step 8: Implement status, resume, cancel, signals, and outcomes**

`status` reports non-secret team/health/run/deadline/checkpoint/barrier/monitor
data. `cancel` sets `cancel_requested` under the short lock; the monitor or a
cancel-owned recovery pass closes once. `resume` reconciles stored checkpoints
and remote state before entering the same monitor. SIGINT/SIGTERM leave the run
active and resumable; no outcome removes role containers or volumes.

- [ ] **Step 9: Run and commit the complete command lifecycle**

Run:

```bash
pnpm exec vitest run packages/cli/src/prometheus-protocol.test.ts packages/cli/src/prometheus-state.test.ts packages/cli/src/prometheus-runtime.test.ts packages/cli/src/prometheus.test.ts packages/cli/src/cli.test.ts
```

Expected: PASS.

```bash
git add packages/cli/src/prometheus.ts packages/cli/src/prometheus.test.ts packages/cli/src/cli.ts packages/cli/src/cli.test.ts packages/cli/src/prometheus-protocol.ts packages/cli/src/prometheus-protocol.test.ts packages/cli/src/prometheus-state.ts packages/cli/src/prometheus-state.test.ts
git commit -m "feat(cli): run persistent local Prometheus teams"
```

### Task 6: Document, export, package, and verify local v1

**Files:**
- Create: `docs/prometheus-local.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/harness-modes.md`
- Modify: `SECURITY.md`
- Modify: `scripts/export-manifest.json`
- Test: `scripts/check-export.test.mjs`
- Test: `scripts/package-smoke.mjs`

**Interfaces:**
- Consumes: final CLI syntax, state/outcome schemas, fixed roles, and barrier behavior from Tasks 2-5.
- Produces: an operator guide; package/export allowlisting for every new source, test, and document; explicit security and research-mode boundaries.
- Preserves: zero runtime dependencies, existing package exports, six frozen research hashes, and both runtime reservations remaining unavailable.

- [ ] **Step 1: Write user, testing, and security documentation**

Document prerequisites, the five policy headings, first/subsequent runs,
status/resume/cancel, role behavior, compiled artifacts/review, terminal
receipts, why `DONE` is inert, state paths/modes, credential locations,
outcomes, and deferred features. Update the runtime catalog wording from
"unmerged PR 48" to "reserved and not wired" without changing registry specs,
hashes, or availability.

- [ ] **Step 2: Add every intentional file to the export manifest**

Add the three `prometheus-*.ts` source/test pairs, the design, this plan, the
operator guide, and every PR 48 file introduced by the rebase. Do not edit
imported source hashes for modified existing files.

- [ ] **Step 3: Extend package smoke with a no-team status check**

From a clean offline tarball install with isolated `HOME`, `XDG_CONFIG_HOME`,
and `XDG_STATE_HOME`, assert `sharednet prometheus status --json` returns the
documented no-team result without TypeScript stripping, install scripts,
Docker, network, or credentials. Assert the tarball contains the new runtime
modules/declarations and no credential/state fixture.

- [ ] **Step 4: Run the complete verification set**

Run:

```bash
pnpm check:export
pnpm typecheck
pnpm test
pnpm test:package
gitleaks git . --redact --no-banner
```

Expected: every command exits 0; package smoke records an artifact SHA-256;
gitleaks reports no leak.

- [ ] **Step 5: Inspect frozen compatibility and the final diff**

Run:

```bash
git diff origin/codex/bootstrap-base...HEAD -- packages/cli/src/harness-modes.ts docs/harness-modes.md
git diff --check origin/codex/bootstrap-base...HEAD
git status --short
```

Expected: immutable registry values/hashes are unchanged; catalog edits only
describe current availability; no whitespace errors; only intentional files.

- [ ] **Step 6: Request review, fix findings, and commit the boundary**

Use `superpowers:requesting-code-review` with the design, plan, and full diff.
Resolve every correctness/security finding and rerun the affected focused test
plus Step 4 whenever source changes.

```bash
git add docs/prometheus-local.md packages/cli/README.md docs/TESTING.md docs/harness-modes.md SECURITY.md scripts/export-manifest.json scripts/check-export.test.mjs scripts/package-smoke.mjs
git commit -m "docs(cli): document local Prometheus teams"
```

Leave the branch ready for a pull request; do not merge or publish.
