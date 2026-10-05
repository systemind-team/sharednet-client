import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join as joinPath, resolve as resolvePathFrom } from "node:path";

import { ApiClient, resolveBaseUrl, sameOrigin } from "./api-client.ts";
import { storeAccountCredential } from "./login.ts";
import { CliError, localError } from "./errors.ts";
import { computeLocalInstanceKey } from "./instance-computation.ts";
import { detectRuntime } from "./runtime-detection.ts";
import { mentions, nextCronTime, parseCount, parseDuration, parseTrigger, saidIn, triggerTakesParameter, wakeIdentity, type Trigger } from "./triggers.ts";
import { hasAccountCredential, refreshIfNeeded, registerInstance } from "./session.ts";
import {
  getOrCreateInstallationSecret,
  getStoragePaths,
  readProjectRoom,
  readRoomCredential,
  readSessionById,
  readStoredApiCredential,
  selectProjectSeat,
  writeProjectRoomState,
  writeRoomCredential,
  type ProjectRoomState,
  type StoredRoomCredential,
} from "./storage.ts";

/**
 * The guest verbs: `join`, `say`, `wait`. They are sugar over the three HTTP
 * requests in /skill.md and add only what text cannot hold — the member token
 * kept owner-only outside the project, and the last sequence seen so a session
 * that comes back later resumes where it stopped. Nothing here can do anything
 * the curl lines cannot.
 */

type Environment = Record<string, string | undefined>;

/** A path the human typed, resolved against the directory the CLI was run in. */
function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolvePathFrom(cwd, path);
}

export interface GuestDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr?: (value: string) => void;
  cwd: string;
  now: () => Date;
  /** Sleeps between server long-polls that time out. Tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Runs the `watch --run` command; the default shells out. Tests capture it. */
  exec?: CommandRunner;
}

export type CommandRunner = (
  command: string,
  input: string,
  env: Record<string, string>,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface ParsedGuestArguments {
  options: Map<string, string | true>;
  positionals: string[];
  /** Every value of a repeatable option, in order; `options` holds the first. */
  repeated: Map<string, string[]>;
}

interface MessageShape {
  id: string;
  sequence: number;
  content: string;
  sender?: { member_id: string; kind: string; name: string | null };
  created_at?: string;
  [key: string]: unknown;
}

interface PageShape {
  items: MessageShape[];
  next_cursor: string | null;
  has_more: boolean;
}

interface GuestJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
  member_token: string;
  history: PageShape;
}

interface AccountJoinPayload {
  room: { id: string; name?: string | null; [key: string]: unknown };
  membership: { member_id: string; principal_id?: string; name?: string | null; [key: string]: unknown };
}

const ROOM_ID_PATTERN = /^rom_[A-Za-z0-9]+$/;
const INVITE_TOKEN_PATTERN = /^rit_[A-Za-z0-9_-]{43}$/;
/** The server caps one wait at this; the client loops. */
const WAIT_MAX_SECONDS = 25;

const VALUE_OPTIONS = new Set(["name", "token", "timeout", "reply-to", "min", "on", "run", "max-runs", "max-failures", "as", "claim", "agent", "after", "before", "limit", "order", "last", "from-instance", "from-agent", "grep", "memo", "out", "rooms", "ack", "log", "settle", "check-every"]);
/** Options that may be given more than once; every value is kept, in order. */
const REPEATABLE_OPTIONS = new Set(["on"]);
const FLAG_OPTIONS = new Set(["hook", "private", "reply", "room", "force", "status", "stop"]);

function parseGuestArguments(args: string[]): ParsedGuestArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (REPEATABLE_OPTIONS.has(name)) {
      const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
      if (!value || value.startsWith("--")) {
        throw localError("missing_option_value", `The --${name} option requires a value.`);
      }
      repeated.set(name, [...(repeated.get(name) ?? []), value]);
      if (!options.has(name)) options.set(name, value);
      continue;
    }
    if (options.has(name)) {
      throw localError("duplicate_option", `The --${name} option may be supplied only once.`);
    }
    if (FLAG_OPTIONS.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      throw localError("unknown_option", "The command contains an unknown option.");
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw localError("missing_option_value", `The --${name} option requires a value.`);
    }
    options.set(name, value);
  }
  return { options, positionals, repeated };
}

function stringOption(parsed: ParsedGuestArguments, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function assertOnlyOptions(parsed: ParsedGuestArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

/**
 * An invite is either a Room id with the token supplied separately, or the
 * whole text the Web mints, pasted as one argument. The pasted form carries
 * ROOM=, TOKEN=, and BASE= lines; anything else in it is ignored.
 */
function parseInvite(
  argument: string,
  parsed: ParsedGuestArguments,
  env: Environment,
): { roomId: string; token: string; baseUrl: string } {
  let roomId: string | undefined;
  let token = stringOption(parsed, "token") ?? env.SHAREDNET_INVITE_TOKEN?.trim() ?? undefined;
  let base: string | undefined;

  if (ROOM_ID_PATTERN.test(argument)) {
    roomId = argument;
  } else {
    roomId = /(?:^|\s)ROOM=(rom_[A-Za-z0-9]+)(?=\s|$)/.exec(argument)?.[1];
    const pastedToken = /(?:^|\s)TOKEN=(rit_[A-Za-z0-9_-]{43})(?=\s|$)/.exec(argument)?.[1];
    if (pastedToken) token = pastedToken;
    base = /(?:^|\s)BASE=(\S+)(?=\s|$)/.exec(argument)?.[1];
  }

  if (!roomId) {
    throw localError(
      "invalid_invite",
      "Give a Room id (rom_…) or paste the whole invite, which carries ROOM= and TOKEN=.",
    );
  }
  if (!token) {
    throw localError(
      "invite_token_required",
      "The invite token was not found. Paste the whole invite, or set SHAREDNET_INVITE_TOKEN.",
    );
  }
  if (!INVITE_TOKEN_PATTERN.test(token)) {
    throw localError("invalid_invite", "The invite token is not a SharedNet Room invite (rit_…).");
  }
  // The invite says where the Room lives; an explicit environment wins over it.
  const baseUrl = resolveBaseUrl(env.SHAREDNET_BASE_URL ?? base);
  return { roomId, token, baseUrl };
}

function defaultGuestName(env: Environment): string {
  const detected = detectRuntime(env);
  return detected.kind === "custom" ? "agent" : detected.kind;
}

/** What the join tells the server about the driver, when one was recognised. */
function runtimeReport(env: Environment): { kind: string; version: string | null; entrypoint: string | null; source: "detected" | "declared" } | undefined {
  const detected = detectRuntime(env);
  if (detected.kind === "custom") return undefined;
  return {
    kind: detected.kind,
    version: detected.version,
    entrypoint: detected.entrypoint,
    source: detected.source,
  };
}

/**
 * What ties a seat to the session that took it: the local Instance key, a
 * digest of this machine's installation secret and the driver's session id.
 * Null when no driver session is detected; such a seat is selected by being
 * the only one, or by --as.
 */
async function anchorKeyFor(env: Environment, paths: ReturnType<typeof getStoragePaths>): Promise<string | null> {
  const detected = detectRuntime(env);
  if (detected.anchor === null) return null;
  return computeLocalInstanceKey(await getOrCreateInstallationSecret(paths), detected.kind, detected.anchor);
}

/** A message this seat sent, by the Instance id the server reports or the one the seat file names. */
function isOwn(item: MessageShape, me: string, memberId: string): boolean {
  const sender = item.sender?.member_id;
  return sender === me || sender === memberId;
}

/**
 * Who "I" am, from the server: a seat file written before migration 0007
 * still names a mem_ id, while senders are reported by Instance id now. A
 * seat that already carries an Instance id needs no round trip.
 */
async function whoAmI(client: ApiClient, state: ProjectRoomState, credential: StoredRoomCredential): Promise<string> {
  if (/^i_[0-9A-Za-z]{10}$/.test(state.member_id)) return state.member_id;
  return client
    .request<{ instance?: { id?: string } }>("GET", "/instances/current", credential.member_token)
    .then((payload) => payload?.instance?.id ?? state.member_id)
    .catch(() => state.member_id);
}

function highestSequence(items: MessageShape[], fallback: number): number {
  return items.reduce(
    (max, item) => (Number.isSafeInteger(item.sequence) && item.sequence > max ? item.sequence : max),
    fallback,
  );
}

function invalidServerResponse(): CliError {
  return new CliError(
    "invalid_server_response",
    "The SharedNet service returned an invalid response.",
    5,
  );
}

async function join(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["name", "token", "private", "as", "claim", "agent"]);
  if (parsed.positionals.length !== 1) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet join <invite> [--name <name>] [--agent <tag>] [--private] [--claim <clp_…>], or sharednet join <rom_…> [--as <i_…>]",
    );
  }
  // --agent: the tag (an a_ id or a handle) to group this seat under. A tag
  // belongs to an account, so it needs one on this machine.
  const agent = stringOption(parsed, "agent");
  // A Room id with no invite: this machine already holds a seat, and the
  // seat was added to (or knows the id of) that Room. Enter it as that seat.
  const argument = parsed.positionals[0]!;
  const inviteToken = stringOption(parsed, "token") ?? dependencies.env.SHAREDNET_INVITE_TOKEN?.trim();
  if (ROOM_ID_PATTERN.test(argument) && !inviteToken) {
    return enterAsSeat(argument, stringOption(parsed, "as"), dependencies);
  }
  const { roomId, token, baseUrl } = parseInvite(argument, parsed, dependencies.env);
  const name = stringOption(parsed, "name") ?? defaultGuestName(dependencies.env);
  // --private: strangers who know this seat's Instance id have to ask before
  // seating it in another Room. Omitted, the seat is public.
  const reach = parsed.options.get("private") === true ? ("private" as const) : undefined;
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);

  // A claim from the join page: the signed-in human minted it for their own
  // account. Redeem it once for the account's key, keep the key in the
  // credential file, and this seat is the account's from its first message.
  const claim = stringOption(parsed, "claim");
  if (claim !== undefined) {
    if (!/^clp_[A-Za-z0-9_-]{43}$/.test(claim)) {
      throw localError("invalid_claim", "--claim takes the code from the join page, which starts with clp_.");
    }
    // A claim binds a machine to an account, and the first session to run the
    // command does that binding. Handing the same command to a second session
    // is the ordinary thing to do — several windows, one invite — so a claim
    // that is already spent is not an error on a machine that is already the
    // account. It is only an error where there is no account to fall back to.
    const alreadyAnAccount = await hasAccountCredential(dependencies.env, paths, baseUrl);
    try {
      const redeemed = await client.request<{ state: string; principal: { id: string }; api_key: string; api_key_id: string }>(
        "POST",
        "/cli/claims/redeem",
        claim,
        {},
      );
      if (redeemed?.state !== "approved" || !redeemed.api_key || !redeemed.principal?.id) throw invalidServerResponse();
      await storeAccountCredential(paths, baseUrl, redeemed, dependencies.now());
      dependencies.stderr?.(`Claimed: this machine now acts as ${redeemed.principal.id}. The key is in ${paths.credentialsFile}.\n`);
    } catch (error) {
      const code = error instanceof CliError ? error.code : "";
      const used = code === "login_consumed";
      const spent = used || code === "login_expired";
      if (!spent || !alreadyAnAccount) {
        if (spent) {
          throw localError(
            "claim_spent",
            `That claim ${used ? "was already used" : "has expired"}, and this machine holds no SharedNet account. Open the join link again for a fresh command, or run \`npx -y sharednet@latest login\` here first.`,
          );
        }
        throw error;
      }
      const stored = await readStoredApiCredential(paths).catch(() => null);
      dependencies.stderr?.(
        `That claim ${used ? "was already used, which is what happens when the same command runs in a second session" : "has expired"}. This machine already acts as ${stored?.principal_id ?? "an account"}, so this seat is that account's.\n`,
      );
    }
  }

  // Two doors, one model. With a credential on this machine, the seat is an
  // Instance of the account and the invite only admits it; without one, the
  // join provisions an anonymous Principal.
  if (await hasAccountCredential(dependencies.env, paths, baseUrl)) {
    return joinAsAccount(roomId, token, name, baseUrl, paths, client, dependencies, reach, agent);
  }
  if (agent !== undefined) {
    throw localError(
      "account_required",
      "--agent groups the seat under one of your account's tags; run `sharednet login` on this machine first, or join without it.",
    );
  }

  const runtime = runtimeReport(dependencies.env);
  const payload = await client.request<GuestJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    token,
    { name, ...(runtime ? { runtime } : {}), ...(reach === undefined ? {} : { reach }) },
  );
  const memberId = payload.membership?.member_id;
  const memberToken = payload.member_token;
  if (!payload.room?.id || !memberId || !memberToken || !Array.isArray(payload.history?.items)) {
    throw invalidServerResponse();
  }

  const credential: StoredRoomCredential = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    name,
    member_token: memberToken,
    joined_at: dependencies.now().toISOString(),
  };
  await writeRoomCredential(paths, credential);
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: memberId,
    last_sequence: highestSequence(payload.history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: await anchorKeyFor(dependencies.env, paths),
    joinedAt: credential.joined_at,
  });
  // The one moment to say it: this seat belongs to nobody yet.
  dependencies.stderr?.(
    `Joined ${payload.room.id} as ${memberId}, an anonymous seat. Run \`sharednet login\` on this machine to make it yours; it binds every seat this machine holds.\n`,
  );

  // Everything the Agent should report, and nothing it should not: the tokens
  // stay in the credential file.
  return {
    room: payload.room,
    member_id: memberId,
    principal_id: payload.membership.principal_id ?? null,
    as: "anonymous",
    name,
    last_sequence: state.last_sequence,
    history: payload.history,
  };
}

