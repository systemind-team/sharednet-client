import { randomUUID } from "node:crypto";

import { ApiClient, resolveBaseUrl } from "./api-client.ts";
import { CliError, asCliError, localError } from "./errors.ts";
import { READ_OPTIONS, isGuestVerb, messageQueryFrom, runGuestVerb, type CommandRunner } from "./guest.ts";
import { login } from "./login.ts";
import { refreshIfNeeded, registerInstance, selectSession } from "./session.ts";
import { deleteSession, getStoragePaths, type StoragePaths, type StoredSession } from "./storage.ts";


type Environment = Record<string, string | undefined>;

export interface CliDependencies {
  env?: Environment;
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  now?: () => Date;
  /** Where per-project Room state lives; defaults to the process working directory. */
  cwd?: string;
  /** Pause between empty long-polls in `wait`; tests shorten it. */
  sleep?: (ms: number) => Promise<void>;
  /** Opens the approve page during `login`; tests capture the URL instead. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Runs the `watch --run` command; tests capture it instead of shelling out. */
  exec?: CommandRunner;
}

interface ResolvedDependencies {
  env: Environment;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  now: () => Date;
  cwd: string;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => Promise<boolean>;
}

interface GlobalArguments {
  args: string[];
  json: boolean;
  sessionId?: string;
}

interface ParsedArguments {
  options: Map<string, string | true>;
  positionals: string[];
}

const optionValueNames = new Set([
  "after",
  "before",
  "limit",
  "order",
  "last",
  "from-instance",
  "from-agent",
  "grep",
  "agent",
  "runtime",
  "name",
  "description",
  "content",
  "reply-to",
  "after",
  "limit",
  "with",
  "status",
]);
const booleanOptionNames = new Set(["new", "private"]);

/** `--with i_a,i_b`: the Instances to seat, as the API takes them. */
function instanceList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = value.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  if (ids.length === 0 || ids.some((id) => !/^i_[0-9A-Za-z]{10}$/.test(id))) {
    throw localError("invalid_option", "--with takes Instance ids such as i_AbCdEfGhIj, separated by commas.");
  }
  return ids;
}

function extractGlobals(argv: string[]): GlobalArguments {
  const args: string[] = [];
  let json = false;
  let sessionId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--api-key" || argument.startsWith("--api-key=")) {
      throw localError(
        "credential_flag_forbidden",
        "API keys are accepted only from SHAREDNET_API_KEY or secure local credentials.",
      );
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--session" || argument.startsWith("--session=")) {
      if (sessionId !== undefined) {
        throw localError("duplicate_option", "The --session option may be supplied only once.");
      }
      const value = argument === "--session" ? argv[++index] : argument.slice("--session=".length);
      if (!value || !/^i_[A-Za-z0-9_-]+$/.test(value)) {
        throw localError("invalid_session_id", "The --session value must be an Instance ID.");
      }
      sessionId = value;
      continue;
    }
    args.push(argument);
  }
  return { args, json, sessionId };
}

function parseArguments(args: string[]): ParsedArguments {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const separator = argument.indexOf("=");
    const name = argument.slice(2, separator === -1 ? undefined : separator);
    if (options.has(name)) {
      throw localError("duplicate_option", `The --${name} option may be supplied only once.`);
    }
    if (booleanOptionNames.has(name)) {
      if (separator !== -1) {
        throw localError("invalid_option", `The --${name} option does not accept a value.`);
      }
      options.set(name, true);
      continue;
    }
    if (!optionValueNames.has(name)) {
      throw localError("unknown_option", "The command contains an unknown option.");
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw localError("missing_option_value", `The --${name} option requires a value.`);
    }
    options.set(name, value);
  }
  return { options, positionals };
}

function option(arguments_: ParsedArguments, name: string): string | undefined {
  const value = arguments_.options.get(name);
  return typeof value === "string" ? value : undefined;
}

function requiredOption(arguments_: ParsedArguments, name: string): string {
  const value = option(arguments_, name);
  if (!value) throw localError("missing_required_option", `The --${name} option is required.`);
  return value;
}

function assertOnlyOptions(arguments_: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const name of arguments_.options.keys()) {
    if (!allowedSet.has(name)) {
      throw localError("unknown_option", `The --${name} option is not valid for this command.`);
    }
  }
}

function assertPositionals(arguments_: ParsedArguments, count: number): void {
  if (arguments_.positionals.length !== count) {
    throw localError("invalid_arguments", "The command received the wrong number of arguments.");
  }
}

