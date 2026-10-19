// @vitest-environment node

import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  claimMonitor,
  finishRun,
  prometheusPaths,
  readActiveRun,
  readRun,
  readTeam,
  requestCancel,
  reserveActiveRun,
  writeRun,
  writeTeam,
  type MonitorLease,
  type PrometheusRunState,
  type PrometheusTeamState,
} from "./prometheus-state.ts";
import type { ProcessProbe } from "./process-identity.ts";

const cleanup: string[] = [];
const CREATED_AT = "2026-10-18T00:00:00.000Z";
const UPDATED_AT = "2026-10-18T00:01:00.000Z";
const DEADLINE_AT = "2026-10-18T02:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-state-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
  };
  const paths = await prometheusPaths(env, workspace);
  return { root, workspace, env, paths };
}

function team(paths: Awaited<ReturnType<typeof prometheusPaths>>): PrometheusTeamState {
  return {
    schema_version: 1,
    workspace_key: paths.workspaceKey,
    workspace_path: paths.workspacePath,
    model: "gpt-6-sol",
    roles: {
      coordinator: {
        container_name: "sharednet-prometheus-coordinator",
        volume_name: "sharednet-prometheus-coordinator-home",
        thread_id: "019a-coordinator-thread",
      },
      builder: {
        container_name: "sharednet-prometheus-builder",
        volume_name: "sharednet-prometheus-builder-home",
        thread_id: "019a-builder-thread",
      },
      reviewer: {
        container_name: "sharednet-prometheus-reviewer",
        volume_name: "sharednet-prometheus-reviewer-home",
        thread_id: "019a-reviewer-thread",
      },
    },
    last_policy_sha256: SHA_A,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  };
}

function run(paths: Awaited<ReturnType<typeof prometheusPaths>>): PrometheusRunState {
  return {
    schema_version: 1,
    run_id: "run_20261018_demo",
    workspace_key: paths.workspaceKey,
    workspace_path: paths.workspacePath,
    configuration: {
      model: "gpt-6-sol",
      goal_path: join(paths.workspacePath, "GOAL.md"),
      goal_sha256: SHA_B,
      policy_sha256: SHA_A,
      check_command: "pnpm test",
    },
    startup_checkpoint: "reserved",
    room: null,
    roster: null,
    idempotency_keys: {
      room: "run_20261018_demo-room",
      goal: "run_20261018_demo-goal",
      roles: {
        coordinator: "run_20261018_demo-coordinator",
        builder: "run_20261018_demo-builder",
        reviewer: "run_20261018_demo-reviewer",
      },
      kickoff: "run_20261018_demo-kickoff",
    },
    deadline_at: DEADLINE_AT,
    monitor: null,
    cancel_requested: false,
    outcome: "starting",
    candidate: null,
    checks: [],
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    finished_at: null,
    reason: null,
  };
}

function anotherRun(
  paths: Awaited<ReturnType<typeof prometheusPaths>>,
  runId: string,
): PrometheusRunState {
  const state = run(paths);
  return {
    ...state,
    run_id: runId,
    idempotency_keys: {
      room: `${runId}-room`,
      goal: `${runId}-goal`,
      roles: {
        coordinator: `${runId}-coordinator`,
        builder: `${runId}-builder`,
        reviewer: `${runId}-reviewer`,
      },
      kickoff: `${runId}-kickoff`,
    },
  };
}

function rosteredRun(
  paths: Awaited<ReturnType<typeof prometheusPaths>>,
): PrometheusRunState {
  return {
    ...run(paths),
    startup_checkpoint: "roles_joined",
    room: { room_id: "rom_OneRoom", goal_sequence: 1, kickoff_sequence: null },
    roster: {
      coordinator: {
        member_id: "i_Coordinator",
        thread_id: "coordinator-thread",
        container_name: "prometheus-coordinator",
      },
      builder: {
        member_id: "i_Builder",
        thread_id: "builder-thread",
        container_name: "prometheus-builder",
      },
      reviewer: {
        member_id: "i_Reviewer",
        thread_id: "reviewer-thread",
        container_name: "prometheus-reviewer",
      },
    },
  };
}

function fakeProbe(identity = "test-process-start") {
  const alive = new Map<number, boolean>([[process.pid, true]]);
  const identities = new Map<number, string | null>([[process.pid, identity]]);
  const probe: ProcessProbe = {
    supported: true,
    alive: (pid) => alive.get(pid) ?? false,
    identity: (pid) => identities.get(pid) ?? null,
    argv: () => null,
  };
  return { probe, alive, identities };
}