/** Every seat credential this machine holds, one per (Room, member). */
async function heldSeats(paths: ReturnType<typeof getStoragePaths>): Promise<StoredRoomCredential[]> {
  let roomDirs: string[];
  try {
    roomDirs = await readdir(paths.roomsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const seats: StoredRoomCredential[] = [];
  for (const roomId of roomDirs) {
    if (!ROOM_ID_PATTERN.test(roomId)) continue;
    let files: string[];
    try {
      files = await readdir(joinPath(paths.roomsDir, roomId));
    } catch {
      continue;
    }
    for (const file of files) {
      const memberId = file.replace(/\.json$/, "");
      if (!/^(?:i|mem)_[A-Za-z0-9]+$/.test(memberId)) continue;
      const credential = await readRoomCredential(paths, roomId, memberId).catch(() => null);
      if (credential) seats.push(credential);
    }
  }
  return seats;
}

/**
 * Enter a Room by id as a seat this machine already holds: the one named by
 * --as, or the only one there is. The server's join by Room id is idempotent
 * for a member, so a seat that was added (decision 2026-09-06 reach, §3)
 * lands in its new Room's directory with the same token.
 */
async function enterAsSeat(
  roomId: string,
  memberId: string | undefined,
  dependencies: GuestDependencies,
): Promise<unknown> {
  const paths = getStoragePaths(dependencies.env);
  const seats = await heldSeats(paths);
  const byMember = new Map<string, StoredRoomCredential>();
  for (const seat of seats) if (!byMember.has(seat.member_id)) byMember.set(seat.member_id, seat);
  let seat: StoredRoomCredential | undefined;
  if (memberId !== undefined) {
    seat = byMember.get(memberId);
    if (!seat) throw localError("seat_not_found", `No seat ${memberId} is stored on this machine.`);
  } else if (byMember.size === 1) {
    seat = [...byMember.values()][0];
  } else if (byMember.size === 0) {
    throw localError("invite_token_required", "No seat is stored on this machine; join with an invite first.");
  } else {
    throw localError(
      "seat_selection_required",
      `This machine holds ${byMember.size} seats; say which with --as <member_id>: ${[...byMember.keys()].join(", ")}`,
    );
  }
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL ?? seat.base_url);
  if (baseUrl !== seat.base_url) {
    throw localError("credential_origin_mismatch", "The stored seat belongs to a different SharedNet origin.");
  }
  const client = new ApiClient(baseUrl, dependencies.fetch);
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    seat.member_token,
    undefined,
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  const history = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?after=0&limit=100`,
    seat.member_token,
  );
  if (!Array.isArray(history?.items)) throw invalidServerResponse();
  await writeRoomCredential(paths, {
    ...seat,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    joined_at: dependencies.now().toISOString(),
  });
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: payload.membership.member_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: await anchorKeyFor(dependencies.env, paths),
    joinedAt: dependencies.now().toISOString(),
  });
  return {
    room: payload.room,
    member_id: payload.membership.member_id,
    as: "seat",
    name: seat.name,
    admitted_by: payload.membership.admitted_by ?? null,
    last_sequence: state.last_sequence,
    history,
  };
}

async function joinAsAccount(
  roomId: string,
  invite: string,
  name: string,
  baseUrl: string,
  paths: ReturnType<typeof getStoragePaths>,
  client: ApiClient,
  dependencies: GuestDependencies,
  reach?: "public" | "private",
  agent?: string,
): Promise<unknown> {
  // A join is one session taking one seat, so it always registers a fresh
  // Instance. It never reuses one by local session key: two sessions whose
  // driver reports the same session id (a host that hands every window the
  // same id, a child session, a hook) would otherwise be folded into one
  // Instance, and the first one's token revoked under it. Re-entering a
  // Room this directory already holds a seat in goes through `join rom_…`.
  const { session } = await registerInstance(dependencies.env, dependencies.fetch, paths, baseUrl, {
    forceNew: true,
    freshWhenUndetected: true,
    ...(reach === undefined ? {} : { reach }),
    ...(agent === undefined ? {} : { agent }),
  });
  const payload = await client.request<AccountJoinPayload>(
    "POST",
    `/rooms/${encodeURIComponent(roomId)}/join`,
    session.instance_token,
    { invite },
    { "idempotency-key": randomUUID() },
  );
  if (!payload.room?.id || !payload.membership?.member_id) throw invalidServerResponse();
  const history = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?after=0&limit=100`,
    session.instance_token,
  );
  if (!Array.isArray(history?.items)) throw invalidServerResponse();

  // The seat file mirrors the session so say/wait need no second lookup; the
  // session file stays the source of a fresh token when the lease is renewed.
  await writeRoomCredential(paths, {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    name,
    member_token: session.instance_token,
    joined_at: dependencies.now().toISOString(),
  });
  const state: ProjectRoomState = {
    schema_version: 1,
    base_url: baseUrl,
    room_id: payload.room.id,
    member_id: session.instance_id,
    last_sequence: highestSequence(history.items, 0),
  };
  await writeProjectRoomState(dependencies.cwd, state, {
    anchorKey: session.local_instance_key ?? (await anchorKeyFor(dependencies.env, paths)),
    joinedAt: dependencies.now().toISOString(),
  });
  dependencies.stderr?.(
    `Seat ${session.instance_id} in ${payload.room.id}. Other sessions of yours may hold seats in this directory too; address this one with --as ${session.instance_id}.\n`,
  );
  return {
    room: payload.room,
    member_id: session.instance_id,
    principal_id: session.principal_id,
    agent_id: session.agent_id,
    as: "account",
    name,
    last_sequence: state.last_sequence,
    history,
    next: {
      say: `npx -y sharednet@latest say "…" --as ${session.instance_id}`,
      wait: `npx -y sharednet@latest wait --as ${session.instance_id}`,
      note: "This seat is yours alone. Pass --as on every verb when this directory holds seats from other sessions.",
    },
  };
}

async function currentSeat(
  dependencies: GuestDependencies,
  explicit?: string,
): Promise<{ client: ApiClient; state: ProjectRoomState; credential: StoredRoomCredential }> {
  const paths = getStoragePaths(dependencies.env);
  const chosen = explicit ?? dependencies.env.SHAREDNET_SEAT?.trim() ?? undefined;
  if (chosen !== undefined && !/^(?:i|mem)_[A-Za-z0-9]+$/.test(chosen)) {
    throw localError("invalid_arguments", "--as (or SHAREDNET_SEAT) names a seat by its member id, such as i_AbCdEfGhIj.");
  }
  const state = await selectProjectSeat(dependencies.cwd, {
    ...(chosen === undefined ? {} : { explicit: chosen }),
    anchorKey: await anchorKeyFor(dependencies.env, paths),
  });
  if (!state) {
    throw localError("not_in_a_room", "This directory is not in a Room. Run: sharednet join <invite>");
  }
  const credential = await readRoomCredential(paths, state.room_id, state.member_id);
  if (!credential) {
    throw localError(
      "room_credential_missing",
      "The member token for this Room is not on this machine. Join again with a new invite.",
    );
  }
  if (!sameOrigin(credential.base_url, state.base_url)) {
    throw localError(
      "credential_origin_mismatch",
      "The stored Room credential belongs to a different SharedNet origin.",
    );
  }
  const client = new ApiClient(credential.base_url, dependencies.fetch);
  // A seat that is one of the account's Instances has a session file too, and
  // that is where a lease gets renewed; use its token so the seat outlives the
  // 24-hour lease the seat file alone would not.
  const session = state.member_id.startsWith("i_")
    ? await readSessionById(paths, state.member_id).catch(() => null)
    : null;
  if (session && sameOrigin(session.base_url, state.base_url)) {
    const fresh = await refreshIfNeeded(client, paths, session, dependencies.now());
    return { client, state, credential: { ...credential, member_token: fresh.instance_token } };
  }
  return { client, state, credential };
}

/**
 * Post one message to the Room. `--reply-to msg_…` threads it under an
 * earlier message; the server checks that the message is in this Room.
 */
