import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ApiClient } from "./api-client.ts";
import { localError } from "./errors.ts";
import { type DockerRunner, type RunPlan } from "./goal-run.ts";
import { PROMETHEUS_ROLES, type CandidateArtifact, type PrometheusRole } from "./prometheus-protocol.ts";
import type { PrometheusRoster, PrometheusTeamState } from "./prometheus-state.ts";

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOME = "/home/prometheus";
const CONTAINER_CLI = "/opt/sharednet";
const CONTAINER_AUTH = "/run/codex/auth.json";
const THREAD_MARKER = `${CONTAINER_HOME}/.prometheus-thread-id`;
const MAX_OUTPUT_BYTES = 64_000;
const PROMETHEUS_LABEL = "io.sharednet.prometheus";
const ARTIFACT_MANIFEST = ".sharednet-artifacts.json";

export interface PrometheusRuntimeDependencies {
  docker: DockerRunner;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  uid?: number | null;
  gid?: number | null;
}

export interface EnsureTeamInput {
  workspaceKey: string;
  workspacePath: string;
  model: string;
  policySha256: string;
  policy: string;
  plan: RunPlan;
  /** Absolute run deadline. Bootstrap turns must never outlive it. */
  deadlineAt?: string;
  existing?: PrometheusTeamState | null;
}

export interface AttachRoomInput {
  roomId: string;
  inviteToken: string;
  baseUrl: string;
  turnLimitMs?: number;
  idempotencyKeys?: Partial<Record<PrometheusRole, string>>;
}

export type PrometheusServeState = "listening" | "working" | "retrying" | "stopped" | "unhealthy";

export interface PrometheusRuntimeStatus {
  healthy: boolean;
  roles: Record<PrometheusRole, { state: PrometheusServeState; unanswered: unknown[] }>;
}

export interface SemanticCheckResult {
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  output: string;
  outputSha256: string;
}

function stableName(workspaceKey: string, role: PrometheusRole): string {
  return `sharednet-prometheus-${workspaceKey}-${role}`;
}

interface DockerInspect {
  Config?: { Image?: unknown; User?: unknown; Cmd?: unknown; Labels?: Record<string, unknown> | null };
  Mounts?: Array<{ Type?: unknown; Name?: unknown; Source?: unknown; Destination?: unknown; RW?: unknown }>;
}

function expectedUser(dependencies: PrometheusRuntimeDependencies): string {
  const uid = dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const gid = dependencies.gid ?? (typeof process.getgid === "function" ? process.getgid() : null);
  return Number.isInteger(uid) && Number.isInteger(gid) ? `${uid}:${gid}` : "node";
}

function hasMount(inspected: DockerInspect, expected: { type: "bind" | "volume"; source: string; destination: string; rw: boolean }): boolean {
  return (inspected.Mounts ?? []).some((mount) =>
    mount.Type === expected.type &&
    (expected.type === "volume" ? mount.Name === expected.source : mount.Source === expected.source) &&
    mount.Destination === expected.destination &&
    mount.RW === expected.rw);
}

function parseInspect(raw: string): DockerInspect | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "object" && parsed[0] !== null
      ? parsed[0] as DockerInspect
      : null;
  } catch {
    return null;
  }
}

