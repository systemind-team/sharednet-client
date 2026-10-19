import { createHash, randomUUID } from "node:crypto";
import { open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { localError } from "./errors.ts";
import {
  assertOwnerOnlyDirectory,
  createOwnerOnlyJsonIfAbsent,
  ensureOwnerOnlyDirectory,
  getStoragePaths,
  readOwnerOnlyFile,
  writeOwnerOnlyJson,
} from "./storage.ts";
import {
  inspectProcessIdentity,
  systemProcessProbe,
  type ProcessProbe,
  type RecordedProcessIdentity,
} from "./process-identity.ts";
import { PROMETHEUS_ROLES, type PrometheusRole } from "./prometheus-protocol.ts";

type Environment = Record<string, string | undefined>;

const STARTUP_CHECKPOINTS = [
  "reserved",
  "room_created",
  "goal_started",
  "roles_joined",
  "listeners_ready",
  "kickoff_posted",
] as const;
const RUN_OUTCOMES = ["starting", "running", "succeeded", "timed_out", "cancelled", "failed"] as const;
const TERMINAL_OUTCOMES = new Set<PrometheusTerminalOutcome>([
  "succeeded",
  "timed_out",
  "cancelled",
  "failed",
]);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const COMPILED_STATE_DIGEST = /^sha256:[0-9a-f]{24}$/;
const WORKSPACE_KEY = /^[0-9a-f]{24}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROOM_ID = /^rom_[A-Za-z0-9]+$/;
const MEMBER_ID = /^(?:i|mem)_[A-Za-z0-9]+$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const MODEL_NAME = /^[A-Za-z0-9._/-]{1,100}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_STATE_TEXT = /(?:\b(?:snk|sni|rit|clp|afk)_[A-Za-z0-9_-]{16,}\b|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|(?:\\?")(?:access_token|refresh_token|id_token|client_secret|api_key|member_token)(?:\\?")\s*:\s*(?:\\?")[^"\\\r\n]{16,})/i;
const FORBIDDEN_JWT = /(?:\bBearer\s+[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;

export type PrometheusStartupCheckpoint = (typeof STARTUP_CHECKPOINTS)[number];
export type PrometheusRunOutcome = (typeof RUN_OUTCOMES)[number];
export type PrometheusTerminalOutcome = Exclude<PrometheusRunOutcome, "starting" | "running">;

export interface PrometheusPaths {
  workspaceKey: string;
  workspacePath: string;
  rootDir: string;
  teamFile: string;
  activeFile: string;
  lockFile: string;
  runsDir: string;
  runDir(runId: string): string;
  runFile(runId: string): string;
  eventsFile(runId: string): string;
  checksFile(runId: string): string;
}

export interface PrometheusTeamRoleState {
  container_name: string;
  volume_name: string;
  thread_id: string;
}

export interface PrometheusTeamState {
  schema_version: 1;
  workspace_key: string;
  workspace_path: string;
  model: string;
  roles: Record<PrometheusRole, PrometheusTeamRoleState>;
  last_policy_sha256: string;
  created_at: string;
  updated_at: string;
}

export interface PrometheusRunConfiguration {
  model: string;
  goal_path: string;
  goal_sha256: string;
  policy_sha256: string;
  check_command: string;
  goal_request_body: {
    content: string;
    until: [string];
  };
}

export interface PrometheusRoomState {
  room_id: string;
  goal_sequence: number | null;
  kickoff_sequence: number | null;
}

export interface PrometheusRosterEntry {
  member_id: string;
  thread_id: string;
  container_name: string;
}

export type PrometheusRoster = Record<PrometheusRole, PrometheusRosterEntry>;

export interface PrometheusIdempotencyKeys {
  room: string;
  goal: string;
  roles: Record<PrometheusRole, string>;
  kickoff: string;
}

export type PrometheusEffectStatus = "pending" | "committed";

export interface PrometheusEffectJournalEntry {
  effect_id: string;
  method: "POST";
  path: string;
  idempotency_key: string;
  body: unknown;
  body_sha256: string;
  status: PrometheusEffectStatus;
  created_at: string;
  committed_at: string | null;
}

export interface PrometheusCloseExpectation {
  latest_sequence: number;
  compiled_sequence: number;
  compiled_digest: string;
}

export interface PrometheusPendingClose {
  effect_id: string;
  outcome: PrometheusTerminalOutcome;
  revision_sha256: string | null;
  expected: PrometheusCloseExpectation | null;
  prepared_at: string;
}

export interface MonitorLease {
  lease_id: string;
  pid: number;
  start_identity: string;
  claimed_at: string;
  renewed_at: string;
}

export interface PrometheusCandidateSummary {
  compiled_digest: string;
  work_id: string;
  result_ref: string;
  revision_sha256: string;
  observed_at: string;
}

export interface PrometheusCheckSummary {
  revision_sha256: string;
  artifact_snapshot_sha256: string;
  started_at: string;
  finished_at: string;
  exit_code: number;
  output: string;
  output_sha256: string;
}

export interface PrometheusRunState {
  schema_version: 2;
  run_id: string;
  workspace_key: string;
  workspace_path: string;
  configuration: PrometheusRunConfiguration;
  startup_checkpoint: PrometheusStartupCheckpoint;
  room: PrometheusRoomState | null;
  roster: PrometheusRoster | null;
  idempotency_keys: PrometheusIdempotencyKeys;
  deadline_at: string;
  monitor: MonitorLease | null;
  cancel_requested: boolean;
  outcome: PrometheusRunOutcome;
  candidate: PrometheusCandidateSummary | null;
  checks: PrometheusCheckSummary[];
  effects: PrometheusEffectJournalEntry[];
  pending_close: PrometheusPendingClose | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  reason: string | null;
}

interface PrometheusActiveRun {
  schema_version: 1;
  run_id: string;
  monitor: MonitorLease | null;
  cancel_requested: boolean;
}

interface PrometheusStateLock extends RecordedProcessIdentity {
  schema_version: 1;
  lock_id: string;
  created_at: string;
}

function invalidState(message = "Prometheus local state is invalid."): never {
  throw localError("invalid_local_state", message);
}

function record(value: unknown, keys: readonly string[], source: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidState(source);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalidState(source);
  }
  return object;
}

function string(value: unknown, source: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || value.includes("\0")) {
    invalidState(source);
  }
  return value;
}

function nullableString(value: unknown, source: string, max = 16_384): string | null {
  return value === null ? null : string(value, source, max);
}

function pattern(value: unknown, expected: RegExp, source: string): string {
  const parsed = string(value, source);
  if (!expected.test(parsed)) invalidState(source);
  return parsed;
}

function timestamp(value: unknown, source: string): string {
  const parsed = string(value, source, 64);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed) invalidState(source);
  return parsed;
}

