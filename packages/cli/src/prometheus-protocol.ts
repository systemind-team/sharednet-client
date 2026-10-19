import { createHash } from "node:crypto";

import type { CompiledState } from "./compiled.ts";
import { localError } from "./errors.ts";

export const PROMETHEUS_ROLES = ["coordinator", "builder", "reviewer"] as const;
export type PrometheusRole = (typeof PROMETHEUS_ROLES)[number];

const POLICY_SECTIONS = ["Motto", "Rules", "Preferences", "Handoff", "Completion"] as const;
type PrometheusPolicySection = (typeof POLICY_SECTIONS)[number];

export interface PrometheusPolicy {
  raw: string;
  sha256: string;
  sections: Record<PrometheusPolicySection, string>;
}

const MAX_POLICY_BYTES = 64 * 1024;

interface MarkdownHeading {
  line: number;
  title: string;
}

function markdownLevelTwoHeadings(lines: readonly string[]): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const [line, value] of lines.entries()) {
    if (fence) {
      const close = new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}[ \\t]*$`);
      if (close.test(value)) fence = null;
      continue;
    }

    const opened = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    if (opened) {
      const run = opened[1]!;
      fence = { marker: run[0] as "`" | "~", length: run.length };
      continue;
    }

    const heading = /^ {0,3}##(?!#)[ \t]+(.+?)[ \t]*$/.exec(value);
    if (heading) headings.push({ line, title: heading[1]! });
  }

  return headings;
}

export function parsePrometheusPolicy(raw: string): PrometheusPolicy {
  if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES) {
    throw localError("invalid_arguments", "PROMETHEUS.md must be no larger than 64 KiB.");
  }

  const lines = raw.split(/\r\n|\n|\r/);
  const headings = markdownLevelTwoHeadings(lines);
  const required = headings.filter((heading) =>
    POLICY_SECTIONS.some((name) => name.toLowerCase() === heading.title.toLowerCase()),
  );

  if (
    required.length !== POLICY_SECTIONS.length ||
    required.some((heading, index) => heading.title !== POLICY_SECTIONS[index])
  ) {
    throw localError(
      "invalid_arguments",
      "PROMETHEUS.md needs exactly one ## Motto, ## Rules, ## Preferences, ## Handoff, and ## Completion section, in that order and case.",
    );
  }

  const sections = Object.create(null) as Record<PrometheusPolicySection, string>;
  for (const heading of required) {
    const next = headings.find((candidate) => candidate.line > heading.line)?.line ?? lines.length;
    const content = lines.slice(heading.line + 1, next).join("\n").trim();
    if (!content) {
      throw localError("invalid_arguments", `PROMETHEUS.md section ## ${heading.title} must not be empty.`);
    }
    sections[heading.title as PrometheusPolicySection] = content;
  }

  return {
    raw,
    sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    sections,
  };
}

export function assertPrometheusGoalUnaddressed(raw: string): void {
  const fixedRole = /@(all|coordinator|builder|reviewer)(?![\p{L}\p{N}_-])/iu;
  const rememberedMember = /@(?:i|mem)_[0-9A-Za-z]{10}(?![\p{L}\p{N}_-])/u;
  if (fixedRole.test(raw) || rememberedMember.test(raw)) {
    throw localError(
      "invalid_arguments",
      "GOAL.md must be unaddressed; Prometheus sends one kickoff to the run's exact coordinator member id.",
    );
  }
}

export interface CandidateArtifact {
  name: string;
  artifactId: string;
  sha256: string;
}

export interface CandidateVerification {
  eventHash: string;
  requirementId: string;
  evidenceArtifactId: string;
  evidenceSha256: string;
}

export interface PrometheusCandidate {
  stateDigest: string;
  workId: string;
  resultRef: string;
  artifacts: CandidateArtifact[];
  verifications: CandidateVerification[];
  revisionSha256: string;
}

export type CandidateResult =
  | { ok: true; candidate: PrometheusCandidate }
  | { ok: false; reasons: string[] };

