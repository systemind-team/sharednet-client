// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_IMAGE, type DockerRunner, type RunPlan } from "./goal-run.ts";
import { ensurePrometheusListeners, ensurePrometheusTeam, inspectPrometheusRuntime, materializePrometheusArtifactSnapshot, runPrometheusCheck } from "./prometheus-runtime.ts";
import type { PrometheusTeamState } from "./prometheus-state.ts";

const plan: RunPlan = {
  image: DEFAULT_IMAGE,
  agents: [
    { name: "coordinator", driver: "codex", model: "gpt-6-sol" },
    { name: "builder", driver: "codex", model: "gpt-6-sol" },
    { name: "reviewer", driver: "codex", model: "gpt-6-sol" },
  ],
  workspace: "/work/project",
  cli: { root: "/opt/client", entry: "src/main.ts" },
  codexAuth: { kind: "login", file: "/owner/.codex/auth.json" },
  claudeAuth: null,
};

const WORKSPACE_KEY = "0".repeat(24);

function inspectPayload(role: "coordinator" | "builder" | "reviewer", overrides: Record<string, unknown> = {}) {
  const container = `sharednet-prometheus-${WORKSPACE_KEY}-${role}`;
  return JSON.stringify([{
    Config: {
      Image: DEFAULT_IMAGE,
      User: "1000:1000",
      Cmd: ["sleep", "infinity"],
      Labels: {
        "io.sharednet.prometheus": "local-v1",
        "io.sharednet.prometheus.workspace": WORKSPACE_KEY,
        "io.sharednet.prometheus.role": role,
      },
    },
    Mounts: [
      { Type: "volume", Name: `${container}-home`, Destination: "/home/prometheus", RW: true },
      { Type: "bind", Source: plan.workspace, Destination: "/workspace", RW: true },
      { Type: "bind", Source: plan.cli.root, Destination: "/opt/sharednet", RW: false },
      { Type: "bind", Source: plan.codexAuth!.file, Destination: "/run/codex/auth.json", RW: false },
    ],
    ...overrides,
  }]);
}