function nullableTimestamp(value: unknown, source: string): string | null {
  return value === null ? null : timestamp(value, source);
}

function safeInteger(value: unknown, source: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) invalidState(source);
  return value as number;
}

function exactRoleRecord<T>(
  value: unknown,
  source: string,
  parse: (value: unknown, role: PrometheusRole) => T,
): Record<PrometheusRole, T> {
  const object = record(value, PROMETHEUS_ROLES, source);
  return {
    coordinator: parse(object.coordinator, "coordinator"),
    builder: parse(object.builder, "builder"),
    reviewer: parse(object.reviewer, "reviewer"),
  };
}

function noCredentials(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (FORBIDDEN_STATE_TEXT.test(serialized) || FORBIDDEN_JWT.test(serialized)) {
    invalidState("Prometheus state must not contain credentials or credential locations.");
  }
}

function parseJson(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    invalidState(`${source} is not valid JSON.`);
  }
}

function parseTeamRole(value: unknown, source: string): PrometheusTeamRoleState {
  const object = record(value, ["container_name", "volume_name", "thread_id"], source);
  return {
    container_name: pattern(object.container_name, DOCKER_NAME, source),
    volume_name: pattern(object.volume_name, DOCKER_NAME, source),
    thread_id: pattern(object.thread_id, SAFE_ID, source),
  };
}

function parseTeam(value: unknown, paths: PrometheusPaths): PrometheusTeamState {
  noCredentials(value);
  const source = "The Prometheus team file";
  const object = record(
    value,
    [
      "schema_version",
      "workspace_key",
      "workspace_path",
      "model",
      "roles",
      "last_policy_sha256",
      "created_at",
      "updated_at",
    ],
    `${source} is not valid Prometheus state.`,
  );
  if (object.schema_version !== 1) invalidState(`${source} has an unsupported version.`);
  const workspaceKey = pattern(object.workspace_key, WORKSPACE_KEY, source);
  const workspacePath = string(object.workspace_path, source);
  if (!isAbsolute(workspacePath) || workspaceKey !== paths.workspaceKey || workspacePath !== paths.workspacePath) {
    invalidState(`${source} does not belong to this workspace.`);
  }
  const createdAt = timestamp(object.created_at, source);
  const updatedAt = timestamp(object.updated_at, source);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) invalidState(source);
  const roles = exactRoleRecord(object.roles, source, (entry, role) =>
    parseTeamRole(entry, `${source} role ${role}`),
  );
  for (const field of ["container_name", "volume_name", "thread_id"] as const) {
    const values = PROMETHEUS_ROLES.map((role) => roles[role][field]);
    if (new Set(values).size !== PROMETHEUS_ROLES.length) invalidState(source);
  }
  return {
    schema_version: 1,
    workspace_key: workspaceKey,
    workspace_path: workspacePath,
    model: pattern(object.model, MODEL_NAME, source),
    roles,
    last_policy_sha256: pattern(object.last_policy_sha256, HEX_SHA256, source),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function parseConfiguration(value: unknown, source: string): PrometheusRunConfiguration {
  const object = record(
    value,
    ["model", "goal_path", "goal_sha256", "policy_sha256", "check_command", "goal_request_body"],
    source,
  );
  const goalPath = string(object.goal_path, source);
  if (!isAbsolute(goalPath)) invalidState(source);
  const goalBody = record(object.goal_request_body, ["content", "until"], source);
  if (!Array.isArray(goalBody.until) || goalBody.until.length !== 1) invalidState(source);
  const until = string(goalBody.until[0], source, 96);
  if (!/^at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(until)) invalidState(source);
  return {
    model: pattern(object.model, MODEL_NAME, source),
    goal_path: goalPath,
    goal_sha256: pattern(object.goal_sha256, HEX_SHA256, source),
    policy_sha256: pattern(object.policy_sha256, HEX_SHA256, source),
    check_command: string(object.check_command, source),
    goal_request_body: {
      content: string(goalBody.content, source, 1_000_000),
      until: [until],
    },
  };
}

function parseRoom(value: unknown, source: string): PrometheusRoomState | null {
  if (value === null) return null;
  const object = record(value, ["room_id", "goal_sequence", "kickoff_sequence"], source);
  return {
    room_id: pattern(object.room_id, ROOM_ID, source),
    goal_sequence:
      object.goal_sequence === null ? null : safeInteger(object.goal_sequence, source, 1),
    kickoff_sequence:
      object.kickoff_sequence === null ? null : safeInteger(object.kickoff_sequence, source, 1),
  };
}

function parseRosterEntry(value: unknown, source: string): PrometheusRosterEntry {
  const object = record(value, ["member_id", "thread_id", "container_name"], source);
  return {
    member_id: pattern(object.member_id, MEMBER_ID, source),
    thread_id: pattern(object.thread_id, SAFE_ID, source),
    container_name: pattern(object.container_name, DOCKER_NAME, source),
  };
}

function parseRoster(value: unknown, source: string): PrometheusRoster | null {
  if (value === null) return null;
  const roster = exactRoleRecord(value, source, (entry, role) =>
    parseRosterEntry(entry, `${source} role ${role}`),
  );
  for (const field of ["member_id", "thread_id", "container_name"] as const) {
    const values = PROMETHEUS_ROLES.map((role) => roster[role][field]);
    if (new Set(values).size !== PROMETHEUS_ROLES.length) invalidState(source);
  }
  return roster;
}

function parseIdempotencyKeys(value: unknown, source: string): PrometheusIdempotencyKeys {
  const object = record(value, ["room", "goal", "roles", "kickoff"], source);
  return {
    room: pattern(object.room, UUID_V4, source),
    goal: pattern(object.goal, UUID_V4, source),
    roles: exactRoleRecord(object.roles, source, (entry) => pattern(entry, UUID_V4, source)),
    kickoff: pattern(object.kickoff, UUID_V4, source),
  };
}

function parseEffectBody(value: unknown, source: string): unknown {
  if (value === undefined) invalidState(source);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalidState(source);
  }
  if (serialized === undefined || serialized.length > 1_000_000) invalidState(source);
  noCredentials(value);
  return value;
}

