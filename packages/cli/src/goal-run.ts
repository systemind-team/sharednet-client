import { compiledPrompt, COMPILED_HELP, type CompiledState } from "./compiled.ts";
import { controlPaths, isTaskMessage, type Task } from "./board-controls.ts";
import { DEFAULT_MODULES, describeModules, seatEnvironment, type HarnessModules } from "./modules/index.ts";
import { PROBE_HELP, probeMessage } from "./modules/information.ts";
import { SBAR_HELP, renderRequests, requestsFor } from "./modules/protocol.ts";
import { ACTIVITY_HELP, TASK_JUDGE_HELP, renderActivity } from "./modules/state.ts";
import { reachable, topologyHelp } from "./modules/topology.ts";
import { TASK_HELP, MENTION_HELP, TASK_PROFILE, TASK_HOOK, TASK_HOOK_SETTINGS } from "./task-guard.ts";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import type { ApiClient } from "./api-client.ts";
import { CliError, localError } from "./errors.ts";
import { goalWatch, type GoalWatchResult } from "./goal.ts";
import { earlierRoomFile, earlierRoomMarkdown, newcomerNote, planMembers, planResume, resumePrompt, roomControls, usageSince, type FreshReason, type MemberTakeUp, type ResumeSource } from "./goal-resume.ts";
import { assertGoalRunHarnessAgentCount, type GoalRunHarnessResolution } from "./harness-modes.ts";
import { mentions } from "./triggers.ts";

/**
 * `goal run`: the goal Room, the Agents that work on it, and the runner that
 * ends it, in one command. Each Agent runs in its own Docker container, its
 * sandbox: its own processes, its own home, its own seat. The containers share
 * one thing, the workspace, mounted at /workspace in each. The checks run in
 * one more container, which has the workspace and nothing an Agent installed.
 * The owner's account key never enters any of them.
 * Isolated (`--isolate`), the containers sit on an internal network whose one
 * way out is a gateway the runner starts: it reaches SharedNet and the drivers'
 * model APIs, and holds the model keys itself, so no Agent can reach anything
 * else or read a key.
 * Each Agent works in turns. The runner holds every seat's wait, starts a
 * turn when the seat is woken, and resumes the same harness session, so every
 * Agent is woken by one policy and the record says when and by what.
 */

export type Driver = "codex" | "claude-code" | "gemini";

export interface AgentSpec {
  /** The seat's name in the Room: the driver and a number, `codex-1`. */
  name: string;
  driver: Driver;
  model: string | null;
}

const DRIVERS: readonly Driver[] = ["codex", "claude-code", "gemini"];
const MAX_AGENTS = 128;
const GEMINI_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `--agent codex`, `--agent codex:gpt-6-luna`, `--agent claude-code:claude-sonnet-5-5`; repeat it for more seats. */
export function parseAgents(raws: readonly string[]): AgentSpec[] {
  if (raws.length === 0) {
    throw localError("invalid_arguments", "goal run needs at least one --agent: codex, claude-code or gemini, with :<model> to choose the model.");
  }
  if (raws.length > MAX_AGENTS) throw localError("invalid_arguments", `goal run starts at most ${MAX_AGENTS} Agents.`);
  const counts = new Map<Driver, number>();
  return raws.map((raw) => {
    const separator = raw.indexOf(":");
    const driver = (separator === -1 ? raw : raw.slice(0, separator)).trim() as Driver;
    const model = separator === -1 ? null : raw.slice(separator + 1).trim() || null;
    if (!DRIVERS.includes(driver)) throw localError("invalid_arguments", `--agent ${raw}: the driver is codex, claude-code or gemini.`);
    // A model name may carry a router's variant after a colon of its own, as in qwen/qwen3.8-27b:nitro.
    if (model !== null && !/^[A-Za-z0-9._/-][A-Za-z0-9._/:-]{0,99}$/.test(model)) throw localError("invalid_arguments", `--agent ${raw}: that is not a model name.`);
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

function git(args: readonly string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolveGit) => {
    execFile("git", [...args], { cwd, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolveGit({ code: error ? 1 : 0, stdout: String(stdout) });
    });
  });
}

/** Do not mistake a consuming application's repository for the installed CLI's source. */
async function repositoryIdentity(cwd: string): Promise<{ commit: string | null; dirty: boolean | null }> {
  const remote = await git(["config", "--get", "remote.origin.url"], cwd);
  if (remote.code !== 0 || !/(?:^|[/:])systemind-team\/sharednet-client(?:\.git)?$/.test(remote.stdout.trim())) {
    return { commit: null, dirty: null };
  }
  const head = await git(["rev-parse", "HEAD"], cwd);
  const commit = head.stdout.trim().toLowerCase();
  const status = await git(["status", "--porcelain", "--untracked-files=all"], cwd);
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit) || status.code !== 0) return { commit: null, dirty: null };
  const dirty = status.stdout.length > 0;
  return { commit: dirty ? null : commit, dirty };
}

/** Package metadata survives npm installation even when the source repository and its commit do not. */
async function packageIdentity(root: string, entry: string): Promise<{
  packageVersion: string | null;
  packageManifestSha256: string | null;
  entrySha256: string | null;
}> {
  let packageVersion: string | null = null;
  let packageManifestSha256: string | null = null;
  let entrySha256: string | null = null;
  try {
    const manifest = await readFile(join(root, "package.json"), "utf8");
    const parsed = JSON.parse(manifest) as { version?: unknown };
    packageVersion = typeof parsed.version === "string" && parsed.version.length > 0 ? parsed.version : null;
    packageManifestSha256 = sha256(manifest);
  } catch {}
  try {
    entrySha256 = sha256(await readFile(join(root, entry), "utf8"));
  } catch {}
  return { packageVersion, packageManifestSha256, entrySha256 };
}

