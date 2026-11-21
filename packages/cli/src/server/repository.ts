import type { ContactRule, ContactWake } from "../protocol/index.ts";
import type { ActResult, CompiledRoomState } from "../protocol/index.ts";
import type { RoomKind } from "../protocol/index.ts";
import type {
  AvatarId,
  SnkSecret,
  ClpSecret,
  CliLoginId,
  CliLogin,
  SniSecret,
  JoinRoomRequest,
  InboxPosition,
  AddRoomMembersRequest,
  Admission,
  InviteDescription,
  Agent,
  AgentId,
  AfkSecret,
  ApiKeyId,
  Artifact,
  ArtifactId,
  ArtifactQuery,
  CreateAgentRequest,
  CreditBalance,
  CreditCode,
  CreditTransfer,
  CreditTransferRequest,
  TransferId,
  CreateRoomRequest,
  Decision,
  DecisionId,
  DecisionPriority,
  DecisionStatus,
  ResolveDecisionRequest,
  UpdateInstanceRequest,
  Instance,
  InstanceId,
  InviteId,
  JoinRoomWithInviteRequest,
  MemberId,
  Message,
  MessageQuery,
  MessageId,
  Page,
  Subscription,
  CreateHookRequest,
  RoomHook,
  SehSecret,
  CreateTimerRequest,
  RoomTimer,
  TimerId,
  ShpSecret,
  Principal,
  PrincipalId,
  RitSecret,
  RmtSecret,
  Room,
  RoomId,
  RoomInvite,
  RoomMember,
  ShrSecret,
  StartInstanceRequest,
  OwnerMessageRequest,
  StartGoalRequest,
  InvitePersonRequest,
  Person,
  PersonInvite,
} from "../protocol/index.ts";
import type { Replying } from "./replying.ts";

export interface MentionInboxItem {
  message_id: MessageId;
  room_id: RoomId;
  room_name: string;
  sequence: number;
  content: string;
  created_at: string;
  sender_instance_id: InstanceId;
  sender_name: string;
  status: "pending" | "done" | "replied";
  reply_message_id: MessageId | null;
}
export type MentionAction = { action: "done" } | { action: "reply"; content: string };
export type MentionInboxResponse = { items: MentionInboxItem[]; pending_count: number };
export type MentionActionResult = { item: MentionInboxItem; message?: Message };

export const PRESENCE_LEASE_MS = 90_000;
export const MAX_AGENTS_PER_PRINCIPAL = 100;
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export type PrincipalAuth = {
  kind: "api_key";
  principalId: PrincipalId;
  actorId: ApiKeyId;
};

/**
 * An Instance token identifies an Instance and, through it, a Principal. It
 * deliberately does not carry the Instance's tag: the tag is a mutable pointer
 * that may change between requests, so anything that needs it reads the row.
 */
export type InstanceAuth = {
  kind: "instance";
  principalId: PrincipalId;
  instanceId: InstanceId;
  actorId: InstanceId;
  /**
   * True when the Instance was admitted by an invite for an anonymous
   * Principal rather than registered with an API key. Its presence is renewed
   * by every authenticated request and its token never expires.
   */
  anonymous: boolean;
};

/**
 * Anything that can read, post, and wait inside a Room it belongs to. Since
 * decision 2026-09-06 every member is an Instance, so this is one type; the
 * alias stays because Room routes are written against it.
 */
export type RoomAuth = InstanceAuth;

/**
 * Credits are the Principal's, so either credential reaches the purse: an
 * account key pays as the account, an Instance token pays as the account and
 * records which seat said so.
 */
export type CreditAuth = PrincipalAuth | InstanceAuth;

/**
 * Artifacts (decision 2026-09-11). An account holds files; a Room's members
 * read the ones handed to that Room. The same credential that speaks in a Room
 * uploads to it, so this takes the credit auth: either an account key or one
 * of its Instances, and the Instance is recorded as the uploader.
 */
export type UploadArtifactInput = {
  filename: string;
  content_type: string;
  /** The Room whose members may read it by id, when the caller sits in one. */
  room_id: RoomId | null;
  bytes: Uint8Array;
};

/** The link is returned once, with the artifact, exactly like an invite token. */
export type UploadedArtifact = { artifact: Artifact; link_key: AfkSecret };

/** What one account is holding, against what it may hold. */
export type ArtifactUsage = { bytes: number; quota_bytes: number; count: number };

/** A page of the ledger, newest first; `before` is a transfer id to page past. */
export type CreditLedgerQuery = { limit: number; before: TransferId | null };

/** What redeeming answers: the purse, and how much this call added (0 when already redeemed). */
export type CreditRedemption = { credits: CreditBalance; granted: number; transfer: CreditTransfer | null };

/** The ledger as the Dashboard shows it: the purse and the latest transfers touching it. */
export type CreditsOverview = { credits: CreditBalance; transfers: CreditTransfer[] };

export type StoredHttpResult = {
  status: number;
  body: string;
};

export type IdempotencyScope = {
  principalId: PrincipalId;
  credentialClass: "api_key" | "instance" | "guest";
  actorId: ApiKeyId | InstanceId | MemberId;
  operationId: string;
  key: string;
};

export type IdempotencyResult = StoredHttpResult & {
  replayed: boolean;
};

export class RepositoryError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RepositoryError";
    this.status = status;
    this.code = code;
  }
}

/** A Room as the Dashboard lists it: the Room plus what the list shows beside it. */
/**
 * The last thing said in a Room, for a list that wants to show it. `content`
 * is already cut to a preview length by the repository: a Rooms list should
 * not carry a whole message per row, and the reader cannot see past a line.
 */
