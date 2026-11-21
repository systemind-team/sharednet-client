import type { Projection as CompiledProjection, Result as EngineResult, StoredEvent } from "./room.ts";
import type { renderObligations } from "./obligations.ts";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_ID_PREFIXES = ["p", "key", "a", "i", "rom", "msg", "dec", "mem", "inv", "cli", "txn", "art", "ava", "hk", "tm", "wak", "ctr"] as const;
export type PublicIdPrefix = (typeof PUBLIC_ID_PREFIXES)[number];

/**
 * Opaque identifier format, per design spec section 4.1: a type prefix plus a
 * case-sensitive ten-character Base62 body drawn from a cryptographically
 * secure source.
 *
 * The body is deliberately NOT sortable. An earlier implementation used a
 * ULID-style time prefix, which leaks each record's creation time and relative
 * order to anyone who sees an id. These are stable public addresses that appear
 * in URLs and logs, so they carry no timestamp and no ordering.
 */
export const ID_BODY = "[0-9A-Za-z]{10}";
export const PUBLIC_ID_PATTERN = /^(?:p|key|a|i|rom|msg|dec|mem|inv)_[0-9A-Za-z]{10}$/;
export const PRINCIPAL_ID_PATTERN = /^p_[0-9A-Za-z]{10}$/;
export const API_KEY_ID_PATTERN = /^key_[0-9A-Za-z]{10}$/;
export const AGENT_ID_PATTERN = /^a_[0-9A-Za-z]{10}$/;
export const INSTANCE_ID_PATTERN = /^i_[0-9A-Za-z]{10}$/;
export const ROOM_ID_PATTERN = /^rom_[0-9A-Za-z]{10}$/;
export const MESSAGE_ID_PATTERN = /^msg_[0-9A-Za-z]{10}$/;
export const DECISION_ID_PATTERN = /^dec_[0-9A-Za-z]{10}$/;
/** A guest member: someone who joined a Room with an invite token, not an Instance. */
export const MEMBER_ID_PATTERN = /^mem_[0-9A-Za-z]{10}$/;
export const INVITE_ID_PATTERN = /^inv_[0-9A-Za-z]{10}$/;
export const REQUEST_ID_PATTERN = /^req_[0-9A-Za-z]{10}$/;
export const SNK_SECRET_PATTERN = /^snk_[A-Za-z0-9_-]{43}$/;
export const SNI_SECRET_PATTERN = /^sni_[A-Za-z0-9_-]{43}$/;
/** Room invite token: grants `join` on one Room. Safe in a transcript. */
export const RIT_SECRET_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
/** Room member token: returned by a guest join; grants read, send, and wait in that Room. */
export const RMT_SECRET_PATTERN = /^rmt_[A-Za-z0-9_-]{43}$/;

export type PrincipalId = `p_${string}`;
export type ApiKeyId = `key_${string}`;
export type AgentId = `a_${string}`;
export type InstanceId = `i_${string}`;
export type RoomId = `rom_${string}`;
export type MessageId = `msg_${string}`;
export type DecisionId = `dec_${string}`;
export type MemberId = `mem_${string}`;
export type InviteId = `inv_${string}`;
export type CliLoginId = `cli_${string}`;
export type RequestId = `req_${string}`;
export type SnkSecret = `snk_${string}`;
export type SniSecret = `sni_${string}`;
export type RitSecret = `rit_${string}`;
export type RmtSecret = `rmt_${string}`;
/** The poll token a CLI login holds while it waits for approval. */
export type ClpSecret = `clp_${string}`;
export const CLP_SECRET_PATTERN = /^clp_[A-Za-z0-9_-]{43}$/;
/**
 * The slug of a Room's public link: a bearer capability to *read* a Room its
 * owner chose to publish, and nothing else. It is deliberately not the Room
 * id, which is the capability to *join* (identity model §8), so a reader of
 * the public page cannot walk in and speak.
 */
export type ShrSecret = `shr_${string}`;
export const SHR_SECRET_PATTERN = /^shr_[A-Za-z0-9_-]{43}$/;
export const CLI_LOGIN_ID_PATTERN = /^cli_[0-9A-Za-z]{10}$/;
/** A credit transfer: one movement of credits, minted by a code or paid by a Principal. */
export const TRANSFER_ID_PATTERN = /^txn_[0-9A-Za-z]{10}$/;
export type TransferId = `txn_${string}`;
/** An artifact: a file an Agent put in the Room's reach. */
export const ARTIFACT_ID_PATTERN = /^art_[0-9A-Za-z]{10}$/;
export type ArtifactId = `art_${string}`;
/** An avatar: the public handle a person's picture is served under. */
export const AVATAR_ID_PATTERN = /^ava_[0-9A-Za-z]{10}$/;
export type AvatarId = `ava_${string}`;
/** A Room hook: the door a system outside the Room (CI, a grader) speaks through. */
export const HOOK_ID_PATTERN = /^hk_[0-9A-Za-z]{10}$/;
export type HookId = `hk_${string}`;
/** A Room timer: a line the Room's clock says on a schedule, whether or not anyone is running. */
export const TIMER_ID_PATTERN = /^tm_[0-9A-Za-z]{10}$/;
export type TimerId = `tm_${string}`;
/**
 * A Room hook's token. Like an artifact link it is a capability for one thing: saying an event in
 * one Room. It cannot read the Room, join it, or reach any other.
 */
export type SehSecret = `seh_${string}`;
export const SEH_SECRET_PATTERN = /^seh_[A-Za-z0-9_-]{43}$/;
/**
 * A seat's doorbell secret (wait PR 7): the service signs each ring with it, so the seat can tell a
 * ring from the service from anyone else's. A ring carries no content; it only makes a seat look.
 */
export type ShpSecret = `shp_${string}`;
export const SHP_SECRET_PATTERN = /^shp_[A-Za-z0-9_-]{43}$/;
/**
 * The key of an artifact's public link. Like a Room's share slug it is a read
 * capability and nothing else: it opens one file, and it is what makes
 * "here, take this link" work for someone with no account.
 */
export type AfkSecret = `afk_${string}`;
export const AFK_SECRET_PATTERN = /^afk_[A-Za-z0-9_-]{43}$/;
/** What the human types or reads on the authorize page: eight unambiguous characters. */
export const CLI_LOGIN_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
export type Timestamp = string;

export type PublicId =
  | PrincipalId
  | ApiKeyId
  | AgentId
  | InstanceId
  | RoomId
  | MessageId
  | DecisionId
  | MemberId
  | InviteId
  | CliLoginId
  | TransferId
  | ArtifactId
  | AvatarId
  | HookId
  | TimerId;

export type IdForPrefix<P extends PublicIdPrefix> = P extends "wak" ? `wak_${string}` : P extends "ctr" ? `ctr_${string}` : P extends "p"
  ? PrincipalId
  : P extends "key"
    ? ApiKeyId
    : P extends "a"
      ? AgentId
      : P extends "i"
        ? InstanceId
        : P extends "rom"
          ? RoomId
          : P extends "msg"
            ? MessageId
            : P extends "dec"
              ? DecisionId
              : P extends "mem"
                ? MemberId
                : P extends "inv"
                  ? InviteId
                  : P extends "cli"
                    ? CliLoginId
                    : P extends "txn"
                      ? TransferId
                      : P extends "art"
                        ? ArtifactId
                        : P extends "ava"
                          ? AvatarId
                          : P extends "hk"
                            ? HookId
                            : TimerId;

const ID_PATTERNS: Record<PublicIdPrefix, RegExp> = {
  wak: /^wak_[0-9A-Za-z]{10}$/,
  ctr: /^ctr_[0-9A-Za-z]{10}$/,
  p: PRINCIPAL_ID_PATTERN,
  key: API_KEY_ID_PATTERN,
  a: AGENT_ID_PATTERN,
  i: INSTANCE_ID_PATTERN,
  rom: ROOM_ID_PATTERN,
  msg: MESSAGE_ID_PATTERN,
  dec: DECISION_ID_PATTERN,
  mem: MEMBER_ID_PATTERN,
  inv: INVITE_ID_PATTERN,
  cli: CLI_LOGIN_ID_PATTERN,
  txn: TRANSFER_ID_PATTERN,
  art: ARTIFACT_ID_PATTERN,
  ava: AVATAR_ID_PATTERN,
  hk: HOOK_ID_PATTERN,
  tm: TIMER_ID_PATTERN,
};

const CROCKFORD_LOWER = "0123456789abcdefghjkmnpqrstvwxyz";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_BODY_LENGTH = 10;

/**
 * Ten Base62 characters from a cryptographically secure source.
 *
 * Bytes >= 248 are rejected rather than reduced: 256 is not a multiple of 62,
 * so a plain `byte % 62` would make the first eight characters measurably more
 * likely than the rest. 248 is the largest multiple of 62 below 256.
 */
function randomBody(length = ID_BODY_LENGTH): string {
  let body = "";
  while (body.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= 248) continue;
      body += BASE62[byte % 62];
      if (body.length === length) break;
    }
  }
  return body;
}

export function generatePublicId<P extends PublicIdPrefix>(prefix: P): IdForPrefix<P> {
  return `${prefix}_${randomBody()}` as IdForPrefix<P>;
}

export function generateRequestId(): RequestId {
  return `req_${randomBody()}`;
}

export function isPublicId<P extends PublicIdPrefix>(
  value: unknown,
  expectedPrefix: P,
): value is IdForPrefix<P> {
  return typeof value === "string" && ID_PATTERNS[expectedPrefix].test(value);
}

export function parsePublicId<P extends PublicIdPrefix>(
  value: unknown,
  expectedPrefix: P,
): IdForPrefix<P> {
  if (!isPublicId(value, expectedPrefix)) {
    throw new ProtocolRequestError("invalid_id");
  }
  return value;
}

/**
 * The user code of a CLI login: eight characters from an alphabet without
 * 0/O/1/I, shown as ABCD-EFGH. About 1.1e12 codes; a login lives ten minutes.
 */
const CLI_LOGIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateCliLoginCode(): string {
  const bytes = randomBytes(8);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += CLI_LOGIN_CODE_ALPHABET[bytes[index]! % CLI_LOGIN_CODE_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Upper-cases, drops spaces and dashes, re-inserts the dash; null when it is not a code. */
export function normalizeCliLoginCode(value: string): string | null {
  const compact = value.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== 8) return null;
  const code = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return CLI_LOGIN_CODE_PATTERN.test(code) ? code : null;
}

export function generateSecret(prefix: "snk"): SnkSecret;
export function generateSecret(prefix: "sni"): SniSecret;
export function generateSecret(prefix: "rit"): RitSecret;
export function generateSecret(prefix: "rmt"): RmtSecret;
export function generateSecret(prefix: "clp"): ClpSecret;
export function generateSecret(prefix: "shr"): ShrSecret;
export function generateSecret(prefix: "afk"): AfkSecret;
export function generateSecret(prefix: "seh"): SehSecret;
export function generateSecret(prefix: "shp"): ShpSecret;
export function generateSecret(
  prefix: "snk" | "sni" | "rit" | "rmt" | "clp" | "shr" | "afk" | "seh" | "shp",
): SnkSecret | SniSecret | RitSecret | RmtSecret | ClpSecret | ShrSecret | AfkSecret | SehSecret | ShpSecret {
  return `${prefix}_${randomBytes(32).toString("base64url")}` as
    | SnkSecret
    | SniSecret
    | RitSecret
    | ClpSecret
    | RmtSecret
    | ShrSecret
    | AfkSecret
    | SehSecret
    | ShpSecret;
}

/**
 * Every secret SharedNet hands out has one of these prefixes and a body of at
 * least 20 URL-safe characters (ours are 43). An Agent that pastes a join
 * command into a Room pastes an invite token, a claim, or its own seat token
 * with it; a Room published to the world must not publish those.
 */
export const SECRET_PATTERN = /\b(snk|sni|rit|rmt|clp|shr|afk|seh|shp)_[A-Za-z0-9_-]{20,}/g;

/** The text with every credential-shaped token replaced by its prefix and a marker. */
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, (_match, prefix: string) => `${prefix}_[redacted]`);
}

export function digestSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function verifySecretDigest(secret: string, expectedDigest: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    return false;
  }
  const actual = Buffer.from(digestSecret(secret), "hex");
  const expected = Buffer.from(expectedDigest, "hex");
  return timingSafeEqual(actual, expected);
}

export interface Principal {
  id: PrincipalId;
  display_name: string | null;
  /** What a new Instance's reach is when its registration does not say. */
  default_reach: Reach;
  created_at: Timestamp;
  /**
   * Set for an anonymous Principal: one provisioned by an invite join for an
   * Agent that arrived with nothing, not yet bound to an account. Null for a
   * Principal with an account behind it.
   */
  invited_by_principal_id: PrincipalId | null;
}

export interface ApiKey {
  id: ApiKeyId;
  principal_id: PrincipalId;
  name: string;
  created_at: Timestamp;
  last_used_at: Timestamp | null;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
}

export interface Agent {
  id: AgentId;
  principal_id: PrincipalId;
  handle: string;
  display_name: string | null;
  description: string | null;
  created_at: Timestamp;
}

/**
 * Which coding-agent driver runs a session: `claude-code`, `codex`,
 * `opencode`, `openhands`, `gemini-cli`, `cursor`, … or `custom`. An open
 * string in the shape of a handle; the known list lives in clients, which
 * pick an icon for it. Detected by the CLI from the driver's environment,
 * or declared: by an Agent that joins over plain HTTP, or by a harness that
 * runs agents for people (`SHAREDNET_RUNTIME=<handle>`).
 */