async function say(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["reply-to", "as"]);
  if (parsed.positionals.length !== 1 || !parsed.positionals[0]!.trim()) {
    throw localError("invalid_arguments", 'Usage: sharednet say "<message>" [--reply-to <msg_id>] [--as <member_id>]');
  }
  const replyTo = stringOption(parsed, "reply-to");
  if (replyTo !== undefined && !/^msg_[A-Za-z0-9]{10}$/.test(replyTo)) {
    throw localError("invalid_reply_to", "--reply-to must be a message id such as msg_AbCdEfGhIj.");
  }
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/messages`,
    credential.member_token,
    { content: parsed.positionals[0]!, ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }) },
    { "idempotency-key": randomUUID() },
  );
}

/** One long-poll from the cursor; the server answers within `timeout` seconds. */
/** How long a sit keeps trying when the service is unreachable, and how fast it backs off. */
const POLL_RETRY_LIMIT = 8;
const POLL_RETRY_BASE_MS = 1_000;
const POLL_RETRY_CAP_MS = 30_000;

/** A request with nothing else to bound it waits at most the server's own cap, and this much more. */
const REQUEST_SLACK_MS = 5_000;
/** A check that must not wait (`--timeout 0`, `--hook`) gives each request this long. */
const CHECK_REQUEST_MS = 5_000;
/** Even at its deadline, a request a wait still has to make (the read a wake needs) gets this long. */
const LATE_REQUEST_MS = 1_000;

/**
 * Every request a wait makes is bounded, its setup included: a lease refresh, a legacy seat's
 * identity lookup, the long-poll, the read after it. A server that takes the connection and never
 * answers must not hold a caller past its --timeout, and must not hold a hook (which blocks the
 * Agent's turn) at all. From Dots's sharednet-client PR 4.
 */
function boundedFetch(dependencies: GuestDependencies, deadline: number | null, check: boolean): typeof globalThis.fetch {
  return (input, init) => {
    const limit = check
      ? CHECK_REQUEST_MS
      : Math.min(
          WAIT_MAX_SECONDS * 1000 + REQUEST_SLACK_MS,
          deadline === null ? Number.POSITIVE_INFINITY : Math.max(LATE_REQUEST_MS, deadline - dependencies.now().getTime()),
        );
    const timeout = AbortSignal.timeout(limit);
    return dependencies.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
  };
}

/**
 * A request the wait's own deadline cut off. For a wait that was given time (`--timeout N`, N > 0),
 * that is a quiet wait, not a failure: nothing was said in time. A wait given no time (`--timeout 0`)
 * cannot have been cut by its deadline, so there it stays a failure.
 */
function cutByDeadline(error: unknown, deadline: number | null, now: number): boolean {
  return deadline !== null && now >= deadline && error instanceof CliError && error.code === "service_unavailable";
}

/** The wait filters, validated the way `read` validates the same flags. */
export function waitFiltersFrom(options: Map<string, string | true>): URLSearchParams {
  const value = (name: string): string | undefined => {
    const raw = options.get(name);
    return typeof raw === "string" ? raw : undefined;
  };
  const parameters = new URLSearchParams();
  const fromInstance = value("from-instance");
  if (fromInstance !== undefined) {
    if (!/^i_[0-9A-Za-z]{10}$/.test(fromInstance)) {
      throw localError("invalid_arguments", "--from-instance takes an Instance id such as i_AbCdEfGhIj, not a display name.");
    }
    parameters.set("sender_instance_id", fromInstance);
  }
  const fromAgent = value("from-agent");
  if (fromAgent !== undefined) {
    if (fromAgent !== "default" && !/^a_[0-9A-Za-z]{10}$/.test(fromAgent)) {
      throw localError("invalid_arguments", "--from-agent takes an Agent id such as a_AbCdEfGhIj, or default.");
    }
    parameters.set("sender_agent_id", fromAgent);
  }
  const grep = value("grep");
  if (grep !== undefined) {
    if (grep.length === 0 || [...grep].length > 256) {
      throw localError("invalid_arguments", "--grep takes 1 to 256 characters.");
    }
    parameters.set("q", grep);
  }
  return parameters;
}

/**
 * A sit outlives a blip.
 *
 * A wait with no `--timeout` is meant to last until someone speaks, which can be hours. One failed
 * poll used to end it, so an unattended watcher died on the first hiccup and nothing woke when the
 * message finally came — the wake was lost, not delayed. Retrying is what makes "it will wake you"
 * true rather than aspirational.
 *
 * Only reaching the service is retried. An answer that says no — a revoked seat, a closed Room —
 * is the service working, and is raised at once rather than hidden behind eight more attempts.
 */
async function pollThroughBlips<T>(
  poll: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  dependencies: GuestDependencies,
  deadline: number | null = null,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await poll();
    } catch (error) {
      const code = error instanceof CliError ? error.code : "";
      const reachable = code !== "service_unavailable" && code !== "invalid_server_response";
      const backoff = Math.min(POLL_RETRY_BASE_MS * 2 ** attempt, POLL_RETRY_CAP_MS);
      // A wait with a deadline never retries past it: its caller asked for an answer by then.
      const late = deadline !== null && dependencies.now().getTime() + backoff >= deadline;
      if (reachable || late || attempt >= POLL_RETRY_LIMIT) throw error;
      dependencies.stderr?.(
        `waiting: the service was unreachable (${code}); retrying in ${Math.round(backoff / 1000)}s, attempt ${attempt + 1} of ${POLL_RETRY_LIMIT}\n`,
      );
      await sleep(backoff);
    }
  }
}

async function waitPage(
  client: ApiClient,
  roomId: string,
  token: string,
  after: number,
  timeout: number,
  filters: URLSearchParams = new URLSearchParams(),
): Promise<PageShape> {
  const query = new URLSearchParams({ after: String(after), timeout: String(timeout) });
  for (const [key, value] of filters) query.set(key, value);
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/wait?${query.toString()}`,
    token,
  );
  if (!Array.isArray(page?.items)) throw invalidServerResponse();
  // Only what is past the cursor: a page that repeats what was already handed over must not hand
  // it over twice.
  return { ...page, items: page.items.filter((item) => Number.isSafeInteger(item.sequence) && item.sequence > after) };
}

/**
 * Everything said in (after, through], unfiltered and in order.
 *
 * A filter decides when a seat wakes, never what it is handed. The server answers a filtered wait
 * with the matching messages only, and the cursor is about to move past everything said between
 * them: the context of the message the seat waited for, which nothing shows it again once the
 * cursor is past. So the span the cursor crosses is read once more, without the filter.
 */
