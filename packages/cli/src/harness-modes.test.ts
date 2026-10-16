// @vitest-environment node

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  HARNESS_MODE_NAMES,
  HARNESS_MODE_REGISTRY,
  getHarnessModeSpec,
  harnessModeSpecHash,
  resolveGoalRunHarnessMode,
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
    "keeps %s discoverable but unavailable until serve-demo is merged",
    (name) => {
      const spec = getHarnessModeSpec(name);
      expect(spec.profile).toMatchObject({ command: "goal serve-demo", kickoff: name.includes("first") ? "first" : "all" });
      expect(spec.availability).toMatchObject({ state: "dependency", pull_request: 48 });
      expect(() => resolveGoalRunHarnessMode(name)).toThrowError(
        expect.objectContaining({ code: "harness_mode_unavailable", message: expect.stringContaining("PR #48") }),
      );
    },
  );

  it("keeps the published catalog tied to every canonical name and spec hash", async () => {
    const catalog = await readFile(new URL("../../../docs/harness-modes.md", import.meta.url), "utf8");
    for (const spec of HARNESS_MODE_REGISTRY) {
      expect(catalog).toContain(`\`${spec.name}\``);
      expect(catalog).toContain(`\`${harnessModeSpecHash(spec)}\``);
    }
    expect(catalog).toContain("PR #48");
    expect(catalog).toContain("unavailable");
  });
});
