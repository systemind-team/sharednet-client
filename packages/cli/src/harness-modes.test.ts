// @vitest-environment node

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  HARNESS_MODE_NAMES,
  HARNESS_MODE_REGISTRY,
  assertGoalRunHarnessAgentCount,
  getHarnessModeSpec,
  harnessModeSpecHash,
  resolveGoalRunHarnessMode,
  resolveRuntimeHarnessMode,
} from "./harness-modes.ts";

const researchProfiles = [
  ["research/baseline@1", false, false, "broadcast"],
  ["research/mentions@1", true, false, "mentions"],
  ["research/tasks@1", false, true, "broadcast"],
  ["research/both@1", true, true, "mentions"],
  ["research/routing-only@1", false, false, "mentions"],
  ["research/receipt-only@1", true, false, "broadcast"],
] as const;

describe("frozen harness mode registry", () => {
  it("enforces an optional frozen agent-count constraint", () => {
    const baseline = resolveGoalRunHarnessMode("research/baseline@1");
    const constrained = { ...baseline, profile: { ...baseline.profile, agents: 1 as const } };
    expect(() => assertGoalRunHarnessAgentCount(constrained, 1)).not.toThrow();
    expect(() => assertGoalRunHarnessAgentCount(constrained, 2)).toThrowError(expect.objectContaining({ code: "harness_agent_count_mismatch" }));
    expect(() => assertGoalRunHarnessAgentCount(baseline, 2)).not.toThrow();
  });

  it("registers the eight canonical immutable names and the exact six goal-run profiles", () => {
    expect(HARNESS_MODE_NAMES).toEqual([
      "research/baseline@1",
      "research/mentions@1",
      "research/tasks@1",
      "research/both@1",
      "research/routing-only@1",
      "research/receipt-only@1",
      "runtime/serve-first@1",
      "runtime/serve-all@1",
    ]);
    expect(HARNESS_MODE_REGISTRY).toHaveLength(8);
    for (const [name, mentionGate, taskGate, messageRouting] of researchProfiles) {
      const resolved = resolveGoalRunHarnessMode(name);
      expect(resolved.profile).toEqual({
        command: "goal run",
        room_type: "board",
        delivery: "runner-owned-turn-loop",
        initial_wake: "all-seats",
        mention_gate: mentionGate,
        task_gate: taskGate,
        message_routing: messageRouting,
      });
      expect(resolved.spec.availability).toEqual({ state: "available", command: "goal run" });
      expect(Object.isFrozen(resolved.spec)).toBe(true);
      expect(Object.isFrozen(resolved.spec.profile)).toBe(true);
    }
  });

  it("hashes the canonical spec deterministically and distinctly", () => {
    const hashes = HARNESS_MODE_REGISTRY.map((spec) => harnessModeSpecHash(spec));
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
    expect(new Set(hashes).size).toBe(HARNESS_MODE_REGISTRY.length);
    expect(harnessModeSpecHash(getHarnessModeSpec("research/both@1"))).toBe(hashes[3]);
  });

  it("does not change any published research-mode hash", () => {
    expect(Object.fromEntries(researchProfiles.map(([name]) => [name, harnessModeSpecHash(getHarnessModeSpec(name))]))).toEqual({
      "research/baseline@1": "3bced23adad81117a2eb039fe5a284eeab49ad7711e1a2efc4506db553a95514",
      "research/mentions@1": "3885aaf5b0615bd9facfa86a3043313ba8598a98f3440626890b05897e2bf793",
      "research/tasks@1": "0b44d68ad0e8131da4b557a3cce5b633c93b2fdb5ecfcf275ad1751d80e7b156",
      "research/both@1": "c4be25291d7aca3a1193119f12bfd70ca0d2723b5cd3bf08d281a1afb6bf6f28",
      "research/routing-only@1": "bd1f751ca8ec726a8632bb99b0148b5e81693af50a623c89230320e92f836f88",
      "research/receipt-only@1": "902d907b2f390a03b17593184836bf644fcdf5dae8f8e412d973f8010717d052",
    });
  });

  it("keeps mutable availability and re-verification metadata outside the immutable spec hash", () => {
    const spec = getHarnessModeSpec("runtime/serve-first@1");
    const changed = {
      ...spec,
      availability: { state: "available", command: "goal serve-demo" },
      provenance: { ...spec.provenance, verified_against: "a".repeat(40) },
    } as unknown as typeof spec;
    expect(harnessModeSpecHash(changed)).toBe(harnessModeSpecHash(spec));
  });

  it.each(["baseline", "research/baseline", "research/baseline@2", "research/unknown@1", "Research/baseline@1"]) (
    "refuses non-canonical mode %s",
    (name) => {
      expect(() => getHarnessModeSpec(name)).toThrowError(expect.objectContaining({ code: "invalid_harness_mode" }));
    },
  );

  it.each(["runtime/serve-first@1", "runtime/serve-all@1"] as const)(
    "makes %s selectable through goal run with the frozen kickoff",
    (name) => {
      const resolved = resolveRuntimeHarnessMode(name);
      expect(resolved.profile).toMatchObject({ command: "goal serve-demo", kickoff: name.includes("first") ? "first" : "all" });
      expect(resolved.spec.availability).toEqual({ state: "available", command: "goal run" });
      expect(resolved.specSha256).toBe(harnessModeSpecHash(resolved.spec));
      expect(() => resolveGoalRunHarnessMode(name)).toThrowError(expect.objectContaining({ code: "harness_mode_family_mismatch" }));
    },
  );

  it("keeps the published catalog tied to every canonical name and spec hash", async () => {
    const catalog = await readFile(new URL("../../../docs/harness-modes.md", import.meta.url), "utf8");
    for (const spec of HARNESS_MODE_REGISTRY) {
      expect(catalog).toContain(`\`${spec.name}\``);
      expect(catalog).toContain(`\`${harnessModeSpecHash(spec)}\``);
    }
    expect(catalog).toContain("goal run");
  });
});