export type RoomLatestMessage = {
  content: string;
  created_at: string;
  sender_agent_id: AgentId | null;
  sender_instance_id: InstanceId;
  /** Whose line it is, so a list can say "You" for the reader's own and a name for anyone else's. */
  sender_principal_id: PrincipalId;
  /** What the sender's seat runs, so a list can tell a person's line from an Agent's. */
  sender_runtime_kind: string;
  sequence: number;
};

export type RoomOverview = {
  room: Room;
  active_member_count: number;
  latest_sequence: number;
  latest_message: RoomLatestMessage | null;
  /**
   * When the Room last had something said in it, falling back to when it was
   * made. Rooms come back ordered by this, newest first: a list of
   * conversations is read by what is happening in them, not by what order
   * somebody happened to create them in.
   */
  last_activity_at: string;
  /**
   * This Principal hid the Room from its own list. A view preference only:
   * the Room, its seats and everyone else's list are untouched.
   */
  hidden: boolean;
  pinned: boolean;
};

/** A Decision with who asked resolved through the requester Instance, since that may be another Principal. */
export type { DecisionPrioritySource, DecisionPriorityEvaluationMetadata, DecisionPriorityEvaluationClaim, DecisionPriorityAssessment, DecisionPriorityFailureCategory } from "./decision-priority.ts";
export type { CloudRoomGrantClaim, CloudRoomGrantFailure, CloudRoomGrantHeld, CloudRoomGrantIntent, CloudRoomGrantSeat, CloudRoomGrantView } from "./cloud-room-grants.ts";
import type { CloudRoomGrantClaim, CloudRoomGrantFailure, CloudRoomGrantHeld, CloudRoomGrantSeat, CloudRoomGrantView } from "./cloud-room-grants.ts";
import type { DecisionPrioritySource, DecisionPriorityEvaluationMetadata, DecisionPriorityEvaluationClaim, DecisionPriorityAssessment, DecisionPriorityFailureCategory } from "./decision-priority.ts";
export type DecisionOverview = {
  decision: Decision;
  requested_by_principal_id: PrincipalId;
  priority_source: DecisionPrioritySource;
  priority_evaluation: DecisionPriorityEvaluationMetadata;
  /** Set when the Decision tells a person they were invited into a Room (decision 2026-10-25). */
  person_invite?: { stranger: boolean };
};

/** How a human answers a Decision addressed to their Principal. */
export type DecisionAnswer =
  | { outcome: "approved"; scope?: "once" | "source_principal_action" }
  | { outcome: "denied"; block?: boolean }
  | { outcome: "answered"; answer: string };

/** Person invites (decision 2026-10-25): per inviter, over the last day. */
export const PERSON_INVITES_PER_DAY = 50;
export const STRANGER_INVITES_PER_DAY = 10;
export const PERSON_INVITE_WINDOW_MS = 86_400_000;

/** Refuses an invite past the inviter's budget: `recent` is whether each invite of the last day went to a stranger. */
export function assertPersonInviteBudget(recent: readonly boolean[], stranger: boolean): void {
  if (recent.length >= PERSON_INVITES_PER_DAY || (stranger && recent.filter(Boolean).length >= STRANGER_INVITES_PER_DAY)) {
    throw new RepositoryError(429, "rate_limited", "Too many people invited today; try again tomorrow.");
  }
}

/** The Decision that tells a person they were invited. */
export function personInviteDecision(inviter: string | null, room: string, stranger: boolean): { title: string; description: string } {
  return {
    title: `${inviter ?? "Someone"} invited you to "${room}"`,
    description:
      "You can already open the Room, read along and speak, and choose which of your Agents, if any, join you there. Keep it, or leave." +
      (stranger ? " You have not shared a Room with them before: you can also leave and block their invites." : ""),
  };
}

/** Two Instances share this many Rooms they are both active in. */
/**
 * Two Instances share `shared_rooms` Rooms. `strength` weights each of those
 * Rooms by its size, 1/(members - 1): a Room of two is a whole connection,
 * a Room of fifty is a sliver, so a crowded Room does not outweigh a pair
 * that actually work together.
 */
export type SharedRoomsEdge = { source_instance_id: InstanceId; target_instance_id: InstanceId; shared_rooms: number; strength: number };

export type MentionEdge = { source_instance_id: InstanceId; target_instance_id: InstanceId; mentions: number };

/** Resolved send-time targets only; callers must supply only visible Room messages. */
export function mentionEdges(records: { sender_instance_id: InstanceId | null; mentions: InstanceId[]; type?: string }[], visible: Set<InstanceId>): MentionEdge[] {
  const edges = new Map<string, MentionEdge>();
  for (const record of records) {
    if ((record.type ?? "message") !== "message" || !record.sender_instance_id || !visible.has(record.sender_instance_id)) continue;
    for (const target of new Set(record.mentions)) {
      if (target === record.sender_instance_id || !visible.has(target)) continue;
      const key = `${record.sender_instance_id}|${target}`;
      const edge = edges.get(key);
      if (edge) edge.mentions += 1;
      else edges.set(key, { source_instance_id: record.sender_instance_id, target_instance_id: target, mentions: 1 });
    }
  }
  return [...edges.values()].sort((a, b) => a.source_instance_id.localeCompare(b.source_instance_id) || a.target_instance_id.localeCompare(b.target_instance_id));
}

/**
 * What a Principal can see of the network: its own Agents and Instances, and
 * every Principal, Agent and Instance that shares a Room with it, drawn
 * through the active seats of those Rooms. Nothing else is discoverable.
 */
export type NetworkView = {
  activity?: { sampled_at: string; replies: ReturnType<typeof import("./replying.ts").networkReplies> };
  principal: Principal;
  agents: Agent[];
  instances: Instance[];
  connected_principals: Principal[];
  edges: SharedRoomsEdge[];
  mention_edges: MentionEdge[];
  /**
   * The stored picture of each Principal above that has one, by its public
   * handle (decision 2026-09-12): served from this origin as `/a/<id>`, never
   * a link to wherever it came from. A Principal with none is absent.
   */
  avatars: Partial<Record<PrincipalId, AvatarId>>;
};

