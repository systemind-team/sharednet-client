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
  type PrometheusMessage,
  type PrometheusPolicy,
  type TerminalReceiptResult,
} from "./prometheus-protocol.ts";
import {
  attachPrometheusRoom,
  ensurePrometheusListeners,
  ensurePrometheusTeam,
  inspectPrometheusRuntime,
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
    `Create compiled work for ${input.roster.builder.member_id} requiring deliverable submission and verified_by ${input.roster.reviewer.member_id}. The builder publishes work.result. The reviewer downloads the exact artifact, checks its SHA-256, uploads review evidence, then publishes verification.pass bound to the current result_ref. Resolve only the verified head; defects require a successor using supersedes.`,
    `Semantic check after the evidence barrier: ${input.check}`,
    `After the final head is resolved, request one receipt from builder and reviewer, then post yours. Exact line: [sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"${input.runId}","role":"<role>","revision_sha256":"<current 64-hex revision>"}`,
  ].join("\n\n");
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
  return {
    schema_version: 1,
    run_id: runId,
    workspace_key: paths.workspaceKey,
    workspace_path: paths.workspacePath,
    configuration: { model: input.model, goal_path: goalPath, goal_sha256: hash(goal), policy_sha256: policy.sha256, check_command: input.check },
    startup_checkpoint: "reserved",
    room: null,
    roster: null,
    idempotency_keys: { room: `${runId}-room`, goal: `${runId}-goal`, roles: { coordinator: `${runId}-coordinator`, builder: `${runId}-builder`, reviewer: `${runId}-reviewer` }, kickoff: `${runId}-kickoff` },
    deadline_at: new Date(now.getTime() + input.timeoutMs).toISOString(),
    monitor: null,
    cancel_requested: false,
    outcome: "starting",
    candidate: null,
    checks: [],
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
  run: PrometheusRunState,
  lease: NonNullable<PrometheusRunState["monitor"]>,
  dependencies: Pick<StartupDependencies, "paths" | "now"> & { connection?: PrometheusConnection },
): Promise<PrometheusRunState> {
  const outcome = run.cancel_requested ? "cancelled" : "timed_out";
  if (run.room && dependencies.connection) {
    await dependencies.connection.client.request(
      "POST",
      `/rooms/${encodeURIComponent(run.room.room_id)}/close`,
      dependencies.connection.apiKey,
      { trigger: `prometheus_${outcome}`, detail: run.run_id },
      { "idempotency-key": `${run.run_id}-close-${outcome}` },
    );
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
  let run = await readActiveRun(dependencies.paths);
  if (!run || run.run_id !== initial.run_id) throw localError("prometheus_monitor_lease_lost", `Prometheus run ${initial.run_id} is no longer active.`);

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
    const stopped = await stopOrRecover(current, lease, { paths: dependencies.paths, now: dependencies.now });
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
  const stoppedAfterBootstrap = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now });
  if (stoppedAfterBootstrap) return stoppedAfterBootstrap;
  const connection = await dependencies.connect();
  run = await reloadActive(run.run_id, dependencies);
  const stoppedAfterConnect = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
  if (stoppedAfterConnect) return stoppedAfterConnect;

  if (run.startup_checkpoint === "reserved") {
    const created = await connection.client.request<{ room?: { id?: string } }>(
      "POST", "/rooms", connection.memberToken,
      { name: `Prometheus ${basename(dependencies.paths.workspacePath)}`, type: "compiled" },
      { "idempotency-key": run.idempotency_keys.room },
    );
    const roomId = created.room?.id;
    if (!roomId) throw localError("invalid_server_response", "The compiled Prometheus Room id did not come back.");
    run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "room_created", room: { room_id: roomId, goal_sequence: null, kickoff_sequence: null } }, dependencies.now());
    const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
    if (stopped) return stopped;
  }

  if (run.startup_checkpoint === "room_created") {
    const remaining = Date.parse(run.deadline_at) - dependencies.now().getTime();
    const started = await connection.client.request<{ message?: { sequence?: number } }>(
      "POST", `/rooms/${encodeURIComponent(run.room!.room_id)}/goal`, connection.apiKey,
      { content: loaded.goal, until: [`after ${Math.max(1, Math.ceil(remaining / 1000))}s`] },
      { "idempotency-key": run.idempotency_keys.goal },
    );
    const goalSequence = started.message?.sequence;
    if (!Number.isSafeInteger(goalSequence) || goalSequence! < 1) throw localError("invalid_server_response", "The Prometheus Goal sequence did not come back.");
    run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "goal_started", room: { ...run.room!, goal_sequence: goalSequence! } }, dependencies.now());
    const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
    if (stopped) return stopped;
  }

  if (run.startup_checkpoint === "goal_started") {
    const invite = await connection.client.request<{ token?: string }>(
      "POST", `/rooms/${encodeURIComponent(run.room!.room_id)}/invites`, connection.memberToken, undefined,
      { "idempotency-key": `${run.idempotency_keys.room}-invite` },
    );
    if (!invite.token) throw localError("invalid_server_response", "The Prometheus Room invite did not come back.");
    run = await reloadActive(run.run_id, dependencies);
    const stoppedAfterInvite = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
    if (stoppedAfterInvite) return stoppedAfterInvite;
    const roster = await attachPrometheusRoom(team, {
      roomId: run.room!.room_id,
      inviteToken: invite.token,
      baseUrl: connection.baseUrl,
      idempotencyKeys: run.idempotency_keys.roles,
    }, { docker: dependencies.docker, now: dependencies.now, sleep: dependencies.sleep });
    run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "roles_joined", roster }, dependencies.now());
    const stopped = await stopOrRecover(run, lease, { paths: dependencies.paths, now: dependencies.now, connection });
    if (stopped) return stopped;
  }

  if (run.startup_checkpoint === "roles_joined") {
    await ensurePrometheusListeners(team, run.room!.room_id, run.roster!, connection.baseUrl, { docker: dependencies.docker, now: dependencies.now, sleep: dependencies.sleep });
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
    const kicked = await connection.client.request<{ message?: { sequence?: number } }>(
      "POST", `/rooms/${encodeURIComponent(run.room!.room_id)}/owner-messages`, connection.apiKey,
      { content, as: "runner" }, { "idempotency-key": run.idempotency_keys.kickoff },
    );
    const kickoffSequence = kicked.message?.sequence;
    if (!Number.isSafeInteger(kickoffSequence) || kickoffSequence! <= run.room!.goal_sequence!) throw localError("invalid_server_response", "The Prometheus kickoff sequence did not come back.");
    run = await saveCheckpoint(dependencies.paths, run, { startup_checkpoint: "kickoff_posted", outcome: "running", room: { ...run.room!, kickoff_sequence: kickoffSequence! } }, dependencies.now());
  }

  return monitorPrometheusRun(run, { ...dependencies, team, connection });
}