function terminalRun(
  state: PrometheusRunState,
  lease: MonitorLease,
): PrometheusRunState {
  const finishedAt = new Date(Date.parse(state.updated_at) + 1_000).toISOString();
  return {
    ...state,
    monitor: lease,
    cancel_requested: true,
    outcome: "cancelled",
    updated_at: finishedAt,
    finished_at: finishedAt,
    reason: "Cancellation requested by the owner.",
  };
}

describe("Prometheus owner-only state", () => {
  it("keys the local-v1 state root by the real workspace path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-path-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-link");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    await symlink(workspace, alias);
    const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };

    const paths = await prometheusPaths(env, alias);
    const resolved = await realpath(workspace);
    const key = createHash("sha256").update(resolved).digest("hex").slice(0, 24);

    expect(paths.workspacePath).toBe(resolved);
    expect(paths.workspaceKey).toBe(key);
    expect(paths.rootDir).toBe(join(env.XDG_STATE_HOME, "sharednet", "prometheus", "local-v1", key));
    expect((await stat(paths.rootDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.runsDir)).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink anywhere in the managed Prometheus directory hierarchy", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-ancestor-"));
    cleanup.push(root);
    const workspace = join(root, "workspace");
    const stateDir = join(root, "state", "sharednet");
    const outside = join(root, "outside-prometheus");
    await mkdir(workspace);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await mkdir(outside, { mode: 0o700 });
    await symlink(outside, join(stateDir, "prometheus"));

    await expect(
      prometheusPaths({ HOME: root, XDG_STATE_HOME: join(root, "state") }, workspace),
    ).rejects.toMatchObject({ code: "unsafe_credential_storage" });
  });

  it("writes team and run files owner-only and atomically replaces a team", async () => {
    const { paths } = await fixture();
    const first = team(paths);
    const replacement = { ...first, last_policy_sha256: SHA_B, updated_at: "2026-10-18T00:02:00.000Z" };
    const state = run(paths);

    await writeTeam(paths, first);
    await writeTeam(paths, replacement);
    await reserveActiveRun(paths, state, fakeProbe().probe);

    expect(await readTeam(paths)).toEqual(replacement);
    expect(await readRun(paths, state.run_id)).toEqual(state);
    expect((await stat(paths.teamFile)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.runFile(state.run_id))).mode & 0o777).toBe(0o600);
    expect((await stat(paths.runDir(state.run_id))).mode & 0o777).toBe(0o700);
    expect((await readdir(paths.rootDir)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("rejects symlink and group-readable state targets", async () => {
    const { root, paths } = await fixture();
    const state = run(paths);
    await writeTeam(paths, team(paths));
    await reserveActiveRun(paths, state, fakeProbe().probe);

    const target = join(root, "team-target.json");
    await writeFile(target, "{}\n", { mode: 0o600 });
    await unlink(paths.teamFile);
    await symlink(target, paths.teamFile);
    await expect(readTeam(paths)).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    await expect(writeTeam(paths, team(paths))).rejects.toMatchObject({ code: "unsafe_credential_storage" });

    await chmod(paths.runFile(state.run_id), 0o640);
    await expect(readRun(paths, state.run_id)).rejects.toMatchObject({
      code: "unsafe_credential_storage",
    });
  });

  it("rejects a symlinked run directory before reading its owner-only file", async () => {
    const { root, paths } = await fixture();
    const state = run(paths);
    await reserveActiveRun(paths, state, fakeProbe().probe);
    const serialized = await readFile(paths.runFile(state.run_id), "utf8");
    const outside = join(root, "outside-run");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(join(outside, "run.json"), serialized, { mode: 0o600 });
    await rm(paths.runDir(state.run_id), { recursive: true });
    await symlink(outside, paths.runDir(state.run_id));

    await expect(readRun(paths, state.run_id)).rejects.toMatchObject({
      code: "unsafe_credential_storage",
    });
  });

  it("fails closed on malformed schemas, role maps, ids, and terminal state", async () => {
    const { paths } = await fixture();
    await writeFile(
      paths.teamFile,
      `${JSON.stringify({ ...team(paths), roles: { coordinator: team(paths).roles.coordinator } })}\n`,
      { mode: 0o600 },
    );
    await expect(readTeam(paths)).rejects.toMatchObject({ code: "invalid_local_state" });

    const state = run(paths);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(paths.runDir(state.run_id), { recursive: true, mode: 0o700 }),
    );
    await writeFile(
      paths.runFile(state.run_id),
      `${JSON.stringify({ ...state, outcome: "succeeded", finished_at: null, reason: null })}\n`,
      { mode: 0o600 },
    );
    await expect(readRun(paths, state.run_id)).rejects.toMatchObject({ code: "invalid_local_state" });
    await expect(readRun(paths, "../escape")).rejects.toMatchObject({ code: "invalid_local_state" });
  });

  it("never serializes credentials or caller-supplied secret fields", async () => {
    const { paths } = await fixture();
    const state = run(paths);
    const syntheticCapability = ["sn", "k_visibly-synthetic-test-only"].join("");
    const credentialPrefixes = [
      ["sn", "k_"].join(""),
      ["sn", "i_"].join(""),
      ["ri", "t_"].join(""),
    ];

    await writeTeam(paths, team(paths));
    await reserveActiveRun(paths, state, fakeProbe().probe);
    const serialized = `${await readFile(paths.teamFile, "utf8")}\n${await readFile(paths.runFile(state.run_id), "utf8")}`;
    for (const forbidden of credentialPrefixes) expect(serialized).not.toContain(forbidden);

    await expect(
      writeTeam(paths, { ...team(paths), api_key: syntheticCapability } as PrometheusTeamState),
    ).rejects.toMatchObject({ code: "invalid_local_state" });
    await expect(
      writeRun(paths, {
        ...state,
        environment: { OPENAI_API_KEY: syntheticCapability },
      } as PrometheusRunState),
    ).rejects.toMatchObject({ code: "invalid_local_state" });
  });

  it("persists ordinary checker output that names credential concepts", async () => {
    const { paths } = await fixture();
    const output = "invite flow failed while reading api_key from auth.json fixture";
    const state = {
      ...run(paths),
      checks: [
        {
          revision_sha256: SHA_A,
          artifact_snapshot_sha256: SHA_B,
          started_at: CREATED_AT,
          finished_at: UPDATED_AT,
          exit_code: 1,
          output,
          output_sha256: createHash("sha256").update(output).digest("hex"),
        },
      ],
    };

    await reserveActiveRun(paths, run(paths), fakeProbe().probe);
    await writeRun(paths, state);
    expect((await readRun(paths, state.run_id)).checks[0]?.output).toBe(output);
  });

  it("rejects synthetic OpenAI and Codex credentials embedded in free text", async () => {
    const openAiKey = ["s", "k-proj-visibly-synthetic-test-credential"].join("");
    const codexAuth = JSON.stringify({
      access_token: "visibly-synthetic-access-token",
      refresh_token: "visibly-synthetic-refresh-token",
      id_token: "visibly-synthetic-id-token",
    });
    const syntheticJwt = [
      "eyJhbGciOiJIUzI1NiJ9",
      "eyJzdWIiOiJ2aXNpYmx5LXN5bnRoZXRpYyJ9",
      "visibly-synthetic-signature",
    ].join(".");
    const cases: Array<(state: PrometheusRunState) => PrometheusRunState> = [
      (state) => ({
        ...state,
        configuration: { ...state.configuration, check_command: `test ${openAiKey}` },
      }),
      (state) => ({
        ...state,
        checks: [
          {
            revision_sha256: SHA_A,
            artifact_snapshot_sha256: SHA_B,
            started_at: CREATED_AT,
            finished_at: UPDATED_AT,
            exit_code: 1,
            output: codexAuth,
            output_sha256: SHA_B,
          },
        ],
      }),
      (state) => ({
        ...state,
        outcome: "failed",
        finished_at: UPDATED_AT,
        reason: `checker exposed ${codexAuth}`,
      }),
      (state) => ({
        ...state,
        configuration: { ...state.configuration, check_command: `inspect ${syntheticJwt}` },
      }),
      (state) => ({
        ...state,
        checks: [
          {
            revision_sha256: SHA_A,
            artifact_snapshot_sha256: SHA_B,
            started_at: CREATED_AT,
            finished_at: UPDATED_AT,
            exit_code: 1,
            output: `${["Bear", "er"].join("")} ${syntheticJwt}`,
            output_sha256: SHA_B,
          },
        ],
      }),
    ];

    for (const makeState of cases) {
      const { paths } = await fixture();
      await reserveActiveRun(paths, run(paths), fakeProbe().probe);
      await expect(writeRun(paths, makeState(run(paths)))).rejects.toMatchObject({
        code: "invalid_local_state",
      });
    }
  });

  it("rejects cross-role identity collisions in teams and run rosters", async () => {
    const { paths } = await fixture();
    for (const field of ["container_name", "volume_name", "thread_id"] as const) {
      const state = team(paths);
      state.roles.builder = {
        ...state.roles.builder,
        [field]: state.roles.coordinator[field],
      };
      await expect(writeTeam(paths, state)).rejects.toMatchObject({ code: "invalid_local_state" });
    }
    for (const field of ["member_id", "thread_id", "container_name"] as const) {
      const state = rosteredRun(paths);
      state.roster!.builder = {
        ...state.roster!.builder,
        [field]: state.roster!.coordinator[field],
      };
      await expect(writeRun(paths, state)).rejects.toMatchObject({ code: "invalid_local_state" });
    }
  });

  it("rejects a terminal timestamp before the last persisted update", async () => {
    const { paths } = await fixture();
    await expect(
      writeRun(paths, {
        ...run(paths),
        outcome: "failed",
        finished_at: CREATED_AT,
        reason: "Visibly synthetic failure.",
      }),
    ).rejects.toMatchObject({ code: "invalid_local_state" });
  });
});