async function verifiedContainer(
  input: EnsureTeamInput,
  role: PrometheusRole,
  dependencies: PrometheusRuntimeDependencies,
): Promise<{ exists: false } | { exists: true }> {
  const container = stableName(input.workspaceKey, role);
  const volume = `${container}-home`;
  const result = await dependencies.docker(["container", "inspect", container]);
  if (result.code !== 0) return { exists: false };
  const inspected = parseInspect(result.stdout);
  const labels = inspected?.Config?.Labels ?? {};
  const authFile = input.plan.codexAuth?.kind === "login" ? input.plan.codexAuth.file : null;
  const identityMatches = inspected !== null &&
    inspected.Config?.Image === input.plan.image &&
    inspected.Config?.User === expectedUser(dependencies) &&
    JSON.stringify(inspected.Config?.Cmd) === JSON.stringify(["sleep", "infinity"]) &&
    labels[PROMETHEUS_LABEL] === "local-v1" &&
    labels[`${PROMETHEUS_LABEL}.workspace`] === input.workspaceKey &&
    labels[`${PROMETHEUS_LABEL}.role`] === role &&
    hasMount(inspected, { type: "volume", source: volume, destination: CONTAINER_HOME, rw: true }) &&
    hasMount(inspected, { type: "bind", source: input.workspacePath, destination: CONTAINER_WORKSPACE, rw: true }) &&
    hasMount(inspected, { type: "bind", source: input.plan.cli.root, destination: CONTAINER_CLI, rw: false }) &&
    (authFile !== null
      ? hasMount(inspected, { type: "bind", source: authFile, destination: CONTAINER_AUTH, rw: false })
      : !(inspected.Mounts ?? []).some((mount) => mount.Destination === CONTAINER_AUTH));
  if (!identityMatches) {
    throw localError("prometheus_team_invalid", `The saved ${role} container does not match the Prometheus runtime identity.`);
  }
  return { exists: true };
}

/** Verify saved container identity without starting it or reading mutable runtime state. */
export async function verifyPrometheusTeamIdentity(
  input: EnsureTeamInput & { existing: PrometheusTeamState },
  dependencies: PrometheusRuntimeDependencies,
): Promise<void> {
  if (input.existing.model !== input.model || input.existing.workspace_key !== input.workspaceKey || input.existing.workspace_path !== input.workspacePath) {
    throw localError("prometheus_team_mismatch", "The saved Prometheus team does not match this workspace and model.");
  }
  for (const role of PROMETHEUS_ROLES) {
    const expectedContainer = stableName(input.workspaceKey, role);
    const saved = input.existing.roles[role];
    if (saved.container_name !== expectedContainer || saved.volume_name !== `${expectedContainer}-home` || !saved.thread_id) {
      throw localError("prometheus_team_invalid", `The saved ${role} runtime cannot be reused safely.`);
    }
    const inspected = await verifiedContainer(input, role, dependencies);
    if (!inspected.exists) throw localError("prometheus_team_missing", `The saved ${role} container is missing; Prometheus will not replace its thread.`);
  }
}

function temporaryTeam(input: EnsureTeamInput): PrometheusTeamState {
  return {
    schema_version: 1 as const,
    workspace_key: input.workspaceKey,
    workspace_path: input.workspacePath,
    model: input.model,
    roles: Object.fromEntries(PROMETHEUS_ROLES.map((candidate) => [candidate, {
      container_name: stableName(input.workspaceKey, candidate),
      volume_name: `${stableName(input.workspaceKey, candidate)}-home`,
      thread_id: "pending",
    }])) as PrometheusTeamState["roles"],
    last_policy_sha256: input.policySha256,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  };
}

async function savedThreadMarker(
  input: EnsureTeamInput,
  role: PrometheusRole,
  dependencies: PrometheusRuntimeDependencies,
): Promise<string | null> {
  const marker = await roleExec(dependencies.docker, temporaryTeam(input), role, ["cat", THREAD_MARKER]);
  const threadId = marker.stdout.trim();
  return marker.code === 0 && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(threadId) ? threadId : null;
}

function roleExec(
  docker: DockerRunner,
  team: PrometheusTeamState,
  role: PrometheusRole,
  command: readonly string[],
  options: { env?: Record<string, string>; detach?: boolean; input?: string } = {},
) {
  const environment = options.env ?? {};
  return docker([
    "exec",
    ...(options.detach ? ["--detach"] : []),
    "--workdir", CONTAINER_WORKSPACE,
    "-e", `HOME=${CONTAINER_HOME}`,
    "-e", `CODEX_HOME=${CONTAINER_HOME}/.codex`,
    ...Object.keys(environment).flatMap((name) => ["-e", name]),
    team.roles[role].container_name,
    ...command,
  ], { env: environment, ...(options.input === undefined ? {} : { input: options.input }) });
}

function threadId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    try {
      const item = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (item.type === "thread.started" && typeof item.thread_id === "string" && item.thread_id.length > 0) return item.thread_id;
    } catch {}
  }
  return null;
}

