import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { ApiClient } from "./api-client.ts";
import { localError } from "./errors.ts";
import { goalWatch, type GoalWatchResult } from "./goal.ts";

/**
 * `goal run`: the goal Room, the Agents that work on it, and the runner that
 * ends it, in one command. The Agents run in one Docker container, which is
 * the workspace they share and the sandbox they work in: the owner's account
 * key never enters it, and each Agent has its own home and its own seat.
 * Each Agent works in turns. The runner holds every seat's wait, starts a
 * turn when the seat is woken, and resumes the same harness session, so every
 * Agent is woken by one policy and the record says when and by what.
 */

export type Driver = "codex" | "claude-code";

export interface AgentSpec {
  /** The seat's name in the Room: the driver and a number, `codex-1`. */
  name: string;
  driver: Driver;
  model: string | null;
}

const DRIVERS: readonly Driver[] = ["codex", "claude-code"];
const MAX_AGENTS = 8;

/** `--agent codex`, `--agent codex:gpt-6-luna`, `--agent claude-code:claude-sonnet-5-5`; repeat it for more seats. */
export function parseAgents(raws: readonly string[]): AgentSpec[] {
  if (raws.length === 0) {
    throw localError("invalid_arguments", "goal run needs at least one --agent: codex or claude-code, with :<model> to choose the model.");
  }
  if (raws.length > MAX_AGENTS) throw localError("invalid_arguments", `goal run starts at most ${MAX_AGENTS} Agents.`);
  const counts = new Map<Driver, number>();
  return raws.map((raw) => {
    const separator = raw.indexOf(":");
    const driver = (separator === -1 ? raw : raw.slice(0, separator)).trim() as Driver;
    const model = separator === -1 ? null : raw.slice(separator + 1).trim() || null;
    if (!DRIVERS.includes(driver)) throw localError("invalid_arguments", `--agent ${raw}: the driver is codex or claude-code.`);
    if (model !== null && !/^[A-Za-z0-9._/-]{1,100}$/.test(model)) throw localError("invalid_arguments", `--agent ${raw}: that is not a model name.`);
    const number = (counts.get(driver) ?? 0) + 1;
    counts.set(driver, number);
    return { name: `${driver}-${number}`, driver, model };
  });
}

// ---- Docker ----

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker <args>`. `env` is added to the Docker client's own environment, which is how a
 * secret reaches a container (`-e NAME` with no value) without appearing in any argument list.
 * With `onLine`, stdout is handed over line by line as it comes and not kept.
 */
export type DockerRunner = (
  args: readonly string[],
  options?: { input?: string; env?: Record<string, string>; onLine?: (line: string) => void },
) => Promise<DockerResult>;

export function dockerRunner(baseEnv: Record<string, string | undefined>): DockerRunner {
  // The owner's key has no business near Docker, not even in the client's own environment.
  const { SHAREDNET_API_KEY: _ownerKey, ...clientEnv } = baseEnv;
  return (args, options = {}) =>
    new Promise((resolveRun) => {
      const child = spawn("docker", [...args], { env: { ...clientEnv, ...options.env } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let partial = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (!options.onLine) {
          stdout += chunk;
          return;
        }
        partial += chunk;
        for (let index = partial.indexOf("\n"); index !== -1; index = partial.indexOf("\n")) {
          options.onLine(partial.slice(0, index));
          partial = partial.slice(index + 1);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-64_000);
      });
      child.on("error", () => resolveRun({ code: 127, stdout, stderr: "docker could not be started" }));
      child.on("close", (code) => {
        if (options.onLine && partial) options.onLine(partial);
        resolveRun({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.end(options.input ?? "");
    });
}

/** The image the Agents run in when no --image is given; built on first use. */
export const DEFAULT_IMAGE = "sharednet-goal-agents:1";
export const AGENT_DOCKERFILE = `FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-pytest ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @anthropic-ai/claude-code && npm cache clean --force
RUN mkdir -p /home/agents /workspace && chown node:node /home/agents /workspace
USER node
WORKDIR /workspace
`;

const AGENT_USER = "node";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOMES = "/home/agents";
const CONTAINER_CLI = "/opt/sharednet";
const CONTAINER_CODEX_AUTH = "/run/codex/auth.json";
/** A turn that runs longer than this is stopped; the next wake starts the next one. */
const TURN_LIMIT_SECONDS = 1_200;
/** A seat whose harness fails this many turns in a row stops taking turns. */
const FAILED_TURNS_LIMIT = 3;

export function containerName(roomId: string): string {
  return `sharednet-goal-${roomId}`;
}

/**
 * The port of a development service on this machine's loopback, the one plain-HTTP address the CLI
 * accepts. Inside the container that address is the container's own, so the runner forwards the
 * same port to this machine; the Agents then use the address the runner uses.
 */
export function loopbackPort(baseUrl: string): number | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  return Number(url.port || 80);
}

const FORWARDER = `const net = require("node:net");
const port = Number(process.argv[1]);
net.createServer((socket) => {
  const upstream = net.connect(port, "host.docker.internal");
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}).listen(port, "127.0.0.1");`;
const FORWARDER_PROBE = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));`;