const MEMBER_ID = /^(?:i|mem)_[0-9A-Za-z]{10}$/;
const ARTIFACT_ID = /^art_[0-9A-Za-z]{10}$/;
const WORK_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
const REQUIREMENT_ID = /^[A-Za-z0-9_.:#-]{1,256}$/;
const EVENT_HASH = /^sha256:[0-9a-f]{24}$/;
const ARTIFACT_SHA256 = /^[0-9a-f]{64}$/;
const COMPILED_PROTOCOL_VERSION = "sha256:protocol-v1-d680a891c4c8063b";
const WORK_STATES = new Set(["OPEN", "COMMITTED", "REVIEW", "DECLINED", "REJECTED", "CANCELLED", "EXPIRED", "RESOLVED"]);
const TERMINAL_WORK_STATES = new Set(["DECLINED", "REJECTED", "CANCELLED", "EXPIRED", "RESOLVED"]);
const EVENT_TYPES = new Set([
  "message",
  "work.request",
  "work.accept",
  "work.decline",
  "work.result",
  "work.cancel",
  "work.resolve",
  "verification.pass",
  "verification.fail",
  "human.approve",
  "human.reject",
  "clock.tick",
]);

interface WireReceipt {
  id: string;
  sha256: string;
}

interface WireRequirement {
  kind: "verify" | "human_review" | "quorum";
  eligible: string[];
  q: number;
  predicate: unknown;
  pos: string[];
  neg: string[];
  status: "open" | "satisfied" | "failed";
}

interface WireWork {
  state: string;
  requester: string;
  assignee_addressed: string[];
  responsible: string | null;
  accepted_by: string | null;
  result: string | null;
  artifacts: Record<string, string>;
  deliverables: string[];
  requirements: Record<string, WireRequirement>;
  veto: string[];
  guards: unknown[];
  supersedes: string | null;
  resolver: string | null;
}

interface WireEvent {
  type: string;
  actor: string;
  work_id: string | null;
  refs: Record<string, unknown>;
  seq: number;
  hash: string;
}

interface WireState {
  digest: string;
  work: Record<string, WireWork>;
  events: WireEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown, pattern?: RegExp): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && (pattern?.test(item) ?? true));
}

function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function areDisjoint(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right);
  return left.every((value) => !rightValues.has(value));
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function validNamedArtifacts(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.entries(value).every(([name, id]) =>
    name.length > 0 && name.length <= 256 && typeof id === "string" && ARTIFACT_ID.test(id));
}

function validReceipts(value: unknown): value is Record<string, WireReceipt> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, receipt]) =>
    ARTIFACT_ID.test(key) && isRecord(receipt) && hasExactKeys(receipt, ["id", "sha256"]) &&
    receipt.id === key && typeof receipt.sha256 === "string");
}

function validRequirement(value: unknown): value is WireRequirement {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "eligible", "q", "predicate", "pos", "neg", "status"])) return false;
  return (value.kind === "verify" || value.kind === "human_review" || value.kind === "quorum") &&
    isStringArray(value.eligible, MEMBER_ID) && isUnique(value.eligible) &&
    Number.isSafeInteger(value.q) && Number(value.q) >= 1 &&
    (value.predicate === null || isJsonValue(value.predicate)) &&
    isStringArray(value.pos, MEMBER_ID) && isUnique(value.pos) &&
    isStringArray(value.neg, MEMBER_ID) && isUnique(value.neg) &&
    areDisjoint(value.pos, value.neg) &&
    (value.status === "open" || value.status === "satisfied" || value.status === "failed");
}