function bootstrapPrompt(role: PrometheusRole, policy: string): string {
  const duty = role === "coordinator"
    ? "decompose typed work, route exact member-id handoffs, and resolve the verified result"
    : role === "builder"
      ? "accept typed work, modify the shared workspace, and publish the submission artifact"
      : "independently inspect the exact submission artifact and publish verification evidence";
  return [
    `You are the persistent Prometheus ${role}. Your duty is to ${duty}.`,
    "The current PROMETHEUS.md policy follows. A later run may supersede it.",
    policy,
    "This bootstrap turn creates your persistent thread only. Do no Goal work and reply exactly READY.",
  ].join("\n\n");
}

function bootstrapTimeoutSeconds(input: EnsureTeamInput, dependencies: PrometheusRuntimeDependencies): string {
  const maximumMs = 120_000;
  if (!input.deadlineAt) return "120";
  const remainingMs = Date.parse(input.deadlineAt) - (dependencies.now ?? (() => new Date()))().getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw localError("prometheus_deadline_reached", "The Prometheus deadline passed before agent bootstrap completed.");
  }
  return `${(Math.min(maximumMs, remainingMs) / 1_000).toFixed(3)}s`;
}

/** Create the fixed local team once; subsequent calls verify and reuse its exact containers and threads. */
export async function ensurePrometheusTeam(
  input: EnsureTeamInput,
  dependencies: PrometheusRuntimeDependencies,
): Promise<PrometheusTeamState> {
  const now = (dependencies.now ?? (() => new Date()))().toISOString();
  const user = expectedUser(dependencies);
  if (input.existing) {
    await verifyPrometheusTeamIdentity({ ...input, existing: input.existing }, dependencies);
    for (const role of PROMETHEUS_ROLES) {
      const saved = input.existing.roles[role];
      const started = await dependencies.docker(["start", saved.container_name]);
      if (started.code !== 0) throw localError("container_failed", `The saved ${role} container could not be started.`);
      const marker = await savedThreadMarker(input, role, dependencies);
      if (marker !== saved.thread_id) throw localError("prometheus_team_invalid", `The saved ${role} thread marker does not match team.json.`);
    }
    return { ...input.existing, last_policy_sha256: input.policySha256, updated_at: now };
  }

  const roles = {} as PrometheusTeamState["roles"];
  for (const role of PROMETHEUS_ROLES) {
    const container = stableName(input.workspaceKey, role);
    const volume = `${container}-home`;
    const recovered = await verifiedContainer(input, role, dependencies);
    if (recovered.exists) {
      const started = await dependencies.docker(["start", container]);
      if (started.code !== 0) throw localError("container_failed", `The saved ${role} container could not be started.`);
      const marker = await savedThreadMarker(input, role, dependencies);
      if (marker !== null) {
        roles[role] = { container_name: container, volume_name: volume, thread_id: marker };
        continue;
      }
    } else {
      const volumeResult = await dependencies.docker(["volume", "create", volume]);
      if (volumeResult.code !== 0) throw localError("container_failed", `The ${role} home volume could not be created.`);
      const created = await dependencies.docker([
        "create", "--name", container,
        "--user", user,
        "--label", `${PROMETHEUS_LABEL}=local-v1`,
        "--label", `${PROMETHEUS_LABEL}.workspace=${input.workspaceKey}`,
        "--label", `${PROMETHEUS_LABEL}.role=${role}`,
        "--add-host", "host.docker.internal:host-gateway",
        "--volume", `${volume}:${CONTAINER_HOME}`,
        "--volume", `${input.workspacePath}:${CONTAINER_WORKSPACE}`,
        "--volume", `${input.plan.cli.root}:${CONTAINER_CLI}:ro`,
        ...(input.plan.codexAuth?.kind === "login" ? ["--volume", `${input.plan.codexAuth.file}:${CONTAINER_AUTH}:ro`] : []),
        input.plan.image, "sleep", "infinity",
      ]);
      if (created.code !== 0) throw localError("container_failed", `The ${role} container could not be created: ${created.stderr.trim().slice(-400)}`);
      const started = await dependencies.docker(["start", container]);
      if (started.code !== 0) throw localError("container_failed", `The ${role} container could not be started.`);
    }
    const entry = `${CONTAINER_CLI}/${input.plan.cli.entry}`;
    const wrapper = `#!/bin/sh\nexec node ${entry.endsWith(".ts") ? "--experimental-strip-types --no-warnings " : ""}${entry} "$@"\n`;
    const installed = await dependencies.docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "cat > /usr/local/bin/sharednet && chmod 755 /usr/local/bin/sharednet"], { input: wrapper });
    if (installed.code !== 0) throw localError("container_failed", `The sharednet command could not be installed for ${role}.`);
    const prepared = await dependencies.docker(["exec", "--user", "root", container, "sh", "-c", `mkdir -p '${CONTAINER_HOME}/.codex' && chown -R ${user} '${CONTAINER_HOME}'${input.plan.codexAuth?.kind === "login" ? ` && ln -sf '${CONTAINER_AUTH}' '${CONTAINER_HOME}/.codex/auth.json'` : ""}`]);
    if (prepared.code !== 0) throw localError("container_failed", `The ${role} Codex home could not be prepared.`);
    const configured = await dependencies.docker(["exec", "--user", user, "--interactive", container, "sh", "-c", `cat > '${CONTAINER_HOME}/.codex/config.toml'`], { input: `model = "${input.model}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n` });
    if (configured.code !== 0) throw localError("container_failed", `The ${role} Codex configuration could not be written.`);
    const bootstrapped = await dependencies.docker([
      "exec", "--user", user, "--workdir", CONTAINER_WORKSPACE,
      "-e", `HOME=${CONTAINER_HOME}`, "-e", `CODEX_HOME=${CONTAINER_HOME}/.codex`,
      ...(input.plan.codexAuth?.kind === "api-key" ? ["-e", "OPENAI_API_KEY"] : []),
      container, "timeout", "--signal=TERM", "--kill-after=5s", bootstrapTimeoutSeconds(input, dependencies), "codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-m", input.model, bootstrapPrompt(role, input.policy),
    ]);
    const thread = threadId(bootstrapped.stdout);
    if (bootstrapped.code !== 0 || thread === null) throw localError("agent_bootstrap_failed", `The ${role} persistent Codex thread could not be created.`);
    const marked = await dependencies.docker(["exec", "--user", user, "--interactive", container, "sh", "-c", `cat > '${THREAD_MARKER}'`], { input: `${thread}\n` });
    if (marked.code !== 0) throw localError("agent_bootstrap_failed", `The ${role} persistent thread marker could not be saved.`);
    roles[role] = { container_name: container, volume_name: volume, thread_id: thread };
  }
  return {
    schema_version: 1,
    workspace_key: input.workspaceKey,
    workspace_path: input.workspacePath,
    model: input.model,
    roles,
    last_policy_sha256: input.policySha256,
    created_at: now,
    updated_at: now,
  };
}