function effectBodySha256(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
}

function parseEffect(value: unknown, source: string): PrometheusEffectJournalEntry {
  const object = record(value, [
    "effect_id", "method", "path", "idempotency_key", "body", "body_sha256",
    "status", "created_at", "committed_at",
  ], source);
  if (object.method !== "POST") invalidState(source);
  const path = string(object.path, source, 2_048);
  if (!path.startsWith("/") || path.includes("\0")) invalidState(source);
  const body = parseEffectBody(object.body, source);
  const bodySha256 = pattern(object.body_sha256, HEX_SHA256, source);
  if (bodySha256 !== effectBodySha256(body)) invalidState(source);
  const status = string(object.status, source) as PrometheusEffectStatus;
  if (status !== "pending" && status !== "committed") invalidState(source);
  const createdAt = timestamp(object.created_at, source);
  const committedAt = nullableTimestamp(object.committed_at, source);
  if ((status === "committed") !== (committedAt !== null)) invalidState(source);
  if (committedAt !== null && Date.parse(committedAt) < Date.parse(createdAt)) invalidState(source);
  return {
    effect_id: pattern(object.effect_id, SAFE_ID, source),
    method: "POST",
    path,
    idempotency_key: pattern(object.idempotency_key, UUID_V4, source),
    body,
    body_sha256: bodySha256,
    status,
    created_at: createdAt,
    committed_at: committedAt,
  };
}

function parseCloseExpectation(value: unknown, source: string): PrometheusCloseExpectation | null {
  if (value === null) return null;
  const object = record(value, ["latest_sequence", "compiled_sequence", "compiled_digest"], source);
  return {
    latest_sequence: safeInteger(object.latest_sequence, source),
    compiled_sequence: safeInteger(object.compiled_sequence, source),
    compiled_digest: pattern(object.compiled_digest, COMPILED_STATE_DIGEST, source),
  };
}

function parsePendingClose(value: unknown, source: string): PrometheusPendingClose | null {
  if (value === null) return null;
  const object = record(value, ["effect_id", "outcome", "revision_sha256", "expected", "prepared_at"], source);
  const outcome = string(object.outcome, source) as PrometheusTerminalOutcome;
  if (!TERMINAL_OUTCOMES.has(outcome)) invalidState(source);
  const revisionSha256 = object.revision_sha256 === null ? null : pattern(object.revision_sha256, HEX_SHA256, source);
  const expected = parseCloseExpectation(object.expected, source);
  if (outcome === "succeeded" ? (revisionSha256 === null || expected === null) : (revisionSha256 !== null || expected !== null)) {
    invalidState(source);
  }
  return {
    effect_id: pattern(object.effect_id, SAFE_ID, source),
    outcome,
    revision_sha256: revisionSha256,
    expected,
    prepared_at: timestamp(object.prepared_at, source),
  };
}

function parseMonitor(value: unknown, source: string): MonitorLease | null {
  if (value === null) return null;
  const object = record(
    value,
    ["lease_id", "pid", "start_identity", "claimed_at", "renewed_at"],
    source,
  );
  const claimedAt = timestamp(object.claimed_at, source);
  const renewedAt = timestamp(object.renewed_at, source);
  if (Date.parse(renewedAt) < Date.parse(claimedAt)) invalidState(source);
  return {
    lease_id: pattern(object.lease_id, SAFE_ID, source),
    pid: safeInteger(object.pid, source, 1),
    start_identity: string(object.start_identity, source, 512),
    claimed_at: claimedAt,
    renewed_at: renewedAt,
  };
}