function validWork(value: unknown): value is WireWork {
  if (!isRecord(value) || !hasExactKeys(value, [
    "state", "requester", "assignee_addressed", "responsible", "accepted_by", "result",
    "artifacts", "deliverables", "requirements", "veto", "guards", "supersedes", "resolver",
  ])) return false;
  if (typeof value.state !== "string" || !WORK_STATES.has(value.state) ||
      typeof value.requester !== "string" || !MEMBER_ID.test(value.requester) ||
      !isStringArray(value.assignee_addressed, MEMBER_ID) || !isUnique(value.assignee_addressed) ||
      !(value.responsible === null || (typeof value.responsible === "string" && MEMBER_ID.test(value.responsible))) ||
      !(value.accepted_by === null || (typeof value.accepted_by === "string" && MEMBER_ID.test(value.accepted_by))) ||
      !(value.result === null || (typeof value.result === "string" && EVENT_HASH.test(value.result))) ||
      !validNamedArtifacts(value.artifacts) ||
      !isStringArray(value.deliverables) || !isUnique(value.deliverables) ||
      value.deliverables.some((name) => name.length === 0 || name.length > 256) ||
      !isRecord(value.requirements) || !Object.entries(value.requirements).every(([id, requirement]) =>
        REQUIREMENT_ID.test(id) && validRequirement(requirement)) ||
      !isStringArray(value.veto, MEMBER_ID) || !isUnique(value.veto) ||
      !Array.isArray(value.guards) || !value.guards.every((guard) => isRecord(guard) && isJsonValue(guard)) ||
      !(value.supersedes === null || (typeof value.supersedes === "string" && WORK_ID.test(value.supersedes))) ||
      !(value.resolver === null || (typeof value.resolver === "string" && MEMBER_ID.test(value.resolver)))) return false;
  return true;
}

function validEventRefs(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactKeys(value, [], [
    "supersedes", "result_ref", "requirement", "evidence", "artifacts", "artifact_receipts",
  ])) return false;
  if (value.supersedes !== undefined && value.supersedes !== null &&
      (typeof value.supersedes !== "string" || !WORK_ID.test(value.supersedes))) return false;
  if (value.result_ref !== undefined && value.result_ref !== null &&
      (typeof value.result_ref !== "string" || !EVENT_HASH.test(value.result_ref))) return false;
  if (value.requirement !== undefined &&
      (typeof value.requirement !== "string" || !REQUIREMENT_ID.test(value.requirement))) return false;
  if (value.evidence !== undefined &&
      (typeof value.evidence !== "string" || !ARTIFACT_ID.test(value.evidence))) return false;
  if (value.artifacts !== undefined && !validNamedArtifacts(value.artifacts)) return false;
  if (value.artifact_receipts !== undefined && !validReceipts(value.artifact_receipts)) return false;
  return true;
}

function validClause(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string" || !value.kind || !isJsonValue(value)) return false;
  if (value.verifier !== undefined && (typeof value.verifier !== "string" || !MEMBER_ID.test(value.verifier))) return false;
  if (value.names !== undefined && (!isStringArray(value.names) || !isUnique(value.names) ||
      value.names.some((name) => name.length === 0 || name.length > 256))) return false;
  return true;
}

function parseWireEvent(value: unknown, index: number): WireEvent | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "type", "actor", "work_id", "to", "payload", "refs", "clauses", "parents",
    "idempotency_key", "seq", "hash",
  ], ["version"])) return null;
  if (typeof value.type !== "string" || !EVENT_TYPES.has(value.type) ||
      typeof value.actor !== "string" || !(MEMBER_ID.test(value.actor) || (value.type === "clock.tick" && value.actor === "room_service")) ||
      !(value.work_id === null || (typeof value.work_id === "string" && WORK_ID.test(value.work_id))) ||
      !isStringArray(value.to, MEMBER_ID) || !isUnique(value.to) ||
      !isRecord(value.payload) || !isJsonValue(value.payload) || !validEventRefs(value.refs) ||
      !Array.isArray(value.clauses) || !value.clauses.every(validClause) ||
      !isStringArray(value.parents, EVENT_HASH) || !isUnique(value.parents) ||
      !(value.idempotency_key === null || (typeof value.idempotency_key === "string" && value.idempotency_key.length > 0)) ||
      !(value.version === undefined || value.version === COMPILED_PROTOCOL_VERSION) ||
      value.seq !== index + 1 || typeof value.hash !== "string" || !EVENT_HASH.test(value.hash)) return null;
  return value as unknown as WireEvent;
}