export interface RunPlan {
  image: string;
  agents: AgentSpec[];
  workspace: string;
  /** This CLI's own package on this machine, mounted into the container so the Agents run the same version. */
  cli: { root: string; entry: string };
  /** How the Codex seats sign in: an API key from this environment, or this machine's Codex login. */
  codexAuth: { kind: "api-key" } | { kind: "login"; file: string } | null;
  /** The variable that signs the Claude Code seats in, passed through by name. */
  claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | null;
}

/** The package root of the CLI that is running: the directory with its package.json. */
export function cliPackage(entry: string): { root: string; entry: string } {
  for (let directory = dirname(entry); directory !== dirname(directory); directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return { root: directory, entry: relative(directory, entry) };
  }
  throw localError("invalid_local_state", "The SharedNet CLI's own package could not be found, so it cannot be handed to the Agents.");
}

/**
 * Everything goal run needs before it creates anything: Docker, the image, and a way for each
 * driver to sign in. A run that would fail half-way is refused here instead.
 */
export async function prepareRun(
  input: { agents: AgentSpec[]; image: string | null; workspace: string; env: Record<string, string | undefined>; home: string; entry: string },
  docker: DockerRunner,
  log: (line: string) => void,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms)),
): Promise<RunPlan> {
  if ((await docker(["info", "--format", "{{.ServerVersion}}"])).code !== 0) {
    throw localError("docker_unavailable", "goal run starts the Agents in a Docker container; start Docker, then run it again.");
  }
  const image = input.image ?? DEFAULT_IMAGE;
  // Docker Desktop waking from idle can answer `info` before it can see its images: ask again before building.
  let present = false;
  for (let attempt = 0; attempt < 5 && !present; attempt += 1) {
    if (attempt > 0) await pause(1_000);
    present = (await docker(["image", "inspect", image])).code === 0;
  }
  if (!present) {
    if (input.image !== null) throw localError("image_not_found", `The image ${image} is not on this machine.`);
    log(`goal: building the Agents' image ${image}, once; this takes a few minutes\n`);
    const built = await docker(["build", "-t", image, "-"], { input: AGENT_DOCKERFILE });
    if (built.code !== 0) throw localError("image_build_failed", `The Agents' image could not be built: ${built.stderr.trim().split("\n").slice(-3).join(" ")}`);
  }
  let codexAuth: RunPlan["codexAuth"] = null;
  if (input.agents.some((agent) => agent.driver === "codex")) {
    const login = join(input.home, ".codex", "auth.json");
    if (input.env.OPENAI_API_KEY) codexAuth = { kind: "api-key" };
    // Mounted by its real path: Docker would otherwise mount the link, not the login.
    else if (existsSync(login)) codexAuth = { kind: "login", file: realpathSync(login) };
    else throw localError("agent_auth_missing", "A codex Agent signs in with OPENAI_API_KEY or this machine's Codex login (codex login); neither is here.");
  }
  let claudeAuth: RunPlan["claudeAuth"] = null;
  if (input.agents.some((agent) => agent.driver === "claude-code")) {
    if (input.env.CLAUDE_CODE_OAUTH_TOKEN) claudeAuth = "CLAUDE_CODE_OAUTH_TOKEN";
    else if (input.env.ANTHROPIC_API_KEY) claudeAuth = "ANTHROPIC_API_KEY";
    else {
      throw localError(
        "agent_auth_missing",
        "A claude-code Agent signs in with CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token` and export what it prints) or ANTHROPIC_API_KEY; neither is set.",
      );
    }
  }
  return { image, agents: input.agents, workspace: input.workspace, cli: cliPackage(input.entry), codexAuth, claudeAuth };
}