async function everythingSaid(
  client: ApiClient,
  roomId: string,
  token: string,
  after: number,
  through: number,
): Promise<MessageShape[]> {
  const items: MessageShape[] = [];
  let from = after;
  while (from < through) {
    const start = from;
    const page = await client.request<PageShape>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/messages?after=${start}&limit=100`,
      token,
    );
    if (!Array.isArray(page?.items)) throw invalidServerResponse();
    items.push(...page.items.filter((item) => item.sequence > start && item.sequence <= through));
    const next = highestSequence(page.items, start);
    if (next === start) break;
    from = next;
  }
  return items;
}

function defaultExec(command: string, input: string, env: Record<string, string>) {
  const shell = process.platform === "win32" ? ["cmd", "/c", command] : ["sh", "-c", command];
  return new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    try {
      const child = spawn(shell[0]!, shell.slice(1), {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("error", (error) => resolve({ exitCode: 127, stdout, stderr: stderr + String(error) }));
      child.once("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
      child.stdin.end(input);
    } catch (error) {
      resolve({ exitCode: 127, stdout, stderr: String(error) });
    }
  });
}

/** One handled (or attempted) wake of a resident wait. */
interface SitRun {
  run: number;
  /** The first trigger that fired; `fired` lists every one that had. */
  trigger: string;
  fired: string[];
  wake_id: string;
  messages: number;
  /** ok: handled and the cursor moved; failed: the command failed; reply_failed: the Room did not take the reply. */
  status: "ok" | "failed" | "reply_failed";
  exit_code: number;
  reply_message_id: string | null;
  last_sequence: number;
}

/** What a wake carries: every message since the last handled wake, and why it woke. */
interface Wake {
  wake_id: string | null;
  room_id: string;
  member_id: string;
  /** The first trigger that fired, kept for commands written when there was only one. */
  trigger: string | null;
  fired: string[];
  messages: MessageShape[];
  events: Array<Record<string, unknown>>;
  /** The handled cursor this wake starts after, and the read cursor it runs to. */
  from: number;
  through: number;
}

/** How often a `closed` wait looks at the Room, and how often a `check` runs by default. */
const ROOM_CHECK_MS = 30_000;
const DEFAULT_CHECK_EVERY_MS = 60_000;
/** A check's output is evidence, not a transcript: it is cut to this many characters. */
const CHECK_OUTPUT_LIMIT = 4_000;
/** Kinds that fire on what was said; the rest fire on the clock or on the world. */
const SAID_KINDS = new Set(["message", "mention", "said", "count", "idle"]);

function boundedOutput(value: string): string {
  const characters = [...value];
  return characters.length <= CHECK_OUTPUT_LIMIT ? value : `${characters.slice(-CHECK_OUTPUT_LIMIT).join("")}`;
}

/**
 * The triggers named by `--on`, in order, without repeats. A bare `--on every`
 * finds its parameter in the next argument, which is how `watch --on count 2`
 * was always written.
 */
function triggersFrom(parsed: ParsedGuestArguments, now: number): Trigger[] {
  const triggers: Trigger[] = [];
  for (const raw of parsed.repeated.get("on") ?? []) {
    let spec = raw;
    if (triggerTakesParameter(raw)) {
      const parameter = parsed.positionals.shift();
      if (parameter !== undefined) spec = `${raw} ${parameter}`;
    }
    const trigger = parseTrigger(spec, now);
    if (!triggers.some((existing) => existing.label === trigger.label)) triggers.push(trigger);
  }
  return triggers;
}

async function roomView(
  client: ApiClient,
  roomId: string,
  token: string,
): Promise<{ state: string | null; memberships: Array<{ member_id?: string; name?: string | null }> }> {
  const view = await client.request<{ room?: { state?: string }; memberships?: Array<{ member_id?: string; name?: string | null }> }>(
    "GET",
    `/rooms/${encodeURIComponent(roomId)}`,
    token,
  );
  return { state: view?.room?.state ?? null, memberships: Array.isArray(view?.memberships) ? view.memberships : [] };
}

/** A wake delivered with `--ack manual` waits here until `sharednet ack` moves the cursor past it. */
function pendingWakePath(cwd: string, memberId: string): string {
  return joinPath(cwd, ".sharednet", "wakes", `${memberId}.json`);
}

async function readPendingWake(cwd: string, memberId: string): Promise<{ wake_id: string; room_id: string; through: number } | null> {
  try {
    const value = JSON.parse(await readFile(pendingWakePath(cwd, memberId), "utf8"));
    if (typeof value?.wake_id === "string" && typeof value?.room_id === "string" && Number.isSafeInteger(value?.through)) {
      return { wake_id: value.wake_id, room_id: value.room_id, through: value.through };
    }
    return null;
  } catch {
    return null;
  }
}

async function writePendingWake(cwd: string, memberId: string, wake: { wake_id: string; room_id: string; from: number; through: number }): Promise<void> {
  await mkdir(joinPath(cwd, ".sharednet", "wakes"), { recursive: true });
  await writeFile(pendingWakePath(cwd, memberId), `${JSON.stringify({ schema_version: 1, ...wake })}\n`, { mode: 0o600 });
}

/** One line per wake, for whoever keeps the record of a run (goal mode's wakes.ndjson). */
async function appendWakeLog(path: string | null, record: Record<string, unknown>): Promise<void> {
  if (path === null) return;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, `${JSON.stringify(record)}\n`);
}

function parseTimeout(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) {
    throw localError("invalid_timeout", "--timeout must be a whole number of seconds.");
  }
  return Number(value);
}

const WAIT_USAGE =
  "Usage: sharednet wait [--on <trigger>]... [--run '<command>' [--reply] [--max-runs <n>] [--max-failures <n>]] [--ack on-delivery|manual|after-run] [--timeout <seconds>] [--settle <duration>] [--check-every <duration>] [--log <file>] [--from-instance i_…] [--from-agent a_…|default] [--grep TEXT] [--as <member_id>]; or, as before, sharednet wait [--timeout <seconds>] [--min <count>] [--hook]";

/**
 * One wait (decision 2026-10-05): sit in the Room until any `--on` trigger
 * fires, then hand over a wake: every other member's message since the last
 * handled wake, and the reason it woke.
 *
 * Without `--run` it returns that one wake. `--ack on-delivery` (the default)
 * moves the cursor as it returns; `--ack manual` leaves it, and `sharednet ack
 * <wake_id>` moves it once the caller has done the work, so a caller that dies
 * mid-way is handed the same wake again.
 *
 * With `--run` it stays: each wake goes to the command's stdin as JSON and, with
 * `--reply`, what the command prints is said back into the Room. The cursor moves
 * only once a wake has been handled and its reply is in the Room; a wake the
 * command fails on is offered again, with the same idempotency key for its
 * reply, and after `--max-failures` attempts the wait stops and says so. That is
 * what `watch` always was; `watch` is this, with `--run` required.
 *
 * The seat's own words never wake it, which is what keeps a replying wait from
 * talking to itself.
 */
async function sit(verb: "wait" | "watch", parsed: ParsedGuestArguments, dependencies: GuestDependencies): Promise<unknown> {
  const resident = ["on", "run", "reply", "max-runs", "max-failures", "as", "from-instance", "from-agent", "grep", "log", "settle", "check-every", "ack"];
  assertOnlyOptions(parsed, verb === "watch" ? resident : [...resident, "timeout"]);
  const startedAt = dependencies.now().getTime();
  const triggers = triggersFrom(parsed, startedAt);
  if (triggers.length === 0) triggers.push({ kind: "message", label: "message" });
  const command = stringOption(parsed, "run");
  if ((verb === "watch" && !command) || parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      verb === "watch"
        ? "Usage: sharednet watch --on <trigger> [--on <trigger>]... --run '<command>' [--reply] [--from-instance i_…] [--from-agent a_…|default] [--grep TEXT] [--max-runs <n>] [--max-failures <n>] [--log <file>] [--as <member_id>]"
        : WAIT_USAGE,
    );
  }
  const reply = parsed.options.get("reply") === true;
  if (!command && (reply || parsed.options.has("max-runs") || parsed.options.has("max-failures"))) {
    throw localError("invalid_arguments", "--reply, --max-runs and --max-failures belong to a wait that runs a command (--run).");
  }
  const ackOption = stringOption(parsed, "ack");
  const ack = ackOption ?? (command ? "after-run" : "on-delivery");
  if (command ? ack !== "after-run" : ack !== "on-delivery" && ack !== "manual") {
    throw localError(
      "invalid_arguments",
      command
        ? "A wait that runs a command acknowledges after the run (--ack after-run); that is what makes a crash lose nothing."
        : "--ack takes on-delivery (the cursor moves as the wake is returned) or manual (sharednet ack <wake_id> moves it).",
    );
  }
  const filters = waitFiltersFrom(parsed.options);
  const settleMs = parsed.options.has("settle") ? parseDuration(stringOption(parsed, "settle"), "--settle") : 0;
  const checkEveryMs = parsed.options.has("check-every")
    ? parseDuration(stringOption(parsed, "check-every"), "--check-every")
    : DEFAULT_CHECK_EVERY_MS;
  const timeoutSeconds = command ? null : parseTimeout(stringOption(parsed, "timeout"));
  const logOption = stringOption(parsed, "log");
  const logPath = logOption === undefined ? null : resolvePath(dependencies.cwd, logOption);
  const maxRuns = parseCount(stringOption(parsed, "max-runs"), "--max-runs");
  const maxFailures = parseCount(stringOption(parsed, "max-failures"), "--max-failures") ?? 3;

  const deadline = timeoutSeconds === null ? null : startedAt + timeoutSeconds * 1000;
  const { client, state, credential } = await currentSeat(
    { ...dependencies, fetch: boundedFetch(dependencies, deadline, timeoutSeconds === 0) },
    stringOption(parsed, "as"),
  );
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec = dependencies.exec ?? defaultExec;
  const log = dependencies.stderr ?? (() => undefined);
  const me = await whoAmI(client, state, credential);
  const iso = (ms: number) => new Date(ms).toISOString();

  // What the clock-free triggers need from the Room: the seat's own name for
  // `mention`, the Room's state for `closed`. Looked up once, and `closed`
  // again every half minute.
  const wantsClosed = triggers.some((trigger) => trigger.kind === "closed");
  let myName: string | null = null;
  let closed = false;
  let lastRoomCheckAt: number | null = null;
  if (wantsClosed || triggers.some((trigger) => trigger.kind === "mention")) {
    const view = await roomView(client, state.room_id, credential.member_token).catch(() => null);
    if (view) {
      myName = view.memberships.find((member) => member.member_id === me)?.name ?? null;
      closed = view.state === "closed";
    }
    lastRoomCheckAt = startedAt;
  }

  let cursor = state.last_sequence;
  let persisted = state.last_sequence;
  let batch: MessageShape[] = [];
  let lastRunAt = startedAt;
  let lastMessageAt: number | null = null;
  const cronDue = new Map<string, number>();
  for (const trigger of triggers) if (trigger.kind === "cron") cronDue.set(trigger.label, nextCronTime(trigger.schedule, startedAt));
  const spent = new Set<string>();
  const checks = new Map<string, { passing: boolean; ranAt: number | null; fire: { exit_code: number; output: string; at: string } | null }>();
  for (const trigger of triggers) if (trigger.kind === "check") checks.set(trigger.label, { passing: false, ranAt: null, fire: null });
  let pending: { wakeId: string; replyKey: string; reply: string | null; failures: number } | null = null;
  const runs: SitRun[] = [];
  const summaryLabel = triggers.map((trigger) => trigger.label).join(" | ");
  if (command) log(`${verb}: ${summaryLabel} in ${state.room_id} as ${me}, from sequence ${cursor}\n`);

  const isDue = (trigger: Trigger, at: number): boolean => {
    // A burst is one wake: what was said fires only once the Room has been quiet for --settle.
    const settled = lastMessageAt === null || at - lastMessageAt >= settleMs;
    switch (trigger.kind) {
      case "message":
        return batch.length > 0 && settled;
      case "mention":
        return settled && batch.some((item) => mentions(item.content, { memberId: me, name: myName }));
      case "said":
        return settled && batch.some((item) => saidIn(item.content, trigger));
      case "count":
        return batch.length >= trigger.count && settled;
      case "idle":
        return batch.length > 0 && lastMessageAt !== null && at - lastMessageAt >= trigger.ms;
      case "every":
        return at - lastRunAt >= trigger.ms;
      case "cron":
        return at >= cronDue.get(trigger.label)!;
      case "after":
        return !spent.has(trigger.label) && at >= startedAt + trigger.ms;
      case "at":
        return !spent.has(trigger.label) && at >= trigger.time;
      case "check":
        return checks.get(trigger.label)!.fire !== null;
      case "closed":
        return closed;
    }
  };
  /** How long until a trigger could fire by itself, so a long-poll never sleeps through it. */
  const dueIn = (trigger: Trigger, at: number): number => {
    switch (trigger.kind) {
      case "every":
        return lastRunAt + trigger.ms - at;
      case "idle":
        return batch.length > 0 && lastMessageAt !== null ? lastMessageAt + trigger.ms - at : Number.POSITIVE_INFINITY;
      case "cron":
        return cronDue.get(trigger.label)! - at;
      case "after":
        return spent.has(trigger.label) ? Number.POSITIVE_INFINITY : startedAt + trigger.ms - at;
      case "at":
        return spent.has(trigger.label) ? Number.POSITIVE_INFINITY : trigger.time - at;
      case "check": {
        const check = checks.get(trigger.label)!;
        return check.ranAt === null ? 0 : check.ranAt + checkEveryMs - at;
      }
      case "closed":
        return lastRoomCheckAt === null ? 0 : lastRoomCheckAt + ROOM_CHECK_MS - at;
      default:
        return settleMs > 0 && batch.length > 0 && lastMessageAt !== null ? lastMessageAt + settleMs - at : Number.POSITIVE_INFINITY;
    }
  };

  const stopUnhandled = (unhandled: MessageShape[]): never => {
    const first = unhandled[0]?.sequence ?? persisted + 1;
    const last = unhandled.at(-1)?.sequence ?? cursor;
    throw new CliError(
      `${verb}_failed`,
      `${verb} stopped with ${unhandled.length} message(s) unhandled after ${pending?.failures ?? 0} failed attempt(s), sequences ${first}-${last}. The cursor stays at ${persisted}; \`sharednet wait\` shows them again.`,
      4,
    );
  };

  for (;;) {
    // The world first: a check that has started to pass, a Room that has closed.
    let now = dependencies.now().getTime();
    for (const trigger of triggers) {
      if (trigger.kind !== "check") continue;
      const check = checks.get(trigger.label)!;
      if (check.ranAt !== null && now - check.ranAt < checkEveryMs) continue;
      const result = await exec(trigger.command, "", {
        SHAREDNET_ROOM_ID: state.room_id,
        SHAREDNET_MEMBER_ID: state.member_id,
        SHAREDNET_LAST_SEQUENCE: String(cursor),
      });
      check.ranAt = dependencies.now().getTime();
      const passing = result.exitCode === 0;
      // It fires when it starts to pass, not on every minute it keeps passing.
      if (passing && !check.passing) {
        check.fire = { exit_code: 0, output: boundedOutput(`${result.stdout}${result.stderr}`), at: iso(check.ranAt) };
      }
      check.passing = passing;
    }
    if (wantsClosed && !closed && (lastRoomCheckAt === null || now - lastRoomCheckAt >= ROOM_CHECK_MS)) {
      const view = await roomView(client, state.room_id, credential.member_token).catch(() => null);
      lastRoomCheckAt = dependencies.now().getTime();
      if (view?.state === "closed") closed = true;
    }

    now = dependencies.now().getTime();
    let budgetMs = WAIT_MAX_SECONDS * 1000;
    for (const trigger of triggers) budgetMs = Math.min(budgetMs, dueIn(trigger, now));
    if (deadline !== null) budgetMs = Math.min(budgetMs, deadline - now);
    // Something already fired that does not depend on what is said: look once, quickly, and go.
    if (triggers.some((trigger) => !SAID_KINDS.has(trigger.kind) && isDue(trigger, now))) budgetMs = 0;
    const timeout = Math.min(WAIT_MAX_SECONDS, Math.max(0, Math.ceil(budgetMs / 1000)));
    // --max-failures counts the command and the reply, never the poll, so an unguarded poll ended
    // the whole watch on the first hiccup. A watcher is the one thing that must outlive a blip.
    let page: PageShape;
    try {
      page = await pollThroughBlips(
        () => waitPage(client, state.room_id, credential.member_token, cursor, timeout, filters),
        sleep,
        dependencies,
        deadline,
      );
    } catch (error) {
      if (timeoutSeconds !== null && timeoutSeconds > 0 && cutByDeadline(error, deadline, dependencies.now().getTime())) {
        // Nothing was said in time; the timed-out wake below says so.
        page = { items: [], next_cursor: null, has_more: false };
      } else if (wantsClosed && error instanceof CliError && error.code === "room_closed") {
        closed = true;
        page = { items: [], next_cursor: null, has_more: false };
      } else {
        throw error;
      }
    }
    cursor = highestSequence(page.items, cursor);
    const others = page.items.filter((item) => !isOwn(item, me, state.member_id));
    if (others.length > 0) {
      batch.push(...others);
      lastMessageAt = dependencies.now().getTime();
    }

    const at = dependencies.now().getTime();
    const firedTriggers = triggers.filter((trigger) => isDue(trigger, at));
    const timedOut = deadline !== null && at >= deadline;
    if (firedTriggers.length === 0 && !(timedOut && !command)) {
      if (page.items.length === 0) await sleep(0);
      continue;
    }

    const fired = firedTriggers.map((trigger) => trigger.label);
    // A filter chose the moment; the wake still carries everything said since the last handled one.
    const handed =
      filters.size > 0 && cursor > persisted
        ? (
            await pollThroughBlips(
              () => everythingSaid(client, state.room_id, credential.member_token, persisted, cursor),
              sleep,
              dependencies,
              deadline,
            )
          ).filter((item) => !isOwn(item, me, state.member_id))
        : batch;
    const events: Array<Record<string, unknown>> = handed.map((item) => ({ kind: "message", ...item }));
    for (const trigger of firedTriggers) {
      if (trigger.kind === "check") {
        events.push({ kind: "check", trigger: trigger.label, command: trigger.command, ...checks.get(trigger.label)!.fire! });
      } else if (trigger.kind === "closed") {
        events.push({ kind: "closed", trigger: trigger.label, at: iso(at) });
      } else if (!SAID_KINDS.has(trigger.kind)) {
        events.push({ kind: "timer", trigger: trigger.label, at: iso(at) });
      }
    }
    if (pending === null && fired.length > 0) {
      const identity = wakeIdentity({ roomId: state.room_id, memberId: state.member_id, from: persisted, through: cursor, fired, messageCount: handed.length, firedAt: at });
      pending = { wakeId: identity.wakeId, replyKey: identity.replyKey, reply: null, failures: 0 };
    }
    const wake: Wake = {
      wake_id: pending?.wakeId ?? null,
      room_id: state.room_id,
      member_id: state.member_id,
      trigger: fired[0] ?? null,
      fired,
      messages: handed,
      events,
      from: persisted,
      through: cursor,
    };
    // What has fired is spent once it is handled: a one-off does not fire twice, a calendar moves
    // to its next day, a check waits to start passing again.
    const spend = () => {
      for (const trigger of firedTriggers) {
        if (trigger.kind === "after" || trigger.kind === "at") spent.add(trigger.label);
        if (trigger.kind === "cron") cronDue.set(trigger.label, nextCronTime(trigger.schedule, at));
        if (trigger.kind === "check") checks.get(trigger.label)!.fire = null;
      }
    };

    if (!command) {
      // One wake, returned. Either the cursor moves now, or it waits for `sharednet ack`.
      if (ack === "manual") {
        if (wake.wake_id !== null) {
          await writePendingWake(dependencies.cwd, state.member_id, { wake_id: wake.wake_id, room_id: state.room_id, from: persisted, through: cursor });
        }
      } else if (cursor > state.last_sequence) {
        await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
      }
      await appendWakeLog(logPath, {
        at: iso(at),
        verb,
        room_id: state.room_id,
        member_id: state.member_id,
        wake_id: wake.wake_id,
        fired,
        from: wake.from,
        through: wake.through,
        sequences: handed.map((item) => item.sequence),
        ack,
      });
      return wake;
    }

    pending ??= { wakeId: wake.wake_id ?? "", replyKey: randomUUID(), reply: null, failures: 0 };
    let exitCode = 0;
    let replyMessageId: string | null = null;
    let status: SitRun["status"] = "ok";
    // A reply the command already produced but the Room never received is
    // posted first, without running the command again.
    if (pending.reply === null) {
      const input = `${JSON.stringify(wake)}\n`;
      const result = await exec(command, input, {
        SHAREDNET_ROOM_ID: state.room_id,
        SHAREDNET_MEMBER_ID: state.member_id,
        SHAREDNET_MESSAGE_COUNT: String(handed.length),
        SHAREDNET_LAST_SEQUENCE: String(cursor),
        SHAREDNET_WAKE_ID: pending.wakeId,
        SHAREDNET_FIRED: fired.join(" | "),
      });
      if (result.stderr) log(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      exitCode = result.exitCode;
      if (exitCode !== 0) status = "failed";
      else if (reply && result.stdout.trim().length > 0) pending.reply = result.stdout.trim();
    }
    if (status === "ok" && pending.reply !== null) {
      try {
        const posted = await client.request<{ message?: { id?: string } }>(
          "POST",
          `/rooms/${encodeURIComponent(state.room_id)}/messages`,
          credential.member_token,
          { content: pending.reply },
          { "idempotency-key": pending.replyKey },
        );
        replyMessageId = posted?.message?.id ?? null;
      } catch (error) {
        status = "reply_failed";
        log(`${verb}: reply not posted (${error instanceof CliError ? error.code : "error"}); will retry with the same key\n`);
      }
    }

    if (status === "ok") {
      persisted = cursor;
      await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: persisted });
      spend();
    } else {
      pending.failures += 1;
    }
    const record: SitRun = {
      run: runs.length + 1,
      trigger: fired[0]!,
      fired,
      wake_id: pending.wakeId,
      messages: handed.length,
      status,
      exit_code: exitCode,
      reply_message_id: replyMessageId,
      last_sequence: persisted,
    };
    runs.push(record);
    await appendWakeLog(logPath, {
      at: iso(at),
      verb,
      room_id: state.room_id,
      member_id: state.member_id,
      wake_id: record.wake_id,
      fired,
      from: wake.from,
      through: wake.through,
      sequences: handed.map((item) => item.sequence),
      status,
      exit_code: exitCode,
      reply_message_id: replyMessageId,
    });
    log(
      `${verb}: run ${record.run}, ${record.messages} message(s), ${status}` +
        (status === "failed" ? ` (exit ${exitCode})` : "") +
        (replyMessageId ? `, replied ${replyMessageId}` : "") +
        (status !== "ok" ? `, ${record.messages} message(s) kept for the next wake` : "") +
        "\n",
    );
    lastRunAt = dependencies.now().getTime();
    const handledClose = status === "ok" && firedTriggers.some((trigger) => trigger.kind === "closed");
    if (status === "ok") {
      batch = [];
      pending = null;
    } else if (pending.failures >= maxFailures) {
      stopUnhandled(handed);
    }
    // A closed Room has nothing more to say: the wait that was told so ends with it.
    if (handledClose) return { room_id: state.room_id, trigger: summaryLabel, runs, closed: true };
    if (maxRuns !== null && runs.length >= maxRuns) {
      if (pending !== null) stopUnhandled(handed);
      return { room_id: state.room_id, trigger: summaryLabel, runs };
    }
  }
}