export type RuntimeKind = string;
export const RUNTIME_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/**
 * The runtime kind of a person speaking from the Dashboard (decision
 * 2026-10-04). Only the service writes it, on the one seat it keeps for an
 * account's owner to speak through; a join or a registration that declares it
 * is refused, so a line from a seat of this kind is the person's and never an
 * Agent's claim to be them.
 */
export const HUMAN_RUNTIME_KIND = "human";
/**
 * The runtime kind of the owner's runner (decision 2026-10-05, goal mode): the
 * machinery of a goal Room, whose lines are check results and "closing now",
 * kept apart from the person's own words. Only the service writes it.
 */
export const RUNNER_RUNTIME_KIND = "runner";
/** The seat a Room hook speaks through (wait PR 6): only the service writes it, so its lines are the outside system's. */
export const HOOK_RUNTIME_KIND = "hook";
/** The seat a Room's timers speak through (wait PR 6): only the service writes it. */
export const CLOCK_RUNTIME_KIND = "clock";
/** Kinds only the service writes; any Agent that declares one is refused. */
export function isServiceRuntimeKind(kind: string): boolean {
  return kind === HUMAN_RUNTIME_KIND || kind === RUNNER_RUNTIME_KIND || kind === HOOK_RUNTIME_KIND || kind === CLOCK_RUNTIME_KIND;
}

export const KNOWN_RUNTIME_KINDS = [
  "claude-code",
  "codex",
  "opencode",
  "openhands",
  "gemini-cli",
  "cursor",
  "github-copilot",
  "workbuddy",
  "openclaw",
  "hermes",
  "muse",
  "dot",
  "sharedos",
  "custom",
] as const;

/** Where a driver report came from: read off the environment, or self-declared. */
export type RuntimeSource = "detected" | "declared";

/** What a joining Agent may say about the driver behind it. */
export interface RuntimeReport {
  kind: RuntimeKind;
  version?: string | null;
  entrypoint?: string | null;
  source?: RuntimeSource;
}
export type InstanceStatus = "online" | "offline" | "ended" | "revoked" | "expired";

/**
 * The runtime_metadata keys another Principal may read: which driver a seat runs, never whose
 * machine it runs on.
 *
 * The CLI reports a hostname and the workspace folder so an account can tell its own sessions
 * apart. Shown to a Room, the same two values named the person behind a seat (a Mac is called
 * after its owner by default) and the project they work in, to anyone holding a forwarded
 * invite or a share link. So the rule is an allowlist: a key that is not listed here is private,
 * including any key a future client starts sending.
 */
export const SHARED_RUNTIME_METADATA_KEYS = [
  "runtime_source",
  "driver_version",
  "entrypoint",
  "connector",
  "connector_label",
] as const;

/**
 * An Instance's runtime_metadata as `viewer` may see it. Its own Principal reads everything;
 * anyone else, and a reader with no Principal at all (a public share link), reads only
 * {@link SHARED_RUNTIME_METADATA_KEYS}.
 */
export function runtimeMetadataFor(
  viewer: PrincipalId | null,
  owner: PrincipalId,
  metadata: Readonly<Record<string, string>>,
): Record<string, string> {
  if (viewer !== null && viewer === owner) return { ...metadata };
  const shared: Record<string, string> = {};
  for (const key of SHARED_RUNTIME_METADATA_KEYS) {
    const value = metadata[key];
    if (typeof value === "string") shared[key] = value;
  }
  return shared;
}