/** Join the saved threads to one fresh Room and wait for each exact seat to be listening. */
export async function attachPrometheusRoom(
  team: PrometheusTeamState,
  input: AttachRoomInput,
  dependencies: PrometheusRuntimeDependencies,
): Promise<PrometheusRoster> {
  const roster = {} as PrometheusRoster;
  for (const role of PROMETHEUS_ROLES) {
    const saved = team.roles[role];
    const joined = await roleExec(dependencies.docker, team, role, ["sharednet", "join", input.roomId, "--name", role, "--no-wake", "--json"], {
      env: {
        SHAREDNET_INVITE_TOKEN: input.inviteToken,
        CODEX_SESSION_ID: saved.thread_id,
        SHAREDNET_BASE_URL: input.baseUrl,
        SHAREDNET_REUSE_RUNTIME_SESSION: "1",
        ...(input.idempotencyKeys?.[role] ? { SHAREDNET_JOIN_IDEMPOTENCY_KEY: input.idempotencyKeys[role]! } : {}),
      },
    });
    let memberId: string | null = null;
    try { memberId = (JSON.parse(joined.stdout) as { member_id?: string }).member_id ?? null; } catch {}
    if (joined.code !== 0 || memberId === null) throw localError("join_failed", `The ${role} thread could not join the Prometheus Room.`);
    roster[role] = { member_id: memberId, thread_id: saved.thread_id, container_name: saved.container_name };
    const wake = await roleExec(dependencies.docker, team, role, ["sharednet", "wake", "set", "codex", "--resume", saved.thread_id, "--command", "codex", "--as", memberId, "--json"], { env: { SHAREDNET_BASE_URL: input.baseUrl } });
    if (wake.code !== 0) throw localError("wake_setup_failed", `The ${role} wake binding could not be set.`);
    await roleExec(dependencies.docker, team, role, ["sharednet", "wake", "limit", `${(input.turnLimitMs ?? 1_200_000) / 1000}s`, "--as", memberId, "--json"], { env: { SHAREDNET_BASE_URL: input.baseUrl } });
  }
  await ensurePrometheusListeners(team, input.roomId, roster, input.baseUrl, dependencies);
  return roster;
}