async function codeTreeSha256(root: string, entry: string): Promise<string | null> {
  const normalizedEntry = entry.replaceAll("\\", "/");
  const roots = normalizedEntry.startsWith("src/") ? ["src"] : normalizedEntry.startsWith("bin/") ? ["bin", "dist"] : [normalizedEntry];
  const files: string[] = [];
  const collect = async (relativePath: string): Promise<void> => {
    const absolutePath = join(root, relativePath);
    try {
      const entries = await readdir(absolutePath, { withFileTypes: true });
      for (const child of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
        const childPath = `${relativePath.replaceAll("\\", "/")}/${child.name}`;
        if (child.isDirectory()) await collect(childPath);
        else if (child.isFile()) files.push(childPath);
      }
    } catch {
      if (existsSync(absolutePath)) files.push(relativePath.replaceAll("\\", "/"));
    }
  };
  for (const candidate of roots) await collect(candidate);
  const runtimeFiles = files.filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.js") && !file.endsWith(".map"));
  if (runtimeFiles.length === 0) return null;
  const digest = createHash("sha256");
  for (const file of runtimeFiles.sort()) {
    digest.update(file).update("\0").update(sha256(await readFile(join(root, file)))).update("\n");
  }
  return digest.digest("hex");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CodeProvenance {
  clientCommit: string | null;
  runnerCommit: string | null;
  sourceWorktreeDirty: boolean | null;
  packageVersion: string | null;
  packageManifestSha256: string | null;
  entrySha256: string | null;
  codeTreeSha256: string | null;
}

export async function discoverCodeProvenance(cli: { root: string; entry: string }): Promise<CodeProvenance> {
  const [repository, packageMetadata, codeTree] = await Promise.all([
    repositoryIdentity(cli.root),
    packageIdentity(cli.root, cli.entry),
    codeTreeSha256(cli.root, cli.entry),
  ]);
  return {
    clientCommit: repository.commit,
    runnerCommit: repository.commit,
    sourceWorktreeDirty: repository.dirty,
    ...packageMetadata,
    codeTreeSha256: codeTree,
  };
}

/** The image the Agents run in when no --image is given; built on first use. */
export const DEFAULT_IMAGE = "sharednet-goal-agents:1";
/** A separate cache tag ensures a cached pre-Gemini image cannot silently omit its binary. */
export const GEMINI_IMAGE = "sharednet-goal-agents:2";
export const AGENT_DOCKERFILE = `FROM node:22-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends python3-pytest ripgrep && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex @anthropic-ai/claude-code @google/gemini-cli@0.70.0 && npm cache clean --force
RUN mkdir -p /home/agents /workspace && chown node:node /home/agents /workspace
USER node
WORKDIR /workspace
`;

const AGENT_USER = "node";
const AGENT_USER_PATTERN = /^(?:[a-z_][a-z0-9_-]{0,31}|[0-9]{1,10}(?::[0-9]{1,10})?)$/;
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOMES = "/home/agents";
const CONTAINER_CLI = "/opt/sharednet";
const CONTAINER_CODEX_AUTH = "/run/codex/auth.json";
/** A turn that runs longer than this is stopped; the next wake starts the next one. */
const TURN_LIMIT_SECONDS = 1_200;
/** A seat whose harness fails this many turns in a row stops taking turns. */
const FAILED_TURNS_LIMIT = 3;

/** The gateway of an isolated run: the one container on its internal network that has a way out. */
export const GATEWAY_IMAGE = "nginx:1.27-alpine";
const GATEWAY_ALIAS = "gateway";
const GATEWAY_PORTS = { sharednet: 8081, openai: 8080, anthropic: 8082 } as const;
/** Where the gateway's image keeps the certificate authorities it checks a model API's certificate against. */
const GATEWAY_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

/**
 * What an isolated Agent holds where its harness wants a key. It is made for one run and is a key
 * nowhere else: the gateway signs a request with the real key only when the request carries this
 * run's placeholder, so nothing outside the run's own containers can borrow the key.
 */
export type KeyPlaceholders = Record<"OPENAI_API_KEY" | "ANTHROPIC_API_KEY" | "CLAUDE_CODE_OAUTH_TOKEN", string>;

export function keyPlaceholders(secret: string = randomBytes(24).toString("hex")): KeyPlaceholders {
  // The placeholders are written into the gateway's configuration: hexadecimal only.
  if (!/^[0-9a-f]{32,}$/.test(secret)) throw localError("invalid_local_state", "A run's key placeholder is made of at least 32 hexadecimal digits.");
  return {
    OPENAI_API_KEY: `sk-isolated-${secret}`,
    ANTHROPIC_API_KEY: `sk-ant-api03-isolated-${secret}`,
    CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-isolated-${secret}`,
  };
}

/** The internal network and the gateway of an isolated run, named for its Room. */
export function isolationNames(roomId: string): { network: string; gateway: string } {
  return { network: `sharednet-goal-${roomId}-net`, gateway: `sharednet-goal-${roomId}-gateway` };
}

/**
 * One server block of the gateway: a port, the upstream it forwards to, and what it adds. A `guard`
 * refuses a request before it is signed. An upstream reached over TLS must show a certificate
 * that is valid for its name: a key is sent only to the API the run names.
 */
function gatewayServer(port: number, upstream: string, log: string, headers: string[], readTimeout: string, guard: string | null = null): string {
  const url = new URL(upstream);
  const verify = url.protocol === "https:" ? [
    "    proxy_ssl_verify on;",
    "    proxy_ssl_verify_depth 4;",
    `    proxy_ssl_trusted_certificate ${GATEWAY_CA_BUNDLE};`,
    `    proxy_ssl_name ${url.hostname};`,
  ] : [];
  return [
    "server {",
    `  listen ${port};`,
    `  access_log /var/log/nginx/${log}.log trace;`,
    "  client_max_body_size 64m;",
    "  location / {",
    ...(guard === null ? [] : [`    ${guard}`]),
    `    proxy_pass ${upstream};`,
    `    proxy_set_header Host ${url.host};`,
    ...headers.map((header) => `    ${header}`),
    "    proxy_set_header Upgrade $http_upgrade;",
    "    proxy_set_header Connection $connection_upgrade;",
    "    proxy_ssl_server_name on;",
    ...verify,
    "    proxy_http_version 1.1;",
    "    proxy_buffering off;",
    `    proxy_read_timeout ${readTimeout};`,
    "  }",
    "}",
  ].join("\n");
}

/**
 * The gateway's nginx configuration, as a template the nginx image fills from its environment when
 * it starts: the keys are written into it there, inside the gateway, and appear in no argument.
 * A model request is signed only when it carries this run's placeholder; any other caller gets 403.
 * Every request is logged with the address of the container it came from.
 */
export function gatewayTemplate(input: { sharednet: string; isolation: Isolation; codex: boolean; claudeAuth: RunPlan["claudeAuth"]; placeholders: KeyPlaceholders }): string {
  const blocks = [
    "log_format trace escape=json '{\"time\":\"$time_iso8601\",\"client\":\"$remote_addr\",\"method\":\"$request_method\",'",
    "  '\"uri\":\"$request_uri\",\"status\":$status,\"request_time\":$request_time,\"bytes_sent\":$body_bytes_sent}';",
    "map $http_upgrade $connection_upgrade { default upgrade; '' ''; }",
    gatewayServer(GATEWAY_PORTS.sharednet, input.sharednet, "sharednet", [], "120s"),
  ];
  if (input.codex) {
    const guard = `if ($http_authorization != "Bearer ${input.placeholders.OPENAI_API_KEY}") { return 403; }`;
    blocks.push(gatewayServer(GATEWAY_PORTS.openai, input.isolation.openai, "openai", ['proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";'], "900s", guard));
  }
  if (input.claudeAuth !== null) {
    const header = input.claudeAuth === "ANTHROPIC_API_KEY"
      ? 'proxy_set_header x-api-key "${ANTHROPIC_API_KEY}";'
      : 'proxy_set_header Authorization "Bearer ${CLAUDE_CODE_OAUTH_TOKEN}";';
    const guard = input.claudeAuth === "ANTHROPIC_API_KEY"
      ? `if ($http_x_api_key != "${input.placeholders.ANTHROPIC_API_KEY}") { return 403; }`
      : `if ($http_authorization != "Bearer ${input.placeholders.CLAUDE_CODE_OAUTH_TOKEN}") { return 403; }`;
    blocks.push(gatewayServer(GATEWAY_PORTS.anthropic, input.isolation.anthropic, "anthropic", [header], "900s", guard));
  }
  return `${blocks.join("\n")}\n`;
}

/** One container of a run: an Agent's, named for its seat, or with no seat, the checks'. */
export function containerName(roomId: string, seat?: string): string {
  return seat === undefined ? `sharednet-goal-${roomId}` : `sharednet-goal-${roomId}-${seat}`;
}

/** Every container one run starts, so that whatever stops the run can remove them all. */
export function runContainers(roomId: string, agents: readonly Pick<AgentSpec, "name">[]): string[] {
  return [...agents.map((agent) => containerName(roomId, agent.name)), containerName(roomId)];
}

/**
 * The port of a development service on this machine's loopback, the one plain-HTTP address the CLI
 * accepts. Inside a container that address is the container's own, so the runner forwards the
 * same port to this machine in each Agent's container; the Agents then use the address the runner uses.
 */
export function loopbackPort(baseUrl: string): number | null {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  return Number(url.port || 80);
}

const FORWARDER = `const net = require("node:net");
const port = Number(process.argv[1]);
const target = process.argv[2] || "host.docker.internal";
net.createServer((socket) => {
  const upstream = net.connect(port, target);
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}).listen(port, "127.0.0.1");`;
const FORWARDER_PROBE = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));`;

/** Where an isolated run's gateway sends each driver's model requests. */
export interface Isolation {
  openai: string;
  anthropic: string;
}

/**
 * Codex's model API: OpenAI's own, or what `--model-api` names with its path, such as
 * https://openrouter.ai/api/v1. Any other host is a provider of Codex's own, reached over HTTP.
 * Nothing in the environment chooses it: a run that does not name an API uses OpenAI's.
 */
export interface CodexApi {
  origin: string;
  path: string;
  custom: boolean;
}

/** OpenAI's API stays Codex's built-in provider; any other is one the run names for it. */
export function codexApi(value: string | undefined): CodexApi {
  if (!value?.trim()) return { origin: OPENAI_ORIGIN, path: "/v1", custom: false };
  const url = modelUrl(value);
  return { origin: url.origin, path: url.pathname.replace(/\/+$/, "") || "/v1", custom: url.origin !== OPENAI_ORIGIN };
}

export interface RunPlan {
  image: string;
  /** The user the Agents and the checks run as in the image: `node` in the default image. */
  agentUser?: string;
  /** Set, the run is isolated: an internal network, and a gateway that holds the model keys. */
  isolation?: Isolation | null;
  agents: AgentSpec[];
  workspace: string;
  /** This CLI's own package on this machine, mounted into each Agent's container so the Agents run the same version. */
  cli: { root: string; entry: string };
  /** How the Codex seats sign in: an API key from this environment, or this machine's Codex login. */
  codexAuth: { kind: "api-key" } | { kind: "login"; file: string } | null;
  /** Where the Codex seats' model API is; OpenAI's own when it is left out. */
  codexApi?: CodexApi;
  /** The variable that signs the Claude Code seats in, passed through by name. */
  claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | null;
  /** Gemini's headless API key, passed by name only to Gemini seats. */
  geminiAuth?: "GEMINI_API_KEY";
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
  input: { agents: AgentSpec[]; image: string | null; workspace: string; env: Record<string, string | undefined>; home: string; entry: string; agentUser?: string | null; isolate?: boolean; modelApi?: string | null },
  docker: DockerRunner,
  log: (line: string) => void,
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolvePause) => setTimeout(resolvePause, ms)),
): Promise<RunPlan> {
  const gemini = input.agents.some((agent) => agent.driver === "gemini");
  if (gemini && input.isolate) throw localError("invalid_arguments", "Gemini agents do not yet support --isolate; its gateway supports Codex and Claude Code.");
  if (gemini && !input.env.GEMINI_API_KEY?.trim()) throw localError("agent_auth_missing", "A gemini Agent signs in with GEMINI_API_KEY; set it before starting the run.");
  if ((await docker(["info", "--format", "{{.ServerVersion}}"])).code !== 0) {
    throw localError("docker_unavailable", "goal run starts the Agents in Docker containers; start Docker, then run it again.");
  }
  const agentUser = input.agentUser ?? AGENT_USER;
  if (!AGENT_USER_PATTERN.test(agentUser)) throw localError("invalid_arguments", `--agent-user ${agentUser}: that is not a user name or uid.`);
  const image = input.image ?? (gemini ? GEMINI_IMAGE : DEFAULT_IMAGE);
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
  if (gemini) {
    // A worker may pin an older custom image. Check its real binary without keys, a
    // network, or the image's entrypoint, and bound even a broken version command.
    const version = await docker(["run", "--rm", "--network", "none", "--entrypoint", "timeout", image, "15", "gemini", "--version"]);
    if (version.code !== 0 || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version.stdout.trim())) {
      throw localError("agent_runtime_missing", `The image ${image} needs a working Gemini CLI on PATH (gemini --version); rebuild the image with @google/gemini-cli@0.70.0 or use the default Gemini image.`);
    }
  }
  let codexAuth: RunPlan["codexAuth"] = null;
  const codex = codexApi(input.modelApi ?? undefined);
  if (input.agents.some((agent) => agent.driver === "codex")) {
    const login = join(input.home, ".codex", "auth.json");
    if (input.env.OPENAI_API_KEY) codexAuth = { kind: "api-key" };
    // A Codex login signs in to OpenAI alone.
    else if (codex.custom) throw localError("agent_auth_missing", `A codex Agent reaches ${codex.origin} with that API's key in OPENAI_API_KEY; set it.`);
    // The gateway signs an isolated seat's requests with a key; a login lives in the container that uses it.
    else if (input.isolate) throw localError("agent_auth_missing", "An isolated codex Agent reaches OpenAI through the run's gateway, which signs its requests with OPENAI_API_KEY; set it. A Codex login cannot be lent to the gateway.");
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
  let isolation: Isolation | null = null;
  if (input.isolate) {
    if ((await docker(["image", "inspect", GATEWAY_IMAGE])).code !== 0) {
      log(`goal: pulling the gateway's image ${GATEWAY_IMAGE}, once\n`);
      const pulled = await docker(["pull", GATEWAY_IMAGE]);
      if (pulled.code !== 0) throw localError("image_not_found", `The gateway's image ${GATEWAY_IMAGE} could not be pulled: ${pulled.stderr.trim().split("\n").slice(-1).join(" ")}`);
    }
    isolation = { openai: codex.origin, anthropic: ANTHROPIC_ORIGIN };
  }
  return { image, agentUser, isolation, agents: input.agents, workspace: input.workspace, cli: cliPackage(input.entry), codexAuth, claudeAuth, ...(gemini ? { geminiAuth: "GEMINI_API_KEY" as const } : {}), ...(codex.custom ? { codexApi: codex } : {}) };
}

const OPENAI_ORIGIN = "https://api.openai.com";
const ANTHROPIC_ORIGIN = "https://api.anthropic.com";

function modelUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw localError("invalid_arguments", `${value} is not a URL a gateway can forward to.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw localError("invalid_arguments", `${value} is not a URL a gateway can forward to.`);
  // The address is written into the gateway's configuration and into Codex's: a plain host and path, nothing else.
  if (url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+$/.test(url.hostname) || !/^[A-Za-z0-9/._~-]*$/.test(url.pathname)) {
    throw localError("invalid_arguments", `${value} is not a model API's base URL: give a plain host and path, such as https://openrouter.ai/api/v1.`);
  }
  return url;
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

export type MessageRouting = "broadcast" | "mentions" | "mentions-only";
/**
 * Routing chooses wake recipients, not board visibility. A message that names no known seat
 * wakes everyone under `mentions` and nobody under `mentions-only`; `@all` wakes everyone in both.
 */
export function routeWake(wake: WakeShape, seat: { name: string }, seats: Array<{ name: string; member_id?: string | null }>, mode: MessageRouting): WakeShape {
  if (mode === "broadcast") return wake;
  return { ...wake, messages: wake.messages.filter(message => {
    if (mentions(message.content, { memberId: "", name: "all" })) return true;
    const recipients = seats.filter(other => mentions(message.content, { memberId: other.member_id ?? "", name: other.name }));
    return recipients.length === 0 ? mode === "mentions" : recipients.some(other => other.name === seat.name);
  }) };
}

/** Task claims and completions are state, not news: a wake drops them, and `task list` shows them. */
export function withoutTaskActs(wake: WakeShape): WakeShape {
  return { ...wake, messages: wake.messages.filter(message => !isTaskMessage(message.content)) };
}

export type TurnPolicy = "legacy" | "cooperative-v1";

const COOPERATIVE_TURNS = [
  "## Cooperative turns",
  "",
  "The team goal spans multiple turns. Responsibilities are negotiated dynamically in the Room; you do not have a permanently assigned role. Your current assignment is one bounded unit of work toward the team goal, not the entire goal.",
  "",
  "At the start of each turn, review the delivered messages and read the Room for relevant updates. Coordinate ownership before starting work that may overlap with a teammate's assignment.",
  "",
  "Complete one coherent unit: a plan update, implementation increment, review of a published change, or test batch.",
  "",
  "After that unit, use sharednet say to publish actionable results: what changed, relevant files or test evidence, and any dependencies or requests. Then finish your response and end your turn.",
  "",
  "If blocked on a teammate, post the specific request, mentioning the responsible teammate when known, and end your turn immediately. Do not wait, sleep, poll, or repeatedly check for their response. Do not run sharednet wait or sharednet watch yourself.",
  "",
  "Ending a turn is a handoff, not a declaration of team completion. Only post DONE or another configured completion claim when the existing team-completion requirements are met. Do not post repeated \"nothing changed\" messages.",
].join("\n");

const COOPERATIVE_REMINDER = "Continue under the cooperative-turn policy: complete one bounded work unit, publish actionable results with sharednet say, then finish your response and end your turn. If blocked, request what you need and yield; do not poll or wait. A handoff is not DONE.";

/** What one Agent is told first: who it is, the goal, how the Room ends, and how to speak. */
export function openingPrompt(input: { seat: AgentSpec; seats: Array<AgentSpec & { member_id?: string | null }>; roomType?: "board" | "compiled"; roomId: string; goal: string; goalSequence: number; until: string[]; mentionGate?: boolean; taskGate?: boolean; messageRouting?: MessageRouting; turnPolicy?: TurnPolicy; modules?: HarnessModules }): string {
  const others = input.seats.filter((seat) => seat.name !== input.seat.name).map((seat) => input.roomType === "compiled" ? `${seat.name} (${seat.member_id ?? "not seated"})` : seat.name);
  const single = input.seats.length === 1;
  const claims = input.until.filter((trigger) => trigger.startsWith("said ")).map((trigger) => `"${trigger.slice(5)}"`);
  return [
    single
      ? `You are ${input.seat.name}, the only agent working on one goal in SharedNet Room ${input.roomId}.`
      : `You are ${input.seat.name}, one of ${input.seats.length} agents working on one goal in SharedNet Room ${input.roomId}. The others: ${others.join(", ")}.`,
    "",
    `The goal (message #${input.goalSequence}):`,
    "<goal>",
    input.goal.trim(),
    "</goal>",
    "",
    `The Room ends when the first of these happens: ${input.until.join("; ")}.`,
    ...(claims.length > 0 ? [`Say ${claims.join(" or ")} in the Room only when you believe the goal is met: saying it runs the check.`] : []),
    "",
    single
      ? `You work in this directory (${CONTAINER_WORKSPACE}) in your own container. Use the SharedNet Room to record concise progress and the final completion claim:`
      : `You share this directory (${CONTAINER_WORKSPACE}) with the others, and only this one: each of you works in its own container, so what you install elsewhere is yours alone. Talk to them only through the Room, with the sharednet command:`,
    "  sharednet read --last 30 --json    what has been said",
    '  sharednet say "…" --json          say something; keep it short',
    ...(input.roomType === "compiled" ? [COMPILED_HELP] : []),
    ...roomRules(input),
  ].join("\n");
}

/**
 * How a Room works, as the end of every opening states it: who a message wakes, how to take
 * turns, the gates and the modules. A seat taken up again from an earlier run is told these only
 * when they are not that run's (`--resume-from`).
 */
export function roomRules(input: { seat: AgentSpec; seats: readonly AgentSpec[]; mentionGate?: boolean; taskGate?: boolean; messageRouting?: MessageRouting; turnPolicy?: TurnPolicy; modules?: HarnessModules }): string[] {
  const modules = input.modules ?? DEFAULT_MODULES;
  const single = input.seats.length === 1;
  return [
    ...(input.messageRouting === "mentions" ? [
      "Messages mentioning known teammates wake only those teammates. No mention, @all, or unknown-only names broadcast. Explicit board reads still show all messages. Use exact teammate names from the roster.",
      "Do not run `sharednet wait` or `sharednet watch`: end your turn when waiting; the runner supplies messages routed to you.",
    ] : input.messageRouting === "mentions-only" ? [
      "A message wakes only the teammates it names with @name, using the exact names from the roster; @all wakes everyone. A message that names nobody wakes nobody: it stays on the board for whoever reads it. When someone else must act on what you say, name them, or nobody will.",
      "Do not run `sharednet wait` or `sharednet watch`: end your turn when waiting; the runner supplies messages addressed to you.",
    ] : ["Do not run `sharednet wait` or `sharednet watch`: when your turn ends, you are woken with whatever is said next."]),
    "Lines from `runner` are the goal's machinery, such as a check's result, not a person.",
    single
      ? "Work through the goal and end your turn when there is nothing more to do now."
      : input.turnPolicy === "cooperative-v1"
        ? COOPERATIVE_TURNS
        : "Agree in the Room who does what, do your part, and end your turn when there is nothing more to do now.",
    ...(input.mentionGate ? [MENTION_HELP] : []),
    ...(input.taskGate ? [TASK_HELP] : []),
    ...moduleHelp(input.seat.name, input.seats.map((seat) => seat.name), modules),
  ];
}

/** What the module slots add to a seat's first prompt; nothing when every slot is at its default. */
export function moduleHelp(seat: string, names: readonly string[], modules: HarnessModules): string[] {
  return [
    ...(modules.taskJudge !== "off" ? [TASK_JUDGE_HELP] : []),
    ...(modules.activityView ? [ACTIVITY_HELP] : []),
    ...topologyHelp(seat, names, modules.topology),
    ...(modules.messageSchema === "sbar" ? [SBAR_HELP] : []),
    ...(modules.probe ? [PROBE_HELP] : []),
  ];
}

/** What a woken Agent is told: everything said since its last turn. */
export function wakePrompt(wake: WakeShape, turnPolicy: TurnPolicy = "legacy"): string {
  const lines = wake.messages.map((message) => `#${message.sequence} ${message.sender?.name ?? message.sender?.member_id ?? "someone"}: ${message.content}`);
  return [`New in the Room since your last turn (#${wake.from + 1} to #${wake.through}):`, ...lines, "", turnPolicy === "cooperative-v1" ? COOPERATIVE_REMINDER : "Carry on with the goal."].join("\n");
}

/**
 * Claude Code tools the seats may not use, from a comma-separated list of tool names
 * (`ScheduleWakeup,CronCreate`). A seat that calls ScheduleWakeup waits inside its own turn, and
 * the runner does not wake a seat that is in a turn, so what is said to it waits too.
 */
export function parseDisallowedTools(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  if (names.length === 0 || names.some((name) => !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))) {
    throw localError("invalid_arguments", "--disallow-tools is a comma-separated list of Claude Code tool names, such as ScheduleWakeup,CronCreate.");
  }
  return [...new Set(names)];
}