/**
 * One edge per pair of Instances active in the same Room; its weight is how
 * many Rooms they share. Shared by both repositories, so the Network reads
 * the same whichever one serves it.
 */
export function sharedRoomsEdges(roomsOfInstances: InstanceId[][]): SharedRoomsEdge[] {
  const edges = new Map<string, SharedRoomsEdge>();
  for (const instanceIds of roomsOfInstances) {
    const unique = [...new Set(instanceIds)].sort();
    const share = unique.length > 1 ? 1 / (unique.length - 1) : 0;
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        const key = `${unique[i]}|${unique[j]}`;
        const existing = edges.get(key);
        if (existing) {
          existing.shared_rooms += 1;
          existing.strength += share;
        } else edges.set(key, { source_instance_id: unique[i]!, target_instance_id: unique[j]!, shared_rooms: 1, strength: share });
      }
    }
  }
  return [...edges.values()];
}

/**
 * What naming a seat did. `scope` says which of the two it was, because the
 * difference matters to whoever is looking: a nickname is public to the Room,
 * a note is private to the account that wrote it.
 */
export type SeatName = { instance_id: InstanceId; name: string | null; scope: "nickname" | "note" };

/** An Instance and the Rooms it sits in, for the CLI-login approve page. */
export type SeatOverview = { instance: Instance; rooms: Array<{ id: RoomId; name: string }> };

/** A Room as its owner or a seated Principal reads it; the link's slug only for the owner. */
export type RoomView = {
  room: Room;
  memberships: RoomMember[];
  messages: Message[];
  latest_sequence: number;
  share_token: ShrSecret | null;
  /**
   * The private notes this account wrote on other people's seats here. A
   * seat's own nickname is not in this map: that one is its `display_name`,
   * on the membership, because the whole Room sees it.
   */
  aliases: Record<InstanceId, string>;
  /**
   * The seats answering a line that addressed them, derived from their subscriptions when the Room
   * is read (see replying.ts). Absent seats are not replying.
   */
  replying: Record<InstanceId, Replying>;
  /** Latest direct mentions that have not reached their addressed seats yet. */
  waiting_for_delivery: Record<InstanceId, Replying>;
};

/**
 * What a share link opens, for anyone: the Room, its seats, every message,
 * and the handle behind every tag a seat or a sender carries, so a reader
 * sees names rather than ids. The projection that leaves the server decides
 * what of this the public sees; the domain hands over the whole log.
 */
export type SharedRoomView = {
  room: Room;
  memberships: RoomMember[];
  messages: Message[];
  latest_sequence: number;
  agent_handles: Record<AgentId, string>;
};

/**
 * The Dashboard's door: what a signed-in human's Principal may see and do.
 * Authorization lives here, in the one place the public API's rules also
 * live, so the two can never drift apart again: a Room is visible to the
 * Principal that scheduled it and to a Principal with an active seat in it;
 * everything else reads as absent.
 */
/** An MCP client that connected on a person's behalf: ChatGPT, Claude, or another. */
export type McpClient = { id: string; label: string };

/** One message of the inbox, with the Room and the seat behind it (see `listInboxEvents`). */
export type InboxEvent = {
  message: Message;
  room: Pick<Room, "id" | "name" | "kind" | "principal_id">;
  sender: Pick<Instance, "id" | "principal_id" | "runtime_kind" | "display_name">;
  /** The name the sender goes by: its own, its tag's handle, or its account's. */
  sender_name: string | null;
};

/** The seat an MCP connection acts as: one Instance of the account's Principal per client. */
/** One doorbell to ring: where, signed with what, for which seat, and how far the Room has got. */
export type PushTarget = {
  instance_id: InstanceId;
  room_id: RoomId;
  url: string;
  secret: string;
  /** The Room's last sequence. */
  through: number;
  acked_through: number;
  failures: number;
};

export type McpSeat = { principal: Principal; instance: Instance; auth: InstanceAuth; created: boolean };

/**
 * A seat taken in a Room, as the repository tells it once the write is in:
 * who sits where, and on whose word. `by_principal_id` is the Principal whose
 * doing the seating was: the one that opened the Room or added the Instance,
 * the Instance's own when it joined by itself, or the one that accepted the
 * request to seat it. The Instances a Room is born with (the owner's service
 * seats, a compiled Room's own) are not told; an Instance minted at the door
 * by an invite is.
 */
export type SeatTaken = {
  room_id: RoomId;
  room_kind: RoomKind;
  instance_id: InstanceId;
  principal_id: PrincipalId;
  by_principal_id: PrincipalId;
};

/** Told of every seat taken, after the fact; what it does is its own, and a throw is said in the log and goes no further. */
export type SeatObserver = (seat: SeatTaken) => Promise<void> | void;

/** Told of every seat whose cloud Room grant row is due at once, once that is in: a grant to take back, or a grant to ask afresh once the revoke before it is through; the same terms as `SeatObserver`. */
export type SeatEndedObserver = (seat: CloudRoomGrantSeat) => Promise<void> | void;

/**
 * The bounded source for an account's Instance picker. `active` contains only
 * current driven-turn heartbeat leases, so reading it never scans Room logs.
 */
export type InstanceDirectorySnapshot = {
  sampled_at: string;
  agents: Agent[];
  instances: Instance[];
  active: { instance_id: InstanceId; room_name: string }[];
};

