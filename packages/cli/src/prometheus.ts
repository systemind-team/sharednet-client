import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ApiClient } from "./api-client.ts";
import type { CompiledState } from "./compiled.ts";
import { asCliError, localError } from "./errors.ts";
import type { DockerRunner, RunPlan } from "./goal-run.ts";
import {
  PROMETHEUS_ROLES,
  assertPrometheusGoalUnaddressed,
  parsePrometheusCandidate,
  parsePrometheusPolicy,
  parseTerminalReceipts,
  type CandidateResult,
  type PrometheusCandidate,
  type PrometheusMessage,
  type PrometheusPolicy,
  type TerminalReceiptResult,
} from "./prometheus-protocol.ts";
import {
  attachPrometheusRoom,
  ensurePrometheusListeners,
  ensurePrometheusTeam,
  inspectPrometheusRuntime,
  materializePrometheusArtifactSnapshot,
  runPrometheusCheck,
  verifyPrometheusTeamIdentity,
  type PrometheusRuntimeStatus,
} from "./prometheus-runtime.ts";
import {
  claimMonitor,
  finishRun,
  prometheusPaths,
  readActiveRun,
  readTeam,
  requestCancel,
  reserveActiveRun,
  writeRun,
  writeTeam,
  type PrometheusPaths,
  type PrometheusEffectJournalEntry,
  type PrometheusPendingClose,
  type PrometheusRoster,
  type PrometheusRunState,
  type PrometheusTeamState,
} from "./prometheus-state.ts";
import { inspectProcessIdentity, systemProcessProbe, type ProcessProbe } from "./process-identity.ts";

const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 86_400_000;

export type PrometheusBarrierResult =
  | { ready: false; reasons: string[]; revisionSha256?: string }
  | { ready: true; candidate: Extract<CandidateResult, { ok: true }>["candidate"]; receipts: TerminalReceiptResult["receipts"] };

export function evaluatePrometheusBarrier(input: {
  candidate: CandidateResult;
  receipts: TerminalReceiptResult;
  runtime: PrometheusRuntimeStatus;
}): PrometheusBarrierResult {
  if (!input.candidate.ok) return { ready: false, reasons: input.candidate.reasons };
  const revisionSha256 = input.candidate.candidate.revisionSha256;
  const reasons: string[] = [];
  if (!input.runtime.healthy) reasons.push("runtime status is unhealthy");
  if (!input.receipts.ok) {
    for (const role of input.receipts.missingRoles) reasons.push(`${role} terminal receipt is missing`);
  }
  for (const role of PROMETHEUS_ROLES) {
    const roleStatus = input.runtime.roles[role];
    if (roleStatus.state !== "listening") reasons.push(`${role} is ${roleStatus.state}`);
    if (roleStatus.unanswered.length > 0) reasons.push(`${role} has unsettled handoff work`);
  }
  return reasons.length > 0
    ? { ready: false, reasons, revisionSha256 }
    : { ready: true, candidate: input.candidate.candidate, receipts: input.receipts.receipts };
}

export function prometheusKickoff(input: {
  runId: string;
  goalSequence: number;
  roster: PrometheusRoster;
  policy: PrometheusPolicy;
  goalSha256: string;
  check: string;
  deadlineAt: string;
}): string {
  const roster = PROMETHEUS_ROLES.map((role) => `${role}=${input.roster[role].member_id}`).join(", ");
  return [
    `@${input.roster.coordinator.member_id} Start Prometheus run ${input.runId} for Goal #${input.goalSequence}.`,
    `Exact roster: ${roster}. Address every request and handoff to one exact member id.`,
    `PROMETHEUS.md sha256=${input.policy.sha256}; GOAL.md sha256=${input.goalSha256}; deadline=${input.deadlineAt}.`,
    "The complete current policy supersedes earlier policy:",
    input.policy.raw,
    `Create compiled work for ${input.roster.builder.member_id} requiring exactly one deliverable named submission and verified_by ${input.roster.reviewer.member_id}. The submission must be a workspace-rooted tar archive for the semantic checker. The builder publishes work.result. The reviewer downloads the exact artifact, checks its SHA-256, uploads review evidence, then publishes verification.pass bound to the current result_ref. Resolve only the verified head; defects require a successor using supersedes.`,
    `Semantic check after the evidence barrier: ${input.check}`,
    `After the final head is resolved and reviewed, wait: the runner will announce the exact candidate revision and pinned artifact snapshot digest. Then request one receipt from builder and reviewer and post yours. Exact line: [sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"${input.runId}","role":"<role>","revision_sha256":"<runner-announced 64-hex revision>"}`,
  ].join("\n\n");
}

export function prometheusCandidateHandoff(
  runId: string,
  roster: PrometheusRoster,
  candidate: PrometheusCandidate,
  artifactSnapshotSha256: string,
): string {
  const recipients = PROMETHEUS_ROLES.map((role) => `@${roster[role].member_id}`).join(" ");
  return `${recipients} Runner pinned candidate revision ${candidate.revisionSha256}; artifact_snapshot_sha256=${artifactSnapshotSha256}. Send exactly one authenticated receipt using [sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"${runId}","role":"<your role>","revision_sha256":"${candidate.revisionSha256}"}`;
}

export interface PrometheusConnection {
  client: ApiClient;
  memberToken: string;
  apiKey: string;
  baseUrl: string;
}