function parseWireState(state: CompiledState): WireState | null {
  const value: unknown = state;
  if (!isRecord(value) || !hasExactKeys(value, [
    "protocol_version", "sequence", "digest", "projection", "obligations", "events",
  ]) || value.protocol_version !== COMPILED_PROTOCOL_VERSION ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0 ||
      typeof value.digest !== "string" || !EVENT_HASH.test(value.digest) ||
      typeof value.obligations !== "string" || !Array.isArray(value.events) ||
      value.events.length !== value.sequence || !isRecord(value.projection) ||
      !hasExactKeys(value.projection, ["work", "clock"]) || !isRecord(value.projection.work) ||
      !Number.isFinite(value.projection.clock)) return null;

  const work: Record<string, WireWork> = Object.create(null);
  for (const [id, item] of Object.entries(value.projection.work)) {
    if (!WORK_ID.test(id) || !validWork(item)) return null;
    work[id] = item;
  }
  for (const [id, item] of Object.entries(work)) {
    if (item.supersedes !== null && (!Object.hasOwn(work, item.supersedes) || item.supersedes === id)) {
      return null;
    }
  }

  const events: WireEvent[] = [];
  const hashes = new Set<string>();
  for (const [index, item] of value.events.entries()) {
    const event = parseWireEvent(item, index);
    if (!event || hashes.has(event.hash)) return null;
    hashes.add(event.hash);
    events.push(event);
  }
  return { digest: value.digest, work, events };
}

const CANDIDATE_REASON_ORDER = [
  "invalid-compiled-state",
  "nonterminal-work",
  "ambiguous-head",
  "rejected-head",
  "missing-result-event",
  "missing-artifact-receipt",
  "bad-artifact-sha256",
  "stale-result-ref",
  "wrong-reviewer",
  "missing-review-evidence",
  "unsatisfied-requirement",
] as const;

function refused(reasons: ReadonlySet<string>): CandidateResult {
  return { ok: false, reasons: CANDIDATE_REASON_ORDER.filter((reason) => reasons.has(reason)) };
}

function compareTuple(left: readonly string[], right: readonly string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index] === right[index]) continue;
    return left[index]! < right[index]! ? -1 : 1;
  }
  return left.length - right.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && left[key] === right[key]);
}

function wouldCycle(work: Record<string, WireWork>): boolean {
  for (const id of Object.keys(work)) {
    const seen = new Set<string>([id]);
    let next = work[id]!.supersedes;
    while (next !== null) {
      if (seen.has(next)) return true;
      seen.add(next);
      next = work[next]!.supersedes;
    }
  }
  return false;
}

function parseRosterMembers(roster: PrometheusRoster): Record<PrometheusRole, string> | null {
  const value: unknown = roster;
  if (!isRecord(value) || !hasExactKeys(value, PROMETHEUS_ROLES)) return null;

  const members = Object.create(null) as Record<PrometheusRole, string>;
  const seen = new Set<string>();
  for (const role of PROMETHEUS_ROLES) {
    const seat = value[role];
    if (!isRecord(seat) || !Object.hasOwn(seat, "memberId") ||
        typeof seat.memberId !== "string" || !MEMBER_ID.test(seat.memberId) || seen.has(seat.memberId)) return null;
    members[role] = seat.memberId;
    seen.add(seat.memberId);
  }
  return members;
}