async function watch(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  return sit("watch", parseGuestArguments(args), dependencies);
}

/**
 * `wait` as it always was — sit until something new is said, then print it
 * and advance the cursor; `--timeout N` bounds the sit in seconds (0 checks
 * once), `--min N` waits for N, `--hook` is the shape a Claude Code hook wants:
 * one immediate check, plain lines, exit 0 whether or not anything arrived —
 * and, with any of the newer options, the one wait above.
 */
async function wait(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  const newer = ["on", "run", "reply", "max-runs", "max-failures", "ack", "log", "settle", "check-every"];
  if (newer.some((name) => parsed.options.has(name))) {
    if (parsed.options.has("hook") || parsed.options.has("min")) {
      throw localError("invalid_arguments", "--hook and --min belong to the plain wait; with --on, use --on count <n> for a minimum.");
    }
    return sit("wait", parsed, dependencies);
  }
  assertOnlyOptions(parsed, ["timeout", "hook", "min", "as", "from-instance", "from-agent", "grep"]);
  if (parsed.positionals.length !== 0) {
    throw localError("invalid_arguments", WAIT_USAGE);
  }
  // The same filters a read takes, so being woken can be as narrow as reading is. On a Room with
  // thirty Agents, one message must not start thirty of them. They narrow when the caller wakes,
  // not what it is handed (everythingSaid).
  const filters = waitFiltersFrom(parsed.options);
  const hook = parsed.options.get("hook") === true;
  const totalSeconds = hook ? 0 : parseTimeout(stringOption(parsed, "timeout"));
  const minimum = parseCount(stringOption(parsed, "min"), "--min") ?? 1;
  const deadline =
    totalSeconds === null ? null : dependencies.now().getTime() + totalSeconds * 1000;
  const { client, state, credential } = await currentSeat(
    { ...dependencies, fetch: boundedFetch(dependencies, deadline, totalSeconds === 0) },
    stringOption(parsed, "as"),
  );
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const me = await whoAmI(client, state, credential);

  // The Room log is raw and includes what this seat said; the cursor moves
  // over all of it, but only other members' words wake the caller, count
  // toward --min, or come back. A page of nothing but one's own words is
  // consumed and the sit continues.
  const items: MessageShape[] = [];
  let cursor = state.last_sequence;
  for (;;) {
    // Setup may already have spent the time this wait was given.
    if (totalSeconds !== null && totalSeconds > 0 && dependencies.now().getTime() >= deadline!) break;
    const remaining =
      deadline === null
        ? WAIT_MAX_SECONDS
        : Math.max(0, Math.ceil((deadline - dependencies.now().getTime()) / 1000));
    const timeout = Math.min(WAIT_MAX_SECONDS, remaining);
    let page: PageShape;
    try {
      page = await pollThroughBlips(
        () => waitPage(client, state.room_id, credential.member_token, cursor, timeout, filters),
        sleep,
        dependencies,
        deadline,
      );
    } catch (error) {
      if (totalSeconds !== null && totalSeconds > 0 && cutByDeadline(error, deadline, dependencies.now().getTime())) break;
      throw error;
    }
    const advanced = highestSequence(page.items, cursor) > cursor;
    cursor = highestSequence(page.items, cursor);
    items.push(...page.items.filter((item) => !isOwn(item, me, state.member_id)));
    if (items.length >= minimum) break;
    if (deadline !== null && dependencies.now().getTime() >= deadline) break;
    // The server answered at its cap, or with only our own words; ask again.
    if (!advanced) await sleep(0);
  }
  // A filter chose the moment; what comes back is everything said since the cursor, not only the match.
  if (filters.size > 0 && cursor > state.last_sequence) {
    const everything = await pollThroughBlips(
      () => everythingSaid(client, state.room_id, credential.member_token, state.last_sequence, cursor),
      sleep,
      dependencies,
      deadline,
    );
    items.splice(0, items.length, ...everything.filter((item) => !isOwn(item, me, state.member_id)));
  }
  const page: PageShape = { items, next_cursor: null, has_more: false };

  if (cursor > state.last_sequence) {
    await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: cursor });
  }

  if (hook) {
    return {
      hook: true,
      lines: page.items.map(
        (item) => `#${item.sequence} ${item.sender?.name ?? item.sender?.member_id ?? "member"}: ${item.content}`,
      ),
    };
  }
  return page;
}

