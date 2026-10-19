// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const races = vi.hoisted(() => ({
  disappearBeforeOpen: null as string | null,
  disappearBeforeUnlink: null as string | null,
  openedAfterRemoval: false,
  unlinkedAfterRemoval: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const path = String(args[0]);
      if (races.disappearBeforeOpen === path) {
        races.disappearBeforeOpen = null;
        await actual.unlink(args[0]);
        races.openedAfterRemoval = true;
      }
      return actual.open(...args);
    },
    unlink: async (...args: Parameters<typeof actual.unlink>) => {
      const path = String(args[0]);
      if (races.disappearBeforeUnlink === path) {
        races.disappearBeforeUnlink = null;
        await actual.unlink(...args);
        races.unlinkedAfterRemoval = true;
      }
      return actual.unlink(...args);
    },
  };
});

import type { ProcessProbe } from "./process-identity.ts";
import {
  claimMonitor,
  finishRun,
  prometheusPaths,
  readRun,
  reserveActiveRun,
  type PrometheusRunState,
} from "./prometheus-state.ts";
import { readOwnerOnlyFile } from "./storage.ts";

const cleanup: string[] = [];

afterEach(async () => {
  races.disappearBeforeOpen = null;
  races.disappearBeforeUnlink = null;
  races.openedAfterRemoval = false;
  races.unlinkedAfterRemoval = false;
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-prometheus-race-"));
  cleanup.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const paths = await prometheusPaths(
    { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") },
    workspace,
  );
  return { root, paths };
}

function fakeProbe(): ProcessProbe {
  return {
    supported: true,
    alive: (pid) => pid === process.pid,
    identity: (pid) => pid === process.pid ? "race-test-process" : null,
    argv: () => null,
  };
}

function run(
  paths: Awaited<ReturnType<typeof prometheusPaths>>,
): PrometheusRunState {
  return {
    schema_version: 2,
    run_id: "run_20261019_race",
    workspace_key: paths.workspaceKey,
    workspace_path: paths.workspacePath,
    configuration: {
      model: "gpt-6-sol",
      goal_path: join(paths.workspacePath, "GOAL.md"),
      goal_sha256: "a".repeat(64),
      policy_sha256: "b".repeat(64),
      check_command: "pnpm test",
      goal_request_body: {
        content: "Build the requested artifact.\n",
        until: ["at 2026-10-19T04:00:00.000Z"],
      },
    },
    startup_checkpoint: "reserved",
    room: null,
    roster: null,
    idempotency_keys: {
      room: "00000000-0000-4000-8000-000000000001",
      goal: "00000000-0000-4000-8000-000000000002",
      roles: {
        coordinator: "00000000-0000-4000-8000-000000000003",
        builder: "00000000-0000-4000-8000-000000000004",
        reviewer: "00000000-0000-4000-8000-000000000005",
      },
      kickoff: "00000000-0000-4000-8000-000000000006",
    },
    deadline_at: "2026-10-19T04:00:00.000Z",
    monitor: null,
    cancel_requested: false,
    outcome: "starting",
    candidate: null,
    checks: [],
    effects: [],
    pending_close: null,
    created_at: "2026-10-19T02:00:00.000Z",
    updated_at: "2026-10-19T02:01:00.000Z",
    finished_at: null,
    reason: null,
  };
}

describe("Prometheus state filesystem races", () => {
  it("treats a file removed between lstat and no-follow open as absent", async () => {
    const { root } = await fixture();
    const path = join(root, "owner-only.json");
    await writeFile(path, "{}\n", { mode: 0o600 });
    races.disappearBeforeOpen = path;

    await expect(readOwnerOnlyFile(path)).resolves.toBeNull();
    expect(races.openedAfterRemoval).toBe(true);
  });

  it("finishes a run when another cleanup wins the active-file unlink", async () => {
    const { paths } = await fixture();
    const initial = run(paths);
    const probe = fakeProbe();
    await reserveActiveRun(paths, initial, probe);
    const lease = await claimMonitor(paths, initial.run_id, probe);
    const current = (await readRun(paths, initial.run_id))!;
    const finishedAt = new Date(Date.parse(current.updated_at) + 1_000).toISOString();
    const finalState: PrometheusRunState = {
      ...current,
      outcome: "failed",
      updated_at: finishedAt,
      finished_at: finishedAt,
      reason: "Synthetic terminal result for a deletion-race regression.",
    };
    races.disappearBeforeUnlink = paths.activeFile;

    await expect(finishRun(paths, finalState, lease)).resolves.toBeUndefined();
    expect(races.unlinkedAfterRemoval).toBe(true);
    expect(await readRun(paths, initial.run_id)).toEqual(finalState);
    await expect(readFile(paths.activeFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