export interface PrometheusDependencies {
  env: Record<string, string | undefined>;
  cwd: string;
  now: () => Date;
  docker: DockerRunner;
  plan?: RunPlan;
  preparePlan?: () => Promise<RunPlan>;
  connect: () => Promise<PrometheusConnection>;
  processProbe?: ProcessProbe;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface StartPrometheusInput {
  workspace: string;
  goalPath: string;
  model: string;
  check: string;
  timeoutMs: number;
}

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function timestampAfter(previous: string, now: Date): string {
  return new Date(Math.max(now.getTime(), Date.parse(previous) + 1)).toISOString();
}

async function readInputs(input: StartPrometheusInput): Promise<{ workspace: string; policy: PrometheusPolicy; goal: string; goalPath: string }> {
  if (!input.model || !/^[A-Za-z0-9._/-]{1,100}$/.test(input.model)) throw localError("invalid_arguments", "--model names an invalid model.");
  if (!input.check.trim()) throw localError("invalid_arguments", "--check must not be empty.");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < MIN_TIMEOUT_MS || input.timeoutMs > MAX_TIMEOUT_MS) throw localError("invalid_arguments", "--timeout must be between 1m and 24h.");
  const workspace = resolve(input.workspace);
  if (!(await stat(workspace).then((entry) => entry.isDirectory(), () => false))) throw localError("invalid_arguments", `--workspace ${workspace} is not a directory.`);
  let policyRaw: string;
  let goal: string;
  const goalPath = resolve(workspace, input.goalPath);
  try { policyRaw = await readFile(join(workspace, "PROMETHEUS.md"), "utf8"); } catch { throw localError("invalid_arguments", "The workspace needs PROMETHEUS.md."); }
  try { goal = await readFile(goalPath, "utf8"); } catch { throw localError("invalid_arguments", `The goal file could not be read: ${input.goalPath}`); }
  if (!goal.trim()) throw localError("invalid_arguments", "The goal file is empty.");
  const policy = parsePrometheusPolicy(policyRaw);
  assertPrometheusGoalUnaddressed(goal);
  return { workspace, policy, goal, goalPath };
}

function newRun(paths: PrometheusPaths, input: StartPrometheusInput, policy: PrometheusPolicy, goal: string, goalPath: string, now: Date): PrometheusRunState {
  const runId = `run_${now.toISOString().replace(/[-:.TZ]/g, "")}_${randomUUID().slice(0, 8)}`;
  const createdAt = now.toISOString();
  const deadlineAt = new Date(now.getTime() + input.timeoutMs).toISOString();
  return {
    schema_version: 2,
    run_id: runId,
    workspace_key: paths.workspaceKey,
    workspace_path: paths.workspacePath,
    configuration: {
      model: input.model,
      goal_path: goalPath,
      goal_sha256: hash(goal),
      policy_sha256: policy.sha256,
      check_command: input.check,
      goal_request_body: { content: goal, until: [`at ${deadlineAt}`] },
    },
    startup_checkpoint: "reserved",
    room: null,
    roster: null,
    idempotency_keys: {
      room: randomUUID(),
      goal: randomUUID(),
      roles: { coordinator: randomUUID(), builder: randomUUID(), reviewer: randomUUID() },
      kickoff: randomUUID(),
    },
    deadline_at: deadlineAt,
    monitor: null,
    cancel_requested: false,
    outcome: "starting",
    candidate: null,
    checks: [],
    effects: [],
    pending_close: null,
    created_at: createdAt,
    updated_at: createdAt,
    finished_at: null,
    reason: null,
  };
}

async function saveCheckpoint(paths: PrometheusPaths, run: PrometheusRunState, changes: Partial<PrometheusRunState>, now: Date): Promise<PrometheusRunState> {
  const next = { ...run, ...changes, updated_at: timestampAfter(run.updated_at, now) };
  await writeRun(paths, next);
  const authoritative = await readActiveRun(paths);
  if (!authoritative || authoritative.run_id !== run.run_id) {
    throw localError("prometheus_monitor_lease_lost", `Prometheus run ${run.run_id} is no longer active.`);
  }
  return authoritative;
}