/** One turn: a fresh harness run, or the same session resumed, with nothing asked of a person. */
/** Whether the Agents may search the web: on by default, off for a benchmark that forbids it. */
export type WebSearch = "live" | "off";

/** The address a Codex turn calls its model at, and whether that is a provider other than OpenAI. */
export interface CodexBase {
  url: string;
  custom: boolean;
}

/** How hard a Codex seat's model reasons on each call: Codex passes it to the model API as `reasoning.effort`. */
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/**
 * What a run tells Codex about its seats' model, each passed to Codex as it is. Codex knows these for
 * OpenAI's models; for another provider's it does not, and without a context window it never
 * compacts a long history, so a turn ends once the history outgrows what the API accepts.
 */
export interface CodexModel {
  reasoningEffort?: ReasoningEffort;
  /** The model's context window in tokens: Codex's `model_context_window`. */
  contextWindow?: number;
  /** Compact the history once it reaches this many tokens: Codex's `model_auto_compact_token_limit`. */
  compactAt?: number;
}

/** The provider Codex is given for a model API other than OpenAI's: Responses over HTTP, keyed from OPENAI_API_KEY. */
const CODEX_PROVIDER = "goal_api";

/** Run-specific settings have system precedence without overwriting the harness's own settings. */
export function geminiSetupCommand(webSearch: WebSearch): string[] {
  const settings = { security: { auth: { selectedType: "gemini-api-key" } }, tools: { exclude: webSearch === "off" ? ["google_web_search", "web_fetch"] : [] } };
  const program = "const fs=require('node:fs');const folder=process.env.HOME+'/.gemini';fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(folder+'/sharednet-settings.json',process.argv[1]);";
  return ["node", "-e", program, JSON.stringify(settings)];
}

