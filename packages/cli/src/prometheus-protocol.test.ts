// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  assertPrometheusGoalUnaddressed,
  parsePrometheusCandidate,
  parsePrometheusPolicy,
  parseTerminalReceipts,
} from "./prometheus-protocol.ts";
import type { CompiledState } from "./compiled.ts";

const VALID_POLICY = [
  "# Prometheus",
  "",
  "```markdown",
  "## Rules",
  "not real",
  "```",
  "",
  "## Motto",
  "Ship evidence.",
  "",
  "## Rules",
  "- Keep receipts strict.",
  "",
  "## Preferences",
  "Prefer small patches.",
  "",
  "## Handoff",
  "Name the exact member.",
  "",
  "## Completion",
  "All checks pass.",
  "",
].join("\n");

function expectInvalidArguments(action: () => unknown): void {
  try {
    action();
    throw new Error("expected invalid_arguments");
  } catch (error) {
    expect(error).toMatchObject({ code: "invalid_arguments" });
  }
}

describe("Prometheus policy", () => {
  it("parses the five ordered nonempty policy sections outside fences and hashes exact bytes", () => {
    const policy = parsePrometheusPolicy(VALID_POLICY);

    expect(policy).toEqual({
      raw: VALID_POLICY,
      sha256: "e3a40d32e60d9d280f4664b44b620034925fbed4fa8cb33d18c956b940080c75",
      sections: {
        Motto: "Ship evidence.",
        Rules: "- Keep receipts strict.",
        Preferences: "Prefer small patches.",
        Handoff: "Name the exact member.",
        Completion: "All checks pass.",
      },
    });
  });

  it("accepts bare CR line endings while hashing the untouched bytes", () => {
    const raw = VALID_POLICY.replaceAll("\n", "\r");

    expect(parsePrometheusPolicy(raw)).toEqual({
      raw,
      sha256: "1e5756195ac80f246df30080412a4fc3806c7a24621a99a7186c89110f1d648c",
      sections: {
        Motto: "Ship evidence.",
        Rules: "- Keep receipts strict.",
        Preferences: "Prefer small patches.",
        Handoff: "Name the exact member.",
        Completion: "All checks pass.",
      },
    });
  });

  it.each([
    ["missing", VALID_POLICY.replace(/\n## Completion\nAll checks pass\.\n$/, "\n")],
    ["duplicate", `${VALID_POLICY}\n## Rules\nAgain.\n`],
    [
      "reordered",
      VALID_POLICY.replace(
        "## Motto\nShip evidence.\n\n## Rules\n- Keep receipts strict.",
        "## Rules\n- Keep receipts strict.\n\n## Motto\nShip evidence.",
      ),
    ],
    ["wrong-case", VALID_POLICY.replace("## Rules\n- Keep receipts strict.", "## rules\n- Keep receipts strict.")],
    ["empty", VALID_POLICY.replace("## Preferences\nPrefer small patches.", "## Preferences\n   ")],
    ["oversized", `${VALID_POLICY}${"x".repeat(65_536)}`],
  ])("rejects %s PROMETHEUS.md before side effects", (_case, raw) => {
    expectInvalidArguments(() => parsePrometheusPolicy(raw));
  });
});

describe("Prometheus goals", () => {
  it("rejects goals that address all, a fixed role name, or a remembered member id", () => {
    for (const goal of [
      "@all finish it",
      "Ask @coordinator to plan",
      "@builder implement it",
      "Review this, @reviewer",
      "Continue with @i_AbCdEfGhIj",
      "Continue with @mem_ZyXwVuTsRq",
    ]) {
      expectInvalidArguments(() => assertPrometheusGoalUnaddressed(goal));
    }

    expect(() => assertPrometheusGoalUnaddressed("Build the feature described here.")).not.toThrow();
  });
});

const COORDINATOR = "i_Coord00001";
const BUILDER = "i_Build00001";
const REVIEWER = "i_Review0001";
const SUBMISSION = "art_Submit0001";
const REVIEW_REPORT = "art_Review0001";
const RESULT_HASH = `sha256:${"5".repeat(24)}`;
const VERIFICATION_HASH = `sha256:${"6".repeat(24)}`;
const STATE_DIGEST = `sha256:${"d".repeat(24)}`;
const SUBMISSION_SHA256 = "a".repeat(64);
const REVIEW_SHA256 = "b".repeat(64);
const REQUIREMENT = `verify:${REVIEWER}`;
const ROSTER = {
  coordinator: { memberId: COORDINATOR },
  builder: { memberId: BUILDER },
  reviewer: { memberId: REVIEWER },
} as const;

interface TestRequirement {
  kind: string;
  eligible: string[];
  q: number;
  predicate: null;
  pos: string[];
  neg: string[];
  status: string;
}

interface TestWork {
  state: string;
  requester: string;
  assignee_addressed: string[];
  responsible: string | null;
  accepted_by: string | null;
  result: string | null;
  artifacts: Record<string, string>;
  deliverables: string[];
  requirements: Record<string, TestRequirement>;
  veto: string[];
  guards: unknown[];
  supersedes: string | null;
  resolver: string | null;
}

interface TestEvent {
  type: string;
  actor: string;
  work_id: string | null;
  to: string[];
  payload: Record<string, unknown>;
  refs: Record<string, unknown>;
  clauses: Array<Record<string, unknown>>;
  parents: string[];
  idempotency_key: string | null;
  version: string;
  seq: number;
  hash: string;
}

interface TestCompiledState extends CompiledState {
  projection: { work: Record<string, TestWork>; clock: number };
  events: TestEvent[];
}

function testEvent(
  seq: number,
  type: string,
  actor: string,
  workId: string,
  refs: Record<string, unknown> = {},
  clauses: Array<Record<string, unknown>> = [],
): TestEvent {
  return {
    type,
    actor,
    work_id: workId,
    to: type === "work.request" ? [BUILDER] : [],
    payload: type === "work.request" ? { task: "Produce the submission" } : {},
    refs,
    clauses,
    parents: [],
    idempotency_key: null,
    version: "sha256:protocol-v1-d680a891c4c8063b",
    seq,
    hash: `sha256:${String(seq).repeat(24)}`,
  };
}

function candidateFixture(): TestCompiledState {
  const oldWork: TestWork = {
    state: "CANCELLED",
    requester: COORDINATOR,
    assignee_addressed: [BUILDER],
    responsible: null,
    accepted_by: null,
    result: null,
    artifacts: {},
    deliverables: [],
    requirements: {},
    veto: [],
    guards: [],
    supersedes: null,
    resolver: null,
  };
  const head: TestWork = {
    state: "RESOLVED",
    requester: COORDINATOR,
    assignee_addressed: [BUILDER],
    responsible: null,
    accepted_by: BUILDER,
    result: RESULT_HASH,
    artifacts: { submission: SUBMISSION },
    deliverables: ["submission"],
    requirements: {
      [REQUIREMENT]: {
        kind: "verify",
        eligible: [REVIEWER],
        q: 1,
        predicate: null,
        pos: [REVIEWER],
        neg: [],
        status: "satisfied",
      },
    },
    veto: [],
    guards: [],
    supersedes: "W0",
    resolver: null,
  };
  const events = [
    testEvent(1, "work.request", COORDINATOR, "W0"),
    testEvent(2, "work.cancel", COORDINATOR, "W0"),
    testEvent(3, "work.request", COORDINATOR, "W1", { supersedes: "W0" }, [
      { kind: "deliverables", names: ["submission"] },
      { kind: "verify", id: REQUIREMENT, verifier: REVIEWER },
    ]),
    testEvent(4, "work.accept", BUILDER, "W1"),
    testEvent(5, "work.result", BUILDER, "W1", {
      artifacts: { submission: SUBMISSION },
      artifact_receipts: { [SUBMISSION]: { id: SUBMISSION, sha256: SUBMISSION_SHA256 } },
    }),
    testEvent(6, "verification.pass", REVIEWER, "W1", {
      result_ref: RESULT_HASH,
      requirement: REQUIREMENT,
      evidence: REVIEW_REPORT,
      artifact_receipts: { [REVIEW_REPORT]: { id: REVIEW_REPORT, sha256: REVIEW_SHA256 } },
    }),
    testEvent(7, "work.resolve", COORDINATOR, "W1"),
  ];
  return {
    protocol_version: "sha256:protocol-v1-d680a891c4c8063b",
    sequence: events.length,
    digest: STATE_DIGEST,
    projection: { work: { W0: oldWork, W1: head }, clock: 0 },
    obligations: "No outstanding obligations.",
    events,
  };
}

describe("Prometheus candidate revisions", () => {
  it("derives one revision from a resolved successor head, exact result artifact receipts, and reviewer passes", () => {
    expect(parsePrometheusCandidate(candidateFixture(), ROSTER)).toEqual({
      ok: true,
      candidate: {
        stateDigest: STATE_DIGEST,
        workId: "W1",
        resultRef: RESULT_HASH,
        artifacts: [{ name: "submission", artifactId: SUBMISSION, sha256: SUBMISSION_SHA256 }],
        verifications: [{
          eventHash: VERIFICATION_HASH,
          requirementId: REQUIREMENT,
          evidenceArtifactId: REVIEW_REPORT,
          evidenceSha256: REVIEW_SHA256,
        }],
        revisionSha256: "bcff959b214dbe461e44be212f7e2df82c5f84cd76f38cbc07291563977afa2c",
      },
    });
  });

  it.each([
    ["nonterminal-work", (state: TestCompiledState) => { state.projection.work.W0!.state = "OPEN"; }],
    ["ambiguous-head", (state: TestCompiledState) => {
      state.projection.work.W2 = { ...structuredClone(state.projection.work.W0!), supersedes: null };
    }],
    ["rejected-head", (state: TestCompiledState) => { state.projection.work.W1!.state = "REJECTED"; }],
    ["missing-result-event", (state: TestCompiledState) => { state.events[4]!.hash = `sha256:${"9".repeat(24)}`; }],
    ["missing-artifact-receipt", (state: TestCompiledState) => {
      state.events[4]!.refs.artifact_receipts = {};
    }],
    ["bad-artifact-sha256", (state: TestCompiledState) => {
      state.events[4]!.refs.artifact_receipts = { [SUBMISSION]: { id: SUBMISSION, sha256: "A".repeat(64) } };
    }],
    ["stale-result-ref", (state: TestCompiledState) => {
      state.events[5]!.refs.result_ref = `sha256:${"0".repeat(24)}`;
    }],
    ["wrong-reviewer", (state: TestCompiledState) => { state.events[5]!.actor = BUILDER; }],
    ["missing-review-evidence", (state: TestCompiledState) => {
      delete state.events[5]!.refs.evidence;
      delete state.events[5]!.refs.artifact_receipts;
    }],
    ["unsatisfied-requirement", (state: TestCompiledState) => {
      state.projection.work.W1!.requirements[REQUIREMENT]!.status = "open";
    }],
  ])("keeps the candidate closed for %s", (reason, mutate) => {
    const state = candidateFixture();
    mutate(state);

    const parsed = parsePrometheusCandidate(state, ROSTER);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reasons).toContain(reason);
  });

  it("sorts work artifacts and verification evidence before hashing the revision", () => {
    const first = candidateFixture();
    const head = first.projection.work.W1!;
    const result = first.events[4]!;
    const report = "art_Report0001";
    const reportSha256 = "c".repeat(64);
    const secondRequirement = "verify:secondary";
    const secondEvidence = "art_Proof00001";
    const secondEvidenceSha256 = "e".repeat(64);
    head.deliverables = ["report", "submission"];
    head.artifacts = { report, submission: SUBMISSION };
    result.refs.artifacts = { report, submission: SUBMISSION };
    result.refs.artifact_receipts = {
      [report]: { id: report, sha256: reportSha256 },
      [SUBMISSION]: { id: SUBMISSION, sha256: SUBMISSION_SHA256 },
    };
    head.requirements = {
      [secondRequirement]: {
        kind: "verify", eligible: [REVIEWER], q: 1, predicate: null,
        pos: [REVIEWER], neg: [], status: "satisfied",
      },
      [REQUIREMENT]: head.requirements[REQUIREMENT]!,
    };
    const resolve = first.events.pop()!;
    first.events.push(
      testEvent(7, "verification.pass", REVIEWER, "W1", {
        result_ref: RESULT_HASH,
        requirement: secondRequirement,
        evidence: secondEvidence,
        artifact_receipts: { [secondEvidence]: { id: secondEvidence, sha256: secondEvidenceSha256 } },
      }),
      { ...resolve, seq: 8, hash: `sha256:${"8".repeat(24)}` },
    );
    first.sequence = first.events.length;

    const second = structuredClone(first);
    const secondHead = second.projection.work.W1!;
    secondHead.artifacts = { submission: SUBMISSION, report };
    secondHead.requirements = {
      [REQUIREMENT]: secondHead.requirements[REQUIREMENT]!,
      [secondRequirement]: secondHead.requirements[secondRequirement]!,
    };
    second.events[4]!.refs.artifacts = { submission: SUBMISSION, report };
    second.events[4]!.refs.artifact_receipts = {
      [SUBMISSION]: { id: SUBMISSION, sha256: SUBMISSION_SHA256 },
      [report]: { id: report, sha256: reportSha256 },
    };

    const one = parsePrometheusCandidate(first, ROSTER);
    const two = parsePrometheusCandidate(second, ROSTER);

    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(one.candidate.artifacts.map((artifact) => artifact.name)).toEqual(["report", "submission"]);
      expect(one.candidate.verifications.map((verification) => verification.eventHash)).toEqual([
        VERIFICATION_HASH,
        `sha256:${"7".repeat(24)}`,
      ]);
      expect(two.candidate.revisionSha256).toBe(one.candidate.revisionSha256);
    }
  });

  it("fails closed on malformed compiled objects, arrays, ids, hashes, and receipts", () => {
    const badProjection = { ...candidateFixture(), projection: [] } as unknown as CompiledState;
    const badEvents = { ...candidateFixture(), events: {} } as unknown as CompiledState;
    const badVersion = candidateFixture();
    badVersion.protocol_version = "sha256:protocol-v2-0000000000000000";
    const badMember = candidateFixture();
    badMember.projection.work.W1!.requester = "coordinator";
    const badHash = candidateFixture();
    badHash.events[0]!.hash = "sha256:not-a-hash";
    const badArtifact = candidateFixture();
    badArtifact.projection.work.W1!.artifacts.submission = "submission.zip";
    const duplicateVerification = candidateFixture();
    const resolve = duplicateVerification.events.pop()!;
    duplicateVerification.events.push(
      testEvent(7, "verification.pass", REVIEWER, "W1", structuredClone(duplicateVerification.events[5]!.refs)),
      { ...resolve, seq: 8, hash: `sha256:${"8".repeat(24)}` },
    );
    duplicateVerification.sequence = duplicateVerification.events.length;

    for (const state of [badProjection, badEvents, badVersion, badMember, badHash, badArtifact, duplicateVerification]) {
      const result = parsePrometheusCandidate(state, ROSTER);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reasons).toContain("invalid-compiled-state");
    }
  });

  it.each([
    ["requester", (state: TestCompiledState) => { state.projection.work.W1!.requester = REVIEWER; }],
    ["assignee", (state: TestCompiledState) => { state.projection.work.W1!.assignee_addressed = [REVIEWER]; }],
    ["acceptor", (state: TestCompiledState) => { state.projection.work.W1!.accepted_by = REVIEWER; }],
    ["result actor", (state: TestCompiledState) => { state.events[4]!.actor = COORDINATOR; }],
  ])("binds the head's %s to the exact coordinator or builder roster member", (_field, mutate) => {
    const state = candidateFixture();
    mutate(state);

    const result = parsePrometheusCandidate(state, ROSTER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("invalid-compiled-state");
  });

  it("requires distinct coordinator, builder, and reviewer members", () => {
    const state = candidateFixture();
    state.projection.work.W1!.requirements[REQUIREMENT]!.eligible = [BUILDER];
    state.projection.work.W1!.requirements[REQUIREMENT]!.pos = [BUILDER];
    state.events[5]!.actor = BUILDER;
    const duplicateRoster = {
      ...ROSTER,
      reviewer: { memberId: BUILDER },
    } as const;

    const result = parsePrometheusCandidate(state, duplicateRoster);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("invalid-compiled-state");
  });

  it("rejects review evidence that reuses any result artifact", () => {
    const state = candidateFixture();
    state.events[5]!.refs.evidence = SUBMISSION;
    state.events[5]!.refs.artifact_receipts = {
      [SUBMISSION]: { id: SUBMISSION, sha256: SUBMISSION_SHA256 },
    };

    const result = parsePrometheusCandidate(state, ROSTER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("missing-review-evidence");
  });

  it("rejects a requirement when the same member appears in both positive and negative evidence", () => {
    const state = candidateFixture();
    state.projection.work.W1!.requirements[REQUIREMENT]!.neg = [REVIEWER];

    const result = parsePrometheusCandidate(state, ROSTER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("invalid-compiled-state");
  });

  it.each([
    ["extra positive", [REVIEWER, BUILDER], []],
    ["ineligible negative", [REVIEWER], [BUILDER]],
  ])("rejects %s votes on a reviewer-only verify requirement", (_case, pos, neg) => {
    const state = candidateFixture();
    state.projection.work.W1!.requirements[REQUIREMENT]!.pos = pos;
    state.projection.work.W1!.requirements[REQUIREMENT]!.neg = neg;

    const result = parsePrometheusCandidate(state, ROSTER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("wrong-reviewer");
  });

  it("rejects result artifacts that were not declared as deliverables", () => {
    const state = candidateFixture();
    const report = "art_Report0001";
    const reportSha256 = "c".repeat(64);
    state.projection.work.W1!.artifacts.report = report;
    state.events[4]!.refs.artifacts = { submission: SUBMISSION, report };
    state.events[4]!.refs.artifact_receipts = {
      [SUBMISSION]: { id: SUBMISSION, sha256: SUBMISSION_SHA256 },
      [report]: { id: report, sha256: reportSha256 },
    };

    const result = parsePrometheusCandidate(state, ROSTER);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reasons).toContain("invalid-compiled-state");
  });
});

const RUN_ID = "run_20261018_abcdef";
const REVISION_SHA256 = "f".repeat(64);

function terminalReceipt(
  role: "coordinator" | "builder" | "reviewer",
  overrides: Partial<{ type: string; run_id: string; role: string; revision_sha256: string; extra: string }> = {},
): string {
  return `[sharednet-prometheus:v1] ${JSON.stringify({
    type: "terminal.receipt",
    run_id: RUN_ID,
    role,
    revision_sha256: REVISION_SHA256,
    ...overrides,
  })}`;
}

describe("Prometheus terminal receipts", () => {
  it("accepts one current receipt from each saved sender", () => {
    const parsed = parseTerminalReceipts([
      { sequence: 2, content: terminalReceipt("coordinator"), sender_instance_id: COORDINATOR },
      { sequence: 3, content: terminalReceipt("builder"), sender: { member_id: BUILDER } },
      { sequence: 4, content: terminalReceipt("reviewer"), sender_instance_id: REVIEWER, sender: { member_id: REVIEWER } },
    ], ROSTER, RUN_ID, REVISION_SHA256);

    expect(parsed).toEqual({
      ok: true,
      receipts: {
        coordinator: { sequence: 2, role: "coordinator", memberId: COORDINATOR, runId: RUN_ID, revisionSha256: REVISION_SHA256 },
        builder: { sequence: 3, role: "builder", memberId: BUILDER, runId: RUN_ID, revisionSha256: REVISION_SHA256 },
        reviewer: { sequence: 4, role: "reviewer", memberId: REVIEWER, runId: RUN_ID, revisionSha256: REVISION_SHA256 },
      },
      missingRoles: [],
    });
  });

  it("rejects raw DONE, ordinary final text, malformed or extra JSON, forged roles, stale values, and unknown members", () => {
    const invalid = [
      { sequence: 1, content: "DONE", sender: { member_id: COORDINATOR } },
      { sequence: 2, content: "The work is complete and all checks pass.", sender: { member_id: COORDINATOR } },
      { sequence: 3, content: "[sharednet-prometheus:v1] {", sender: { member_id: COORDINATOR } },
      { sequence: 4, content: terminalReceipt("coordinator", { extra: "not allowed" }), sender: { member_id: COORDINATOR } },
      {
        sequence: 5,
        content: `[sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"${RUN_ID}","role":"coordinator","revision_sha256":"${REVISION_SHA256}","__proto__":"not allowed"}`,
        sender: { member_id: COORDINATOR },
      },
      {
        sequence: 6,
        content: `[sharednet-prometheus:v1] {"type":"terminal.receipt","run_id":"${RUN_ID}","role":"coordinator","role":"coordinator","revision_sha256":"${REVISION_SHA256}"}`,
        sender: { member_id: COORDINATOR },
      },
      { sequence: 7, content: terminalReceipt("reviewer"), sender: { member_id: BUILDER } },
      { sequence: 8, content: terminalReceipt("coordinator", { run_id: "run_stale" }), sender: { member_id: COORDINATOR } },
      { sequence: 9, content: terminalReceipt("coordinator", { revision_sha256: "0".repeat(64) }), sender: { member_id: COORDINATOR } },
      { sequence: 10, content: terminalReceipt("coordinator"), sender: { member_id: "i_Unknown001" } },
      {
        sequence: 11,
        content: terminalReceipt("coordinator"),
        sender_instance_id: COORDINATOR,
        sender: { member_id: BUILDER },
      },
    ];

    expect(parseTerminalReceipts(invalid, ROSTER, RUN_ID, REVISION_SHA256)).toEqual({
      ok: false,
      receipts: {},
      missingRoles: ["coordinator", "builder", "reviewer"],
    });
  });

  it("keeps the newest valid receipt per role even with duplicate older and newer invalid messages", () => {
    const reorderedCoordinator = `[sharednet-prometheus:v1] {"role":"coordinator","revision_sha256":"${REVISION_SHA256}","type":"terminal.receipt","run_id":"${RUN_ID}"}`;
    const parsed = parseTerminalReceipts([
      { sequence: 12, content: terminalReceipt("builder"), sender: { member_id: BUILDER } },
      { sequence: 4, content: terminalReceipt("coordinator"), sender: { member_id: COORDINATOR } },
      { sequence: 15, content: terminalReceipt("reviewer"), sender: { member_id: REVIEWER } },
      { sequence: 11, content: reorderedCoordinator, sender: { member_id: COORDINATOR } },
      { sequence: 20, content: terminalReceipt("coordinator", { revision_sha256: "0".repeat(64) }), sender: { member_id: COORDINATOR } },
    ], ROSTER, RUN_ID, REVISION_SHA256);

    expect(parsed.ok).toBe(true);
    expect(parsed.receipts.coordinator?.sequence).toBe(11);
  });

  it.each([
    ["extra", { ...ROSTER, observer: { memberId: "i_Observe001" } }],
    ["inherited", Object.assign(Object.create({ coordinator: ROSTER.coordinator }), {
      builder: ROSTER.builder,
      reviewer: ROSTER.reviewer,
    })],
  ])("rejects a roster with %s role keys instead of exact own role keys", (_case, roster) => {
    const parsed = parseTerminalReceipts([
      { sequence: 2, content: terminalReceipt("coordinator"), sender_instance_id: COORDINATOR },
      { sequence: 3, content: terminalReceipt("builder"), sender_instance_id: BUILDER },
      { sequence: 4, content: terminalReceipt("reviewer"), sender_instance_id: REVIEWER },
    ], roster as typeof ROSTER, RUN_ID, REVISION_SHA256);

    expect(parsed).toEqual({
      ok: false,
      receipts: {},
      missingRoles: ["coordinator", "builder", "reviewer"],
    });
  });
});