function requestBodySha256(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

interface PreparedEffectInput {
  effectId: string;
  path: string;
  body: unknown;
  idempotencyKey?: string;
  pendingClose?: Omit<PrometheusPendingClose, "effect_id" | "prepared_at">;
}

async function prepareEffect(
  run: PrometheusRunState,
  input: PreparedEffectInput,
  dependencies: Pick<StartupDependencies, "paths" | "now">,
): Promise<{ run: PrometheusRunState; effect: PrometheusEffectJournalEntry }> {
  const bodySha256 = requestBodySha256(input.body);
  const existing = run.effects.find((entry) => entry.effect_id === input.effectId);
  if (existing) {
    if (
      existing.path !== input.path ||
      existing.method !== "POST" ||
      existing.body_sha256 !== bodySha256 ||
      JSON.stringify(existing.body) !== JSON.stringify(input.body) ||
      (input.idempotencyKey !== undefined && existing.idempotency_key !== input.idempotencyKey)
    ) {
      throw localError("prometheus_effect_conflict", `Prometheus effect ${input.effectId} was already prepared with a different request.`);
    }
    return { run, effect: existing };
  }
  const createdAt = timestampAfter(run.updated_at, dependencies.now());
  const effect: PrometheusEffectJournalEntry = {
    effect_id: input.effectId,
    method: "POST",
    path: input.path,
    idempotency_key: input.idempotencyKey ?? randomUUID(),
    body: input.body,
    body_sha256: bodySha256,
    status: "pending",
    created_at: createdAt,
    committed_at: null,
  };
  const pendingClose = input.pendingClose === undefined
    ? run.pending_close
    : { effect_id: effect.effect_id, ...input.pendingClose, prepared_at: createdAt };
  const prepared = await saveCheckpoint(dependencies.paths, run, {
    effects: [...run.effects, effect],
    pending_close: pendingClose,
  }, new Date(createdAt));
  return { run: prepared, effect: prepared.effects.at(-1)! };
}

async function commitEffect(
  run: PrometheusRunState,
  effectId: string,
  dependencies: Pick<StartupDependencies, "paths" | "now">,
): Promise<PrometheusRunState> {
  const index = run.effects.findIndex((entry) => entry.effect_id === effectId);
  if (index < 0) throw localError("prometheus_effect_missing", `Prometheus effect ${effectId} is missing.`);
  if (run.effects[index]!.status === "committed") return run;
  const committedAt = timestampAfter(run.updated_at, dependencies.now());
  const effects = run.effects.map((entry, candidate) => candidate === index
    ? { ...entry, status: "committed" as const, committed_at: committedAt }
    : entry);
  return saveCheckpoint(dependencies.paths, run, { effects }, new Date(committedAt));
}

async function performEffect<T>(
  run: PrometheusRunState,
  input: PreparedEffectInput,
  credential: string,
  client: ApiClient,
  dependencies: Pick<StartupDependencies, "paths" | "now">,
  signal?: AbortSignal,
): Promise<{ run: PrometheusRunState; response: T }> {
  const prepared = await prepareEffect(run, input, dependencies);
  const response = await client.request<T>(
    "POST",
    prepared.effect.path,
    credential,
    prepared.effect.body,
    { "idempotency-key": prepared.effect.idempotency_key },
    signal,
  );
  const committed = await commitEffect(prepared.run, prepared.effect.effect_id, dependencies);
  return { run: committed, response };
}

async function readSavedInputs(run: PrometheusRunState): Promise<{ policy: PrometheusPolicy; goal: string }> {
  let policyRaw: string;
  let goal: string;
  try { policyRaw = await readFile(join(run.workspace_path, "PROMETHEUS.md"), "utf8"); } catch { throw localError("prometheus_policy_changed", "The saved run's PROMETHEUS.md is unavailable."); }
  try { goal = await readFile(run.configuration.goal_path, "utf8"); } catch { throw localError("prometheus_goal_changed", "The saved run's goal file is unavailable."); }
  const policy = parsePrometheusPolicy(policyRaw);
  assertPrometheusGoalUnaddressed(goal);
  if (policy.sha256 !== run.configuration.policy_sha256) throw localError("prometheus_policy_changed", "PROMETHEUS.md changed after this run was reserved.");
  if (hash(goal) !== run.configuration.goal_sha256) throw localError("prometheus_goal_changed", "The goal file changed after this run was reserved.");
  return { policy, goal };
}

/** Reserve, create and seed one fresh compiled Room. Monitoring continues in the same process. */
export async function startPrometheusRun(input: StartPrometheusInput, dependencies: PrometheusDependencies): Promise<PrometheusRunState> {
  // Local policy and goal validation deliberately precede credentials, Docker and HTTP.
  const loaded = await readInputs(input);
  const paths = await prometheusPaths(dependencies.env, loaded.workspace);
  const existing = await readTeam(paths);
  if (existing && existing.model !== input.model) throw localError("prometheus_model_mismatch", `This workspace's Prometheus team uses ${existing.model}; local v1 cannot change it.`);
  const plan = dependencies.plan ?? await dependencies.preparePlan?.();
  if (!plan) throw localError("prometheus_runtime_unavailable", "The Prometheus Docker runtime was not prepared.");
  const run = newRun(paths, input, loaded.policy, loaded.goal, loaded.goalPath, dependencies.now());
  await reserveActiveRun(paths, run, dependencies.processProbe ?? systemProcessProbe);
  return continuePrometheusRun(run, loaded, existing, { ...dependencies, plan, paths });
}

interface MonitorDependencies extends PrometheusDependencies {
  plan: RunPlan;
  paths: PrometheusPaths;
  team: PrometheusTeamState;
  connection: PrometheusConnection;
}

interface StartupDependencies extends PrometheusDependencies {
  plan: RunPlan;
  paths: PrometheusPaths;
}

async function finishStoppedRun(
  initial: PrometheusRunState,
  lease: NonNullable<PrometheusRunState["monitor"]>,
  dependencies: Pick<StartupDependencies, "paths" | "now"> & { connection?: PrometheusConnection },
): Promise<PrometheusRunState> {
  let run = initial;
  const outcome = run.cancel_requested ? "cancelled" : "timed_out";
  if (run.room && dependencies.connection) {
    const body = { trigger: `prometheus_${outcome}`, detail: run.run_id };
    const closed = await performEffect(
      run,
      {
        effectId: `close.${outcome}`,
        path: `/rooms/${encodeURIComponent(run.room.room_id)}/close`,
        body,
        pendingClose: { outcome, revision_sha256: null, expected: null },
      },
      dependencies.connection.apiKey,
      dependencies.connection.client,
      dependencies,
    );
    run = await saveCheckpoint(dependencies.paths, closed.run, { pending_close: null }, dependencies.now());
  }
  const finishedAt = timestampAfter(run.updated_at, dependencies.now());
  const final: PrometheusRunState = {
    ...run,
    monitor: lease,
    outcome,
    updated_at: finishedAt,
    finished_at: finishedAt,
    reason: outcome === "cancelled" ? "Cancellation requested." : "The original deadline passed.",
  };
  await finishRun(dependencies.paths, final, lease);
  return final;
}

async function finishFailedRun(
  run: PrometheusRunState,
  lease: NonNullable<PrometheusRunState["monitor"]>,
  failure: ReturnType<typeof asCliError>,
  dependencies: Pick<StartupDependencies, "paths" | "now"> & { connection?: PrometheusConnection },
): Promise<PrometheusRunState> {
  if (run.room && dependencies.connection && failure.code !== "prometheus_room_closed") {
    await dependencies.connection.client.request(
      "POST", `/rooms/${encodeURIComponent(run.room.room_id)}/close`, dependencies.connection.apiKey,
      { trigger: "prometheus_failed", detail: run.run_id },
      { "idempotency-key": `${run.run_id}-close-failed` },
    ).catch(() => undefined);
  }
  const finishedAt = timestampAfter(run.updated_at, dependencies.now());
  const final: PrometheusRunState = {
    ...run,
    monitor: lease,
    outcome: "failed",
    updated_at: finishedAt,
    finished_at: finishedAt,
    reason: `${failure.code}: ${failure.message}`.slice(0, 4_000),
  };
  await finishRun(dependencies.paths, final, lease);
  return final;
}

async function finishRecoveredSuccess(
  run: PrometheusRunState,
  lease: NonNullable<PrometheusRunState["monitor"]>,
  dependencies: Pick<StartupDependencies, "paths" | "now">,
): Promise<PrometheusRunState> {
  const revision = run.candidate!.revision_sha256;
  const finishedAt = timestampAfter(run.updated_at, dependencies.now());
  const final: PrometheusRunState = {
    ...run,
    monitor: lease,
    outcome: "succeeded",
    updated_at: finishedAt,
    finished_at: finishedAt,
    reason: `Recovered committed Prometheus success for ${revision}.`,
  };
  await finishRun(dependencies.paths, final, lease);
  return final;
}

async function reloadActive(
  runId: string,
  dependencies: Pick<StartupDependencies, "paths">,
): Promise<PrometheusRunState> {
  const current = await readActiveRun(dependencies.paths);
  if (!current || current.run_id !== runId) {
    throw localError("prometheus_monitor_lease_lost", `Prometheus run ${runId} is no longer active.`);
  }
  return current;
}

function watchRunStop(
  run: PrometheusRunState,
  paths: PrometheusPaths,
  now: () => Date,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const remainingMs = Math.max(0, Date.parse(run.deadline_at) - now().getTime());
  const deadline = setTimeout(() => controller.abort(), remainingMs);
  deadline.unref?.();
  let reading = false;
  const poll = setInterval(() => {
    if (reading || controller.signal.aborted) return;
    reading = true;
    void readActiveRun(paths).then((current) => {
      if (!current || current.run_id !== run.run_id || current.cancel_requested) controller.abort();
    }).catch(() => undefined).finally(() => { reading = false; });
  }, 50);
  poll.unref?.();
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(deadline); clearInterval(poll); },
  };
}