// ---- turns ----

export interface WakeShape {
  wake_id: string | null;
  fired: string[];
  messages: Array<{ sequence: number; content: string; sender?: { member_id?: string; name?: string | null } }>;
  events: Array<Record<string, unknown>>;
  from: number;
  through: number;
}

/** What one Agent is told first: who it is, the goal, how the Room ends, and how to speak. */
export function openingPrompt(input: { seat: AgentSpec; seats: AgentSpec[]; roomId: string; goal: string; goalSequence: number; until: string[] }): string {
  const others = input.seats.filter((seat) => seat.name !== input.seat.name).map((seat) => seat.name);
  const claims = input.until.filter((trigger) => trigger.startsWith("said ")).map((trigger) => `"${trigger.slice(5)}"`);
  return [
    `You are ${input.seat.name}, one of ${input.seats.length} agents working on one goal in SharedNet Room ${input.roomId}.${others.length > 0 ? ` The others: ${others.join(", ")}.` : ""}`,
    "",
    `The goal (message #${input.goalSequence}):`,
    "<goal>",
    input.goal.trim(),
    "</goal>",
    "",
    `The Room ends when the first of these happens: ${input.until.join("; ")}.`,
    ...(claims.length > 0 ? [`Say ${claims.join(" or ")} in the Room only when you believe the goal is met: saying it runs the check.`] : []),
    "",
    `You share this directory (${CONTAINER_WORKSPACE}) with the others. Talk to them only through the Room, with the sharednet command:`,
    "  sharednet read --last 30 --json    what has been said",
    '  sharednet say "…" --json          say something; keep it short',
    "Do not run `sharednet wait` or `sharednet watch`: when your turn ends, you are woken with whatever is said next.",
    "Lines from `runner` are the goal's machinery, such as a check's result, not a person.",
    "Agree in the Room who does what, do your part, and end your turn when there is nothing more to do now.",
  ].join("\n");
}

/** What a woken Agent is told: everything said since its last turn. */
export function wakePrompt(wake: WakeShape): string {
  const lines = wake.messages.map((message) => `#${message.sequence} ${message.sender?.name ?? message.sender?.member_id ?? "someone"}: ${message.content}`);
  return [`New in the Room since your last turn (#${wake.from + 1} to #${wake.through}):`, ...lines, "", "Carry on with the goal."].join("\n");
}

/** One turn: a fresh harness run, or the same session resumed, with nothing asked of a person. */
export function turnCommand(seat: AgentSpec, prompt: string, sessionId: string | null): string[] {
  const limit = ["timeout", String(TURN_LIMIT_SECONDS)];
  if (seat.driver === "codex") {
    // Live web search, which Claude Code has by default: a goal is as often research as code.
    const flags = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", 'web_search="live"', ...(seat.model ? ["-m", seat.model] : [])];
    return sessionId === null ? [...limit, "codex", "exec", ...flags, prompt] : [...limit, "codex", "exec", "resume", ...flags, sessionId, prompt];
  }
  return [
    ...limit,
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    ...(seat.model ? ["--model", seat.model] : []),
    ...(sessionId === null ? [] : ["--resume", sessionId]),
    prompt,
  ];
}

/** Tokens as a harness reports them: read fresh, read again from the cache, and written. */
export interface Usage {
  input: number;
  cached: number;
  output: number;
}