function parseCandidate(value: unknown, source: string): PrometheusCandidateSummary | null {
  if (value === null) return null;
  const object = record(
    value,
    ["compiled_digest", "work_id", "result_ref", "revision_sha256", "observed_at"],
    source,
  );
  return {
    compiled_digest: pattern(object.compiled_digest, COMPILED_STATE_DIGEST, source),
    work_id: pattern(object.work_id, SAFE_ID, source),
    result_ref: pattern(object.result_ref, SAFE_ID, source),
    revision_sha256: pattern(object.revision_sha256, HEX_SHA256, source),
    observed_at: timestamp(object.observed_at, source),
  };
}

function parseCheck(value: unknown, source: string): PrometheusCheckSummary {
  const object = record(
    value,
    ["revision_sha256", "artifact_snapshot_sha256", "started_at", "finished_at", "exit_code", "output", "output_sha256"],
    source,
  );
  const startedAt = timestamp(object.started_at, source);
  const finishedAt = timestamp(object.finished_at, source);
  if (Date.parse(finishedAt) < Date.parse(startedAt)) invalidState(source);
  return {
    revision_sha256: pattern(object.revision_sha256, HEX_SHA256, source),
    artifact_snapshot_sha256: pattern(object.artifact_snapshot_sha256, HEX_SHA256, source),
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: safeInteger(object.exit_code, source),
    output: typeof object.output === "string" && object.output.length <= 64_000 ? object.output : invalidState(source),
    output_sha256: pattern(object.output_sha256, HEX_SHA256, source),
  };
}

function parseRun(value: unknown, paths: PrometheusPaths, expectedRunId: string): PrometheusRunState {
  noCredentials(value);
  const source = "The Prometheus run file";
  const object = record(
    value,
    [
      "schema_version",
      "run_id",
      "workspace_key",
      "workspace_path",
      "configuration",
      "startup_checkpoint",
      "room",
      "roster",
      "idempotency_keys",
      "deadline_at",
      "monitor",
      "cancel_requested",
      "outcome",
      "candidate",
      "checks",
      "effects",
      "pending_close",
      "created_at",
      "updated_at",
      "finished_at",
      "reason",
    ],
    `${source} is not valid Prometheus state.`,
  );
  if (object.schema_version !== 2) invalidState(`${source} has an unsupported version.`);
  const runId = pattern(object.run_id, SAFE_ID, source);
  const workspaceKey = pattern(object.workspace_key, WORKSPACE_KEY, source);
  const workspacePath = string(object.workspace_path, source);
  if (
    runId !== expectedRunId ||
    !isAbsolute(workspacePath) ||
    workspaceKey !== paths.workspaceKey ||
    workspacePath !== paths.workspacePath
  ) {
    invalidState(`${source} does not belong to this run and workspace.`);
  }
  const checkpoint = string(object.startup_checkpoint, source) as PrometheusStartupCheckpoint;
  if (!(STARTUP_CHECKPOINTS as readonly string[]).includes(checkpoint)) invalidState(source);
  const outcome = string(object.outcome, source) as PrometheusRunOutcome;
  if (!(RUN_OUTCOMES as readonly string[]).includes(outcome)) invalidState(source);
  const room = parseRoom(object.room, source);
  const roster = parseRoster(object.roster, source);
  const checkpointIndex = STARTUP_CHECKPOINTS.indexOf(checkpoint);
  if ((checkpointIndex === 0) !== (room === null)) invalidState(source);
  if (checkpointIndex >= 2 && room?.goal_sequence === null) invalidState(source);
  if (checkpointIndex < 2 && room !== null && room.goal_sequence !== null) invalidState(source);
  if ((checkpointIndex >= 3) !== (roster !== null)) invalidState(source);
  if (checkpointIndex === 5 && room?.kickoff_sequence === null) invalidState(source);
  if (checkpointIndex < 5 && room !== null && room.kickoff_sequence !== null) invalidState(source);
  if (outcome === "running" && checkpoint !== "kickoff_posted") invalidState(source);

  const createdAt = timestamp(object.created_at, source);
  const updatedAt = timestamp(object.updated_at, source);
  const deadlineAt = timestamp(object.deadline_at, source);
  const finishedAt = nullableTimestamp(object.finished_at, source);
  const reason = nullableString(object.reason, source, 4_000);
  if (Date.parse(updatedAt) < Date.parse(createdAt) || Date.parse(deadlineAt) <= Date.parse(createdAt)) {
    invalidState(source);
  }
  const terminal = TERMINAL_OUTCOMES.has(outcome as PrometheusTerminalOutcome);
  if (terminal !== (finishedAt !== null && reason !== null)) invalidState(source);
  if (!terminal && (finishedAt !== null || reason !== null)) invalidState(source);
  if (finishedAt !== null && Date.parse(finishedAt) < Date.parse(updatedAt)) invalidState(source);

  const candidate = parseCandidate(object.candidate, source);
  if (outcome === "succeeded" && candidate === null) invalidState(source);
  if (!Array.isArray(object.checks)) invalidState(source);
  if (!Array.isArray(object.effects)) invalidState(source);
  if (typeof object.cancel_requested !== "boolean") invalidState(source);

  const effects = object.effects.map((entry, index) => parseEffect(entry, `${source} effect ${index}`));
  if (new Set(effects.map((entry) => entry.effect_id)).size !== effects.length) invalidState(source);
  const pendingClose = parsePendingClose(object.pending_close, source);
  if (pendingClose !== null) {
    const closeEffect = effects.find((entry) => entry.effect_id === pendingClose.effect_id);
    if (!closeEffect || !closeEffect.path.endsWith("/close")) invalidState(source);
  }

  return {
    schema_version: 2,
    run_id: runId,
    workspace_key: workspaceKey,
    workspace_path: workspacePath,
    configuration: parseConfiguration(object.configuration, source),
    startup_checkpoint: checkpoint,
    room,
    roster,
    idempotency_keys: parseIdempotencyKeys(object.idempotency_keys, source),
    deadline_at: deadlineAt,
    monitor: parseMonitor(object.monitor, source),
    cancel_requested: object.cancel_requested,
    outcome,
    candidate,
    checks: object.checks.map((entry, index) => parseCheck(entry, `${source} check ${index}`)),
    effects,
    pending_close: pendingClose,
    created_at: createdAt,
    updated_at: updatedAt,
    finished_at: finishedAt,
    reason,
  };
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_ID.test(runId)) invalidState("The Prometheus run ID is invalid.");
}