async function whileRunActive<T>(
  run: PrometheusRunState,
  dependencies: Pick<StartupDependencies, "paths" | "now">,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const stop = watchRunStop(run, dependencies.paths, dependencies.now);
  try {
    return await operation(stop.signal);
  } finally {
    stop.dispose();
  }
}

function dockerWithSignal(docker: DockerRunner, signal: AbortSignal): DockerRunner {
  return (args, options) => docker(args, { ...options, signal });
}

async function stopOrRecover(
  run: PrometheusRunState,
  lease: NonNullable<PrometheusRunState["monitor"]>,
  dependencies: Pick<StartupDependencies, "paths" | "now"> & { connection?: PrometheusConnection },
): Promise<PrometheusRunState | null> {
  if (!run.cancel_requested && dependencies.now().getTime() < Date.parse(run.deadline_at)) return null;
  if (run.room && run.candidate && dependencies.connection) {
    const lifecycle = await roomLifecycle(run, { connection: dependencies.connection });
    if (lifecycle.state !== "open" && lifecycle.endedBy?.trigger === "prometheus_success" && lifecycle.endedBy.detail === run.candidate.revision_sha256) {
      return finishRecoveredSuccess(run, lease, dependencies);
    }
  }
  return finishStoppedRun(run, lease, dependencies);
}