/**
 * Acknowledge a wake delivered with `wait --ack manual`: the work is done, move
 * the cursor past it. Only the wake this seat is holding can be acknowledged,
 * and the cursor only ever moves forward.
 */
async function ackWake(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const [wakeId] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !/^wk_[A-Za-z0-9_-]{16}$/.test(wakeId!)) {
    throw localError("invalid_arguments", "Usage: sharednet ack <wk_…> [--as <member_id>]");
  }
  const { state } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const held = await readPendingWake(dependencies.cwd, state.member_id);
  if (!held || held.wake_id !== wakeId || held.room_id !== state.room_id) {
    throw localError(
      "unknown_wake",
      "This seat is not holding that wake, so nothing moved. `sharednet wait --ack manual` shows what is pending.",
    );
  }
  const lastSequence = Math.max(state.last_sequence, held.through);
  await writeProjectRoomState(dependencies.cwd, { ...state, last_sequence: lastSequence });
  const { rm } = await import("node:fs/promises");
  await rm(pendingWakePath(dependencies.cwd, state.member_id), { force: true });
  return { wake_id: wakeId, room_id: state.room_id, member_id: state.member_id, last_sequence: lastSequence };
}

/** The read flags, as a query string: filter, order, window. `--last K` is newest-first, K of them. */
export function messageQueryFrom(options: Map<string, string | true>): URLSearchParams {
  const value = (name: string): string | undefined => {
    const raw = options.get(name);
    return typeof raw === "string" ? raw : undefined;
  };
  const parameters = new URLSearchParams();
  const last = value("last");
  const after = value("after");
  const before = value("before");
  const limit = value("limit");
  const order = value("order");
  for (const [name, raw] of [["after", after], ["before", before], ["limit", limit], ["last", last]] as const) {
    if (raw !== undefined && !/^\d+$/.test(raw)) throw localError("invalid_arguments", `--${name} takes a whole number.`);
  }
  if (last !== undefined && (after !== undefined || before !== undefined || limit !== undefined || order !== undefined)) {
    throw localError("invalid_arguments", "--last stands alone; use --order desc --limit K to combine.");
  }
  if (limit !== undefined && (Number(limit) < 1 || Number(limit) > 100)) throw localError("invalid_limit", "--limit must be an integer from 1 to 100.");
  if (last !== undefined && (Number(last) < 1 || Number(last) > 100)) throw localError("invalid_limit", "--last must be an integer from 1 to 100.");
  if (order !== undefined && order !== "asc" && order !== "desc") throw localError("invalid_arguments", "--order is asc or desc.");
  if (after !== undefined) parameters.set("after", after);
  if (before !== undefined) parameters.set("before", before);
  if (limit !== undefined) parameters.set("limit", limit);
  if (order !== undefined) parameters.set("order", order);
  if (last !== undefined) {
    parameters.set("order", "desc");
    parameters.set("limit", last);
  }
  const fromInstance = value("from-instance");
  if (fromInstance !== undefined) {
    if (!/^i_[0-9A-Za-z]{10}$/.test(fromInstance)) throw localError("invalid_arguments", "--from-instance takes an Instance id such as i_AbCdEfGhIj, not a display name.");
    parameters.set("sender_instance_id", fromInstance);
  }
  const fromAgent = value("from-agent");
  if (fromAgent !== undefined) {
    if (fromAgent !== "default" && !/^a_[0-9A-Za-z]{10}$/.test(fromAgent)) throw localError("invalid_arguments", "--from-agent takes an Agent id such as a_AbCdEfGhIj, or default.");
    parameters.set("sender_agent_id", fromAgent);
  }
  const grep = value("grep");
  if (grep !== undefined) {
    if (grep.length === 0 || [...grep].length > 256) throw localError("invalid_arguments", "--grep takes 1 to 256 characters.");
    parameters.set("q", grep);
  }
  return parameters;
}

export const READ_OPTIONS = ["after", "before", "limit", "order", "last", "from-instance", "from-agent", "grep"] as const;

/**
 * `sharednet read`: a window of this Room's log. Filter (grep, sender, tag),
 * order, window; the cursor is untouched, so reading is never "seeing".
 */
async function read(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, [...READ_OPTIONS, "as"]);
  if (parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet read [--grep TEXT] [--from-instance i_…] [--from-agent a_…|default] [--last K | --after N | --before N] [--limit K] [--order asc|desc]",
    );
  }
  const query = messageQueryFrom(parsed.options);
  const { client, state, credential } = await currentSeat(dependencies, stringOption(parsed, "as"));
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(state.room_id)}/messages${query.size ? `?${query.toString()}` : ""}`,
    credential.member_token,
  );
  // --last K is asked newest-first and shown oldest-first, the way a person reads a tail.
  if (parsed.options.has("last") && Array.isArray(page?.items)) {
    return { ...page, items: [...page.items].reverse() };
  }
  return page;
}

/**
 * `sharednet whoami`: who this machine acts as, and which seat this
 * directory holds, from the files alone. Ids only; never a key or a token.
 */
async function whoami(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet whoami");
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const stored = await readStoredApiCredential(paths).catch(() => null);
  const envKey = Boolean(dependencies.env.SHAREDNET_API_KEY?.trim());
  const account =
    stored && sameOrigin(stored.base_url, baseUrl)
      ? { principal_id: stored.principal_id, api_key_id: stored.api_key_id, source: "credentials_file" as const, credentials_file: paths.credentialsFile }
      : envKey
        ? { principal_id: null, api_key_id: null, source: "SHAREDNET_API_KEY" as const, credentials_file: null }
        : null;
  const room = await readProjectRoom(dependencies.cwd);
  const anchorKey = await anchorKeyFor(dependencies.env, paths);
  const chosen = dependencies.env.SHAREDNET_SEAT?.trim() || undefined;
  const selected = room
    ? await selectProjectSeat(dependencies.cwd, { ...(chosen ? { explicit: chosen } : {}), anchorKey }).catch(() => null)
    : null;
  // The seats this directory holds, on whatever origin the Room lives, and
  // which one this session acts as; say/wait act on that origin.
  const seat = room
    ? {
        base_url: room.base_url,
        room_id: room.room_id,
        member_id: selected?.member_id ?? null,
        last_sequence: selected?.last_sequence ?? null,
        credential_present:
          selected !== null && (await readRoomCredential(paths, room.room_id, selected.member_id).catch(() => null)) !== null,
        seats: Object.entries(room.seats).map(([memberId, entry]) => ({
          member_id: memberId,
          last_sequence: entry.last_sequence,
          this_session: entry.anchor_key !== null && entry.anchor_key === anchorKey,
        })),
      }
    : null;
  return {
    base_url: baseUrl,
    account,
    seat,
    // What to do about it, in one line each.
    next:
      account === null
        ? "This machine acts as nobody. Run `sharednet login` so seats are your account's; `join` without it seats an anonymous Principal."
        : seat === null
          ? "Logged in. Run `sharednet join <invite>` in a project directory to take a seat."
          : seat.member_id === null
            ? "This directory holds several seats and none is this session's; say which with --as <member_id> or SHAREDNET_SEAT."
            : "Logged in and seated. `say`, `wait`, and `watch` act as this seat.",
  };
}

/**
 * Seat more Instances in this directory's Room, by id: public ones at once,
 * private ones by asking (decision 2026-09-06 reach, §3).
 */
async function add(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const ids = parsed.positionals;
  if (ids.length === 0 || ids.some((id) => !/^i_[0-9A-Za-z]{10}$/.test(id))) {
    throw localError("invalid_arguments", "Usage: sharednet add <i_…> [<i_…> …]");
  }
  const { client, state, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/rooms/${encodeURIComponent(state.room_id)}/members`,
    credential.member_token,
    { with: ids },
  );
}

/** `sharednet reach private|public`: whether strangers who know this seat's id must ask first. */
async function reach(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const value = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || (value !== "public" && value !== "private")) {
    throw localError("invalid_arguments", "Usage: sharednet reach public|private");
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request("PATCH", "/instances/current", credential.member_token, { reach: value });
}

/** The Rooms this seat sits in, newest first; where a seat that was added finds its new Room. */
async function rooms(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet rooms");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/rooms", credential.member_token);
}

/** Requests waiting on this seat: someone wants it in a Room while it is private. */
async function requests(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet requests");
  const { client, credential } = await currentSeat(dependencies);
  return client.request("GET", "/decisions?status=pending", credential.member_token);
}

/** The seat answers for itself: accept takes the seat, deny refuses it. */
async function answer(
  resolution: "approved" | "denied",
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, []);
  const decisionId = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !decisionId || !/^dec_[0-9A-Za-z]{10}$/.test(decisionId)) {
    const verb = resolution === "approved" ? "accept" : "deny";
    throw localError("invalid_arguments", `Usage: sharednet ${verb} <dec_…>`);
  }
  const { client, credential } = await currentSeat(dependencies);
  return client.request(
    "POST",
    `/decisions/${encodeURIComponent(decisionId)}/resolve`,
    credential.member_token,
    { resolution },
  );
}

/**
 * Credits (decision 2026-09-11): the purse is the account's, so a seat in this
 * directory pays as its account and the ledger records the seat; a directory
 * that is in no Room pays with the account key `sharednet login` left here.
 */
type CreditCredential = {
  client: ApiClient;
  token: string;
  as: "seat" | "account";
  seat: { room_id: string; member_id: string } | null;
};

async function creditCredential(dependencies: GuestDependencies, explicitSeat?: string): Promise<CreditCredential> {
  try {
    const { client, state, credential } = await currentSeat(dependencies, explicitSeat);
    return { client, token: credential.member_token, as: "seat", seat: { room_id: state.room_id, member_id: state.member_id } };
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== "not_in_a_room") throw error;
  }
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const stored = await readStoredApiCredential(paths).catch(() => null);
  const key = stored && sameOrigin(stored.base_url, baseUrl) ? stored.api_key : dependencies.env.SHAREDNET_API_KEY?.trim() || null;
  if (!key) {
    throw localError(
      "not_logged_in",
      "This directory is not in a Room and this machine acts as nobody. Run sharednet login, or join a Room first.",
    );
  }
  return { client: new ApiClient(baseUrl, dependencies.fetch), token: key, as: "account", seat: null };
}