export async function prometheusPaths(
  env: Environment = process.env,
  workspace: string,
): Promise<PrometheusPaths> {
  const workspacePath = await realpath(workspace);
  if (!isAbsolute(workspacePath)) invalidState("The Prometheus workspace path is invalid.");
  const workspaceKey = createHash("sha256").update(workspacePath).digest("hex").slice(0, 24);
  const stateDir = getStoragePaths(env).stateDir;
  const prometheusDir = join(stateDir, "prometheus");
  const versionDir = join(prometheusDir, "local-v1");
  const rootDir = join(versionDir, workspaceKey);
  const runsDir = join(rootDir, "runs");
  for (const directory of [stateDir, prometheusDir, versionDir, rootDir]) {
    await ensureOwnerOnlyDirectory(directory);
  }
  await ensureOwnerOnlyDirectory(runsDir);
  const checkedRunDir = (runId: string) => {
    assertSafeRunId(runId);
    return join(runsDir, runId);
  };
  return {
    workspaceKey,
    workspacePath,
    rootDir,
    teamFile: join(rootDir, "team.json"),
    activeFile: join(rootDir, "active.json"),
    lockFile: join(rootDir, "lock.json"),
    runsDir,
    runDir: checkedRunDir,
    runFile: (runId) => join(checkedRunDir(runId), "run.json"),
    eventsFile: (runId) => join(checkedRunDir(runId), "events.ndjson"),
    checksFile: (runId) => join(checkedRunDir(runId), "checks.ndjson"),
  };
}

function prometheusRootDirectories(paths: PrometheusPaths): string[] {
  const versionDir = dirname(paths.rootDir);
  const prometheusDir = dirname(versionDir);
  const stateDir = dirname(prometheusDir);
  return [stateDir, prometheusDir, versionDir, paths.rootDir];
}

async function ownerOnlyDirectoriesExist(directories: readonly string[]): Promise<boolean> {
  for (const directory of directories) {
    if (!(await assertOwnerOnlyDirectory(directory))) return false;
  }
  return true;
}

async function ensurePrometheusDirectories(paths: PrometheusPaths): Promise<void> {
  for (const directory of [...prometheusRootDirectories(paths), paths.runsDir]) {
    await ensureOwnerOnlyDirectory(directory);
  }
}

export async function readTeam(paths: PrometheusPaths): Promise<PrometheusTeamState | null> {
  if (!(await ownerOnlyDirectoriesExist(prometheusRootDirectories(paths)))) return null;
  const raw = await readOwnerOnlyFile(paths.teamFile);
  return raw === null ? null : parseTeam(parseJson(raw, "The Prometheus team file"), paths);
}

async function writeTeamUnlocked(
  paths: PrometheusPaths,
  state: PrometheusTeamState,
): Promise<void> {
  const parsed = parseTeam(state, paths);
  const existing = await readTeam(paths);
  if (existing !== null) {
    const immutable = (value: PrometheusTeamState) => ({
      workspace_key: value.workspace_key,
      workspace_path: value.workspace_path,
      model: value.model,
      roles: value.roles,
      created_at: value.created_at,
    });
    if (JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(parsed))) {
      invalidState("A Prometheus team's fixed identity cannot be changed.");
    }
    if (Date.parse(parsed.updated_at) < Date.parse(existing.updated_at)) {
      invalidState("A Prometheus team update cannot move backwards in time.");
    }
  }
  await writeOwnerOnlyJson(paths.teamFile, parsed);
}

export async function writeTeam(paths: PrometheusPaths, state: PrometheusTeamState): Promise<void> {
  const parsed = parseTeam(state, paths);
  await withStateLock(paths, systemProcessProbe, () => writeTeamUnlocked(paths, parsed));
}

export async function readRun(
  paths: PrometheusPaths,
  runId: string,
): Promise<PrometheusRunState | null> {
  assertSafeRunId(runId);
  if (
    !(await ownerOnlyDirectoriesExist([
      ...prometheusRootDirectories(paths),
      paths.runsDir,
      paths.runDir(runId),
    ]))
  ) {
    return null;
  }
  const raw = await readOwnerOnlyFile(paths.runFile(runId));
  return raw === null ? null : parseRun(parseJson(raw, "The Prometheus run file"), paths, runId);
}

interface WriteRunOptions {
  allowTerminal?: boolean;
}