/** Restart the saved all-Room serve processes without creating seats or Codex threads. */
export async function ensurePrometheusListeners(
  team: PrometheusTeamState,
  roomId: string,
  roster: PrometheusRoster,
  baseUrl: string,
  dependencies: PrometheusRuntimeDependencies,
): Promise<void> {
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (const role of PROMETHEUS_ROLES) {
    let started = false;
    const initial = await roleExec(dependencies.docker, team, role, ["sharednet", "serve", "--status", "--json"], { env: { SHAREDNET_BASE_URL: baseUrl } });
    try { started = initial.code === 0 && (JSON.parse(initial.stdout) as { running?: unknown }).running === true; } catch {}
    if (!started) {
      const served = await roleExec(dependencies.docker, team, role, ["sh", "-c", "exec sharednet serve >>\"$HOME/serve.log\" 2>&1"], { env: { SHAREDNET_BASE_URL: baseUrl }, detach: true });
      if (served.code !== 0) throw localError("serve_failed", `The ${role} listener could not be started.`);
    }
    let listening = false;
    for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
      const status = await roleExec(dependencies.docker, team, role, ["sharednet", "serve", "--status", "--json"], { env: { SHAREDNET_BASE_URL: baseUrl } });
      try {
        const parsed = JSON.parse(status.stdout) as { running?: unknown; wake_protocol?: unknown; seats?: Array<{ room_id?: unknown; member_id?: unknown; state?: unknown }> };
        listening = status.code === 0 && parsed.running === true && parsed.wake_protocol === "wake-plugins-v1" && (parsed.seats ?? []).some((seat) =>
          seat.room_id === roomId && seat.member_id === roster[role].member_id && seat.state === "listening");
      } catch {}
      if (!listening) await sleep(250);
    }
    if (!listening) throw localError("serve_not_listening", `The ${role} listener did not reach listening.`);
  }
}

export async function inspectPrometheusRuntime(
  team: PrometheusTeamState,
  roomId: string,
  roster: PrometheusRoster,
  dependencies: Pick<PrometheusRuntimeDependencies, "docker"> & { baseUrl?: string },
): Promise<PrometheusRuntimeStatus> {
  const roles = {} as PrometheusRuntimeStatus["roles"];
  let healthy = true;
  for (const role of PROMETHEUS_ROLES) {
    const env = dependencies.baseUrl ? { SHAREDNET_BASE_URL: dependencies.baseUrl } : undefined;
    const result = await roleExec(dependencies.docker, team, role, ["sharednet", "serve", "--status", "--json"], { env });
    let state: PrometheusServeState = "unhealthy";
    try {
      const parsed = JSON.parse(result.stdout) as { running?: unknown; wake_protocol?: unknown; seats?: Array<{ room_id?: unknown; member_id?: unknown; state?: unknown }> };
      const seat = (parsed.seats ?? []).find((candidate) => candidate.room_id === roomId && candidate.member_id === roster[role].member_id);
      const candidate = seat?.state;
      state = result.code === 0 && parsed.running === true && parsed.wake_protocol === "wake-plugins-v1" && ["listening", "working", "retrying", "stopped"].includes(String(candidate)) ? candidate as PrometheusServeState : "unhealthy";
    } catch {}
    const handed = await roleExec(dependencies.docker, team, role, ["sharednet", "handed", "--as", roster[role].member_id, "--json"], { env });
    let unanswered: unknown[] = [];
    try {
      const parsed = JSON.parse(handed.stdout) as unknown;
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { unanswered?: unknown }).unanswered)
          ? (parsed as { unanswered: unknown[] }).unanswered
          : [];
      unanswered = list.filter((item) => typeof item !== "object" || item === null || (item as { room_id?: unknown }).room_id === undefined || (item as { room_id?: unknown }).room_id === roomId);
    } catch { state = "unhealthy"; }
    if (state !== "listening" || handed.code !== 0) healthy = false;
    roles[role] = { state, unanswered };
  }
  return { healthy, roles };
}