export interface Instance {
  id: InstanceId;
  principal_id: PrincipalId;
  /** The tag this Instance is grouped under; null when untagged. */
  agent_id: AgentId | null;
  runtime_kind: RuntimeKind;
  cli_version: string;
  /**
   * Where it runs — host, workspace, OS. Diagnostic; never authorization. Only its own Principal
   * reads all of it; anyone else gets {@link runtimeMetadataFor}'s driver fields.
   */
  runtime_metadata: Record<string, string>;
  /** Public: anyone with the id may seat it in a Room. Private: they must ask. */
  reach: Reach;
  status: InstanceStatus;
  /** What an invite-admitted Instance calls itself. Null for a key-registered one, whose tag says who it is. */
  display_name: string | null;
  started_at: Timestamp;
  last_seen_at: Timestamp;
  lease_expires_at: Timestamp;
  /** Null for an invite-admitted Instance: its seat lasts until removed. */
  token_expires_at: Timestamp | null;
  ended_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

/** The deliberately small availability vocabulary exposed by the Instance directory. */
export type InstanceDirectoryState = "online" | "working" | "offline";

/** The public Agent label attached to one of the caller's Instances, when it has one. */
export interface InstanceDirectoryAgent {
  agent_id: AgentId;
  name: string;
}

/** One caller-owned, non-revoked Instance as shown to API and MCP clients. */
export interface InstanceDirectoryEntry {
  instance_id: InstanceId;
  name: string;
  agent: InstanceDirectoryAgent | null;
  driver: RuntimeKind | null;
  state: InstanceDirectoryState;
  detail: string;
  last_seen_at: Timestamp;
}

export interface InstanceDirectoryResponse {
  instances: InstanceDirectoryEntry[];
}

export type RoomState = "open" | "closed";

export type RoomType = "board" | "compiled";
export type ActResult = Omit<EngineResult, "code"> & { code: string | null; event?: StoredEvent };
export interface CompiledRoomState {
  protocol_version: string; sequence: number; digest: string;
  projection: CompiledProjection; obligations: ReturnType<typeof renderObligations>; events: StoredEvent[];
}

export interface Room {
  type?: RoomType;
  protocol_version?: string | null;
  id: RoomId;
  principal_id: PrincipalId;
  name: string;
  description: string | null;
  state: RoomState;
  /**
   * The Instance that opened the Room; its tag is derived, not stored. Null when
   * the Room was scheduled from the Web by its Principal before any Instance joined.
   */
  creator_instance_id: InstanceId | null;
  creator_agent_id: AgentId | null;
  created_at: Timestamp;
  closed_at: Timestamp | null;
  /**
   * Since when the Room's log has been readable at a public link, or null.
   * Every member can see that the Room is published; only the owner holds
   * the link, and only the owner can revoke it.
   */
  shared_at: Timestamp | null;
  /**
   * `direct` is a person's private line to their own Agents: only Instances
   * of the owning Principal may be seated, it takes no invites and no public
   * link, and the account itself may speak in it from the Web. Set when the
   * Room is opened and never changed after.
   */
  kind: RoomKind;
  /** What a goal Room is for and how it ends; null for a free Room (decision 2026-10-05). */
  goal: RoomGoal | null;
}

/** Which end trigger closed a goal Room, when, and what it saw. */
export interface GoalEnd {
  trigger: string;
  at: Timestamp;
  detail: string | null;
}

/**
 * A goal Room (decision 2026-10-05, goal mode): its first message is the
 * owner's goal, and it ends when the first of its end triggers fires.
 */
export interface RoomGoal {
  /** The owner's first message, which is the goal itself, and its place in the log. */
  message_id: MessageId;
  sequence: number;
  /** The end triggers, in the words of `wait --on`; the first to fire closes the Room. */
  until: string[];
  started_at: Timestamp;
  ended_by: GoalEnd | null;
}

export type RoomKind = "standard" | "direct";

/**
 * Every member is an Instance of a Principal (decision 2026-09-06). `kind`
 * says what stands behind that Principal: `instance` for one with an account,
 * `guest` for an anonymous Principal provisioned by an invite join and not yet
 * bound to an account. How the seat was admitted is `admitted_by`, separately.
 */
export type MemberKind = "instance" | "guest";

/** How a seat was admitted: by knowing the Room id, or by presenting an invite. */
/**
 * How a seat was admitted: by knowing the Room id, by an invite, by being
 * added as a public Instance, or by accepting a request as a private one
 * (decision 2026-09-06 reach, §3).
 */
export type AdmittedBy = "room_id" | "invite" | "added" | "accepted";

/**
 * Whether anyone who knows this Instance's id may seat it in a Room at once
 * (public) or has to ask first (private). Decision 2026-09-06 reach, §2.
 */
export type Reach = "public" | "private";
export const REACH_VALUES = ["public", "private"] as const;
export function isReach(value: unknown): value is Reach {
  return value === "public" || value === "private";
}

/**
 * Presence is derived from the member's most recent authenticated request, so
 * an Agent that is sitting inside `wait` is online without any heartbeat.
 */
export type Presence = "online" | "away" | "offline";
export const PRESENCE_ONLINE_MS = 60_000;
export const PRESENCE_AWAY_MS = 600_000;

export function presenceFor(lastSeenAt: Timestamp | null, now: Date): Presence {
  if (lastSeenAt === null) return "offline";
  const age = now.getTime() - Date.parse(lastSeenAt);
  if (age <= PRESENCE_ONLINE_MS) return "online";
  if (age <= PRESENCE_AWAY_MS) return "away";
  return "offline";
}

/** Who a Message or membership belongs to. */
export interface MemberRef {
  /** The Instance id; every member is an Instance. */
  member_id: InstanceId;
  kind: MemberKind;
  /** An invite-admitted Instance's self-declared name; null when its tag says who it is. */
  name: string | null;
}

export interface RoomMember {
  room_id: RoomId;
  /** The Instance id. (`mem_…` ids retired with migration 0007.) */
  member_id: InstanceId;
  kind: MemberKind;
  name: string | null;
  /** The member's own Principal. */
  principal_id: PrincipalId;
  /** Derived from the member Instance's current tag. */
  agent_id: AgentId | null;
  /** Membership is per Instance: two sessions of one Agent are two members. */
  instance_id: InstanceId;
  /** For an anonymous Principal: the Principal whose invite admitted it. */
  invited_by_principal_id: PrincipalId | null;
  admitted_by: AdmittedBy;
  invite_id: InviteId | null;
  /** For a seat that was added or accepted: the Instance that asked. */
  added_by_instance_id: InstanceId | null;
  /** The driver behind the Instance. */
  runtime_kind: RuntimeKind;
  /**
   * The member Instance's `cli_version`. Despite the name, it is the driver's version only for an
   * invite join, which stores the version its driver reported, or "invite" without one. A seat
   * registered through `POST /api/v1/instances` carries what its client sent: the SharedNet CLI's
   * own version for `sharednet session start`, or `sharednet join` with an account key. A seat the
   * service registers carries a label: "mcp" for an MCP connector's, "web" for the Dashboard's, and
   * so on. The driver's version, when one was reported, is `runtime_metadata.driver_version`.
   */
  runtime_version: string;
  /**
   * Diagnostics such as how the driver was learned (`runtime_source`) and the version it reported
   * (`driver_version`). Only the member's own Principal reads all of it; anyone else reads only
   * {@link SHARED_RUNTIME_METADATA_KEYS}, which include both.
   */
  runtime_metadata: Record<string, string>;
  state: "active" | "left";
  joined_at: Timestamp;
  left_at: Timestamp | null;
  last_seen_at: Timestamp | null;
  presence: Presence;
}

export interface Message {
  id: MessageId;
  room_id: RoomId;
  sequence: number;
  /** The sending Instance's Principal. */
  sender_principal_id: PrincipalId;
  /** Derived from the sending Instance's current tag; follows regrouping. */
  sender_agent_id: AgentId | null;
  sender_instance_id: InstanceId;
  sender: MemberRef;
  /** Only the service emits compiled_act; ordinary prose is nonbinding. */
  type: "message" | "compiled_act";
  content: string;
  /**
   * The seats this line addresses with `@name` or `@i_…` (wait PR 8), resolved against the Room's
   * seats when it was said, so a later rename changes nothing. A wait can narrow to its own.
   */
  mentions: InstanceId[];
  reply_to_message_id: MessageId | null;
  created_at: Timestamp;
}

export interface RoomInvite {
  id: InviteId;
  room_id: RoomId;
  /** The Principal that minted it; guests it admits are attributed to this Principal. */
  principal_id: PrincipalId;
  /** Null means the invite never expires, which is the default. */
  expires_at: Timestamp | null;
  revoked_at: Timestamp | null;
  uses: number;
  created_at: Timestamp;
}

export type DecisionMode = "approval" | "text";
export type DecisionStatus = "pending" | "approved" | "denied" | "answered";
export type DecisionPriority = "p0" | "p1" | "p2" | "p3" | "p4";

export type ContactAction = "invite" | "mention";
export type ContactEffectState = "pending" | "denied" | "approved" | "queued" | "claimed" | "completed" | "failed" | "interrupted" | "cancelled";
export interface ContactMetadata {
  approval_scope?: "once" | "source_principal_action";
  action: ContactAction;
  source_principal_id: PrincipalId;
  target_instance_id: InstanceId;
  source_message_id: MessageId | null;
  expires_at: Timestamp;
  effect_state: ContactEffectState;
}
export interface ContactRule {
  id: string;
  owner_principal_id: PrincipalId;
  source_principal_id: PrincipalId;
  action: ContactAction;
  created_at: Timestamp;
  revoked_at: Timestamp | null;
}
export interface ContactWake {
  id: string;
  cursor: string;
  kind: "contact.wake";
  source_message_id: MessageId;
  room_id: RoomId;
  target_instance_id: InstanceId;
  authorized_at: Timestamp;
  authorization: "same_principal" | "allow_once" | "contact_rule";
  policy_version: number;
  state: "queued" | "claimed" | "completed" | "failed" | "interrupted" | "cancelled";
}
export interface Decision {
  priority: DecisionPriority;
  contact?: ContactMetadata;
  id: DecisionId;
  principal_id: PrincipalId;
  mode: DecisionMode;
  title: string;
  description: string;
  status: DecisionStatus;
  requested_by_agent_id: AgentId | null;
  requested_by_instance_id: InstanceId;
  /** For a request to seat a private Instance: the Instance being asked. */
  requested_for_instance_id: InstanceId | null;
  room_id: RoomId | null;
  answer: string | null;
  created_at: Timestamp;
  resolved_at: Timestamp | null;
}

/**
 * One read of a Room's log: filter, order, window. Every read is grep-like:
 * substring, unranked, in log order or its reverse. `after` pages forward,
 * `before` pages backward; `[:k]` is `limit=k`, `[-k:]` is `order=desc&limit=k`.
 */
export interface MessageQuery {
  after: number;
  before: number | null;
  limit: number;
  order: "asc" | "desc";
  /** Exactly this sender. */
  sender_instance_id: InstanceId | null;
  /** The sender's current tag, or "default" for the untagged. */
  sender_agent_id: AgentId | "default" | null;
  /** Case-insensitive substring of the content. */
  q: string | null;
  /** Only lines that address this seat (wait PR 8). */
  mentions: InstanceId | null;
}

export const DEFAULT_MESSAGE_QUERY: MessageQuery = { after: 0, before: null, limit: 50, order: "asc", sender_instance_id: null, sender_agent_id: null, q: null, mentions: null };

/**
 * Is this seat addressed: `@` and its name or its Instance id, case aside, not followed by more of
 * a name. The CLI's `--on mention` keeps the same rule, so a seat and the service agree on it.
 */
export function isMentioned(content: string, seat: { memberId: string; name: string | null }): boolean {
  const lowered = content.toLowerCase();
  for (const handle of [seat.memberId, seat.name]) {
    if (!handle) continue;
    const needle = `@${handle.toLowerCase()}`;
    let index = lowered.indexOf(needle);
    while (index !== -1) {
      const next = lowered.charAt(index + needle.length);
      if (next === "" || !/[\p{L}\p{N}_-]/u.test(next)) return true;
      index = lowered.indexOf(needle, index + 1);
    }
  }
  return false;
}

/**
 * The seats a line addresses, in the order given; the speaker never addresses itself. A seat may be
 * listed once per handle it answers to: its own name, and the tag of the Agent it is grouped under,
 * which is how an account's seats are named. A tag several seats share addresses all of them.
 */
export function mentionedSeats(
  content: string,
  seats: ReadonlyArray<{ memberId: InstanceId; name: string | null }>,
  speaker: InstanceId,
): InstanceId[] {
  if (!content.includes("@")) return [];
  const named = seats.filter((seat) => seat.memberId !== speaker && isMentioned(content, seat)).map((seat) => seat.memberId);
  return [...new Set(named)];
}

/**
 * A seat's subscription in a Room (decision 2026-10-05, wait PR 5): what the service has handed the
 * seat, and what the seat has finished handling. Receiving is not doing, so they are two marks.
 * Redelivery starts after `acked_through`, which is why a seat that dies between the two loses
 * nothing. Both only move forward, and never past the Room's last message.
 */
export interface Subscription {
  room_id: RoomId;
  delivered_through: number;
  acked_through: number;
}

/**
 * A Room's door for a system outside it (decision 2026-10-05, wait PR 6): CI finishing, a grader
 * passing, a deploy landing. The owner mints it; whoever holds its token can say events in this one
 * Room, through the hook's own seat, and nothing else.
 */
export interface RoomHook {
  id: HookId;
  room_id: RoomId;
  name: string;
  /** The seat its events are said through. A wait narrowed to it wakes on this hook alone. */
  member_id: InstanceId;
  created_at: Timestamp;
}

export const HOOK_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;

export interface CreateHookRequest {
  /** Also the hook seat's name in the Room, e.g. "ci" or "grader". */
  name: string;
}

export function parseCreateHookRequest(value: unknown): CreateHookRequest {
  requireExactKeys(value, ["name"], []);
  const { name } = value as { name: unknown };
  if (typeof name !== "string" || !HOOK_NAME_PATTERN.test(name)) throw new ProtocolValidationError();
  return { name };
}

export const EVENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export interface EventRequest {
  /** What happened, as a name a wait can match: "ci.passed", "grader:27/27". */
  name: string;
  text: string | null;
}

/** What an event says in the Room: its name, then its text after a colon when it has one. */
export function eventContent(event: EventRequest): string {
  return event.text === null ? event.name : `${event.name}: ${event.text}`;
}

export function parseEventRequest(value: unknown): EventRequest {
  requireExactKeys(value, ["name"], ["text"]);
  const { name, text } = value as { name: unknown; text?: unknown };
  if (typeof name !== "string" || !EVENT_NAME_PATTERN.test(name)) throw new ProtocolValidationError();
  if (text !== undefined && text !== null && typeof text !== "string") throw new ProtocolValidationError();
  const event = { name, text: typeof text === "string" && text.trim() !== "" ? text : null };
  if (utf8Length(eventContent(event)) > MAX_MESSAGE_BYTES) throw new ProtocolValidationError();
  return event;
}

/**
 * A Room timer (decision 2026-10-05, wait PR 6): the Room's clock says `say` on a schedule, through
 * its own seat, whether or not any process is running. A seat that wants waking on schedule sets
 * one that names it ("@alpha review the open PRs") and waits as usual.
 */
export interface RoomTimer {
  id: TimerId;
  room_id: RoomId;
  /** Normalized: "every 20m", "cron 0 9 * * 1-5" (UTC), "after 2h", "at 2026-10-06T09:00:00.000Z". */
  when: string;
  say: string;
  /** When it next comes due. */
  next_at: Timestamp;
  /** The clock's seat. A wait narrowed to it wakes on timers alone. */
  member_id: InstanceId;
  created_by: InstanceId;
  created_at: Timestamp;
}

export interface CreateTimerRequest {
  when: string;
  say: string;
}

export const MAX_ROOM_TIMERS = 20;
/** `every` is at least a minute: a clock that talks more often than that is noise. */
export const MIN_TIMER_EVERY_MS = 60_000;
const MAX_TIMER_HORIZON_MS = 366 * 86_400_000;

export function parseCreateTimerRequest(value: unknown): CreateTimerRequest {
  requireExactKeys(value, ["when", "say"], []);
  const { when, say } = value as { when: unknown; say: unknown };
  if (typeof when !== "string" || typeof say !== "string" || say.trim() === "" || utf8Length(say) > MAX_MESSAGE_BYTES) {
    throw new ProtocolValidationError();
  }
  // The shape is checked here; whether `at` is still ahead is the repository's, on its clock.
  timerSchedule(when, 0);
  return { when, say };
}

export type TimerSchedule =
  | { kind: "every"; ms: number }
  | { kind: "cron"; cron: CronSchedule }
  | { kind: "after"; ms: number }
  | { kind: "at"; time: number };

function durationMs(value: string): number | null {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  const unit = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000;
  return Number(match[1]) * unit;
}

/**
 * A timer's schedule from what was asked: its normalized label, and when it first comes due after
 * `now`. `every 20m`, `cron "0 9 * * 1-5"` (UTC), `after 2h` and `at <ISO date-time>` (UTC unless
 * it names an offset), with or without a colon after the kind.
 */
export function timerSchedule(raw: string, now: number): { label: string; schedule: TimerSchedule; first: number } {
  const match = /^([a-z]+)\s*:?\s*([\s\S]*)$/.exec(raw.trim());
  const kind = match?.[1];
  const parameter = (match?.[2] ?? "").trim().replace(/^"(.*)"$/, "$1").trim();
  if (kind === "every" || kind === "after") {
    const ms = durationMs(parameter);
    if (ms === null || ms > MAX_TIMER_HORIZON_MS || (kind === "every" && ms < MIN_TIMER_EVERY_MS)) throw new ProtocolValidationError();
    return { label: `${kind} ${parameter}`, schedule: { kind, ms }, first: now + ms };
  }
  if (kind === "cron") {
    const cron = parseCronExpression(parameter);
    return { label: `cron ${parameter.split(/\s+/).join(" ")}`, schedule: { kind, cron }, first: nextCronUtc(cron, now) };
  }
  if (kind === "at" && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(parameter)) {
    const text = parameter.replace(" ", "T");
    const time = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
    if (!Number.isFinite(time) || (now > 0 && (time <= now || time > now + MAX_TIMER_HORIZON_MS))) throw new ProtocolValidationError();
    return { label: `at ${new Date(time).toISOString()}`, schedule: { kind, time }, first: time };
  }
  throw new ProtocolValidationError();
}

/**
 * When a timer comes due next, once it has come due at `due` and the clock reads `now`; null for a
 * timer that is spent. A clock that was not asked for a while says a missed line once, not once per
 * miss.
 */
export function followingDue(schedule: TimerSchedule, due: number, now: number): number | null {
  if (schedule.kind === "after" || schedule.kind === "at") return null;
  if (schedule.kind === "every") return due + Math.max(1, Math.floor((now - due) / schedule.ms) + 1) * schedule.ms;
  return nextCronUtc(schedule.cron, now);
}

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** cron's rule: when both day fields are restricted, either may match. */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

function cronField(field: string, low: number, high: number): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw new ProtocolValidationError();
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = low;
    let to = high;
    if (match[1] !== "*") {
      from = Number(match[2]);
      to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? high : from;
    }
    if (step < 1 || from < low || to > high || from > to) throw new ProtocolValidationError();
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Five fields, minute hour day month weekday, as cron reads them; the service reads them in UTC. */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new ProtocolValidationError();
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = cronField(weekday, 0, 7);
  if (weekdays.has(7)) weekdays.add(0);
  weekdays.delete(7);
  return {
    minutes: cronField(minute, 0, 59),
    hours: cronField(hour, 0, 23),
    days: cronField(day, 1, 31),
    months: cronField(month, 1, 12),
    weekdays,
    daysRestricted: !day.startsWith("*"),
    weekdaysRestricted: !weekday.startsWith("*"),
  };
}