export function parsePrometheusCandidate(state: CompiledState, roster: PrometheusRoster): CandidateResult {
  const wire = parseWireState(state);
  const members = parseRosterMembers(roster);
  if (!wire || !members || wouldCycle(wire.work)) {
    return { ok: false, reasons: ["invalid-compiled-state"] };
  }
  const reviewerMemberId = members.reviewer;

  const reasons = new Set<string>();
  const entries = Object.entries(wire.work);
  if (entries.some(([, work]) => !TERMINAL_WORK_STATES.has(work.state))) reasons.add("nonterminal-work");

  const superseded = new Set(entries.flatMap(([, work]) => work.supersedes === null ? [] : [work.supersedes]));
  const heads = entries.filter(([id]) => !superseded.has(id));
  if (heads.length !== 1) {
    reasons.add("ambiguous-head");
    return refused(reasons);
  }
  const [workId, head] = heads[0]!;
  if (head.state !== "RESOLVED") {
    if (TERMINAL_WORK_STATES.has(head.state)) reasons.add("rejected-head");
    return refused(reasons);
  }
  if (head.requester !== members.coordinator || head.assignee_addressed.length !== 1 ||
      head.assignee_addressed[0] !== members.builder || head.accepted_by !== members.builder) {
    reasons.add("invalid-compiled-state");
  }

  const resultRef = head.result;
  if (resultRef === null) {
    reasons.add("missing-result-event");
    return refused(reasons);
  }
  const resultEvents = wire.events.filter((event) => event.hash === resultRef);
  const resultEvent = resultEvents.length === 1 && resultEvents[0]!.type === "work.result" && resultEvents[0]!.work_id === workId
    ? resultEvents[0]!
    : null;
  if (!resultEvent) {
    reasons.add("missing-result-event");
    return refused(reasons);
  }
  if (resultEvent.actor !== members.builder) reasons.add("invalid-compiled-state");

  const resultArtifacts = resultEvent.refs.artifacts;
  const resultReceipts = resultEvent.refs.artifact_receipts;
  const artifacts: CandidateArtifact[] = [];
  const resultArtifactIds = new Set<string>();
  if (!validNamedArtifacts(resultArtifacts) || !validReceipts(resultReceipts) ||
      head.deliverables.length === 0 || !head.deliverables.every((name) => Object.hasOwn(resultArtifacts, name)) ||
      !sameRecord(head.artifacts, resultArtifacts)) {
    reasons.add("missing-artifact-receipt");
  } else {
    for (const artifactId of Object.values(resultArtifacts)) resultArtifactIds.add(artifactId);
    if (Object.keys(resultArtifacts).length !== head.deliverables.length ||
        Object.keys(resultReceipts).some((id) => !resultArtifactIds.has(id))) reasons.add("invalid-compiled-state");
    for (const [name, artifactId] of Object.entries(resultArtifacts)) {
      const receipt = resultReceipts[artifactId];
      if (!receipt || receipt.id !== artifactId) {
        reasons.add("missing-artifact-receipt");
        continue;
      }
      if (!ARTIFACT_SHA256.test(receipt.sha256)) {
        reasons.add("bad-artifact-sha256");
        continue;
      }
      artifacts.push({ name, artifactId, sha256: receipt.sha256 });
    }
  }

  const requirements = Object.entries(head.requirements);
  if (requirements.length === 0 || requirements.some(([, requirement]) => requirement.status !== "satisfied")) {
    reasons.add("unsatisfied-requirement");
  }
  const verifyRequirements = requirements.filter(([, requirement]) => requirement.kind === "verify");
  if (verifyRequirements.length === 0) reasons.add("unsatisfied-requirement");

  const verifications: CandidateVerification[] = [];
  for (const [requirementId, requirement] of verifyRequirements) {
    if (requirement.q !== 1 || requirement.eligible.length !== 1 || requirement.eligible[0] !== reviewerMemberId ||
        requirement.pos.length !== 1 || requirement.pos[0] !== reviewerMemberId || requirement.neg.length !== 0) {
      reasons.add("wrong-reviewer");
    }

    const forRequirement = wire.events.filter((event) =>
      event.type === "verification.pass" && event.work_id === workId && event.refs.requirement === requirementId);
    const forResult = forRequirement.filter((event) => event.refs.result_ref === resultRef);
    if (forRequirement.length > 0 && forResult.length === 0) reasons.add("stale-result-ref");
    const byReviewer = forResult.filter((event) => event.actor === reviewerMemberId);
    if (forResult.length > 0 && byReviewer.length === 0) reasons.add("wrong-reviewer");
    if (byReviewer.length > 1) reasons.add("invalid-compiled-state");
    if (byReviewer.length !== 1) {
      if (forRequirement.length === 0) reasons.add("missing-review-evidence");
      continue;
    }

    const verification = byReviewer[0]!;
    const evidence = verification.refs.evidence;
    const evidenceReceipts = verification.refs.artifact_receipts;
    if (typeof evidence !== "string" || !ARTIFACT_ID.test(evidence) || !validReceipts(evidenceReceipts)) {
      reasons.add("missing-review-evidence");
      continue;
    }
    if (resultArtifactIds.has(evidence)) {
      reasons.add("missing-review-evidence");
      continue;
    }
    const receipt = evidenceReceipts[evidence];
    if (!receipt || receipt.id !== evidence || Object.keys(evidenceReceipts).length !== 1) {
      reasons.add("missing-review-evidence");
      continue;
    }
    if (!ARTIFACT_SHA256.test(receipt.sha256)) {
      reasons.add("bad-artifact-sha256");
      continue;
    }
    verifications.push({
      eventHash: verification.hash,
      requirementId,
      evidenceArtifactId: evidence,
      evidenceSha256: receipt.sha256,
    });
  }

  if (reasons.size > 0) return refused(reasons);
  artifacts.sort((left, right) => compareTuple(
    [left.name, left.artifactId, left.sha256],
    [right.name, right.artifactId, right.sha256],
  ));
  verifications.sort((left, right) => compareTuple(
    [left.eventHash, left.requirementId, left.evidenceArtifactId, left.evidenceSha256],
    [right.eventHash, right.requirementId, right.evidenceArtifactId, right.evidenceSha256],
  ));

  const revisionInput = {
    state_digest: wire.digest,
    work_id: workId,
    result_ref: resultRef,
    artifacts: artifacts.map((artifact) => ({
      name: artifact.name,
      artifact_id: artifact.artifactId,
      sha256: artifact.sha256,
    })),
    verifications: verifications.map((verification) => ({
      event_hash: verification.eventHash,
      requirement_id: verification.requirementId,
      evidence_artifact_id: verification.evidenceArtifactId,
      evidence_sha256: verification.evidenceSha256,
    })),
  };
  const revisionSha256 = createHash("sha256").update(canonicalJson(revisionInput), "utf8").digest("hex");
  return {
    ok: true,
    candidate: {
      stateDigest: wire.digest,
      workId,
      resultRef,
      artifacts,
      verifications,
      revisionSha256,
    },
  };
}