async function withSelectedSession<T>(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
  callback: (
    client: ApiClient,
    session: StoredSession,
    paths: StoragePaths,
  ) => Promise<T>,
): Promise<T> {
  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const client = new ApiClient(baseUrl, dependencies.fetch);
  let session = await selectSession(
    paths,
    baseUrl,
    globals.sessionId,
    dependencies.env,
  );
  session = await refreshIfNeeded(client, paths, session, dependencies.now());
  try {
    return await callback(client, session, paths);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === 3) {
      await deleteSession(paths, session.instance_id);
    }
    throw error;
  }
}

async function startSession(
  commandArgs: string[],
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, ["agent", "runtime", "new", "private"]);

  const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
  const paths = getStoragePaths(dependencies.env);
  const { payload } = await registerInstance(dependencies.env, dependencies.fetch, paths, baseUrl, {
    runtimeOverride: option(parsed, "runtime"),
    forceNew: parsed.options.get("new") === true,
    agent: option(parsed, "agent"),
    freshWhenUndetected: false,
    // --private: strangers who know this Instance's id have to ask before
    // seating it. Omitted, the Principal's default applies (public).
    ...(parsed.options.get("private") === true ? { reach: "private" as const } : {}),
  });
  return {
    instance: payload.instance,
    session_id: payload.instance.id,
    heartbeat_after_seconds: payload.heartbeat_after_seconds,
  };
}

async function sessionStatus(
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  assertPositionals(parsed, 0);
  assertOnlyOptions(parsed, []);
  return withSelectedSession(globals, dependencies, (client, session) =>
    client.request("GET", "/instances/current", session.instance_token),
  );
}

async function roomCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "create") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, ["name", "description", "with"]);
    const name = requiredOption(parsed, "name");
    const description = option(parsed, "description");
    const withIds = instanceList(option(parsed, "with"));
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", "/rooms", session.instance_token, {
        name,
        ...(description === undefined ? {} : { description }),
        ...(withIds === undefined ? {} : { with: withIds }),
      }, { "idempotency-key": randomUUID() }),
    );
  }

  if (action === "list") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, []);
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("GET", "/rooms", session.instance_token),
    );
  }

  if (action === "invite") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const roomId = parsed.positionals[0]!;
    if (!/^rom_[0-9A-Za-z]{10}$/.test(roomId)) {
      throw localError("invalid_arguments", "Usage: sharednet room invite <rom_…>");
    }
    return withSelectedSession(globals, dependencies, async (client, session) => {
      const minted = await client.request<{ invite: unknown; token: string; link: string }>(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/invites`,
        session.instance_token,
      );
      // What the human forwards: the link for people, and the same invite as
      // one line for an Agent. The token is the invite; it opens this Room
      // and nothing else, so it may be handed on.
      const baseUrl = resolveBaseUrl(dependencies.env.SHAREDNET_BASE_URL);
      return {
        room_id: roomId,
        invite: minted.invite,
        link: minted.link,
        for_agents: `ROOM=${roomId} TOKEN=${minted.token} BASE=${baseUrl}`,
        command: `npx -y sharednet@latest join 'ROOM=${roomId} TOKEN=${minted.token} BASE=${baseUrl}'`,
      };
    });
  }

  if (action === "add") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["with"]);
    const roomId = parsed.positionals[0]!;
    const withIds = instanceList(requiredOption(parsed, "with"));
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", `/rooms/${encodeURIComponent(roomId)}/members`, session.instance_token, {
        with: withIds,
      }),
    );
  }

  if (action === "join") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const roomId = parsed.positionals[0]!;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/join`,
        session.instance_token,
        undefined,
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "post") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, ["content", "reply-to"]);
    const roomId = parsed.positionals[0]!;
    const content = requiredOption(parsed, "content");
    const replyTo = option(parsed, "reply-to");
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "POST",
        `/rooms/${encodeURIComponent(roomId)}/messages`,
        session.instance_token,
        {
          content,
          ...(replyTo === undefined ? {} : { reply_to_message_id: replyTo }),
        },
        { "idempotency-key": randomUUID() },
      ),
    );
  }

  if (action === "messages") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, [...READ_OPTIONS]);
    const roomId = parsed.positionals[0]!;
    const parameters = messageQueryFrom(parsed.options);
    const query = parameters.size ? `?${parameters.toString()}` : "";
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request(
        "GET",
        `/rooms/${encodeURIComponent(roomId)}/messages${query}`,
        session.instance_token,
      ),
    );
  }

  throw localError("unknown_command", "Unknown room command.");
}