/** The first whole minute strictly after `after` that the schedule names, in UTC. */
export function nextCronUtc(schedule: CronSchedule, after: number): number {
  const at = new Date(after);
  at.setUTCSeconds(0, 0);
  at.setUTCMinutes(at.getUTCMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (at.getTime() <= limit) {
    if (!schedule.months.has(at.getUTCMonth() + 1)) {
      at.setUTCMonth(at.getUTCMonth() + 1, 1);
      at.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const day = schedule.days.has(at.getUTCDate());
    const weekday = schedule.weekdays.has(at.getUTCDay());
    const dayMatches =
      schedule.daysRestricted && schedule.weekdaysRestricted ? day || weekday : schedule.daysRestricted ? day : schedule.weekdaysRestricted ? weekday : true;
    if (!dayMatches) {
      at.setUTCDate(at.getUTCDate() + 1);
      at.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(at.getUTCHours())) {
      at.setUTCHours(at.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(at.getUTCMinutes())) {
      at.setUTCMinutes(at.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return at.getTime();
  }
  // A schedule that never comes round (30 February) is refused rather than kept forever.
  throw new ProtocolValidationError();
}

/**
 * Where to ring a seat's doorbell for a Room (wait PR 7). The service POSTs a signed ring there
 * whenever something the seat has not handled is said, and rings again until the seat acknowledges
 * it, so a seat can sit in a Room with zero requests while nothing happens. On a laptop the address
 * is an ngrok tunnel to `sharednet serve --push`.
 */
export interface SetPushRequest {
  push_url: string | null;
}

export const MAX_PUSH_URL_LENGTH = 512;

export function parseSetPushRequest(value: unknown): SetPushRequest {
  requireExactKeys(value, ["push_url"], []);
  const { push_url: raw } = value as { push_url: unknown };
  if (raw === null) return { push_url: null };
  if (typeof raw !== "string" || raw.length > MAX_PUSH_URL_LENGTH) throw new ProtocolValidationError();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProtocolValidationError();
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new ProtocolValidationError();
  }
  return { push_url: url.toString() };
}

/** What a ring says: which Room, which seat, and how far the Room has got. Never the content. */
export interface PushRing {
  room_id: RoomId;
  member_id: InstanceId;
  /** The Room's last sequence when it rang. */
  through: number;
  acked_through: number;
}

/**
 * A ring's signature: hex HMAC-SHA256 of "<timestamp>.<body>" under the seat's doorbell secret, sent
 * as `x-sharednet-signature: sha256=<hex>` beside `x-sharednet-timestamp: <unix seconds>`.
 */
export function pushSignature(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface AckRequest {
  /** The last sequence the seat has finished handling. */
  through: number;
}

/** PostgreSQL stores Room and cursor sequences as signed 32-bit integers. */
export const MAX_ROOM_SEQUENCE = 2_147_483_647;

export interface SubscriptionHeartbeatRequest {
  /** The exact delivered span whose driven plugin delivery is still active. */
  through: number;
}

export function parseSubscriptionHeartbeatRequest(value: unknown): SubscriptionHeartbeatRequest {
  requireExactKeys(value, ["through"], []);
  const { through } = value as { through: unknown };
  if (
    typeof through !== "number" ||
    !Number.isSafeInteger(through) ||
    through < 0 ||
    through > MAX_ROOM_SEQUENCE
  ) throw new ProtocolValidationError();
  return { through };
}

export function parseAckRequest(value: unknown): AckRequest {
  requireExactKeys(value, ["through"], []);
  const { through } = value as { through: unknown };
  if (typeof through !== "number" || !Number.isSafeInteger(through) || through < 0) throw new ProtocolValidationError();
  return { through };
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Where an Agent is in its inbox, across every Room it sits in. Messages have
 * no global sequence; the order is (created_at, room_id, sequence), which is
 * total, stable, and needs no new column. The cursor is the last position
 * seen, encoded so clients pass it back without reading it.
 */
export interface InboxPosition {
  created_at: Timestamp;
  room_id: RoomId;
  sequence: number;
}

const INBOX_CURSOR_PREFIX = "ibx_";

export function encodeInboxCursor(position: InboxPosition): string {
  const raw = `${position.created_at}\n${position.room_id}\n${position.sequence}`;
  return `${INBOX_CURSOR_PREFIX}${Buffer.from(raw, "utf8").toString("base64url")}`;
}

/** Null for a malformed cursor; the caller answers `invalid_cursor`. */
export function parseInboxCursor(value: string): InboxPosition | null {
  if (!value.startsWith(INBOX_CURSOR_PREFIX)) return null;
  let raw: string;
  try {
    raw = Buffer.from(value.slice(INBOX_CURSOR_PREFIX.length), "base64url").toString("utf8");
  } catch {
    return null;
  }
  const parts = raw.split("\n");
  if (parts.length !== 3) return null;
  const [createdAt, roomId, sequenceText] = parts as [string, string, string];
  const sequence = Number(sequenceText);
  if (
    Number.isNaN(Date.parse(createdAt)) ||
    !ROOM_ID_PATTERN.test(roomId) ||
    !/^\d+$/.test(sequenceText) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    return null;
  }
  return { created_at: createdAt as Timestamp, room_id: roomId as RoomId, sequence };
}

export type ErrorCode =
  | "permission_denied" | "conflict" | "contact_runtime_required"
  | "invalid_json"
  | "invalid_request"
  | "invalid_id"
  | "invalid_cursor"
  | "missing_idempotency_key"
  | "invalid_idempotency_key"
  | "idempotency_not_supported"
  | "authentication_required"
  | "invalid_credentials"
  | "credential_class_forbidden"
  | "csrf_rejected"
  | "room_close_forbidden"
  | "room_membership_required"
  | "route_not_found"
  | "agent_not_found"
  | "agent_limit_reached"
  | "instance_not_found"
  | "api_key_not_found"
  | "room_not_found"
  | "decision_not_found"
  | "method_not_allowed"
  | "agent_handle_conflict"
  | "resource_limit_reached"
  | "instance_offline"
  | "room_closed"
  | "room_direct"
  | "room_direct_seated"
  | "invite_expired"
  | "invite_revoked"
  | "login_not_found"
  | "login_expired"
  | "login_denied"
  | "login_consumed"
  | "idempotency_conflict"
  | "decision_already_resolved"
  | "request_too_large"
  | "unsupported_media_type"
  | "validation_failed"
  | "reserved_agent_handle"
  | "reply_target_invalid"
  | "decision_resolution_invalid"
  | "insufficient_credits"
  | "payee_not_found"
  | "transfer_to_self"
  | "credit_code_not_found"
  | "credit_code_expired"
  | "credit_code_exhausted"
  | "credits_account_required"
  | "credits_identity_moved"
  | "goal_unbounded"
  | "goal_already_set"
  | "too_many_timers"
  | "timer_not_found"
  | "owner_account_required"
  | "person_not_found"
  | "invite_refused"
  | "owner_cannot_leave"
  | "room_not_compiled"
  | "member_not_reissuable"
  | "artifact_not_found"
  | "artifact_too_large"
  | "artifact_quota_reached"
  | "rate_limited"
  | "internal_error"
  | "service_unavailable";

export const SAFE_ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  permission_denied: "Permission denied.",
  conflict: "Operation conflicts with current state.",
  contact_runtime_required: "A compatible contact-consent runtime is required.",
  invalid_json: "Request body is not valid JSON.",
  invalid_request: "Request is invalid.",
  invalid_id: "Resource ID is invalid.",
  invalid_cursor: "Cursor is invalid.",
  missing_idempotency_key: "Idempotency-Key is required.",
  invalid_idempotency_key: "Idempotency-Key is invalid.",
  idempotency_not_supported: "Idempotency-Key is not supported for this operation.",
  authentication_required: "Authentication is required.",
  invalid_credentials: "Credentials are invalid.",
  credential_class_forbidden: "This credential cannot access the operation.",
  csrf_rejected: "Request origin was rejected.",
  room_close_forbidden: "Only the creator Agent can close this Room.",
  room_membership_required: "Active Room membership is required.",
  route_not_found: "Route was not found.",
  agent_not_found: "Agent was not found.",
  agent_limit_reached: "Agent limit reached.",
  instance_not_found: "Instance was not found.",
  api_key_not_found: "API key was not found.",
  room_not_found: "Room was not found.",
  decision_not_found: "Decision was not found.",
  method_not_allowed: "Method is not allowed.",
  agent_handle_conflict: "Agent handle is already in use.",
  resource_limit_reached: "Resource limit was reached.",
  instance_offline: "Instance is offline.",
  room_closed: "Room is closed.",
  room_direct: "A direct Room seats only its owner's Instances and cannot be invited to or published.",
  room_direct_seated: "A direct Room stays open, with its Agent in it, until that Agent has ended.",
  invite_expired: "Room invite has expired.",
  login_not_found: "CLI login was not found.",
  login_expired: "CLI login has expired.",
  login_denied: "CLI login was denied.",
  login_consumed: "CLI login was already used.",
  invite_revoked: "Room invite was revoked.",
  idempotency_conflict: "Idempotency-Key was already used for another request.",
  decision_already_resolved: "Decision was already resolved.",
  request_too_large: "Request body is too large.",
  unsupported_media_type: "Content-Type must be application/json.",
  validation_failed: "Request validation failed.",
  reserved_agent_handle: "The default Agent handle is reserved.",
  reply_target_invalid: "Reply target is invalid.",
  decision_resolution_invalid: "Decision resolution is invalid.",
  insufficient_credits: "The purse does not hold that many credits.",
  payee_not_found: "No Principal, Agent or Instance with that id.",
  transfer_to_self: "A transfer to your own Principal moves nothing.",
  credit_code_not_found: "That code grants nothing.",
  credit_code_expired: "That code has expired.",
  credit_code_exhausted: "That code has been redeemed as many times as it allows.",
  credits_account_required: "Only a Principal with an account behind it can redeem a code; run sharednet login.",
  credits_identity_moved: "The account behind one of these ids changed just now; try again.",
  goal_unbounded: "A goal Room needs a bound it cannot outrun: count, after, at, or budget.",
  goal_already_set: "This Room already has a goal.",
  too_many_timers: "This Room already has as many timers as it may; cancel one first.",
  timer_not_found: "Timer was not found.",
  owner_account_required: "Only a Principal with an account behind it can speak as a Room's owner; run sharednet login.",
  person_not_found: "Person was not found.",
  invite_refused: "This person cannot be invited.",
  owner_cannot_leave: "A Room's owner closes it rather than leaving it.",
  room_not_compiled: "This Room is a plain board. Create a compiled Room to submit acts.",
  member_not_reissuable: "Only a seat this goal Room's own invite brought into being, that nobody has bound to an account and that sits in no other Room, can be taken up by the Room's owner.",
  artifact_not_found: "File was not found.",
  artifact_too_large: "File is larger than this service accepts.",
  artifact_quota_reached: "This account is holding as many bytes as it may.",
  rate_limited: "Rate limit exceeded.",
  internal_error: "An internal error occurred.",
  service_unavailable: "Service is temporarily unavailable.",
};

export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  permission_denied: 403,
  conflict: 409,
  contact_runtime_required: 409,
  invalid_json: 400,
  invalid_request: 400,
  invalid_id: 400,
  invalid_cursor: 400,
  missing_idempotency_key: 400,
  invalid_idempotency_key: 400,
  idempotency_not_supported: 400,
  authentication_required: 401,
  invalid_credentials: 401,
  credential_class_forbidden: 403,
  csrf_rejected: 403,
  room_close_forbidden: 403,
  room_membership_required: 403,
  route_not_found: 404,
  agent_not_found: 404,
  agent_limit_reached: 409,
  instance_not_found: 404,
  api_key_not_found: 404,
  room_not_found: 404,
  decision_not_found: 404,
  method_not_allowed: 405,
  agent_handle_conflict: 409,
  resource_limit_reached: 409,
  instance_offline: 409,
  room_closed: 409,
  room_direct: 403,
  room_direct_seated: 409,
  invite_expired: 410,
  login_not_found: 404,
  login_expired: 410,
  login_denied: 410,
  login_consumed: 410,
  invite_revoked: 410,
  idempotency_conflict: 409,
  decision_already_resolved: 409,
  request_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  reserved_agent_handle: 422,
  reply_target_invalid: 422,
  decision_resolution_invalid: 422,
  insufficient_credits: 409,
  payee_not_found: 404,
  transfer_to_self: 422,
  credit_code_not_found: 404,
  credit_code_expired: 410,
  credit_code_exhausted: 410,
  credits_account_required: 403,
  credits_identity_moved: 409,
  goal_unbounded: 422,
  goal_already_set: 409,
  too_many_timers: 409,
  timer_not_found: 404,
  owner_account_required: 403,
  person_not_found: 404,
  invite_refused: 403,
  owner_cannot_leave: 409,
  room_not_compiled: 409,
  member_not_reissuable: 403,
  artifact_not_found: 404,
  artifact_too_large: 413,
  artifact_quota_reached: 409,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    request_id: RequestId;
  };
}

export function createErrorEnvelope(code: ErrorCode, requestId: RequestId): ErrorEnvelope {
  return {
    error: {
      code,
      message: SAFE_ERROR_MESSAGES[code],
      request_id: requestId,
    },
  };
}

export class ProtocolRequestError extends Error {
  readonly code: ErrorCode;
  readonly status: number;

  constructor(code: ErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "ProtocolRequestError";
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

export class ProtocolValidationError extends ProtocolRequestError {
  constructor() {
    super("validation_failed");
    this.name = "ProtocolValidationError";
  }
}

export const MAX_JSON_BODY_BYTES = 65_536;
export const MAX_MESSAGE_BYTES = 32_768;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new ProtocolValidationError();
  }

  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new ProtocolValidationError();
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ProtocolValidationError();
  }
}

function scalarLength(value: string): number {
  return Array.from(value).length;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasNonWhitespaceScalar(value: string): boolean {
  return Array.from(value).some((scalar) => !/^\s$/u.test(scalar));
}

export const AGENT_HANDLE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
export const LOCAL_INSTANCE_KEY_PATTERN = /^[0-9a-f]{64}$/;
const RUNTIME_METADATA_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
export const MAX_RUNTIME_METADATA_ENTRIES = 16;
export const MAX_RUNTIME_METADATA_VALUE_SCALARS = 256;

export interface StartInstanceRequest {
  runtime_kind: RuntimeKind;
  cli_version: string;
  /** Tag to register under. Omit to leave the pointer untouched, null to untag. */
  agent_id?: AgentId | null;
  /**
   * HMAC of the caller's runtime session. When it matches a live Instance of
   * the same Principal the server returns that Instance with a fresh token
   * instead of creating a second one — one session, one live Instance.
   */
  local_instance_key?: string;
  /** Host, workspace, OS and the like. Replaces what was stored before. */
  runtime_metadata?: Record<string, string>;
  /** Omit to inherit the Principal's default; on re-registration, omit to keep. */
  reach?: Reach;
}

function parseRuntimeMetadata(value: unknown): Record<string, string> {
  if (!isPlainRecord(value)) throw new ProtocolValidationError();
  const entries = Object.entries(value);
  if (entries.length > MAX_RUNTIME_METADATA_ENTRIES) throw new ProtocolValidationError();
  const metadata: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (
      !RUNTIME_METADATA_KEY_PATTERN.test(key) ||
      typeof raw !== "string" ||
      CONTROL_CHARACTER_PATTERN.test(raw) ||
      scalarLength(raw) > MAX_RUNTIME_METADATA_VALUE_SCALARS
    ) {
      throw new ProtocolValidationError();
    }
    metadata[key] = raw;
  }
  return metadata;
}

export function parseStartInstanceRequest(value: unknown): StartInstanceRequest {
  requireExactKeys(
    value,
    ["runtime_kind", "cli_version"],
    ["agent_id", "local_instance_key", "runtime_metadata", "reach"],
  );
  const {
    runtime_kind: runtimeKind,
    cli_version: cliVersion,
    agent_id: agentId,
    local_instance_key: localInstanceKey,
    runtime_metadata: runtimeMetadata,
    reach,
  } = value;
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();

  if (
    typeof runtimeKind !== "string" ||
    !RUNTIME_KIND_PATTERN.test(runtimeKind) ||
    isServiceRuntimeKind(runtimeKind) ||
    typeof cliVersion !== "string" ||
    !/^[\x20-\x7e]{1,64}$/.test(cliVersion)
  ) {
    throw new ProtocolValidationError();
  }
  if (
    agentId !== undefined &&
    agentId !== null &&
    (typeof agentId !== "string" || !AGENT_ID_PATTERN.test(agentId))
  ) {
    throw new ProtocolValidationError();
  }
  if (
    localInstanceKey !== undefined &&
    (typeof localInstanceKey !== "string" || !LOCAL_INSTANCE_KEY_PATTERN.test(localInstanceKey))
  ) {
    throw new ProtocolValidationError();
  }

  const request: StartInstanceRequest = { runtime_kind: runtimeKind, cli_version: cliVersion };
  if (agentId !== undefined) request.agent_id = agentId as AgentId | null;
  if (localInstanceKey !== undefined) request.local_instance_key = localInstanceKey;
  if (runtimeMetadata !== undefined) request.runtime_metadata = parseRuntimeMetadata(runtimeMetadata);
  if (reach !== undefined) request.reach = reach;
  return request;
}

export interface UpdateInstanceRequest {
  reach?: Reach;
}

/** `PATCH /instances/current`: what an Instance may change about itself. */
export function parseUpdateInstanceRequest(value: unknown): UpdateInstanceRequest {
  requireExactKeys(value, [], ["reach"]);
  const { reach } = value as { reach?: unknown };
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();
  return reach === undefined ? {} : { reach };
}

/** How many Instances one request may name. */
export const MAX_ADMISSIONS = 50;

function parseInstanceIdList(value: unknown): InstanceId[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ADMISSIONS) {
    throw new ProtocolValidationError();
  }
  const ids: InstanceId[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isPublicId(item, "i") || ids.includes(item as InstanceId)) {
      throw new ProtocolValidationError();
    }
    ids.push(item as InstanceId);
  }
  return ids;
}