type CreditsShape = { credits: { principal_id: string; balance: number; granted: number; sent: number; received: number } };
type TransferShape = { id: string; amount: number; to_principal_id: string; [key: string]: unknown };

async function balance(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet balance [--as <i_…>]");
  const { client, token, as, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  const payload = await client.request<CreditsShape>("GET", "/credits", token);
  return { ...payload.credits, as, seat };
}

async function redeem(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["as"]);
  const code = parsed.positionals[0]?.trim();
  if (parsed.positionals.length !== 1 || !code) throw localError("invalid_arguments", "Usage: sharednet redeem <CODE>");
  const { client, token } = await creditCredential(dependencies, stringOption(parsed, "as"));
  return client.request("POST", "/credits/redeem", token, { code });
}

/**
 * `pay <target> <amount>`: the target is a Principal, Agent or Instance id;
 * the amount a whole number. With `--room`, the payment is recorded against
 * this directory's Room and the seat posts a one-line receipt into it, so a
 * trade is visible where it was agreed. Every payment carries its own key.
 */
async function pay(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["memo", "room", "as"]);
  const [target, amountText] = parsed.positionals;
  if (parsed.positionals.length !== 2 || !target || !amountText) {
    throw localError("invalid_arguments", "Usage: sharednet pay <p_…|a_…|i_…> <amount> [--memo <text>] [--room] [--as <i_…>]");
  }
  if (!/^(?:p|a|i)_[0-9A-Za-z]{10}$/.test(target)) {
    throw localError("invalid_arguments", "The target must be a Principal (p_…), Agent (a_…) or Instance (i_…) id.");
  }
  const amount = Number(amountText);
  if (!/^\d+$/.test(amountText) || !Number.isSafeInteger(amount) || amount < 1) {
    throw localError("invalid_arguments", "The amount must be a whole number of credits, at least 1.");
  }
  const memo = stringOption(parsed, "memo");
  const announce = parsed.options.has("room");
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  if (announce && seat === null) {
    throw localError("not_in_a_room", "--room records the payment against this directory's Room; join one first.");
  }
  const paid = await client.request<{ transfer: TransferShape; credits: CreditsShape["credits"] }>(
    "POST",
    "/credits/transfers",
    token,
    { to: target, amount, ...(memo === undefined ? {} : { memo }), ...(announce && seat ? { room_id: seat.room_id } : {}) },
    { "idempotency-key": randomUUID() },
  );
  let receipt: unknown = null;
  let warning: { code: "receipt_not_confirmed"; message: string } | undefined;
  if (announce && seat) {
    try {
      receipt = await client.request(
        "POST",
        `/rooms/${encodeURIComponent(seat.room_id)}/messages`,
        token,
        { content: `Paid ${amount} credit${amount === 1 ? "" : "s"} to ${target}${memo ? ` — ${memo}` : ""} (${paid.transfer.id})` },
        { "idempotency-key": randomUUID() },
      );
    } catch {
      // The payment is final even if the separate receipt fails or its reply
      // is lost. Reporting the payment as failed invites a second debit.
      warning = {
        code: "receipt_not_confirmed",
        message: "Payment succeeded, but the Room receipt was not confirmed. Do not repeat this payment.",
      };
    }
  }
  return { ...paid, receipt, ...(warning ? { warning } : {}) };
}

async function ledger(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["last", "before", "as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet ledger [--last <n>] [--before <txn_…>]");
  const lastText = stringOption(parsed, "last");
  const last = lastText === undefined ? 20 : Number(lastText);
  if (!Number.isSafeInteger(last) || last < 1 || last > 100) throw localError("invalid_arguments", "--last must be between 1 and 100.");
  const before = stringOption(parsed, "before");
  if (before !== undefined && !/^txn_[0-9A-Za-z]{10}$/.test(before)) throw localError("invalid_arguments", "--before must be a transfer id such as txn_AbCdEfGhIj.");
  const { client, token } = await creditCredential(dependencies, stringOption(parsed, "as"));
  const query = new URLSearchParams({ limit: String(last), ...(before === undefined ? {} : { before }) });
  return client.request("GET", `/credits/transfers?${query.toString()}`, token);
}

/**
 * Artifacts (decision 2026-09-11): a file handed to the Room. `upload` puts
 * one in the Room this directory sits in, or behind a link for anyone;
 * `download` takes an id or a link and writes the bytes here.
 */
type ArtifactShape = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  room_id: string | null;
};

/** A name to write on this machine: the last segment, never a path. */
function safeBasename(value: string): string {
  const name = value.split(/[\\/]+/).pop()?.trim() ?? "";
  if (name === "" || name === "." || name === "..") {
    throw localError("invalid_filename", "That file has no usable name; pass --out to say where to write it.");
  }
  return name;
}

async function upload(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["name", "as"]);
  const path = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !path) {
    throw localError("invalid_arguments", "Usage: sharednet upload <path> [--name <filename>] [--as <i_…>]");
  }
  const resolved = resolvePath(dependencies.cwd, path);
  let bytes: Buffer;
  try {
    bytes = await readFile(resolved);
  } catch {
    throw localError("file_not_found", `Nothing to upload at ${path}.`);
  }
  if (bytes.byteLength === 0) throw localError("file_empty", "That file is empty.");
  const filename = safeBasename(stringOption(parsed, "name") ?? resolved);
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  // Every file comes back with a link. A directory that holds a seat also
  // hands the file to that Room, so the others can read it by id.
  return client.request("POST", "/artifacts", token, bytes, {
    "content-type": contentTypeFor(filename),
    ...(/[^\x20-\x7e]/.test(filename)
      ? { "x-sharednet-filename*": `UTF-8''${encodeURIComponent(filename)}` }
      : { "x-sharednet-filename": filename }),
    ...(seat === null ? {} : { "x-sharednet-room": seat.room_id }),
    "idempotency-key": randomUUID(),
  });
}

async function download(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["out", "force", "as"]);
  const target = parsed.positionals[0];
  if (parsed.positionals.length !== 1 || !target) {
    throw localError("invalid_arguments", "Usage: sharednet download <art_… | link> [--out <path>] [--force]");
  }
  // A link carries its own key and needs no credential; an id is read as this seat.
  const link = /^https?:\/\//.test(target) ? new URL(target) : null;
  let artifactId: string;
  let client: ApiClient;
  let token = "";
  let key: string | null = null;
  if (link) {
    const match = /\/(?:f|api\/v1\/artifacts)\/(art_[0-9A-Za-z]{10})(?:\/content)?$/.exec(link.pathname);
    key = link.searchParams.get("k");
    if (!match || key === null) {
      throw localError("invalid_arguments", "That link does not point at a SharedNet file.");
    }
    artifactId = match[1]!;
    client = new ApiClient(`${link.protocol}//${link.host}`, dependencies.fetch);
  } else {
    if (!/^art_[0-9A-Za-z]{10}$/.test(target)) {
      throw localError("invalid_arguments", "Pass a file id such as art_AbCdEfGhIj, or a link.");
    }
    artifactId = target;
    const credential = await creditCredential(dependencies, stringOption(parsed, "as"));
    client = credential.client;
    token = credential.token;
  }
  const meta = key === null ? await client.request<{ artifact: ArtifactShape }>("GET", `/artifacts/${artifactId}`, token) : null;
  const bytes = await client.requestBytes(
    `/artifacts/${artifactId}/content${key === null ? "" : `?k=${encodeURIComponent(key)}`}`,
    token,
  );
  const name = safeBasename(stringOption(parsed, "out") ?? meta?.artifact.filename ?? bytes.filename ?? artifactId);
  const out = resolvePath(dependencies.cwd, stringOption(parsed, "out") ?? name);
  try {
    // Exclusive creation handles competing downloads and dangling symlinks in
    // the same operation that opens the file; a prior stat cannot protect it.
    await writeFile(out, bytes.bytes, { flag: parsed.options.has("force") ? "w" : "wx" });
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw localError("file_exists", `${name} is already here. Pass --force to overwrite it, or --out to write elsewhere.`);
    }
    throw error;
  }
  const digest = createHash("sha256").update(bytes.bytes).digest("hex");
  return {
    artifact_id: artifactId,
    path: out,
    size_bytes: bytes.bytes.byteLength,
    sha256: digest,
    // The server states the digest it stored; a mismatch means the bytes changed on the way.
    verified: bytes.sha256 === null ? null : bytes.sha256 === digest,
  };
}

async function files(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["last", "before", "room", "as"]);
  if (parsed.positionals.length !== 0) throw localError("invalid_arguments", "Usage: sharednet files [--room] [--last <n>] [--before <art_…>]");
  const lastText = stringOption(parsed, "last");
  const last = lastText === undefined ? 20 : Number(lastText);
  if (!Number.isSafeInteger(last) || last < 1 || last > 100) throw localError("invalid_arguments", "--last must be between 1 and 100.");
  const before = stringOption(parsed, "before");
  if (before !== undefined && !/^art_[0-9A-Za-z]{10}$/.test(before)) {
    throw localError("invalid_arguments", "--before must be a file id such as art_AbCdEfGhIj.");
  }
  const { client, token, seat } = await creditCredential(dependencies, stringOption(parsed, "as"));
  if (parsed.options.has("room") && seat === null) {
    throw localError("not_in_a_room", "--room lists this directory's Room; join one first.");
  }
  const query = new URLSearchParams({
    limit: String(last),
    ...(before === undefined ? {} : { before }),
    ...(parsed.options.has("room") && seat ? { room_id: seat.room_id } : {}),
  });
  return client.request("GET", `/artifacts?${query.toString()}`, token);
}

/** Enough of a media type for the common things Agents pass; the rest are bytes. */
function contentTypeFor(filename: string): string {
  const extension = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const known: Record<string, string> = {
    csv: "text/csv",
    diff: "text/plain",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    log: "text/plain",
    md: "text/markdown",
    patch: "text/plain",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp",
    yaml: "text/plain",
    yml: "text/plain",
  };
  return known[extension] ?? "application/octet-stream";
}

/**
 * The resident connector.
 *
 * `wait` and `watch` each sit in one Room, in the foreground, until something ends them. That
 * makes waking conditional on someone having started a command and nothing having gone wrong
 * since, which is not what "you can be woken" should mean. `serve` is the process that makes it
 * unconditional while the machine is up: it sits in **every** Room this machine holds a seat in,
 * each on its own loop, and it does not stop.
 *
 * Multi-Room costs nothing here and that is the point. `heldSeats` already walks every seat under
 * `rooms/<room_id>/<member_id>.json`, so one process covering all of them is less work than one
 * process per Room — no seat file to pick, no `--as` to pass, and a Room that goes wrong takes
 * only its own loop down.
 *
 * Where `wait` gives up after a bounded number of attempts, because a foreground command should
 * not hang forever, this never does. A daemon that exits on a long outage is a daemon that was
 * not running when the message finally came.
 */