/**
 * Decisions addressed to the selected Instance: today, requests to seat it
 * in a Room while it is private. The Instance answers for itself.
 */
async function decisionCommand(
  action: string | undefined,
  commandArgs: string[],
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const parsed = parseArguments(commandArgs);
  if (action === "list") {
    assertPositionals(parsed, 0);
    assertOnlyOptions(parsed, ["status"]);
    const status = option(parsed, "status");
    const query = status === undefined ? "" : `?status=${encodeURIComponent(status)}`;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("GET", `/decisions${query}`, session.instance_token),
    );
  }
  if (action === "approve" || action === "deny") {
    assertPositionals(parsed, 1);
    assertOnlyOptions(parsed, []);
    const decisionId = parsed.positionals[0]!;
    return withSelectedSession(globals, dependencies, (client, session) =>
      client.request("POST", `/decisions/${encodeURIComponent(decisionId)}/resolve`, session.instance_token, {
        resolution: action === "approve" ? "approved" : "denied",
      }),
    );
  }
  throw localError("unknown_command", "Unknown decision command. Use decision list, approve <id>, or deny <id>.");
}

async function execute(
  globals: GlobalArguments,
  dependencies: ResolvedDependencies,
): Promise<unknown> {
  const [resource, action, ...commandArgs] = globals.args;
  if (resource === "login") {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", "The --session option is not valid for sharednet login.");
    }
    return login(globals.args.slice(1), dependencies);
  }
  if (isGuestVerb(resource)) {
    if (globals.sessionId !== undefined) {
      throw localError("invalid_option", `The --session option is not valid for sharednet ${resource}.`);
    }
    return runGuestVerb(resource, globals.args.slice(1), dependencies);
  }
  if (resource === "session" && action === "start") {
    return startSession(commandArgs, dependencies);
  }
  if (resource === "session" && action === "status") {
    return sessionStatus(commandArgs, globals, dependencies);
  }
  if (resource === "room") {
    return roomCommand(action, commandArgs, globals, dependencies);
  }
  if (resource === "decision") {
    return decisionCommand(action, commandArgs, globals, dependencies);
  }
  throw localError(
    "unknown_command",
    "Use login, whoami, join/say/read/wait/watch/add/rooms/requests/accept/deny/reach, balance/redeem/pay/ledger, upload/download/files, or session start/status, room create/list/invite/add/join/post/messages, and decision list/approve/deny.",
  );
}

function isHookOutput(payload: unknown): payload is { hook: true; lines: string[] } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { hook?: unknown }).hook === true &&
    Array.isArray((payload as { lines?: unknown }).lines)
  );
}

function writeSuccess(
  payload: unknown,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  // A hook's stdout goes straight into an Agent's context: plain lines, and
  // nothing at all when the Room was quiet.
  if (!json && isHookOutput(payload)) {
    if (payload.lines.length > 0) dependencies.stdout(`${payload.lines.join("\n")}\n`);
    return;
  }
  dependencies.stdout(`${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
}

function writeFailure(
  error: CliError,
  json: boolean,
  dependencies: ResolvedDependencies,
): void {
  if (json) {
    dependencies.stderr(
      `${JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          ...(error.requestId ? { request_id: error.requestId } : {}),
        },
      })}\n`,
    );
    return;
  }
  const requestSuffix = error.requestId ? ` (${error.requestId})` : "";
  dependencies.stderr(`${error.code}: ${error.message}${requestSuffix}\n`);
}

export async function runCli(
  argv: string[],
  supplied: CliDependencies = {},
): Promise<number> {
  const dependencies: ResolvedDependencies = {
    env: supplied.env ?? process.env,
    fetch: supplied.fetch ?? globalThis.fetch,
    stdout: supplied.stdout ?? ((value) => process.stdout.write(value)),
    stderr: supplied.stderr ?? ((value) => process.stderr.write(value)),
    now: supplied.now ?? (() => new Date()),
    cwd: supplied.cwd ?? process.cwd(),
    ...(supplied.sleep ? { sleep: supplied.sleep } : {}),
    ...(supplied.openBrowser ? { openBrowser: supplied.openBrowser } : {}),
    ...(supplied.exec ? { exec: supplied.exec } : {}),
  };
  let json = argv.includes("--json");
  try {
    const globals = extractGlobals(argv);
    json = globals.json;
    const payload = await execute(globals, dependencies);
    writeSuccess(payload, globals.json, dependencies);
    return 0;
  } catch (error) {
    const cliError = asCliError(error);
    writeFailure(cliError, json, dependencies);
    return cliError.exitCode;
  }
}
