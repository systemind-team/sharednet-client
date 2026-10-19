// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_IMAGE, type DockerRunner, type RunPlan } from "./goal-run.ts";
import { cancelPrometheusRun, evaluatePrometheusBarrier, prometheusKickoff, prometheusStatus, readPrometheusMessages, resumePrometheusRun } from "./prometheus.ts";
import { claimMonitor, prometheusPaths, readActiveRun, requestCancel, reserveActiveRun, writeRun, writeTeam, type PrometheusRunState, type PrometheusTeamState } from "./prometheus-state.ts";
import type { ProcessProbe } from "./process-identity.ts";

const candidate = {
  stateDigest: "a".repeat(64),
  workId: "work-1",
  resultRef: "evt-1",
  artifacts: [],
  verifications: [],
  revisionSha256: "b".repeat(64),
};
const receipts = {
  ok: true as const,
  receipts: {
    coordinator: { sequence: 10, role: "coordinator" as const, memberId: "i_coord", runId: "run-1", revisionSha256: candidate.revisionSha256 },
    builder: { sequence: 11, role: "builder" as const, memberId: "i_build", runId: "run-1", revisionSha256: candidate.revisionSha256 },
    reviewer: { sequence: 12, role: "reviewer" as const, memberId: "i_review", runId: "run-1", revisionSha256: candidate.revisionSha256 },
  },
  missingRoles: [],
};

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

const plan: RunPlan = {
  image: DEFAULT_IMAGE,
  agents: (["coordinator", "builder", "reviewer"] as const).map((name) => ({ name, driver: "codex" as const, model: "gpt-6-sol" })),
  workspace: "/unused",
  cli: { root: "/opt/client", entry: "src/main.ts" },
  codexAuth: { kind: "login", file: "/owner/.codex/auth.json" },
  claudeAuth: null,
};

async function lifecycleFixture(checkpoint: PrometheusRunState["startup_checkpoint"] = "reserved", deadlineAt = "2026-10-18T02:00:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-lifecycle-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const policy = "## Motto\nShip\n\n## Rules\nBe exact\n\n## Preferences\nUse evidence\n\n## Handoff\nName the recipient\n\n## Completion\nRequire review\n";
  const goal = "Build the requested artifact.\n";
  await writeFile(join(workspace, "PROMETHEUS.md"), policy);
  await writeFile(join(workspace, "GOAL.md"), goal);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
  const paths = await prometheusPaths(env, workspace);
  const container = (role: string) => `sharednet-prometheus-${paths.workspaceKey}-${role}`;
  const roles = Object.fromEntries((["coordinator", "builder", "reviewer"] as const).map((role) => [role, {
    container_name: container(role), volume_name: `${container(role)}-home`, thread_id: `thr-${role}`,
  }])) as PrometheusTeamState["roles"];
  const team: PrometheusTeamState = {
    schema_version: 1, workspace_key: paths.workspaceKey, workspace_path: paths.workspacePath,
    model: "gpt-6-sol", roles, last_policy_sha256: createHash("sha256").update(policy).digest("hex"),
    created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:01.000Z",
  };
  const checkpointIndex = ["reserved", "room_created", "goal_started", "roles_joined", "listeners_ready", "kickoff_posted"].indexOf(checkpoint);
  const roster = Object.fromEntries((["coordinator", "builder", "reviewer"] as const).map((role) => [role, {
    member_id: `i_${role}`, thread_id: `thr-${role}`, container_name: container(role),
  }])) as NonNullable<PrometheusRunState["roster"]>;
  const run: PrometheusRunState = {
    schema_version: 1, run_id: "run_lifecycle", workspace_key: paths.workspaceKey, workspace_path: paths.workspacePath,
    configuration: {
      model: "gpt-6-sol", goal_path: join(workspace, "GOAL.md"),
      goal_sha256: createHash("sha256").update(goal).digest("hex"), policy_sha256: team.last_policy_sha256,
      check_command: "pnpm test",
    },
    startup_checkpoint: checkpoint,
    room: checkpointIndex >= 1 ? { room_id: "rom_Lifecycle", goal_sequence: checkpointIndex >= 2 ? 1 : null, kickoff_sequence: checkpointIndex >= 5 ? 2 : null } : null,
    roster: checkpointIndex >= 3 ? roster : null,
    idempotency_keys: { room: "run-room", goal: "run-goal", roles: { coordinator: "run-coordinator", builder: "run-builder", reviewer: "run-reviewer" }, kickoff: "run-kickoff" },
    deadline_at: deadlineAt, monitor: null, cancel_requested: false,
    outcome: checkpoint === "kickoff_posted" ? "running" : "starting", candidate: null, checks: [],
    created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:01.000Z", finished_at: null, reason: null,
  };
  const processState = { alive: true, identity: "test-process-start" };
  const probe: ProcessProbe = { supported: true, alive: () => processState.alive, identity: () => processState.identity, argv: () => null };
  await writeTeam(paths, team);
  const reservedRun: PrometheusRunState = {
    ...run,
    startup_checkpoint: "reserved",
    room: null,
    roster: null,
    outcome: "starting",
  };
  await reserveActiveRun(paths, reservedRun, probe);
  if (checkpoint !== "reserved") await writeRun(paths, run);
  return { root, workspace, env, paths, team, run, probe, processState };
}