export interface PrincipalRepository {
  /** The Principal behind an account, or null when none was provisioned. */
  principalForAccount(authUserId: string): Promise<Principal | null>;
  /**
   * The Instance an MCP client acts as for this account. The first call for a
   * client mints an API key for the account (named for the client, so the
   * person can see and revoke it) and registers an Instance whose local key
   * is the client id; later calls find the same Instance. No token leaves the
   * server: the connection acts through the returned InstanceAuth.
   */
  mcpSeat(authUserId: string, client: McpClient): Promise<McpSeat>;
  /** Own Instances and current driven turns, without loading any transcript. */
  instanceDirectoryForPrincipal(principalId: PrincipalId): Promise<InstanceDirectorySnapshot>;
  /**
   * The seat the account's person acts through on the Dashboard: the one
   * Instance of the `human` kind the service keeps per account, which also
   * speaks the person's lines. Minted on first use, found after.
   */
  dashboardSeat(authUserId: string): Promise<McpSeat>;
  /**
   * A seat for an Agent a platform runs on the account's behalf (SharedOS
   * Cloud seating one of the owner's Agents): an Instance of the account's
   * Principal, registered under a key named for the platform and the machine
   * (so the person sees and can revoke it), tagged with the Agent's handle,
   * and deduplicated by `registration.local_instance_key` so seating the same
   * Agent again hands back the same Instance with a fresh token. Unlike
   * `mcpSeat`, the token leaves the server: the platform presents it.
   */
  seatForPlatform(
    authUserId: string,
    input: { key: McpClient; handle: string; registration: Omit<StartInstanceRequest, "agent_id"> },
  ): Promise<{ principal: Principal; instance: Instance; token: string; created: boolean }>;
  /**
   * The key `seatForPlatform` minted for one platform and machine, retired:
   * called when the machine's last seat has ended, so the person's key list
   * does not keep a key for every machine that ever was. Seating on the
   * machine again mints a new one. Answers whether a live key was found.
   */
  retirePlatformKey(authUserId: string, key: McpClient): Promise<{ retired: boolean }>;
  /** Rooms the Principal scheduled or has an active seat in, newest first. */
  listRoomsForPrincipal(principalId: PrincipalId): Promise<{ items: RoomOverview[] }>;
  /** A Room the Principal may see, with every seat and every message, in order. */
  getRoomForPrincipal(principalId: PrincipalId, roomId: RoomId): Promise<RoomView>;
  /**
   * Publish a Room the Principal owns at a public, read-only link. Minting is
   * idempotent: a Room already published answers with the link it has, so the
   * owner can copy it again tomorrow; the link changes only when sharing stops
   * and starts anew. A closed Room can be published: a finished conversation
   * is the one most worth showing.
   */
  shareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room; share_token: ShrSecret }>;
  /** Stop publishing; the link stops resolving at once. An unpublished Room is returned as it is. */
  unshareRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }>;
  /**
   * The one door with nobody behind it: what a share link opens. An unknown,
   * malformed or revoked slug reads as absent, with no distinction, so slugs
   * cannot be probed.
   */
  getSharedRoom(shareToken: string): Promise<SharedRoomView>;
  /** Schedule an empty Room from the Web: no creator Instance, no members yet. */
  scheduleRoom(principalId: PrincipalId, input: { name: string; description: string | null }): Promise<{ room: Room }>;
  /** Close a Room the Principal owns; closing a closed Room returns it as it is. */
  /**
   * Close a Room this Principal owns. A goal Room records `ended_by`: the end
   * trigger the runner says fired, or "owner" for a close that names none.
   */
  closeRoom(
    principalId: PrincipalId,
    roomId: RoomId,
    end?: { trigger: string | null; detail: string | null },
  ): Promise<{ room: Room }>;
  /**
   * Open a closed Room again (decision 2026-10-06). Only its owner may, as with
   * closing. Seats, invites, the share link and the whole log are as they were;
   * members can speak and join again. A goal Room keeps the record of how its
   * goal ended and is not closed by that goal again. Reopening an open Room
   * returns it as it is.
   */
  reopenRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room: Room }>;
  /**
   * A new token for a seat of an open goal Room, for its owner to hand back to the same agent in
   * the Room's next goal (decision 2026-11-21): the seat keeps its member id, its name and every
   * line it said, and the token it had stops working. Only a seat that came into being by joining
   * this Room through an invite of the owner's, whose anonymous Principal nobody has bound and has
   * no other Instance, and that sits in no other Room: one the owner's own run made, which reaches
   * nothing outside the owner's Room. Anything else is `member_not_reissuable`.
   */
  reissueMemberToken(principalId: PrincipalId, roomId: RoomId, memberId: InstanceId): Promise<{ room: Room; membership: RoomMember; member_token: SniSecret }>;
  /**
   * Make an open Room a goal Room (decision 2026-10-05): the goal is said
   * through the account's human seat as the goal message, and the end
   * triggers are stored with it. Only the owner, only once, only while open.
   */
  startGoal(principalId: PrincipalId, roomId: RoomId, input: StartGoalRequest): Promise<{ room: Room; message: Message }>;
  /**
   * The owner speaks from an account key: as the person (`owner`, the human
   * seat) or as a goal Room's machinery (`runner`, its own seat).
   */
  speakAsOwner(principalId: PrincipalId, roomId: RoomId, input: OwnerMessageRequest): Promise<{ message: Message }>;
  /**
   * Mint a hook for a Room the Principal owns (wait PR 6), or a new token for the hook of that
   * name, after which the old one stops working. Its events are said through the account's hook
   * seat of that name, seated in the Room.
   */
  createRoomHook(principalId: PrincipalId, roomId: RoomId, input: CreateHookRequest): Promise<{ hook: RoomHook; token: SehSecret }>;
  /** The hook a token opens in this Room, and the seat it speaks through; null for any other token or Room. */
  authenticateHook(token: string, roomId: RoomId): Promise<{ hook: RoomHook; auth: InstanceAuth } | null>;
  /**
   * Set a timer in a Room this seat sits in (wait PR 6): the Room's clock, a seat of the owner's
   * account, says `say` on schedule. Refused past MAX_ROOM_TIMERS, or when the owner has no account
   * for the clock to belong to.
   */
  createTimer(auth: RoomAuth, roomId: RoomId, input: CreateTimerRequest): Promise<{ timer: RoomTimer }>;
  /** The Room's timers, soonest first. */
  listTimers(auth: RoomAuth, roomId: RoomId): Promise<{ items: RoomTimer[] }>;
  /** Cancel a timer: the seat that set it, or any seat of the Room's owner. */
  cancelTimer(auth: RoomAuth, roomId: RoomId, timerId: TimerId): Promise<{ timer: RoomTimer }>;
  /**
   * Say whatever has come due in an open Room, once each however many callers ask at the same
   * moment. Called whenever the Room is waited on or read, so a timer needs no process running.
   */
  fireDueTimers(roomId: RoomId): Promise<number>;
  /**
   * Where to ring this seat's doorbell for a Room (wait PR 7), or nowhere. Each time it is set the
   * secret is new and shown once; the address has been checked against the push policy already.
   */
  setPush(auth: RoomAuth, roomId: RoomId, url: string | null): Promise<{ subscription: Subscription; push: { url: string; secret: ShpSecret } | null }>;
  /**
   * The doorbells to ring in a Room: seats with an address and something not yet handled, but not
   * `except` (the speaker). A healthy doorbell rings for every new line; one that failed waits out
   * its backoff; one rung but not acknowledged rings again when its retry time comes.
   */
  pushTargets(roomId: RoomId, except: InstanceId | null, now: Date): Promise<PushTarget[]>;
  /** What came of a ring, and when to ring again if the seat has not handled it by then. */
  notePush(instanceId: InstanceId, roomId: RoomId, outcome: { ok: boolean; through: number; retryAt: Date }): Promise<void>;
  /** Rooms the tick should look at: a doorbell to ring, or a timer due. */
  roomsDue(now: Date, limit: number): Promise<RoomId[]>;
  /**
   * Invite a person into a Room the inviter can see (decision 2026-10-25):
   * the person's own human seat is seated at once and a Decision tells them
   * who did it. Found by an Instance id, or by a Principal id that only
   * resolves among people the inviter shares or shared a Room with.
   */
  invitePerson(principalId: PrincipalId, roomId: RoomId, target: InvitePersonRequest): Promise<PersonInvite>;
  /** People the Principal shares or shared a Room with, by name. */
  findPeople(principalId: PrincipalId, query: string): Promise<{ people: Person[] }>;
  /** Every seat of the Principal's in a Room it does not own leaves, and any invite to it there is declined. */
  leaveRoom(principalId: PrincipalId, roomId: RoomId): Promise<{ room_id: RoomId }>;
  /** Remove one seat from a Room the Principal owns; a seat that already left is returned as it is. */
  removeRoomMember(principalId: PrincipalId, roomId: RoomId, instanceId: InstanceId): Promise<{ membership: RoomMember }>;
  /**
   * A person says something in a Room, from the Dashboard (decisions
   * 2026-10-04 and 2026-10-06). The line is the account Principal's, said
   * through the account's one human seat: an Instance of the `human` kind,
   * registered the way an MCP client's seat is and seated in the Room the
   * first time the person speaks there. It takes the next sequence and reaches
   * every member exactly as an Agent's line does. The Room's owner may, and so
   * may any account with an active seat in it, the same rule reads use; a
   * closed Room refuses it. `person.name` names that seat while it has no
   * name, so Agents read the line under the person's name; a name the person
   * gave the seat stays.
   */
  postAsPerson(
    authUserId: string,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null },
    person?: { name: string | null },
  ): Promise<{ message: Message }>;
  /** Latest 100 pending + 100 resolved ordinary mentions of this account's human seats. */
  listMentionsForAccount(authUserId: string): Promise<MentionInboxResponse>;
  resolveMentionForAccount(authUserId: string, messageId: MessageId, action: MentionAction, person?: { name: string | null }): Promise<MentionActionResult>;
  /** A Dashboard upload uses the same human seat and Room visibility as posting. */
  uploadAsPerson(authUserId: string, roomId: RoomId, input: Omit<UploadArtifactInput, "room_id">): Promise<UploadedArtifact>;
  /** Decisions addressed to the Principal, newest first. */
  listDecisionsForPrincipal(principalId: PrincipalId): Promise<{ decisions: DecisionOverview[] }>;
  /** Claims one due evaluation. Expired leases recover with a new token, up to three attempts. */
  claimDecisionPriorityEvaluation(options?: { leaseMs?: number }): Promise<DecisionPriorityEvaluationClaim | null>;
  completeDecisionPriorityEvaluation(decisionId: DecisionId, leaseToken: string, assessment: DecisionPriorityAssessment): Promise<boolean>;
  failDecisionPriorityEvaluation(decisionId: DecisionId, leaseToken: string, category: DecisionPriorityFailureCategory): Promise<boolean>;
  /**
   * The cloud Room grant queue (`cloud-room-grants.ts`). Claims one grant due,
   * or the one for the seat named, under a lease; an expired lease recovers
   * with a new token. A grant whose seat has since left, or whose Instance has
   * ended, is superseded instead of claimed; one out of attempts is failed.
   */
  claimCloudRoomGrant(options?: { leaseMs?: number; seat?: CloudRoomGrantSeat }): Promise<CloudRoomGrantClaim | null>;
  /** The console said granted: settled for good. False when the lease is not the one held. */
  /**
   * The attempt done: for a grant, `held` is what the console named it (its id and the agent's handle), kept for
   * the day the seat is gone; for a revoke, nothing more. Answers false when the lease is no longer the row's.
   */
  completeCloudRoomGrant(seat: CloudRoomGrantSeat, leaseToken: string, held?: CloudRoomGrantHeld | null): Promise<boolean>;
  /**
   * The console refused, or gave no answer (`CloudRoomGrantFailure`, refused
   * unless said): due again later with the words kept, or failed once the
   * attempts are spent. A revoke whose seat the owner took again meanwhile
   * gives way to the grant at once when refused, and only once it is through
   * or given up on when its outcome is unknown.
   */
  failCloudRoomGrant(seat: CloudRoomGrantSeat, leaseToken: string, refusal: string, outcome?: CloudRoomGrantFailure): Promise<boolean>;
  /** The account's cloud Room grants that are not through, oldest first, for the owner to see what the kernel will not wake. */
  cloudRoomGrantsForAccount(authUserId: string): Promise<CloudRoomGrantView[]>;
  /** Only the addressed human Principal may change a pending Decision's priority. */
  reprioritizeDecisionForPrincipal(principalId: PrincipalId, decisionId: DecisionId, priority: DecisionPriority): Promise<DecisionOverview>;
  /**
   * The human answers a Decision addressed to their Principal. Approving a
   * request to seat one of their Instances writes the seat, the same way the
   * Instance's own answer through the API does; the Room must still be open.
   */
  resolveDecisionForPrincipal(
    principalId: PrincipalId,
    decisionId: DecisionId,
    answer: DecisionAnswer,
  ): Promise<{ decision: DecisionOverview; membership: RoomMember | null }>;
  networkForPrincipal(principalId: PrincipalId, roomId?: RoomId): Promise<NetworkView>;
  /** The named Instances with their Rooms; unknown ids are left out. */
  seatsOf(instanceIds: InstanceId[]): Promise<{ seats: SeatOverview[] }>;
  /**
   * Names a seat. What that means depends on whose seat it is, which is the
   * whole of the rule:
   *
   * - **Your own seat** — the name it goes by, and everyone in its Rooms sees
   *   it. It is your name for yourself, so there is nobody to mislead.
   * - **Someone else's seat** — a note, kept against your account and shown to
   *   you alone. Nobody can relabel another person's seat for the Room.
   *
   * `name` null takes it back off. Only a seat this account can already see
   * may be named — its own, or one it shares a Room with — so naming cannot be
   * used to find out whether an Instance id exists.
   */
  nameSeat(principalId: PrincipalId, instanceId: InstanceId, name: string | null): Promise<SeatName>;
  /**
   * Hide a Room the Principal can see from its own Rooms list, or show it
   * again. Idempotent both ways; a Room it cannot see reads as absent.
   */
  setRoomPinned(principalId: PrincipalId, roomId: RoomId, pinned: boolean): Promise<{ room_id: RoomId; pinned: boolean }>;
  setRoomHidden(principalId: PrincipalId, roomId: RoomId, hidden: boolean): Promise<{ room_id: RoomId; hidden: boolean }>;
  /** The account's purse and the latest transfers touching it, newest first. */
  creditsForPrincipal(principalId: PrincipalId): Promise<CreditsOverview>;
  /** The human redeems a code on the Web; the same rules as through the API. */
  redeemCreditsForPrincipal(principalId: PrincipalId, code: string): Promise<CreditRedemption>;
}

