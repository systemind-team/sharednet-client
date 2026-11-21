import type { MentionInboxItem, MentionInboxResponse, MentionAction, MentionActionResult } from "./repository.ts";
import { parsePostMessageRequest } from "../protocol/index.ts";
import { configuredContactPrincipals, configuredMentionConsent, releasedContent, emptyContactState, contactRule, grantContactRule, metadata, enqueueContactWake, contactWakeList, storedWake, claimWake, completeWake, type ContactState } from "./contact-policy.ts";
import type { ContactMetadata, ContactWake } from "../protocol/index.ts";
import { Room as CompiledEngine, PROTOCOL_V1 } from "../protocol/room.ts";
import type { ActResult, CompiledRoomState } from "../protocol/index.ts";
import { admitCompiled, compiledState, envelopeDigest, notification, type PersistedAct } from "./compiled.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import { PRIORITY_MAX_ATTEMPTS, priorityRetryMs, priorityLeaseMs, priorityFailureCategory, validatePriorityAssessment, priorityEvaluationMetadata, type DecisionPrioritySource, type DecisionPriorityEvaluationState, type DecisionPriorityEvaluationClaim, type DecisionPriorityAssessment, type DecisionPriorityFailureCategory } from "./decision-priority.ts";
import { CLOUD_ROOM_GRANT_MAX_ATTEMPTS, cloudMachineOf, cloudRoomGrantLeaseMs, cloudRoomGrantNotice, cloudRoomGrantRefusal, cloudRoomGrantRetryMs, decideSeatGrant, seatStillHeld, type CloudRoomGrantClaim, type CloudRoomGrantFailure, type CloudRoomGrantHeld, type CloudRoomGrantIntent, type CloudRoomGrantNoticeKind, type CloudRoomGrantSeat, type CloudRoomGrantState, type CloudRoomGrantView } from "./cloud-room-grants.ts";

import {
  type ClpSecret,
  type CliLoginId,
  type CliLogin,
  generateCliLoginCode,
  type RuntimeReport,
  type MemberRef,
  type MemberKind,
  type SniSecret,
  type JoinRoomRequest,
  type AdmittedBy,
  encodeInboxCursor,
  type InboxPosition,
  DEFAULT_MESSAGE_QUERY,
  digestSecret,
  generatePublicId,
  generateSecret,
  HUMAN_RUNTIME_KIND,
  RUNNER_RUNTIME_KIND,
  mentionedSeats,
  followingDue,
  timerSchedule,
  MAX_ROOM_TIMERS,
  CLOCK_RUNTIME_KIND,
  SEH_SECRET_PATTERN,
  HOOK_RUNTIME_KIND,
  isServiceRuntimeKind,
  serviceGoalTriggers,
  type OwnerMessageRequest,
  type RoomGoal,
  type StartGoalRequest,
  type Agent,
  type AgentId,
  type ApiKeyId,
  type AfkSecret,
  type Artifact,
  type ArtifactId,
  type ArtifactQuery,
  ARTIFACT_QUOTA_BYTES,
  MAX_ARTIFACT_BYTES,
  type CreateAgentRequest,
  type CreditBalance,
  type CreditCode,
  type CreditTransfer,
  type CreditTransferRequest,
  type TransferId,
  presenceFor,
  type Instance,
  type InstanceId,
  type InviteId,
  type JoinRoomWithInviteRequest,
  type MemberId,
  type Message,
  type MessageId,
  type Page,
  type Subscription,
  type ShpSecret,
  type TimerId,
  type CreateTimerRequest,
  type RoomTimer,
  type SehSecret,
  type CreateHookRequest,
  type RoomHook,
  type Principal,
  type PrincipalId,
  type RitSecret,
  type Room,
  type RoomId,
  type RoomInvite,
  type RoomMember,
  runtimeMetadataFor,
  SHR_SECRET_PATTERN,
  type ShrSecret,
  type StartInstanceRequest,
} from "../protocol/index.ts";
import { mentionEdges, sharedRoomsEdges, type SeatName, type ArtifactUsage, type CreditAuth, type CreditLedgerQuery, type CreditRedemption, type CreditsOverview, type DecisionAnswer, type DecisionOverview, type InboxEvent, type McpClient, type McpSeat, type NetworkView, type RoomOverview, type RoomView, type SeatEndedObserver, type SeatObserver, type SeatOverview, type SeatTaken, type SharedRoomView, type UploadArtifactInput, type UploadedArtifact, type PushTarget } from "./repository.ts";
import { networkReplies, REPLY_LEASE_MS, replyingSeats, type SeatMarks, waitingForDeliverySeats } from "./replying.ts";
import type {
  AddRoomMembersRequest,
  Admission,
  InviteDescription,
  CreateRoomRequest,
  Decision,
  DecisionId,
  DecisionPriority,
  DecisionStatus,
  ResolveDecisionRequest,
  UpdateInstanceRequest,
  MessageQuery,
  InvitePersonRequest,
  Person,
  PersonInvite,
} from "../protocol/index.ts";
import {
  assertPersonInviteBudget,
  personInviteDecision,
  PERSON_INVITE_WINDOW_MS,
  MAX_AGENTS_PER_PRINCIPAL,
  PRESENCE_LEASE_MS,
  RepositoryError,
  type IdempotencyResult,
  type IdempotencyScope,
  type InstanceDirectorySnapshot,
  type InstanceAuth,
  type PrincipalAuth,
  type RoomAuth,
  type SharedNetRepository,
  type StoredHttpResult,
} from "./repository.ts";

type ApiKeyRecord = {
  id: ApiKeyId;
  principalId: PrincipalId;
  digest: string;
  revokedAt: string | null;
  /**
   * Set for a key the service minted for a seat it keeps on the account's
   * behalf (an MCP client, or the Dashboard), so the same client finds it again.
   */
  seatClientId?: string;
};

type InstanceRecord = Instance & {
  tokenDigest: string;
  /** Null for an invite-admitted Instance of an anonymous Principal. */
  issuedByKeyId: ApiKeyId | null;
  admittedByInviteId: InviteId | null;
  localInstanceKey: string | null;
};

// Records store who acted (an Instance id) and never a copy of its tag; the
// tag is read from the Instance at projection time so regrouping follows.
type RoomRecord = Omit<Room, "creator_agent_id"> & {
  nextSequence: number;
  /** The public link's slug while the Room is published; set and cleared with `shared_at`. */
  shareToken: ShrSecret | null;
};
/** A direct Room is closed to everyone but its owner: no invite, no link, no foreign seat. */
function refuseDirect(room: RoomRecord): void {
  if (room.kind === "direct") {
    throw new RepositoryError(403, "room_direct", "A direct Room seats only its owner's Instances and cannot be invited to or published.");
  }
}

type MembershipRecord = {
  room_id: RoomId;
  instance_id: InstanceId;
  state: "active" | "left";
  joined_at: string;
  left_at: string | null;
  admitted_by: AdmittedBy;
  invite_id: InviteId | null;
  added_by_instance_id: InstanceId | null;
};
/** The requester's tag is read at projection time, like everywhere else. */
type DecisionRecord = Omit<Decision, "requested_by_agent_id"> & { priority_source?: DecisionPrioritySource };
type PriorityEvaluationRecord = {
  state: DecisionPriorityEvaluationState; attempts: number; nextAttemptAt: number; leaseToken: string | null; leaseExpiresAt: number | null;
  provider: string | null; model: string | null; rubricVersion: string | null; reason: string | null; confidence: number | null;
  assessedAt: string | null; inputDigest: string | null; failureCategory: DecisionPriorityFailureCategory | null; createdAt: string; updatedAt: string;
};
type CloudRoomGrantRecord = {
  room_id: RoomId; instance_id: InstanceId; machine: string; auth_user_id: string; seated_at: string; intent: CloudRoomGrantIntent; grant_id: string | null; agent_handle: string | null;
  state: CloudRoomGrantState; attempts: number; nextAttemptAt: number;
  leaseToken: string | null; leaseExpiresAt: number | null; lastRefusal: string | null;
  /** As the Postgres schema's lost_at: when an attempt of this revoke first went out without its end learned; a refusal settles nothing while it is set. */
  lostAt: string | null; grantedAt: string | null; createdAt: string; updatedAt: string;
};
type InviteRecord = RoomInvite & { tokenDigest: string };
type MessageRecord = {
  type?: "message" | "compiled_act";
  id: MessageId;
  room_id: RoomId;
  sequence: number;
  sender_principal_id: PrincipalId;
  sender_instance_id: InstanceId;
  content: string;
  reply_to_message_id: MessageId | null;
  created_at: string;
  mentions: InstanceId[];
};

type IdempotencyRecord = StoredHttpResult & {
  fingerprint: string;
};

type CliLoginRecord = CliLogin & {
  codeDigest: string;
  pollTokenDigest: string;
  apiKeyId: ApiKeyId | null;
};

const CLI_LOGIN_TTL_MS = 10 * 60_000;
/** A claim sits on a page the human is looking at; unused, it lapses after a week. */
const CLI_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

export { RepositoryError } from "./repository.ts";
export type {
  IdempotencyResult,
  IdempotencyScope,
  InstanceAuth,
  PrincipalAuth,
  McpClient,
  McpSeat,
  RoomAuth,
  SharedNetRepository,
} from "./repository.ts";

export type MemoryRepositoryOptions = {
  contactPrincipals?: PrincipalId[];
  /** Whether an @ across Principals waits for the target's owner; defaults to SHAREDNET_MENTION_CONSENT. */
  mentionConsent?: boolean;
  /** Told of each seat taken, right after the write; here there is no transaction to wait for. */
  seated?: SeatObserver;
  /** Told of each seat whose cloud Room grant row is due at once, right after the write: a grant to take back, or a grant to ask afresh once the revoke before it is through. */
  unseated?: SeatEndedObserver;
  devApiKey?: string;
  /** Each key seeds its own Principal, for exercising cross-Principal paths. */
  devApiKeys?: string[];
  /** Accounts with a Principal each, the way the Dashboard sees them; a key per account when given. */
  accounts?: Array<{ authUserId: string; apiKey?: string; displayName?: string; email?: string }>;
  /** Grant codes minted before anything runs, the way an operator would. */
  creditCodes?: Array<{ code: string; amount: number; max_redemptions?: number | null; expires_at?: string | null }>;
  now?: () => Date;
};

/**
 * The driver a connector reports. ChatGPT and Claude are named; anything else
 * takes a handle from its own name, and an unnamed client is just `mcp` —
 * never a handle derived from an opaque client id, which says nothing.
 */
export function runtimeKindForMcp(client: McpClient): string {
  const haystack = `${client.id} ${client.label}`.toLowerCase();
  if (haystack.includes("chatgpt") || haystack.includes("openai")) return "chatgpt";
  if (haystack.includes("claude") || haystack.includes("anthropic")) return "claude-ai";
  if (client.label === client.id) return "mcp";
  const handle = client.label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  // A client names itself; it does not get to name itself the person or the
  // runner (decisions 2026-10-04, 2026-10-05): those kinds are the service's.
  if (isServiceRuntimeKind(handle)) return "mcp";
  return /^[a-z][a-z0-9-]*$/.test(handle) ? handle : "mcp";
}

/**
 * The local session key for an MCP connection: one client on one account is
 * one session, so the same client finds its Instance again. The key is a
 * digest, like every other local key the schema accepts.
 */
export function mcpLocalInstanceKey(client: McpClient): string {
  return createHash("sha256").update(`mcp:${client.id}`).digest("hex");
}

/**
 * A seat the service registers for an account, rather than a CLI for itself:
 * an MCP client's, or the Dashboard's. It is registered by a key minted for it
 * and named for it, so it shows on the account's key list and can be revoked
 * there, and it finds the same Instance again by its local key.
 */
export type AccountSeatSpec = {
  clientId: string;
  keyName: string;
  /** What the key's metadata says minted it. */
  keySource: "mcp" | "dashboard" | "runner" | "hook" | "clock";
  runtimeKind: string;
  cliVersion: string;
  localInstanceKey: string;
  runtimeMetadata: Record<string, string>;
};

export function mcpSeatSpec(client: McpClient): AccountSeatSpec {
  return {
    clientId: client.id,
    keyName: `mcp · ${client.label}`,
    keySource: "mcp",
    runtimeKind: runtimeKindForMcp(client),
    cliVersion: "mcp",
    localInstanceKey: mcpLocalInstanceKey(client),
    runtimeMetadata: { connector: client.id, connector_label: client.label, runtime_source: "declared" },
  };
}

/**
 * The seat an account's person speaks through from the Dashboard (decision
 * 2026-10-04): one per account, of the `human` kind no join or registration
 * may declare, so a line from it is the person's own.
 */
export const DASHBOARD_SEAT: AccountSeatSpec = {
  clientId: "sharednet-dashboard",
  keyName: "web · Dashboard",
  keySource: "dashboard",
  runtimeKind: HUMAN_RUNTIME_KIND,
  cliVersion: "web",
  localInstanceKey: createHash("sha256").update("web:dashboard").digest("hex"),
  runtimeMetadata: { surface: "dashboard", runtime_source: "service" },
};

/**
 * The seat a goal Room's runner speaks through (decision 2026-10-05): check
 * results and "closing now", kept apart from the person's own words. One per
 * account, of the `runner` kind only the service writes.
 */
export const RUNNER_SEAT: AccountSeatSpec = {
  clientId: "sharednet-runner",
  keyName: "cli · Runner",
  keySource: "runner",
  runtimeKind: RUNNER_RUNTIME_KIND,
  cliVersion: "cli",
  localInstanceKey: createHash("sha256").update("cli:runner").digest("hex"),
  runtimeMetadata: { surface: "runner", runtime_source: "service" },
};

/**
 * The seat a Room's timers speak through (wait PR 6): one per account, named "clock", of the
 * `clock` kind only the service writes.
 */
export const CLOCK_SEAT: AccountSeatSpec = {
  clientId: "sharednet-clock",
  keyName: "service · Clock",
  keySource: "clock",
  runtimeKind: CLOCK_RUNTIME_KIND,
  cliVersion: "service",
  localInstanceKey: createHash("sha256").update("service:clock").digest("hex"),
  runtimeMetadata: { surface: "clock", runtime_source: "service" },
};

/**
 * The seat a Room hook speaks through (wait PR 6): one per account per hook name, so "ci" is the
 * same seat in every Room of the account, of the `hook` kind only the service writes.
 */
export function hookSeatSpec(name: string): AccountSeatSpec {
  return {
    clientId: `sharednet-hook-${name}`,
    keyName: `hook · ${name}`,
    keySource: "hook",
    runtimeKind: HOOK_RUNTIME_KIND,
    cliVersion: "hook",
    localInstanceKey: createHash("sha256").update(`hook:${name}`).digest("hex"),
    runtimeMetadata: { surface: "hook", runtime_source: "service" },
  };
}

/**
 * A goal Room's service-enforced end (`count`, `after`, `at`), or null. Pure,
 * so both repositories decide it the same way.
 */
export function dueGoalEnd(goal: RoomGoal | null, latestSequence: number, now: number): string | null {
  if (goal === null || goal.ended_by !== null) return null;
  for (const trigger of serviceGoalTriggers(goal.until)) {
    const due =
      trigger.kind === "count"
        ? latestSequence - goal.sequence >= trigger.count
        : trigger.kind === "after"
          ? now >= Date.parse(goal.started_at) + trigger.ms
          : now >= trigger.time;
    if (due) return trigger.label;
  }
  return null;
}

function secureDigestEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** What an invite join recorded about the driver, as Instance metadata. */
function runtimeMetadataFromReport(runtime: RuntimeReport | undefined): Record<string, string> {
  if (!runtime) return {};
  const metadata: Record<string, string> = { runtime_source: runtime.source ?? "declared" };
  if (runtime.version) metadata.driver_version = runtime.version;
  if (runtime.entrypoint) metadata.entrypoint = runtime.entrypoint;
  return metadata;
}

/** The inbox order: time, then Room, then sequence. Total and stable. */
function compareInboxPosition(left: InboxPosition, right: InboxPosition): number {
  const byTime = Date.parse(left.created_at) - Date.parse(right.created_at);
  if (byTime !== 0) return byTime;
  if (left.room_id !== right.room_id) return left.room_id < right.room_id ? -1 : 1;
  return left.sequence - right.sequence;
}

function membershipKey(roomId: RoomId, instanceId: InstanceId): string {
  return `${roomId}\0${instanceId}`;
}

function idempotencyKey(scope: IdempotencyScope): string {
  // A guest claim changes the purse's owner, never the Instance's retry scope.
  return [
    scope.credentialClass === "instance" ? "" : scope.principalId,
    scope.credentialClass,
    scope.actorId,
    scope.operationId,
    scope.key,
  ].join("\0");
}

export class MemorySharedNetRepository implements SharedNetRepository {
  private readonly now: () => Date;
  private readonly principals = new Map<PrincipalId, Principal>();
  private readonly apiKeysByDigest = new Map<string, ApiKeyRecord>();
  private readonly agents = new Map<AgentId, Agent>();
  private readonly instances = new Map<InstanceId, InstanceRecord>();
  private readonly instanceIdsByDigest = new Map<string, InstanceId>();
  private readonly acts = new Map<RoomId, PersistedAct[]>();
  private readonly compiledSeats = new Map<RoomId, InstanceId>();
  private readonly rooms = new Map<RoomId, RoomRecord>();
  private readonly memberships = new Map<string, MembershipRecord>();
  private readonly contactPrincipals: PrincipalId[];
  private readonly mentionConsent: boolean;
  private readonly contactStates = new Map<PrincipalId, ContactState>();
  private readonly decisions = new Map<DecisionId, DecisionRecord>();
  private readonly personInvites = new Map<DecisionId, { room_id: RoomId; inviter: PrincipalId; invitee: PrincipalId; stranger: boolean; blocked_at: string | null; created_at: string }>();
  private readonly priorityEvaluations = new Map<DecisionId, PriorityEvaluationRecord>();
  private readonly cloudRoomGrants = new Map<string, CloudRoomGrantRecord>();
  private readonly invites = new Map<InviteId, InviteRecord>();
  private readonly messages = new Map<RoomId, MessageRecord[]>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly cliLogins = new Map<CliLoginId, CliLoginRecord>();
  /** Anonymous Principals that were bound into an account's Principal. */
  private readonly mergedPrincipals = new Map<PrincipalId, PrincipalId>();
  /** The Principal each signed-in account owns. */
  private readonly principalsByAccount = new Map<string, PrincipalId>();
  private readonly accountEmails = new Map<string, string>();
  private readonly idempotencyInFlight = new Map<
    string,
    { fingerprint: string; result: Promise<IdempotencyResult> }
  >();
  /** Credits: the running total per Principal, the ledger, the codes, and who redeemed what. */
  private readonly creditBalances = new Map<PrincipalId, number>();
  private readonly creditTransfers: CreditTransfer[] = [];
  private readonly creditCodes = new Map<string, CreditCode>();
  private readonly creditRedemptions = new Set<string>();
  /** Artifacts: what each file is, its bytes, and the key of its link. */
  private readonly artifacts = new Map<ArtifactId, Artifact & { linkKey: AfkSecret }>();
  private readonly artifactBytes = new Map<ArtifactId, Uint8Array>();
  /** `principal\0instance` → the name that account gave that seat. */
  private readonly instanceAliases = new Map<string, string>();
  /** `${principalId}\0${roomId}` for every Room a Principal hid from its own list. */
  private readonly roomHides = new Set<string>();
  private readonly roomPins = new Set<string>();
  private readonly seated: SeatObserver | null;
  private readonly unseated: SeatEndedObserver | null;