/**
 * What became of one Instance named in `with`: seated at once (member), asked
 * through a Decision (pending), or refused, which says nothing about why.
 */
export type AdmissionStatus = "member" | "pending" | "refused";
export interface Admission {
  instance_id: InstanceId;
  status: AdmissionStatus;
  /** The Decision a private Instance has to answer; null otherwise. */
  decision_id: DecisionId | null;
}

/** What an invite opens, for the join page: enough to write the command, nothing that acts. */
export interface InviteDescription {
  room: { id: RoomId; name: string; state: RoomState };
  invite: { id: InviteId; expires_at: Timestamp | null; uses: number };
}

export interface AddRoomMembersRequest {
  with: InstanceId[];
}

export function parseAddRoomMembersRequest(value: unknown): AddRoomMembersRequest {
  requireExactKeys(value, ["with"], []);
  return { with: parseInstanceIdList((value as { with: unknown }).with) };
}

/**
 * Inviting a person into a Room (decision 2026-10-25): by any Instance id of
 * theirs, or by the Principal id a name search returned. The person is seated
 * at once; which Agents follow them in is theirs to choose.
 */
export type InvitePersonRequest = { instance_id: InstanceId } | { principal_id: PrincipalId };

export function parseInvitePersonRequest(value: unknown): InvitePersonRequest {
  requireExactKeys(value, [], ["instance_id", "principal_id"]);
  const { instance_id, principal_id } = value as { instance_id?: unknown; principal_id?: unknown };
  if ((instance_id === undefined) === (principal_id === undefined)) throw new ProtocolValidationError();
  return instance_id === undefined ? { principal_id: parsePublicId(principal_id, "p") } : { instance_id: parsePublicId(instance_id, "i") };
}

/** A name search for people (`GET /api/v1/people?q=`): 2–64 characters, trimmed. */
export function parsePeopleQuery(value: unknown): string {
  const query = typeof value === "string" ? value.trim() : "";
  if (scalarLength(query) < 2 || scalarLength(query) > 64) throw new ProtocolValidationError();
  return query;
}

/** A person as an invite names them: the Principal and the name its account goes by. */
export interface Person {
  principal_id: PrincipalId;
  name: string | null;
}

/** `member` when the person could already see the Room: nothing was written. */
export interface PersonInvite {
  status: "invited" | "member";
  person: Person;
  room_id: RoomId;
}

export type DecisionResolutionOutcome = "approved" | "denied";
export interface ResolveDecisionRequest {
  resolution: DecisionResolutionOutcome;
}

export function parseResolveDecisionRequest(value: unknown): ResolveDecisionRequest {
  requireExactKeys(value, ["resolution"], []);
  const { resolution } = value as { resolution: unknown };
  if (resolution !== "approved" && resolution !== "denied") throw new ProtocolValidationError();
  return { resolution };
}

export interface CreateAgentRequest {
  handle: string;
  display_name?: string | null;
  description?: string | null;
}

/** Handles are NFKC-normalised, trimmed and lower-cased before validation. */
export function canonicalAgentHandle(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function parseCreateAgentRequest(value: unknown): CreateAgentRequest {
  requireExactKeys(value, ["handle"], ["display_name", "description"]);
  const { handle, display_name: displayName, description } = value;
  if (typeof handle !== "string") throw new ProtocolValidationError();
  const canonical = canonicalAgentHandle(handle);
  if (!AGENT_HANDLE_PATTERN.test(canonical)) throw new ProtocolValidationError();
  if (
    displayName !== undefined &&
    displayName !== null &&
    (typeof displayName !== "string" ||
      !hasNonWhitespaceScalar(displayName) ||
      scalarLength(displayName) > 120 ||
      CONTROL_CHARACTER_PATTERN.test(displayName))
  ) {
    throw new ProtocolValidationError();
  }
  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || scalarLength(description) > 2_000)
  ) {
    throw new ProtocolValidationError();
  }
  const request: CreateAgentRequest = { handle: canonical };
  if (displayName !== undefined) request.display_name = (displayName as string | null)?.trim() ?? null;
  if (description !== undefined) request.description = description as string | null;
  return request;
}

export interface CreateRoomRequest {
  type?: RoomType;
  name: string;
  description?: string | null;
  /** Instances to seat as the Room opens: public ones at once, private ones by asking. */
  with?: InstanceId[];
  /** `direct` opens a Room only the caller's own Principal can ever be seated in. Default `standard`. */
  kind?: RoomKind;
}

export function parseCreateRoomRequest(value: unknown): CreateRoomRequest {
  requireExactKeys(value, ["name"], ["description", "with", "type", "kind"]);
  const roomType = (value as { type?: unknown }).type;
  if (roomType !== undefined && roomType !== "board" && roomType !== "compiled") throw new ProtocolValidationError();
  const { name, description, with: withIds, kind } = value as {
    name: unknown;
    description?: unknown;
    with?: unknown;
    kind?: unknown;
  };
  if (typeof name !== "string") {
    throw new ProtocolValidationError();
  }
  if (kind !== undefined && kind !== "standard" && kind !== "direct") {
    throw new ProtocolValidationError();
  }

  const normalizedName = name.normalize("NFKC").trim();
  if (scalarLength(normalizedName) < 1 || scalarLength(normalizedName) > 120) {
    throw new ProtocolValidationError();
  }

  if (
    description !== undefined &&
    description !== null &&
    (typeof description !== "string" || scalarLength(description) > 2_000)
  ) {
    throw new ProtocolValidationError();
  }

  const request: CreateRoomRequest = { name: normalizedName };
  if (roomType !== undefined) request.type = roomType;
  if (description !== undefined) request.description = description as string | null;
  if (withIds !== undefined) request.with = parseInstanceIdList(withIds);
  if (kind === "direct") request.kind = "direct";
  return request;
}

/**
 * Credits: play money (decision 2026-09-11). A purse belongs to a Principal;
 * a transfer records the Instance that moved it. Minting is a code
 * redemption: a transfer with no payer and the code that granted it.
 */
export interface CreditTransfer {
  id: TransferId;
  /** Null when the credits were minted by a code redemption. */
  from_principal_id: PrincipalId | null;
  to_principal_id: PrincipalId;
  amount: number;
  memo: string | null;
  /** The Room the trade was agreed in, when the payer said so. */
  room_id: RoomId | null;
  /** The seat that said pay; null for a redemption, or a payment made with an account key. */
  by_instance_id: InstanceId | null;
  /** What the payer typed: a Principal, Agent or Instance id, resolved to `to_principal_id`. */
  addressed_to: string;
  /** For a redemption: the code that granted it. */
  code: string | null;
  created_at: Timestamp;
}

export interface CreditBalance {
  principal_id: PrincipalId;
  balance: number;
  granted: number;
  sent: number;
  received: number;
}

/** A grant code an operator minted: redeemable once per Principal, until it is switched off. */
export interface CreditCode {
  code: string;
  amount: number;
  max_redemptions: number | null;
  redeemed_count: number;
  expires_at: Timestamp | null;
  active: boolean;
  created_at: Timestamp;
}

export const CREDIT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const MAX_CREDIT_AMOUNT = 1_000_000_000;
export const MAX_CREDIT_MEMO_SCALARS = 200;
/** The column holds 200 characters; a scalar can be several bytes, and the check counts characters. */
export const MAX_CREDIT_MEMO_BYTES = 800;

export interface RedeemCreditsRequest {
  code: string;
}

/** Codes are case-insensitive as typed and stored upper-case. */
export function normalizeCreditCode(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

export function parseRedeemCreditsRequest(value: unknown): RedeemCreditsRequest {
  requireExactKeys(value, ["code"]);
  const { code } = value;
  if (typeof code !== "string") throw new ProtocolValidationError();
  const normalized = normalizeCreditCode(code);
  if (!CREDIT_CODE_PATTERN.test(normalized)) throw new ProtocolValidationError();
  return { code: normalized };
}

export interface CreditTransferRequest {
  /** A Principal, Agent or Instance id; all three resolve to the owning Principal's purse. */
  to: PrincipalId | AgentId | InstanceId;
  amount: number;
  memo?: string | null;
  room_id?: RoomId | null;
}

export function parseCreditTransferRequest(value: unknown): CreditTransferRequest {
  requireExactKeys(value, ["to", "amount"], ["memo", "room_id"]);
  const { to, amount, memo, room_id: roomId } = value;
  if (
    typeof to !== "string" ||
    !(PRINCIPAL_ID_PATTERN.test(to) || AGENT_ID_PATTERN.test(to) || INSTANCE_ID_PATTERN.test(to))
  ) {
    throw new ProtocolValidationError();
  }
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CREDIT_AMOUNT) {
    throw new ProtocolValidationError();
  }
  // NFKC first, then measure: normalizing can make a string longer (ﬃ becomes
  // ffi), and what the column has to hold is the normalized text.
  const normalizedMemo = typeof memo === "string" ? memo.normalize("NFKC").trim() : memo;
  if (
    normalizedMemo !== undefined &&
    normalizedMemo !== null &&
    (typeof normalizedMemo !== "string" ||
      !hasNonWhitespaceScalar(normalizedMemo) ||
      scalarLength(normalizedMemo) > MAX_CREDIT_MEMO_SCALARS ||
      utf8Length(normalizedMemo) > MAX_CREDIT_MEMO_BYTES ||
      /[\p{Cc}]/u.test(normalizedMemo))
  ) {
    throw new ProtocolValidationError();
  }
  if (roomId !== undefined && roomId !== null && (typeof roomId !== "string" || !ROOM_ID_PATTERN.test(roomId))) {
    throw new ProtocolValidationError();
  }
  const request: CreditTransferRequest = { to: to as CreditTransferRequest["to"], amount };
  if (memo !== undefined) request.memo = normalizedMemo as string | null;
  if (roomId !== undefined) request.room_id = roomId as RoomId | null;
  return request;
}

/**
 * Artifacts (decision 2026-09-11): a file. What Agents pass each other is not
 * only sentences — a patch, a screenshot, a dataset — and until now every one
 * of those had to be pasted into a message or left on a machine nobody else
 * can reach.
 *
 * There is one kind of file. Every one has a link, minted at upload and
 * returned once; whoever holds the link reads the file. A file uploaded from
 * a seat is also addressed to that seat's Room, which lets the other members
 * read it by id without anyone passing the link around.
 */
export interface Artifact {
  id: ArtifactId;
  /** The account that uploaded it. */
  principal_id: PrincipalId;
  /** The seat that uploaded it; null once that Instance is gone. */
  uploaded_by_instance_id: InstanceId | null;
  /** The Room it was handed to, whose members may read it by id; null if none. */
  room_id: RoomId | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** SHA-256 of the bytes, hex. The same file uploaded twice has the same digest. */
  sha256: string;
  created_at: Timestamp;
}

/** Four mebibytes. A screenshot, a patch, a log, a dataset of the size an Agent actually passes. */
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
/** What one account may hold at once, so a runaway loop cannot fill the disk. */
export const ARTIFACT_QUOTA_BYTES = 256 * 1024 * 1024;
export const MAX_ARTIFACT_FILENAME_SCALARS = 120;

/**
 * A seat's name (decision 2026-09-11): the nickname its own account gave it,
 * or the note someone else wrote on it. Display text and nothing more — it
 * never addresses anything, and the Instance id stays exactly what it was.
 */
export const MAX_SEAT_NAME_SCALARS = 48;

/**
 * An account's own name, fitted to the rule every seat name obeys: one line,
 * at most 48 characters. A name with nothing usable left gives no name.
 */
export function fitSeatName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const oneLine = name.normalize("NFKC").replace(/\p{Cc}+/gu, " ").trim();
  const fitted = [...oneLine].slice(0, MAX_SEAT_NAME_SCALARS).join("").trim();
  try {
    return parseSeatName(fitted);
  } catch {
    return null;
  }
}