async function continuePrometheusRun(
  initial: PrometheusRunState,
  loaded: { policy: PrometheusPolicy; goal: string },
  savedTeam: PrometheusTeamState | null,
  dependencies: StartupDependencies,
): Promise<PrometheusRunState> {
  const lease = await claimMonitor(dependencies.paths, initial.run_id, dependencies.processProbe ?? systemProcessProbe);
  const persistedRun = await readActiveRun(dependencies.paths);
  if (!persistedRun || persistedRun.run_id !== initial.run_id) throw localError("prometheus_monitor_lease_lost", `Prometheus run ${initial.run_id} is no longer active.`);
  let run: PrometheusRunState = persistedRun;

  if (run.cancel_requested || dependencies.now().getTime() >= Date.parse(run.deadline_at)) {
    const connection = run.room ? await dependencies.connect() : undefined;
    return (await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, ...(connection ? { connection } : {}) }))!;
  }

  const existing = savedTeam ?? await readTeam(dependencies.paths);
  let team: PrometheusTeamState;
  const bootstrapStop = watchRunStop(run, dependencies.paths, dependencies.now);
  try {
    if (run.startup_checkpoint !== "reserved" && !existing) {
      throw localError("prometheus_team_missing", "The active Prometheus run has no saved team.");
    }
    team = await ensurePrometheusTeam({
      workspaceKey: dependencies.paths.workspaceKey,
      workspacePath: dependencies.paths.workspacePath,
      model: run.configuration.model,
      policySha256: loaded.policy.sha256,
      policy: loaded.policy.raw,
      plan: dependencies.plan,
      deadlineAt: run.deadline_at,
      existing,
    }, {
      docker: (args, options) => dependencies.docker(args, { ...options, signal: bootstrapStop.signal }),
      now: dependencies.now,
      sleep: dependencies.sleep,
    });
  } catch (error) {
    const current = await reloadActive(run.run_id, dependencies);
    const stopConnection = current.room ? await dependencies.connect() : undefined;
    const stopped = await stopOrRecover(current, lease, {
      paths: dependencies.paths,
      now: dependencies.now,
      ...(stopConnection ? { connection: stopConnection } : {}),
    });
    if (stopped) return stopped;
    const failure = asCliError(error);
    if (!["prometheus_team_invalid", "prometheus_team_missing", "prometheus_team_mismatch"].includes(failure.code)) throw error;
    const connection = run.room ? await dependencies.connect().catch(() => undefined) : undefined;
    return finishFailedRun(run, lease, failure, { paths: dependencies.paths, now: dependencies.now, ...(connection ? { connection } : {}) });
  } finally {
    bootstrapStop.dispose();
  }
  await writeTeam(dependencies.paths, team);
  run = await reloadActive(run.run_id, dependencies);
  const bootstrapConnection = run.room ? await dependencies.connect() : undefined;
  const stoppedAfterBootstrap = await stopOrRecover(run, lease, {
    paths: dependencies.paths,
    now: dependencies.now,
    ...(bootstrapConnection ? { connection: bootstrapConnection } : {}),
  });
  if (stoppedAfterBootstrap) return stoppedAfterBootstrap;
  const connection = bootstrapConnection ?? await dependencies.connect();
  run = await reloadActive(run.run_id, dependencies);
  const stoppedAfterConnect = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
  if (stoppedAfterConnect) return stoppedAfterConnect;

  try {
    if (run.startup_checkpoint === "reserved") {
      const created = await whileRunActive(run, dependencies, (signal) => performEffect<{ room?: { id?: string } }>(
        run,
        {
          effectId: "room.create",
          path: "/rooms",
          body: { name: `Prometheus ${basename(dependencies.paths.workspacePath)}`, type: "compiled" },
          idempotencyKey: run.idempotency_keys.room,
        },
        connection.memberToken,
        connection.client,
        dependencies,
        signal,
      ));
      run = created.run;
      const roomId = created.response.room?.id;
      if (!roomId) throw localError("invalid_server_response", "The compiled Prometheus Room id did not come back.");
      run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "room_created", room: { room_id: roomId, goal_sequence: null, kickoff_sequence: null } }, dependencies.now());
      const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
      if (stopped) return stopped;
    }

    if (run.startup_checkpoint === "room_created") {
      const started = await whileRunActive(run, dependencies, (signal) => performEffect<{ message?: { sequence?: number } }>(
        run,
        {
          effectId: "goal.start",
          path: `/rooms/${encodeURIComponent(run.room!.room_id)}/goal`,
          body: run.configuration.goal_request_body,
          idempotencyKey: run.idempotency_keys.goal,
        },
        connection.apiKey,
        connection.client,
        dependencies,
        signal,
      ));
      run = started.run;
      const goalSequence = started.response.message?.sequence;
      if (!Number.isSafeInteger(goalSequence) || goalSequence! < 1) throw localError("invalid_server_response", "The Prometheus Goal sequence did not come back.");
      run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "goal_started", room: { ...run.room!, goal_sequence: goalSequence! } }, dependencies.now());
      const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
      if (stopped) return stopped;
    }

    if (run.startup_checkpoint === "goal_started") {
      const invite = await whileRunActive(run, dependencies, (signal) =>
        connection.client.request<{ token?: string }>(
          "POST", `/rooms/${encodeURIComponent(run.room!.room_id)}/invites`, connection.memberToken, undefined,
          { "idempotency-key": `${run.idempotency_keys.room}-invite` },
          signal,
        ));
      if (!invite.token) throw localError("invalid_server_response", "The Prometheus Room invite did not come back.");
      const inviteToken = invite.token;
      run = await reloadActive(run.run_id, dependencies);
      const stoppedAfterInvite = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
      if (stoppedAfterInvite) return stoppedAfterInvite;
      const roster = await whileRunActive(run, dependencies, (signal) => attachPrometheusRoom(team, {
        roomId: run.room!.room_id,
        inviteToken,
        baseUrl: connection.baseUrl,
        idempotencyKeys: run.idempotency_keys.roles,
      }, { docker: dockerWithSignal(dependencies.docker, signal), now: dependencies.now, sleep: dependencies.sleep }));
      run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "roles_joined", roster }, dependencies.now());
      const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
      if (stopped) return stopped;
    }

    if (run.startup_checkpoint === "roles_joined") {
      await whileRunActive(run, dependencies, (signal) => ensurePrometheusListeners(team, run.room!.room_id, run.roster!, connection.baseUrl, { docker: dockerWithSignal(dependencies.docker, signal), now: dependencies.now, sleep: dependencies.sleep }));
      run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "listeners_ready" }, dependencies.now());
      const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
      if (stopped) return stopped;
    }

    if (run.startup_checkpoint === "listeners_ready") {
      const content = prometheusKickoff({
        runId: run.run_id,
        goalSequence: run.room!.goal_sequence!,
        roster: run.roster!,
        policy: loaded.policy,
        goalSha256: run.configuration.goal_sha256,
        check: run.configuration.check_command,
        deadlineAt: run.deadline_at,
      });
      const kicked = await whileRunActive(run, dependencies, (signal) => performEffect<{ message?: { sequence?: number } }>(
        run,
        {
          effectId: "kickoff.post",
          path: `/rooms/${encodeURIComponent(run.room!.room_id)}/owner-messages`,
          body: { content, as: "runner" },
          idempotencyKey: run.idempotency_keys.kickoff,
        },
        connection.apiKey,
        connection.client,
        dependencies,
        signal,
      ));
      run = kicked.run;
      const kickoffSequence = kicked.response.message?.sequence;
      if (!Number.isSafeInteger(kickoffSequence) || kickoffSequence! <= run.room!.goal_sequence!) throw localError("invalid_server_response", "The Prometheus kickoff sequence did not come back.");
      run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "kickoff_posted", outcome: "running", room: { ...run.room!, kickoff_sequence: kickoffSequence! } }, dependencies.now());
    }
  } catch (error) {
    const current = await reloadActive(run.run_id, dependencies);
    const stopped = await stopOrRecover(current, lease, {
      paths: dependencies.paths,
      now: dependencies.now,
      connection,
    });
    if (stopped) return stopped;
    throw error;
  }

  return monitorPrometheusRun(run, { ...dependencies, team, connection });
}