  constructor(options: MemoryRepositoryOptions = {}) {
    this.contactPrincipals = options.contactPrincipals ?? configuredContactPrincipals();
    this.mentionConsent = options.mentionConsent ?? configuredMentionConsent();
    this.now = options.now ?? (() => new Date());
    this.seated = options.seated ?? null;
    this.unseated = options.unseated ?? null;

    const seedKeys = [
      ...(options.devApiKey ? [options.devApiKey] : []),
      ...(options.devApiKeys ?? []),
    ];
    for (const devApiKey of seedKeys) {
      const createdAt = this.timestamp();
      const principal: Principal = {
        id: generatePublicId("p"),
        display_name: null,
        default_reach: "public",
        created_at: createdAt,
        invited_by_principal_id: null,
      };
      const apiKeyRecord: ApiKeyRecord = {
        id: generatePublicId("key"),
        principalId: principal.id,
        digest: digestSecret(devApiKey),
        revokedAt: null,
      };
      this.principals.set(principal.id, principal);
      this.apiKeysByDigest.set(apiKeyRecord.digest, apiKeyRecord);
    }
    for (const account of options.accounts ?? []) {
      const principal: Principal = {
        id: generatePublicId("p"),
        display_name: account.displayName ?? null,
        default_reach: "public",
        created_at: this.timestamp(),
        invited_by_principal_id: null,
      };
      this.principals.set(principal.id, principal);
      this.principalsByAccount.set(account.authUserId, principal.id);
      if (account.email) this.accountEmails.set(account.authUserId, account.email);
      if (account.apiKey) {
        const digest = digestSecret(account.apiKey);
        this.apiKeysByDigest.set(digest, { id: generatePublicId("key"), principalId: principal.id, digest, revokedAt: null });
      }
    }
    for (const code of options.creditCodes ?? []) {
      void this.mintCreditCode(code);
    }
  }

  // ---- The Dashboard's door: Principal-scoped, the same rules as the API. ----

  async principalForAccount(authUserId: string): Promise<Principal | null> {
    const id = this.principalsByAccount.get(authUserId);
    const principal = id ? this.principals.get(id) : undefined;
    return principal ? { ...principal } : null;
  }

  private readonly subscriptions = new Map<string, {
    delivered: number;
    acked: number;
    movedAt: string;
    activeThrough: number | null;
    activeExpiresAt: string | null;
  }>();
  /** Doorbells by `instance|room` (wait PR 7). */
  private readonly doorbells = new Map<string, { url: string; secret: string; pushedThrough: number; failures: number; retryAt: number | null }>();
  private readonly timers = new Map<TimerId, RoomTimer>();
  /** Room hooks by `room|name`, each with the digest of its current token. */
  private readonly hooks = new Map<string, { hook: RoomHook; digest: string }>();

  async mcpSeat(authUserId: string, client: McpClient): Promise<McpSeat> {
    return this.accountSeat(authUserId, mcpSeatSpec(client));
  }

  async instanceDirectoryForPrincipal(principalId: PrincipalId): Promise<InstanceDirectorySnapshot> {
    const sampledAt = this.now().toISOString();
    const owned = [...this.instances.values()].filter(
      (instance) => instance.principal_id === principalId && instance.status !== "revoked",
    );
    const ownedIds = new Set(owned.map((instance) => instance.id));
    const active: Array<InstanceDirectorySnapshot["active"][number] & { expires_at: string }> = [];
    for (const [key, cursor] of this.subscriptions) {
      const separator = key.indexOf("|");
      const instanceId = key.slice(0, separator) as InstanceId;
      const roomId = key.slice(separator + 1) as RoomId;
      if (
        separator < 0 ||
        !ownedIds.has(instanceId) ||
        cursor.activeThrough === null ||
        cursor.activeExpiresAt === null ||
        cursor.activeThrough !== cursor.delivered ||
        cursor.acked >= cursor.activeThrough ||
        Date.parse(cursor.activeExpiresAt) <= Date.parse(sampledAt)
      ) continue;
      const membership = this.memberships.get(membershipKey(roomId, instanceId));
      const room = this.rooms.get(roomId);
      if (membership?.state === "active" && room) {
        active.push({ instance_id: instanceId, room_name: room.name, expires_at: cursor.activeExpiresAt });
      }
    }
    active.sort(
      (left, right) =>
        right.expires_at.localeCompare(left.expires_at) || right.room_name.localeCompare(left.room_name),
    );
    return {
      sampled_at: sampledAt,
      agents: [...this.agents.values()].filter((agent) => agent.principal_id === principalId),
      instances: owned.map((instance) => this.projectInstance(instance)),
      active: active.map(({ instance_id, room_name }) => ({ instance_id, room_name })),
    };
  }

  async dashboardSeat(authUserId: string): Promise<McpSeat> {
    return this.accountSeat(authUserId, DASHBOARD_SEAT);
  }