/** Read the complete ordered Room log; completion receipts may be later than the first page. */
export async function readPrometheusMessages(
  client: ApiClient,
  roomId: string,
  memberToken: string,
): Promise<PrometheusMessage[]> {
  const messages: PrometheusMessage[] = [];
  let after = 0;
  for (;;) {
    const page = await client.request<{ items?: PrometheusMessage[]; has_more?: boolean }>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/messages?after=${after}&order=asc&limit=100`,
      memberToken,
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

async function roomLifecycle(run: PrometheusRunState, dependencies: Pick<MonitorDependencies, "connection">): Promise<RoomLifecycle> {
  const roomId = run.room!.room_id;
  const response = await dependencies.connection.client.request<{ room?: { state?: unknown; goal?: { ended_by?: { trigger?: unknown; detail?: unknown } | null } | null } }>("GET", `/rooms/${encodeURIComponent(roomId)}`, dependencies.connection.memberToken);
  const state = response.room?.state;
  const ended = response.room?.goal?.ended_by;
  if (typeof state !== "string") throw localError("invalid_server_response", "The Prometheus Room state did not come back.");
  const endedBy = ended && typeof ended.trigger === "string" && (typeof ended.detail === "string" || ended.detail === null)
    ? { trigger: ended.trigger, detail: ended.detail }
    : null;
  return { state, endedBy };
}

async function snapshot(run: PrometheusRunState, dependencies: MonitorDependencies) {
  const roomId = run.room!.room_id;
  const state = await dependencies.connection.client.request<CompiledState>("GET", `/rooms/${encodeURIComponent(roomId)}/state`, dependencies.connection.memberToken);
  const messages = await readPrometheusMessages(dependencies.connection.client, roomId, dependencies.connection.memberToken);
  const protocolRoster = {
    coordinator: { memberId: run.roster!.coordinator.member_id },
    builder: { memberId: run.roster!.builder.member_id },
    reviewer: { memberId: run.roster!.reviewer.member_id },
  };
  const candidate = parsePrometheusCandidate(state, protocolRoster);
  const receipts = candidate.ok ? parseTerminalReceipts(messages, protocolRoster, run.run_id, candidate.candidate.revisionSha256) : { ok: false as const, receipts: {}, missingRoles: [...PROMETHEUS_ROLES] };
  const runtime = await inspectPrometheusRuntime(dependencies.team, roomId, run.roster!, { docker: dependencies.docker, baseUrl: dependencies.connection.baseUrl });
  return { state, candidate, receipts, runtime, barrier: evaluatePrometheusBarrier({ candidate, receipts, runtime }) };
}

function sameReady(left: PrometheusBarrierResult, right: PrometheusBarrierResult): boolean {
  return left.ready && right.ready && left.candidate.stateDigest === right.candidate.stateDigest && left.candidate.revisionSha256 === right.candidate.revisionSha256 && JSON.stringify(left.receipts) === JSON.stringify(right.receipts);
}

export async function monitorPrometheusRun(run: PrometheusRunState, dependencies: MonitorDependencies): Promise<PrometheusRunState> {
  const lease = await claimMonitor(dependencies.paths, run.run_id, dependencies.processProbe ?? systemProcessProbe);
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const feedbackAttempted = new Set<string>();
  try {
    for (;;) {
      const current = await reloadActive(run.run_id, dependencies);
      const now = dependencies.now();
      if (current.cancel_requested || now.getTime() >= Date.parse(current.deadline_at)) {
        return (await stopOrRecover(current, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection }))!;
      }
      const lifecycle = await roomLifecycle(current, dependencies);
      if (lifecycle.state !== "open") {
        if (current.candidate && lifecycle.endedBy?.trigger === "prometheus_success" && lifecycle.endedBy.detail === current.candidate.revision_sha256) {
          return finishRecoveredSuccess(current, lease, dependencies);
        }
        throw localError("prometheus_room_closed", "The Prometheus Room closed before the completion barrier passed.");
      }
      const afterLifecycle = await reloadActive(current.run_id, dependencies);
      const stoppedAfterLifecycle = await stopOrRecover(afterLifecycle, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
      if (stoppedAfterLifecycle) return stoppedAfterLifecycle;
      const observed = await snapshot(afterLifecycle, dependencies);
      const afterSnapshot = await reloadActive(current.run_id, dependencies);
      const stoppedAfterSnapshot = await stopOrRecover(afterSnapshot, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
      if (stoppedAfterSnapshot) return stoppedAfterSnapshot;
      if (observed.barrier.ready) {
        const revision = observed.barrier.candidate.revisionSha256;
        const prior = afterSnapshot.checks.find((entry) => entry.revision_sha256 === revision);
        let passingCheck = prior?.exit_code === 0;
        if (!prior) {
          const checkStop = watchRunStop(afterSnapshot, dependencies.paths, dependencies.now);
          let checked: Awaited<ReturnType<typeof runPrometheusCheck>>;
          try {
            checked = await runPrometheusCheck({ image: dependencies.plan.image, workspace: current.workspace_path }, current.configuration.check_command, {
              SHAREDNET_PROMETHEUS_RUN_ID: current.run_id,
              SHAREDNET_PROMETHEUS_WORK_ID: observed.barrier.candidate.workId,
              SHAREDNET_PROMETHEUS_RESULT_REF: observed.barrier.candidate.resultRef,
              SHAREDNET_PROMETHEUS_REVISION_SHA256: revision,
            }, {
              docker: dependencies.docker,
              now: dependencies.now,
              timeoutMs: Date.parse(afterSnapshot.deadline_at) - dependencies.now().getTime(),
              signal: checkStop.signal,
            });
          } finally {
            checkStop.dispose();
          }
          const afterCheck = await reloadActive(current.run_id, dependencies);
          const stoppedAfterCheck = await stopOrRecover(afterCheck, lease, { paths: dependencies.paths, now: dependencies.now, connection: dependencies.connection });
          if (stoppedAfterCheck) return stoppedAfterCheck;
          if (checked.exitCode === 125) throw localError("prometheus_check_launch_failed", "The Prometheus semantic-check container could not be launched.");
          const summary = { revision_sha256: revision, started_at: checked.startedAt, finished_at: checked.finishedAt, exit_code: Math.max(0, checked.exitCode), output: checked.output, output_sha256: checked.outputSha256 };
          run = await saveCheckpoint(dependencies.paths, afterCheck, { monitor: lease, checks: [...afterCheck.checks, summary] }, dependencies.now());
          if (checked.exitCode !== 0) {
            const feedback = `@${current.roster!.coordinator.member_id} Semantic check failed for revision ${revision}:\n${checked.output.slice(-2_000)}`;
            await dependencies.connection.client.request("POST", `/rooms/${encodeURIComponent(current.room!.room_id)}/owner-messages`, dependencies.connection.apiKey, { content: feedback, as: "runner" }, { "idempotency-key": `${current.run_id}-check-${revision}` });
            feedbackAttempted.add(revision);
          } else {
            passingCheck = true;
          }
        } else if (prior.exit_code !== 0 && !feedbackAttempted.has(revision)) {
          const feedback = `@${current.roster!.coordinator.member_id} Semantic check failed for revision ${revision}:\n${prior.output.slice(-2_000)}`;
          await dependencies.connection.client.request("POST", `/rooms/${encodeURIComponent(current.room!.room_id)}/owner-messages`, dependencies.connection.apiKey, { content: feedback, as: "runner" }, { "idempotency-key": `${current.run_id}-check-${revision}` });
          feedbackAttempted.add(revision);
        }
        if (passingCheck) {
          const after = await snapshot(run, dependencies);
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
            const closed = await dependencies.connection.client.request<{ room?: { state?: unknown; goal?: { ended_by?: { trigger?: unknown; detail?: unknown } | null } | null } }>(
              "POST",
              `/rooms/${encodeURIComponent(current.room!.room_id)}/close`,
              dependencies.connection.apiKey,
              { trigger: "prometheus_success", detail: revision },
              { "idempotency-key": `${current.run_id}-close-success` },
            );
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
    // Transport and service failures do not prove the Room or run is invalid.
    // Keep the durable run active so a later `prometheus resume` can reclaim it.
    if (failure.exitCode === 5) throw failure;
    const current = await reloadActive(run.run_id, dependencies);
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
