import { createHash } from "node:crypto";

import { localError } from "./errors.ts";

export type ResearchHarnessModeName =
  | "research/baseline@1"
  | "research/mentions@1"
  | "research/tasks@1"
  | "research/both@1"
  | "research/routing-only@1"
  | "research/receipt-only@1";
export type RuntimeHarnessModeName = "runtime/serve-first@1" | "runtime/serve-all@1";
export type HarnessModeName = ResearchHarnessModeName | RuntimeHarnessModeName;

export interface ResearchHarnessProfile {
  readonly command: "goal run";
  readonly room_type: "board";
  readonly delivery: "runner-owned-turn-loop";
  readonly initial_wake: "all-seats";
  readonly mention_gate: boolean;
  readonly task_gate: boolean;
  readonly message_routing: "broadcast" | "mentions";
}

export interface RuntimeHarnessProfile {
  readonly command: "goal serve-demo";
  readonly room_type: "board";
  readonly delivery: "production-sharednet-serve";
  readonly kickoff: "first" | "all";
  readonly agents: 3;
  readonly driver: "codex";
  readonly later_wake: "direct-mentions";
}

interface AvailableHarnessMode {
  readonly state: "available";
  readonly command: "goal run";
}

interface DependencyHarnessMode {
  readonly state: "dependency";
  readonly command: "goal serve-demo";
  readonly pull_request: 48;
  readonly url: "https://github.com/systemind-team/sharednet-client/pull/48";
  readonly reviewed_head: "e77597df9e2fae3d83c8c518c1c815eb7a3ede5d";
}

interface HarnessModeProvenance {
  readonly repository: "systemind-team/sharednet-client";
  readonly mechanism_commit: string;
  readonly verified_against: string;
  readonly source: readonly string[];
}

export interface ResearchHarnessModeSpec {
  readonly name: ResearchHarnessModeName;
  readonly family: "research";
  readonly version: 1;
  readonly delivery: string;
  readonly wake: string;
  readonly stop: string;
  readonly profile: ResearchHarnessProfile;
  readonly availability: AvailableHarnessMode;
  readonly provenance: HarnessModeProvenance;
}

export interface RuntimeHarnessModeSpec {
  readonly name: RuntimeHarnessModeName;
  readonly family: "runtime";
  readonly version: 1;
  readonly delivery: string;
  readonly wake: string;
  readonly stop: string;
  readonly profile: RuntimeHarnessProfile;
  readonly availability: DependencyHarnessMode;
  readonly provenance: HarnessModeProvenance;
}

export type HarnessModeSpec = ResearchHarnessModeSpec | RuntimeHarnessModeSpec;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const researchProvenance = {
  repository: "systemind-team/sharednet-client",
  // The receipt gate, routing control and task gate first coexist at d7383cf.
  mechanism_commit: "d7383cfb742abe7d1fdf253c4ec9504329443c1e",
  verified_against: "6c56615e4fe389ce43f9addc1cdc79a1f8ba39a8",
  source: ["packages/cli/src/goal-run.ts", "packages/cli/src/board-controls.ts", "packages/cli/src/task-guard.ts"],
} as const;

const runtimeProvenance = {
  repository: "systemind-team/sharednet-client",
  mechanism_commit: "e77597df9e2fae3d83c8c518c1c815eb7a3ede5d",
  verified_against: "e77597df9e2fae3d83c8c518c1c815eb7a3ede5d",
  source: ["packages/cli/src/goal-serve-demo.ts"],
} as const;

const available = { state: "available", command: "goal run" } as const;
const dependency = {
  state: "dependency",
  command: "goal serve-demo",
  pull_request: 48,
  url: "https://github.com/systemind-team/sharednet-client/pull/48",
  reviewed_head: "e77597df9e2fae3d83c8c518c1c815eb7a3ede5d",
} as const;