/** An empty name is how one is taken back off, so it parses to null. */
export function parseSeatName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFKC").trim();
  if (normalized === "") return null;
  if (scalarLength(normalized) > MAX_SEAT_NAME_SCALARS || /[\p{Cc}]/u.test(normalized)) {
    throw new ProtocolValidationError();
  }
  return normalized;
}

/**
 * A filename is display text, never a path: an Agent that downloads one must
 * not be steered into writing outside the directory it chose. Separators,
 * control characters and the traversal names are refused rather than mangled.
 */
export function parseArtifactFilename(value: unknown): string {
  if (typeof value !== "string") throw new ProtocolValidationError();
  const normalized = value.normalize("NFKC").trim();
  if (
    scalarLength(normalized) < 1 ||
    scalarLength(normalized) > MAX_ARTIFACT_FILENAME_SCALARS ||
    /[/\\]/.test(normalized) ||
    /[\p{Cc}]/u.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new ProtocolValidationError();
  }
  return normalized;
}

/** A media type as a header gives it, without parameters; anything odd becomes bytes. */
export function parseArtifactContentType(value: unknown): string {
  if (typeof value !== "string") return "application/octet-stream";
  const type = value.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(type)
    ? type
    : "application/octet-stream";
}

export interface ArtifactQuery {
  room_id: RoomId | null;
  before: ArtifactId | null;
  limit: number;
}

export const DEFAULT_ARTIFACT_QUERY: ArtifactQuery = { room_id: null, before: null, limit: 50 };

export interface PostMessageRequest {
  content: string;
  reply_to_message_id?: MessageId | null;
}

export function parsePostMessageRequest(value: unknown): PostMessageRequest {
  requireExactKeys(value, ["content"], ["reply_to_message_id"]);
  const { content, reply_to_message_id: replyToMessageId } = value;
  if (
    typeof content !== "string" ||
    !hasNonWhitespaceScalar(content) ||
    utf8Length(content) > MAX_MESSAGE_BYTES
  ) {
    throw new ProtocolValidationError();
  }

  if (
    replyToMessageId !== undefined &&
    replyToMessageId !== null &&
    !isPublicId(replyToMessageId, "msg")
  ) {
    throw new ProtocolValidationError();
  }

  return replyToMessageId === undefined
    ? { content }
    : { content, reply_to_message_id: replyToMessageId as MessageId | null };
}

// ---- Goal Rooms (decision 2026-10-05, goal mode and one wait) ----

/** At most this many end triggers, each at most this many characters. */
export const MAX_GOAL_TRIGGERS = 10;
const MAX_GOAL_TRIGGER_SCALARS = 300;
/** A close's reason detail (a check's output, a budget's total) is evidence, not a transcript. */
export const MAX_GOAL_DETAIL_SCALARS = 4_000;

/** An end trigger the service enforces itself, so a goal Room ends even when its runner has died. */
export type ServiceGoalTrigger =
  | { kind: "count"; label: string; count: number }
  | { kind: "after"; label: string; ms: number }
  | { kind: "at"; label: string; time: number };

/**
 * The kinds an end condition may use. The service enforces `count`, `after`
 * and `at`; the runner, on the machine where the Agents work, enforces the
 * rest (`check` runs a command there; `budget` reads the Agents' own usage).
 */
const GOAL_TRIGGER_KINDS = new Set(["count", "after", "at", "idle", "said", "mention", "message", "check", "budget"]);
/** A goal Room must name at least one of these: a while-loop with no bound burns money. */
const GOAL_BOUND_KINDS = new Set(["count", "after", "at", "budget"]);

function goalDurationMs(value: string): number | null {
  const match = /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  const unit = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000;
  return Number(match[1]) * unit;
}

/**
 * One end trigger in the words of `wait --on`, normalised to `kind parameter`.
 * `at` must carry its offset: the service cannot know the runner's clock, so
 * the CLI resolves `at 17:30` before sending it.
 */
export function parseGoalTrigger(raw: unknown): { label: string; kind: string; enforced: ServiceGoalTrigger | null } {
  if (typeof raw !== "string") throw new ProtocolValidationError();
  const trimmed = raw.normalize("NFC").trim();
  const match = /^([a-z]+)\s*:?\s*([\s\S]*)$/.exec(trimmed);
  if (!match || scalarLength(trimmed) > MAX_GOAL_TRIGGER_SCALARS || CONTROL_CHARACTER_PATTERN.test(trimmed)) {
    throw new ProtocolValidationError();
  }
  const kind = match[1]!;
  const parameter = match[2]!.trim();
  if (!GOAL_TRIGGER_KINDS.has(kind)) throw new ProtocolValidationError();
  const parameterless = kind === "mention" || kind === "message";
  if (parameterless ? parameter !== "" : parameter === "") throw new ProtocolValidationError();
  const label = parameterless ? kind : `${kind} ${parameter}`;
  if (kind === "count") {
    if (!/^[1-9]\d{0,8}$/.test(parameter)) throw new ProtocolValidationError();
    return { label, kind, enforced: { kind: "count", label, count: Number(parameter) } };
  }
  if (kind === "after" || kind === "idle") {
    const ms = goalDurationMs(parameter);
    if (ms === null) throw new ProtocolValidationError();
    return { label, kind, enforced: kind === "after" ? { kind: "after", label, ms } : null };
  }
  if (kind === "at") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(parameter)) {
      throw new ProtocolValidationError();
    }
    const time = Date.parse(parameter);
    if (!Number.isFinite(time)) throw new ProtocolValidationError();
    return { label, kind, enforced: { kind: "at", label, time } };
  }
  if (kind === "budget" && !/^(?:\$\d+(?:\.\d{1,2})?|\d+(?:\.\d+)?[kKmM]? tokens)$/.test(parameter)) {
    throw new ProtocolValidationError();
  }
  return { label, kind, enforced: null };
}

export interface StartGoalRequest {
  /** The goal, said as the Room's first owner message. */
  content: string;
  until: string[];
}

/** `{ content, until }`: the goal and its end triggers, at least one of them a bound. */
export function parseStartGoalRequest(value: unknown): StartGoalRequest {
  requireExactKeys(value, ["content", "until"]);
  const { content, until } = value as { content: unknown; until: unknown };
  const { content: goal } = parsePostMessageRequest({ content });
  if (!Array.isArray(until) || until.length < 1 || until.length > MAX_GOAL_TRIGGERS) {
    throw new ProtocolValidationError();
  }
  const triggers = until.map((raw) => parseGoalTrigger(raw));
  const labels = [...new Set(triggers.map((trigger) => trigger.label))];
  if (!triggers.some((trigger) => GOAL_BOUND_KINDS.has(trigger.kind))) {
    throw new ProtocolRequestError("goal_unbounded");
  }
  return { content: goal, until: labels };
}

/** The service-enforced triggers among a goal's stored ones. */
export function serviceGoalTriggers(until: readonly string[]): ServiceGoalTrigger[] {
  const enforced: ServiceGoalTrigger[] = [];
  for (const raw of until) {
    try {
      const trigger = parseGoalTrigger(raw).enforced;
      if (trigger) enforced.push(trigger);
    } catch {
      // A stored trigger this service no longer reads is the runner's to enforce.
    }
  }
  return enforced;
}

export interface OwnerMessageRequest {
  content: string;
  /** `owner` speaks as the person; `runner` as the goal Room's machinery. */
  as: "owner" | "runner";
}

export function parseOwnerMessageRequest(value: unknown): OwnerMessageRequest {
  requireExactKeys(value, ["content"], ["as"]);
  const { content, as } = value as { content: unknown; as?: unknown };
  if (as !== undefined && as !== "owner" && as !== "runner") throw new ProtocolValidationError();
  return { content: parsePostMessageRequest({ content }).content, as: as === "runner" ? "runner" : "owner" };
}

export interface CloseRoomRequest {
  /** The end trigger that fired, in the words of `--until`; null for a plain close. */
  trigger: string | null;
  detail: string | null;
}

export function parseCloseRoomRequest(value: unknown): CloseRoomRequest {
  if (value === undefined || value === null) return { trigger: null, detail: null };
  requireExactKeys(value, [], ["trigger", "detail"]);
  const { trigger, detail } = value as { trigger?: unknown; detail?: unknown };
  const label = trigger === undefined || trigger === null ? null : parseGoalTrigger(trigger).label;
  if (detail !== undefined && detail !== null && (typeof detail !== "string" || scalarLength(detail) > MAX_GOAL_DETAIL_SCALARS)) {
    throw new ProtocolValidationError();
  }
  return { trigger: label, detail: typeof detail === "string" && detail.trim() !== "" ? detail : null };
}

export const MAX_MEMBER_NAME_SCALARS = 64;

export interface JoinRoomWithInviteRequest {
  /** What the joiner calls itself in the Room, e.g. "claude-code". Display only. */
  name: string;
  /** The driver behind it, if it can say. Recorded on the Instance the join provisions. */
  runtime?: RuntimeReport;
  /** Omit for public, the default for a seat that arrived by invite. */
  reach?: Reach;
}

export function parseRuntimeReport(value: unknown): RuntimeReport {
  requireExactKeys(value, ["kind"], ["version", "entrypoint", "source"]);
  const { kind, version, entrypoint, source } = value as Record<string, unknown>;
  if (typeof kind !== "string" || !RUNTIME_KIND_PATTERN.test(kind) || isServiceRuntimeKind(kind)) {
    throw new ProtocolValidationError();
  }
  const text = (field: unknown): string | null | undefined => {
    if (field === undefined) return undefined;
    if (field === null) return null;
    if (typeof field !== "string" || !/^[\x20-\x7e]{1,64}$/.test(field)) {
      throw new ProtocolValidationError();
    }
    return field;
  };
  const report: RuntimeReport = { kind };
  const parsedVersion = text(version);
  if (parsedVersion !== undefined) report.version = parsedVersion;
  const parsedEntrypoint = text(entrypoint);
  if (parsedEntrypoint !== undefined) report.entrypoint = parsedEntrypoint;
  if (source !== undefined) {
    if (source !== "detected" && source !== "declared") throw new ProtocolValidationError();
    report.source = source;
  }
  return report;
}

/** A CLI login as the API describes it; codes and tokens are never in here. */
export interface CliLogin {
  id: CliLoginId;
  state: "pending" | "approved" | "consumed" | "denied" | "expired";
  label: string | null;
  /** The anonymous seats the CLI proved it holds; approval binds their Principals. */
  bind_instance_ids: InstanceId[];
  principal_id: PrincipalId | null;
  created_at: Timestamp;
  expires_at: Timestamp;
  approved_at: Timestamp | null;
}

export interface StartCliLoginRequest {
  /** Where the CLI runs, for the approve page: a hostname or a short description. */
  label?: string | null;
  /** Instance tokens of seats this machine holds; proof of possession for binding. */
  seats?: SniSecret[];
}

export function parseStartCliLoginRequest(value: unknown): StartCliLoginRequest {
  if (value === undefined || value === null) return {};
  requireExactKeys(value, [], ["label", "seats"]);
  const { label, seats } = value as { label?: unknown; seats?: unknown };
  const request: StartCliLoginRequest = {};
  if (label !== undefined) {
    if (label === null) request.label = null;
    else {
      if (typeof label !== "string") throw new ProtocolValidationError();
      const normalized = label.normalize("NFKC").trim();
      if (
        scalarLength(normalized) < 1 ||
        scalarLength(normalized) > 120 ||
        CONTROL_CHARACTER_PATTERN.test(normalized)
      ) {
        throw new ProtocolValidationError();
      }
      request.label = normalized;
    }
  }
  if (seats !== undefined) {
    if (!Array.isArray(seats) || seats.length > 50) throw new ProtocolValidationError();
    for (const seat of seats) {
      if (typeof seat !== "string" || !SNI_SECRET_PATTERN.test(seat)) {
        throw new ProtocolValidationError();
      }
    }
    request.seats = seats as SniSecret[];
  }
  return request;
}

/** An Instance joining a Room: optionally with the invite that admits it. */
export interface JoinRoomRequest {
  invite?: RitSecret;
  /**
   * The name this seat goes by — its own nickname, which everyone in its Rooms
   * sees (decision 2026-09-11 seat names). Omit to keep the one it has; a seat
   * with none is shown by its Instance id.
   */
  name?: string;
}

export function parseJoinRoomRequest(value: unknown): JoinRoomRequest {
  if (value === undefined || value === null) return {};
  requireExactKeys(value, [], ["invite", "name"]);
  const { invite, name } = value as { invite?: unknown; name?: unknown };
  const request: JoinRoomRequest = {};
  if (invite !== undefined) {
    if (typeof invite !== "string" || !RIT_SECRET_PATTERN.test(invite)) {
      throw new ProtocolValidationError();
    }
    request.invite = invite as RitSecret;
  }
  if (name !== undefined) request.name = parseMemberName(name);
  return request;
}

/** A seat's name as a person would type it: NFKC, trimmed, 1–64 scalars, no control characters. */
function parseMemberName(name: unknown): string {
  if (typeof name !== "string") {
    throw new ProtocolValidationError();
  }
  const normalized = name.normalize("NFKC").trim();
  if (
    scalarLength(normalized) < 1 ||
    scalarLength(normalized) > MAX_MEMBER_NAME_SCALARS ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new ProtocolValidationError();
  }
  return normalized;
}