function bounded(raw: string): string {
  const bytes = Buffer.from(raw);
  return bytes.byteLength <= MAX_OUTPUT_BYTES ? raw : bytes.subarray(bytes.byteLength - MAX_OUTPUT_BYTES).toString("utf8");
}

interface ArtifactSnapshotManifest {
  schema_version: 1;
  artifacts: Array<{ name: string; artifact_id: string; sha256: string; file: string }>;
  snapshot_sha256: string;
}

export interface PrometheusArtifactSnapshot {
  path: string;
  sha256: string;
  artifacts: ArtifactSnapshotManifest["artifacts"];
}

function snapshotDigest(artifacts: ArtifactSnapshotManifest["artifacts"]): string {
  return createHash("sha256").update(JSON.stringify({ schema_version: 1, artifacts }), "utf8").digest("hex");
}

async function verifyArtifactSnapshot(target: string, expected: readonly CandidateArtifact[]): Promise<PrometheusArtifactSnapshot> {
  let parsed: ArtifactSnapshotManifest;
  try {
    parsed = JSON.parse(await readFile(`${target}/${ARTIFACT_MANIFEST}`, "utf8")) as ArtifactSnapshotManifest;
  } catch {
    throw localError("prometheus_artifact_snapshot_invalid", "The saved Prometheus artifact snapshot is missing or invalid.");
  }
  if (parsed.schema_version !== 1 || !Array.isArray(parsed.artifacts) || !/^[0-9a-f]{64}$/.test(parsed.snapshot_sha256)) {
    throw localError("prometheus_artifact_snapshot_invalid", "The saved Prometheus artifact snapshot is invalid.");
  }
  const wanted = expected.map((artifact) => ({ name: artifact.name, artifact_id: artifact.artifactId, sha256: artifact.sha256 }));
  const actual = parsed.artifacts.map(({ name, artifact_id, sha256 }) => ({ name, artifact_id, sha256 }));
  if (JSON.stringify(actual) !== JSON.stringify(wanted) || snapshotDigest(parsed.artifacts) !== parsed.snapshot_sha256) {
    throw localError("prometheus_artifact_snapshot_invalid", "The saved Prometheus artifact snapshot does not match the current reviewed artifacts.");
  }
  for (const artifact of parsed.artifacts) {
    if (artifact.file !== "submission.tar") {
      throw localError("prometheus_artifact_snapshot_invalid", "The saved Prometheus artifact snapshot contains an unsafe filename.");
    }
    const bytes = await readFile(`${target}/${artifact.file}`).catch(() => null);
    if (bytes === null || createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
      throw localError("prometheus_artifact_snapshot_invalid", "The saved Prometheus artifact bytes no longer match their reviewed digest.");
    }
  }
  return { path: target, sha256: parsed.snapshot_sha256, artifacts: parsed.artifacts };
}