export function turnCommand(seat: AgentSpec, prompt: string, sessionId: string | null, webSearch: WebSearch = "live", turnLimitSeconds = TURN_LIMIT_SECONDS, codexBase: CodexBase | null = null, model: CodexModel = {}, disallowedTools: readonly string[] = []): string[] {
  const limit = ["timeout", String(turnLimitSeconds)];
  if (seat.driver === "gemini") {
    if (sessionId !== null && !GEMINI_SESSION.test(sessionId)) throw localError("invalid_local_state", "A Gemini session must be an explicit UUID; latest and numeric session selectors are not accepted.");
    return [...limit, "gemini", "--approval-mode", "yolo", "--output-format", "stream-json", ...(seat.model ? ["--model", seat.model] : []), ...(sessionId === null ? [] : ["--resume", sessionId]), "--prompt", prompt];
  }
  if (seat.driver === "codex") {
    // Live web search, which Claude Code has by default: a goal is as often research as code.
    const search = webSearch === "live" ? 'web_search="live"' : 'web_search="disabled"';
    // Codex takes its API's address from its config, not from OPENAI_BASE_URL. OpenAI's built-in provider
    // cannot be redefined, and talks to OpenAI over a WebSocket another API may not offer.
    const provider = `model_providers.${CODEX_PROVIDER}`;
    const base = codexBase === null ? [] : codexBase.custom ? [
      "-c", `model_provider="${CODEX_PROVIDER}"`,
      "-c", `${provider}.name="${CODEX_PROVIDER}"`,
      "-c", `${provider}.base_url="${codexBase.url}"`,
      "-c", `${provider}.env_key="OPENAI_API_KEY"`,
      "-c", `${provider}.wire_api="responses"`,
      "-c", `${provider}.supports_websockets=false`,
    ] : ["-c", `openai_base_url="${codexBase.url}"`];
    // Left unset, a model reasons as its API's default has it, which for some is as long as it may.
    const tuning = [
      ...(model.reasoningEffort === undefined ? [] : ["-c", `model_reasoning_effort="${model.reasoningEffort}"`]),
      ...(model.contextWindow === undefined ? [] : ["-c", `model_context_window=${model.contextWindow}`]),
      ...(model.compactAt === undefined ? [] : ["-c", `model_auto_compact_token_limit=${model.compactAt}`]),
    ];
    const flags = ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", search, ...base, ...tuning, ...(seat.model ? ["-m", seat.model] : [])];
    return sessionId === null ? [...limit, "codex", "exec", ...flags, prompt] : [...limit, "codex", "exec", "resume", ...flags, sessionId, prompt];
  }
  return [
    ...limit,
    "claude",
    "-p",
    // A list option takes every argument up to the next flag, so it stands before the other flags.
    ...(webSearch === "off" || disallowedTools.length > 0 ? ["--disallowedTools", ...(webSearch === "off" ? ["WebSearch", "WebFetch"] : []), ...disallowedTools] : []),
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
  /**
   * Whether the harness took a session up in this turn: Codex says `thread.started`, Claude Code
   * `system init`. A harness that is asked to resume a session it cannot find says neither.
   */
  started = false;
  completed = false;
  text = "";
  toolCalls = 0;
  private readonly driver: Driver;
  private readonly expectedSession: string | null;
  private readonly pendingTools = new Set<string>();
  private readonly seenTools = new Set<string>();

  constructor(driver: Driver, expectedSession: string | null = null) {
    this.driver = driver;
    this.expectedSession = expectedSession;
  }

  /** A zero exit without a session and final success is not a completed Gemini turn. */
  finish(): void {
    if (this.driver === "gemini" && (!this.started || !this.completed)) this.reading.failed = true;
  }

  line(text: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(text) as Record<string, unknown>;
    } catch {
      if (this.driver === "gemini") this.reading.failed = true;
      return;
    }
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      if (this.driver === "gemini") this.reading.failed = true;
      return;
    }
    if (this.driver === "gemini") {
      if (this.completed) { this.reading.failed = true; this.completed = false; return; }
      if (event.type === "init") {
        const id = event.session_id;
        if (this.started || typeof id !== "string" || !GEMINI_SESSION.test(id) || (this.expectedSession !== null && id !== this.expectedSession)) this.reading.failed = true;
        else { this.started = true; this.reading.sessionId = id; }
      } else if (event.type === "message") {
        if (!this.started || (event.role !== "assistant" && event.role !== "user") || typeof event.content !== "string") this.reading.failed = true;
        else if (event.role === "assistant") this.text += event.content;
      } else if (event.type === "tool_use") {
        if (!this.started || typeof event.tool_name !== "string" || !event.tool_name || typeof event.tool_id !== "string" || !event.tool_id || this.seenTools.has(event.tool_id) || event.parameters === null || typeof event.parameters !== "object" || Array.isArray(event.parameters)) this.reading.failed = true;
        else { this.toolCalls += 1; this.seenTools.add(event.tool_id); this.pendingTools.add(event.tool_id); }
      } else if (event.type === "tool_result") {
        if (!this.started || typeof event.tool_id !== "string" || !this.pendingTools.delete(event.tool_id) || (event.status !== "success" && event.status !== "error")) this.reading.failed = true;
      } else if (event.type === "error") {
        if (event.severity !== "warning" || typeof event.message !== "string") this.reading.failed = true;
      } else if (event.type === "result") {
        const stats = event.stats;
        if (stats && typeof stats === "object" && !Array.isArray(stats)) {
          const usage = stats as Record<string, unknown>;
          const keys = ["input", "cached", "output_tokens"] as const;
          if (keys.every(key => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && usage[key] >= 0)) {
            this.reading.usage = { input: usage.input as number, cached: usage.cached as number, output: usage.output_tokens as number };
          }
        }
        this.completed = !this.reading.failed && this.started && this.pendingTools.size === 0 && event.status === "success" && event.error === undefined && this.reading.usage !== null;
        if (!this.completed) this.reading.failed = true;
      } else this.reading.failed = true;
      return;
    }
    const usage = (event.usage ?? null) as Record<string, unknown> | null;
    if (this.driver === "codex") {
      if (event.type === "thread.started" && typeof event.thread_id === "string") this.reading.sessionId = event.thread_id;
      if (event.type === "thread.started") this.started = true;
      if (event.type === "turn.completed" && usage) this.reading.usage = codexUsage(usage);
      if (event.type === "turn.failed" || event.type === "error") this.reading.failed = true;
      return;
    }
    if (typeof event.session_id === "string") this.reading.sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init") this.started = true;
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
  roomType?: "board" | "compiled";
  inviteToken: string;
  goal: string;
  goalSequence: number;
  until: string[];
  baseUrl: string;
  out: string;
  checkEveryMs: number;
  quietChecks: boolean;
  /** `off` takes web search away from every Agent; the default is `live`. */
  webSearch?: WebSearch;
  /** Claude Code tools the Claude Code seats may not use, such as ScheduleWakeup (a seat that waits inside its turn cannot be woken). */
  disallowedTools?: readonly string[];
  /** The longest one turn may run; the default is 20 minutes. An experiment may set it to the run's own limit. */
  turnLimitMs?: number;
  /** Opt-in board controls. Mention gates default to targeted wakes unless overridden. */
  mentionGate?: boolean;
  taskGate?: boolean;
  messageRouting?: MessageRouting;
  turnPolicy?: TurnPolicy;
  /** A canonical treatment selected by --harness-mode. Omission preserves legacy ad-hoc flags. */
  harnessMode?: GoalRunHarnessResolution;
  /** Tests and artifact builders may supply provenance; source runs discover repository and package identity. */
  codeProvenance?: CodeProvenance;
  /** What Codex is told about the Codex seats' model; Codex's own defaults when left out. */
  codexModel?: CodexModel;
  /** The module slots (modules/index.ts); left out, every slot keeps today's behaviour. */
  modules?: HarnessModules;
  /**
   * `--resume-from`: the earlier run whose seats this run takes up again (goal-resume.ts). Left
   * out, every seat starts a fresh session with the whole opening, as it always has.
   * `earlierRooms` names a file in the workspace that already holds what was said earlier; null,
   * goal run writes the earlier Room's messages into the workspace itself.
   */
  resume?: { source: ResumeSource; earlierRooms: string | null };
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
  /** Only for a run with `--resume-from`: which seats were taken up again, and why the others were not. */
  resume?: ResumeRecord;
}