export function parseJoinRoomWithInviteRequest(value: unknown): JoinRoomWithInviteRequest {
  requireExactKeys(value, ["name"], ["runtime", "reach"]);
  const { name, runtime, reach } = value as { name: unknown; runtime?: unknown; reach?: unknown };
  if (reach !== undefined && !isReach(reach)) throw new ProtocolValidationError();
  const request: JoinRoomWithInviteRequest = { name: parseMemberName(name) };
  if (runtime !== undefined) request.runtime = parseRuntimeReport(runtime);
  if (reach !== undefined) request.reach = reach;
  return request;
}

export function parseEmptyRequest(value: unknown): Record<string, never> {
  if (value === undefined) {
    return {};
  }
  requireExactKeys(value, []);
  return {};
}

export function parseJsonBody<T>(text: string, parser: (value: unknown) => T): T {
  if (utf8Length(text) > MAX_JSON_BODY_BYTES) {
    throw new ProtocolRequestError("request_too_large");
  }
  if (text.length === 0) {
    throw new ProtocolRequestError("invalid_request");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolRequestError("invalid_json");
  }
  return parser(value);
}

export const CAPABILITIES = [
  "identity.principal",
  "agents",
  "instances.lease",
  "rooms",
  "rooms.messages",
  "rooms.invites",
  "rooms.wait",
  "rooms.inbox",
  "decisions.approval",
  "decisions.text",
  "decisions.resolve",
  "instances.reach",
  "rooms.members",
  "network",
  "credits",
  "artifacts",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/**
 * The oldest CLI the service still registers Instances for. Raised when a
 * released CLI has a bug the service cannot work around; 0.1.3 is the first
 * whose `join` never folds two windows into one Instance.
 */
export const MIN_CLI_VERSION = "0.1.3";

/** Semantic-version order for `MAJOR.MINOR.PATCH` strings; anything else compares as unknown (0). */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.trim().split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return 0;
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

export function isVersionString(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(value.trim());
}

export interface DiscoveryDocument {
  service: "sharednet";
  api_major: 1;
  protocol_version: string;
  /** CLIs older than this are refused at Instance registration and told to update. */
  min_cli_version: string;
  openapi_url: "/api/v1/openapi.json";
  capabilities: readonly Capability[];
  limits: {
    default_page_size: number;
    max_page_size: number;
    max_message_bytes: number;
    /** Largest file `uploadArtifact` accepts, and what one account may hold at once. */
    max_artifact_bytes: number;
    artifact_quota_bytes: number;
    heartbeat_after_seconds: number;
    presence_lease_seconds: number;
    idempotency_retention_seconds: number;
    bearer_requests_per_minute: number;
    web_requests_per_minute: number;
    api_key_issuances_per_hour: number;
    max_active_api_keys: number;
    max_agents_per_principal: number;
    max_active_instances_per_principal: number;
    max_open_rooms_per_principal: number;
    /** Longest a single `wait` request blocks before answering with an empty page. */
    wait_max_seconds: number;
    /** 0 means an invite never expires unless revoked. */
    invite_default_seconds: number;
    /** 0 means no cap on `expires_in_seconds`. */
    invite_max_seconds: number;
  };
}

export const DISCOVERY_DOCUMENT = {
  service: "sharednet",
  api_major: 1,
  protocol_version: "1.0.0",
  min_cli_version: MIN_CLI_VERSION,
  openapi_url: "/api/v1/openapi.json",
  capabilities: CAPABILITIES,
  limits: {
    default_page_size: 50,
    max_page_size: 100,
    max_message_bytes: MAX_MESSAGE_BYTES,
    max_artifact_bytes: MAX_ARTIFACT_BYTES,
    artifact_quota_bytes: ARTIFACT_QUOTA_BYTES,
    heartbeat_after_seconds: 30,
    presence_lease_seconds: 90,
    idempotency_retention_seconds: 86_400,
    bearer_requests_per_minute: 600,
    web_requests_per_minute: 300,
    api_key_issuances_per_hour: 10,
    max_active_api_keys: 20,
    max_agents_per_principal: 100,
    max_active_instances_per_principal: 100,
    max_open_rooms_per_principal: 100,
    wait_max_seconds: 25,
    invite_default_seconds: 0,
    invite_max_seconds: 0,
  },
} as const satisfies DiscoveryDocument;

export interface RouteDefinition {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: "public" | "api_key" | "instance" | "any";
  operationId: string;
}

export const ROUTE_CATALOGUE = [
  { method: "GET", path: "/api/v1", auth: "public", operationId: "discover" },
  {
    method: "GET",
    path: "/api/v1/openapi.json",
    auth: "public",
    operationId: "getOpenApi",
  },
  { method: "POST", path: "/api/v1/agents", auth: "api_key", operationId: "createAgent" },
  { method: "GET", path: "/api/v1/agents", auth: "api_key", operationId: "listAgents" },
  {
    method: "GET",
    path: "/api/v1/agents/{agent_id}",
    auth: "api_key",
    operationId: "getAgent",
  },
  {
    method: "POST",
    path: "/api/v1/instances",
    auth: "api_key",
    operationId: "startInstance",
  },
  {
    method: "GET",
    path: "/api/v1/instances",
    auth: "any",
    operationId: "listInstances",
  },
  {
    method: "GET",
    path: "/api/v1/instances/current",
    auth: "instance",
    operationId: "getCurrentInstance",
  },
  {
    method: "POST",
    path: "/api/v1/instances/current/heartbeat",
    auth: "instance",
    operationId: "heartbeat",
  },
  {
    method: "PATCH",
    path: "/api/v1/instances/current",
    auth: "instance",
    operationId: "updateInstance",
  },
  {
    method: "DELETE",
    path: "/api/v1/instances/current",
    auth: "instance",
    operationId: "endInstance",
  },
  { method: "GET", path: "/api/v1/rooms", auth: "instance", operationId: "listRooms" },
  { method: "POST", path: "/api/v1/rooms", auth: "instance", operationId: "createRoom" },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/members",
    auth: "any",
    operationId: "addRoomMembers",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}",
    auth: "any",
    operationId: "getRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/join",
    auth: "any",
    operationId: "joinRoom",
  },
  {
    method: "POST",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "any",
    operationId: "postMessage",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}/messages",
    auth: "any",
    operationId: "listMessages",
  },
  {
    method: "GET",
    path: "/api/v1/rooms/{room_id}/wait",
    auth: "any",
    operationId: "waitForMessages",
  },
  { method: "GET", path: "/api/v1/rooms/{room_id}/subscription", auth: "any", operationId: "getSubscription" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/subscription/heartbeat", auth: "any", operationId: "heartbeatSubscription" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/ack", auth: "any", operationId: "acknowledge" },
  { method: "PUT", path: "/api/v1/rooms/{room_id}/subscription", auth: "any", operationId: "setPush" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/hooks", auth: "api_key", operationId: "createRoomHook" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/acts", auth: "instance", operationId: "postAct" },
  { method: "GET", path: "/api/v1/rooms/{room_id}/state", auth: "instance", operationId: "getCompiledState" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/events", auth: "any", operationId: "postEvent" },
  { method: "GET", path: "/api/v1/rooms/{room_id}/timers", auth: "any", operationId: "listTimers" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/timers", auth: "any", operationId: "createTimer" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/timers/{timer_id}/cancel", auth: "any", operationId: "cancelTimer" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/invites", auth: "any", operationId: "createRoomInvite" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/goal", auth: "api_key", operationId: "startGoal" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/owner-messages", auth: "api_key", operationId: "postOwnerMessage" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/close", auth: "api_key", operationId: "closeRoom" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/members/{member_id}/token", auth: "api_key", operationId: "reissueMemberToken" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/people", auth: "api_key", operationId: "invitePerson" },
  { method: "POST", path: "/api/v1/rooms/{room_id}/leave", auth: "api_key", operationId: "leaveRoom" },
  { method: "GET", path: "/api/v1/people", auth: "api_key", operationId: "findPeople" },
  { method: "GET", path: "/api/v1/invites/current", auth: "any", operationId: "describeInvite" },
  { method: "GET", path: "/api/v1/inbox", auth: "any", operationId: "listInbox" },
  { method: "GET", path: "/api/v1/contact-wakes", auth: "instance", operationId: "listContactWakes" },
  { method: "POST", path: "/api/v1/contact-wakes/{wake_id}/claim", auth: "instance", operationId: "claimContactWake" },
  { method: "POST", path: "/api/v1/contact-wakes/{wake_id}/complete", auth: "instance", operationId: "completeContactWake" },
  { method: "GET", path: "/api/v1/decisions", auth: "any", operationId: "listDecisions" },
  {
    method: "POST",
    path: "/api/v1/decisions/{decision_id}/resolve",
    auth: "any",
    operationId: "resolveDecision",
  },
  { method: "POST", path: "/api/v1/artifacts", auth: "any", operationId: "uploadArtifact" },
  { method: "GET", path: "/api/v1/artifacts", auth: "any", operationId: "listArtifacts" },
  { method: "GET", path: "/api/v1/artifacts/{artifact_id}", auth: "any", operationId: "getArtifact" },
  { method: "GET", path: "/api/v1/artifacts/{artifact_id}/content", auth: "any", operationId: "downloadArtifact" },
  { method: "GET", path: "/api/v1/credits", auth: "any", operationId: "getCredits" },
  { method: "POST", path: "/api/v1/credits/redeem", auth: "any", operationId: "redeemCredits" },
  { method: "POST", path: "/api/v1/credits/transfers", auth: "any", operationId: "transferCredits" },
  { method: "GET", path: "/api/v1/credits/transfers", auth: "any", operationId: "listCreditTransfers" },
  { method: "POST", path: "/api/v1/cli/logins", auth: "public", operationId: "startCliLogin" },
  { method: "POST", path: "/api/v1/cli/claims/redeem", auth: "public", operationId: "redeemCliClaim" },
  {
    method: "POST",
    path: "/api/v1/cli/logins/{login_id}/poll",
    auth: "public",
    operationId: "pollCliLogin",
  },
] as const satisfies readonly RouteDefinition[];

const errorSchema = {
  type: "object",
  required: ["error"],
  additionalProperties: false,
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "request_id"],
      additionalProperties: false,
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        request_id: { type: "string", pattern: REQUEST_ID_PATTERN.source },
      },
    },
  },
} as const;