async function writeRunUnlocked(
  paths: PrometheusPaths,
  state: PrometheusRunState,
  options: WriteRunOptions = {},
): Promise<void> {
  const parsed = parseRun(state, paths, state.run_id);
  const existing = await readRun(paths, parsed.run_id);
  if (existing !== null) {
    if (isTerminal(existing.outcome)) {
      if (JSON.stringify(existing) === JSON.stringify(parsed)) return;
      invalidState("A terminal Prometheus run cannot be changed.");
    }
    if (
      STARTUP_CHECKPOINTS.indexOf(parsed.startup_checkpoint) <
      STARTUP_CHECKPOINTS.indexOf(existing.startup_checkpoint)
    ) {
      invalidState("A Prometheus run cannot move backwards through startup.");
    }
    if (existing.outcome === "running" && parsed.outcome === "starting") {
      invalidState("A Prometheus run cannot return to startup.");
    }
    const immutable = (value: PrometheusRunState) => ({
      run_id: value.run_id,
      workspace_key: value.workspace_key,
      workspace_path: value.workspace_path,
      configuration: value.configuration,
      idempotency_keys: value.idempotency_keys,
      deadline_at: value.deadline_at,
      created_at: value.created_at,
    });
    if (JSON.stringify(immutable(existing)) !== JSON.stringify(immutable(parsed))) {
      invalidState("A Prometheus run's configuration and deadline cannot be changed.");
    }
    if (Date.parse(parsed.updated_at) < Date.parse(existing.updated_at)) {
      invalidState("A Prometheus run update cannot move backwards in time.");
    }
    if (parsed.effects.length < existing.effects.length) {
      invalidState("A Prometheus effect journal cannot lose entries.");
    }
    for (let index = 0; index < existing.effects.length; index += 1) {
      const before = existing.effects[index]!;
      const after = parsed.effects[index]!;
      const fixed = (entry: PrometheusEffectJournalEntry) => ({
        effect_id: entry.effect_id,
        method: entry.method,
        path: entry.path,
        idempotency_key: entry.idempotency_key,
        body: entry.body,
        body_sha256: entry.body_sha256,
        created_at: entry.created_at,
      });
      if (JSON.stringify(fixed(before)) !== JSON.stringify(fixed(after))) {
        invalidState("A prepared Prometheus effect request cannot be changed.");
      }
      if (before.status === "committed" && JSON.stringify(before) !== JSON.stringify(after)) {
        invalidState("A committed Prometheus effect cannot be changed.");
      }
    }
  }
  if (isTerminal(parsed.outcome) && !options.allowTerminal) {
    throw localError(
      "prometheus_terminal_requires_lease",
      `Prometheus run ${parsed.run_id} must be finished through its monitor lease.`,
    );
  }
  await ensurePrometheusDirectories(paths);
  await ensureOwnerOnlyDirectory(paths.runDir(parsed.run_id));
  await writeOwnerOnlyJson(paths.runFile(parsed.run_id), parsed);
}

export async function writeRun(paths: PrometheusPaths, state: PrometheusRunState): Promise<void> {
  const parsed = parseRun(state, paths, state.run_id);
  await withStateLock(paths, systemProcessProbe, async () => {
    const existing = await readRun(paths, parsed.run_id);
    if (isTerminal(parsed.outcome)) {
      if (
        existing !== null &&
        isTerminal(existing.outcome) &&
        JSON.stringify(existing) === JSON.stringify(parsed)
      ) {
        return;
      }
      throw localError(
        "prometheus_terminal_requires_lease",
        `Prometheus run ${parsed.run_id} must be finished through its monitor lease.`,
      );
    }

    const active = await readActive(paths);
    if (active === null || active.run_id !== parsed.run_id) {
      throw localError(
        "prometheus_run_not_active",
        `Prometheus run ${parsed.run_id} is not active.`,
      );
    }
    if (
      (active.monitor === null && parsed.monitor !== null) ||
      (active.monitor !== null && !sameLease(parsed.monitor, active.monitor))
    ) {
      throw localError(
        "prometheus_monitor_lease_lost",
        `Prometheus run ${parsed.run_id} no longer has this monitor lease.`,
      );
    }
    const reconciled = {
      ...parsed,
      monitor: active.monitor,
      cancel_requested: active.cancel_requested,
    };
    await writeRunUnlocked(paths, reconciled);
  });
}

function parseActive(value: unknown): PrometheusActiveRun {
  noCredentials(value);
  const source = "The Prometheus active-run file";
  const object = record(
    value,
    ["schema_version", "run_id", "monitor", "cancel_requested"],
    source,
  );
  if (object.schema_version !== 1 || typeof object.cancel_requested !== "boolean") {
    invalidState(source);
  }
  return {
    schema_version: 1,
    run_id: pattern(object.run_id, SAFE_ID, source),
    monitor: parseMonitor(object.monitor, source),
    cancel_requested: object.cancel_requested,
  };
}

function parseStateLock(value: unknown): PrometheusStateLock {
  const source = "The Prometheus state lock";
  const object = record(
    value,
    ["schema_version", "lock_id", "pid", "start_identity", "created_at"],
    source,
  );
  if (object.schema_version !== 1) invalidState(source);
  return {
    schema_version: 1,
    lock_id: pattern(object.lock_id, SAFE_ID, source),
    pid: safeInteger(object.pid, source, 1),
    start_identity: string(object.start_identity, source, 512),
    created_at: timestamp(object.created_at, source),
  };
}

async function readActive(paths: PrometheusPaths): Promise<PrometheusActiveRun | null> {
  const raw = await readOwnerOnlyFile(paths.activeFile);
  return raw === null ? null : parseActive(parseJson(raw, "The Prometheus active-run file"));
}