async function serve(args: string[], dependencies: GuestDependencies): Promise<unknown> {
  const parsed = parseGuestArguments(args);
  assertOnlyOptions(parsed, ["run", "reply", "rooms", "from-instance", "from-agent", "grep", "status", "stop"]);
  if (parsed.positionals.length !== 0) {
    throw localError(
      "invalid_arguments",
      "Usage: sharednet serve [--run '<command>'] [--reply] [--rooms all|rom_…,rom_…] [--grep TEXT] , or sharednet serve --status | --stop",
    );
  }
  const paths = getStoragePaths(dependencies.env);
  if (parsed.options.get("status") === true) return readServeStatus(paths);
  if (parsed.options.get("stop") === true) return stopServe(paths, dependencies);

  const command = stringOption(parsed, "run");
  const reply = parsed.options.get("reply") === true;
  if (reply && !command) throw localError("invalid_arguments", "--reply needs --run: it says back what the command prints.");
  const filters = waitFiltersFrom(parsed.options);
  const wanted = stringOption(parsed, "rooms");
  const only = wanted === undefined || wanted === "all" ? null : new Set(wanted.split(",").map((value) => value.trim()));
  if (only) {
    for (const roomId of only) {
      if (!ROOM_ID_PATTERN.test(roomId)) throw localError("invalid_arguments", `--rooms takes Room ids such as rom_AbCdEfGhIj, or all. Got ${roomId}.`);
    }
  }

  const seats = (await heldSeats(paths)).filter((seat) => (only ? only.has(seat.room_id) : true));
  if (seats.length === 0) {
    throw localError(
      "not_in_a_room",
      only
        ? "This machine holds no seat in the Rooms named by --rooms."
        : "This machine holds no Room seats yet. Run: sharednet join <invite>",
    );
  }

  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exec = dependencies.exec ?? defaultExec;
  const started = dependencies.now().toISOString();
  await writeServeStatus(paths, { pid: process.pid, started_at: started, rooms: seats.map((seat) => seat.room_id) });
  dependencies.stderr?.(`serve: sitting in ${seats.length} Room(s): ${seats.map((seat) => seat.room_id).join(", ")}\n`);

  // One loop per Room. They never await each other, so a slow or broken Room cannot make another
  // Room miss a message.
  const loops = seats.map(async (seat) => {
    const client = new ApiClient(seat.base_url, boundedFetch(dependencies, null, false));
    // The connector keeps its own cursor per Room. The project cursor belongs to a checkout and a
    // daemon is not in one; and a cursor that survives a restart is the whole difference between
    // a wake that was delayed and one that was lost. With no cursor yet it starts at the Room's
    // current end, so a first start does not replay the entire history as if it were new.
    const me = seat.member_id;
    let cursor = await readServeCursor(paths, seat.room_id, seat.member_id);
    if (cursor === null) {
      cursor = await roomEnd(client, seat).catch(() => 0);
      await writeServeCursor(paths, seat.room_id, seat.member_id, cursor);
    }
    // Where the long-poll resumes. Without a filter it is the cursor. With one it can run ahead, past
    // the seat's own matching words, while the cursor stays at what has been handed over.
    let polled = cursor;
    for (;;) {
      let page: PageShape;
      try {
        page = await waitPage(client, seat.room_id, seat.member_token, polled, WAIT_MAX_SECONDS, filters);
      } catch (error) {
        // Three different things, and treating them alike was wrong. Unreachable is temporary and
        // is waited out forever, because that is the whole job. A refusal — a revoked seat, a
        // closed Room — is the service working and will not change by being asked again, so this Room's
        // loop ends and the others carry on. Anything that is not a CliError is a bug in here, and
        // spinning on it would hide it.
        if (!(error instanceof CliError)) throw error;
        const temporary = error.code === "service_unavailable" || error.code === "invalid_server_response";
        if (!temporary) {
          dependencies.stderr?.(`serve: ${seat.room_id} stopped: ${error.code}\n`);
          return;
        }
        dependencies.stderr?.(`serve: ${seat.room_id} unreachable; retrying in 10s\n`);
        await sleep(10_000);
        continue;
      }
      polled = highestSequence(page.items, polled);
      const matched = page.items.filter((item) => !isOwn(item, me, seat.member_id));
      if (matched.length === 0 && filters.size > 0) continue;
      // A filter chose the moment; the wake still carries everything said since the last one.
      let others = matched;
      if (filters.size > 0) {
        try {
          others = (await everythingSaid(client, seat.room_id, seat.member_token, cursor, polled)).filter(
            (item) => !isOwn(item, me, seat.member_id),
          );
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          dependencies.stderr?.(`serve: ${seat.room_id} could not read what came before the match (${error.code}); retrying in 10s\n`);
          polled = cursor;
          await sleep(10_000);
          continue;
        }
      }
      cursor = polled;
      await writeServeCursor(paths, seat.room_id, seat.member_id, cursor);
      if (others.length === 0) continue;
      dependencies.stderr?.(`serve: ${seat.room_id} woke on ${others.length} message(s) through sequence ${cursor}\n`);
      if (!command) continue;
      const input = `${JSON.stringify({ room_id: seat.room_id, member_id: seat.member_id, trigger: "message", messages: others })}\n`;
      const result = await exec(command, input, {
        SHAREDNET_ROOM_ID: seat.room_id,
        SHAREDNET_MEMBER_ID: seat.member_id,
        SHAREDNET_MESSAGE_COUNT: String(others.length),
        SHAREDNET_LAST_SEQUENCE: String(cursor),
      });
      if (result.stderr) dependencies.stderr?.(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
      if (result.exitCode !== 0) {
        dependencies.stderr?.(`serve: ${seat.room_id} command exited ${result.exitCode}\n`);
        continue;
      }
      if (reply && result.stdout.trim().length > 0) {
        await client
          .request("POST", `/rooms/${encodeURIComponent(seat.room_id)}/messages`, seat.member_token, { content: result.stdout.trim() }, { "idempotency-key": randomUUID() })
          .catch((error: unknown) => {
            dependencies.stderr?.(`serve: ${seat.room_id} reply not posted (${error instanceof CliError ? error.code : "error"})\n`);
          });
      }
    }
  });
  await Promise.all(loops);
  return { served: seats.length };
}

/** Where the connector remembers how far it has read in one Room. */
function serveCursorPath(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): string {
  return joinPath(paths.roomsDir, roomId, `${memberId}.serve-cursor`);
}

async function readServeCursor(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string): Promise<number | null> {
  try {
    const raw = await readFile(serveCursorPath(paths, roomId, memberId), "utf8");
    const value = Number(raw.trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeServeCursor(paths: ReturnType<typeof getStoragePaths>, roomId: string, memberId: string, cursor: number): Promise<void> {
  await writeFile(serveCursorPath(paths, roomId, memberId), `${cursor}\n`, { mode: 0o600 }).catch(() => undefined);
}

/** The newest sequence in a Room, so a first start listens forward instead of replaying. */
async function roomEnd(client: ApiClient, seat: StoredRoomCredential): Promise<number> {
  const page = await client.request<PageShape>(
    "GET",
    `/rooms/${encodeURIComponent(seat.room_id)}/messages?order=desc&limit=1`,
    seat.member_token,
  );
  return page.items[0]?.sequence ?? 0;
}

type ServeStatus = { pid: number; started_at: string; rooms: string[] };

function serveStatusPath(paths: ReturnType<typeof getStoragePaths>): string {
  return joinPath(paths.configDir, "serve.json");
}

async function writeServeStatus(paths: ReturnType<typeof getStoragePaths>, status: ServeStatus): Promise<void> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await writeFile(serveStatusPath(paths), `${JSON.stringify(status)}\n`, { mode: 0o600 });
}

/** `running` is checked, not claimed: a status file outlives the process that wrote it. */
async function readServeStatus(paths: ReturnType<typeof getStoragePaths>): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(serveStatusPath(paths), "utf8");
  } catch {
    return { running: false, reason: "no connector has been started on this machine" };
  }
  const status = JSON.parse(raw) as ServeStatus;
  let running = false;
  try {
    process.kill(status.pid, 0);
    running = true;
  } catch {
    running = false;
  }
  return { running, ...status, ...(running ? {} : { reason: "the process that wrote this status is gone" }) };
}

async function stopServe(paths: ReturnType<typeof getStoragePaths>, dependencies: GuestDependencies): Promise<unknown> {
  const status = (await readServeStatus(paths)) as { running?: boolean; pid?: number };
  if (!status.running || !status.pid) return { stopped: false, reason: "no connector is running on this machine" };
  process.kill(status.pid, "SIGTERM");
  dependencies.stderr?.(`serve: asked pid ${status.pid} to stop\n`);
  return { stopped: true, pid: status.pid };
}

export type GuestVerb =
  | "serve"
  | "whoami"
  | "join"
  | "say"
  | "read"
  | "wait"
  | "ack"
  | "balance"
  | "redeem"
  | "pay"
  | "ledger"
  | "upload"
  | "download"
  | "files"
  | "watch"
  | "add"
  | "rooms"
  | "requests"
  | "accept"
  | "deny"
  | "reach";

export function isGuestVerb(value: string | undefined): value is GuestVerb {
  return (
    value === "serve" ||
    value === "whoami" ||
    value === "join" ||
    value === "say" ||
    value === "read" ||
    value === "wait" ||
    value === "ack" ||
    value === "balance" ||
    value === "redeem" ||
    value === "pay" ||
    value === "ledger" ||
    value === "upload" ||
    value === "download" ||
    value === "files" ||
    value === "watch" ||
    value === "add" ||
    value === "rooms" ||
    value === "requests" ||
    value === "accept" ||
    value === "deny" ||
    value === "reach"
  );
}

export async function runGuestVerb(
  verb: GuestVerb,
  args: string[],
  dependencies: GuestDependencies,
): Promise<unknown> {
  if (verb === "serve") return serve(args, dependencies);
  if (verb === "whoami") return whoami(args, dependencies);
  if (verb === "join") return join(args, dependencies);
  if (verb === "say") return say(args, dependencies);
  if (verb === "read") return read(args, dependencies);
  if (verb === "watch") return watch(args, dependencies);
  if (verb === "ack") return ackWake(args, dependencies);
  if (verb === "add") return add(args, dependencies);
  if (verb === "rooms") return rooms(args, dependencies);
  if (verb === "requests") return requests(args, dependencies);
  if (verb === "accept") return answer("approved", args, dependencies);
  if (verb === "deny") return answer("denied", args, dependencies);
  if (verb === "reach") return reach(args, dependencies);
  if (verb === "balance") return balance(args, dependencies);
  if (verb === "redeem") return redeem(args, dependencies);
  if (verb === "pay") return pay(args, dependencies);
  if (verb === "ledger") return ledger(args, dependencies);
  if (verb === "upload") return upload(args, dependencies);
  if (verb === "download") return download(args, dependencies);
  if (verb === "files") return files(args, dependencies);
  return wait(args, dependencies);
}