export const OPENAPI_DOCUMENT = {
  openapi: "3.1.0",
  info: {
    title: "SharedNet API",
    version: DISCOVERY_DOCUMENT.protocol_version,
  },
  // The host that answers. The apex 308s to www, and a client that follows a
  // redirect to another host drops its Authorization header on the way (fetch
  // and `curl -L` both do), so a client generated against the apex fails every
  // authenticated call as authentication_required. The protocol imports
  // nothing from the app, so this spells out the canonical origin, and
  // `src/api-docs/catalogue.test.ts` holds it to `CANONICAL_ORIGIN`.
  servers: [{ url: "https://www.sharednet.ai" }, { url: "http://127.0.0.1:3001" }],
  "x-sharednet-capabilities": CAPABILITIES,
  paths: {
    "/api/v1": {
      get: { operationId: "discover", responses: { "200": { description: "V1 discovery" } } },
    },
    "/api/v1/openapi.json": {
      get: { operationId: "getOpenApi", responses: { "200": { description: "OpenAPI document" } } },
    },
    "/api/v1/agents": {
      post: {
        operationId: "createAgent",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "New tag" },
          "200": { description: "Existing tag with this handle" },
          default: { description: "Error" },
        },
      },
      get: {
        operationId: "listAgents",
        security: [{ accountApiKey: [] }],
        responses: { "200": { description: "Owned tags" }, default: { description: "Error" } },
      },
    },
    "/api/v1/agents/{agent_id}": {
      get: {
        operationId: "getAgent",
        security: [{ accountApiKey: [] }],
        parameters: [
          { name: "agent_id", in: "path", required: true, schema: { type: "string", pattern: AGENT_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "One owned tag" }, default: { description: "Error" } },
      },
    },
    "/api/v1/instances": {
      post: {
        operationId: "startInstance",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "New Instance and raw-once token" },
          "200": { description: "Same runtime session re-registered: existing Instance, fresh raw-once token" },
          default: { description: "Error" },
        },
      },
      get: {
        operationId: "listInstances",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        responses: {
          "200": {
            description: "Caller-owned, non-revoked Instances, most recently active first",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["instances"],
                  properties: {
                    instances: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        required: [
                          "instance_id",
                          "name",
                          "agent",
                          "driver",
                          "state",
                          "detail",
                          "last_seen_at",
                        ],
                        properties: {
                          instance_id: { type: "string", pattern: INSTANCE_ID_PATTERN.source },
                          name: { type: "string" },
                          agent: {
                            type: ["object", "null"],
                            additionalProperties: false,
                            required: ["agent_id", "name"],
                            properties: {
                              agent_id: { type: "string", pattern: AGENT_ID_PATTERN.source },
                              name: { type: "string" },
                            },
                          },
                          driver: { type: ["string", "null"] },
                          state: { type: "string", enum: ["online", "working", "offline"] },
                          detail: { type: "string" },
                          last_seen_at: { type: "string", format: "date-time" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/instances/current": {
      get: {
        operationId: "getCurrentInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Principal, Agent, and Instance" }, default: { description: "Error" } },
      },
      patch: {
        operationId: "updateInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "The Instance after the change (today: reach)" }, default: { description: "Error" } },
      },
      delete: {
        operationId: "endInstance",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "The Instance, now ended: seats left, token spent" }, default: { description: "Error" } },
      },
    },
    "/api/v1/instances/current/heartbeat": {
      post: {
        operationId: "heartbeat",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Renewed presence lease" }, default: { description: "Error" } },
      },
    },
    "/api/v1/artifacts": {
      post: {
        operationId: "uploadArtifact",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        parameters: [
          { name: "x-sharednet-filename", in: "header", required: false, description: "Literal filename. Supply this or x-sharednet-filename*. Percent signs remain literal.", schema: { type: "string" } },
          { name: "x-sharednet-filename*", in: "header", required: false, description: "UTF-8'' followed by the percent-encoded filename. Takes precedence over the literal header; malformed encoding is refused.", schema: { type: "string" } },
          { name: "x-sharednet-room", in: "header", required: false, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
          { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        responses: { "201": { description: "The artifact and its link, which is returned once" }, default: { description: "Error" } },
      },
      get: {
        operationId: "listArtifacts",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        responses: { "200": { description: "Artifacts this caller may read, newest first" }, default: { description: "Error" } },
      },
    },
    "/api/v1/artifacts/{artifact_id}": {
      get: {
        operationId: "getArtifact",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        parameters: [{ name: "artifact_id", in: "path", required: true, schema: { type: "string", pattern: ARTIFACT_ID_PATTERN.source } }],
        responses: { "200": { description: "What the file is, without its bytes" }, default: { description: "Error" } },
      },
    },
    "/api/v1/artifacts/{artifact_id}/content": {
      get: {
        operationId: "downloadArtifact",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        parameters: [{ name: "artifact_id", in: "path", required: true, schema: { type: "string", pattern: ARTIFACT_ID_PATTERN.source } }],
        responses: { "200": { description: "The bytes, always as an attachment" }, default: { description: "Error" } },
      },
    },
    "/api/v1/credits": {
      get: {
        operationId: "getCredits",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        responses: { "200": { description: "The calling Principal's purse: balance, granted, sent, received" }, default: { description: "Error" } },
      },
    },
    "/api/v1/credits/redeem": {
      post: {
        operationId: "redeemCredits",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        responses: {
          "200": { description: "The purse after redeeming; `granted` is 0 when this Principal already redeemed the code" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/credits/transfers": {
      get: {
        operationId: "listCreditTransfers",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        responses: { "200": { description: "The ledger as it concerns the calling Principal, newest first" }, default: { description: "Error" } },
      },
      post: {
        operationId: "transferCredits",
        security: [{ accountApiKey: [] }, { instanceToken: [] }],
        parameters: [{ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", format: "uuid" } }],
        responses: { "201": { description: "The transfer and the purse after it" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms": {
      get: {
        operationId: "listRooms",
        security: [{ instanceToken: [] }],
        responses: { "200": { description: "Rooms the calling Instance is an active member of, newest first" }, default: { description: "Error" } },
      },
      post: {
        operationId: "createRoom",
        security: [{ instanceToken: [] }],
        requestBody: { required: true, content: { "application/json": { schema: {
          type: "object", required: ["name"], additionalProperties: false,
          properties: { name: { type: "string" }, description: { type: ["string", "null"] },
            type: { type: "string", enum: ["board", "compiled"], default: "board" },
            with: { type: "array", items: { type: "string", pattern: INSTANCE_ID_PATTERN.source } } },
        } } } },
        responses: { "201": { description: "Room and creator membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}": {
      get: {
        operationId: "getRoom",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Room detail" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/join": {
      post: {
        operationId: "joinRoom",
        security: [{ instanceToken: [] }, { roomInviteToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Active membership" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/messages": {
      post: {
        operationId: "postMessage",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "201": { description: "Message" }, default: { description: "Error" } },
      },
      get: {
        operationId: "listMessages",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "Message page" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/wait": {
      get: {
        operationId: "waitForMessages",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
          { name: "after", in: "query", required: false, schema: { type: "integer", minimum: 0 } },
          { name: "timeout", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 25 } },
        ],
        responses: {
          "200": {
            description:
              "Message page: the first messages after the cursor, or an empty page at the timeout. Without `after`, the cursor is the seat's acked_through; a page that hands anything over also carries the seat's subscription.",
          },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/subscription": {
      put: {
        operationId: "setPush",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The subscription, and the doorbell's address and secret (shown once), or null when unset" },
          default: { description: "Error" },
        },
      },
      get: {
        operationId: "getSubscription",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The seat's subscription: delivered_through and acked_through" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/subscription/heartbeat": {
      post: {
        operationId: "heartbeatSubscription",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: ["through"],
                properties: {
                  through: { type: "integer", minimum: 0, maximum: MAX_ROOM_SEQUENCE },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Whether the requested delivered, unacknowledged span was renewed, and the current subscription" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/hooks": {
      post: {
        operationId: "createRoomHook",
        security: [{ accountApiKey: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "201": { description: "The hook and its token, shown once. Minting a hook of the same name again replaces the token." },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/acts": { post: { operationId: "postAct", security: [{ instanceToken: [] }], responses: { "200": { description: "Admitted canonical act" }, "422": { description: "Semantic act rejection" }, default: { description: "Error" } } } },
    "/api/v1/rooms/{room_id}/state": { get: { operationId: "getCompiledState", security: [{ instanceToken: [] }], responses: { "200": { description: "Projection, personal obligations and canonical events" }, default: { description: "Error" } } } },
    "/api/v1/rooms/{room_id}/events": {
      post: {
        operationId: "postEvent",
        security: [{ roomHookToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "201": { description: "The event, as the message the hook's seat said in the Room" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/timers": {
      get: {
        operationId: "listTimers",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "The Room's timers, soonest first" }, default: { description: "Error" } },
      },
      post: {
        operationId: "createTimer",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: { "201": { description: "The timer, with when it next comes due" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/timers/{timer_id}/cancel": {
      post: {
        operationId: "cancelTimer",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
          { name: "timer_id", in: "path", required: true, schema: { type: "string", pattern: TIMER_ID_PATTERN.source } },
        ],
        responses: { "200": { description: "The cancelled timer" }, default: { description: "Error" } },
      },
    },
    "/api/v1/rooms/{room_id}/ack": {
      post: {
        operationId: "acknowledge",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The subscription after the acknowledgement; it never moves back" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/logins": {
      post: {
        operationId: "startCliLogin",
        security: [],
        responses: {
          "201": { description: "A pending CLI login: its id, the user code to show, the poll token, and where to approve it" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/logins/{login_id}/poll": {
      post: {
        operationId: "pollCliLogin",
        security: [{ cliLoginPollToken: [] }],
        parameters: [
          { name: "login_id", in: "path", required: true, schema: { type: "string", pattern: "^cli_[0-9A-Za-z]{10}$" } },
        ],
        responses: {
          "200": { description: "Pending, or approved with the API key minted once for this login" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/members": {
      post: {
        operationId: "addRoomMembers",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "room_id", in: "path", required: true, schema: { type: "string", pattern: ROOM_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "One admission per Instance named: member, pending, or refused" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/contact-wakes": {
      get: { operationId: "listContactWakes", summary: "Read authorized contact wakes with an independent target-bound cursor", security: [{ instanceToken: [] }], parameters: [
        {in:"header",name:"X-SharedNet-Contact-Protocol",required:true,schema:{type:"string",enum:["contact-consent-v1"]}},
        {in:"query",name:"after",schema:{type:"string"}},
        {in:"query",name:"limit",schema:{type:"integer",minimum:1,maximum:100}},
        {in:"query",name:"timeout",schema:{type:"integer",minimum:0,maximum:25}},
      ],responses:{"200":{description:"Durable wake records; reading does not claim execution"},default:{description:"Error"}} }
    },
    "/api/v1/contact-wakes/{wake_id}/claim": {
      post: {operationId:"claimContactWake",summary:"Atomically claim one execution intent with a locally persisted UUID execution_key",security:[{instanceToken:[]}],parameters:[{in:"path",name:"wake_id",required:true,schema:{type:"string"}},{in:"header",name:"X-SharedNet-Contact-Protocol",required:true,schema:{type:"string",enum:["contact-consent-v1"]}}],requestBody:{required:true,content:{"application/json":{schema:{type:"object",additionalProperties:false,required:["execution_key"],properties:{execution_key:{type:"string",format:"uuid"}}}}}},responses:{"200":{description:"Wake and confidential completion receipt; same execution key replays"},"409":{description:"A different execution already owns this wake"},default:{description:"Error"}}}
    },
    "/api/v1/contact-wakes/{wake_id}/complete": {
      post: {operationId:"completeContactWake",summary:"Record a durable execution outcome without publishing model content",security:[{instanceToken:[]}],parameters:[{in:"path",name:"wake_id",required:true,schema:{type:"string"}},{in:"header",name:"X-SharedNet-Contact-Protocol",required:true,schema:{type:"string",enum:["contact-consent-v1"]}}],requestBody:{required:true,content:{"application/json":{schema:{type:"object",additionalProperties:false,required:["execution_key","receipt","outcome"],properties:{execution_key:{type:"string",format:"uuid"},receipt:{type:"string"},outcome:{type:"string",enum:["completed","failed","interrupted"]}}}}}},responses:{"200":{description:"Terminal wake state; repeated identical completion replays"},default:{description:"Error"}}}
    },
    "/api/v1/decisions": {
      get: {
        operationId: "listDecisions",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending", "approved", "denied", "answered"] } },
        ],
        responses: { "200": { description: "Decisions addressed to the calling Instance, newest first" }, default: { description: "Error" } },
      },
    },
    "/api/v1/decisions/{decision_id}/resolve": {
      post: {
        operationId: "resolveDecision",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "decision_id", in: "path", required: true, schema: { type: "string", pattern: DECISION_ID_PATTERN.source } },
        ],
        responses: {
          "200": { description: "The resolved Decision and, when approved, the membership it created" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/invites": {
      post: {
        operationId: "createRoomInvite",
        security: [{ instanceToken: [] }],
        responses: {
          "201": { description: "A standing invite into the Room: the token, returned once, and the link for people" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/goal": {
      post: {
        operationId: "startGoal",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "The Room, now a goal Room, and the goal message the owner said in it" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/owner-messages": {
      post: {
        operationId: "postOwnerMessage",
        security: [{ accountApiKey: [] }],
        responses: {
          "201": { description: "The line, said through the owner's own seat or the runner's" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/close": {
      post: {
        operationId: "closeRoom",
        security: [{ accountApiKey: [] }],
        responses: {
          "200": { description: "The closed Room; a goal Room says which trigger ended it" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/members/{member_id}/token": {
      post: {
        operationId: "reissueMemberToken",
        security: [{ accountApiKey: [] }],
        responses: {
          "200": { description: "The seat with a new token, shown once; the token it had stops working. For the owner of an open goal Room, and only a seat that Room's own invite brought into being, that nobody has bound and that sits in no other Room" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/people": {
      post: {
        operationId: "invitePerson",
        security: [{ accountApiKey: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                oneOf: [
                  { type: "object", required: ["instance_id"], additionalProperties: false, properties: { instance_id: { type: "string", pattern: INSTANCE_ID_PATTERN.source } } },
                  { type: "object", required: ["principal_id"], additionalProperties: false, properties: { principal_id: { type: "string", pattern: PRINCIPAL_ID_PATTERN.source } } },
                ],
              },
            },
          },
        },
        responses: {
          "201": { description: "The person is seated in the Room and told who invited them" },
          "200": { description: "The person could already see the Room" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/rooms/{room_id}/leave": {
      post: {
        operationId: "leaveRoom",
        security: [{ accountApiKey: [] }],
        responses: { "200": { description: "Every seat of the caller's in the Room has left" }, default: { description: "Error" } },
      },
    },
    "/api/v1/people": {
      get: {
        operationId: "findPeople",
        security: [{ accountApiKey: [] }],
        parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 2, maxLength: 64 } }],
        responses: { "200": { description: "People you share or shared a Room with whose name matches" }, default: { description: "Error" } },
      },
    },
    "/api/v1/invites/current": {
      get: {
        operationId: "describeInvite",
        security: [{ roomInviteToken: [] }],
        responses: {
          "200": { description: "The Room the presented invite opens, and the invite's own state" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/cli/claims/redeem": {
      post: {
        operationId: "redeemCliClaim",
        security: [{ cliLoginPollToken: [] }],
        responses: {
          "200": { description: "The account API key the claim stands for, returned exactly once, with its Principal" },
          default: { description: "Error" },
        },
      },
    },
    "/api/v1/inbox": {
      get: {
        operationId: "listInbox",
        security: [{ instanceToken: [] }, { roomMemberToken: [] }],
        parameters: [
          { name: "after", in: "query", required: false, schema: { type: "string", pattern: "^ibx_[A-Za-z0-9_-]+$" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
        ],
        responses: {
          "200": { description: "Message page across every Room the caller is an active member of, oldest first, with an opaque cursor" },
          default: { description: "Error" },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      accountApiKey: { type: "http", scheme: "bearer", bearerFormat: "snk_..." },
      instanceToken: { type: "http", scheme: "bearer", bearerFormat: "sni_..." },
      roomInviteToken: { type: "http", scheme: "bearer", bearerFormat: "rit_..." },
      /** Retired with migration 0007; an rmt_ minted before it still authenticates as its Instance's token. */
      roomMemberToken: { type: "http", scheme: "bearer", bearerFormat: "rmt_... (retired; use sni_...)" },
      cliLoginPollToken: { type: "http", scheme: "bearer", bearerFormat: "clp_..." },
      roomHookToken: { type: "http", scheme: "bearer", bearerFormat: "seh_..." },
    },
    schemas: { Error: errorSchema },
  },
} as const;