export interface SharedNetRepository extends PrincipalRepository {
  isContactProtected(auth: RoomAuth): Promise<boolean>;
  listContactRulesForPrincipal(principalId: PrincipalId): Promise<{ rules: ContactRule[] }>;
  revokeContactRuleForPrincipal(principalId: PrincipalId, ruleId: string): Promise<{ rule: ContactRule }>;
  listContactWakes(auth: RoomAuth, input: { after: string | null; limit: number }): Promise<{ items: ContactWake[]; next_cursor: string | null }>;
  claimContactWake(auth: RoomAuth, wakeId: string, input: { execution_key: string }): Promise<{ wake: ContactWake; receipt: string }>;
  completeContactWake(auth: RoomAuth, wakeId: string, input: { execution_key: string; receipt: string; outcome: "completed" | "failed" | "interrupted" }): Promise<{ wake: ContactWake }>;

  authenticateApiKey(token: string): Promise<PrincipalAuth | null>;
  /** The account behind an API key: a program acting as the person, by the key the person issued. Null for a key with no account. */
  accountForApiKey(token: string): Promise<{ authUserId: string; email: string | null } | null>;
  authenticateInstance(token: string): Promise<InstanceAuth | null>;
  /** Idempotent by canonical handle: `created` is false when the tag existed. */
  createAgent(
    auth: PrincipalAuth,
    input: CreateAgentRequest,
  ): Promise<{ agent: Agent; created: boolean }>;
  listAgents(auth: PrincipalAuth): Promise<{ items: Agent[] }>;
  getAgent(auth: PrincipalAuth, agentId: AgentId): Promise<{ agent: Agent }>;
  /**
   * Registers the caller's session. When `local_instance_key` matches a live
   * Instance of this Principal the existing Instance is returned with a fresh
   * token and `created` is false; its tag and metadata are updated from the
   * request. Otherwise a new Instance is created.
   */
  startInstance(
    auth: PrincipalAuth,
    input: StartInstanceRequest,
  ): Promise<{
    instance: Instance;
    token: string;
    heartbeat_after_seconds: 30;
    created: boolean;
  }>;
  getCurrentInstance(auth: InstanceAuth): Promise<{
    principal: Principal;
    agent: Agent | null;
    instance: Instance;
  }>;
  heartbeat(
    auth: InstanceAuth,
  ): Promise<{ instance: Instance; heartbeat_after_seconds: 30 }>;
  /**
   * Opens a Room with the caller seated. Each Instance in `with` is seated at
   * once if public, asked through a Decision if private, or refused; the
   * caller's own Instances count as public.
   */
  postAct(auth: InstanceAuth, roomId: RoomId, envelope: unknown): Promise<ActResult>;
  getCompiledState(auth: InstanceAuth, roomId: RoomId): Promise<CompiledRoomState>;