  private async accountSeat(authUserId: string, spec: AccountSeatSpec): Promise<McpSeat> {
    let principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) {
      // An account that never touched the API yet: its Principal is provisioned here, as a key would.
      const principal: Principal = { id: generatePublicId("p"), display_name: null, default_reach: "public", created_at: this.timestamp(), invited_by_principal_id: null };
      this.principals.set(principal.id, principal);
      this.principalsByAccount.set(authUserId, principal.id);
      principalId = principal.id;
    }
    let key = [...this.apiKeysByDigest.values()].find((record) => record.principalId === principalId && record.seatClientId === spec.clientId && record.revokedAt === null);
    if (!key) {
      key = { id: generatePublicId("key"), principalId, digest: digestSecret(generateSecret("snk")), revokedAt: null, seatClientId: spec.clientId };
      this.apiKeysByDigest.set(key.digest, key);
    }
    const principalAuth: PrincipalAuth = { kind: "api_key", principalId, actorId: key.id };
    const { instance, created } = await this.startInstance(principalAuth, {
      runtime_kind: spec.runtimeKind,
      cli_version: spec.cliVersion,
      local_instance_key: spec.localInstanceKey,
      runtime_metadata: { ...spec.runtimeMetadata },
    });
    return {
      principal: { ...this.principals.get(principalId)! },
      instance,
      auth: { kind: "instance", principalId, instanceId: instance.id, actorId: instance.id, anonymous: false },
      created,
    };
  }

  async postAsPerson(
    authUserId: string,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
    person: { name: string | null } = { name: null },
  ): Promise<{ message: Message }> {
    // The Room first, so a request about a Room this account cannot see mints nothing.
    const principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) throw new RepositoryError(404, "room_not_found", "Room was not found.");
    const room = this.roomVisibleTo(principalId, roomId);
    const result = await this.ownerLine(authUserId, room, input.content, "owner", person.name, input.reply_to_message_id);
    if (input.reply_to_message_id) {
      const mention = this.mentionItems(principalId).find((item) => item.message_id === input.reply_to_message_id && item.status === "pending");
      if (mention) this.mentionResolutions.set(`${principalId}|${mention.message_id}`, { status: "replied", reply_message_id: result.message.id });
    }
    return result;
  }

  private readonly mentionResolutions = new Map<string, { status: "done" | "replied"; reply_message_id: MessageId | null }>();
  private readonly mentionActions = new Map<string, Promise<unknown>>();

  private mentionItems(principalId: PrincipalId): MentionInboxItem[] {
    const humanIds = new Set([...this.instances.values()].filter((seat) => seat.principal_id === principalId && seat.runtime_kind === HUMAN_RUNTIME_KIND).map((seat) => seat.id));
    const items: MentionInboxItem[] = [];
    for (const [roomId, records] of this.messages) {
      const room = this.rooms.get(roomId);
      const visible = room && (room.principal_id === principalId || [...this.memberships.values()].some((m) => m.room_id === roomId && m.state === "active" && this.instances.get(m.instance_id)?.principal_id === principalId));
      if (!visible) continue;
      for (const record of records) {
        if ((record.type ?? "message") !== "message" || !record.mentions.some((id) => humanIds.has(id))) continue;
        const sender = this.instances.get(record.sender_instance_id);
        if (!sender || (isServiceRuntimeKind(sender.runtime_kind) && sender.runtime_kind !== HUMAN_RUNTIME_KIND)) continue;
        const resolution = this.mentionResolutions.get(`${principalId}|${record.id}`);
        items.push({ message_id: record.id, room_id: roomId, room_name: room.name, sequence: record.sequence, content: record.content, created_at: record.created_at, sender_instance_id: record.sender_instance_id, sender_name: sender.display_name ?? record.sender_instance_id, status: resolution?.status ?? "pending", reply_message_id: resolution?.reply_message_id ?? null });
      }
    }
    return items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.sequence - a.sequence || b.message_id.localeCompare(a.message_id));
  }

  async listMentionsForAccount(authUserId: string): Promise<MentionInboxResponse> {
    const principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) return { items: [], pending_count: 0 };
    const items = this.mentionItems(principalId);
    const pending = items.filter((item) => item.status === "pending");
    return { items: [...pending.slice(0, 100), ...items.filter((item) => item.status !== "pending").slice(0, 100)], pending_count: pending.length };
  }

  async resolveMentionForAccount(authUserId: string, messageId: MessageId, action: MentionAction, person: { name: string | null } = { name: null }): Promise<MentionActionResult> {
    const principalId = this.principalsByAccount.get(authUserId);
    const key = `${principalId}|${messageId}`;
    const previous = this.mentionActions.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      const item = principalId ? this.mentionItems(principalId).find((item) => item.message_id === messageId) : undefined;
      if (!item) throw new RepositoryError(404, "mention_not_found", "Mention was not found.");
      if (item.status !== "pending") {
        const reply = item.reply_message_id ? this.messages.get(item.room_id)?.find((m) => m.id === item.reply_message_id) : undefined;
        return { item, ...(reply ? { message: this.projectMessage(reply) } : {}) };
      }
      let message: Message | undefined;
      if (action.action === "reply") {
        const input = parsePostMessageRequest({ content: `@${item.sender_instance_id} ${action.content}`, reply_to_message_id: messageId });
        // Validate the person's text independently: adding an address must not make blank input valid.
        parsePostMessageRequest({ content: action.content });
        ({ message } = await this.postAsPerson(authUserId, item.room_id, input, person));
      }
      const resolution = { status: message ? "replied" as const : "done" as const, reply_message_id: message?.id ?? null };
      this.mentionResolutions.set(key, resolution);
      return { item: { ...item, ...resolution }, ...(message ? { message } : {}) };
    });
    this.mentionActions.set(key, operation);
    try { return await operation; } finally { if (this.mentionActions.get(key) === operation) this.mentionActions.delete(key); }
  }

  async uploadAsPerson(authUserId: string, roomId: RoomId, input: Omit<UploadArtifactInput, "room_id">): Promise<UploadedArtifact> {
    const principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) throw new RepositoryError(404, "room_not_found", "Room was not found.");
    const room = this.roomVisibleTo(principalId, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    const { auth } = await this.accountSeat(authUserId, DASHBOARD_SEAT);
    this.seatOwner(roomId, auth.instanceId);
    return this.uploadArtifact(auth, { ...input, room_id: roomId });
  }

  async seatForPlatform(
    authUserId: string,
    input: { key: McpClient; handle: string; registration: Omit<StartInstanceRequest, "agent_id"> },
  ): Promise<{ principal: Principal; instance: Instance; token: string; created: boolean }> {
    let principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) {
      const principal: Principal = { id: generatePublicId("p"), display_name: null, default_reach: "public", created_at: this.timestamp(), invited_by_principal_id: null };
      this.principals.set(principal.id, principal);
      this.principalsByAccount.set(authUserId, principal.id);
      principalId = principal.id;
    }
    let key = [...this.apiKeysByDigest.values()].find((record) => record.principalId === principalId && record.seatClientId === input.key.id && record.revokedAt === null);
    if (!key) {
      key = { id: generatePublicId("key"), principalId, digest: digestSecret(generateSecret("snk")), revokedAt: null, seatClientId: input.key.id };
      this.apiKeysByDigest.set(key.digest, key);
    }
    const principalAuth: PrincipalAuth = { kind: "api_key", principalId, actorId: key.id };
    const { agent } = await this.createAgent(principalAuth, { handle: input.handle });
    const { instance, token, created } = await this.startInstance(principalAuth, { ...input.registration, agent_id: agent.id });
    // The seat goes by its handle in every Room, as the service's own seats go by theirs, until the owner names it.
    const stored = this.instances.get(instance.id);
    if (stored && stored.display_name === null) stored.display_name = input.handle;
    return { principal: { ...this.principals.get(principalId)! }, instance: { ...instance, display_name: instance.display_name ?? input.handle }, token, created };
  }

  async speakAsOwner(principalId: PrincipalId, roomId: RoomId, input: OwnerMessageRequest): Promise<{ message: Message }> {
    const room = this.ownedRoom(principalId, roomId);
    return this.ownerLine(this.requireAccount(principalId), room, input.content, input.as, this.principals.get(principalId)?.display_name ?? null);
  }

  async retirePlatformKey(authUserId: string, key: McpClient): Promise<{ retired: boolean }> {
    const principalId = this.principalsByAccount.get(authUserId);
    if (!principalId) return { retired: false };
    let retired = false;
    for (const record of this.apiKeysByDigest.values()) {
      if (record.principalId === principalId && record.seatClientId === key.id && record.revokedAt === null) {
        record.revokedAt = this.timestamp();
        retired = true;
      }
    }
    return { retired };
  }

  async startGoal(principalId: PrincipalId, roomId: RoomId, input: StartGoalRequest): Promise<{ room: Room; message: Message }> {
    const room = this.ownedRoom(principalId, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    // One goal at a time: a goal that has ended may be followed by the next, said in the same Room.
    if (room.goal !== null && room.goal.ended_by === null) throw new RepositoryError(409, "goal_already_set", "This Room already has a goal.");
    const authUserId = this.requireAccount(principalId);
    const { message } = await this.ownerLine(authUserId, room, input.content, "owner", this.principals.get(principalId)?.display_name ?? null);
    room.goal = { message_id: message.id, sequence: message.sequence, until: [...input.until], started_at: message.created_at, ended_by: null };
    return { room: this.projectRoom(room), message };
  }

  async createRoomHook(principalId: PrincipalId, roomId: RoomId, input: CreateHookRequest): Promise<{ hook: RoomHook; token: SehSecret }> {
    const room = this.ownedRoom(principalId, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    const { auth } = await this.accountSeat(this.requireAccount(principalId), hookSeatSpec(input.name));
    const seat = this.instances.get(auth.instanceId);
    if (seat !== undefined && seat.display_name === null) seat.display_name = input.name;
    this.seatOwner(room.id, auth.instanceId);
    const key = `${room.id}|${input.name}`;
    const hook: RoomHook = this.hooks.get(key)?.hook ?? {
      id: generatePublicId("hk"),
      room_id: room.id,
      name: input.name,
      member_id: auth.instanceId,
      created_at: this.timestamp(),
    };
    const token = generateSecret("seh");
    this.hooks.set(key, { hook, digest: digestSecret(token) });
    return { hook: { ...hook }, token };
  }

  async authenticateHook(token: string, roomId: RoomId): Promise<{ hook: RoomHook; auth: InstanceAuth } | null> {
    if (!SEH_SECRET_PATTERN.test(token)) return null;
    const digest = digestSecret(token);
    const found = [...this.hooks.values()].find((entry) => entry.hook.room_id === roomId && secureDigestEquals(entry.digest, digest));
    const seat = found ? this.instances.get(found.hook.member_id) : undefined;
    if (!found || !seat) return null;
    // A hook has no process to keep it present: being used is its presence, so each event renews it.
    // Without this its seat went offline a lease after it was minted, and every later event was refused.
    const now = this.now();
    seat.last_seen_at = now.toISOString();
    seat.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    return {
      hook: { ...found.hook },
      auth: { kind: "instance", principalId: seat.principal_id, instanceId: seat.id, actorId: seat.id, anonymous: false },
    };
  }

  /** The owner's clock seat, seated in the Room; a Room whose owner has no account has no clock. */
  private async clockSeat(room: RoomRecord): Promise<InstanceAuth> {
    const { auth } = await this.accountSeat(this.requireAccount(room.principal_id), CLOCK_SEAT);
    const seat = this.instances.get(auth.instanceId);
    if (seat !== undefined && seat.display_name === null) seat.display_name = "clock";
    this.seatOwner(room.id, auth.instanceId);
    return auth;
  }

  async createTimer(auth: RoomAuth, roomId: RoomId, input: CreateTimerRequest): Promise<{ timer: RoomTimer }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    if ([...this.timers.values()].filter((timer) => timer.room_id === room.id).length >= MAX_ROOM_TIMERS) {
      throw new RepositoryError(409, "too_many_timers", "This Room already has as many timers as it may; cancel one first.");
    }
    const { label, first } = timerSchedule(input.when, this.now().getTime());
    const clock = await this.clockSeat(room);
    const timer: RoomTimer = {
      id: generatePublicId("tm"),
      room_id: room.id,
      when: label,
      say: input.say,
      next_at: new Date(first).toISOString(),
      member_id: clock.instanceId,
      created_by: auth.instanceId,
      created_at: this.timestamp(),
    };
    this.timers.set(timer.id, timer);
    return { timer: { ...timer } };
  }

  async listTimers(auth: RoomAuth, roomId: RoomId): Promise<{ items: RoomTimer[] }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const items = [...this.timers.values()].filter((timer) => timer.room_id === room.id);
    return { items: items.sort((left, right) => Date.parse(left.next_at) - Date.parse(right.next_at)).map((timer) => ({ ...timer })) };
  }

  async cancelTimer(auth: RoomAuth, roomId: RoomId, timerId: TimerId): Promise<{ timer: RoomTimer }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const timer = this.timers.get(timerId);
    if (!timer || timer.room_id !== room.id) throw new RepositoryError(404, "timer_not_found", "Timer was not found.");
    if (timer.created_by !== auth.instanceId && auth.principalId !== room.principal_id) {
      throw new RepositoryError(404, "timer_not_found", "Timer was not found.");
    }
    this.timers.delete(timer.id);
    return { timer: { ...timer } };
  }

  async setPush(auth: RoomAuth, roomId: RoomId, url: string | null): Promise<{ subscription: Subscription; push: { url: string; secret: ShpSecret } | null }> {
    const subscription = await this.getSubscription(auth, roomId);
    const key = `${auth.instanceId}|${subscription.room_id}`;
    if (url === null) {
      this.doorbells.delete(key);
      return { subscription, push: null };
    }
    const secret = generateSecret("shp");
    this.doorbells.set(key, { url, secret, pushedThrough: subscription.acked_through, failures: 0, retryAt: null });
    return { subscription, push: { url, secret } };
  }

  async pushTargets(roomId: RoomId, except: InstanceId | null, now: Date): Promise<PushTarget[]> {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== "open") return [];
    const through = room.nextSequence - 1;
    const targets: PushTarget[] = [];
    for (const [key, bell] of this.doorbells) {
      const [instanceId, bellRoom] = key.split("|") as [InstanceId, RoomId];
      if (bellRoom !== roomId || instanceId === except) continue;
      if (this.memberships.get(membershipKey(roomId, instanceId))?.state !== "active") continue;
      const acked = this.subscriptions.get(key)?.acked ?? 0;
      if (acked >= through) continue;
      const fresh = bell.failures === 0 && bell.pushedThrough < through;
      const due = bell.retryAt !== null && bell.retryAt <= now.getTime();
      if (!fresh && !due) continue;
      targets.push({ instance_id: instanceId, room_id: roomId, url: bell.url, secret: bell.secret, through, acked_through: acked, failures: bell.failures });
    }
    return targets;
  }

  async notePush(instanceId: InstanceId, roomId: RoomId, outcome: { ok: boolean; through: number; retryAt: Date }): Promise<void> {
    const bell = this.doorbells.get(`${instanceId}|${roomId}`);
    if (!bell) return;
    if (outcome.ok) {
      bell.pushedThrough = Math.max(bell.pushedThrough, outcome.through);
      bell.failures = 0;
    } else {
      bell.failures += 1;
    }
    bell.retryAt = outcome.retryAt.getTime();
  }

  async roomsDue(now: Date, limit: number): Promise<RoomId[]> {
    const due = new Set<RoomId>();
    for (const timer of this.timers.values()) if (Date.parse(timer.next_at) <= now.getTime()) due.add(timer.room_id);
    for (const key of this.doorbells.keys()) {
      const roomId = key.split("|")[1] as RoomId;
      if ((await this.pushTargets(roomId, null, now)).length > 0) due.add(roomId);
    }
    return [...due].slice(0, limit);
  }

  async fireDueTimers(roomId: RoomId): Promise<number> {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== "open") return 0;
    const now = this.now().getTime();
    const due = [...this.timers.values()]
      .filter((timer) => timer.room_id === room.id && Date.parse(timer.next_at) <= now)
      .sort((left, right) => Date.parse(left.next_at) - Date.parse(right.next_at));
    for (const timer of due) {
      const next = followingDue(timerSchedule(timer.when, 0).schedule, Date.parse(timer.next_at), now);
      if (next === null) this.timers.delete(timer.id);
      else timer.next_at = new Date(next).toISOString();
      const clock = await this.clockSeat(room);
      await this.postMessage(clock, room.id, { content: timer.say });
    }
    return due.length;
  }

  /** The account behind a Principal; speaking as a Room's owner needs one, because the seats are the account's. */
  private requireAccount(principalId: PrincipalId): string {
    const authUserId = this.accountOf(principalId);
    if (authUserId === undefined) throw new RepositoryError(403, "owner_account_required", "Only a Principal with an account behind it can speak as a Room's owner; run sharednet login.");
    return authUserId;
  }

  /**
   * One owner line in a Room this account owns: through the person's seat
   * (`owner`), named after the person until the person renames it, or through
   * the runner's (`runner`), named "runner".
   */
  private async ownerLine(authUserId: string, room: RoomRecord, content: string, as: "owner" | "runner", name: string | null, replyToMessageId?: MessageId | null): Promise<{ message: Message }> {
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    const { auth } = await this.accountSeat(authUserId, as === "runner" ? RUNNER_SEAT : DASHBOARD_SEAT);
    const seat = this.instances.get(auth.instanceId);
    const seatName = as === "runner" ? "runner" : name;
    if (seat !== undefined && seat.display_name === null && seatName !== null) seat.display_name = seatName;
    this.seatOwner(room.id, auth.instanceId);
    return this.postMessage(auth, room.id, { content, reply_to_message_id: replyToMessageId });
  }

  /**
   * The end triggers the service enforces itself, checked whenever the Room is
   * touched, so a goal Room ends even when its runner has died.
   */
  private endGoalIfDue(room: RoomRecord): void {
    if (room.state !== "open") return;
    const trigger = dueGoalEnd(room.goal, room.nextSequence - 1, this.now().getTime());
    if (trigger === null || room.goal === null) return;
    const at = this.timestamp();
    room.state = "closed";
    room.closed_at = at;
    room.goal = { ...room.goal, ended_by: { trigger, at, detail: null } };
  }

  /** A person's or the owner's own seat in a Room: added once, brought back if it was removed. */
  private seatOwner(roomId: RoomId, instanceId: InstanceId): void {
    const key = membershipKey(roomId, instanceId);
    const existing = this.memberships.get(key);
    if (existing?.state === "active") return;
    const now = this.timestamp();
    this.memberships.set(key, {
      room_id: roomId,
      instance_id: instanceId,
      state: "active",
      joined_at: now,
      left_at: null,
      admitted_by: "room_id",
      invite_id: null,
      added_by_instance_id: null,
    });
  }

  /** A seat's two marks in a Room, moved only forward and never past its last message. */
  private moveSubscription(auth: RoomAuth, roomId: RoomId, move: (kept: { delivered: number; acked: number }, last: number) => { delivered: number; acked: number }): Subscription {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const key = `${auth.instanceId}|${room.id}`;
    const kept = this.subscriptions.get(key) ?? {
      delivered: 0,
      acked: 0,
      activeThrough: null,
      activeExpiresAt: null,
    };
    const next = move(kept, room.nextSequence - 1);
    const clearsLease = kept.activeThrough !== null && next.acked >= kept.activeThrough;
    // Like the Postgres row's updated_at: every handover and every ack is a move, even a no-op one.
    this.subscriptions.set(key, {
      ...next,
      activeThrough: clearsLease ? null : kept.activeThrough,
      activeExpiresAt: clearsLease ? null : kept.activeExpiresAt,
      movedAt: this.now().toISOString(),
    });
    return { room_id: room.id, delivered_through: next.delivered, acked_through: next.acked };
  }

  async getSubscription(auth: RoomAuth, roomId: RoomId): Promise<Subscription> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const kept = this.subscriptions.get(`${auth.instanceId}|${room.id}`);
    return { room_id: room.id, delivered_through: kept?.delivered ?? 0, acked_through: kept?.acked ?? 0 };
  }

  async markDelivered(auth: RoomAuth, roomId: RoomId, through: number): Promise<Subscription> {
    const subscription = this.moveSubscription(auth, roomId, (kept, last) => ({
      ...kept,
      delivered: Math.max(kept.delivered, Math.min(through, last)),
    }));
    // A fresh handover, including a same-span redelivery after restart/downgrade, returns to legacy
    // inference until a lease-capable driven turn explicitly claims it. An older partial page must
    // not clear the lease held by a newer span.
    const kept = this.subscriptions.get(`${auth.instanceId}|${roomId}`)!;
    const handedThrough = Math.max(0, Math.min(through, subscription.delivered_through));
    if (kept.activeThrough !== null && handedThrough >= kept.activeThrough) {
      kept.activeThrough = null;
      kept.activeExpiresAt = null;
    }
    return subscription;
  }

  async heartbeatSubscription(auth: RoomAuth, roomId: RoomId, through: number): Promise<{ subscription: Subscription; renewed: boolean }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const key = `${auth.instanceId}|${room.id}`;
    const kept = this.subscriptions.get(key);
    const valid = kept !== undefined && kept.acked < through && through === kept.delivered;
    if (valid) {
      kept.activeThrough = through;
      kept.activeExpiresAt = new Date(this.now().getTime() + REPLY_LEASE_MS).toISOString();
    }
    return {
      renewed: valid,
      subscription: {
        room_id: room.id,
        delivered_through: kept?.delivered ?? 0,
        acked_through: kept?.acked ?? 0,
      },
    };
  }

  async acknowledge(auth: RoomAuth, roomId: RoomId, through: number): Promise<Subscription> {
    return this.moveSubscription(auth, roomId, (kept, last) => {
      const acked = Math.max(kept.acked, Math.min(through, last));
      return { delivered: Math.max(kept.delivered, acked), acked };
    });
  }

  /** A Room the Principal scheduled, or has an active seat in; anything else is absent. */
  private roomVisibleTo(principalId: PrincipalId, roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    const seated =
      room !== undefined &&
      [...this.memberships.values()].some(
        (membership) =>
          membership.room_id === room.id &&
          membership.state === "active" &&
          this.instances.get(membership.instance_id)?.principal_id === principalId,
      );
    if (!room || (room.principal_id !== principalId && !seated)) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    this.endGoalIfDue(room);
    return room;
  }

  private ownedRoom(principalId: PrincipalId, roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room || room.principal_id !== principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    this.endGoalIfDue(room);
    return room;
  }

  async listRoomsForPrincipal(principalId: PrincipalId): Promise<{ items: RoomOverview[] }> {
    const items = [...this.rooms.values()]
      .filter((room) => {
        try {
          this.roomVisibleTo(principalId, room.id);
          return true;
        } catch {
          return false;
        }
      })
      .map((room) => {
        const log = this.messages.get(room.id) ?? [];
        const last = log.length > 0 ? log[log.length - 1] : undefined;
        const latest_message = last
          ? {
              // Characters, not UTF-16 code units, so an emoji is cut the
              // same way PostgreSQL's `left(content, 200)` cuts it.
              content: [...last.content].slice(0, 200).join(""),
              created_at: last.created_at,
              // The sender's *current* tag, the way every other read resolves
              // it, so regrouping moves this row too.
              sender_agent_id: this.tagOf(last.sender_instance_id),
              sender_instance_id: last.sender_instance_id,
              sender_principal_id: last.sender_principal_id,
              sender_runtime_kind: this.instances.get(last.sender_instance_id)?.runtime_kind ?? "custom",
              sequence: last.sequence,
            }
          : null;
        return {
          room: this.projectRoom(room),
          active_member_count: [...this.memberships.values()].filter(
            (membership) => membership.room_id === room.id && membership.state === "active",
          ).length,
          latest_sequence: room.nextSequence - 1,
          latest_message,
          last_activity_at: latest_message?.created_at ?? room.created_at,
          hidden: this.roomHides.has(`${principalId}\0${room.id}`),
          pinned: this.roomPins.has(`${principalId}\0${room.id}`),
        };
      })
      // Newest conversation first, tie-broken exactly as the PostgreSQL
      // repository does it: equal activity falls back to when the Room was
      // made, and only then to the id.
      .sort(
        (a, b) =>
          b.last_activity_at.localeCompare(a.last_activity_at) ||
          b.room.created_at.localeCompare(a.room.created_at) ||
          b.room.id.localeCompare(a.room.id),
      );
    return { items };
  }

  async getRoomForPrincipal(principalId: PrincipalId, roomId: RoomId): Promise<RoomView> {
    const room = this.roomVisibleTo(principalId, roomId);
    const log = this.roomLog(room, principalId);
    const seats = new Set([
      ...log.memberships.map((member) => member.instance_id),
      ...log.messages.map((message) => message.sender_instance_id),
    ]);
    const aliases: Record<InstanceId, string> = {};
    for (const instanceId of seats) {
      const alias = this.instanceAliases.get(`${principalId}\0${instanceId}`);
      if (alias !== undefined) aliases[instanceId] = alias;
    }
    const marks = new Map<InstanceId, SeatMarks>();
    for (const member of log.memberships) {
      const kept = this.subscriptions.get(`${member.instance_id}|${room.id}`);
      if (kept) marks.set(member.instance_id, {
        delivered_through: kept.delivered,
        acked_through: kept.acked,
        moved_at: kept.movedAt,
        active_through: kept.activeThrough,
        active_expires_at: kept.activeExpiresAt,
      });
    }
    // Anyone seated may publish the Room (decision 2026-09-30), so anyone seated sees its link.
    return {
      ...log,
      share_token: room.shareToken,
      aliases,
      replying: replyingSeats(log.messages, marks, this.now()),
      waiting_for_delivery: waitingForDeliverySeats(
        log.messages,
        marks,
        new Set(
          log.memberships
            .filter((member) => member.state === "active" && !isServiceRuntimeKind(member.runtime_kind))
            .map((member) => member.instance_id),
        ),
      ),
    };
  }

  async setRoomHidden(principalId: PrincipalId, roomId: RoomId, hidden: boolean): Promise<{ room_id: RoomId; hidden: boolean }> {
    const room = this.roomVisibleTo(principalId, roomId);
    const key = `${principalId}\0${room.id}`;
    if (hidden) this.roomHides.add(key);
    else this.roomHides.delete(key);
    return { room_id: room.id, hidden };
  }

  async setRoomPinned(principalId: PrincipalId, roomId: RoomId, pinned: boolean): Promise<{ room_id: RoomId; pinned: boolean }> {
    const room = this.roomVisibleTo(principalId, roomId);
    const key = `${principalId}\0${room.id}`;
    if (pinned) this.roomPins.add(key);
    else this.roomPins.delete(key);
    return { room_id: room.id, pinned };
  }

  async nameSeat(principalId: PrincipalId, instanceId: InstanceId, name: string | null): Promise<SeatName> {
    const instance = this.instances.get(instanceId);
    // Your own seat's name is the name it goes by: everyone in its Rooms sees
    // it, because it is your name for yourself.
    if (instance !== undefined && instance.principal_id === principalId) {
      instance.display_name = name;
      // A note you once left on your own seat would now sit under its nickname.
      this.instanceAliases.delete(`${principalId}\0${instanceId}`);
      return { instance_id: instanceId, name, scope: "nickname" };
    }
    // A seat this account cannot see does not exist as far as it is concerned,
    // so naming one cannot be used to discover that an id is real.
    const visible =
      instance !== undefined &&
      ([...this.memberships.values()].some(
          (membership) =>
            membership.state === "active" &&
            membership.instance_id === instanceId &&
            [...this.memberships.values()].some(
              (mine) =>
                mine.room_id === membership.room_id &&
                mine.state === "active" &&
                this.instances.get(mine.instance_id)?.principal_id === principalId,
            ),
        ));
    if (!visible) throw new RepositoryError(404, "instance_not_found", "Instance was not found.");
    // Someone else's seat: a note, for this account's eyes only.
    const key = `${principalId}\0${instanceId}`;
    if (name === null) this.instanceAliases.delete(key);
    else this.instanceAliases.set(key, name);
    return { instance_id: instanceId, name, scope: "note" };
  }

  async scheduleRoom(
    principalId: PrincipalId,
    input: { name: string; description: string | null },
  ): Promise<{ room: Room }> {
    if (!this.principals.has(principalId)) {
      throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    }
    const room: RoomRecord = {
      id: generatePublicId("rom"),
      principal_id: principalId,
      name: input.name,
      description: input.description,
      state: "open",
      creator_instance_id: null,
      created_at: this.timestamp(),
      closed_at: null,
      shared_at: null,
      kind: "standard",
      shareToken: null,
      goal: null,
      nextSequence: 1,
    };
    this.rooms.set(room.id, room);
    this.messages.set(room.id, []);
    return { room: this.projectRoom(room) };
  }

  async shareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room; share_token: ShrSecret }> {
    const room = this.roomVisibleTo(principalId, roomId);
    refuseDirect(room);
    if (room.shareToken === null) {
      room.shareToken = generateSecret("shr");
      room.shared_at = this.timestamp();
    }
    return { room: this.projectRoom(room), share_token: room.shareToken };
  }

  async unshareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }> {
    // Anyone seated may publish a Room; only its owner takes it down (decision 2026-09-30).
    const room = this.ownedRoom(principalId, roomId);
    room.shareToken = null;
    room.shared_at = null;
    return { room: this.projectRoom(room) };
  }

  async getSharedRoom(shareToken: string): Promise<SharedRoomView> {
    const room = SHR_SECRET_PATTERN.test(shareToken)
      ? [...this.rooms.values()].find((candidate) => candidate.shareToken === shareToken)
      : undefined;
    if (!room) throw new RepositoryError(404, "room_not_found", "Room was not found.");
    const log = this.roomLog(room, null);
    return { ...log, agent_handles: this.agentHandlesIn(log) };
  }

  /** Every seat and every message of a Room, in order: what both the owner's page and the public one read. */
  private roomLog(
    room: RoomRecord,
    viewer: PrincipalId | null,
  ): Omit<RoomView, "aliases" | "share_token" | "replying" | "waiting_for_delivery"> {
    const memberships = [...this.memberships.values()]
      .filter((membership) => membership.room_id === room.id)
      .sort((a, b) => a.joined_at.localeCompare(b.joined_at))
      .map((membership) => this.projectMembership(membership, viewer));
    const messages = (this.messages.get(room.id) ?? []).map((record) => this.projectMessage(record));
    return { room: this.projectRoom(room), memberships, messages, latest_sequence: room.nextSequence - 1 };
  }

  private agentHandlesIn(log: Pick<RoomView, "memberships" | "messages">): Record<AgentId, string> {
    const handles: Record<AgentId, string> = {};
    for (const agentId of [...log.memberships.map((m) => m.agent_id), ...log.messages.map((m) => m.sender_agent_id)]) {
      if (agentId === null || agentId in handles) continue;
      const agent = this.agents.get(agentId);
      if (agent) handles[agentId] = agent.handle;
    }
    return handles;
  }

  /**
   * A direct Room is one Agent's line to its owner. So while the Agent it was
   * opened with is still seated, the Room is not closed and the Agent is not
   * removed: both wait for the Agent to end.
   */
  private directAgents(room: RoomRecord): InstanceId[] {
    if (room.kind !== "direct") return [];
    return [...this.memberships.values()]
      .filter((membership) => membership.room_id === room.id && membership.state === "active" && membership.admitted_by === "added")
      .map((membership) => membership.instance_id);
  }

  async closeRoom(
    principalId: PrincipalId,
    roomId: RoomId,
    end: { trigger: string | null; detail: string | null } = { trigger: null, detail: null },
  ): Promise<{ room: Room }> {
    const room = this.ownedRoom(principalId, roomId);
    if (room.state !== "closed" && this.directAgents(room).length > 0) {
      throw new RepositoryError(409, "room_direct_seated", "A direct Room stays open, with its Agent in it, until that Agent has ended.");
    }
    if (room.state !== "closed") {
      room.state = "closed";
      room.closed_at = this.timestamp();
      // A goal Room records why it ended; a close with no trigger is the owner's own.
      if (room.goal !== null && room.goal.ended_by === null) {
        room.goal = { ...room.goal, ended_by: { trigger: end.trigger ?? "owner", at: room.closed_at, detail: end.detail } };
      }
    }
    return { room: this.projectRoom(room) };
  }

  async reopenRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }> {
    const room = this.ownedRoom(principalId, roomId);
    if (room.state === "closed") {
      room.state = "open";
      room.closed_at = null;
    }
    return { room: this.projectRoom(room) };
  }

  async reissueMemberToken(principalId: PrincipalId, roomId: RoomId, memberId: InstanceId): Promise<{ room: Room; membership: RoomMember; member_token: SniSecret }> {
    const room = this.ownedRoom(principalId, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    const membership = this.memberships.get(membershipKey(room.id, memberId));
    const instance = this.instances.get(memberId);
    if (!membership || membership.state !== "active" || !instance) throw new RepositoryError(404, "instance_not_found", "Instance was not found.");
    const refused = () => new RepositoryError(403, "member_not_reissuable", "Only a seat this goal Room's own invite brought into being, that nobody has bound to an account and that sits in no other Room, can be taken up by the Room's owner.");
    // A goal Room on a board: the owner's own run, whose seats it made.
    if (room.kind === "direct" || (room.type ?? "board") !== "board" || room.goal === null) throw refused();
    // The seat came into being by joining this Room through an invite of the owner's: not an Instance
    // an API key registered, and still live.
    const invite = membership.invite_id === null ? undefined : this.invites.get(membership.invite_id);
    const owner = (id: PrincipalId) => this.mergedPrincipals.get(id) ?? id;
    if (
      membership.admitted_by !== "invite" || !invite || invite.room_id !== room.id || owner(invite.principal_id) !== principalId
      || instance.admittedByInviteId !== invite.id || instance.issuedByKeyId !== null
      || instance.status === "ended" || instance.status === "revoked" || isServiceRuntimeKind(instance.runtime_kind)
    ) throw refused();
    // Still nobody's: the anonymous Principal that invite made for it, never bound, with no other Instance.
    const principal = this.principals.get(instance.principal_id);
    if (!principal || principal.invited_by_principal_id !== invite.principal_id || this.mergedPrincipals.has(principal.id)) throw refused();
    if ([...this.instances.values()].some((other) => other.id !== instance.id && other.principal_id === principal.id)) throw refused();
    // It speaks in this Room alone, so a token for it reaches nothing else.
    if ([...this.memberships.values()].some((other) => other.instance_id === instance.id && other.room_id !== room.id && other.state === "active")) throw refused();
    // The new token replaces the old one, which stops working; a doorbell the old holder set is taken down with it.
    const memberToken = generateSecret("sni");
    this.instanceIdsByDigest.delete(instance.tokenDigest);
    instance.tokenDigest = digestSecret(memberToken);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    const now = this.now();
    instance.last_seen_at = now.toISOString();
    instance.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    for (const key of [...this.doorbells.keys()]) if (key.startsWith(`${instance.id}|`)) this.doorbells.delete(key);
    return { room: this.projectRoom(room), membership: this.projectMembership(membership, principalId), member_token: memberToken };
  }

  async invitePerson(principalId: PrincipalId, roomId: RoomId, target: InvitePersonRequest): Promise<PersonInvite> {
    const room = this.roomVisibleTo(principalId, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    refuseDirect(room);
    const seen = this.peopleSeenBy(principalId);
    const inviteeId = "instance_id" in target ? this.instances.get(target.instance_id)?.principal_id : seen.has(target.principal_id) ? target.principal_id : undefined;
    const inviteeAccount = inviteeId === undefined || inviteeId === principalId ? undefined : this.accountOf(inviteeId);
    if (inviteeId === undefined || inviteeAccount === undefined) throw new RepositoryError(404, "person_not_found", "Person was not found.");
    const person: Person = { principal_id: inviteeId, name: this.principals.get(inviteeId)?.display_name ?? null };
    const invites = [...this.personInvites.values()].filter((invite) => invite.inviter === principalId);
    if (invites.some((invite) => invite.invitee === inviteeId && invite.blocked_at !== null)) {
      throw new RepositoryError(403, "invite_refused", "This person cannot be invited.");
    }
    if (this.canSee(inviteeId, room.id)) return { status: "member", person, room_id: room.id };
    const stranger = !seen.has(inviteeId);
    const since = new Date(this.now().getTime() - PERSON_INVITE_WINDOW_MS).toISOString();
    assertPersonInviteBudget(invites.filter((invite) => invite.created_at > since).map((invite) => invite.stranger), stranger);
    const inviterAccount = this.accountOf(principalId);
    if (inviterAccount === undefined) throw new RepositoryError(403, "permission_denied", "Only a Principal with an account behind it can invite people.");
    const inviter = await this.dashboardSeat(inviterAccount);
    const invitee = await this.dashboardSeat(inviteeAccount);
    this.seat(room, invitee.instance.id, "added", inviter.instance.id, principalId);
    const decision: DecisionRecord = {
      id: generatePublicId("dec"),
      priority: "p2",
      principal_id: inviteeId,
      mode: "approval",
      ...personInviteDecision(this.principals.get(principalId)?.display_name ?? null, room.name, stranger),
      status: "pending",
      requested_by_instance_id: inviter.instance.id,
      requested_for_instance_id: null,
      room_id: room.id,
      answer: null,
      created_at: this.timestamp(),
      resolved_at: null,
    };
    this.insertDecision(decision);
    this.personInvites.set(decision.id, { room_id: room.id, inviter: principalId, invitee: inviteeId, stranger, blocked_at: null, created_at: decision.created_at });
    return { status: "invited", person, room_id: room.id };
  }

  async findPeople(principalId: PrincipalId, query: string): Promise<{ people: Person[] }> {
    const needle = query.trim().toLowerCase();
    const people = [...this.peopleSeenBy(principalId)]
      .filter((id) => this.accountOf(id) !== undefined)
      .map((id) => ({ principal_id: id, name: this.principals.get(id)?.display_name ?? null }))
      .filter((person) => person.name?.toLowerCase().includes(needle))
      .sort((a, b) => a.name!.localeCompare(b.name!))
      .slice(0, 10);
    return { people };
  }

  async leaveRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room_id: RoomId }> {
    const room = this.roomVisibleTo(principalId, roomId);
    if (room.principal_id === principalId) throw new RepositoryError(409, "owner_cannot_leave", "A Room's owner closes it rather than leaving it.");
    this.leave(principalId, room.id);
    return { room_id: room.id };
  }

  /** Everyone the Principal shares or shared a Room with: the Rooms it owns or ever held a seat in, their owners and every seat in them. */
  private peopleSeenBy(principalId: PrincipalId): Set<PrincipalId> {
    const principalOf = (membership: MembershipRecord) => this.instances.get(membership.instance_id)?.principal_id;
    const rooms = new Set([
      ...[...this.rooms.values()].filter((room) => room.principal_id === principalId).map((room) => room.id),
      ...[...this.memberships.values()].filter((membership) => principalOf(membership) === principalId).map((membership) => membership.room_id),
    ]);
    const people = new Set<PrincipalId>();
    for (const roomId of rooms) people.add(this.rooms.get(roomId)!.principal_id);
    for (const membership of this.memberships.values()) {
      const member = principalOf(membership);
      if (member && rooms.has(membership.room_id)) people.add(member);
    }
    people.delete(principalId);
    return people;
  }

  async accountForApiKey(token: string): Promise<{ authUserId: string; email: string | null } | null> {
    const auth = await this.authenticateApiKey(token);
    const authUserId = auth ? this.accountOf(auth.principalId) : undefined;
    return authUserId === undefined ? null : { authUserId, email: this.accountEmails.get(authUserId) ?? null };
  }

  private accountOf(principalId: PrincipalId): string | undefined {
    for (const [authUserId, id] of this.principalsByAccount) if (id === principalId) return authUserId;
    return undefined;
  }

  private canSee(principalId: PrincipalId, roomId: RoomId): boolean {
    try {
      this.roomVisibleTo(principalId, roomId);
      return true;
    } catch {
      return false;
    }
  }

  /** Every seat of the Principal's in the Room leaves, and a pending invite to it there is declined with them. */
  private leave(principalId: PrincipalId, roomId: RoomId): void {
    const now = this.timestamp();
    for (const membership of this.memberships.values()) {
      if (membership.room_id === roomId && membership.state === "active" && this.instances.get(membership.instance_id)?.principal_id === principalId) {
        Object.assign(membership, { state: "left", left_at: now });
        this.endCloudRoomGrant(membership);
      }
    }
    for (const [id, invite] of this.personInvites) {
      const decision = this.decisions.get(id)!;
      if (invite.room_id === roomId && invite.invitee === principalId && decision.status === "pending") {
        Object.assign(decision, { status: "denied", resolved_at: now });
      }
    }
  }

  /** Declining a person invite leaves its Room; blocking also refuses the inviter's next invites. */
  private declineInvite(decision: DecisionRecord, block: boolean): void {
    const invite = this.personInvites.get(decision.id);
    if (block && !invite?.stranger) {
      throw new RepositoryError(422, "decision_resolution_invalid", "Only an invite from someone you had not shared a Room with can be blocked.");
    }
    if (!invite) return;
    if (block) invite.blocked_at = this.timestamp();
    this.leave(decision.principal_id, invite.room_id);
  }

  async removeRoomMember(
    principalId: PrincipalId,
    roomId: RoomId,
    instanceId: InstanceId,
  ): Promise<{ membership: RoomMember }> {
    const room = this.ownedRoom(principalId, roomId);
    const membership = this.memberships.get(membershipKey(room.id, instanceId));
    if (!membership) throw new RepositoryError(404, "member_not_found", "Member was not found.");
    if (room.state !== "closed" && this.directAgents(room).includes(instanceId)) {
      throw new RepositoryError(409, "room_direct_seated", "A direct Room stays open, with its Agent in it, until that Agent has ended.");
    }
    if (membership.state === "active") {
      membership.state = "left";
      membership.left_at = this.timestamp();
      this.endCloudRoomGrant(membership);
    }
    return { membership: this.projectMembership(membership, principalId) };
  }

  private contactState(owner: PrincipalId): ContactState {
    let state=this.contactStates.get(owner);if(!state){state=emptyContactState();this.contactStates.set(owner,state);}return state;
  }
  async isContactProtected(auth: RoomAuth): Promise<boolean> { this.instanceRecord(auth);return this.contactPrincipals.includes(auth.principalId); }
  async listContactRulesForPrincipal(owner: PrincipalId) { return {rules:this.contactState(owner).rules.map(r=>({...r}))}; }
  async revokeContactRuleForPrincipal(owner:PrincipalId,id:string) {
    const rule=this.contactState(owner).rules.find(r=>r.id===id);if(!rule)throw new RepositoryError(404,"decision_not_found","Rule was not found.");rule.revoked_at??=this.timestamp();for(const item of this.contactState(owner).wakes)if(item.ruleId===id&&item.wake.state==="queued"){item.wake.state="cancelled";this.updateContactEffect(item.decisionId,"cancelled");}return {rule:{...rule}};
  }
  async listContactWakes(auth:RoomAuth,input:{after:string|null;limit:number}) { this.instanceRecord(auth);return contactWakeList(this.contactState(auth.principalId),auth.instanceId,input); }
  async claimContactWake(auth:RoomAuth,id:string,input:{execution_key:string}) {
    this.requireOnline(auth);const state=this.contactState(auth.principalId);const item=storedWake(state,auth.instanceId,id);
    if(!item.executionKey)this.validateContact(auth.principalId, item.sourceInstanceId, item.wake.room_id, metadata("mention",item.sourcePrincipalId,auth.instanceId,item.wake.source_message_id,item.wake.authorized_at));
    const result=claimWake(state,item,input.execution_key,this.timestamp());this.updateContactEffect(item.decisionId,result.wake.state);return result;
  }
  async completeContactWake(auth:RoomAuth,id:string,input:{execution_key:string;receipt:string;outcome:"completed"|"failed"|"interrupted"}) {
    this.instanceRecord(auth);const state=this.contactState(auth.principalId);const item=storedWake(state,auth.instanceId,id);const result=completeWake(state,item,input);this.updateContactEffect(item.decisionId,result.wake.state);return result;
  }
  private updateContactEffect(id:string|null,state:ContactWake["state"]) { if(!id)return;const decision=this.decisions.get(id as DecisionId);if(decision?.contact)decision.contact.effect_state=state; }
  private validateContact(owner:PrincipalId,sourceId:InstanceId,roomId:RoomId,contact:ContactMetadata) {
    const target=this.instances.get(contact.target_instance_id),source=this.instances.get(sourceId),room=this.rooms.get(roomId);
    const targetMember=this.memberships.get(membershipKey(roomId,contact.target_instance_id));
    if(!room||room.state!=="open"||!target||target.principal_id!==owner||target.status==="ended"||target.status==="revoked"||!source||source.principal_id!==contact.source_principal_id||source.status==="ended"||source.status==="revoked"||contact.expires_at<=this.timestamp()||this.memberships.get(membershipKey(roomId,sourceId))?.state!=="active"||(contact.action==="mention"?targetMember?.state!=="active":targetMember?.state==="left"))throw new RepositoryError(403,"permission_denied","Contact request is no longer valid.");
  }
  private assertContactCapacity(source:PrincipalId,target:InstanceId) {
    const pending=[...this.decisions.values()].filter(d=>d.status==="pending"&&d.contact?.source_principal_id===source&&d.contact.target_instance_id===target&&d.contact.expires_at>this.timestamp());
    if(pending.length>=100)throw new RepositoryError(409,"resource_limit_reached","Too many pending contact requests for this source and target.");
  }
  private contactDecision(requester:InstanceRecord,room:RoomRecord,target:InstanceRecord,contact:ContactMetadata):DecisionRecord {
    const old=[...this.decisions.values()].find(d=>d.room_id===room.id&&d.requested_for_instance_id===target.id&&d.contact?.action===contact.action&&d.contact.source_principal_id===requester.principal_id&&d.contact.source_message_id===contact.source_message_id&&(d.status==="pending"&&d.contact.expires_at>this.timestamp()||contact.action==="invite"&&d.status==="denied"));if(old)return old;
    this.assertContactCapacity(requester.principal_id,target.id);
    const decision:DecisionRecord={id:generatePublicId("dec"),priority:"p2",principal_id:target.principal_id,mode:"approval",title:contact.action==="invite"?"Allow an invitation?":"Allow an agent to respond?",description:`Principal ${requester.principal_id} requests ${contact.action} contact in Room ${room.id}. This does not grant file or tool access.`,status:"pending",requested_by_instance_id:requester.id,requested_for_instance_id:target.id,room_id:room.id,answer:null,created_at:this.timestamp(),resolved_at:null,contact};this.insertDecision(decision);return decision;
  }
  private contactMentions(sender:InstanceRecord,room:RoomRecord,message:MessageRecord) {
    // Validate the whole fanout before changing any state: one refused target
    // must not leave another target's wake behind for an uncommitted message.
    for(const id of message.mentions){const target=this.instances.get(id);if(target&&this.contactPrincipals.includes(target.principal_id)&&sender.principal_id!==target.principal_id&&!contactRule(this.contactState(target.principal_id),sender.principal_id,"mention"))this.assertContactCapacity(sender.principal_id,id);}

    for(const id of message.mentions){const target=this.instances.get(id);if(!target||!this.contactPrincipals.includes(target.principal_id))continue;
      const state=this.contactState(target.principal_id),rule=contactRule(state,sender.principal_id,"mention"),contact=metadata("mention",sender.principal_id,id,message.id,this.timestamp());
      if(sender.principal_id===target.principal_id||rule)enqueueContactWake(state,{roomId:room.id,targetId:id,messageId:message.id,sourceId:sender.id,sourcePrincipalId:sender.principal_id,authorization:rule?"contact_rule":"same_principal",ruleId:rule?.id,expiresAt:contact.expires_at,now:this.timestamp()});
      else this.contactDecision(sender,room,target,contact);
    }
  }

  /**
   * Mention consent: the seats this line may wake now. An agent of another Principal is woken only
   * once its owner approves in Decisions (or has always allowed the sender's Principal); until then
   * the line is not addressed to it, so no wait, serve or push treats it as a mention.
   */
  private holdForeignMentions(sender: InstanceRecord, room: RoomRecord, message: MessageRecord): InstanceId[] {
    if (!this.mentionConsent) return message.mentions;
    const held = message.mentions.flatMap((id) => {
      const target = this.instances.get(id);
      return target && this.needsMentionConsent(sender, target) ? [target] : [];
    });
    // Every target is checked before any Decision is written, so a refused line leaves nothing behind.
    for (const target of held) this.assertContactCapacity(sender.principal_id, target.id);
    for (const target of held) this.contactDecision(sender, room, target, metadata("mention", sender.principal_id, target.id, message.id, this.timestamp()));
    return message.mentions.filter((id) => !held.some((target) => target.id === id));
  }

  private needsMentionConsent(sender: InstanceRecord, target: InstanceRecord): boolean {
    // Only an owner with an account can answer a Decision; an invite's anonymous seat has none.
    return target.principal_id !== sender.principal_id &&
      !isServiceRuntimeKind(target.runtime_kind) &&
      [...this.principalsByAccount.values()].includes(target.principal_id) &&
      !this.contactPrincipals.includes(target.principal_id) &&
      !contactRule(this.contactState(target.principal_id), sender.principal_id, "mention");
  }

  /** An approved mention: a short pointer replies to the held line and addresses the target alone. */
  private releaseMention(decision: DecisionRecord): void {
    const contact = decision.contact!;
    const room = this.roomById(decision.room_id!);
    const roomMessages = this.messages.get(room.id)!;
    const held = roomMessages.find((message) => message.id === contact.source_message_id);
    if (!held) throw new RepositoryError(403, "permission_denied", "Contact request is no longer valid.");
    roomMessages.push({
      id: generatePublicId("msg"),
      room_id: room.id,
      sequence: room.nextSequence,
      sender_principal_id: held.sender_principal_id,
      sender_instance_id: held.sender_instance_id,
      content: releasedContent(contact.target_instance_id, held.sequence),
      reply_to_message_id: held.id,
      created_at: this.timestamp(),
      mentions: [contact.target_instance_id],
    });
    room.nextSequence += 1;
    this.endGoalIfDue(room);
  }

  async listDecisionsForPrincipal(principalId: PrincipalId): Promise<{ decisions: DecisionOverview[] }> {
    const decisions = [...this.decisions.values()]
      .filter((decision) => decision.principal_id === principalId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((decision) => this.decisionOverview(decision));
    return { decisions };
  }

  async reprioritizeDecisionForPrincipal(principalId: PrincipalId, decisionId: DecisionId, priority: DecisionPriority): Promise<DecisionOverview> {
    const decision = this.decisions.get(decisionId);
    if (!decision || decision.principal_id !== principalId) {
      throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
    }
    if (decision.status !== "pending") {
      throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
    }
    decision.priority = priority;
    decision.priority_source = "owner";
    const evaluation = this.priorityEvaluations.get(decisionId);
    if (evaluation && (evaluation.state === "pending" || evaluation.state === "processing")) {
      Object.assign(evaluation, { state: "superseded", leaseToken: null, leaseExpiresAt: null, updatedAt: this.timestamp() });
    }
    return this.decisionOverview(decision);
  }

  async resolveDecisionForPrincipal(
    principalId: PrincipalId,
    decisionId: DecisionId,
    answer: DecisionAnswer,
  ): Promise<{ decision: DecisionOverview; membership: RoomMember | null }> {
    const decision = this.decisions.get(decisionId);
    if (!decision || decision.principal_id !== principalId) {
      throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
    }
    if(!decision.contact && decision.status==="pending" && decision.requested_for_instance_id && decision.room_id && this.contactPrincipals.includes(principalId)) {
      const requester=this.instances.get(decision.requested_by_instance_id);
      if(requester && requester.principal_id!==principalId)decision.contact=metadata("invite",requester.principal_id,decision.requested_for_instance_id,null,decision.created_at);
    }
    if(decision.contact&&decision.status==="approved"&&answer.outcome==="approved"&&(decision.contact.approval_scope??"once")!==(answer.scope??"once"))throw new RepositoryError(409,"conflict","Contact approval scope differs from the recorded answer.");
    if (decision.contact && decision.status === answer.outcome && answer.outcome !== "answered") return {decision:this.decisionOverview(decision),membership:null};
    if (decision.status !== "pending") {
      throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
    }
    if (answer.outcome === "approved" && answer.scope && !decision.contact) throw new RepositoryError(422,"decision_resolution_invalid","Scope only applies to contact Decisions.");
    if (decision.contact && answer.outcome === "approved") {
      this.validateContact(principalId,decision.requested_by_instance_id,decision.room_id!,decision.contact);
      const state=this.contactState(principalId);
      const rule=answer.scope==="source_principal_action"?grantContactRule(state,principalId,decision.contact.source_principal_id,decision.contact.action,this.timestamp()):undefined;
      if(decision.contact.action==="mention"&&this.contactPrincipals.includes(principalId))enqueueContactWake(state,{roomId:decision.room_id!,targetId:decision.contact.target_instance_id,messageId:decision.contact.source_message_id!,sourceId:decision.requested_by_instance_id,sourcePrincipalId:decision.contact.source_principal_id,authorization:"allow_once",decisionId:decision.id,expiresAt:decision.contact.expires_at,now:this.timestamp()});
      void rule;
    }
    if ((decision.mode === "text") !== (answer.outcome === "answered")) {
      throw new RepositoryError(422, "decision_resolution_invalid", "Resolution does not match the Decision mode.");
    }
    let membership: MembershipRecord | null = null;
    if (answer.outcome === "approved" && decision.requested_for_instance_id && decision.room_id && decision.contact?.action !== "mention") {
      const room = this.rooms.get(decision.room_id);
      if (!room || room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      // A request can outlive the Instance it was for. An ended one is not seated; the request can still be denied.
      const target = this.instances.get(decision.requested_for_instance_id);
      if (!target || target.status === "ended" || target.status === "revoked") {
        throw new RepositoryError(409, "instance_offline", "The Instance this request was for has ended.");
      }
      membership = this.seat(room, decision.requested_for_instance_id, "accepted", decision.requested_by_instance_id, principalId);
    }
    if (answer.outcome === "denied") this.declineInvite(decision, answer.block === true);
    if(decision.contact&&answer.outcome==="approved")decision.contact.approval_scope=answer.scope??"once";
    const released = decision.contact?.action === "mention" && answer.outcome === "approved" && !this.contactPrincipals.includes(principalId);
    if(decision.contact)decision.contact.effect_state=answer.outcome==="denied"?"denied":decision.contact.action==="mention"&&!released?"queued":"approved";
    if (released) this.releaseMention(decision);
    decision.status = answer.outcome;
    decision.answer = answer.outcome === "answered" ? answer.answer : null;
    decision.resolved_at = this.timestamp();
    return {
      decision: this.decisionOverview(decision),
      membership: membership ? this.projectMembership(membership, principalId) : null,
    };
  }

  private decisionOverview(record: DecisionRecord): DecisionOverview {
    const asker = this.instances.get(record.requested_by_instance_id);
    const invite = this.personInvites.get(record.id);
    return { decision: this.projectDecision(record), requested_by_principal_id: asker?.principal_id ?? record.principal_id, priority_source: record.priority_source ?? "pending", priority_evaluation: priorityEvaluationMetadata(record.priority_source ?? "pending", this.priorityEvaluations.get(record.id)), ...(invite ? { person_invite: { stranger: invite.stranger } } : {}) };
  }

  async networkForPrincipal(principalId: PrincipalId, roomId?: RoomId): Promise<NetworkView> {
    const principal = this.principals.get(principalId);
    if (!principal) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    const visibleRoomIds = new Set(
      [...this.rooms.values()]
        .filter((room) => room.principal_id === principalId)
        .map((room) => room.id),
    );
    for (const membership of this.memberships.values()) {
      if (membership.state === "active" && this.instances.get(membership.instance_id)?.principal_id === principalId) {
        visibleRoomIds.add(membership.room_id);
      }
    }
    if (roomId !== undefined) {
      this.roomVisibleTo(principalId, roomId);
      visibleRoomIds.clear();
      visibleRoomIds.add(roomId);
    }
    const seats = [...this.memberships.values()].filter(
      (membership) => membership.state === "active" && visibleRoomIds.has(membership.room_id),
    );
    const coMemberIds = new Set(seats.map((seat) => seat.instance_id));
    const connectedIds = new Set<PrincipalId>();
    for (const seat of seats) {
      const owner = this.instances.get(seat.instance_id)?.principal_id;
      if (owner && owner !== principalId) connectedIds.add(owner);
    }
    const visiblePrincipalIds = new Set([principalId, ...connectedIds]);
    const agents = [...this.agents.values()]
      .filter((agent) => visiblePrincipalIds.has(agent.principal_id) && (roomId === undefined || [...this.instances.values()].some((instance) => coMemberIds.has(instance.id) && instance.agent_id === agent.id)))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const instances = [...this.instances.values()]
      // An ended or revoked Instance is history, not a node on the graph.
      .filter((instance) => instance.status !== "ended" && instance.status !== "revoked")
      .filter((instance) => (roomId === undefined && instance.principal_id === principalId) || coMemberIds.has(instance.id))
      .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))
      .map((instance) => this.projectInstance(instance));
    const byRoom = new Map<RoomId, InstanceId[]>();
    for (const seat of seats) byRoom.set(seat.room_id, [...(byRoom.get(seat.room_id) ?? []), seat.instance_id]);
    return {
      activity: { sampled_at: this.now().toISOString(), replies: networkReplies([...visibleRoomIds].flatMap(id => this.messages.get(id) ?? []), byRoom, (room, seat) => {
        const kept = this.subscriptions.get(`${seat}|${room}`);
        return kept ? {
          delivered_through: kept.delivered,
          acked_through: kept.acked,
          moved_at: kept.movedAt,
          active_through: kept.activeThrough,
          active_expires_at: kept.activeExpiresAt,
        } : undefined;
      }, this.now()) },
      principal: { ...principal },
      agents,
      instances,
      connected_principals: [...connectedIds]
        .map((id) => this.principals.get(id))
        .filter((candidate): candidate is Principal => candidate !== undefined)
        .map((candidate) => ({ ...candidate })),
      edges: sharedRoomsEdges([...byRoom.values()]),
      mention_edges: mentionEdges([...visibleRoomIds].flatMap((id) => this.messages.get(id) ?? []), new Set(instances.map((instance) => instance.id))),
      // Pictures are stored only at sign-up through a social provider, which
      // the in-memory store never sees.
      avatars: {},
    };
  }

  async seatsOf(instanceIds: InstanceId[]): Promise<{ seats: SeatOverview[] }> {
    const seats: SeatOverview[] = [];
    for (const id of instanceIds) {
      const instance = this.instances.get(id);
      if (!instance) continue;
      const rooms = [...this.memberships.values()]
        .filter((membership) => membership.instance_id === id)
        .map((membership) => this.rooms.get(membership.room_id))
        .filter((room): room is RoomRecord => room !== undefined)
        .map((room) => ({ id: room.id, name: room.name }));
      seats.push({ instance: this.projectInstance(instance), rooms });
    }
    return { seats };
  }

  async authenticateApiKey(token: string): Promise<PrincipalAuth | null> {
    const candidate = digestSecret(token);
    for (const record of this.apiKeysByDigest.values()) {
      if (record.revokedAt === null && secureDigestEquals(candidate, record.digest)) {
        return {
          kind: "api_key",
          principalId: record.principalId,
          actorId: record.id,
        };
      }
    }
    return null;
  }

  async authenticateInstance(token: string): Promise<InstanceAuth | null> {
    const candidate = digestSecret(token);
    let instanceId: InstanceId | undefined;
    for (const [digest, id] of this.instanceIdsByDigest) {
      if (secureDigestEquals(candidate, digest)) {
        instanceId = id;
        break;
      }
    }
    if (!instanceId) return null;

    const record = this.instances.get(instanceId);
    if (!record) return null;
    if (record.status === "ended" || record.status === "revoked") return null;
    // Any authenticated request is presence, for every Instance.
    const now = this.now();
    record.last_seen_at = now.toISOString();
    record.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    if (record.issuedByKeyId === null) {
      // An anonymous Principal's Instance: no key to check.
      return {
        kind: "instance",
        principalId: record.principal_id,
        instanceId: record.id,
        actorId: record.id,
        anonymous: true,
      };
    }
    const issuingKey = [...this.apiKeysByDigest.values()].find(
      (apiKey) => apiKey.id === record.issuedByKeyId,
    );
    const projected = this.projectInstance(record);
    if (
      !issuingKey ||
      issuingKey.revokedAt !== null ||
      projected.status === "ended" ||
      projected.status === "revoked" ||
      projected.status === "expired"
    ) {
      return null;
    }
    return {
      kind: "instance",
      principalId: record.principal_id,
      instanceId: record.id,
      actorId: record.id,
      anonymous: false,
    };
  }

  async createAgent(
    auth: PrincipalAuth,
    input: CreateAgentRequest,
  ): Promise<{ agent: Agent; created: boolean }> {
    const owned = [...this.agents.values()].filter(
      (agent) => agent.principal_id === auth.principalId,
    );
    const existing = owned.find((agent) => agent.handle === input.handle);
    if (existing) return { agent: { ...existing }, created: false };
    if (owned.length >= MAX_AGENTS_PER_PRINCIPAL) {
      throw new RepositoryError(409, "agent_limit_reached", "Agent limit reached.");
    }
    const agent: Agent = {
      id: generatePublicId("a"),
      principal_id: auth.principalId,
      handle: input.handle,
      display_name: input.display_name ?? null,
      description: input.description ?? null,
      created_at: this.timestamp(),
    };
    this.agents.set(agent.id, agent);
    return { agent: { ...agent }, created: true };
  }

  async listAgents(auth: PrincipalAuth): Promise<{ items: Agent[] }> {
    const items = [...this.agents.values()]
      .filter((agent) => agent.principal_id === auth.principalId)
      .sort((a, b) => a.handle.localeCompare(b.handle) || a.id.localeCompare(b.id))
      .map((agent) => ({ ...agent }));
    return { items };
  }

  async getAgent(auth: PrincipalAuth, agentId: AgentId): Promise<{ agent: Agent }> {
    return { agent: { ...this.ownedAgent(auth, agentId) } };
  }

  async startInstance(
    auth: PrincipalAuth,
    input: StartInstanceRequest,
  ): Promise<{ instance: Instance; token: string; heartbeat_after_seconds: 30; created: boolean }> {
    if (input.agent_id) this.ownedAgent(auth, input.agent_id);

    const now = this.now();
    const token = generateSecret("sni");
    const tokenDigest = digestSecret(token);
    const leaseExpiresAt = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();

    // One session, one live Instance: a re-registration of the same runtime
    // session hands back the existing row with a fresh token.
    const existing = input.local_instance_key
      ? [...this.instances.values()].find(
          (candidate) =>
            candidate.principal_id === auth.principalId &&
            candidate.localInstanceKey === input.local_instance_key &&
            candidate.status !== "ended" &&
            candidate.status !== "revoked",
        )
      : undefined;
    if (existing) {
      this.instanceIdsByDigest.delete(existing.tokenDigest);
      existing.tokenDigest = tokenDigest;
      existing.issuedByKeyId = auth.actorId;
      existing.runtime_kind = input.runtime_kind;
      existing.cli_version = input.cli_version;
      if (input.agent_id !== undefined) existing.agent_id = input.agent_id;
      if (input.runtime_metadata !== undefined) existing.runtime_metadata = { ...input.runtime_metadata };
      existing.last_seen_at = now.toISOString();
      existing.lease_expires_at = leaseExpiresAt;
      existing.token_expires_at = null;
      existing.status = "online";
      if (input.reach !== undefined) existing.reach = input.reach;
      this.instanceIdsByDigest.set(tokenDigest, existing.id);
      return {
        instance: this.projectInstance(existing),
        token,
        heartbeat_after_seconds: 30,
        created: false,
      };
    }

    const instance: InstanceRecord = {
      id: generatePublicId("i"),
      principal_id: auth.principalId,
      agent_id: input.agent_id ?? null,
      runtime_kind: input.runtime_kind,
      cli_version: input.cli_version,
      runtime_metadata: { ...(input.runtime_metadata ?? {}) },
      status: "online",
      started_at: now.toISOString(),
      last_seen_at: now.toISOString(),
      lease_expires_at: leaseExpiresAt,
      token_expires_at: null,
      ended_at: null,
      revoked_at: null,
      display_name: null,
      reach: input.reach ?? this.principals.get(auth.principalId)?.default_reach ?? "public",
      tokenDigest,
      issuedByKeyId: auth.actorId,
      admittedByInviteId: null,
      localInstanceKey: input.local_instance_key ?? null,
    };
    this.instances.set(instance.id, instance);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    return {
      instance: this.projectInstance(instance),
      token,
      heartbeat_after_seconds: 30,
      created: true,
    };
  }

  async getCurrentInstance(auth: InstanceAuth) {
    const record = this.instanceRecord(auth);
    const principal = this.principals.get(auth.principalId);
    if (!principal) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    const agent = record.agent_id ? this.agents.get(record.agent_id) : undefined;
    return {
      principal: { ...principal },
      agent: agent ? { ...agent } : null,
      instance: this.projectInstance(record),
    };
  }

  async heartbeat(auth: InstanceAuth) {
    const record = this.instanceRecord(auth);
    if (record.status === "ended" || record.status === "revoked") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    const now = this.now();
    record.last_seen_at = now.toISOString();
    record.lease_expires_at = new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString();
    record.status = "online";
    return {
      instance: this.projectInstance(record),
      heartbeat_after_seconds: 30 as const,
    };
  }

  async createRoom(
    auth: InstanceAuth,
    input: CreateRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember; admissions: Admission[] }> {
    const creator = this.requireOnline(auth);
    const createdAt = this.timestamp();
    const room: RoomRecord = {
      id: generatePublicId("rom"),
      principal_id: auth.principalId,
      name: input.name,
      type: input.type ?? "board",
      protocol_version: input.type === "compiled" ? PROTOCOL_V1 : null,
      description: input.description ?? null,
      state: "open",
      creator_instance_id: auth.instanceId,
      created_at: createdAt,
      closed_at: null,
      shared_at: null,
      kind: input.kind ?? "standard",
      shareToken: null,
      goal: null,
      nextSequence: 1,
    };
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: auth.instanceId,
      state: "active",
      joined_at: createdAt,
      left_at: null,
      admitted_by: "room_id",
      invite_id: null,
      added_by_instance_id: null,
    };
    this.rooms.set(room.id, room);
    this.memberships.set(membershipKey(room.id, auth.instanceId), membership);
    this.seatTaken(room, auth.instanceId, auth.principalId);
    this.messages.set(room.id, []);
    if (room.type === "compiled") {
      const service: InstanceRecord = { ...creator, id: generatePublicId("i"), agent_id: null,
        runtime_kind: HOOK_RUNTIME_KIND, cli_version: "service", runtime_metadata: { surface: "compiled", runtime_source: "service" },
        display_name: "compiled", reach: "private", tokenDigest: digestSecret(generateSecret("sni")), localInstanceKey: null };
      this.instances.set(service.id, service);
      this.memberships.set(membershipKey(room.id, service.id), { ...membership, instance_id: service.id });
      this.compiledSeats.set(room.id, service.id);
      this.acts.set(room.id, []);
    }
    const admissions = (input.with ?? []).map((instanceId) => this.admit(creator, room, instanceId));
    return { room: this.projectRoom(room), membership: this.projectMembership(membership, auth.principalId), admissions };
  }

  async describeInvite(token: string): Promise<InviteDescription> {
    const candidate = digestSecret(token);
    const invite = [...this.invites.values()].find((record) => secureDigestEquals(candidate, record.tokenDigest));
    if (!invite) throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    if (invite.revoked_at !== null) throw new RepositoryError(410, "invite_revoked", "Room invite was revoked.");
    if (invite.expires_at !== null && Date.parse(invite.expires_at) <= this.now().getTime()) {
      throw new RepositoryError(410, "invite_expired", "Room invite has expired.");
    }
    const room = this.roomById(invite.room_id);
    return {
      room: { id: room.id, name: room.name, state: room.state },
      invite: { id: invite.id, expires_at: invite.expires_at, uses: invite.uses },
    };
  }

  async listRooms(auth: InstanceAuth): Promise<{ items: Room[] }> {
    this.instanceRecord(auth);
    const items = [...this.memberships.values()]
      .filter((membership) => membership.instance_id === auth.instanceId && membership.state === "active")
      .map((membership) => this.rooms.get(membership.room_id))
      .filter((room): room is RoomRecord => room !== undefined)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((room) => this.projectRoom(room));
    return { items };
  }

  async addRoomMembers(
    auth: InstanceAuth,
    roomId: RoomId,
    input: AddRoomMembersRequest,
  ): Promise<{ admissions: Admission[] }> {
    const requester = this.requireOnline(auth);
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    return { admissions: input.with.map((instanceId) => this.admit(requester, room, instanceId)) };
  }

  async updateInstance(auth: InstanceAuth, input: UpdateInstanceRequest): Promise<{ instance: Instance }> {
    const record = this.instanceRecord(auth);
    if (input.reach !== undefined) record.reach = input.reach;
    return { instance: this.projectInstance(record) };
  }

  async endInstance(auth: InstanceAuth): Promise<{ instance: Instance }> {
    const record = this.instanceRecord(auth);
    if (record.status === "ended" || record.status === "revoked") {
      return { instance: this.projectInstance(record) };
    }
    const now = this.timestamp();
    for (const membership of this.memberships.values()) {
      if (membership.instance_id === record.id && membership.state === "active") {
        membership.state = "left";
        membership.left_at = now;
        this.endCloudRoomGrant(membership);
      }
    }
    record.status = "ended";
    record.ended_at = now;
    return { instance: this.projectInstance(record) };
  }

  async listDecisions(
    auth: InstanceAuth,
    filter: { status?: DecisionStatus },
  ): Promise<{ decisions: Decision[] }> {
    this.instanceRecord(auth);
    const decisions = [...this.decisions.values()]
      .filter(
        (decision) =>
          decision.requested_for_instance_id === auth.instanceId &&
          (filter.status === undefined || decision.status === filter.status),
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
      .map((decision) => this.projectDecision(decision));
    return { decisions };
  }

  async resolveDecision(
    auth: InstanceAuth,
    decisionId: DecisionId,
    input: ResolveDecisionRequest,
  ): Promise<{ decision: Decision; membership: RoomMember | null }> {
    this.instanceRecord(auth);
    const decision = this.decisions.get(decisionId);
    // A Decision that is not addressed to this Instance does not exist for it.
    if (!decision || decision.requested_for_instance_id !== auth.instanceId) {
      throw new RepositoryError(404, "decision_not_found", "Decision was not found.");
    }
    if(decision.contact || (decision.requested_for_instance_id && decision.room_id && this.contactPrincipals.includes(decision.principal_id) && this.instances.get(decision.requested_by_instance_id)?.principal_id !== decision.principal_id))throw new RepositoryError(403,"permission_denied","Only the human owner can resolve contact Decisions.");
    if (decision.status !== "pending") {
      throw new RepositoryError(409, "decision_already_resolved", "Decision was already resolved.");
    }
    let membership: MembershipRecord | null = null;
    if (input.resolution === "approved") {
      const room = decision.room_id ? this.rooms.get(decision.room_id) : undefined;
      if (!room || room.state === "closed") {
        throw new RepositoryError(409, "room_closed", "Room is closed.");
      }
      // The Instance asked for accepts for itself, so the seat is its own Principal's word.
      membership = this.seat(room, auth.instanceId, "accepted", decision.requested_by_instance_id, auth.principalId);
    }
    decision.status = input.resolution;
    decision.resolved_at = this.timestamp();
    return {
      decision: this.projectDecision(decision),
      membership: membership ? this.projectMembership(membership, auth.principalId) : null,
    };
  }

  /**
   * One Instance named in `with` (decision 2026-09-06 reach, §3): seated at
   * once when public or the requester's own, asked through a Decision when
   * private, refused otherwise. "refused" never says why, so ids cannot be
   * told apart by asking.
   */
  private admit(requester: InstanceRecord, room: RoomRecord, targetId: InstanceId): Admission {
    const refused: Admission = { instance_id: targetId, status: "refused", decision_id: null };
    const target = this.instances.get(targetId);
    if (!target || target.status === "ended" || target.status === "revoked") return refused;
    const existing = this.memberships.get(membershipKey(room.id, target.id));
    if (existing?.state === "active") return { instance_id: targetId, status: "member", decision_id: null };
    // A direct Room seats its owner's Instances and nobody else's, however reachable they are.
    if (room.kind === "direct" && target.principal_id !== room.principal_id) return refused;
    if(target.principal_id!==requester.principal_id&&this.contactPrincipals.includes(target.principal_id)) {
      const previous=[...this.decisions.values()].find(d=>d.room_id===room.id&&d.requested_for_instance_id===target.id&&(!d.contact||d.contact.action==="invite")&&(d.contact?.source_principal_id??this.instances.get(d.requested_by_instance_id)?.principal_id)===requester.principal_id&&(d.status==="denied"||d.status==="pending"&&(!d.contact||d.contact.expires_at>this.timestamp())));
      if(previous)return {instance_id:targetId,status:previous.status==="denied"?"refused":"pending",decision_id:previous.id};
    }
    if (target.principal_id !== requester.principal_id && this.contactPrincipals.includes(target.principal_id) && !contactRule(this.contactState(target.principal_id),requester.principal_id,"invite")) {
      const decision=this.contactDecision(requester,room,target,metadata("invite",requester.principal_id,target.id,null,this.timestamp()));return {instance_id:targetId,status:decision.status==="denied"?"refused":"pending",decision_id:decision.id};
    }
    if (target.principal_id === requester.principal_id || target.reach === "public" || (this.contactPrincipals.includes(target.principal_id) && contactRule(this.contactState(target.principal_id),requester.principal_id,"invite"))) {
      if(this.contactPrincipals.includes(target.principal_id)&&target.principal_id!==requester.principal_id)this.validateContact(target.principal_id,requester.id,room.id,metadata("invite",requester.principal_id,target.id,null,this.timestamp()));
      this.seat(room, target.id, "added", requester.id, requester.principal_id);
      return { instance_id: targetId, status: "member", decision_id: null };
    }
    const pending = [...this.decisions.values()].find(
      (decision) =>
        decision.room_id === room.id &&
        decision.requested_for_instance_id === target.id &&
        decision.status === "pending",
    );
    if (pending) return { instance_id: targetId, status: "pending", decision_id: pending.id };
    const decision: DecisionRecord = {
      id: generatePublicId("dec"),
      priority: "p2",
      principal_id: target.principal_id,
      mode: "approval",
      title: `${requester.id} wants to add ${target.id} to Room "${room.name}"`,
      description: `Instance ${requester.id} of Principal ${requester.principal_id} asked to seat ${target.id} in Room ${room.id} ("${room.name}"). Approve to take the seat; deny to refuse.`,
      status: "pending",
      requested_by_instance_id: requester.id,
      requested_for_instance_id: target.id,
      room_id: room.id,
      answer: null,
      created_at: this.timestamp(),
      resolved_at: null,
    };
    this.insertDecision(decision);
    return { instance_id: targetId, status: "pending", decision_id: decision.id };
  }

  /** Writes an active membership, reviving a left one. */
  private seat(
    room: RoomRecord,
    instanceId: InstanceId,
    admittedBy: "added" | "accepted",
    addedBy: InstanceId,
    byPrincipalId: PrincipalId,
  ): MembershipRecord {
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: instanceId,
      state: "active",
      joined_at: this.timestamp(),
      left_at: null,
      admitted_by: admittedBy,
      invite_id: null,
      added_by_instance_id: addedBy,
    };
    this.memberships.set(membershipKey(room.id, instanceId), membership);
    this.seatTaken(room, instanceId, byPrincipalId);
    return membership;
  }

  /** The observer told of a seat written, at once, with the cloud Room grant it may call for queued first: nothing here waits for a commit. A throw is said and goes no further. */
  private seatTaken(room: Pick<RoomRecord, "id" | "kind">, instanceId: InstanceId, byPrincipalId: PrincipalId): void {
    const instance = this.instances.get(instanceId);
    if (!instance) return;
    const seat: SeatTaken = { room_id: room.id, room_kind: room.kind, instance_id: instanceId, principal_id: instance.principal_id, by_principal_id: byPrincipalId };
    this.queueCloudRoomGrant(seat, instance, this.memberships.get(membershipKey(room.id, instanceId))!.joined_at);
    if (!this.seated) return;
    const said = (error: unknown) => console.error(`the seat of ${seat.instance_id} in Room ${seat.room_id} was taken but not told:`, error instanceof Error ? error.message : error);
    try {
      const told = this.seated(seat);
      if (told) told.catch(said);
    } catch (error) {
      said(error);
    }
  }

  /** As the Postgres repository's: the promise to grant, kept with the seat and bound to this seating; a seat taken again asks again, unless an attempt is out on the row or a revoke is not yet through, which is settled first and asks afresh. */
  private queueCloudRoomGrant(seat: SeatTaken, instance: InstanceRecord, seatedAt: string): void {
    if (seat.room_kind === "direct" || seat.by_principal_id !== seat.principal_id) return;
    const active = instance.status !== "ended" && instance.status !== "revoked";
    const decision = decideSeatGrant(seat, { machine: cloudMachineOf({ runtime_kind: instance.runtime_kind, runtime_metadata: instance.runtime_metadata, active }), auth_user_id: this.accountOf(seat.principal_id) ?? null });
    if (!decision.grant) return;
    const key = membershipKey(seat.room_id, seat.instance_id);
    const held = this.cloudRoomGrants.get(key);
    if (held?.state === "processing") {
      Object.assign(held, { machine: decision.machine, auth_user_id: decision.auth_user_id, seated_at: seatedAt, updatedAt: this.timestamp() });
      return;
    }
    if (held?.intent === "revoke" && held.state !== "revoked") {
      Object.assign(held, { machine: decision.machine, auth_user_id: decision.auth_user_id, seated_at: seatedAt, state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, lastRefusal: null, updatedAt: this.timestamp() });
      return;
    }
    this.cloudRoomGrants.set(key, {
      room_id: seat.room_id, instance_id: seat.instance_id, machine: decision.machine, auth_user_id: decision.auth_user_id, seated_at: seatedAt, intent: "grant", grant_id: null, agent_handle: null,
      state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, lastRefusal: null, lostAt: null, grantedAt: null,
      createdAt: held?.createdAt ?? this.timestamp(), updatedAt: this.timestamp(),
    });
  }

  /** As the Postgres repository's: the seat gone, a grant through becomes the intent to revoke it, told to the observer at once; a promise not through goes with the seat, an attempt in flight settling its own row. */
  private endCloudRoomGrant(seat: CloudRoomGrantSeat): void {
    const row = this.cloudRoomGrants.get(membershipKey(seat.room_id, seat.instance_id));
    if (!row || row.state === "processing") return;
    if (row.state === "granted" && row.grant_id && row.agent_handle) {
      Object.assign(row, { intent: "revoke", state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, lastRefusal: null, lostAt: null, grantedAt: null, updatedAt: this.timestamp() });
      this.tellSeatDue(row);
    } else if (row.intent === "grant" && row.state !== "superseded") {
      // A grant the console never named is only the kernel's sweep to take back.
      Object.assign(row, { state: "superseded", grantedAt: null, updatedAt: this.timestamp() });
    }
  }

  private tellSeatDue(seat: CloudRoomGrantSeat): void {
    if (!this.unseated) return;
    const said = (error: unknown) => console.error(`the grant row of ${seat.instance_id} in Room ${seat.room_id} is due but was not told:`, error instanceof Error ? error.message : error);
    try {
      const told = this.unseated({ room_id: seat.room_id, instance_id: seat.instance_id });
      if (told) told.catch(said);
    } catch (error) {
      said(error);
    }
  }

  /** The seat gone, the promise not through is superseded (as `endCloudRoomGrant`, for a row already claimed). */
  private voidCloudRoomGrant(seat: CloudRoomGrantSeat): void {
    const row = this.cloudRoomGrants.get(membershipKey(seat.room_id, seat.instance_id));
    if (row && row.intent === "grant" && row.state !== "granted" && row.state !== "superseded") Object.assign(row, { state: "superseded", leaseToken: null, leaseExpiresAt: null, updatedAt: this.timestamp() });
  }

  /** Whether the seating a promise was made for is the one in the Room. */
  private cloudRoomGrantStands(row: CloudRoomGrantRecord): boolean {
    const instance = this.instances.get(row.instance_id);
    return seatStillHeld(row, this.memberships.get(membershipKey(row.room_id, row.instance_id))) && !!instance && instance.status !== "ended" && instance.status !== "revoked";
  }

  async claimCloudRoomGrant(options: { leaseMs?: number; seat?: CloudRoomGrantSeat } = {}): Promise<CloudRoomGrantClaim | null> {
    const leaseMs = cloudRoomGrantLeaseMs(options.leaseMs), now = this.now().getTime();
    const due = [...this.cloudRoomGrants.values()]
      .filter((row) => (row.state === "pending" && row.nextAttemptAt <= now) || (row.state === "processing" && row.leaseExpiresAt! <= now))
      .filter((row) => !options.seat || (row.room_id === options.seat.room_id && row.instance_id === options.seat.instance_id))
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.room_id.localeCompare(b.room_id) || a.instance_id.localeCompare(b.instance_id))
      .slice(0, 20);
    for (const row of due) {
      if (row.intent === "grant" && !this.cloudRoomGrantStands(row)) {
        this.voidCloudRoomGrant(row);
        continue;
      }
      // A revoke whose lease ran out went out without its end learned: the row is marked lost until the console says where the grant stands.
      if (row.intent === "revoke" && row.state === "processing") row.lostAt ??= this.timestamp();
      if (row.attempts >= CLOUD_ROOM_GRANT_MAX_ATTEMPTS) {
        // A lease that ran out on the last attempt: nothing is left to try. A revoke's seat taken again meanwhile is owed a
        // grant, but not one asked here: that last DELETE may still land, after any POST. The row stays a failed revoke.
        Object.assign(row, { state: "failed", leaseToken: null, leaseExpiresAt: null, lastRefusal: row.lastRefusal ?? "The last attempt did not finish.", updatedAt: this.timestamp() });
        if (row.intent === "grant") await this.sayCloudRoomGrantNotice(row, "gave_up", row.lastRefusal);
        else if (this.cloudRoomGrantStands(row)) await this.sayCloudRoomGrantNotice(row, "unresolved", row.lastRefusal);
        continue;
      }
      const leaseToken = randomUUID();
      Object.assign(row, { state: "processing", attempts: row.attempts + 1, leaseToken, leaseExpiresAt: now + leaseMs, updatedAt: this.timestamp() });
      const claimed = { room_id: row.room_id, instance_id: row.instance_id, machine: row.machine, auth_user_id: row.auth_user_id, leaseToken, attempts: row.attempts };
      return row.intent === "revoke" ? { ...claimed, intent: "revoke" as const, grant_id: row.grant_id!, agent_handle: row.agent_handle! } : { ...claimed, intent: "grant" as const };
    }
    return null;
  }

  /** The claim's row while the lease is held, and whether the seating it is bound to stands: the one a grant was promised for, or one the owner took again while a revoke was out. */
  private heldCloudRoomGrant(seat: CloudRoomGrantSeat, leaseToken: string): { row: CloudRoomGrantRecord; standing: boolean } | null {
    const row = this.cloudRoomGrants.get(membershipKey(seat.room_id, seat.instance_id));
    if (!row || row.state !== "processing" || row.leaseToken !== leaseToken || row.leaseExpiresAt! <= this.now().getTime()) return null;
    return { row, standing: seatStillHeld(row, this.memberships.get(membershipKey(row.room_id, row.instance_id))) };
  }

  /** As the Postgres repository's: a revoke settled with the seat taken again by the owner meanwhile becomes the grant that seating is owed, due at once and told to the observer. */
  private askCloudRoomGrantAfresh(row: CloudRoomGrantRecord): void {
    Object.assign(row, { intent: "grant", grant_id: null, agent_handle: null, state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, lastRefusal: null, lostAt: null, grantedAt: null, updatedAt: this.timestamp() });
    this.tellSeatDue(row);
  }

  async completeCloudRoomGrant(seat: CloudRoomGrantSeat, leaseToken: string, held: CloudRoomGrantHeld | null = null): Promise<boolean> {
    const locked = this.heldCloudRoomGrant(seat, leaseToken);
    if (!locked) return false;
    const { row, standing } = locked;
    if (row.intent === "revoke") {
      // The console's word on the grant itself, revoked or gone: whatever was lost on the way is answered too.
      if (standing) this.askCloudRoomGrantAfresh(row);
      else Object.assign(row, { state: "revoked", leaseToken: null, leaseExpiresAt: null, lastRefusal: null, lostAt: null, updatedAt: this.timestamp() });
      return true;
    }
    if (!standing) {
      // The grant landed on a seat gone meanwhile: to be taken back by the name the console gave it; unnamed, the kernel's own sweep is all there is.
      if (held) {
        Object.assign(row, { intent: "revoke", grant_id: held.grant_id, agent_handle: held.agent_handle, state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, lastRefusal: null, lostAt: null, updatedAt: this.timestamp() });
        this.tellSeatDue(row);
      } else this.voidCloudRoomGrant(row);
      return false;
    }
    Object.assign(row, { state: "granted", grant_id: held?.grant_id ?? null, agent_handle: held?.agent_handle ?? null, leaseToken: null, leaseExpiresAt: null, lastRefusal: null, grantedAt: this.timestamp(), updatedAt: this.timestamp() });
    if (row.attempts > 1) await this.sayCloudRoomGrantNotice(row, "through", null);
    return true;
  }

  async failCloudRoomGrant(seat: CloudRoomGrantSeat, leaseToken: string, refusal: string, outcome: CloudRoomGrantFailure = "refused"): Promise<boolean> {
    const locked = this.heldCloudRoomGrant(seat, leaseToken);
    if (!locked) return false;
    const { row, standing } = locked;
    // A revoke whose end is unknown marks its row lost, and the mark outlives the attempt: a refusal is definitive only when
    // no DELETE of this revoke is out there unanswered, since one that is may yet land after any grant asked now.
    if (row.intent === "revoke" && outcome === "unknown") row.lostAt ??= this.timestamp();
    const definite = outcome === "refused" && row.lostAt === null;
    if (row.intent === "revoke" && standing && definite) {
      // The revoke refused, it did nothing and is over: the grant is wanted after all, and the console's answer to it,
      // granted or already_granted, is right either way. One whose end is unknown, or refused after one was, is tried
      // again instead until the console says where the grant stands; with the attempts spent it stays failed, as a revoke.
      this.askCloudRoomGrantAfresh(row);
      return true;
    }
    if (row.intent === "grant" && !standing) {
      this.voidCloudRoomGrant(row);
      return false;
    }
    const said = cloudRoomGrantRefusal(refusal);
    if (row.attempts >= CLOUD_ROOM_GRANT_MAX_ATTEMPTS) Object.assign(row, { state: "failed", leaseToken: null, leaseExpiresAt: null, lastRefusal: said, updatedAt: this.timestamp() });
    else Object.assign(row, { state: "pending", leaseToken: null, leaseExpiresAt: null, nextAttemptAt: this.now().getTime() + cloudRoomGrantRetryMs(row.attempts), lastRefusal: said, updatedAt: this.timestamp() });
    if (row.intent === "revoke") {
      if (standing && !definite && row.attempts >= CLOUD_ROOM_GRANT_MAX_ATTEMPTS) await this.sayCloudRoomGrantNotice(row, "unresolved", said);
      return true;
    }
    if (row.attempts >= CLOUD_ROOM_GRANT_MAX_ATTEMPTS) await this.sayCloudRoomGrantNotice(row, "gave_up", said);
    else if (row.attempts === 1) await this.sayCloudRoomGrantNotice(row, "asking", said);
    return true;
  }

  /** As the Postgres repository's: the Room told by its owner's clock seat, while it is open; a notice that cannot be said changes nothing. */
  private async sayCloudRoomGrantNotice(seat: CloudRoomGrantSeat, kind: CloudRoomGrantNoticeKind, refusal: string | null): Promise<void> {
    try {
      const room = this.rooms.get(seat.room_id);
      if (!room || room.state !== "open") return;
      const agent = this.instances.get(seat.instance_id);
      const handle = typeof agent?.runtime_metadata.handle === "string" ? agent.runtime_metadata.handle : (agent?.display_name ?? null);
      const clock = await this.clockSeat(room);
      await this.postMessage(clock, room.id, { content: cloudRoomGrantNotice(kind, { id: seat.instance_id, handle }, refusal), addressing: "nobody" });
    } catch (error) {
      console.error(`Room ${seat.room_id} was not told of its cloud grant (${kind}):`, error instanceof Error ? error.message : error);
    }
  }

  async cloudRoomGrantsForAccount(authUserId: string): Promise<CloudRoomGrantView[]> {
    return [...this.cloudRoomGrants.values()]
      .filter((row) => row.auth_user_id === authUserId && (row.state === "pending" || row.state === "processing" || row.state === "failed"))
      .filter((row) => seatStillHeld(row, this.memberships.get(membershipKey(row.room_id, row.instance_id))))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.room_id.localeCompare(b.room_id) || a.instance_id.localeCompare(b.instance_id))
      .map((row) => ({
        room_id: row.room_id, instance_id: row.instance_id, room_name: this.rooms.get(row.room_id)?.name ?? "", machine: row.machine,
        intent: row.intent, state: row.state as CloudRoomGrantView["state"], attempts: row.attempts, last_refusal: row.lastRefusal, since: row.createdAt,
      }));
  }

  private projectDecision(record: DecisionRecord): Decision {
    const { priority_source: _source, ...decision } = record;
    return { ...decision, requested_by_agent_id: this.tagOf(record.requested_by_instance_id) };
  }

  private insertDecision(decision: DecisionRecord): void {
    decision.priority_source = "pending";
    this.decisions.set(decision.id, decision);
    this.priorityEvaluations.set(decision.id, { state: "pending", attempts: 0, nextAttemptAt: this.now().getTime(), leaseToken: null, leaseExpiresAt: null, provider: null, model: null, rubricVersion: null, reason: null, confidence: null, assessedAt: null, inputDigest: null, failureCategory: null, createdAt: this.timestamp(), updatedAt: this.timestamp() });
  }

  async claimDecisionPriorityEvaluation(options: { leaseMs?: number } = {}): Promise<DecisionPriorityEvaluationClaim | null> {
    const leaseMs = priorityLeaseMs(options.leaseMs), now = this.now().getTime();
    // A single call inspects a bounded batch, including leases abandoned on their last attempt.
    const due = [...this.priorityEvaluations.entries()].filter(([, row]) => row.state === "pending" && row.nextAttemptAt <= now || row.state === "processing" && row.leaseExpiresAt! <= now).sort((a, b) => a[1].nextAttemptAt - b[1].nextAttemptAt || a[0].localeCompare(b[0])).slice(0, 20);
    for (const [id, row] of due) {
      const decision = this.decisions.get(id)!;
      if (decision.priority_source === "owner") {
        Object.assign(row, { state: "superseded", leaseToken: null, leaseExpiresAt: null, updatedAt: this.timestamp() });
        continue;
      }
      if (row.attempts >= PRIORITY_MAX_ATTEMPTS) {
        this.priorityFallback(decision, row, "timeout");
        continue;
      }
      const leaseToken = randomUUID();
      Object.assign(row, { state: "processing", attempts: row.attempts + 1, leaseToken, leaseExpiresAt: now + leaseMs, updatedAt: this.timestamp() });
      return { decision: this.projectDecision(decision), leaseToken, attempts: row.attempts };
    }
    return null;
  }

  async completeDecisionPriorityEvaluation(id: DecisionId, leaseToken: string, assessment: DecisionPriorityAssessment): Promise<boolean> {
    validatePriorityAssessment(assessment);
    const row = this.priorityEvaluations.get(id), decision = this.decisions.get(id);
    if (!row || !decision || decision.priority_source === "owner" || row.state !== "processing" || row.leaseToken !== leaseToken || row.leaseExpiresAt! <= this.now().getTime()) return false;
    decision.priority = assessment.priority;
    decision.priority_source = "model";
    Object.assign(row, { state: "succeeded", leaseToken: null, leaseExpiresAt: null, provider: assessment.provider, model: assessment.model, rubricVersion: assessment.rubricVersion, reason: assessment.reason, confidence: assessment.confidence, assessedAt: this.timestamp(), inputDigest: assessment.inputDigest, failureCategory: null, updatedAt: this.timestamp() });
    return true;
  }

  async failDecisionPriorityEvaluation(id: DecisionId, leaseToken: string, category: DecisionPriorityFailureCategory): Promise<boolean> {
    const row = this.priorityEvaluations.get(id), decision = this.decisions.get(id);
    if (!row || !decision || decision.priority_source === "owner" || row.state !== "processing" || row.leaseToken !== leaseToken || row.leaseExpiresAt! <= this.now().getTime()) return false;
    if (row.attempts >= PRIORITY_MAX_ATTEMPTS) this.priorityFallback(decision, row, category);
    else Object.assign(row, { state: "pending", nextAttemptAt: this.now().getTime() + priorityRetryMs(row.attempts), leaseToken: null, leaseExpiresAt: null, failureCategory: priorityFailureCategory(category), updatedAt: this.timestamp() });
    return true;
  }

  private priorityFallback(decision: DecisionRecord, row: PriorityEvaluationRecord, category: DecisionPriorityFailureCategory): void {
    decision.priority = "p2";
    decision.priority_source = "fallback";
    Object.assign(row, { state: "failed", leaseToken: null, leaseExpiresAt: null, failureCategory: priorityFailureCategory(category), updatedAt: this.timestamp() });
  }

  async joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
    input: JoinRoomRequest = {},
  ): Promise<{ room: Room; membership: RoomMember }> {
    this.requireOnline(auth);
    const room = this.roomById(roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    if (auth.principalId !== room.principal_id) refuseDirect(room);
    const invite = input.invite === undefined ? null : this.usableInvite(input.invite, room.id);
    if(this.contactPrincipals.includes(auth.principalId) && room.principal_id!==auth.principalId && this.memberships.get(membershipKey(room.id,auth.instanceId))?.state!=="active")throw new RepositoryError(403,"permission_denied","Owner contact approval is required before joining.");
    const key = membershipKey(room.id, auth.instanceId);
    const existing = this.memberships.get(key);
    const membership: MembershipRecord =
      existing && existing.state === "active"
        ? existing
        : {
            room_id: room.id,
            instance_id: auth.instanceId,
            state: "active",
            joined_at: this.timestamp(),
            left_at: null,
            admitted_by: invite ? "invite" : "room_id",
            invite_id: invite?.id ?? null,
            added_by_instance_id: null,
          };
    if (membership !== existing) {
      this.memberships.set(key, membership);
      this.seatTaken(room, auth.instanceId, auth.principalId);
      if (invite) invite.uses += 1;
    }
    // A name given at the door is this seat's own nickname, the same one a
    // double-click in the Dashboard sets: everyone in its Rooms sees it.
    if (input.name !== undefined) await this.nameSeat(auth.principalId, auth.instanceId, input.name);
    return { room: this.projectRoom(room), membership: this.projectMembership(membership, auth.principalId) };
  }

  /** The invite behind a token, if it opens this Room and is still usable. */
  private usableInvite(token: string, roomId: RoomId): InviteRecord {
    const candidate = digestSecret(token);
    let invite: InviteRecord | undefined;
    for (const record of this.invites.values()) {
      if (secureDigestEquals(candidate, record.tokenDigest)) {
        invite = record;
        break;
      }
    }
    // An invite is bound to one Room; presenting it on another is a bad credential.
    if (!invite || invite.room_id !== roomId) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    if (invite.revoked_at !== null) {
      throw new RepositoryError(410, "invite_revoked", "Room invite was revoked.");
    }
    if (invite.expires_at !== null && Date.parse(invite.expires_at) <= this.now().getTime()) {
      throw new RepositoryError(410, "invite_expired", "Room invite has expired.");
    }
    return invite;
  }

  async createRoomInvite(input: {
    roomId: RoomId;
    principalId: PrincipalId;
    expiresInSeconds?: number | null;
  }): Promise<{ invite: RoomInvite; token: RitSecret }> {
    const room = this.roomVisibleTo(input.principalId, input.roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    refuseDirect(room);
    const token = generateSecret("rit");
    const createdAt = this.now();
    const seconds = input.expiresInSeconds ?? 0;
    const invite: InviteRecord = {
      id: generatePublicId("inv"),
      room_id: room.id,
      principal_id: input.principalId,
      expires_at:
        seconds > 0 ? new Date(createdAt.getTime() + seconds * 1000).toISOString() : null,
      revoked_at: null,
      uses: 0,
      created_at: createdAt.toISOString(),
      tokenDigest: digestSecret(token),
    };
    this.invites.set(invite.id, invite);
    return { invite: this.projectInvite(invite), token };
  }

  async revokeRoomInvite(input: {
    inviteId: InviteId;
    principalId: PrincipalId;
  }): Promise<{ invite: RoomInvite }> {
    const invite = this.invites.get(input.inviteId);
    if (!invite || invite.principal_id !== input.principalId) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    invite.revoked_at ??= this.timestamp();
    return { invite: this.projectInvite(invite) };
  }

  async joinRoomWithInvite(
    token: string,
    roomId: RoomId,
    input: JoinRoomWithInviteRequest,
  ): Promise<{
    room: Room;
    membership: RoomMember;
    member_token: SniSecret;
    history: Page<Message>;
  }> {
    const invite = this.usableInvite(token, roomId);
    const room = this.roomById(invite.room_id);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    refuseDirect(room);
    const now = this.now();
    const joinedAt = now.toISOString();
    // The Agent arrived with nothing but the invite: it gets a Principal of its
    // own, anonymous until someone binds it, and an Instance under it.
    const principal: Principal = {
      id: generatePublicId("p"),
      display_name: input.name,
      default_reach: "public",
      created_at: joinedAt,
      invited_by_principal_id: invite.principal_id,
    };
    const memberToken = generateSecret("sni");
    const runtime = input.runtime;
    const instance: InstanceRecord = {
      id: generatePublicId("i"),
      principal_id: principal.id,
      agent_id: null,
      runtime_kind: runtime?.kind ?? "custom",
      cli_version: runtime?.version ?? "invite",
      runtime_metadata: runtimeMetadataFromReport(runtime),
      status: "online",
      display_name: input.name,
      reach: input.reach ?? "public",
      started_at: joinedAt,
      last_seen_at: joinedAt,
      lease_expires_at: new Date(now.getTime() + PRESENCE_LEASE_MS).toISOString(),
      token_expires_at: null,
      ended_at: null,
      revoked_at: null,
      tokenDigest: digestSecret(memberToken),
      issuedByKeyId: null,
      admittedByInviteId: invite.id,
      localInstanceKey: null,
    };
    const membership: MembershipRecord = {
      room_id: room.id,
      instance_id: instance.id,
      state: "active",
      joined_at: joinedAt,
      left_at: null,
      admitted_by: "invite",
      invite_id: invite.id,
      added_by_instance_id: null,
    };
    this.principals.set(principal.id, principal);
    this.instances.set(instance.id, instance);
    this.instanceIdsByDigest.set(instance.tokenDigest, instance.id);
    this.memberships.set(membershipKey(room.id, instance.id), membership);
    invite.uses += 1;
    const history = this.pageMessages(room.id, { after: 0, limit: 100 });
    return {
      room: this.projectRoom(room),
      membership: this.projectMembership(membership, principal.id),
      member_token: memberToken,
      history,
    };
  }

  async getRoom(
    auth: RoomAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const memberships = [...this.memberships.values()]
      .filter((membership) => membership.room_id === room.id)
      .map((membership) => this.projectMembership(membership, auth.principalId));
    return { room: this.projectRoom(room), memberships };
  }

  async getCompiledState(auth: InstanceAuth, roomId: RoomId): Promise<CompiledRoomState> {
    this.instanceRecord(auth);
    const room = this.roomById(roomId);
    this.requireMembership(auth, roomId);
    if (room.type !== "compiled") throw new RepositoryError(409, "room_not_compiled", "Room is not compiled.");
    const engine = CompiledEngine.restore([auth.instanceId], (this.acts.get(roomId) ?? []).map(row => row.event), room.protocol_version!);
    return compiledState(engine, auth.instanceId);
  }

  async postAct(auth: InstanceAuth, roomId: RoomId, input: unknown): Promise<ActResult> {
    // No await from membership/open check through both appends: one atomic memory turn.
    const actor = this.requireOnline(auth);
    const room = this.roomById(roomId);
    this.requireMembership(auth, roomId);
    if (room.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    if (room.type !== "compiled") throw new RepositoryError(409, "room_not_compiled", "Room is not compiled.");
    if (isServiceRuntimeKind(actor.runtime_kind)) throw new RepositoryError(403, "room_membership_required", "Service seats cannot submit agent acts.");
    const history = this.acts.get(roomId) ?? [];
    const engine = CompiledEngine.restore([auth.instanceId], history.map(row => row.event), room.protocol_version!);
    const envelope = input as Record<string, unknown>;
    const result = admitCompiled(engine, roomId, auth.instanceId, envelope, history, this.artifacts);
    if (result.accepted && result.code !== "DUPLICATE") {
      const event = result.event!;
      const serviceId = this.compiledSeats.get(roomId)!;
      const mentions = [...this.memberships.values()]
        .filter(member => member.room_id === roomId && member.state === "active" && !isServiceRuntimeKind(this.instances.get(member.instance_id)?.runtime_kind ?? ""))
        .map(member => member.instance_id);
      const line: MessageRecord = { id: generatePublicId("msg"), room_id: roomId, sequence: room.nextSequence,
        sender_principal_id: room.principal_id, sender_instance_id: serviceId, type: "compiled_act", content: notification(event),
        reply_to_message_id: null, created_at: this.timestamp(), mentions };
      this.contactMentions(actor,room,line);
      history.push({ event: structuredClone(event), envelopeDigest: envelopeDigest(envelope) });
      this.acts.set(roomId, history);
      this.messages.get(roomId)!.push(line);
      room.nextSequence += 1;
      this.endGoalIfDue(room);
    }
    return result;
  }

  async postMessage(
    auth: RoomAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null; addressing?: "nobody" },
  ): Promise<{ message: Message }> {
    this.requireOnline(auth);
    const room = this.roomById(roomId);
    if (room.state === "closed") {
      throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    this.requireMembership(auth, room.id);

    const roomMessages = this.messages.get(room.id)!;
    const replyId = input.reply_to_message_id ?? null;
    if (replyId && !roomMessages.some((message) => message.id === replyId)) {
      throw new RepositoryError(
        422,
        "reply_target_invalid",
        "Reply target is invalid.",
      );
    }

    // Who the line addresses is settled now, against the seats as they are named now; a line said to address nobody names no seat.
    const seats = [...this.memberships.values()]
      .filter((membership) => input.addressing !== "nobody" && membership.room_id === room.id && membership.state === "active")
      .flatMap((membership) => {
        const instance = this.instances.get(membership.instance_id);
        const tag = instance?.agent_id ? this.agents.get(instance.agent_id)?.handle ?? null : null;
        return [
          { memberId: membership.instance_id, name: instance?.display_name ?? null },
          { memberId: membership.instance_id, name: tag },
        ];
      });
    const message: MessageRecord = {
      id: generatePublicId("msg"),
      room_id: room.id,
      sequence: room.nextSequence,
      sender_principal_id: auth.principalId,
      sender_instance_id: auth.instanceId,
      content: input.content,
      reply_to_message_id: replyId,
      created_at: this.timestamp(),
      mentions: mentionedSeats(input.content, seats, auth.instanceId),
    };
    this.contactMentions(this.instanceRecord(auth),room,message);
    message.mentions = this.holdForeignMentions(this.instanceRecord(auth), room, message);
    room.nextSequence += 1;
    roomMessages.push(message);
    // The message that reaches a goal's count is taken, and the Room ends with it.
    this.endGoalIfDue(room);
    return { message: this.projectMessage(message) };
  }

  async listMessages(auth: RoomAuth, roomId: RoomId, input: MessageQuery): Promise<Page<Message>> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    return this.pageMessages(room.id, input);
  }

  async getMessage(auth: RoomAuth, roomId: RoomId, messageId: MessageId): Promise<Message | null> {
    const room = this.roomById(roomId);
    this.requireMembership(auth, room.id);
    const message = this.messages.get(room.id)?.find((item) => item.id === messageId);
    return message ? this.projectMessage(message) : null;
  }

  async listInbox(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<Page<Message>> {
    const roomIds = [...this.memberships.values()]
      .filter((membership) => membership.instance_id === auth.instanceId && membership.state === "active")
      .map((membership) => membership.room_id);
    const after = input.after;
    const matching = roomIds
      .flatMap((roomId) => this.messages.get(roomId) ?? [])
      .filter((message) => after === null || compareInboxPosition(message, after) > 0)
      .sort(compareInboxPosition);
    const items = matching.slice(0, input.limit).map((message) => this.projectMessage(message));
    const last = items.at(-1);
    return {
      items,
      next_cursor: last
        ? encodeInboxCursor({ created_at: last.created_at, room_id: last.room_id, sequence: last.sequence })
        : after
          ? encodeInboxCursor(after)
          : null,
      has_more: matching.length > items.length,
    };
  }

  async listInboxEvents(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<{ items: InboxEvent[] }> {
    const { items } = await this.listInbox(auth, input);
    return {
      items: items.map((message) => {
        const room = this.roomById(message.room_id);
        const sender = this.instances.get(message.sender_instance_id);
        const tag = sender?.agent_id ? this.agents.get(sender.agent_id) : undefined;
        const principal = this.principals.get(message.sender_principal_id);
        return {
          message,
          room: { id: room.id, name: room.name, kind: room.kind, principal_id: room.principal_id },
          sender: {
            id: message.sender_instance_id,
            principal_id: message.sender_principal_id,
            runtime_kind: sender?.runtime_kind ?? "custom",
            display_name: sender?.display_name ?? null,
          },
          sender_name: sender?.display_name ?? tag?.handle ?? principal?.display_name ?? null,
        };
      }),
    };
  }

  private pageMessages(roomId: RoomId, partial: Partial<MessageQuery> & { after: number; limit: number }): Page<Message> {
    const input: MessageQuery = { ...DEFAULT_MESSAGE_QUERY, ...partial };
    const needle = input.q === null ? null : input.q.toLowerCase();
    const matching = (this.messages.get(roomId) ?? [])
      .filter((message) => (input.before === null ? message.sequence > input.after : message.sequence < input.before))
      .filter((message) => input.sender_instance_id === null || message.sender_instance_id === input.sender_instance_id)
      .filter((message) => {
        if (input.sender_agent_id === null) return true;
        const tag = this.tagOf(message.sender_instance_id);
        return input.sender_agent_id === "default" ? tag === null : tag === input.sender_agent_id;
      })
      .filter((message) => needle === null || message.content.toLowerCase().includes(needle))
      .filter((message) => input.mentions === null || message.mentions.includes(input.mentions))
      .sort((left, right) => (input.order === "asc" ? left.sequence - right.sequence : right.sequence - left.sequence));
    const items = matching.slice(0, input.limit).map((message) => this.projectMessage(message));
    const resumeFrom = input.before ?? (input.after > 0 ? input.after : null);
    return {
      items,
      next_cursor: items.length > 0 ? String(items[items.length - 1]!.sequence) : resumeFrom === null ? null : String(resumeFrom),
      has_more: matching.length > items.length,
    };
  }

  async startCliLogin(input: {
    label: string | null;
    seats: string[];
  }): Promise<{ login: CliLogin; user_code: string; poll_token: ClpSecret }> {
    const now = this.now();
    const bind: InstanceId[] = [];
    for (const seat of input.seats) {
      // Proof of possession: only a live seat of an anonymous Principal counts.
      const digest = digestSecret(seat);
      const instanceId = [...this.instanceIdsByDigest.entries()].find(([candidate]) =>
        secureDigestEquals(candidate, digest),
      )?.[1];
      const instance = instanceId ? this.instances.get(instanceId) : undefined;
      if (!instance || instance.issuedByKeyId !== null || instance.status === "ended" || instance.status === "revoked") continue;
      const principal = this.principals.get(instance.principal_id);
      if (!principal || principal.invited_by_principal_id === null || this.mergedPrincipals.has(principal.id)) continue;
      if (!bind.includes(instance.id)) bind.push(instance.id);
    }
    const code = generateCliLoginCode();
    const pollToken = generateSecret("clp");
    const record: CliLoginRecord = {
      id: generatePublicId("cli"),
      state: "pending",
      label: input.label,
      bind_instance_ids: bind,
      principal_id: null,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CLI_LOGIN_TTL_MS).toISOString(),
      approved_at: null,
      codeDigest: digestSecret(code),
      pollTokenDigest: digestSecret(pollToken),
      apiKeyId: null,
    };
    this.cliLogins.set(record.id, record);
    return { login: this.projectCliLogin(record), user_code: code, poll_token: pollToken };
  }

  async createCliClaim(input: { principalId: PrincipalId; label: string | null }): Promise<{ login: CliLogin; claim: ClpSecret }> {
    const principal = this.principals.get(input.principalId);
    if (!principal) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    const now = this.now();
    const claim = generateSecret("clp");
    const record: CliLoginRecord = {
      id: generatePublicId("cli"),
      state: "approved",
      label: input.label,
      bind_instance_ids: [],
      principal_id: principal.id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CLI_CLAIM_TTL_MS).toISOString(),
      approved_at: now.toISOString(),
      codeDigest: digestSecret(generateCliLoginCode()),
      pollTokenDigest: digestSecret(claim),
      apiKeyId: null,
    };
    this.cliLogins.set(record.id, record);
    return { login: this.projectCliLogin(record), claim };
  }

  async redeemCliClaim(claim: string) {
    const digest = digestSecret(claim);
    const record = [...this.cliLogins.values()].find((candidate) => secureDigestEquals(digest, candidate.pollTokenDigest));
    if (!record) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    const polled = await this.pollCliLogin(record.id, claim);
    if (polled.state !== "approved") throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    return polled;
  }

  private cliLoginByCode(code: string): CliLoginRecord | null {
    const digest = digestSecret(code);
    for (const record of this.cliLogins.values()) {
      if (secureDigestEquals(digest, record.codeDigest)) return record;
    }
    return null;
  }

  /**
   * `expires_at` binds every state a login can still be redeemed from, not
   * only `pending`. An approved record carries a claim someone may still
   * spend for this account's API key, so leaving it out made that claim
   * immortal. `consumed` and `denied` are terminal and keep their own error.
   */
  private expireCliLogin(record: CliLoginRecord): void {
    const redeemable = record.state === "pending" || record.state === "approved";
    if (redeemable && Date.parse(record.expires_at) <= this.now().getTime()) {
      record.state = "expired";
    }
  }

  async getCliLoginByCode(code: string): Promise<{ login: CliLogin } | null> {
    const record = this.cliLoginByCode(code);
    if (!record) return null;
    this.expireCliLogin(record);
    return { login: this.projectCliLogin(record) };
  }

  async approveCliLogin(input: {
    code: string;
    principalId: PrincipalId;
  }): Promise<{ login: CliLogin; bound_principal_ids: PrincipalId[] }> {
    const record = this.cliLoginByCode(input.code);
    if (!record) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    this.expireCliLogin(record);
    if (record.state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
    if (record.state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
    if (record.state !== "pending") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
    const account = this.principals.get(input.principalId);
    if (!account || account.invited_by_principal_id !== null) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    const bound: PrincipalId[] = [];
    for (const instanceId of record.bind_instance_ids) {
      const instance = this.instances.get(instanceId);
      if (!instance) continue;
      const anonymousId = instance.principal_id;
      if (anonymousId === account.id || this.mergedPrincipals.has(anonymousId)) continue;
      // Binding: every Instance of the anonymous Principal moves under the
      // account's Principal; memberships and messages follow the Instance.
      for (const candidate of this.instances.values()) {
        if (candidate.principal_id === anonymousId) candidate.principal_id = account.id;
      }
      for (const messages of this.messages.values()) {
        for (const message of messages) {
          if (message.sender_principal_id === anonymousId) message.sender_principal_id = account.id;
        }
      }
      this.mergedPrincipals.set(anonymousId, account.id);
      // Credits follow the Instances: an anonymous seat may hold credits it was
      // paid before its human logged in.
      this.moveCreditPurse(anonymousId, account.id);
      bound.push(anonymousId);
    }
    record.state = "approved";
    record.principal_id = account.id;
    record.approved_at = this.timestamp();
    // Approval restarts the clock: the window before it is how long a human
    // had to answer, and the CLI still has to poll once more to redeem.
    record.expires_at = new Date(this.now().getTime() + CLI_LOGIN_TTL_MS).toISOString();
    return { login: this.projectCliLogin(record), bound_principal_ids: bound };
  }

  async pollCliLogin(loginId: CliLoginId, pollToken: string) {
    const record = this.cliLogins.get(loginId);
    if (!record || !secureDigestEquals(digestSecret(pollToken), record.pollTokenDigest)) {
      throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    }
    this.expireCliLogin(record);
    if (record.state === "expired") throw new RepositoryError(410, "login_expired", "CLI login has expired.");
    if (record.state === "denied") throw new RepositoryError(410, "login_denied", "CLI login was denied.");
    if (record.state === "consumed") throw new RepositoryError(410, "login_consumed", "CLI login was already used.");
    if (record.state === "pending") return { state: "pending" as const, login: this.projectCliLogin(record) };
    const principal = this.principals.get(record.principal_id!);
    if (!principal) throw new RepositoryError(404, "login_not_found", "CLI login was not found.");
    // The key is minted now, at the one moment it is handed over, so no raw key is ever stored.
    const apiKey = generateSecret("snk");
    const keyRecord: ApiKeyRecord = {
      id: generatePublicId("key"),
      principalId: principal.id,
      digest: digestSecret(apiKey),
      revokedAt: null,
    };
    this.apiKeysByDigest.set(keyRecord.digest, keyRecord);
    record.state = "consumed";
    record.apiKeyId = keyRecord.id;
    return {
      state: "approved" as const,
      login: this.projectCliLogin(record),
      api_key: apiKey,
      api_key_id: keyRecord.id,
      principal: { ...principal },
    };
  }

  private projectCliLogin(record: CliLoginRecord): CliLogin {
    const { codeDigest: _c, pollTokenDigest: _p, apiKeyId: _k, ...login } = record;
    return { ...login, bind_instance_ids: [...login.bind_instance_ids] };
  }

  async executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult> {
    const key = idempotencyKey(scope);
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RepositoryError(
          409,
          "idempotency_conflict",
          "Idempotency key was already used for a different request.",
        );
      }
      return { status: existing.status, body: existing.body, replayed: true };
    }

    const inFlight = this.idempotencyInFlight.get(key);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        throw new RepositoryError(
          409,
          "idempotency_conflict",
          "Idempotency key was already used for a different request.",
        );
      }
      const replay = await inFlight.result;
      return { ...replay, replayed: true };
    }

    const pending = (async () => {
      const result = await operation();
      this.idempotency.set(key, { ...result, fingerprint });
      return { ...result, replayed: false };
    })();
    this.idempotencyInFlight.set(key, { fingerprint, result: pending });
    try {
      return await pending;
    } finally {
      this.idempotencyInFlight.delete(key);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private projectInstance(record: InstanceRecord): Instance {
    const now = this.now().getTime();
    let status = record.status;
    if (status !== "ended" && status !== "revoked") {
      if (record.token_expires_at !== null && now >= Date.parse(record.token_expires_at)) status = "expired";
      else if (now >= Date.parse(record.lease_expires_at)) status = "offline";
      else status = "online";
    }
    const {
      tokenDigest: _tokenDigest,
      issuedByKeyId: _issuedByKeyId,
      admittedByInviteId: _admittedByInviteId,
      localInstanceKey: _localInstanceKey,
      ...projected
    } = record;
    return { ...projected, runtime_metadata: { ...projected.runtime_metadata }, status };
  }

  private instanceRecord(auth: InstanceAuth): InstanceRecord {
    const record = this.instances.get(auth.instanceId);
    if (!record || record.principal_id !== auth.principalId) {
      throw new RepositoryError(401, "invalid_credentials", "Credentials are invalid.");
    }
    return record;
  }

  private ownedAgent(auth: PrincipalAuth, agentId: AgentId): Agent {
    const agent = this.agents.get(agentId);
    if (!agent || agent.principal_id !== auth.principalId) {
      throw new RepositoryError(404, "agent_not_found", "Agent was not found.");
    }
    return agent;
  }

  /** The tag an Instance is currently under — read at projection time, never copied. */
  private tagOf(instanceId: InstanceId | null): AgentId | null {
    if (instanceId === null) return null;
    return this.instances.get(instanceId)?.agent_id ?? null;
  }

  /**
   * The kind of Principal behind an Instance: with an account, or anonymous.
   * It is the Principal that decides, not how the Instance was admitted: a
   * seat joined by invite reads as `instance` once its Principal is bound.
   */
  private memberKind(instance: InstanceRecord | undefined): MemberKind {
    const principal = instance ? this.principals.get(instance.principal_id) : undefined;
    return principal && principal.invited_by_principal_id !== null && !this.mergedPrincipals.has(principal.id)
      ? "guest"
      : "instance";
  }

  private memberRef(instanceId: InstanceId): MemberRef {
    const instance = this.instances.get(instanceId);
    return {
      member_id: instanceId,
      kind: this.memberKind(instance),
      name: instance?.display_name ?? null,
    };
  }

  /** A seat as `viewer` sees it: another Principal reads only the driver fields of its runtime_metadata. */
  private projectMembership(record: MembershipRecord, viewer: PrincipalId | null): RoomMember {
    const instance = this.instances.get(record.instance_id);
    const principal = instance ? this.principals.get(instance.principal_id) : undefined;
    const lastSeenAt = instance?.last_seen_at ?? null;
    return {
      room_id: record.room_id,
      member_id: record.instance_id,
      kind: this.memberKind(instance),
      name: instance?.display_name ?? null,
      principal_id: instance?.principal_id ?? principal?.id ?? ("p_unknown" as PrincipalId),
      agent_id: this.tagOf(record.instance_id),
      instance_id: record.instance_id,
      invited_by_principal_id: principal?.invited_by_principal_id ?? null,
      admitted_by: record.admitted_by,
      invite_id: record.invite_id,
      added_by_instance_id: record.added_by_instance_id,
      runtime_kind: instance?.runtime_kind ?? "custom",
      runtime_version: instance?.cli_version ?? "",
      runtime_metadata: instance ? runtimeMetadataFor(viewer, instance.principal_id, instance.runtime_metadata) : {},
      state: record.state,
      joined_at: record.joined_at,
      left_at: record.left_at,
      last_seen_at: lastSeenAt,
      presence: presenceFor(lastSeenAt, this.now()),
    };
  }

  private projectInvite(record: InviteRecord): RoomInvite {
    const { tokenDigest: _tokenDigest, ...invite } = record;
    return { ...invite };
  }

  private projectMessage(record: MessageRecord): Message {
    return {
      ...record,
      sender_agent_id: this.tagOf(record.sender_instance_id),
      sender: this.memberRef(record.sender_instance_id),
      type: record.type ?? "message",
    };
  }

  private requireOnline(auth: InstanceAuth): InstanceRecord {
    const record = this.instanceRecord(auth);
    if (this.projectInstance(record).status !== "online") {
      throw new RepositoryError(409, "instance_offline", "Instance is offline.");
    }
    return record;
  }

  /** A Room id is the capability; membership is checked separately. */
  private roomById(roomId: RoomId): RoomRecord {
    const room = this.rooms.get(roomId);
    if (!room) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    this.endGoalIfDue(room);
    return room;
  }

  private requireMembership(auth: RoomAuth, roomId: RoomId): void {
    const active = this.memberships.get(membershipKey(roomId, auth.instanceId))?.state === "active";
    if (!active) {
      throw new RepositoryError(
        403,
        "room_membership_required",
        "Active Room membership is required.",
      );
    }
  }

  private projectRoom(room: RoomRecord): Room {
    const { nextSequence: _nextSequence, shareToken: _shareToken, ...projected } = room;
    return { ...projected, type: room.type ?? "board", protocol_version: room.protocol_version ?? null, creator_agent_id: this.tagOf(room.creator_instance_id) };
  }

  // ---- Artifacts: files an Agent hands to a Room. ----

  async uploadArtifact(auth: CreditAuth, input: UploadArtifactInput): Promise<UploadedArtifact> {
    const principalId = this.artifactOwner(auth.principalId);
    if (input.bytes.byteLength === 0) {
      throw new RepositoryError(422, "validation_failed", "Request is invalid.");
    }
    if (input.bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new RepositoryError(413, "artifact_too_large", "File is larger than this service accepts.");
    }
    if (input.room_id !== null) {
      // You hand a file to a Room you are in, not to one you know the id of.
      const seated = [...this.memberships.values()].some(
        (membership) =>
          membership.room_id === input.room_id &&
          membership.state === "active" &&
          this.instances.get(membership.instance_id)?.principal_id === principalId,
      );
      if (!seated) throw new RepositoryError(404, "room_not_found", "Room was not found.");
      const room = this.rooms.get(input.room_id);
      if (room?.state === "closed") throw new RepositoryError(409, "room_closed", "Room is closed.");
    }
    const held = this.usageOf(principalId);
    if (held.bytes + input.bytes.byteLength > ARTIFACT_QUOTA_BYTES) {
      throw new RepositoryError(409, "artifact_quota_reached", "This account is holding as many bytes as it may.");
    }
    // Every file has a link: that is what makes handing one over work.
    const linkKey = generateSecret("afk");
    const artifact: Artifact & { linkKey: AfkSecret } = {
      id: generatePublicId("art"),
      principal_id: principalId,
      uploaded_by_instance_id: auth.kind === "instance" ? auth.instanceId : null,
      room_id: input.room_id,
      filename: input.filename,
      content_type: input.content_type,
      size_bytes: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
      created_at: this.timestamp(),
      linkKey,
    };
    this.artifacts.set(artifact.id, artifact);
    this.artifactBytes.set(artifact.id, new Uint8Array(input.bytes));
    return { artifact: this.projectArtifact(artifact), link_key: linkKey };
  }

  async getArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }> {
    return { artifact: this.projectArtifact(this.artifactVisibleTo(auth.principalId, artifactId)) };
  }

  async readArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact; bytes: Uint8Array }> {
    const record = this.artifactVisibleTo(auth.principalId, artifactId);
    return { artifact: this.projectArtifact(record), bytes: this.artifactBytes.get(record.id) ?? new Uint8Array() };
  }

  async readArtifactByLink(artifactId: ArtifactId, key: string): Promise<{ artifact: Artifact; bytes: Uint8Array }> {
    const record = this.artifacts.get(artifactId);
    // A wrong key reads exactly like a missing file: the comparison is constant-time.
    if (!record || !secureDigestEquals(digestSecret(record.linkKey), digestSecret(key))) {
      throw new RepositoryError(404, "artifact_not_found", "File was not found.");
    }
    return { artifact: this.projectArtifact(record), bytes: this.artifactBytes.get(record.id) ?? new Uint8Array() };
  }

  async listArtifacts(auth: CreditAuth, input: ArtifactQuery): Promise<Page<Artifact>> {
    const mine = [...this.artifacts.values()]
      .filter((record) => this.canRead(auth.principalId, record))
      .filter((record) => (input.room_id === null ? true : record.room_id === input.room_id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id));
    const start = input.before === null ? 0 : mine.findIndex((record) => record.id === input.before) + 1;
    if (input.before !== null && start === 0) throw new RepositoryError(400, "invalid_cursor", "Cursor is invalid.");
    const page = mine.slice(start, start + input.limit);
    const hasMore = start + input.limit < mine.length;
    return {
      items: page.map((record) => this.projectArtifact(record)),
      next_cursor: hasMore ? (page[page.length - 1]!.id as string) : null,
      has_more: hasMore,
    };
  }

  async artifactUsage(auth: CreditAuth): Promise<ArtifactUsage> {
    return this.usageOf(auth.principalId);
  }

  async deleteArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }> {
    const record = this.artifacts.get(artifactId);
    // Only the account that uploaded it; to anyone else it is not there at all.
    if (!record || this.artifactOwner(record.principal_id) !== this.artifactOwner(auth.principalId)) {
      throw new RepositoryError(404, "artifact_not_found", "File was not found.");
    }
    this.artifacts.delete(artifactId);
    this.artifactBytes.delete(artifactId);
    return { artifact: this.projectArtifact(record) };
  }

  private usageOf(principalId: PrincipalId): ArtifactUsage {
    const owner = this.artifactOwner(principalId);
    const mine = [...this.artifacts.values()].filter((record) => this.artifactOwner(record.principal_id) === owner);
    return {
      bytes: mine.reduce((sum, record) => sum + record.size_bytes, 0),
      quota_bytes: ARTIFACT_QUOTA_BYTES,
      count: mine.length,
    };
  }

  private canRead(principalId: PrincipalId, record: Artifact): boolean {
    principalId = this.artifactOwner(principalId);
    if (this.artifactOwner(record.principal_id) === principalId) return true;
    if (record.room_id === null) return false;
    return [...this.memberships.values()].some(
      (membership) =>
        membership.room_id === record.room_id &&
        membership.state === "active" &&
        this.instances.get(membership.instance_id)?.principal_id === principalId,
    );
  }

  private artifactVisibleTo(principalId: PrincipalId, artifactId: ArtifactId): Artifact & { linkKey: AfkSecret } {
    const record = this.artifacts.get(artifactId);
    if (!record || !this.canRead(principalId, record)) {
      throw new RepositoryError(404, "artifact_not_found", "File was not found.");
    }
    return record;
  }

  /** The key never leaves through a read: it is handed out once, at upload. */
  private projectArtifact(record: Artifact & { linkKey: AfkSecret }): Artifact {
    const { linkKey: _linkKey, ...artifact } = record;
    return { ...artifact, principal_id: this.artifactOwner(artifact.principal_id) };
  }

  /** Retired guest rows remain recoverable through the permanent claim mapping. */
  private artifactOwner(principalId: PrincipalId): PrincipalId {
    return this.mergedPrincipals.get(principalId) ?? principalId;
  }

  // ---- Credits: a purse per Principal, a ledger of every movement. ----

  async getCredits(auth: CreditAuth): Promise<{ credits: CreditBalance }> {
    return { credits: this.purseOf(auth.principalId) };
  }

  async redeemCredits(auth: CreditAuth, code: string): Promise<CreditRedemption> {
    return this.redeem(auth.principalId, code);
  }

  async transferCredits(auth: CreditAuth, input: CreditTransferRequest): Promise<{ transfer: CreditTransfer; credits: CreditBalance }> {
    const payer = auth.principalId;
    const payee = this.purseBehind(input.to);
    if (payee === null) throw new RepositoryError(404, "payee_not_found", "No Principal, Agent or Instance with that id.");
    if (payee === payer) throw new RepositoryError(422, "transfer_to_self", "A transfer to your own Principal moves nothing.");
    if (input.room_id !== undefined && input.room_id !== null && !this.rooms.has(input.room_id)) {
      throw new RepositoryError(404, "room_not_found", "Room was not found.");
    }
    const balance = this.creditBalances.get(payer) ?? 0;
    if (balance < input.amount) {
      throw new RepositoryError(409, "insufficient_credits", "The purse does not hold that many credits.");
    }
    this.creditBalances.set(payer, balance - input.amount);
    this.creditBalances.set(payee, (this.creditBalances.get(payee) ?? 0) + input.amount);
    const transfer: CreditTransfer = {
      id: generatePublicId("txn"),
      from_principal_id: payer,
      to_principal_id: payee,
      amount: input.amount,
      memo: input.memo ?? null,
      room_id: input.room_id ?? null,
      by_instance_id: auth.kind === "instance" ? auth.instanceId : null,
      addressed_to: input.to,
      code: null,
      created_at: this.timestamp(),
    };
    this.creditTransfers.push(transfer);
    return { transfer: { ...transfer }, credits: this.purseOf(payer) };
  }

  async listCreditTransfers(auth: CreditAuth, input: CreditLedgerQuery): Promise<Page<CreditTransfer>> {
    return this.ledgerOf(auth.principalId, input);
  }

  async mintCreditCode(input: { code: string; amount: number; max_redemptions?: number | null; expires_at?: string | null }): Promise<{ code: CreditCode }> {
    const code: CreditCode = {
      code: input.code,
      amount: input.amount,
      max_redemptions: input.max_redemptions ?? null,
      redeemed_count: 0,
      expires_at: input.expires_at ?? null,
      active: true,
      created_at: this.timestamp(),
    };
    this.creditCodes.set(code.code, code);
    return { code: { ...code } };
  }

  async creditsForPrincipal(principalId: PrincipalId): Promise<CreditsOverview> {
    if (!this.principals.has(principalId)) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    return { credits: this.purseOf(principalId), transfers: (await this.ledgerOf(principalId, { limit: 100, before: null })).items };
  }

  async redeemCreditsForPrincipal(principalId: PrincipalId, code: string): Promise<CreditRedemption> {
    if (!this.principals.has(principalId)) throw new RepositoryError(404, "principal_not_found", "Principal was not found.");
    return this.redeem(principalId, code);
  }

  /**
   * Moves one purse into another when an anonymous Principal is bound into an
   * account. The move is a ledger row like any other, so the balance is still
   * the sum of the ledger and the account can see where the credits came from.
   */
  private moveCreditPurse(fromPrincipalId: PrincipalId, toPrincipalId: PrincipalId): void {
    const amount = this.creditBalances.get(fromPrincipalId) ?? 0;
    if (amount <= 0) return;
    this.creditBalances.set(fromPrincipalId, 0);
    this.creditBalances.set(toPrincipalId, (this.creditBalances.get(toPrincipalId) ?? 0) + amount);
    this.creditTransfers.push({
      id: generatePublicId("txn"),
      from_principal_id: fromPrincipalId,
      to_principal_id: toPrincipalId,
      amount,
      memo: "Bound into this account by sharednet login",
      room_id: null,
      by_instance_id: null,
      addressed_to: toPrincipalId,
      code: null,
      created_at: this.timestamp(),
    });
  }

  /** The Principal whose purse an id names: a Principal's own, an Agent's owner, an Instance's owner. */
  private purseBehind(id: string): PrincipalId | null {
    if (id.startsWith("p_")) {
      const principal = this.principals.get(id as PrincipalId);
      return principal ? (this.mergedPrincipals.get(principal.id) ?? principal.id) : null;
    }
    // A claim repoints Instances but not Agent tags, so both are followed to
    // whatever Principal they belong to now.
    const agent = id.startsWith("a_") ? this.agents.get(id as AgentId) : undefined;
    if (agent) return this.mergedPrincipals.get(agent.principal_id) ?? agent.principal_id;
    const instance = id.startsWith("i_") ? this.instances.get(id as InstanceId) : undefined;
    if (instance) return this.mergedPrincipals.get(instance.principal_id) ?? instance.principal_id;
    return null;
  }

  private purseOf(principalId: PrincipalId): CreditBalance {
    let granted = 0;
    let sent = 0;
    let received = 0;
    for (const transfer of this.creditTransfers) {
      if (transfer.to_principal_id === principalId) {
        if (transfer.from_principal_id === null) granted += transfer.amount;
        else received += transfer.amount;
      }
      if (transfer.from_principal_id === principalId) sent += transfer.amount;
    }
    return { principal_id: principalId, balance: this.creditBalances.get(principalId) ?? 0, granted, sent, received };
  }

  private async ledgerOf(principalId: PrincipalId, input: CreditLedgerQuery): Promise<Page<CreditTransfer>> {
    const mine = this.creditTransfers
      .filter((transfer) => transfer.from_principal_id === principalId || transfer.to_principal_id === principalId)
      .reverse();
    const start = input.before === null ? 0 : mine.findIndex((transfer) => transfer.id === input.before) + 1;
    if (input.before !== null && start === 0) throw new RepositoryError(400, "invalid_cursor", "Cursor is invalid.");
    const items = mine.slice(start, start + input.limit).map((transfer) => ({ ...transfer }));
    const hasMore = start + input.limit < mine.length;
    return { items, next_cursor: hasMore ? items[items.length - 1]!.id : null, has_more: hasMore };
  }

  private redeem(principalId: PrincipalId, code: string): CreditRedemption {
    const grant = this.creditCodes.get(code);
    if (!grant || !grant.active) throw new RepositoryError(404, "credit_code_not_found", "That code grants nothing.");
    // What this Principal already redeemed is settled history: a retry answers
    // the same way for good, even once the code itself has expired or filled up.
    const key = `${code}\0${principalId}`;
    if (this.creditRedemptions.has(key)) return { credits: this.purseOf(principalId), granted: 0, transfer: null };
    if (grant.expires_at !== null && Date.parse(grant.expires_at) <= this.now().getTime()) {
      throw new RepositoryError(410, "credit_code_expired", "That code has expired.");
    }
    // An anonymous Principal is free to create, so a code it could redeem would be an infinite purse.
    const backed = [...this.principalsByAccount.values()].includes(principalId);
    if (!backed) {
      throw new RepositoryError(403, "credits_account_required", "Only a Principal with an account behind it can redeem a code; run sharednet login.");
    }
    if (grant.max_redemptions !== null && grant.redeemed_count >= grant.max_redemptions) {
      throw new RepositoryError(410, "credit_code_exhausted", "That code has been redeemed as many times as it allows.");
    }
    grant.redeemed_count += 1;
    this.creditRedemptions.add(key);
    this.creditBalances.set(principalId, (this.creditBalances.get(principalId) ?? 0) + grant.amount);
    const transfer: CreditTransfer = {
      id: generatePublicId("txn"),
      from_principal_id: null,
      to_principal_id: principalId,
      amount: grant.amount,
      memo: null,
      room_id: null,
      by_instance_id: null,
      addressed_to: principalId,
      code,
      created_at: this.timestamp(),
    };
    this.creditTransfers.push(transfer);
    return { credits: this.purseOf(principalId), granted: grant.amount, transfer: { ...transfer } };
  }
}