/** Read the durable active run through the validated public run schema. */
export async function readActiveRun(paths: PrometheusPaths): Promise<PrometheusRunState | null> {
  const active = await readActive(paths);
  if (active === null) return null;
  const state = await readRun(paths, active.run_id);
  if (state === null) invalidState("The Prometheus active-run file names a missing run.");
  return state;
}

async function removeOwnerOnlyFile(path: string): Promise<void> {
  try {
    // Unlinking a symlink removes the link itself, so deletion does not need
    // the read-side no-follow validation. Avoiding a read before unlink also
    // removes the check/read/unlink window used by competing state cleaners.
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function currentProcessIdentity(probe: ProcessProbe): RecordedProcessIdentity {
  if (!probe.supported) {
    throw localError(
      "prometheus_process_identity_unavailable",
      "Prometheus state mutation needs an OS process start identity on this platform.",
    );
  }
  const startIdentity = probe.identity(process.pid);
  if (startIdentity === null || startIdentity.length === 0) {
    throw localError(
      "prometheus_process_identity_unavailable",
      "Prometheus could not read this process's start identity.",
    );
  }
  return { pid: process.pid, start_identity: startIdentity };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type ReclaimResult = "won" | "busy" | "retry";

async function reclaimStateLock(
  paths: PrometheusPaths,
  observedRaw: string,
  observed: PrometheusStateLock,
  replacement: PrometheusStateLock,
  probe: ProcessProbe,
): Promise<ReclaimResult> {
  let token: string | null = null;
  for (let index = 0; index < 16 && token === null; index += 1) {
    const candidate = `${paths.lockFile}.reclaim.${observed.lock_id}.${index}`;
    if (await createOwnerOnlyJsonIfAbsent(candidate, replacement)) {
      token = candidate;
      break;
    }
    const tokenRaw = await readOwnerOnlyFile(candidate);
    if (tokenRaw === null) continue;
    const creator = parseStateLock(parseJson(tokenRaw, "A Prometheus lock-reclaim token"));
    const status = inspectProcessIdentity(probe, creator);
    if (status === "alive" || status === "unknown") return "busy";
  }
  if (token === null) return "busy";
  try {
    const currentRaw = await readOwnerOnlyFile(paths.lockFile);
    if (currentRaw !== observedRaw) return currentRaw === null ? "retry" : "busy";
    await writeOwnerOnlyJson(paths.lockFile, replacement);
    return "won";
  } finally {
    await removeOwnerOnlyFile(token).catch(() => undefined);
  }
}

async function acquireStateLock(
  paths: PrometheusPaths,
  probe: ProcessProbe,
): Promise<PrometheusStateLock> {
  await ensurePrometheusDirectories(paths);
  const identity = currentProcessIdentity(probe);
  const lock: PrometheusStateLock = {
    schema_version: 1,
    lock_id: randomUUID(),
    ...identity,
    created_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await createOwnerOnlyJsonIfAbsent(paths.lockFile, lock)) return lock;
    const raw = await readOwnerOnlyFile(paths.lockFile);
    if (raw === null) continue;
    const current = parseStateLock(parseJson(raw, "The Prometheus state lock"));
    const status = inspectProcessIdentity(probe, current);
    if (status === "dead" || status === "reused") {
      const reclaimed = await reclaimStateLock(paths, raw, current, lock, probe);
      if (reclaimed === "won") return lock;
      if (reclaimed === "retry") continue;
    }
    await pause(5);
  }
  throw localError(
    "prometheus_state_busy",
    "Another local Prometheus command is changing this workspace's state.",
  );
}

async function releaseStateLock(paths: PrometheusPaths, lockId: string): Promise<void> {
  const raw = await readOwnerOnlyFile(paths.lockFile);
  if (raw === null) return;
  const current = parseStateLock(parseJson(raw, "The Prometheus state lock"));
  if (current.lock_id === lockId) await removeOwnerOnlyFile(paths.lockFile);
}

async function withStateLock<T>(
  paths: PrometheusPaths,
  probe: ProcessProbe,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireStateLock(paths, probe);
  try {
    return await operation();
  } finally {
    await releaseStateLock(paths, lock.lock_id);
  }
}

function isTerminal(outcome: PrometheusRunOutcome): outcome is PrometheusTerminalOutcome {
  return TERMINAL_OUTCOMES.has(outcome as PrometheusTerminalOutcome);
}

function stateTimestamp(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous))).toISOString();
}

function sameLease(left: MonitorLease | null, right: MonitorLease): boolean {
  return left !== null &&
    left.lease_id === right.lease_id &&
    left.pid === right.pid &&
    left.start_identity === right.start_identity &&
    left.claimed_at === right.claimed_at;
}

/** Atomically reserve this workspace's single active-run slot. */
export async function reserveActiveRun(
  paths: PrometheusPaths,
  state: PrometheusRunState,
  probe: ProcessProbe,
): Promise<void> {
  const parsed = parseRun(state, paths, state.run_id);
  if (
    parsed.outcome !== "starting" ||
    parsed.startup_checkpoint !== "reserved" ||
    parsed.monitor !== null ||
    parsed.cancel_requested
  ) {
    invalidState("A new Prometheus active run must be in its reserved startup state.");
  }
  await withStateLock(paths, probe, async () => {
    const active = await readActive(paths);
    if (active !== null) {
      const existing = await readRun(paths, active.run_id);
      if (existing === null) {
        invalidState("The Prometheus active-run file names a missing run.");
      }
      if (isTerminal(existing.outcome)) {
        await removeOwnerOnlyFile(paths.activeFile);
      } else {
        throw localError(
          "prometheus_run_active",
          `Prometheus run ${active.run_id} is already active or resumable for this workspace.`,
        );
      }
    }
    await writeRunUnlocked(paths, parsed);
    await writeOwnerOnlyJson(paths.activeFile, {
      schema_version: 1,
      run_id: parsed.run_id,
      monitor: null,
      cancel_requested: false,
    } satisfies PrometheusActiveRun);
  });
}