export interface PrometheusMessage {
  sequence: number;
  content: string;
  sender_instance_id?: string;
  sender?: { member_id?: string };
}

export type PrometheusRoster = {
  readonly [Role in PrometheusRole]: { readonly memberId: string };
};

export interface TerminalReceipt {
  sequence: number;
  role: PrometheusRole;
  memberId: string;
  runId: string;
  revisionSha256: string;
}

export interface TerminalReceiptResult {
  ok: boolean;
  receipts: Partial<Record<PrometheusRole, TerminalReceipt>>;
  missingRoles: PrometheusRole[];
}

const TERMINAL_RECEIPT_PREFIX = "[sharednet-prometheus:v1] ";

function skipJsonWhitespace(raw: string, start: number): number {
  let index = start;
  while (index < raw.length && /[ \t\r\n]/.test(raw[index]!)) index += 1;
  return index;
}

function readJsonString(raw: string, start: number): { value: string; next: number } | null {
  if (raw[start] !== "\"") return null;
  let index = start + 1;
  while (index < raw.length) {
    if (raw[index] === "\\") {
      index += 2;
      continue;
    }
    if (raw[index] === "\"") {
      const encoded = raw.slice(start, index + 1);
      try {
        const value: unknown = JSON.parse(encoded);
        return typeof value === "string" ? { value, next: index + 1 } : null;
      } catch {
        return null;
      }
    }
    index += 1;
  }
  return null;
}