/**
 * What a budget is judged on: tokens read fresh plus tokens written. The cached context a harness
 * reads again on every model call is most of the raw count (93% in the first real run) at a tenth
 * of the price, so it is recorded and not counted.
 */
export function freshTokens(usage: Usage | null): number {
  return usage ? usage.input + usage.output : 0;
}

function numberAt(record: Record<string, unknown> | null | undefined, key: string): number {
  return typeof record?.[key] === "number" ? (record[key] as number) : 0;
}

/** Codex counts cached input inside input_tokens. */
function codexUsage(raw: Record<string, unknown>): Usage {
  const cached = numberAt(raw, "cached_input_tokens");
  return { input: Math.max(0, numberAt(raw, "input_tokens") - cached), cached, output: numberAt(raw, "output_tokens") };
}

/** A Codex session file's own running total: exact, and it includes a turn that the end of the goal cut. */
export function codexSessionUsage(rollout: string): Usage | null {
  let last: Usage | null = null;
  for (const line of rollout.split("\n")) {
    if (!line.includes('"token_count"')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; payload?: { type?: string; info?: { total_token_usage?: Record<string, unknown> } | null } };
      const total = event.payload?.info?.total_token_usage;
      if (event.type === "event_msg" && event.payload?.type === "token_count" && total) last = codexUsage(total);
    } catch {
      // A line cut off mid-write says nothing.
    }
  }
  return last;
}

export interface TurnReading {
  sessionId: string | null;
  /**
   * Codex: the session's running total as of this turn, since a resumed `codex exec` reports the
   * whole session's usage. Claude Code: this run's own usage.
   */
  usage: Usage | null;
  failed: boolean;
}

/** Reads a harness's JSON stream for what the runner needs: the session to resume, and the spend. */
export class TurnReader {
  readonly reading: TurnReading = { sessionId: null, usage: null, failed: false };
  private readonly driver: Driver;

  constructor(driver: Driver) {
    this.driver = driver;
  }

  line(text: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const usage = (event.usage ?? null) as Record<string, unknown> | null;
    if (this.driver === "codex") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") this.reading.sessionId = event.thread_id;
      if (event.type === "turn.completed" && usage) this.reading.usage = codexUsage(usage);
      if (event.type === "turn.failed" || event.type === "error") this.reading.failed = true;
      return;
    }
    if (typeof event.session_id === "string") this.reading.sessionId = event.session_id;
    if (event.type === "result") {
      if (usage) {
        this.reading.usage = {
          input: numberAt(usage, "input_tokens") + numberAt(usage, "cache_creation_input_tokens"),
          cached: numberAt(usage, "cache_read_input_tokens"),
          output: numberAt(usage, "output_tokens"),
        };
      }
      if (event.is_error === true) this.reading.failed = true;
    }
  }
}

// ---- the run ----

export interface SeatRecord {
  name: string;
  driver: Driver;
  model: string | null;
  member_id: string | null;
  session_id: string | null;
  turns: number;
  failed_turns: number;
  /** Fresh tokens: what a budget counts. */
  tokens: number;
  usage: Usage;
}

export interface GoalRunInput {
  plan: RunPlan;
  roomId: string;
  inviteToken: string;
  goal: string;
  goalSequence: number;
  until: string[];
  baseUrl: string;
  out: string;
  checkEveryMs: number;
  quietChecks: boolean;
}

export interface GoalRunDependencies {
  docker: DockerRunner;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
}

export interface GoalRunResult extends GoalWatchResult {
  agents: SeatRecord[];
  tokens: number;
}