/** Claim or renew the active run's monitor lease using an exact OS process identity. */
export async function claimMonitor(
  paths: PrometheusPaths,
  runId: string,
  probe: ProcessProbe,
): Promise<MonitorLease> {
  assertSafeRunId(runId);
  return withStateLock(paths, probe, async () => {
    const active = await readActive(paths);
    if (active === null || active.run_id !== runId) {
      throw localError("prometheus_run_not_active", `Prometheus run ${runId} is not active.`);
    }
    const state = await readRun(paths, runId);
    if (state === null || isTerminal(state.outcome)) {
      invalidState("The Prometheus active run is missing or terminal.");
    }
    const me = currentProcessIdentity(probe);
    const now = new Date().toISOString();
    let lease: MonitorLease;
    if (active.monitor === null) {
      lease = {
        lease_id: randomUUID(),
        ...me,
        claimed_at: now,
        renewed_at: now,
      };
    } else {
      const status = inspectProcessIdentity(probe, active.monitor);
      if (
        status === "alive" &&
        active.monitor.pid === me.pid &&
        active.monitor.start_identity === me.start_identity
      ) {
        lease = { ...active.monitor, renewed_at: now };
      } else if (status === "dead" || status === "reused") {
        lease = {
          lease_id: randomUUID(),
          ...me,
          claimed_at: now,
          renewed_at: now,
        };
      } else {
        throw localError(
          "prometheus_monitor_active",
          `Prometheus run ${runId} already has a live or unverifiable monitor.`,
        );
      }
    }
    await writeOwnerOnlyJson(paths.activeFile, { ...active, monitor: lease });
    await writeRunUnlocked(paths, {
      ...state,
      monitor: lease,
      cancel_requested: active.cancel_requested,
      updated_at: stateTimestamp(state.updated_at),
    });
    return lease;
  });
}

/** Set the active run's durable cancellation bit without waiting on its monitor. */
export async function requestCancel(paths: PrometheusPaths, runId: string): Promise<void> {
  assertSafeRunId(runId);
  await withStateLock(paths, systemProcessProbe, async () => {
    const active = await readActive(paths);
    const state = await readRun(paths, runId);
    if (active === null) {
      if (state !== null && isTerminal(state.outcome)) return;
      throw localError("prometheus_run_not_active", `Prometheus run ${runId} is not active.`);
    }
    if (active.run_id !== runId || state === null) {
      throw localError("prometheus_run_not_active", `Prometheus run ${runId} is not active.`);
    }
    if (isTerminal(state.outcome)) {
      await removeOwnerOnlyFile(paths.activeFile);
      return;
    }
    const next = {
      ...state,
      monitor: active.monitor,
      cancel_requested: true,
      updated_at: stateTimestamp(state.updated_at),
    };
    await writeOwnerOnlyJson(paths.activeFile, { ...active, cancel_requested: true });
    await writeRunUnlocked(paths, next);
  });
}

/** Write a terminal run under its matching lease, then clear the active slot last. */
export async function finishRun(
  paths: PrometheusPaths,
  finalState: PrometheusRunState,
  lease: MonitorLease,
): Promise<void> {
  const parsed = parseRun(finalState, paths, finalState.run_id);
  if (!isTerminal(parsed.outcome)) {
    invalidState("A finished Prometheus run needs a terminal outcome.");
  }
  if (!sameLease(parsed.monitor, lease)) {
    throw localError(
      "prometheus_monitor_lease_lost",
      `Prometheus run ${parsed.run_id} no longer has this monitor lease.`,
    );
  }
  await withStateLock(paths, systemProcessProbe, async () => {
    const active = await readActive(paths);
    const current = await readRun(paths, parsed.run_id);
    if (active === null) {
      if (
        current !== null &&
        isTerminal(current.outcome) &&
        sameLease(current.monitor, lease) &&
        JSON.stringify(current) ===
          JSON.stringify({
            ...parsed,
            monitor: current.monitor,
            cancel_requested: current.cancel_requested,
          })
      ) {
        return;
      }
      throw localError(
        "prometheus_monitor_lease_lost",
        `Prometheus run ${parsed.run_id} no longer has this monitor lease.`,
      );
    }
    if (
      active.run_id !== parsed.run_id ||
      !sameLease(active.monitor, lease) ||
      current === null ||
      (parsed.outcome === "cancelled" && !active.cancel_requested)
    ) {
      throw localError(
        "prometheus_monitor_lease_lost",
        `Prometheus run ${parsed.run_id} no longer has this monitor lease.`,
      );
    }
    const canonical = {
      ...parsed,
      monitor: active.monitor,
      cancel_requested: active.cancel_requested,
    };
    if (isTerminal(current.outcome)) {
      if (JSON.stringify(current) !== JSON.stringify(canonical)) {
        invalidState("A terminal Prometheus run cannot be replaced by another outcome.");
      }
    } else {
      await writeRunUnlocked(paths, canonical, { allowTerminal: true });
    }
    await removeOwnerOnlyFile(paths.activeFile);
  });
}