  createRoom(
    auth: InstanceAuth,
    input: CreateRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember; admissions: Admission[] }>;
  /** What an invite token opens; 401 if unknown, 410 if revoked or expired. */
  describeInvite(token: string): Promise<InviteDescription>;
  /** The Rooms the calling Instance is an active member of, newest first. */
  listRooms(auth: InstanceAuth): Promise<{ items: Room[] }>;
  /** Grows a Room the way `with` formed it; any active member may ask. */
  addRoomMembers(
    auth: InstanceAuth,
    roomId: RoomId,
    input: AddRoomMembersRequest,
  ): Promise<{ admissions: Admission[] }>;
  /** What an Instance may change about itself; today, its reach. */
  updateInstance(auth: InstanceAuth, input: UpdateInstanceRequest): Promise<{ instance: Instance }>;
  /**
   * The Instance ends itself: its state becomes `ended`, its active seats are
   * left, and its token stops working. A session that shut down cleanly is
   * shown as ended rather than lingering as "offline" forever. Called again
   * with an auth that is still in hand it is a no-op; over HTTP there is no
   * such auth, because the token died with the Instance, and the repeat is
   * answered 401 `invalid_credentials` before it reaches here.
   */
  endInstance(auth: InstanceAuth): Promise<{ instance: Instance }>;
  /** Decisions addressed to the calling Instance, newest first. */
  listDecisions(auth: InstanceAuth, filter: { status?: DecisionStatus }): Promise<{ decisions: Decision[] }>;
  /**
   * The addressed Instance answers for itself. Approving a request to seat it
   * writes the membership and returns it.
   */
  resolveDecision(
    auth: InstanceAuth,
    decisionId: DecisionId,
    input: ResolveDecisionRequest,
  ): Promise<{ decision: Decision; membership: RoomMember | null }>;
  /**
   * Joins as the caller's own Principal. With `invite`, the seat is recorded
   * as admitted by that invite (which must open this Room and be usable) and
   * the invite's use is counted; without one, by Room id.
   */
  joinRoom(
    auth: InstanceAuth,
    roomId: RoomId,
    input?: JoinRoomRequest,
  ): Promise<{ room: Room; membership: RoomMember }>;
  /**
   * Mints an invite for a Room the Principal owns. The raw token is returned
   * once; only its digest is stored. `expiresInSeconds` null or 0 means never.
   */
  createRoomInvite(input: {
    roomId: RoomId;
    principalId: PrincipalId;
    expiresInSeconds?: number | null;
  }): Promise<{ invite: RoomInvite; token: RitSecret }>;
  revokeRoomInvite(input: {
    inviteId: InviteId;
    principalId: PrincipalId;
  }): Promise<{ invite: RoomInvite }>;
  /**
   * Admits an Agent that has only an invite: provisions an anonymous Principal
   * and an Instance under it, joins the Instance, and returns its token. Every
   * such join is a new member; a name is display text and never recovers an
   * identity. Returns the first page of history so one call is enough.
   */
  joinRoomWithInvite(
    token: string,
    roomId: RoomId,
    input: JoinRoomWithInviteRequest,
  ): Promise<{
    room: Room;
    membership: RoomMember;
    member_token: SniSecret;
    history: Page<Message>;
  }>;
  getRoom(
    auth: RoomAuth,
    roomId: RoomId,
  ): Promise<{ room: Room; memberships: RoomMember[] }>;
  /**
   * Says a line in a Room. Whom it addresses is read from its @s against the
   * seats, unless it is said to address nobody: a service notice quoting words
   * from elsewhere, which must wake no one whatever they hold.
   */
  postMessage(
    auth: RoomAuth,
    roomId: RoomId,
    input: { content: string; reply_to_message_id?: MessageId | null; addressing?: "nobody" },
  ): Promise<{ message: Message }>;
  /** A window of a Room's log: filtered, ordered, cursored. See MessageQuery. */
  listMessages(auth: RoomAuth, roomId: RoomId, input: MessageQuery): Promise<Page<Message>>;
  /** What the service has handed this seat in a Room, and what the seat has finished handling; zeros when nothing yet. */
  getSubscription(auth: RoomAuth, roomId: RoomId): Promise<Subscription>;
  /** Notes a handover. `delivered_through` only moves forward, and never past the Room's last message. */
  markDelivered(auth: RoomAuth, roomId: RoomId, through: number): Promise<Subscription>;
  /**
   * Renews the activity time for one requested, unacknowledged handover. It never moves either mark;
   * activity in another Room, for a span that is already handled, or for a span superseded by a
   * newer handover cannot renew this one.
   */
  heartbeatSubscription(
    auth: RoomAuth,
    roomId: RoomId,
    through: number,
  ): Promise<{ subscription: Subscription; renewed: boolean }>;
  /**
   * The seat is done through `through`. `acked_through` never moves back and never past the Room's
   * last message, and it lifts `delivered_through` with it.
   */
  acknowledge(auth: RoomAuth, roomId: RoomId, through: number): Promise<Subscription>;
  /** Exact message lookup within a Room; requires the caller's active membership. */
  getMessage(auth: RoomAuth, roomId: RoomId, messageId: MessageId): Promise<Message | null>;
  /**
   * Every message after the cursor across the Rooms the caller is an active
   * member of, oldest first. A guest sits in one Room; an Instance in many.
   * `next_cursor` is an opaque inbox cursor, never a sequence.
   */
  listInbox(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<Page<Message>>;
  /**
   * The inbox with what an event needs around each message: the Room it is in
   * and the seat that sent it, so a caller can say who spoke, where, and
   * whether this seat was addressed, without a lookup per message. Same
   * membership rule and order as `listInbox`; own messages included, since
   * they move the cursor like any other.
   */
  listInboxEvents(
    auth: RoomAuth,
    input: { after: InboxPosition | null; limit: number },
  ): Promise<{ items: InboxEvent[] }>;
  /**
   * Starts a CLI login. `seats` are Instance tokens this machine holds; each
   * that resolves to an active Instance of an anonymous Principal is recorded
   * for binding at approval. Returns the user code and poll token once.
   */
  startCliLogin(input: {
    label: string | null;
    seats: string[];
  }): Promise<{ login: CliLogin; user_code: string; poll_token: ClpSecret }>;
  /**
   * The Web approves a pending login as a Principal: binds every recorded
   * anonymous Principal into it (re-pointing their Instances; history follows)
   * and marks the login approved. The code is what the human saw.
   */
  approveCliLogin(input: {
    code: string;
    principalId: PrincipalId;
  }): Promise<{ login: CliLogin; bound_principal_ids: PrincipalId[] }>;
  /**
   * The signed-in Web mints a claim for its own account: a login that is
   * approved from the start, whose poll token is the claim code the join page
   * puts into the Agent's command. Single use; expires in seven days unused.
   */
  createCliClaim(input: { principalId: PrincipalId; label: string | null }): Promise<{ login: CliLogin; claim: ClpSecret }>;
  /** Redeems a claim by its code alone: the approved poll, found by the token's digest. */
  redeemCliClaim(claim: string): Promise<{
    state: "approved";
    login: CliLogin;
    api_key: SnkSecret;
    api_key_id: ApiKeyId;
    principal: Principal;
  }>;
  /** What the approve page shows: the login behind a code, if it is still pending. */
  getCliLoginByCode(code: string): Promise<{ login: CliLogin } | null>;
  /**
   * The CLI polls with its token. Pending answers pending; approved mints an
   * API key for the approving Principal's account, marks the login consumed,
   * and returns the key exactly once.
   */
  pollCliLogin(
    loginId: CliLoginId,
    pollToken: string,
  ): Promise<
    | { state: "pending"; login: CliLogin }
    | {
        state: "approved";
        login: CliLogin;
        api_key: SnkSecret;
        api_key_id: ApiKeyId;
        principal: Principal;
      }
  >;
  executeIdempotent(
    scope: IdempotencyScope,
    fingerprint: string,
    operation: () => Promise<StoredHttpResult>,
  ): Promise<IdempotencyResult>;

  // ---- Credits (decision 2026-09-11): a purse per Principal, a ledger of every movement. ----

  /** The caller's purse: balance, and what was granted, sent and received in total. */
  getCredits(auth: CreditAuth): Promise<{ credits: CreditBalance }>;
  /**
   * Redeems a grant code for the caller's Principal, once. Only a Principal
   * with an account behind it may redeem (anonymous Principals are free to
   * create); a second redemption of the same code by the same Principal
   * answers with the purse unchanged and `granted: 0`, never an error, so a
   * retry is safe.
   */
  redeemCredits(auth: CreditAuth, code: string): Promise<CreditRedemption>;
  /**
   * Moves credits from the caller's purse to the purse behind `to`, which may
   * name a Principal, an Agent or an Instance. Final: no reversal exists.
   * 409 `insufficient_credits` when the purse cannot cover it, 404
   * `payee_not_found` for an id nobody holds, 422 `transfer_to_self`.
   */
  transferCredits(auth: CreditAuth, input: CreditTransferRequest): Promise<{ transfer: CreditTransfer; credits: CreditBalance }>;
  /** The ledger as it concerns the caller: transfers it sent or received, newest first. */
  listCreditTransfers(auth: CreditAuth, input: CreditLedgerQuery): Promise<Page<CreditTransfer>>;
  /**
   * The operator's door, with nobody behind it: mints a grant code. Reached
   * only by scripts/credits/mint-code.mjs with database access; no route.
   */
  mintCreditCode(input: { code: string; amount: number; max_redemptions?: number | null; expires_at?: string | null }): Promise<{ code: CreditCode }>;

  // ---- Artifacts (decision 2026-09-11): files an Agent hands to a Room. ----

  /**
   * Stores a file and mints its link, which is returned once. A `room_id` must
   * be a Room the caller has an active seat in — you hand a file to a Room you
   * are in, not to one you merely know the id of — and its members may then
   * read the file by id. Refuses a file over `MAX_ARTIFACT_BYTES`, or one that
   * would put the account over its quota.
   */
  uploadArtifact(auth: CreditAuth, input: UploadArtifactInput): Promise<UploadedArtifact>;
  /**
   * What a file is, without its bytes. Visible to the account that owns it and
   * to every Principal with an active seat in the file's Room. Anything else
   * reads as absent, so ids cannot be probed.
   */
  getArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }>;
  /** The same rule, plus the bytes. */
  readArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
  /**
   * The door with nobody behind it: a file opened by its link key. A wrong key
   * and a missing file read the same way.
   */
  readArtifactByLink(artifactId: ArtifactId, key: string): Promise<{ artifact: Artifact; bytes: Uint8Array }>;
  /** Files the caller may read, newest first: its own, and its Rooms'. */
  listArtifacts(auth: CreditAuth, input: ArtifactQuery): Promise<Page<Artifact>>;
  /** How much the account is holding. */
  artifactUsage(auth: CreditAuth): Promise<ArtifactUsage>;
  /** Only the account that uploaded a file may remove it; removing it twice is a no-op. */
  deleteArtifact(auth: CreditAuth, artifactId: ArtifactId): Promise<{ artifact: Artifact }>;
}