describe("persistent Prometheus runtime", () => {
  it("creates three stable role homes and reuses their saved threads", async () => {
    const calls: string[][] = [];
    const created = new Set<string>();
    const docker: DockerRunner = async (args) => {
      calls.push([...args]);
      const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate));
      if (args[0] === "container" && args[1] === "inspect") {
        return role && created.has(role)
          ? { code: 0, stdout: inspectPayload(role), stderr: "" }
          : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "create" && role) created.add(role);
      if (args[0] === "exec" && args.includes("cat") && role) {
        return { code: 0, stdout: `thr-${role}\n`, stderr: "" };
      }
      if (args[0] === "exec" && args.includes("codex")) {
        const container = args.find((value) => value.startsWith("sharednet-prometheus-"))!;
        return { code: 0, stdout: `${JSON.stringify({ type: "thread.started", thread_id: `thr-${container.split("-").at(-1)}` })}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const input = {
      workspaceKey: WORKSPACE_KEY,
      workspacePath: plan.workspace,
      model: "gpt-6-sol",
      policySha256: "a".repeat(64),
      policy: "## Motto\nShip it\n",
      plan,
    };

    const first = await ensurePrometheusTeam(input, { docker, now: () => new Date("2026-10-18T00:00:00.000Z"), uid: 1000, gid: 1000 });
    const beforeReuse = calls.length;
    const second = await ensurePrometheusTeam({ ...input, existing: first }, { docker, now: () => new Date("2026-10-18T00:01:00.000Z"), uid: 1000, gid: 1000 });

    expect(first.roles.coordinator).toMatchObject({ container_name: `sharednet-prometheus-${WORKSPACE_KEY}-coordinator`, volume_name: `sharednet-prometheus-${WORKSPACE_KEY}-coordinator-home` });
    expect(Object.values(first.roles).map((role) => role.thread_id)).toEqual(["thr-coordinator", "thr-builder", "thr-reviewer"]);
    expect(second.roles).toEqual(first.roles);
    const creates = calls.filter((args) => args[0] === "create");
    expect(creates).toHaveLength(3);
    expect(creates.every((args) => args.includes("--user") && args.includes("1000:1000"))).toBe(true);
    expect(calls.slice(beforeReuse).some((args) => args.includes("codex"))).toBe(false);
    expect(calls.flat().some((value) => value.includes("snk_") || value.includes("rit_"))).toBe(false);
  });

  it("rejects a saved container whose image, user, labels, mounts, auth mount, or thread marker changed", async () => {
    const existing: PrometheusTeamState = {
      schema_version: 1,
      workspace_key: WORKSPACE_KEY,
      workspace_path: plan.workspace,
      model: "gpt-6-sol",
      roles: {
        coordinator: { container_name: `sharednet-prometheus-${WORKSPACE_KEY}-coordinator`, volume_name: `sharednet-prometheus-${WORKSPACE_KEY}-coordinator-home`, thread_id: "thr-coordinator" },
        builder: { container_name: `sharednet-prometheus-${WORKSPACE_KEY}-builder`, volume_name: `sharednet-prometheus-${WORKSPACE_KEY}-builder-home`, thread_id: "thr-builder" },
        reviewer: { container_name: `sharednet-prometheus-${WORKSPACE_KEY}-reviewer`, volume_name: `sharednet-prometheus-${WORKSPACE_KEY}-reviewer-home`, thread_id: "thr-reviewer" },
      },
      last_policy_sha256: "a".repeat(64),
      created_at: "2026-10-18T00:00:00.000Z",
      updated_at: "2026-10-18T00:00:00.000Z",
    };
    const docker: DockerRunner = async (args) => {
      const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate))!;
      if (args[0] === "container" && args[1] === "inspect") {
        return { code: 0, stdout: inspectPayload(role, { Config: { Image: "attacker/image", User: "0:0", Cmd: ["sleep", "infinity"], Labels: {} } }), stderr: "" };
      }
      if (args[0] === "exec" && args.includes("cat")) return { code: 0, stdout: `thr-${role}\n`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

    await expect(ensurePrometheusTeam({
      workspaceKey: WORKSPACE_KEY, workspacePath: plan.workspace, model: "gpt-6-sol",
      policySha256: "a".repeat(64), policy: "## Motto\nShip\n", plan, existing,
    }, { docker, uid: 1000, gid: 1000 })).rejects.toMatchObject({ code: "prometheus_team_invalid" });
  });

  it("reconciles a partially bootstrapped team from verified containers and saved thread markers", async () => {
    const calls: string[][] = [];
    const started = new Set<string>();
    const docker: DockerRunner = async (args) => {
      calls.push([...args]);
      const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate))!;
      if (args[0] === "container" && args[1] === "inspect") return { code: 0, stdout: inspectPayload(role), stderr: "" };
      if (args[0] === "start") started.add(role);
      if (args[0] === "exec" && args.includes("cat")) return started.has(role)
        ? { code: 0, stdout: `thr-${role}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "container is stopped" };
      return { code: 0, stdout: "", stderr: "" };
    };

    const recovered = await ensurePrometheusTeam({
      workspaceKey: WORKSPACE_KEY, workspacePath: plan.workspace, model: "gpt-6-sol",
      policySha256: "a".repeat(64), policy: "## Motto\nShip\n", plan,
    }, { docker, now: () => new Date("2026-10-18T00:00:00.000Z"), uid: 1000, gid: 1000 });

    expect(Object.values(recovered.roles).map((role) => role.thread_id)).toEqual(["thr-coordinator", "thr-builder", "thr-reviewer"]);
    expect(calls.some((args) => args[0] === "create")).toBe(false);
    expect(calls.some((args) => args.includes("codex"))).toBe(false);
  });

  it("starts a verified stopped pre-bootstrap container before checking its marker, then completes bootstrap", async () => {
    const calls: string[][] = [];
    const started = new Set<string>();
    const marked = new Set<string>();
    const docker: DockerRunner = async (args) => {
      calls.push([...args]);
      const role = (["coordinator", "builder", "reviewer"] as const).find((candidate) => args.join(" ").includes(candidate))!;
      if (args[0] === "container" && args[1] === "inspect") return { code: 0, stdout: inspectPayload(role), stderr: "" };
      if (args[0] === "start") { started.add(role); return { code: 0, stdout: "", stderr: "" }; }
      if (args[0] === "exec" && args.includes("cat")) {
        if (!started.has(role)) return { code: 1, stdout: "", stderr: "container is stopped" };
        return marked.has(role) ? { code: 0, stdout: `thr-${role}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
      }
      if (args[0] === "exec" && args.includes("codex")) {
        return { code: 0, stdout: `${JSON.stringify({ type: "thread.started", thread_id: `thr-${role}` })}\n`, stderr: "" };
      }
      if (args.join(" ").includes(".prometheus-thread-id")) marked.add(role);
      return { code: 0, stdout: "", stderr: "" };
    };

    const recovered = await ensurePrometheusTeam({
      workspaceKey: WORKSPACE_KEY, workspacePath: plan.workspace, model: "gpt-6-sol",
      policySha256: "a".repeat(64), policy: "## Motto\nShip\n", plan,
    }, { docker, now: () => new Date("2026-10-18T00:00:00.000Z"), uid: 1000, gid: 1000 });

    expect(Object.values(recovered.roles).map((role) => role.thread_id)).toEqual(["thr-coordinator", "thr-builder", "thr-reviewer"]);
    expect(calls.filter((args) => args[0] === "create")).toHaveLength(0);
    expect(calls.filter((args) => args.includes("codex"))).toHaveLength(3);
    for (const role of ["coordinator", "builder", "reviewer"] as const) {
      const start = calls.findIndex((args) => args[0] === "start" && args.join(" ").includes(role));
      const markerRead = calls.findIndex((args) => args.includes("cat") && args.join(" ").includes(role));
      expect(start).toBeGreaterThanOrEqual(0);
      expect(markerRead).toBeGreaterThan(start);
    }
  });

  it("passes check metadata through the environment and bounds output", async () => {
    const seen: Array<{ args: readonly string[]; env?: Record<string, string> }> = [];
    const docker: DockerRunner = async (args, options) => {
      seen.push({ args, env: options?.env });
      return { code: 7, stdout: "x".repeat(70_000), stderr: "tail" };
    };
    const result = await runPrometheusCheck(
      { image: DEFAULT_IMAGE, snapshot: "/state/pinned-artifacts", snapshotSha256: "c".repeat(64) },
      "pnpm test",
      {
        SHAREDNET_PROMETHEUS_RUN_ID: "run-1",
        SHAREDNET_PROMETHEUS_WORK_ID: "work-1",
        SHAREDNET_PROMETHEUS_RESULT_REF: "evt-1",
        SHAREDNET_PROMETHEUS_REVISION_SHA256: "b".repeat(64),
        SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256: "c".repeat(64),
      },
      { docker, now: () => new Date("2026-10-18T00:00:00.000Z") },
    );
    expect(seen[0]!.env).toEqual({
      SHAREDNET_PROMETHEUS_RUN_ID: "run-1",
      SHAREDNET_PROMETHEUS_WORK_ID: "work-1",
      SHAREDNET_PROMETHEUS_RESULT_REF: "evt-1",
      SHAREDNET_PROMETHEUS_REVISION_SHA256: "b".repeat(64),
      SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256: "c".repeat(64),
    });
    expect(seen[0]!.args).toContain("/state/pinned-artifacts:/prometheus-input:ro");
    expect(seen[0]!.args).toEqual(expect.arrayContaining(["--read-only", "--network", "none", "--cap-drop", "ALL", "--tmpfs"]));
    expect(seen[0]!.args).toContain("/workspace:rw,nosuid,nodev,size=1g");
    expect(seen[0]!.args).toContain("/tmp:rw,nosuid,nodev,size=256m");
    expect(seen[0]!.args.join(" ")).toContain("tar -xf /prometheus-input/submission.tar");
    expect(seen[0]!.args.join(" ")).not.toContain(`${plan.workspace}:`);
    expect(seen[0]!.args.join(" ")).not.toContain("run-1");
    expect(seen[0]!.args).toContain("timeout");
    expect(seen[0]!.args).toContain("120.000s");
    expect(result.exitCode).toBe(7);
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64_000);
    expect(result.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes cancellation into an attached semantic-check container", async () => {
    const controller = new AbortController();
    let sawSignal = false;
    const docker: DockerRunner = async (_args, options) => new Promise((resolve) => {
      sawSignal = options?.signal === controller.signal;
      options?.signal?.addEventListener("abort", () => resolve({ code: 143, stdout: "", stderr: "terminated" }), { once: true });
    });
    const pending = runPrometheusCheck(
      { image: DEFAULT_IMAGE, snapshot: "/state/pinned-artifacts", snapshotSha256: "c".repeat(64) },
      "pnpm test",
      {
        SHAREDNET_PROMETHEUS_RUN_ID: "run-1",
        SHAREDNET_PROMETHEUS_WORK_ID: "work-1",
        SHAREDNET_PROMETHEUS_RESULT_REF: "evt-1",
        SHAREDNET_PROMETHEUS_REVISION_SHA256: "b".repeat(64),
        SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256: "c".repeat(64),
      },
      { docker, timeoutMs: 30_000, signal: controller.signal },
    );

    controller.abort();

    await expect(pending).resolves.toMatchObject({ exitCode: 143 });
    expect(sawSignal).toBe(true);
  });

  it("refuses to launch a check when its announced snapshot digest differs from the mounted snapshot", async () => {
    let launches = 0;
    await expect(runPrometheusCheck(
      { image: DEFAULT_IMAGE, snapshot: "/state/pinned-artifacts", snapshotSha256: "c".repeat(64) },
      "pnpm test",
      {
        SHAREDNET_PROMETHEUS_RUN_ID: "run-1",
        SHAREDNET_PROMETHEUS_WORK_ID: "work-1",
        SHAREDNET_PROMETHEUS_RESULT_REF: "evt-1",
        SHAREDNET_PROMETHEUS_REVISION_SHA256: "b".repeat(64),
        SHAREDNET_PROMETHEUS_ARTIFACT_SNAPSHOT_SHA256: "d".repeat(64),
      },
      { docker: async () => { launches += 1; return { code: 0, stdout: "", stderr: "" }; } },
    )).rejects.toMatchObject({ code: "prometheus_artifact_snapshot_invalid" });
    expect(launches).toBe(0);
  });

  it("materializes and re-verifies an immutable snapshot of the exact reviewed artifact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-artifacts-"));
    const snapshot = join(root, "snapshot");
    const bytes = new TextEncoder().encode("reviewed artifact\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let downloads = 0;
    const client = {
      requestBytes: async (path: string) => {
        downloads += 1;
        expect(path).toBe("/artifacts/art_Submit0001/content");
        return { bytes, filename: "submission.tar", sha256 };
      },
    };
    try {
      const first = await materializePrometheusArtifactSnapshot(
        [{ name: "submission", artifactId: "art_Submit0001", sha256 }],
        client as never,
        "member",
        snapshot,
      );
      const second = await materializePrometheusArtifactSnapshot(
        [{ name: "submission", artifactId: "art_Submit0001", sha256 }],
        client as never,
        "member",
        snapshot,
      );

      expect(downloads).toBe(1);
      expect(second).toEqual(first);
      expect(await readFile(join(snapshot, "submission.tar"), "utf8")).toBe("reviewed artifact\n");
      expect((await stat(snapshot)).mode & 0o777).toBe(0o555);
      expect((await stat(join(snapshot, "submission.tar"))).mode & 0o777).toBe(0o444);
      expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await import("node:fs/promises").then(({ chmod }) => chmod(snapshot, 0o700)).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects artifact content that does not match the compiled receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-artifacts-bad-"));
    const snapshot = join(root, "snapshot");
    try {
      await expect(materializePrometheusArtifactSnapshot(
        [{ name: "submission", artifactId: "art_Submit0001", sha256: "a".repeat(64) }],
        { requestBytes: async () => ({ bytes: new TextEncoder().encode("changed"), filename: null, sha256: null }) } as never,
        "member",
        snapshot,
      )).rejects.toMatchObject({ code: "prometheus_artifact_changed" });
    } finally {
      await import("node:fs/promises").then(({ chmod }) => chmod(snapshot, 0o700)).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes the run cancellation signal into artifact downloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-artifacts-cancel-"));
    const snapshot = join(root, "snapshot");
    const controller = new AbortController();
    let sawSignal = false;
    try {
      await expect(materializePrometheusArtifactSnapshot(
        [{ name: "submission", artifactId: "art_Submit0001", sha256: "a".repeat(64) }],
        {
          requestBytes: async (_path: string, _credential: string, signal?: AbortSignal) => {
            sawSignal = signal === controller.signal;
            throw new Error("stopped");
          },
        } as never,
        "member",
        snapshot,
        controller.signal,
      )).rejects.toThrow("stopped");
      expect(sawSignal).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restarts unfiltered listeners for saved seats without joining again", async () => {
    const calls: string[][] = [];
    const team: PrometheusTeamState = {
      schema_version: 1, workspace_key: "0".repeat(24), workspace_path: "/work/project", model: "gpt-6-sol",
      roles: {
        coordinator: { container_name: "c-coordinator", volume_name: "v1", thread_id: "t1" },
        builder: { container_name: "c-builder", volume_name: "v2", thread_id: "t2" },
        reviewer: { container_name: "c-reviewer", volume_name: "v3", thread_id: "t3" },
      },
      last_policy_sha256: "a".repeat(64), created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:00.000Z",
    };
    const roster = {
      coordinator: { member_id: "i_coord", thread_id: "t1", container_name: "c-coordinator" },
      builder: { member_id: "i_build", thread_id: "t2", container_name: "c-builder" },
      reviewer: { member_id: "i_review", thread_id: "t3", container_name: "c-reviewer" },
    };
    const docker: DockerRunner = async (args) => {
      calls.push([...args]);
      if (args.includes("--status")) {
        const role = String(args.find((arg) => arg.startsWith("c-"))).slice(2);
        const member = role === "coordinator" ? "i_coord" : role === "builder" ? "i_build" : "i_review";
        const checks = calls.filter((call) => call.includes("--status") && call.includes(`c-${role}`)).length;
        return { code: 0, stdout: JSON.stringify({ running: checks > 1, wake_protocol: "wake-plugins-v1", seats: checks > 1 ? [{ room_id: "rom_AbCdEfGhIj", member_id: member, state: "listening" }] : [] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await ensurePrometheusListeners(team, "rom_AbCdEfGhIj", roster, "https://www.sharednet.ai", { docker, sleep: async () => undefined });
    expect(calls.some((call) => call.includes("join"))).toBe(false);
    expect(calls.filter((call) => call.includes("sh") && call.join(" ").includes("sharednet serve"))).toHaveLength(3);
    expect(calls.filter((call) => call.includes("--rooms"))).toHaveLength(0);
  });

  it("keeps only the active Room's unsettled handed records", async () => {
    const team = {
      schema_version: 1 as const, workspace_key: "0".repeat(24), workspace_path: "/work/project", model: "gpt-6-sol",
      roles: { coordinator: { container_name: "c1", volume_name: "v1", thread_id: "t1" }, builder: { container_name: "c2", volume_name: "v2", thread_id: "t2" }, reviewer: { container_name: "c3", volume_name: "v3", thread_id: "t3" } },
      last_policy_sha256: "a".repeat(64), created_at: "2026-10-18T00:00:00.000Z", updated_at: "2026-10-18T00:00:00.000Z",
    };
    const roster = { coordinator: { member_id: "i_coord", thread_id: "t1", container_name: "c1" }, builder: { member_id: "i_build", thread_id: "t2", container_name: "c2" }, reviewer: { member_id: "i_review", thread_id: "t3", container_name: "c3" } };
    const members: Record<string, string> = { c1: "i_coord", c2: "i_build", c3: "i_review" };
    const docker: DockerRunner = async (args) => args.includes("--status")
      ? { code: 0, stdout: JSON.stringify({ running: true, wake_protocol: "wake-plugins-v1", seats: [{ room_id: "rom_AbCdEfGhIj", member_id: members[String(args.find((arg) => /^c\d$/.test(arg)))], state: "listening" }] }), stderr: "" }
      : { code: 0, stdout: JSON.stringify({ unanswered: [{ room_id: "rom_AbCdEfGhIj", through: 2 }, { room_id: "rom_OtherRoom1", through: 3 }] }), stderr: "" };
    const status = await inspectPrometheusRuntime(team, "rom_AbCdEfGhIj", roster, { docker });
    expect(status.healthy).toBe(true);
    expect(status.roles.coordinator.unanswered).toEqual([{ room_id: "rom_AbCdEfGhIj", through: 2 }]);
  });
});