/** The receipt object is deliberately string-only, which lets duplicate keys be rejected before JSON can erase them. */
function parseReceiptObject(raw: string): Record<string, string> | null {
  let index = skipJsonWhitespace(raw, 0);
  if (raw[index] !== "{") return null;
  index = skipJsonWhitespace(raw, index + 1);
  const result = Object.create(null) as Record<string, string>;
  if (raw[index] === "}") return skipJsonWhitespace(raw, index + 1) === raw.length ? result : null;

  while (index < raw.length) {
    const key = readJsonString(raw, index);
    if (!key || Object.hasOwn(result, key.value)) return null;
    index = skipJsonWhitespace(raw, key.next);
    if (raw[index] !== ":") return null;
    index = skipJsonWhitespace(raw, index + 1);
    const value = readJsonString(raw, index);
    if (!value) return null;
    result[key.value] = value.value;
    index = skipJsonWhitespace(raw, value.next);
    if (raw[index] === "}") {
      index = skipJsonWhitespace(raw, index + 1);
      return index === raw.length ? result : null;
    }
    if (raw[index] !== ",") return null;
    index = skipJsonWhitespace(raw, index + 1);
  }
  return null;
}

function parsedTerminalReceipt(content: string): {
  type: "terminal.receipt";
  run_id: string;
  role: PrometheusRole;
  revision_sha256: string;
} | null {
  if (content.includes("\n") || content.includes("\r") || !content.startsWith(TERMINAL_RECEIPT_PREFIX)) return null;
  const value = parseReceiptObject(content.slice(TERMINAL_RECEIPT_PREFIX.length));
  if (!value || !hasExactKeys(value, ["type", "run_id", "role", "revision_sha256"]) ||
      value.type !== "terminal.receipt" || !PROMETHEUS_ROLES.includes(value.role as PrometheusRole) ||
      !ARTIFACT_SHA256.test(value.revision_sha256!)) return null;
  return value as {
    type: "terminal.receipt";
    run_id: string;
    role: PrometheusRole;
    revision_sha256: string;
  };
}

export function parseTerminalReceipts(
  messages: readonly PrometheusMessage[],
  roster: PrometheusRoster,
  runId: string,
  revisionSha256: string,
): TerminalReceiptResult {
  const receipts: Partial<Record<PrometheusRole, TerminalReceipt>> = {};
  const members = parseRosterMembers(roster);
  if (!members) return { ok: false, receipts, missingRoles: [...PROMETHEUS_ROLES] };
  const memberRoles = new Map<string, PrometheusRole>();
  for (const role of PROMETHEUS_ROLES) {
    const memberId = members[role];
    memberRoles.set(memberId, role);
  }
  if (!ARTIFACT_SHA256.test(revisionSha256)) {
    return { ok: false, receipts, missingRoles: [...PROMETHEUS_ROLES] };
  }

  for (const message of messages) {
    if (!Number.isSafeInteger(message.sequence) || message.sequence < 1 || typeof message.content !== "string") continue;
    const direct = message.sender_instance_id;
    const nested = message.sender?.member_id;
    if (direct !== undefined && nested !== undefined && direct !== nested) continue;
    const memberId = nested ?? direct;
    if (typeof memberId !== "string") continue;
    const savedRole = memberRoles.get(memberId);
    if (!savedRole) continue;

    const receipt = parsedTerminalReceipt(message.content);
    if (!receipt || receipt.role !== savedRole || receipt.run_id !== runId || receipt.revision_sha256 !== revisionSha256) continue;
    const previous = receipts[savedRole];
    if (previous && previous.sequence >= message.sequence) continue;
    receipts[savedRole] = {
      sequence: message.sequence,
      role: savedRole,
      memberId,
      runId,
      revisionSha256,
    };
  }

  const missingRoles = PROMETHEUS_ROLES.filter((role) => receipts[role] === undefined);
  return { ok: missingRoles.length === 0, receipts, missingRoles };
}