/** Read the complete ordered Room log; completion receipts may be later than the first page. */
export async function readPrometheusMessages(
  client: ApiClient,
  roomId: string,
  memberToken: string,
  signal?: AbortSignal,
): Promise<PrometheusMessage[]> {
  const messages: PrometheusMessage[] = [];
  let after = 0;
  for (;;) {
    const page = await client.request<{ items?: PrometheusMessage[]; has_more?: boolean }>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/messages?after=${after}&order=asc&limit=100`,
      memberToken,
      undefined,
      {},
      signal,
    );
    if (!Array.isArray(page.items) || typeof page.has_more !== "boolean") {
      throw localError("prometheus_history_incomplete", "The Prometheus Room history is incomplete.");
    }
    let cursor = after;
    for (const message of page.items) {
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= cursor) {
        throw localError("prometheus_history_incomplete", "The Prometheus Room history is malformed or out of order.");
      }
      cursor = message.sequence;
    }
    messages.push(...page.items);
    if (!page.has_more) return messages;
    if (cursor <= after) throw localError("prometheus_history_incomplete", "Prometheus Room pagination did not advance.");
    after = cursor;
  }
}

interface RoomLifecycle {
  state: string;
  endedBy: { trigger: string; detail: string | null } | null;
}

async function roomLifecycle(
  run: PrometheusRunState,
  dependencies: Pick<MonitorDependencies, "connection"> & { signal?: AbortSignal },
): Promise<RoomLifecycle> {
  const roomId = run.room!.room_id;
  const response = await dependencies.connection.client.request<{ room?: { state?: unknown; goal?: { ended_by?: { trigger?: unknown; detail?: unknown } | null } | null } }>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}`,
    dependencies.connection.memberToken,
    undefined,
    {},
    dependencies.signal,
  );
  const state = response.room?.state;
  const ended = response.room?.goal?.ended_by;
  if (typeof state !== "string") throw localError("invalid_server_response", "The Prometheus Room state did not come back.");
  const endedBy = ended && typeof ended.trigger === "string" && (typeof ended.detail === "string" || ended.detail === null)
    ? { trigger: ended.trigger, detail: ended.detail }
    : null;
  return { state, endedBy };
}