/** Creates nothing outside the container and the record; the Room and its goal already exist. */
export async function runGoal(
  client: ApiClient,
  memberToken: string,
  apiKey: string,
  input: GoalRunInput,
  dependencies: GoalRunDependencies,
): Promise<GoalRunResult> {
  const { docker, plan } = { docker: dependencies.docker, plan: input.plan };
  const log = dependencies.stderr ?? (() => undefined);
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const container = containerName(input.roomId);
  const base = input.baseUrl;
  await mkdir(input.out, { recursive: true });
  const wakeLog = join(input.out, "wakes.ndjson");
  await writeFile(wakeLog, "");

  const startContainer = () => docker([
    "run",
    "--detach",
    "--name",
    container,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--volume",
    `${plan.workspace}:${CONTAINER_WORKSPACE}`,
    "--volume",
    `${plan.cli.root}:${CONTAINER_CLI}:ro`,
    ...(plan.codexAuth?.kind === "login" ? ["--volume", `${plan.codexAuth.file}:${CONTAINER_CODEX_AUTH}`] : []),
    plan.image,
    "sleep",
    "infinity",
  ]);

  let ended = false;
  const records: SeatRecord[] = plan.agents.map((agent) => ({
    ...agent,
    member_id: null,
    session_id: null,
    turns: 0,
    failed_turns: 0,
    tokens: 0,
    usage: { input: 0, cached: 0, output: 0 },
  }));
  /** A seat's usage: Codex reports the session's running total, Claude Code each run's own. */
  const account = (seat: SeatRecord, usage: Usage | null, sessionTotal: boolean) => {
    if (!usage) return 0;
    const before = seat.tokens;
    seat.usage = sessionTotal
      ? usage
      : { input: seat.usage.input + usage.input, cached: seat.usage.cached + usage.cached, output: seat.usage.output + usage.output };
    seat.tokens = freshTokens(seat.usage);
    return seat.tokens - before;
  };
  const spend = () => records.reduce((sum, record) => sum + record.tokens, 0);
  const exec = (seat: SeatRecord | null, command: readonly string[], options: { env?: Record<string, string>; onLine?: (line: string) => void } = {}) => {
    const home = seat ? `${CONTAINER_HOMES}/${seat.name}` : null;
    const environment = [
      ...(home ? ["-e", `HOME=${home}`] : []),
      ...(home && seat?.driver === "codex" ? ["-e", `CODEX_HOME=${home}/.codex`] : []),
      "-e",
      `SHAREDNET_BASE_URL=${base}`,
      ...(seat?.member_id ? ["-e", `SHAREDNET_SEAT=${seat.member_id}`] : []),
      ...(seat?.driver === "claude-code" && plan.claudeAuth ? ["-e", plan.claudeAuth] : []),
      ...(seat?.driver === "codex" && plan.codexAuth?.kind === "api-key" ? ["-e", "OPENAI_API_KEY"] : []),
      ...Object.keys(options.env ?? {}).flatMap((name) => ["-e", name]),
    ];
    return docker(["exec", "--user", AGENT_USER, "--workdir", CONTAINER_WORKSPACE, ...environment, container, ...command], options);
  };

  /** The container, the Agents' command, and every seat; a start that fails closes the Room it opened. */
  const setUp = async () => {
    const started = await startContainer();
    if (started.code !== 0) throw localError("container_failed", `The Agents' container did not start: ${started.stderr.trim()}`);
    const port = loopbackPort(base);
    if (port !== null) {
      await docker(["exec", "--detach", "--user", AGENT_USER, container, "node", "-e", FORWARDER, String(port)]);
      let listening = false;
      for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
        listening = (await docker(["exec", "--user", AGENT_USER, container, "node", "-e", FORWARDER_PROBE, String(port)])).code === 0;
        if (!listening) await sleep(250);
      }
      if (!listening) throw localError("container_failed", `The container could not reach this machine's port ${port}.`);
    }
    // The Agents' `sharednet` is this CLI, so they speak the version that started them.
    const entry = `${CONTAINER_CLI}/${plan.cli.entry}`;
    const wrapper = `#!/bin/sh\nexec node ${entry.endsWith(".ts") ? "--experimental-strip-types --no-warnings " : ""}${entry} "$@"\n`;
    const installed = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "cat > /usr/local/bin/sharednet && chmod 755 /usr/local/bin/sharednet"], { input: wrapper });
    if (installed.code !== 0) throw localError("container_failed", `The sharednet command could not be put in the container: ${installed.stderr.trim()}`);

    // Every seat: its own home, its own sign-in, its own seat in the Room.
    for (const seat of records) {
      const home = `${CONTAINER_HOMES}/${seat.name}`;
      const setup =
        seat.driver === "codex"
          ? plan.codexAuth?.kind === "login"
            ? `mkdir -p ${home}/.codex && ln -sf ${CONTAINER_CODEX_AUTH} ${home}/.codex/auth.json`
            : `mkdir -p ${home}/.codex && printf '{"OPENAI_API_KEY": "%s"}' "$OPENAI_API_KEY" > ${home}/.codex/auth.json && chmod 600 ${home}/.codex/auth.json`
          : `mkdir -p ${home}`;
      const prepared = await exec(seat, ["sh", "-c", setup]);
      if (prepared.code !== 0) throw localError("container_failed", `${seat.name}'s home could not be made: ${prepared.stderr.trim()}`);
      // The driver's own marker names the seat's runtime on the Web; the invite travels by environment.
      const marker: Record<string, string> = seat.driver === "codex" ? { CODEX_SESSION_ID: `goal-${seat.name}` } : { CLAUDECODE: "1" };
      const joined = await exec(seat, ["sharednet", "join", input.roomId, "--name", seat.name, "--json"], {
        env: { ...marker, SHAREDNET_INVITE_TOKEN: input.inviteToken },
      });
      const memberId = (() => {
        try {
          return (JSON.parse(joined.stdout) as { member_id?: string }).member_id ?? null;
        } catch {
          return null;
        }
      })();
      if (joined.code !== 0 || !memberId) throw localError("join_failed", `${seat.name} could not join the Room: ${(joined.stdout + joined.stderr).trim().slice(0, 400)}`);
      seat.member_id = memberId;
    }
    log(`goal: ${records.map((seat) => `${seat.name} (${seat.member_id})`).join(", ")} joined ${input.roomId}\n`);
  };

  try {
    try {
      await setUp();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "error";
      await client
        .request("POST", `/rooms/${encodeURIComponent(input.roomId)}/close`, apiKey, { detail: `goal run could not start: ${reason}`.slice(0, 2_000) })
        .catch(() => undefined);
      throw error;
    }

    const runTurn = async (seat: SeatRecord, prompt: string, wake: WakeShape | null) => {
      seat.turns += 1;
      const number = String(seat.turns).padStart(3, "0");
      const directory = join(input.out, "agents", seat.name);
      await mkdir(directory, { recursive: true });
      const stream = join(directory, `turn-${number}.jsonl`);
      await writeFile(stream, "");
      const reader = new TurnReader(seat.driver);
      const startedAt = dependencies.now().toISOString();
      let writes = Promise.resolve();
      const result = await exec(seat, turnCommand(seat, prompt, seat.session_id), {
        onLine: (line) => {
          reader.line(line);
          writes = writes.then(() => appendFile(stream, `${line}\n`));
        },
      });
      await writes;
      if (result.stderr.trim()) await writeFile(join(directory, `turn-${number}.stderr.txt`), result.stderr);
      const reading = reader.reading;
      seat.session_id = reading.sessionId ?? seat.session_id;
      const spent = account(seat, reading.usage, seat.driver === "codex");
      // A turn the end of the goal stopped did not fail; its spend is lost with it, as the harness reports at a turn's end.
      const cut = ended && result.code !== 0;
      const failed = !cut && (result.code !== 0 || reading.failed);
      if (failed) seat.failed_turns += 1;
      await appendFile(
        wakeLog,
        `${JSON.stringify({
          seat: seat.name,
          turn: seat.turns,
          wake_id: wake?.wake_id ?? null,
          fired: wake?.fired ?? ["goal"],
          from: wake?.from ?? null,
          through: wake?.through ?? null,
          messages: wake?.messages.length ?? 0,
          started_at: startedAt,
          ended_at: dependencies.now().toISOString(),
          exit_code: result.code,
          failed,
          session_id: seat.session_id,
          tokens: spent,
          cut_by_end: cut,
        })}\n`,
      );
      return failed;
    };

    // One policy for every seat: woken by anything another member says, merged over 2 s, until the Room closes.
    const seatLoop = async (seat: SeatRecord) => {
      let prompt = openingPrompt({ seat, seats: plan.agents, roomId: input.roomId, goal: input.goal, goalSequence: input.goalSequence, until: input.until });
      let wake: WakeShape | null = null;
      let failedInARow = 0;
      while (!ended) {
        const failed = await runTurn(seat, prompt, wake);
        if (wake?.wake_id) await exec(seat, ["sharednet", "ack", wake.wake_id, "--json"]);
        failedInARow = failed ? failedInARow + 1 : 0;
        if (ended) break;
        if (failedInARow >= FAILED_TURNS_LIMIT) {
          log(`goal: ${seat.name} failed ${FAILED_TURNS_LIMIT} turns in a row and takes no more; see agents/${seat.name}/\n`);
          break;
        }
        const waited = await exec(seat, ["sharednet", "wait", "--on", "message", "--on", "closed", "--settle", "2s", "--ack", "manual", "--json"]);
        if (ended || waited.code !== 0) break;
        try {
          wake = JSON.parse(waited.stdout) as WakeShape;
        } catch {
          break;
        }
        if (wake.fired.includes("closed")) break;
        prompt = wakePrompt(wake);
      }
    };
    const seats = records.map((seat) =>
      seatLoop(seat).catch((error: unknown) => {
        log(`goal: ${seat.name} stopped (${error instanceof Error ? error.message : "error"})\n`);
      }),
    );

    const watched = await goalWatch(
      client,
      memberToken,
      apiKey,
      { roomId: input.roomId, workspace: plan.workspace, out: input.out, checkEveryMs: input.checkEveryMs, quietChecks: input.quietChecks },
      {
        now: dependencies.now,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        stderr: log,
        // A check runs where the Agents work: in the container, in the shared workspace.
        check: async (command) => {
          const result = await exec(null, ["sh", "-c", command]);
          return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
        },
        spend,
      },
    );
    ended = true;
    // Stopping the container ends every turn and every wait still running.
    await docker(["stop", "--time", "5", container]);
    await Promise.all(seats);

    // Each Agent's own trace is its home: Codex keeps sessions in ~/.codex, Claude Code in ~/.claude.
    for (const seat of records) {
      const target = join(input.out, "agents", seat.name, "home");
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      const copied = await docker(["cp", `${container}:${CONTAINER_HOMES}/${seat.name}`, target]);
      if (copied.code !== 0) log(`goal: ${seat.name}'s home could not be copied out: ${copied.stderr.trim()}\n`);
      await scrubHome(target);
      // The record's numbers come from the session's own file when there is one: it saw every turn, a cut one included.
      if (seat.driver === "codex" && seat.session_id) {
        const usage = await sessionFileUsage(join(target, ".codex", "sessions"), seat.session_id);
        if (usage) account(seat, usage, true);
      }
    }
    const episodePath = join(input.out, "episode.json");
    const episode = JSON.parse(await readFile(episodePath, "utf8")) as Record<string, unknown>;
    await writeFile(
      episodePath,
      `${JSON.stringify(
        {
          ...episode,
          image: plan.image,
          agents: records,
          totals: { ...(episode.totals as object), tokens: spend(), cached_tokens: records.reduce((sum, seat) => sum + seat.usage.cached, 0) },
        },
        null,
        2,
      )}\n`,
    );
    return { ...watched, agents: records, tokens: spend() };
  } finally {
    ended = true;
    await docker(["rm", "--force", container]);
  }
}

/** The usage in a Codex home's session file for one session, read after the run. */
async function sessionFileUsage(sessions: string, sessionId: string): Promise<Usage | null> {
  const files = await readdir(sessions, { recursive: true }).catch(() => [] as string[]);
  const file = files.find((name) => name.endsWith(`${sessionId}.jsonl`));
  return file ? codexSessionUsage(await readFile(join(sessions, file), "utf8")) : null;
}

/** A record is made to be handed on: the seat's token and the harness's sign-in leave it. */
export async function scrubHome(home: string): Promise<void> {
  for (const secret of [".config/sharednet", ".codex/auth.json", ".claude/.credentials.json"]) {
    await rm(join(home, secret), { recursive: true, force: true });
  }
}