function research(
  name: ResearchHarnessModeName,
  controls: Pick<ResearchHarnessProfile, "mention_gate" | "task_gate" | "message_routing">,
): ResearchHarnessModeSpec {
  const targeted = controls.message_routing === "mentions";
  return {
    name,
    family: "research",
    version: 1,
    delivery: controls.mention_gate
      ? "Before each post, the sender reads newer direct mentions and must retry after reviewing any it finds."
      : "Posts use the ordinary SharedNet board path without a before-post receipt gate.",
    wake: targeted
      ? "Known direct mentions wake only their named seats; no mention, @all, and unknown-only mentions broadcast."
      : "Every ordinary board message wakes every seat; task control events are suppressed only when the task gate is enabled.",
    stop: "The runner stops at the first configured --until condition; a said claim runs the configured check before closure.",
    profile: {
      command: "goal run",
      room_type: "board",
      delivery: "runner-owned-turn-loop",
      initial_wake: "all-seats",
      ...controls,
    },
    availability: available,
    provenance: researchProvenance,
  };
}

function runtime(name: RuntimeHarnessModeName, kickoff: "first" | "all"): RuntimeHarnessModeSpec {
  return {
    name,
    family: "runtime",
    version: 1,
    delivery: "Each seat owns a production sharednet serve listener and persistent Codex thread; the runner provisions, observes, checks and exports.",
    wake: kickoff === "first"
      ? "After all listeners are healthy, the runner directly mentions only the coordinator; every later turn requires a direct Room mention."
      : "After all listeners are healthy, the runner directly mentions all three seats once; every later turn requires a direct Room mention.",
    stop: "The observer stops on configured said/check/idle/after/at/message/mention conditions; count and live token budgets are unavailable.",
    profile: {
      command: "goal serve-demo",
      room_type: "board",
      delivery: "production-sharednet-serve",
      kickoff,
      agents: 3,
      driver: "codex",
      later_wake: "direct-mentions",
    },
    availability: dependency,
    provenance: runtimeProvenance,
  };
}

export const HARNESS_MODE_REGISTRY: readonly HarnessModeSpec[] = deepFreeze([
  research("research/baseline@1", { mention_gate: false, task_gate: false, message_routing: "broadcast" }),
  research("research/mentions@1", { mention_gate: true, task_gate: false, message_routing: "mentions" }),
  research("research/tasks@1", { mention_gate: false, task_gate: true, message_routing: "broadcast" }),
  research("research/both@1", { mention_gate: true, task_gate: true, message_routing: "mentions" }),
  research("research/routing-only@1", { mention_gate: false, task_gate: false, message_routing: "mentions" }),
  research("research/receipt-only@1", { mention_gate: true, task_gate: false, message_routing: "broadcast" }),
  runtime("runtime/serve-first@1", "first"),
  runtime("runtime/serve-all@1", "all"),
]);

export const HARNESS_MODE_NAMES: readonly HarnessModeName[] = deepFreeze(HARNESS_MODE_REGISTRY.map((spec) => spec.name));

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function harnessModeSpecHash(spec: HarnessModeSpec): string {
  const { availability: _availability, provenance, ...semantics } = spec;
  const { verified_against: _verifiedAgainst, ...mechanismProvenance } = provenance;
  return createHash("sha256").update(canonicalJson({ ...semantics, provenance: mechanismProvenance })).digest("hex");
}

export function getHarnessModeSpec(name: string): HarnessModeSpec {
  const spec = HARNESS_MODE_REGISTRY.find((candidate) => candidate.name === name);
  if (!spec) {
    throw localError(
      "invalid_harness_mode",
      `--harness-mode must be a canonical versioned name: ${HARNESS_MODE_NAMES.join(", ")}.`,
    );
  }
  return spec;
}

export interface GoalRunHarnessResolution {
  readonly name: ResearchHarnessModeName;
  readonly spec: ResearchHarnessModeSpec;
  readonly specSha256: string;
  readonly profile: ResearchHarnessProfile;
}

export function resolveGoalRunHarnessMode(name: string): GoalRunHarnessResolution {
  const spec = getHarnessModeSpec(name);
  if (spec.family === "runtime") {
    throw localError(
      "harness_mode_unavailable",
      `${spec.name} is registered but unavailable in this build: it depends on unmerged PR #48 and the goal serve-demo command.`,
    );
  }
  return { name: spec.name, spec, specSha256: harnessModeSpecHash(spec), profile: spec.profile };
}