/** Download the service-attested deliverables once and expose only those immutable bytes to the semantic checker. */
export async function materializePrometheusArtifactSnapshot(
  artifacts: readonly CandidateArtifact[],
  client: Pick<ApiClient, "requestBytes">,
  memberToken: string,
  target: string,
  signal?: AbortSignal,
): Promise<PrometheusArtifactSnapshot> {
  if (artifacts.length !== 1 || artifacts[0]?.name !== "submission") {
    throw localError("prometheus_artifact_snapshot_invalid", "Prometheus local v1 requires exactly one submission tar artifact.");
  }
  try {
    return await verifyArtifactSnapshot(target, artifacts);
  } catch (error) {
    if ((error as { code?: string }).code !== "prometheus_artifact_snapshot_invalid") throw error;
    const exists = await readFile(`${target}/${ARTIFACT_MANIFEST}`).then(() => true, () => false);
    if (exists) throw error;
  }

  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${randomUUID()}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    const manifestArtifacts: ArtifactSnapshotManifest["artifacts"] = [];
    for (const artifact of artifacts) {
      const downloaded = await client.requestBytes(`/artifacts/${encodeURIComponent(artifact.artifactId)}/content`, memberToken, signal);
      const digest = createHash("sha256").update(downloaded.bytes).digest("hex");
      if (digest !== artifact.sha256 || (downloaded.sha256 !== null && downloaded.sha256 !== artifact.sha256)) {
        throw localError("prometheus_artifact_changed", `Artifact ${artifact.artifactId} does not match its compiled receipt.`);
      }
      const file = "submission.tar";
      await writeFile(`${temporary}/${file}`, downloaded.bytes, { flag: "wx", mode: 0o444 });
      manifestArtifacts.push({ name: artifact.name, artifact_id: artifact.artifactId, sha256: artifact.sha256, file });
    }
    const sha256 = snapshotDigest(manifestArtifacts);
    const manifest: ArtifactSnapshotManifest = { schema_version: 1, artifacts: manifestArtifacts, snapshot_sha256: sha256 };
    await writeFile(`${temporary}/${ARTIFACT_MANIFEST}`, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o444 });
    await chmod(temporary, 0o555);
    try {
      await rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
      await chmod(temporary, 0o700);
      await rm(temporary, { recursive: true, force: true });
    }
    return verifyArtifactSnapshot(target, artifacts);
  } catch (error) {
    await chmod(temporary, 0o700).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function runPrometheusCheck(
  runtime: { image: string; snapshot: string; snapshotSha256: string },
  check: string,
  environment: Record<"SHAREDNET_PROMETHEUS_RUN_ID" | "SHAREDNET_PROMETHEUS_WORK_ID" | "SHAREDNET_PROMETHEUS_RESULT_REF" | "SHAREDNET_PROMETHEUS_REVISION_SHA256" | "SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256", string>,
  dependencies: Pick<PrometheusRuntimeDependencies, "docker" | "now"> & { timeoutMs?: number; signal?: AbortSignal },
): Promise<SemanticCheckResult> {
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw localError("prometheus_deadline_reached", "The Prometheus deadline passed before the semantic check could start.");
  }
  if (runtime.snapshotSha256 !== environment.SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256) {
    throw localError("prometheus_artifact_snapshot_invalid", "The semantic check metadata does not match the mounted artifact snapshot.");
  }
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const result = await dependencies.docker([
    "run", "--rm", "--read-only", "--network", "none", "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges", "--volume", `${runtime.snapshot}:/prometheus-input:ro`,
    "--tmpfs", `${CONTAINER_WORKSPACE}:rw,nosuid,nodev,size=1g`,
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--workdir", CONTAINER_WORKSPACE,
    ...Object.keys(environment).flatMap((name) => ["-e", name]),
    runtime.image,
    "timeout", "--signal=TERM", "--kill-after=5s", `${(timeoutMs / 1_000).toFixed(3)}s`,
    "sh", "-c",
    "set -eu; tar -xf /prometheus-input/submission.tar -C /workspace --no-same-owner --no-same-permissions; exec sh -c \"$1\"",
    "prometheus-check", check,
  ], { env: environment, signal: dependencies.signal });
  const output = bounded(`${result.stdout}${result.stderr}`);
  return {
    startedAt,
    finishedAt: now().toISOString(),
    exitCode: result.code,
    output,
    outputSha256: createHash("sha256").update(output).digest("hex"),
  };
}