function inspectJson(team: PrometheusTeamState, role: "coordinator" | "builder" | "reviewer") {
  const saved = team.roles[role];
  return JSON.stringify([{
    Config: { Image: DEFAULT_IMAGE, User: `${process.getuid?.() ?? "node"}:${process.getgid?.() ?? "node"}`, Cmd: ["sleep", "infinity"], Labels: { "io.sharednet.prometheus": "local-v1", "io.sharednet.prometheus.workspace": team.workspace_key, "io.sharednet.prometheus.role": role } },
    Mounts: [
      { Type: "volume", Name: saved.volume_name, Destination: "/home/prometheus", RW: true },
      { Type: "bind", Source: team.workspace_path, Destination: "/workspace", RW: true },
      { Type: "bind", Source: plan.cli.root, Destination: "/opt/sharednet", RW: false },
      { Type: "bind", Source: plan.codexAuth!.file, Destination: "/run/codex/auth.json", RW: false },
    ],
  }]);
}

function lifecycleDocker(team: PrometheusTeamState, calls: Array<{ args: readonly string[]; env?: Record<string, string> }>, liveTruth = false): DockerRunner {
  return async (args, options) => {
    calls.push({ args: [...args], env: options?.env });
    const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate)) ?? "coordinator";
    if (args[0] === "container" && args[1] === "inspect") return { code: 0, stdout: inspectJson(team, role), stderr: "" };
    if (args[0] === "exec" && args.includes("cat")) return { code: 0, stdout: `${team.roles[role].thread_id}\n`, stderr: "" };
    if (args.includes("join")) return { code: 0, stdout: JSON.stringify({ member_id: `i_${role}` }), stderr: "" };
    if (args.includes("--status")) return { code: 0, stdout: JSON.stringify({ running: true, wake_protocol: "wake-plugins-v1", seats: [{ room_id: "rom_Lifecycle", member_id: `i_${role}`, state: liveTruth && role === "builder" ? "working" : "listening" }] }), stderr: "" };
    if (args.includes("handed")) return { code: 0, stdout: JSON.stringify({ unanswered: liveTruth && role === "reviewer" ? [{ room_id: "rom_Lifecycle", through: 7 }] : [] }), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

describe("Prometheus completion barrier", () => {
  it("reads every message page so late terminal receipts remain visible", async () => {
    const paths: string[] = [];
    const client = {
      request: async (_method: string, path: string) => {
        paths.push(path);
        if (path.includes("after=0")) {
          return {
            items: Array.from({ length: 100 }, (_, index) => ({ sequence: index + 1, content: `message ${index + 1}` })),
            has_more: true,
          };
        }
        return {
          items: [{ sequence: 101, content: "terminal receipt" }],
          has_more: false,
        };
      },
    };

    const messages = await readPrometheusMessages(client as never, "rom_123", "token");

    expect(messages).toHaveLength(101);
    expect(messages.at(-1)?.sequence).toBe(101);
    expect(paths).toEqual([
      "/rooms/rom_123/messages?after=0&order=asc&limit=100",
      "/rooms/rom_123/messages?after=100&order=asc&limit=100",
    ]);
  });

  it("requires candidate, all authenticated receipts, listening seats, and no handed work", () => {
    const ready = evaluatePrometheusBarrier({
      candidate: { ok: true, candidate },
      receipts,
      runtime: {
        healthy: true,
        roles: {
          coordinator: { state: "listening", unanswered: [] },
          builder: { state: "listening", unanswered: [] },
          reviewer: { state: "listening", unanswered: [] },
        },
      },
    });
    expect(ready).toMatchObject({ ready: true, candidate });

    expect(evaluatePrometheusBarrier({
      candidate: { ok: true, candidate }, receipts,
      runtime: { healthy: true, roles: { coordinator: { state: "working", unanswered: [] }, builder: { state: "listening", unanswered: [] }, reviewer: { state: "listening", unanswered: [] } } },
    })).toEqual({ ready: false, reasons: ["coordinator is working"], revisionSha256: candidate.revisionSha256 });
    expect(evaluatePrometheusBarrier({
      candidate: { ok: true, candidate }, receipts,
      runtime: { healthy: true, roles: { coordinator: { state: "listening", unanswered: [{}] }, builder: { state: "listening", unanswered: [] }, reviewer: { state: "listening", unanswered: [] } } },
    })).toEqual({ ready: false, reasons: ["coordinator has unsettled handoff work"], revisionSha256: candidate.revisionSha256 });
    expect(evaluatePrometheusBarrier({
      candidate: { ok: true, candidate }, receipts,
      runtime: { healthy: false, roles: { coordinator: { state: "listening", unanswered: [] }, builder: { state: "listening", unanswered: [] }, reviewer: { state: "listening", unanswered: [] } } },
    })).toEqual({ ready: false, reasons: ["runtime status is unhealthy"], revisionSha256: candidate.revisionSha256 });
  });

  it("builds one exact-member coordinator kickoff with the policy and typed-work recipe", () => {
    const kickoff = prometheusKickoff({
      runId: "run-1", goalSequence: 3, deadlineAt: "2026-10-18T02:00:00.000Z", check: "pnpm test",
      goalSha256: "c".repeat(64), policy: { raw: "## Motto\nShip\n", sha256: "d".repeat(64), sections: { Motto: "Ship", Rules: "R", Preferences: "P", Handoff: "H", Completion: "C" } },
      roster: { coordinator: { member_id: "i_coord", thread_id: "t1", container_name: "c1" }, builder: { member_id: "i_build", thread_id: "t2", container_name: "c2" }, reviewer: { member_id: "i_review", thread_id: "t3", container_name: "c3" } },
    });
    expect(kickoff.startsWith("@i_coord ")).toBe(true);
    expect(kickoff).toContain("i_build");
    expect(kickoff).toContain("i_review");
    expect(kickoff).toContain("verification.pass");
    expect(kickoff).not.toContain("@all");
    expect(kickoff).not.toContain("@builder");
  });
});

describe("Prometheus lifecycle recovery", () => {
  it("resumes a reserved run through every missing startup checkpoint with the original idempotency keys", async () => {
    const fixture = await lifecycleFixture("reserved");
    const dockerCalls: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
    const requests: Array<{ method: string; path: string; headers?: Record<string, string> }> = [];
    let startupFinished = false;
    const client = { request: async (method: string, path: string, _credential: string, _body?: unknown, headers?: Record<string, string>) => {
      requests.push({ method, path, headers });
      if (path === "/rooms") return { room: { id: "rom_Lifecycle" } };
      if (path.endsWith("/goal")) return { message: { sequence: 1 } };
      if (path.endsWith("/invites")) return { token: `rit_${"t".repeat(43)}` };
      if (path.endsWith("/owner-messages")) { startupFinished = true; return { message: { sequence: 2 } }; }
      return { room: { state: "closed" } };
    } };

    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date(startupFinished ? "2026-10-18T03:00:00.000Z" : "2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, dockerCalls), plan: { ...plan, workspace: fixture.workspace },
      connect: async () => ({ client: client as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      processProbe: fixture.probe, sleep: async () => undefined,
    });

    expect(result).toMatchObject({ startup_checkpoint: "kickoff_posted", outcome: "timed_out", room: { room_id: "rom_Lifecycle", goal_sequence: 1, kickoff_sequence: 2 } });
    expect(await readActiveRun(fixture.paths)).toBeNull();
    expect(requests.filter((request) => request.path === "/rooms")).toHaveLength(1);
    expect(requests.find((request) => request.path === "/rooms")?.headers?.["idempotency-key"]).toBe("run-room");
    expect(requests.find((request) => request.path.endsWith("/goal"))?.headers?.["idempotency-key"]).toBe("run-goal");
    expect(requests.find((request) => request.path.endsWith("/owner-messages"))?.headers?.["idempotency-key"]).toBe("run-kickoff");
    for (const role of ["coordinator", "builder", "reviewer"] as const) {
      const join = dockerCalls.find((call) => call.args.includes("join") && call.args.join(" ").includes(role));
      expect(join?.env?.SHAREDNET_JOIN_IDEMPOTENCY_KEY).toBe(`run-${role}`);
    }
  });

  it.each([
    ["room_created", ["/rooms"]],
    ["goal_started", ["/rooms", "/rooms/rom_Lifecycle/goal"]],
    ["roles_joined", ["/rooms", "/rooms/rom_Lifecycle/goal", "/rooms/rom_Lifecycle/invites"]],
    ["listeners_ready", ["/rooms", "/rooms/rom_Lifecycle/goal", "/rooms/rom_Lifecycle/invites"]],
    ["kickoff_posted", ["/rooms", "/rooms/rom_Lifecycle/goal", "/rooms/rom_Lifecycle/invites", "/rooms/rom_Lifecycle/owner-messages"]],
  ] as const)("resumes exactly after the %s checkpoint", async (checkpoint, forbiddenPaths) => {
    const fixture = await lifecycleFixture(checkpoint, "2026-10-18T04:00:00.000Z");
    const requests: string[] = [];
    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        requests.push(path);
        if (path.endsWith("/goal")) return { message: { sequence: 1 } };
        if (path.endsWith("/invites")) return { token: `rit_${"t".repeat(43)}` };
        if (path.endsWith("/owner-messages")) return { message: { sequence: 2 } };
        if (path === "/rooms/rom_Lifecycle") return { room: { state: "closed" } };
        return {};
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ startup_checkpoint: "kickoff_posted", outcome: "failed" });
    for (const path of forbiddenPaths) expect(requests).not.toContain(path);
  });

  it("lets cancel own a dead monitor, closes once, and finishes the run", async () => {
    const fixture = await lifecycleFixture("kickoff_posted");
    const first = await claimMonitor(fixture.paths, fixture.run.run_id, fixture.probe);
    fixture.processState.identity = "replacement-process-start";
    const requests: string[] = [];
    const result = await cancelPrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => { requests.push(path); return {}; } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
    });

    expect(result).toMatchObject({ cancelled: true, recovered: true, outcome: "cancelled" });
    expect(requests).toEqual(["/rooms/rom_Lifecycle/close"]);
    expect((await readActiveRun(fixture.paths))).toBeNull();
    expect(first.start_identity).toBe("test-process-start");
  });

  it("records an unexpected Room closure as failed and clears the active slot", async () => {
    const fixture = await lifecycleFixture("kickoff_posted");
    const requests: string[] = [];
    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        requests.push(path);
        if (path === "/rooms/rom_Lifecycle") return { room: { state: "closed" } };
        return {};
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("closed") });
    expect(await readActiveRun(fixture.paths)).toBeNull();
    expect(requests[0]).toBe("/rooms/rom_Lifecycle");
  });

  it("reconciles a success close that committed before the terminal record", async () => {
    const fixture = await lifecycleFixture("kickoff_posted", "2026-10-18T00:30:00.000Z");
    const revision = "b".repeat(64);
    await writeRun(fixture.paths, {
      ...fixture.run,
      candidate: { compiled_digest: "a".repeat(64), work_id: "work-1", result_ref: "evt-1", revision_sha256: revision, observed_at: "2026-10-18T00:01:00.000Z" },
      updated_at: "2026-10-18T00:01:00.000Z",
    });
    await requestCancel(fixture.paths, fixture.run.run_id);
    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        if (path === "/rooms/rom_Lifecycle") return { room: { state: "closed", goal: { ended_by: { trigger: "prometheus_success", detail: revision } } } };
        throw new Error(`unexpected request ${path}`);
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
    });

    expect(result).toMatchObject({ outcome: "succeeded", cancel_requested: true, candidate: { revision_sha256: revision }, reason: expect.stringContaining("Recovered") });
    expect(await readActiveRun(fixture.paths)).toBeNull();
  });

  it("does not create a Room when cancellation lands during reusable-team bootstrap", async () => {
    const fixture = await lifecycleFixture("reserved", "2026-10-18T04:00:00.000Z");
    const calls: string[][] = [];
    const baseDocker = lifecycleDocker(fixture.team, []);
    let cancelled = false;
    const docker: DockerRunner = async (args, options) => {
      calls.push([...args]);
      if (!cancelled && args[0] === "start") {
        cancelled = true;
        await requestCancel(fixture.paths, fixture.run.run_id);
        await new Promise<void>((resolve) => {
          if (options?.signal?.aborted) resolve();
          else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        expect(options?.signal?.aborted).toBe(true);
      }
      return baseDocker(args, options);
    };
    let connected = false;

    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker, plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => { connected = true; throw new Error("must not connect after cancellation"); },
    });

    expect(result).toMatchObject({ outcome: "cancelled", startup_checkpoint: "reserved" });
    expect(connected).toBe(false);
    expect(await readActiveRun(fixture.paths)).toBeNull();
  });

  it("records an irrecoverable monitor protocol error as failed and closes the Room", async () => {
    const fixture = await lifecycleFixture("kickoff_posted");
    const requests: string[] = [];
    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        requests.push(path);
        if (path === "/rooms/rom_Lifecycle") return { room: { state: "open" } };
        if (path.endsWith("/state")) return { protocol_version: "rac/1", sequence: 0, digest: "empty", projection: { work: {} }, obligations: "none", events: [] };
        if (path.includes("/messages?")) return { items: "malformed", has_more: false };
        return {};
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("prometheus_history_incomplete") });
    expect(requests).toContain("/rooms/rom_Lifecycle/close");
    expect(await readActiveRun(fixture.paths)).toBeNull();
  });

  it("leaves a transient transport failure resumable instead of closing the Room", async () => {
    const fixture = await lifecycleFixture("kickoff_posted");
    const requests: string[] = [];
    await expect(resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, []), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        requests.push(path);
        throw new Error("network details that must not escape");
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "service_unavailable", message: "SharedNet could not complete the request." });

    expect(requests).toEqual(["/rooms/rom_Lifecycle"]);
    expect(await readActiveRun(fixture.paths)).toMatchObject({ outcome: "running", startup_checkpoint: "kickoff_posted" });
  });

  it("does not post kickoff while a resumed pre-kickoff seat is retrying", async () => {
    const fixture = await lifecycleFixture("roles_joined", "2026-10-18T04:00:00.000Z");
    const requests: string[] = [];
    const docker: DockerRunner = async (args) => {
      const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate)) ?? "coordinator";
      if (args[0] === "container" && args[1] === "inspect") return { code: 0, stdout: inspectJson(fixture.team, role), stderr: "" };
      if (args[0] === "exec" && args.includes("cat")) return { code: 0, stdout: `${fixture.team.roles[role].thread_id}\n`, stderr: "" };
      if (args.includes("--status")) return { code: 0, stdout: JSON.stringify({ running: true, wake_protocol: "wake-plugins-v1", seats: [{ room_id: "rom_Lifecycle", member_id: `i_${role}`, state: role === "reviewer" ? "retrying" : "listening" }] }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker, plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => { requests.push(path); return {}; } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "serve_not_listening" });

    expect(requests).not.toContain("/rooms/rom_Lifecycle/owner-messages");
    expect(await readActiveRun(fixture.paths)).toMatchObject({ startup_checkpoint: "roles_joined", outcome: "starting" });
  });

  it("terminalizes an irreparable saved-container identity mismatch", async () => {
    const fixture = await lifecycleFixture("reserved", "2026-10-18T04:00:00.000Z");
    const docker: DockerRunner = async (args) => {
      if (args[0] === "container" && args[1] === "inspect") {
        return { code: 0, stdout: JSON.stringify([{ Config: { Image: "unexpected/image", User: "0:0", Cmd: ["sleep", "infinity"], Labels: {} }, Mounts: [] }]), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await resumePrometheusRun(fixture.workspace, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker, plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => { throw new Error("must not connect before a Room exists"); },
    });

    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("prometheus_team_invalid") });
    expect(await readActiveRun(fixture.paths)).toBeNull();
  });

  it("reports live monitor, Room, runtime, and barrier truth when dependencies are available", async () => {
    const fixture = await lifecycleFixture("kickoff_posted");
    const holder = await claimMonitor(fixture.paths, fixture.run.run_id, fixture.probe);
    fixture.processState.identity = "replacement-process-start";
    const status = await prometheusStatus(fixture.workspace, fixture.env, {
      env: fixture.env, cwd: fixture.workspace, now: () => new Date("2026-10-18T01:00:00.000Z"),
      docker: lifecycleDocker(fixture.team, [], true), plan: { ...plan, workspace: fixture.workspace }, processProbe: fixture.probe,
      connect: async () => ({ client: { request: async (_method: string, path: string) => {
        if (path === "/rooms/rom_Lifecycle") return { room: { state: "open" } };
        if (path.endsWith("/state")) return { protocol_version: "rac/1", sequence: 0, digest: "empty", projection: { work: {} }, obligations: "none", events: [] };
        if (path.includes("/messages?")) return { items: [], has_more: false };
        return {};
      } } as never, memberToken: "member", apiKey: "api", baseUrl: "https://www.sharednet.ai" }),
    });

    expect(status.monitor).toMatchObject({ state: "reused", pid: holder.pid });
    expect(status.live).toMatchObject({ available: true, room_state: "open", runtime: { healthy: false, roles: { builder: { state: "working" }, reviewer: { unanswered: [{ through: 7 }] } } }, barrier: { ready: false } });
  });
});