/** What a resumed run's record says of each seat: its earlier session taken up, or a fresh one and why. */
export interface ResumeRecord {
  from: string;
  room_id: string | null;
  /** The file in the workspace that holds what was said earlier. */
  earlier_rooms: string | null;
  seats: Record<string, { resumed: true; session_id: string; baseline: Usage; prompt_sha256: string } | { resumed: false; reason: FreshReason }>;
  /**
   * Only for a run in the earlier run's own Room (`--room`): for each seat the record names a member
   * for, whether it took that member up or joined as a new one, and why.
   */
  members?: Record<string, MemberTakeUp>;
}

/** Creates nothing outside its containers and the record; the Room and its goal already exist. */
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
  const checks = containerName(input.roomId);
  const containers = runContainers(input.roomId, plan.agents);
  const turnLimitSeconds = Math.round((input.turnLimitMs ?? TURN_LIMIT_SECONDS * 1000) / 1000);
  const base = input.baseUrl;
  const user = plan.agentUser ?? AGENT_USER;
  const isolation = plan.isolation ?? null;
  const isolated = isolation !== null;
  const names = isolationNames(input.roomId);
  const placeholders = keyPlaceholders();
  // An isolated Agent reaches SharedNet only through the gateway, which its container forwards to
  // its own loopback: the one plain-HTTP address the CLI accepts.
  const seatBase = isolated ? `http://127.0.0.1:${GATEWAY_PORTS.sharednet}` : base;
  const addresses: Record<string, string> = {};
  const messageRouting = input.messageRouting ?? (input.mentionGate ? "mentions" : "broadcast");
  const mentionGate = input.mentionGate ?? false;
  const taskGate = input.taskGate ?? false;
  const turnPolicy = input.turnPolicy ?? "legacy";
  if (turnPolicy !== "legacy" && turnPolicy !== "cooperative-v1") throw localError("invalid_arguments", "--turn-policy is legacy or cooperative-v1.");
  const modules = input.modules ?? DEFAULT_MODULES;
  // Who is in a turn now: the activity view reads it, so it is the runner's record, not a seat's word.
  const busy = new Set<string>();
  if (input.harnessMode && turnPolicy !== "legacy") throw localError("invalid_arguments", "--turn-policy cooperative-v1 cannot override a frozen --harness-mode.");
  if (turnPolicy === "cooperative-v1" && (plan.agents.length < 2 || input.roomType === "compiled")) throw localError("invalid_arguments", "--turn-policy cooperative-v1 requires a multi-agent board Room.");
  if (
    input.harnessMode
    && (input.roomType !== input.harnessMode.profile.room_type
      || mentionGate !== input.harnessMode.profile.mention_gate
      || taskGate !== input.harnessMode.profile.task_gate
      || messageRouting !== input.harnessMode.profile.message_routing)
  ) {
    throw localError("harness_mode_mismatch", `${input.harnessMode.name} does not match the resolved Room, gate, and routing controls.`);
  }
  if (input.harnessMode && plan.agents.some((agent) => agent.model === null)) {
    throw localError("harness_model_required", "A frozen --harness-mode requires every Agent to pin its model.");
  }
  if (input.harnessMode) assertGoalRunHarnessAgentCount(input.harnessMode, plan.agents.length);
  if (input.roomType === "compiled" && (input.mentionGate || input.taskGate || messageRouting !== "broadcast")) throw localError("invalid_arguments", "The mention/task controls are for plain board Rooms.");
  const codeProvenance = input.codeProvenance ?? await discoverCodeProvenance(plan.cli);
  if (input.harnessMode && codeProvenance.sourceWorktreeDirty) {
    throw localError("dirty_harness_source", "A frozen --harness-mode cannot run from a dirty sharednet-client checkout; commit or stash the CLI changes first.");
  }
  const openingPromptHashes: Record<string, string> = {};
  await mkdir(input.out, { recursive: true });
  const wakeLog = join(input.out, "wakes.ndjson");
  await writeFile(wakeLog, "");

  // `--resume-from`: which seats are taken up again, and where what was said earlier can be read.
  // Without it, `resume` is null and nothing below this point is different from a run before the option.
  const resume = input.resume ? await planResume(input.resume.source, plan.agents, codexSessionUsage) : null;
  const resumeRecord: ResumeRecord | null = input.resume && resume
    ? { from: input.resume.source.record, room_id: input.resume.source.roomId, earlier_rooms: input.resume.earlierRooms, seats: Object.fromEntries([...resume.fresh].map(([name, reason]) => [name, { resumed: false as const, reason }])) }
    : null;
  if (input.resume && resumeRecord && input.resume.earlierRooms === null) {
    // The earlier Room has ended and these seats hold new seats in a new one: what was said there is kept as a file to search.
    const file = earlierRoomFile(input.resume.source.roomId);
    try {
      const said = earlierRoomMarkdown(input.resume.source.roomId, await readFile(join(input.resume.source.record, "room.ndjson"), "utf8"));
      await mkdir(join(plan.workspace, dirname(file)), { recursive: true });
      await writeFile(join(plan.workspace, file), said);
      // The Agents' user is the image's, not this machine's: readable whatever this process's umask is.
      await chmod(join(plan.workspace, dirname(file)), 0o755);
      await chmod(join(plan.workspace, file), 0o644);
      resumeRecord.earlier_rooms = file;
    } catch {
      log(`goal: what was said in the earlier Room could not be written to ${file}; the resumed seats still have their own memory of it\n`);
    }
  }
  // In the earlier run's own Room, each seat of the same name and harness takes up the member it was
  // there, so the Room keeps one member per agent. Without `--room` this is empty and nothing changes.
  const earlierMembers = input.resume ? planMembers(input.resume.source, plan.agents, input.roomId) : new Map<string, string>();
  if (resumeRecord && input.resume?.source.roomId === input.roomId) resumeRecord.members = {};
  /** A seat that was to take up its earlier member joins as a new one after all; the record says why. */
  const joinsNew = (name: string, memberId: string, reason: string) => {
    earlierMembers.delete(name);
    if (resumeRecord?.members) resumeRecord.members[name] = { taken_up: false, member_id: memberId, reason };
    log(`goal: ${name} joins as a new member; its earlier member ${memberId} was not taken up (${reason})\n`);
  };
  /** A seat that was to be taken up again starts fresh after all; the record says why. */
  const startFresh = (seat: SeatRecord, reason: FreshReason) => {
    resume?.seats.delete(seat.name);
    if (resumeRecord) resumeRecord.seats[seat.name] = { resumed: false, reason };
    log(`goal: ${seat.name} starts a fresh session (${reason}); its earlier session was not resumed\n`);
  };

  /** An Agent's container: the shared workspace, this CLI, and a Codex seat's login; idle until a turn runs in it. */
  const startContainer = (seat: SeatRecord) => docker([
    "run",
    "--detach",
    "--name",
    containerName(input.roomId, seat.name),
    ...(isolated ? ["--network", names.network] : ["--add-host", "host.docker.internal:host-gateway"]),
    "--volume",
    `${plan.workspace}:${CONTAINER_WORKSPACE}`,
    "--volume",
    `${plan.cli.root}:${CONTAINER_CLI}:ro`,
    ...(seat.driver === "codex" && plan.codexAuth?.kind === "login" ? ["--volume", `${plan.codexAuth.file}:${CONTAINER_CODEX_AUTH}:ro`] : []),
    plan.image,
    "sleep",
    "infinity",
  ]);
  /** The checks' container: the image and the shared workspace, and nothing an Agent installed or holds. */
  const startChecks = () => docker(["run", "--detach", "--name", checks, ...(isolated ? ["--network", names.network] : []), "--volume", `${plan.workspace}:${CONTAINER_WORKSPACE}`, plan.image, "sleep", "infinity"]);
  /** An isolated run's internal network and its gateway, the network's one way out; up before any Agent starts. */
  const startGateway = async () => {
    const created = await docker(["network", "create", "--internal", names.network]);
    if (created.code !== 0) throw localError("container_failed", `The run's internal network could not be made: ${created.stderr.trim()}`);
    const loopback = loopbackPort(base);
    const template = gatewayTemplate({
      sharednet: loopback === null ? base : `http://host.docker.internal:${loopback}`,
      isolation: isolation!,
      codex: plan.codexAuth !== null,
      claudeAuth: plan.claudeAuth,
      placeholders,
    });
    const keys = [...(plan.codexAuth !== null ? ["OPENAI_API_KEY"] : []), ...(plan.claudeAuth !== null ? [plan.claudeAuth] : [])];
    const started = await docker(
      [
        "run",
        "--detach",
        "--name",
        names.gateway,
        ...(loopback === null ? [] : ["--add-host", "host.docker.internal:host-gateway"]),
        "-e",
        "GATEWAY_TEMPLATE",
        ...keys.flatMap((key) => ["-e", key]),
        GATEWAY_IMAGE,
        "sh",
        "-c",
        'mkdir -p /etc/nginx/templates && printf "%s" "$GATEWAY_TEMPLATE" > /etc/nginx/templates/default.conf.template && exec /docker-entrypoint.sh nginx -g "daemon off;"',
      ],
      { env: { GATEWAY_TEMPLATE: template } },
    );
    if (started.code !== 0) throw localError("container_failed", `The run's gateway did not start: ${started.stderr.trim()}`);
    const joined = await docker(["network", "connect", "--alias", GATEWAY_ALIAS, names.network, names.gateway]);
    if (joined.code !== 0) throw localError("container_failed", `The gateway could not join the run's network: ${joined.stderr.trim()}`);
    // Listening once nginx has written its configuration from the template.
    const port = GATEWAY_PORTS.sharednet.toString(16).toUpperCase().padStart(4, "0");
    let listening = false;
    for (let attempt = 0; attempt < 40 && !listening; attempt += 1) {
      listening = (await docker(["exec", names.gateway, "sh", "-c", `grep -q ":${port} " /proc/net/tcp`])).code === 0;
      if (!listening) await sleep(250);
    }
    if (!listening) throw localError("container_failed", "The run's gateway did not start listening.");
  };

  let ended = false;
  // Large teams keep their independent homes and waits, while only eight paid harness
  // processes run at once. The historical <=50-seat scheduling stays unchanged.
  const maxActiveTurns = plan.agents.length > 50 ? 8 : null;
  let activeTurns = 0;
  const pendingTurns: Array<(start: boolean) => void> = [];
  const cancelPendingTurns = () => { for (const resolve of pendingTurns.splice(0)) resolve(false); };
  const acquireTurn = (): Promise<boolean> => {
    if (ended) return Promise.resolve(false);
    if (activeTurns < (maxActiveTurns ?? plan.agents.length)) { activeTurns += 1; return Promise.resolve(true); }
    return new Promise(resolve => pendingTurns.push(resolve));
  };
  const releaseTurn = () => {
    activeTurns -= 1;
    if (ended) { cancelPendingTurns(); return; }
    const next = pendingTurns.shift();
    if (next) { activeTurns += 1; next(true); }
  };
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
    // A session taken up from an earlier run had a total before this run began: only what comes after it is this run's.
    const earlier = resume?.seats.get(seat.name)?.baseline;
    seat.usage = sessionTotal
      ? earlier ? usageSince(usage, earlier) : usage
      : { input: seat.usage.input + usage.input, cached: seat.usage.cached + usage.cached, output: seat.usage.output + usage.output };
    seat.tokens = freshTokens(seat.usage);
    return seat.tokens - before;
  };
  const spend = () => records.reduce((sum, record) => sum + record.tokens, 0);
  const exec = (seat: SeatRecord | null, command: readonly string[], options: { env?: Record<string, string>; onLine?: (line: string) => void; through?: number } = {}) => {
    const home = seat ? `${CONTAINER_HOMES}/${seat.name}` : null;
    const controls = seat?.member_id && home ? controlPaths({ HOME: home }, { base_url: seatBase, room_id: input.roomId, member_id: seat.member_id }) : null;
    const environment = [
      ...(home ? ["-e", `HOME=${home}`] : []),
      ...(home && seat?.driver === "codex" ? ["-e", `CODEX_HOME=${home}/.codex`] : []),
      ...(seat?.driver === "gemini" ? ["-e", "GEMINI_API_KEY", "-e", "GEMINI_CLI_TRUST_WORKSPACE=true", "-e", `GEMINI_CLI_SYSTEM_SETTINGS_PATH=${home}/.gemini/sharednet-settings.json`] : []),
      "-e",
      `SHAREDNET_BASE_URL=${seatBase}`,
      ...(seat?.member_id ? ["-e", `SHAREDNET_SEAT=${seat.member_id}`] : []),
      // This runner wakes its seats itself. Whatever a seat runs, its join or an agent's own
      // `sharednet join rom_…` in a turn, starts no wake service of its own.
      ...(seat ? ["-e", "SHAREDNET_WAKE=off"] : []),
      ...(seat && input.mentionGate ? ["-e", "SHAREDNET_MENTION_GATE=1"] : []),
      ...(seat && options.through !== undefined ? ["-e", `SHAREDNET_TURN_THROUGH=${options.through}`] : []),
      ...(seat ? seatEnvironment(modules) : []),
      ...(controls && input.taskGate ? ["-e", "SHAREDNET_TASK_GATE=1", "-e", `SHAREDNET_TASK_FILE=${controls.tasks}`, "-e", `SHAREDNET_TASK_AUDIT=${join(controls.root, "shell-blocks.tsv")}`, "-e", "SHAREDNET_TASK_PROFILE=/etc/profile.d/sharednet-task.sh"] : []),
      // Isolated, a seat holds a placeholder where its harness wants a key, and its requests go to the gateway, which signs them.
      ...(seat?.driver === "claude-code" && plan.claudeAuth
        ? isolated
          ? ["-e", `${plan.claudeAuth}=${placeholders[plan.claudeAuth]}`, "-e", `ANTHROPIC_BASE_URL=http://${GATEWAY_ALIAS}:${GATEWAY_PORTS.anthropic}`]
          : ["-e", plan.claudeAuth]
        : []),
      ...(seat?.driver === "codex" && plan.codexAuth?.kind === "api-key"
        ? isolated
          ? ["-e", `OPENAI_API_KEY=${placeholders.OPENAI_API_KEY}`]
          : ["-e", "OPENAI_API_KEY"]
        : []),
      ...Object.keys(options.env ?? {}).flatMap((name) => ["-e", name]),
    ];
    return docker(["exec", "--user", user, "--workdir", CONTAINER_WORKSPACE, ...environment, seat ? containerName(input.roomId, seat.name) : checks, ...command], options);
  };

  /** The checks' container, then each Agent's container and seat; a start that fails closes the Room it opened. */
  const setUp = async () => {
    if (isolated) await startGateway();
    const checker = await startChecks();
    if (checker.code !== 0) throw localError("container_failed", `The checks' container did not start: ${checker.stderr.trim()}`);
    // Isolated, each container forwards its loopback to the gateway; otherwise only a development service is forwarded, to this machine.
    const port = isolated ? GATEWAY_PORTS.sharednet : loopbackPort(base);
    const forwardTo = isolated ? [GATEWAY_ALIAS] : [];
    // The Agents' `sharednet` is this CLI, so they speak the version that started them.
    const entry = `${CONTAINER_CLI}/${plan.cli.entry}`;
    const wrapper = `#!/bin/sh\nexec node ${entry.endsWith(".ts") ? "--experimental-strip-types --no-warnings " : ""}${entry} "$@"\n`;
    const memberOf = (result: DockerResult) => {
      try {
        return (JSON.parse(result.stdout) as { member_id?: string }).member_id ?? null;
      } catch {
        return null;
      }
    };
    // The earlier members as the Room lists them now: a seat takes up only its own, under its own name.
    if (earlierMembers.size > 0) {
      const listed = await client
        .request<{ memberships?: Array<{ member_id?: string; name?: string | null; state?: string }> }>("GET", `/rooms/${encodeURIComponent(input.roomId)}`, memberToken)
        .then((view) => view?.memberships ?? [], () => null);
      for (const [name, memberId] of [...earlierMembers]) {
        if (listed?.some((member) => member.member_id === memberId && member.name === name && (member.state ?? "active") === "active")) continue;
        joinsNew(name, memberId, listed === null ? "room_unreadable" : "not_in_room");
      }
    }
    /**
     * The seat's earlier member, taken up: the owner's key has the service hand that member a new
     * token (the old one stops working), and the seat's own CLI enters the Room as it, the token
     * passed by environment as an invite is. Null when that cannot be done: the seat then joins as new.
     */
    const takeUp = async (seat: SeatRecord, memberId: string, marker: Record<string, string>): Promise<DockerResult | null> => {
      let token: string | null = null;
      let reason = "invalid_server_response";
      try {
        const handed = await client.request<{ membership?: { member_id?: string }; member_token?: string }>(
          "POST",
          `/rooms/${encodeURIComponent(input.roomId)}/members/${encodeURIComponent(memberId)}/token`,
          apiKey,
        );
        if (handed?.membership?.member_id === memberId && typeof handed.member_token === "string") token = handed.member_token;
      } catch (error) {
        // An older service has no such route (`route_not_found`); a seat that is not the run's own is `member_not_reissuable`.
        reason = error instanceof CliError ? error.code : "error";
      }
      if (token !== null) {
        const entered = await exec(seat, ["sharednet", "join", input.roomId, "--name", seat.name, "--json"], { env: { ...marker, SHAREDNET_MEMBER_TOKEN: token } });
        if (entered.code === 0 && memberOf(entered) === memberId) {
          if (resumeRecord?.members) resumeRecord.members[seat.name] = { taken_up: true, member_id: memberId };
          log(`goal: ${seat.name} takes up its earlier member ${memberId}\n`);
          return entered;
        }
        reason = "join_failed";
      }
      joinsNew(seat.name, memberId, reason);
      return null;
    };

    // Every seat: its own container, its own home, its own sign-in, its own seat in the Room.
    for (const seat of records) {
      const container = containerName(input.roomId, seat.name);
      const started = await startContainer(seat);
      if (started.code !== 0) throw localError("container_failed", `${seat.name}'s container did not start: ${started.stderr.trim()}`);
      // An image other than the default one may have no home for the Agents: made here, as root, for the Agents' user.
      const homes = await docker(["exec", "--user", "root", container, "sh", "-c", `mkdir -p ${CONTAINER_HOMES} && chown ${user} ${CONTAINER_HOMES}`]);
      if (homes.code !== 0) throw localError("container_failed", `${seat.name}'s container has no place for homes: ${homes.stderr.trim()}`);
      if (isolated) {
        const address = await docker(["inspect", "--format", `{{(index .NetworkSettings.Networks "${names.network}").IPAddress}}`, container]);
        if (address.code === 0 && address.stdout.trim()) addresses[seat.name] = address.stdout.trim();
      }
      if (port !== null) {
        await docker(["exec", "--detach", "--user", user, container, "node", "-e", FORWARDER, String(port), ...forwardTo]);
        let listening = false;
        for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
          listening = (await docker(["exec", "--user", user, container, "node", "-e", FORWARDER_PROBE, String(port)])).code === 0;
          if (!listening) await sleep(250);
        }
        if (!listening) throw localError("container_failed", isolated ? `${seat.name}'s container could not reach the run's gateway.` : `${seat.name}'s container could not reach this machine's port ${port}.`);
      }
      const installed = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "cat > /usr/local/bin/sharednet && chmod 755 /usr/local/bin/sharednet"], { input: wrapper });
      if (installed.code !== 0) throw localError("container_failed", `The sharednet command could not be put in ${seat.name}'s container: ${installed.stderr.trim()}`);
      if (input.taskGate) {
        const guarded = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "mkdir -p /etc/profile.d && cat > /etc/profile.d/sharednet-task.sh && chmod 644 /etc/profile.d/sharednet-task.sh"], { input: TASK_PROFILE });
        if (guarded.code !== 0) throw localError("container_failed", "Could not install the task shell guard.");
        if (seat.driver === "claude-code") {
          const hook = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "mkdir -p /usr/local/lib && cat > /usr/local/lib/sharednet-task-hook.cjs && chmod 644 /usr/local/lib/sharednet-task-hook.cjs"], { input: TASK_HOOK });
          if (hook.code !== 0) throw localError("container_failed", "Could not install the Claude task hook.");
        }
      }
      const home = `${CONTAINER_HOMES}/${seat.name}`;
      const taken = resume?.seats.get(seat.name);
      if (taken) {
        // The seat's home as its earlier run left it: its sessions, its harness's settings, skills and MCP servers,
        // and what it installed for itself. The record took the sign-ins out; they are put back just below, as for a new seat.
        // Its contents (`/.`), so the home lands in place whether or not something has made the folder already.
        const restored = await docker(["cp", `${taken.home}/.`, `${container}:${home}`]);
        const owned = restored.code === 0 ? await docker(["exec", "--user", "root", container, "sh", "-c", `chown -R ${user} '${home}'`]) : restored;
        if (owned.code !== 0) {
          await docker(["exec", "--user", "root", container, "rm", "-rf", home]);
          startFresh(seat, "home_not_restored");
        }
      }
      const prepared = seat.driver === "gemini"
        ? await exec(seat, geminiSetupCommand(input.webSearch ?? "live"))
        : seat.driver === "codex" && plan.codexAuth?.kind === "login"
        ? await docker([
            "exec", "--user", "root", container, "sh", "-c",
            `mkdir -p '${home}/.codex' && cp ${CONTAINER_CODEX_AUTH} '${home}/.codex/auth.json' && chown -R ${user} '${home}' && chmod 600 '${home}/.codex/auth.json'`,
          ])
        : await exec(seat, [
            "sh", "-c",
            seat.driver === "codex"
              ? `mkdir -p ${home}/.codex && printf '{"OPENAI_API_KEY": "%s"}' "$OPENAI_API_KEY" > ${home}/.codex/auth.json && chmod 600 ${home}/.codex/auth.json`
              : `mkdir -p ${home}`,
          ]);
      if (prepared.code !== 0) throw localError("container_failed", `${seat.name}'s home could not be made: ${prepared.stderr.trim()}`);
      // The driver's own marker names the seat's runtime on the Web; the invite travels by environment.
      const marker: Record<string, string> = seat.driver === "codex" ? { CODEX_SESSION_ID: `goal-${seat.name}` } : seat.driver === "gemini" ? { GEMINI_CLI: "1" } : { CLAUDECODE: "1" };
      const earlier = earlierMembers.get(seat.name);
      const joined = (earlier === undefined ? null : await takeUp(seat, earlier, marker)) ?? await exec(seat, ["sharednet", "join", input.roomId, "--name", seat.name, "--json"], {
        env: { ...marker, SHAREDNET_INVITE_TOKEN: input.inviteToken },
      });
      const memberId = memberOf(joined);
      if (joined.code !== 0 || !memberId) throw localError("join_failed", `${seat.name} could not join the Room: ${(joined.stdout + joined.stderr).trim().slice(0, 400)}`);
      seat.member_id = memberId;
      if (input.taskGate) {
        const paths = controlPaths({ HOME: home }, { base_url: seatBase, room_id: input.roomId, member_id: memberId });
        const made = await exec(seat, ["mkdir", "-p", paths.root]);
        if (made.code !== 0) throw localError("container_failed", "Could not create local task state.");
      }
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

    // An isolated seat calls its model at the gateway, with the API's own path; one that is not calls another API itself.
    const api = plan.codexApi ?? codexApi(undefined);
    const codexBase: CodexBase | null = isolated
      ? { url: `http://${GATEWAY_ALIAS}:${GATEWAY_PORTS.openai}${api.path}`, custom: api.custom }
      : api.custom ? { url: `${api.origin}${api.path}`, custom: true } : null;

    const runTurn = async (seat: SeatRecord, prompt: string, wake: WakeShape | null) => {
      if (input.roomType === "compiled") {
        // The CLI inside the seat's container holds its own credential; the owner cannot render its obligations.
        const opened = await exec(seat, ["sharednet", "open", "--json"]);
        if (opened.code !== 0) throw localError("state_unavailable", "Could not read this seat's compiled Room state.");
        let state: CompiledState;
        try { state = JSON.parse(opened.stdout) as CompiledState; }
        catch { throw localError("invalid_server_response", "The compiled Room state was not JSON."); }
        if (typeof state.obligations !== "string") throw localError("invalid_server_response", "The compiled Room state has no personal obligations.");
        prompt += `\n\n${compiledPrompt(state, false)}`;
      }
      seat.turns += 1;
      const number = String(seat.turns).padStart(3, "0");
      const directory = join(input.out, "agents", seat.name);
      await mkdir(directory, { recursive: true });
      const stream = join(directory, `turn-${number}.jsonl`);
      await writeFile(stream, "");
      const reader = new TurnReader(seat.driver, seat.session_id);
      const startedAt = dependencies.now().toISOString();
      let writes = Promise.resolve();
      const command = turnCommand(seat, prompt, seat.session_id, input.webSearch ?? "live", turnLimitSeconds, codexBase, input.codexModel ?? {}, input.disallowedTools ?? []);
      if (input.taskGate && seat.driver === "claude-code") command.splice(command.length - 1, 0, "--settings", TASK_HOOK_SETTINGS);
      const result = await exec(seat, command, {
        through: wake?.through ?? input.goalSequence,
        onLine: (line) => {
          reader.line(line);
          writes = writes.then(() => appendFile(stream, `${line}\n`));
        },
      });
      await writes;
      reader.finish();
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
      return { failed, started: reader.started };
    };

    /** What the module slots add to a wake: what has been asked of the seat, and who is doing what. */
    const wakeContext = async (seat: SeatRecord, wake: WakeShape): Promise<string[]> => {
      const parts: string[] = [];
      if (modules.messageSchema === "sbar") {
        const asked = renderRequests(requestsFor(wake.messages, seat));
        if (asked) parts.push(asked);
      }
      if (modules.activityView) {
        let tasks: Task[] = [];
        const listed = await exec(seat, ["sharednet", "task", "list", "--json"]);
        try { tasks = (JSON.parse(listed.stdout) as { tasks?: Task[] }).tasks ?? []; } catch { /* the view goes out without tasks */ }
        parts.push(renderActivity(records.map((record) => ({ name: record.name, member_id: record.member_id ?? null, busy: busy.has(record.name), turns: record.turns })), tasks, seat.name));
      }
      return parts;
    };

    // The information slot: a probe on a fixed clock, in the checks container, posted as the runner.
    const probeLoop = async () => {
      const probe = modules.probe;
      if (!probe) return;
      const probeLog = join(input.out, "probe.ndjson");
      while (!ended) {
        // Short sleeps, so that the end of the goal does not wait out a whole probe interval.
        for (let waited = 0; waited < probe.everyMs && !ended; waited += 5_000) await sleep(Math.min(5_000, probe.everyMs - waited));
        if (ended) break;
        const startedAt = dependencies.now().toISOString();
        const result = await exec(null, ["sh", "-c", probe.command]);
        const content = probeMessage(result.stdout);
        let posted = false;
        if (content && !ended) {
          try {
            await client.request("POST", `/rooms/${encodeURIComponent(input.roomId)}/owner-messages`, apiKey, { content, as: "runner" });
            posted = true;
          } catch (error) {
            log(`goal: a probe result was not posted (${error instanceof CliError ? error.code : "error"})\n`);
          }
        }
        await appendFile(probeLog, `${JSON.stringify({ at: startedAt, exit_code: result.code, chars: result.stdout.length, posted })}\n`);
      }
    };

    // Every seat starts once. Subsequent wakes follow the configured routing policy.
    const seatLoop = async (seat: SeatRecord) => {
      let prompt = openingPrompt({ seat, seats: records, roomType: input.roomType, roomId: input.roomId, goal: input.goal, goalSequence: input.goalSequence, until: input.until, mentionGate: input.mentionGate, taskGate: input.taskGate, messageRouting, turnPolicy, modules });
      // A seat taken up again resumes its own session with the new goal and what has changed; a seat
      // that starts fresh in such a run gets the whole opening, and is told the swarm has worked before.
      let taken = resume?.seats.get(seat.name) ?? null;
      // The whole opening, kept for a seat whose session turns out not to be resumable.
      let freshOpening: string | null = null;
      if (input.resume && resume && resumeRecord) {
        const names = records.map((record) => record.name);
        const earlier = { earlierRoomId: input.resume.source.roomId, earlierRooms: resumeRecord.earlier_rooms, workspace: CONTAINER_WORKSPACE };
        // In the same Room, a seat that took up its earlier member speaks from the seat it had.
        const sameSeat = resumeRecord.members?.[seat.name]?.taken_up === true ? { sameSeat: true } : {};
        const opening = `${prompt}\n\n${newcomerNote({ seat: seat.name, seats: names, resumed: new Set(resume.seats.keys()), ...earlier, roomId: input.roomId, goalSequence: input.goalSequence, ...sameSeat })}`;
        if (taken) {
          const controls = roomControls({ mentionGate, taskGate, messageRouting, turnPolicy, modules: describeModules(modules), seats: names });
          const again = resumePrompt({
            seat: seat.name, seats: names, resumed: new Set(resume.seats.keys()), roomId: input.roomId, ...earlier,
            goal: input.goal, goalSequence: input.goalSequence, until: input.until, today: dependencies.now().toISOString().slice(0, 10),
            rules: controls === input.resume.source.controls ? null : roomRules({ seat, seats: records, mentionGate: input.mentionGate, taskGate: input.taskGate, messageRouting, turnPolicy, modules }),
            ...sameSeat,
          });
          seat.session_id = taken.sessionId;
          resumeRecord.seats[seat.name] = { resumed: true, session_id: taken.sessionId, baseline: taken.baseline, prompt_sha256: sha256(again) };
          freshOpening = opening;
          prompt = again;
        } else prompt = opening;
      }
      if (!taken) openingPromptHashes[seat.name] = sha256(prompt);
      let wake: WakeShape | null = null;
      let failedInARow = 0;
      while (!ended) {
        if (maxActiveTurns !== null && !(await acquireTurn())) return;
        if (ended) { if (maxActiveTurns !== null) releaseTurn(); return; }
        busy.add(seat.name);
        const { failed, started } = await runTurn(seat, prompt, wake).finally(() => {
          busy.delete(seat.name);
          if (maxActiveTurns !== null) releaseTurn();
        });
        if (wake?.wake_id) await exec(seat, ["sharednet", "ack", wake.wake_id, "--json"]);
        failedInARow = failed ? failedInARow + 1 : 0;
        if (taken) {
          // The first turn shows whether the harness took the session up. Codex names the session it runs:
          // any other than the one asked for is a new one, which has not had the opening. A harness that
          // names none refused. Either way the seat starts again, fresh, with the whole opening.
          const took = started && (seat.driver === "claude-code" || seat.session_id === taken.sessionId);
          taken = null;
          if (!took) {
            startFresh(seat, ended ? "ended_first" : "harness_refused");
            seat.session_id = null;
            if (ended || freshOpening === null) break;
            prompt = freshOpening;
            openingPromptHashes[seat.name] = sha256(prompt);
            failedInARow = 0;
            continue;
          }
        }
        if (ended) break;
        if (failedInARow >= FAILED_TURNS_LIMIT) {
          log(`goal: ${seat.name} failed ${FAILED_TURNS_LIMIT} turns in a row and takes no more; see agents/${seat.name}/\n`);
          break;
        }
        while (!ended) {
          const waited = await exec(seat, ["sharednet", "wait", "--on", "message", "--on", "closed", "--settle", "2s", "--ack", "manual", "--json"]);
          if (ended || waited.code !== 0) return;
          let raw: WakeShape;
          try { raw = JSON.parse(waited.stdout) as WakeShape; } catch { return; }
          if (raw.fired.includes("closed")) return;
          wake = reachable(routeWake(raw, seat, records, messageRouting), seat, records, modules.topology);
          if (input.taskGate) wake = withoutTaskActs(wake);
          const delivered = wake.messages.map(message => message.sequence);
          if (messageRouting !== "broadcast" || input.taskGate || modules.topology.kind !== "all") await appendFile(join(input.out, "routing.ndjson"), `${JSON.stringify({ at: dependencies.now().toISOString(), seat: seat.name, wake_id: raw.wake_id, from: raw.from, through: raw.through, delivered, skipped: raw.messages.filter(m => !delivered.includes(m.sequence)).map(m => m.sequence), model_wake: delivered.length > 0 })}\n`);
          if (delivered.length > 0 || (messageRouting === "broadcast" && !input.taskGate && modules.topology.kind === "all")) break;
          if (raw.wake_id) await exec(seat, ["sharednet", "ack", raw.wake_id, "--json"]);
        }
        if (ended || !wake) return;
        prompt = [wakePrompt(wake, turnPolicy), ...(await wakeContext(seat, wake))].join("\n\n");
      }
    };
    const seats = records.map((seat) =>
      seatLoop(seat).catch((error: unknown) => {
        log(`goal: ${seat.name} stopped (${error instanceof Error ? error.message : "error"})\n`);
      }),
    );
    const probing = probeLoop().catch((error: unknown) => {
      log(`goal: the probe stopped (${error instanceof Error ? error.message : "error"})\n`);
    });

    const watched = await goalWatch(
      client,
      memberToken,
      apiKey,
      // Under mentions-only an unaddressed line wakes nobody, so a failing check is said to the seat that claimed.
      { roomId: input.roomId, workspace: plan.workspace, out: input.out, checkEveryMs: input.checkEveryMs, quietChecks: input.quietChecks, ...(messageRouting === "mentions-only" ? { feedbackToClaimant: true } : {}) },
      {
        now: dependencies.now,
        ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
        stderr: log,
        // A check runs in its own container, on the shared workspace: what one Agent installed for itself does not count.
        check: async (command) => {
          const result = await exec(null, ["sh", "-c", command]);
          return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
        },
        spend,
      },
    );
    ended = true;
    cancelPendingTurns();
    // Stopping the containers ends every turn and every wait still running.
    await docker(["stop", "--time", "5", ...containers]);
    await Promise.all(seats);
    await probing;

    // Each Agent's own trace is its home: Codex keeps sessions in ~/.codex, Claude Code in ~/.claude.
    for (const seat of records) {
      const target = join(input.out, "agents", seat.name, "home");
      await mkdir(dirname(target), { recursive: true });
      await rm(target, { recursive: true, force: true });
      const copied = await docker(["cp", `${containerName(input.roomId, seat.name)}:${CONTAINER_HOMES}/${seat.name}`, target]);
      if (copied.code !== 0) log(`goal: ${seat.name}'s home could not be copied out: ${copied.stderr.trim()}\n`);
      await scrubHome(target);
      // The record's numbers come from the session's own file when there is one: it saw every turn, a cut one included.
      if (seat.driver === "codex" && seat.session_id) {
        const usage = await sessionFileUsage(join(target, ".codex", "sessions"), seat.session_id);
        if (usage) account(seat, usage, true);
      }
    }
    // An isolated run's gateway saw every request that left a container: its log is part of the record.
    // Its own logs only: the image's access.log and error.log are links to the console, read with `docker logs`.
    if (isolated) {
      const target = join(input.out, "gateway");
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      const logs = ["sharednet", ...(plan.codexAuth !== null ? ["openai"] : []), ...(plan.claudeAuth !== null ? ["anthropic"] : [])];
      for (const name of logs) {
        const copied = await docker(["cp", `${names.gateway}:/var/log/nginx/${name}.log`, join(target, `${name}.log`)]);
        if (copied.code !== 0) log(`goal: the gateway's ${name} log could not be copied out: ${copied.stderr.trim()}\n`);
      }
      const printed = await docker(["logs", names.gateway]);
      await writeFile(join(target, "nginx.log"), `${printed.stdout}${printed.stderr}`);
    }
    const episodePath = join(input.out, "episode.json");
    const episode = JSON.parse(await readFile(episodePath, "utf8")) as Record<string, unknown>;
    const adHocProfile = {
      command: "goal run",
      room_type: input.roomType ?? "board",
      delivery: "runner-owned-turn-loop",
      initial_wake: "all-seats",
      mention_gate: mentionGate,
      task_gate: taskGate,
      message_routing: messageRouting,
    };
    const profile = input.harnessMode?.profile ?? adHocProfile;
    await writeFile(
      episodePath,
      `${JSON.stringify(
        {
          ...episode,
          image: plan.image,
          agent_user: user,
          isolated,
          ...(isolated ? { addresses } : {}),
          web_search: input.webSearch ?? "live",
          ...(input.disallowedTools?.length ? { disallowed_tools: input.disallowedTools } : {}),
          // Where the Codex seats' model was: a run's numbers are read with the model and its provider.
          // Recorded when the run names an API: a Codex login's own endpoint is Codex's business, not the run's.
          ...(plan.codexApi ? { model_api: `${api.origin}${api.path}` } : {}),
          ...(plan.codexAuth !== null ? {
            reasoning_effort: input.codexModel?.reasoningEffort ?? null,
            context_window: input.codexModel?.contextWindow ?? null,
            compact_at: input.codexModel?.compactAt ?? null,
          } : {}),
          turn_limit_s: turnLimitSeconds,
          ...(maxActiveTurns === null ? {} : { max_active_turns: maxActiveTurns }),
          turn_policy: turnPolicy,
          mention_gate: input.mentionGate ?? false,
          task_gate: input.taskGate ?? false,
          message_routing: messageRouting,
          modules: describeModules(modules),
          harness: {
            mode: input.harnessMode?.name ?? null,
            spec_sha256: input.harnessMode?.specSha256 ?? null,
            resolved_profile: {
              ...profile,
              web_search: input.webSearch ?? "live",
              turn_limit_s: turnLimitSeconds,
              turn_policy: turnPolicy,
              // Explicit inputs a named mode leaves open, written down when the run sets them.
              ...(plan.codexApi ? { model_api: `${api.origin}${api.path}` } : {}),
              ...(input.codexModel?.reasoningEffort === undefined ? {} : { reasoning_effort: input.codexModel.reasoningEffort }),
              ...(input.codexModel?.contextWindow === undefined ? {} : { context_window: input.codexModel.contextWindow }),
              ...(input.codexModel?.compactAt === undefined ? {} : { compact_at: input.codexModel.compactAt }),
              ...(isolated ? { isolated: true } : {}),
              ...(user === AGENT_USER ? {} : { agent_user: user }),
              until: input.until,
            },
            client_commit: codeProvenance.clientCommit,
            runner_commit: codeProvenance.runnerCommit,
            source_worktree_dirty: codeProvenance.sourceWorktreeDirty,
            package_version: codeProvenance.packageVersion,
            package_manifest_sha256: codeProvenance.packageManifestSha256,
            entry_sha256: codeProvenance.entrySha256,
            code_tree_sha256: codeProvenance.codeTreeSha256,
            image: plan.image,
            models: records.map((seat) => ({ seat: seat.name, driver: seat.driver, model: seat.model })),
            goal_sha256: sha256(input.goal),
            opening_prompt_sha256: Object.fromEntries(records.map((seat) => [seat.name, openingPromptHashes[seat.name] ?? null])),
          },
          agents: records,
          totals: { ...(episode.totals as object), tokens: spend(), cached_tokens: records.reduce((sum, seat) => sum + seat.usage.cached, 0) },
          // Only a run that was asked to resume a swarm says so: which seats were taken up again, and why the others were not.
          ...(resumeRecord ? { resume: resumeRecord } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return { ...watched, agents: records, tokens: spend(), ...(resumeRecord ? { resume: resumeRecord } : {}) };
  } finally {
    ended = true;
    cancelPendingTurns();
    await docker(["rm", "--force", ...containers]);
    if (isolated) {
      await docker(["rm", "--force", names.gateway]);
      await docker(["network", "rm", names.network]);
    }
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
  for (const secret of [".config/sharednet", ".codex/auth.json", ".claude/.credentials.json", ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".gemini/mcp-oauth-tokens.json", ".gemini/a2a-oauth-tokens.json", ".gemini/.env"]) {
    await rm(join(home, secret), { recursive: true, force: true });
  }
}