async function snapshot(run: PrometheusRunState, dependencies: MonitorDependencies, signal?: AbortSignal) {
  const roomId = run.room!.room_id;
  const state = await dependencies.connection.client.request<CompiledState>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/state`,
    dependencies.connection.memberToken,
    undefined,
    {},
    signal,
  );
  const messages = await readPrometheusMessages(dependencies.connection.client, roomId, dependencies.connection.memberToken, signal);
  const protocolRoster = {
    coordinator: { memberId: run.roster!.coordinator.member_id },
    builder: { memberId: run.roster!.builder.member_id },
    reviewer: { memberId: run.roster!.reviewer.member_id },
  };
  const candidate = parsePrometheusCandidate(state, protocolRoster);
  const receipts = candidate.ok ? parseTerminalReceipts(messages, protocolRoster, run.run_id, candidate.candidate.revisionSha256) : { ok: false as const, receipts: {}, missingRoles: [...PROMETHEUS_ROLES] };
  const docker = signal ? dockerWithSignal(dependencies.docker, signal) : dependencies.docker;
  const runtime = await inspectPrometheusRuntime(dependencies.team, roomId, run.roster!, { docker, baseUrl: dependencies.connection.baseUrl });
  return { state, candidate, receipts, runtime, barrier: evaluatePrometheusBarrier({ candidate, receipts, runtime }) };
}

function sameReady(left: PrometheusBarrierResult, right: PrometheusBarrierResult): boolean {
  return left.ready && right.ready && left.candidate.stateDigest === right.candidate.stateDigest && left.candidate.revisionSha256 === right.candidate.revisionSha256 && JSON.stringify(left.receipts) === JSON.stringify(right.receipts);
}

export async function monitorPrometheusRun(run: PrometheusRunState, dependencies: MonitorDependencies): Promise<PrometheusRunState> {
  const lease = await claimMonitor(dependencies.paths, run.run_id, dependencies.processProbe ?? systemProcessProbe);
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const feedbackAttempted = new Set<string>();
  const candidateAnnounced = new Set<string>();
  try {
    for (;;) {
      const current = await reloadActive(run.run_id, dependencies);
      const now = dependencies.now();
      if (current.cancel_requested || now.getTime() >= Date.parse(current.deadline_at)) {
        return (await stopOrRecover(current, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection }))!;
      }
      const lifecycle = await whileRunActive(current, dependencies, (signal) => roomLifecycle(current, { connection: dependencies.connection, signal }));
      if (lifecycle.state !== "open") {
        if (current.candidate && lifecycle.endedBy?.trigger === "prometheus_success" && lifecycle.endedBy.detail === current.candidate.revision_sha256) {
          return finishRecoveredSuccess(current, lease, dependencies);
        }
        throw localError("prometheus_room_closed", "The Prometheus Room closed before the completion barrier passed.");
      }
      const afterLifecycle = await reloadActive(current.run_id, dependencies);
      const stoppedAfterLifecycle = await stopOrRecover(afterLifecycle, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
      if (stoppedAfterLifecycle) return stoppedAfterLifecycle;
      const observed = await whileRunActive(afterLifecycle, dependencies, (signal) => snapshot(afterLifecycle, dependencies, signal));
      const afterSnapshot = await reloadActive(current.run_id, dependencies);
      const stoppedAfterSnapshot = await stopOrRecover(afterSnapshot, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
      if (stoppedAfterSnapshot) return stoppedAfterSnapshot;
      const pinned = await whileRunActive(afterSnapshot, dependencies, async (signal) => observed.candidate.ok
          ? await materializePrometheusArtifactSnapshot(
            observed.candidate.candidate.artifacts,
            dependencies.connection.client,
            dependencies.connection.memberToken,
            join(dependencies.paths.runDir(afterSnapshot.run_id), "artifact-snapshots", observed.candidate.candidate.revisionSha256),
            signal,
          )
          : null);
      let active = await reloadActive(current.run_id, dependencies);
      const stoppedAfterPin = await stopOrRecover(active, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
      if (stoppedAfterPin) return stoppedAfterPin;
      run = active;
      if (observed.candidate.ok && !observed.receipts.ok && !candidateAnnounced.has(observed.candidate.candidate.revisionSha256)) {
        const revision = observed.candidate.candidate.revisionSha256;
        const content = prometheusCandidateHandoff(active.run_id, active.roster!, observed.candidate.candidate, pinned!.sha256);
        await whileRunActive(active, dependencies, (signal) => dependencies.connection.client.request(
          "POST",
          `/rooms/${encodeURIComponent(active.room!.room_id)}/owner-messages`,
          dependencies.connection.apiKey,
          { content, as: "runner" },
          { "idempotency-key": `${active.run_id}-candidate-${revision}` },
          signal,
        ));
        candidateAnnounced.add(revision);
        active = await reloadActive(current.run_id, dependencies);
        const stoppedAfterAnnouncement = await stopOrRecover(active, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
        if (stoppedAfterAnnouncement) return stoppedAfterAnnouncement;
      }
      if (observed.barrier.ready) {
        const revision = observed.barrier.candidate.revisionSha256;
        const prior = active.checks.find((entry) => entry.revision_sha256 === revision);
        if (pinned === null) throw localError("prometheus_artifact_snapshot_invalid", "The ready candidate has no artifact snapshot.");
        if (prior && prior.artifact_snapshot_sha256 !== pinned.sha256) {
          throw localError("prometheus_artifact_snapshot_invalid", "The saved semantic check names a different artifact snapshot.");
        }
        let passingCheck = prior?.exit_code === 0;
        if (!prior) {
          const checkStop = watchRunStop(active, dependencies.paths, dependencies.now);
          let checked: Awaited<ReturnType<typeof runPrometheusCheck>>;
          try {
            checked = await runPrometheusCheck({ image: dependencies.plan.image, snapshot: pinned.path, snapshotSha256: pinned.sha256 }, active.configuration.check_command, {
              SHAREDNET_PROMETHEUS_RUN_ID: active.run_id,
              SHAREDNET_PROMETHEUS_WORK_ID: observed.barrier.candidate.workId,
              SHAREDNET_PROMETHEUS_RESULT_REF: observed.barrier.candidate.resultRef,
              SHAREDNET_PROMETHEUS_REVISION_SHA256: revision,
              SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256: pinned.sha256,
            }, {
              docker: dependencies.docker,
              now: dependencies.now,
              timeoutMs: Math.min(120_000, Date.parse(active.deadline_at) - dependencies.now().getTime()),
              signal: checkStop.signal,
            });
          } finally {
            checkStop.dispose();
          }
          const afterCheck = await reloadActive(current.run_id, dependencies);
          const stoppedAfterCheck = await stopOrRecover(afterCheck, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
          if (stoppedAfterCheck) return stoppedAfterCheck;
          if (checked.exitCode === 125) throw localError("prometheus_check_launch_failed", "The Prometheus semantic-check container could not be launched.");
          const summary = { revision_sha256: revision, artifact_snapshot_sha256: pinned.sha256, started_at: checked.startedAt, finished_at: checked.finishedAt, exit_code: Math.max(0, checked.exitCode), output: checked.output, output_sha256: checked.outputSha256 };
          run = await saveCheckpoint(dependencies.paths, afterCheck, { monitor: lease, checks: [...afterCheck.checks, summary] }, dependencies.now());
          const stoppedAfterCheckCheckpoint = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
          if (stoppedAfterCheckCheckpoint) return stoppedAfterCheckCheckpoint;
          if (checked.exitCode !== 0) {
            const feedback = `@${current.roster!.coordinator.member_id} Semantic check failed for revision ${revision}:\n${checked.output.slice(-2_000)}`;
            await whileRunActive(run, dependencies, (signal) => dependencies.connection.client.request("POST", `/rooms/${encodeURIComponent(current.room!.room_id)}/owner-messages`, dependencies.connection.apiKey, { content: feedback, as: "runner" }, { "idempotency-key": `${current.run_id}-check-${revision}` }, signal));
            feedbackAttempted.add(revision);
          } else {
            passingCheck = true;
          }
        } else if (prior.exit_code !== 0 && !feedbackAttempted.has(revision)) {
          const feedback = `@${current.roster!.coordinator.member_id} Semantic check failed for revision ${revision}:\n${prior.output.slice(-2_000)}`;
          await whileRunActive(active, dependencies, (signal) => dependencies.connection.client.request("POST", `/rooms/${encodeURIComponent(current.room!.room_id)}/owner-messages`, dependencies.connection.apiKey, { content: feedback, as: "runner" }, { "idempotency-key": `${current.run_id}-check-${revision}` }, signal));
          feedbackAttempted.add(revision);
        }
        if (passingCheck) {
          const after = await whileRunActive(run, dependencies, (signal) => snapshot(run, dependencies, signal));
          const beforeSuccess = await reloadActive(current.run_id, dependencies);
          const stoppedBeforeSuccess = await stopOrRecover(beforeSuccess, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
          if (stoppedBeforeSuccess) return stoppedBeforeSuccess;
          if (sameReady(observed.barrier, after.barrier)) {
            const observedAt = timestampAfter(beforeSuccess.updated_at, dependencies.now());
            run = await saveCheckpoint(dependencies.paths, beforeSuccess, {
              monitor: lease,
              candidate: { compiled_digest: observed.barrier.candidate.stateDigest, work_id: observed.barrier.candidate.workId, result_ref: observed.barrier.candidate.resultRef, revision_sha256: revision, observed_at: observedAt },
            }, dependencies.now());
            run = await reloadActive(run.run_id, dependencies);
            const stoppedImmediatelyBeforeSuccess = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
            if (stoppedImmediatelyBeforeSuccess) return stoppedImmediatelyBeforeSuccess;
            const closed = await whileRunActive(run, dependencies, (signal) => dependencies.connection.client.request<{ room?: { state?: unknown; goal?: { ended_by?: { trigger?: unknown; detail?: unknown } | null } | null } }>(
              "POST",
              `/rooms/${encodeURIComponent(current.room!.room_id)}/close`,
              dependencies.connection.apiKey,
              { trigger: "prometheus_success", detail: revision },
              { "idempotency-key": `${current.run_id}-close-success` },
              signal,
            ));
            if (closed.room?.state !== "closed" || closed.room.goal?.ended_by?.trigger !== "prometheus_success" || closed.room.goal.ended_by.detail !== revision) {
              throw localError("prometheus_success_unconfirmed", "SharedNet did not confirm the exact Prometheus success close.");
            }
            const finishedAt = timestampAfter(run.updated_at, dependencies.now());
            const final: PrometheusRunState = { ...run, monitor: lease, outcome: "succeeded", updated_at: finishedAt, finished_at: finishedAt, reason: `Prometheus completion barrier passed for ${revision}.` };
            await finishRun(dependencies.paths, final, lease);
            return final;
          }
        }
      }
      await sleep(1_000);
    }
  } catch (error) {
    const failure = asCliError(error);
    if (failure.code === "prometheus_monitor_active" || failure.code === "prometheus_monitor_lease_lost") throw error;
    // The close may have committed even when its response was lost or malformed. Keep the
    // candidate durable so resume can reconcile authoritative Room ended_by before any stop.
    if (failure.code === "prometheus_success_unconfirmed") throw error;
    const current = await reloadActive(run.run_id, dependencies);
    const stopped = await stopOrRecover(current, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
    if (stopped) return stopped;
    // Transport and service failures do not prove the Room or run is invalid.
    // Keep the durable run active so a later `prometheus resume` can reclaim it.
    if (failure.exitCode === 5) throw failure;
    return finishFailedRun(current, lease, failure, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
  }
}

type PrometheusStatusDependencies = Pick<PrometheusDependencies, "docker" | "plan" | "connect" | "processProbe">;

export async function prometheusStatus(
  workspace: string,
  env: Record<string, string | undefined>,
  dependencies?: PrometheusStatusDependencies,
) {
  const paths = await prometheusPaths(env, workspace);
  const [team, run] = await Promise.all([readTeam(paths), readActiveRun(paths)]);
  const base = { workspace: paths.workspacePath, team: team ? { model: team.model, roles: PROMETHEUS_ROLES } : null, run };
  if (!run) return base;
  const monitor = run.monitor === null
    ? { state: "none" as const, pid: null, claimed_at: null, renewed_at: null }
    : {
        state: inspectProcessIdentity(dependencies?.processProbe ?? systemProcessProbe, run.monitor),
        pid: run.monitor.pid,
        claimed_at: run.monitor.claimed_at,
        renewed_at: run.monitor.renewed_at,
      };
  if (!dependencies) {
    return { ...base, monitor, live: { available: false, reason: "Live inspection was not attempted." } };
  }
  if (!team || !dependencies.plan || !run.room || !run.roster || run.startup_checkpoint !== "kickoff_posted") {
    return { ...base, monitor, live: { available: false, reason: "The run has not reached a live inspectable checkpoint." } };
  }
  try {
    await verifyPrometheusTeamIdentity({
      workspaceKey: paths.workspaceKey,
      workspacePath: paths.workspacePath,
      model: team.model,
      policySha256: team.last_policy_sha256,
      policy: "",
      plan: dependencies.plan,
      existing: team,
    }, { docker: dependencies.docker });
    const connection = await dependencies.connect();
    const monitorDependencies = { ...dependencies, env, cwd: paths.workspacePath, now: () => new Date(), plan: dependencies.plan, paths, team, connection };
    const lifecycle = await roomLifecycle(run, monitorDependencies);
    if (lifecycle.state !== "open") return { ...base, monitor, live: { available: true, room_state: lifecycle.state, ended_by: lifecycle.endedBy } };
    const observed = await snapshot(run, monitorDependencies);
    return { ...base, monitor, live: { available: true, room_state: lifecycle.state, runtime: observed.runtime, barrier: observed.barrier } };
  } catch (error) {
    const failure = asCliError(error);
    return { ...base, monitor, live: { available: false, error: { code: failure.code, message: failure.message } } };
  }
}

type PrometheusCancelDependencies = Pick<PrometheusDependencies, "env" | "cwd" | "now" | "connect" | "processProbe">;

export async function cancelPrometheusRun(workspace: string, dependencies: PrometheusCancelDependencies) {
  const paths = await prometheusPaths(dependencies.env, workspace);
  const active = await readActiveRun(paths);
  if (!active) return { cancelled: false, active: false };
  await requestCancel(paths, active.run_id);
  try {
    const lease = await claimMonitor(paths, active.run_id, dependencies.processProbe ?? systemProcessProbe);
    const current = await readActiveRun(paths);
    if (!current) return { cancelled: true, active: false, recovered: false, run_id: active.run_id };
    const connection = current.room ? await dependencies.connect() : undefined;
    const final = (await stopOrRecover(current, lease, { paths, now: dependencies.now, ...(connection ? { connection } : {}) }))!;
    return { cancelled: true, active: false, recovered: true, run_id: active.run_id, outcome: final.outcome };
  } catch (error) {
    const failure = asCliError(error);
    if (failure.code === "prometheus_run_not_active" && (await readActiveRun(paths)) === null) {
      return { cancelled: true, active: false, recovered: false, run_id: active.run_id };
    }
    if (failure.code !== "prometheus_monitor_active") throw error;
    return { cancelled: true, active: true, recovered: false, run_id: active.run_id };
  }
}

/** Take over a fully seeded run without recreating its Room, seats, threads, goal or kickoff. */
export async function resumePrometheusRun(workspace: string, dependencies: PrometheusDependencies): Promise<PrometheusRunState> {
  const paths = await prometheusPaths(dependencies.env, workspace);
  const run = await readActiveRun(paths);
  if (!run) throw localError("prometheus_run_not_active", "This workspace has no active Prometheus run to resume.");
  const team = await readTeam(paths);
  const plan = dependencies.plan ?? await dependencies.preparePlan?.();
  if (!plan) throw localError("prometheus_runtime_unavailable", "The Prometheus Docker runtime was not prepared.");
  const loaded = await readSavedInputs(run);
  return continuePrometheusRun(run, loaded, team, { ...dependencies, plan, paths });
}