describe("Prometheus active run and monitor lease", () => {
  it("requires a matching active record for every public nonterminal update", async () => {
    const { paths } = await fixture();
    const state = run(paths);

    await expect(writeRun(paths, state)).rejects.toMatchObject({
      code: "prometheus_run_not_active",
    });
    expect(await readRun(paths, state.run_id)).toBeNull();
  });

  it("lets exactly one concurrent caller reserve the active slot", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const first = run(paths);
    const second = anotherRun(paths, "run_20261018_second");

    const attempts = await Promise.allSettled([
      reserveActiveRun(paths, first, probe),
      reserveActiveRun(paths, second, probe),
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "prometheus_run_active" } });
    const active = JSON.parse(await readFile(paths.activeFile, "utf8")) as { run_id: string };
    expect([first.run_id, second.run_id]).toContain(active.run_id);
    expect(await readRun(paths, active.run_id)).not.toBeNull();
  });

  it("refuses a second run while an active or resumable run exists", async () => {
    const { paths } = await fixture();
    const holder = fakeProbe("holder-start");
    const first = run(paths);
    await reserveActiveRun(paths, first, holder.probe);
    await claimMonitor(paths, first.run_id, holder.probe);

    holder.alive.set(process.pid, false);
    holder.identities.set(process.pid, "replacement-start");
    await expect(
      reserveActiveRun(paths, anotherRun(paths, "run_20261018_second"), holder.probe),
    ).rejects.toMatchObject({ code: "prometheus_run_active" });
    expect((await readRun(paths, first.run_id))?.deadline_at).toBe(DEADLINE_AT);
  });

  it("does not let resume replace a live monitor or a reused pid", async () => {
    const { paths } = await fixture();
    const holder = fakeProbe("first-process-start");
    const state = run(paths);
    await reserveActiveRun(paths, state, holder.probe);
    const first = await claimMonitor(paths, state.run_id, holder.probe);

    const renewed = await claimMonitor(paths, state.run_id, holder.probe);
    expect(renewed.lease_id).toBe(first.lease_id);

    holder.identities.set(process.pid, "reused-pid-start");
    const replacement = await claimMonitor(paths, state.run_id, holder.probe);
    expect(replacement.lease_id).not.toBe(first.lease_id);
    expect(replacement.start_identity).toBe("reused-pid-start");
    expect((await readRun(paths, state.run_id))?.monitor).toEqual(replacement);
  });

  it("lets resume replace a dead exact process identity without changing the deadline", async () => {
    const { paths } = await fixture();
    const holder = fakeProbe("first-process-start");
    const state = run(paths);
    await reserveActiveRun(paths, state, holder.probe);
    const first = await claimMonitor(paths, state.run_id, holder.probe);

    holder.alive.set(first.pid, false);
    holder.identities.set(process.pid, "replacement-process-start");
    const replacement = await claimMonitor(paths, state.run_id, holder.probe);

    expect(replacement.lease_id).not.toBe(first.lease_id);
    expect((await readRun(paths, state.run_id))?.deadline_at).toBe(DEADLINE_AT);
  });

  it("lets cancel set cancel_requested while the monitor lease is live", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const state = run(paths);
    await reserveActiveRun(paths, state, probe);
    const lease = await claimMonitor(paths, state.run_id, probe);

    await Promise.all([requestCancel(paths, state.run_id), requestCancel(paths, state.run_id)]);

    expect(await readRun(paths, state.run_id)).toMatchObject({
      cancel_requested: true,
      monitor: lease,
    });
    expect(JSON.parse(await readFile(paths.activeFile, "utf8"))).toMatchObject({
      run_id: state.run_id,
      cancel_requested: true,
      monitor: lease,
    });
  });

  it("serializes public updates and preserves a concurrent cancellation and monitor lease", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const initial = run(paths);
    await reserveActiveRun(paths, initial, probe);
    const lease = await claimMonitor(paths, initial.run_id, probe);
    const stale = (await readRun(paths, initial.run_id))!;
    await requestCancel(paths, initial.run_id);
    const current = (await readRun(paths, initial.run_id))!;

    await writeRun(paths, {
      ...stale,
      startup_checkpoint: "room_created",
      room: { room_id: "rom_OneRoom", goal_sequence: null, kickoff_sequence: null },
      updated_at: new Date(Date.parse(current.updated_at) + 1_000).toISOString(),
    });

    expect(await readRun(paths, initial.run_id)).toMatchObject({
      startup_checkpoint: "room_created",
      cancel_requested: true,
      monitor: lease,
    });
  });

  it("requires finishRun for terminal transitions and never moves a checkpoint backwards", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const initial = run(paths);
    await reserveActiveRun(paths, initial, probe);
    const lease = await claimMonitor(paths, initial.run_id, probe);
    const current = (await readRun(paths, initial.run_id))!;
    const advanced: PrometheusRunState = {
      ...current,
      startup_checkpoint: "room_created",
      room: { room_id: "rom_OneRoom", goal_sequence: null, kickoff_sequence: null },
      updated_at: new Date(Date.parse(current.updated_at) + 1_000).toISOString(),
    };
    await writeRun(paths, advanced);

    await expect(writeRun(paths, terminalRun(advanced, lease))).rejects.toMatchObject({
      code: "prometheus_terminal_requires_lease",
    });
    await expect(
      writeRun(paths, {
        ...advanced,
        startup_checkpoint: "reserved",
        room: null,
        updated_at: new Date(Date.parse(advanced.updated_at) + 2_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "invalid_local_state" });
    expect((await readRun(paths, initial.run_id))?.startup_checkpoint).toBe("room_created");
  });

  it("preserves a cancellation that wins the race with a terminal write", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const initial = run(paths);
    await reserveActiveRun(paths, initial, probe);
    const lease = await claimMonitor(paths, initial.run_id, probe);
    const stale = (await readRun(paths, initial.run_id))!;
    await requestCancel(paths, initial.run_id);
    const current = (await readRun(paths, initial.run_id))!;
    const finishedAt = new Date(Date.parse(current.updated_at) + 1_000).toISOString();
    const finalState: PrometheusRunState = {
      ...stale,
      outcome: "failed",
      updated_at: finishedAt,
      finished_at: finishedAt,
      reason: "The monitor stopped after cancellation was requested.",
    };

    await finishRun(paths, finalState, lease);
    expect(await readRun(paths, initial.run_id)).toMatchObject({
      outcome: "failed",
      cancel_requested: true,
      monitor: lease,
    });
    await finishRun(paths, finalState, lease);
  });

  it("clears active only after the matching lease writes a terminal run", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const state = run(paths);
    await reserveActiveRun(paths, state, probe);
    const lease = await claimMonitor(paths, state.run_id, probe);
    await requestCancel(paths, state.run_id);
    const current = (await readRun(paths, state.run_id))!;
    const finalState = terminalRun(current, lease);

    await expect(
      finishRun(paths, finalState, { ...lease, lease_id: "wrong-lease" }),
    ).rejects.toMatchObject({ code: "prometheus_monitor_lease_lost" });
    expect(await readFile(paths.activeFile, "utf8")).toContain(state.run_id);
    expect((await readRun(paths, state.run_id))?.outcome).toBe("starting");

    await finishRun(paths, finalState, lease);
    expect(await readRun(paths, state.run_id)).toEqual(finalState);
    await expect(readFile(paths.activeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the active run without exposing the private active record", async () => {
    const { paths } = await fixture();
    const { probe } = fakeProbe();
    const state = run(paths);
    expect(await readActiveRun(paths)).toBeNull();
    await reserveActiveRun(paths, state, probe);
    expect(await readActiveRun(paths)).toEqual(state);
  });
});
