import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { CliError, localError } from "./errors.ts";

/**
 * `goal report`: one row per goal record, for a table that collects runs and compares them
 * (agents, tokens, time and how each run ended).
 *
 * A row holds numbers, settings and short labels. It is read from `episode.json`, `wakes.ndjson`,
 * `checks.ndjson` and, when a launcher left them, `launch.json`, `launcher-summary.json` and
 * `score.json`. Messages, turn streams, the workspace and the agents' homes are never opened, and
 * what does leave the record is cleaned first: absolute paths are cut to their last two segments
 * and anything shaped like a key is replaced.
 *
 * The derivations, so that rows made by different tools agree:
 * - `duration_s`    `goal.started_at` to `ended_by.at`, falling back to the runner's own times
 * - `tokens_fresh`  `totals.tokens`: uncached input plus output, what a budget is judged on
 * - `tokens_cached` `totals.cached_tokens`, else the sum of the seats' cached usage
 * - `agent_busy_s`  the sum of (ended - started) over `wakes.ndjson`; a wake's `tokens` is never
 *                   summed, because a resumed Codex session reports its running total there
 * - `first_pass_s`  from the start to the first check that passed
 * - `outcome`       `passed` (a check ended it), `declared` (a `said` trigger), `stopped`
 *                   (budget, after, at, count, idle), `closed` (a person), else `unknown`
 */
export const REPORT_SCHEMA = 2;

type Json = Record<string, unknown>;

export interface ReportScore {
  name: string;
  value: number;
  scale?: string;
  source: string;
}

export interface ReportRow extends Json {
  schema: number;
  id: string;
  room_id: string;
  goal_seq: number | null;
  title: string;
  family: string | null;
  tags: string[];
  extracted_at: string;
  config: Json;
  trace: Json;
  performance: Json & { scores: ReportScore[] };
  metrics: Json;
  per_agent: Json[];
}

export interface ReportOptions {
  /** The experiment the run belongs to; a table groups its rows by this. */
  experiment?: string;
  tags?: readonly string[];
  /** A score someone measured after the run, such as a hidden-test pass fraction. */
  score?: { name: string; value: number };
  now?: () => Date;
}

const ABSOLUTE_PATH = /(?<![\w.])\/(?:mnt|home|Users|tmp|var|opt|srv|data|workspace|root)\/[^\s'"=,;]*/g;
const KEY_SHAPED = /(?<![A-Za-z])(sk-[A-Za-z0-9_-]{8,}|snk_[A-Za-z0-9_-]{8,}|sn_[A-Za-z0-9_-]{12,}|rit_[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{12,}|AIza[0-9A-Za-z_-]{12,}|eyJ[A-Za-z0-9_-]{20,})/g;
/** Options whose value names an account or a seat, not the run. */
const IDENTITY_OPTIONS = new Set(["--session", "--token", "--key", "--api-key", "--account", "--name"]);

const record = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const text = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

function seconds(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at / 1000;
}

function isoSeconds(value: unknown): string | null {
  const at = seconds(value);
  return at === null ? null : new Date(at * 1000).toISOString().replace(/\.\d+Z$/, "Z");
}

function shortPath(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

/** Text that may leave the machine: no absolute path, nothing shaped like a key, one line. */
export function cleanReportText(value: unknown, limit?: number): string | null {
  if (value === null || value === undefined) return null;
  let cleaned = String(value).replace(KEY_SHAPED, "‹redacted›").replace(ABSOLUTE_PATH, (match) => shortPath(match));
  cleaned = cleaned.split(/\s+/).filter((part) => part.length > 0).join(" ");
  return limit !== undefined && cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
}

const shortImage = (image: unknown): string | null => cleanReportText(image, 100)?.replace(/(sha256:[0-9a-f]{12})[0-9a-f]+/, "$1…") ?? null;
const quoted = (word: string): string => (/^[\w@%+=:,./…×-]+$/.test(word) ? word : `'${word.replace(/'/g, `'"'"'`)}'`);

function foldAgents(specs: readonly string[]): string[] {
  const runs: Array<[string, number]> = [];
  for (const spec of specs) {
    const last = runs[runs.length - 1];
    if (last && last[0] === spec) last[1] += 1;
    else runs.push([spec, 1]);
  }
  return runs.map(([spec, times]) => `--agent ${spec}${times > 1 ? ` ×${times}` : ""}`);
}

/**
 * A launch argv as one readable line: identities dropped, paths shortened, the interpreter and the
 * script path in front of the subcommand removed, and a run of the same `--agent` folded to `×N`.
 */
export function launchCommandLine(argv: readonly unknown[]): string {
  const kept: string[] = [];
  const agents: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (IDENTITY_OPTIONS.has(argument) && index + 1 < argv.length) {
      index += 1;
      continue;
    }
    if ([...IDENTITY_OPTIONS].some((name) => argument.startsWith(`${name}=`))) continue;
    if (argument === "--agent" && index + 1 < argv.length) {
      agents.push(String(argv[++index]));
      continue;
    }
    kept.push(argument);
  }
  let words = kept.map((argument) => quoted(cleanReportText(argument) ?? "").replace(/(sha256:[0-9a-f]{12})[0-9a-f]+/, "$1…"));
  for (const verb of ["goal", "room"]) {
    const at = words.indexOf(verb);
    if (at >= 0) {
      words = [...words.slice(0, at).filter((word) => word.startsWith("-")), ...words.slice(at)];
      break;
    }
  }
  if (words[0] !== "sharednet") words.unshift("sharednet");
  const at = Math.min(words.includes("run") ? words.indexOf("run") + 2 : words.length, words.length);
  return [...words.slice(0, at), ...foldAgents(agents), ...words.slice(at)].join(" ");
}

/** The command a record implies, for a record that does not hold the one it was launched with. */
function rebuiltCommand(episode: Json, agents: readonly Json[]): string {
  const words = ["sharednet", "goal", "run", "GOAL.md", ...foldAgents(agents.map((agent) => `${text(agent.driver) ?? "?"}${text(agent.model) ? `:${agent.model as string}` : ""}`))];
  const harness = record(episode.harness) ? episode.harness : {};
  if (text(harness.mode)) words.push(`--harness-mode ${harness.mode as string}`);
  if (episode.image) words.push(`--image ${shortImage(episode.image)}`);
  if (episode.isolated) words.push("--isolate");
  if (text(episode.web_search) && episode.web_search !== "live") words.push(`--web-search ${episode.web_search as string}`);
  if (text(episode.message_routing) && episode.message_routing !== "broadcast") words.push(`--message-routing ${episode.message_routing as string}`);
  if (episode.mention_gate) words.push("--mention-gate");
  if (episode.task_gate) words.push("--task-gate");
  if (text(episode.turn_policy) && episode.turn_policy !== "legacy") words.push(`--turn-policy ${episode.turn_policy as string}`);
  // A record written by a client that loops its seats says so; this one only reads it.
  if (text(episode.loop)) {
    words.push(`--loop ${episode.loop as string}`);
    if (count(episode.rest_s) !== null) words.push(`--rest ${Math.trunc(episode.rest_s as number)}s`);
  }
  if (text(episode.reasoning_effort)) words.push(`--reasoning-effort ${episode.reasoning_effort as string}`);
  const turnLimit = count(episode.turn_limit_s);
  if (turnLimit) words.push(turnLimit % 60 === 0 ? `--turn-limit ${turnLimit / 60}m` : `--turn-limit ${Math.trunc(turnLimit)}s`);
  if (episode.resume) words.push("--resume-from ‹earlier record›");
  const goal = record(episode.goal) ? episode.goal : {};
  for (const condition of Array.isArray(goal.until) ? goal.until : []) words.push(`--until ${quoted(cleanReportText(condition, 90) ?? "")}`);
  return words.join(" ");
}

function modulesLabel(modules: unknown): string | null {
  if (!record(modules)) return null;
  const parts: string[] = [];
  const state = record(modules.state) ? modules.state : {};
  if (text(state.task_judge) && state.task_judge !== "off") parts.push(`task-judge:${state.task_judge as string}`);
  if (state.activity_view) parts.push("activity-view");
  if (modules.topology !== undefined && modules.topology !== null && modules.topology !== "all") {
    parts.push(`topology:${typeof modules.topology === "string" ? modules.topology : text((modules.topology as Json).kind) ?? "custom"}`);
  }
  if (text(modules.protocol) && modules.protocol !== "free") parts.push(`protocol:${modules.protocol as string}`);
  if (modules.information) parts.push("probe");
  return parts.length > 0 ? parts.join(" ") : null;
}

export function reportOutcome(trigger: unknown, lastCheckPassed: boolean | null): "passed" | "declared" | "stopped" | "closed" | "unknown" {
  const word = String(trigger ?? "").trim().split(" ")[0]!.replace(/:$/, "").toLowerCase();
  if (word === "check" || (word === "" && lastCheckPassed === true)) return "passed";
  if (word === "said") return "declared";
  if (["budget", "after", "at", "count", "idle"].includes(word)) return "stopped";
  if (word === "owner") return "closed";
  return lastCheckPassed === true ? "passed" : "unknown";
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readLines(path: string): Promise<Json[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const lines: Json[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (record(parsed)) lines.push(parsed);
    } catch {
      // A line cut off by a stopped runner is skipped; the rest of the file still counts.
    }
  }
  return lines;
}

/** The folder name that says which run this is: the record's own, or the one above a generic leaf. */
function recordLabel(recordDirectory: string): string {
  const generic = new Set(["record", "records", "episode", "goal", "out", "run", "rooms"]);
  let current = resolve(recordDirectory);
  let label = basename(current);
  // A swarm keeps its Rooms as <run>/…/divisions/<division>/rooms/<room>: the leaf alone says little.
  const swarm = /\/([^/]+)(?:\/state)?\/divisions\/([^/]+)\/rooms\/([^/]+)$/.exec(current);
  if (swarm) return `${swarm[1]}/${swarm[2]}/${swarm[3]}`;
  while (generic.has(label) && dirname(current) !== current) {
    current = dirname(current);
    label = basename(current);
  }
  return label;
}

/** One record as one row, or null when the directory holds no goal record. */
export async function reportRow(recordDirectory: string, options: ReportOptions = {}): Promise<ReportRow | null> {
  const episode = await readJson(join(recordDirectory, "episode.json"));
  if (!record(episode) || !text(episode.room_id) || !record(episode.goal)) return null;
  const goal = episode.goal;
  const runner = record(episode.runner) ? episode.runner : {};
  const totals = record(episode.totals) ? episode.totals : {};
  const endedBy = record(episode.ended_by) ? episode.ended_by : {};
  const harness = record(episode.harness) ? episode.harness : {};
  const agents = (Array.isArray(episode.agents) ? episode.agents : record(episode.agents) ? Object.values(episode.agents) : []).filter(record);

  const perAgent: Json[] = [];
  const mix = new Map<string, number>();
  let input = 0;
  let output = 0;
  let cachedBySeat = 0;
  let hasUsage = false;
  for (const agent of agents) {
    const usage = record(agent.usage) ? agent.usage : null;
    if (usage) {
      hasUsage = true;
      input += count(usage.input) ?? 0;
      output += count(usage.output) ?? 0;
      cachedBySeat += count(usage.cached) ?? 0;
    }
    perAgent.push({
      name: cleanReportText(agent.name, 60),
      driver: text(agent.driver),
      model: text(agent.model),
      turns: count(agent.turns),
      failed_turns: count(agent.failed_turns),
      tokens: count(agent.tokens),
      input: usage ? count(usage.input) : null,
      cached: usage ? count(usage.cached) : null,
      output: usage ? count(usage.output) : null,
    });
    const key = JSON.stringify([text(agent.driver), text(agent.model)]);
    mix.set(key, (mix.get(key) ?? 0) + 1);
  }

  const started = seconds(goal.started_at) ?? seconds(runner.started_at);
  const ended = seconds(endedBy.at) ?? seconds(runner.ended_at);
  const duration = started !== null && ended !== null && ended >= started ? Math.round((ended - started) * 10) / 10 : null;

  let busy = 0;
  let cut = 0;
  const wakes = await readLines(join(recordDirectory, "wakes.ndjson"));
  for (const wake of wakes) {
    const from = seconds(wake.started_at);
    const to = seconds(wake.ended_at);
    if (from !== null && to !== null && to >= from) busy += to - from;
    if (wake.cut_by_end) cut += 1;
  }

  let checksPassed = 0;
  let firstPass: number | null = null;
  let lastPassed: boolean | null = null;
  const checks = await readLines(join(recordDirectory, "checks.ndjson"));
  for (const check of checks) {
    lastPassed = Boolean(check.passed);
    if (!check.passed) continue;
    checksPassed += 1;
    const at = seconds(check.at);
    if (firstPass === null && at !== null && started !== null) firstPass = Math.round(Math.max(0, at - started) * 10) / 10;
  }

  const fresh = count(totals.tokens) ?? (hasUsage ? input + output : null);
  const cached = count(totals.cached_tokens) ?? (hasUsage ? cachedBySeat : null);
  const seats = agents.length;

  // How it was launched. goal run's own note in the record is believed first, then a launcher
  // that wrote its arguments down: next to the record (launch.json, launcher-summary.json) or one
  // folder up (command.safe.json, launcher/summary.json). Without one the command is rebuilt from
  // what the record keeps, helped by a launcher's settings file when there is one.
  const parent = dirname(resolve(recordDirectory));
  const fromFile = async (path: string): Promise<Json> => {
    const value = await readJson(path);
    return record(value) ? value : {};
  };
  const launch = await fromFile(join(recordDirectory, "launch.json"));
  const settings = await fromFile(join(recordDirectory, "launch-settings.json"));
  const written = [
    record(episode.launch) ? episode.launch : {},
    launch,
    await fromFile(join(recordDirectory, "launcher-summary.json")),
    await fromFile(join(parent, "command.safe.json")),
    await fromFile(join(parent, "launcher", "summary.json")),
    await fromFile(join(recordDirectory, "command.safe.json")),
  ];
  let command: string | null = null;
  for (const holder of written) {
    for (const key of ["args", "argv", "command"]) {
      const candidate = holder[key];
      if (Array.isArray(candidate) && candidate.some((word) => String(word) === "goal") && candidate.some((word) => String(word) === "run" || String(word) === "watch")) {
        command = launchCommandLine(candidate);
        break;
      }
    }
    if (command !== null) break;
  }
  let commandSource: "recorded" | "launch settings" | "reconstructed" = "recorded";
  if (command === null) {
    command = rebuiltCommand(episode, agents);
    commandSource = "reconstructed";
    if (text(settings.effort) && !command.includes("--reasoning-effort")) {
      command = command.replace(" --until ", ` --reasoning-effort ${cleanReportText(settings.effort, 20)} --until `);
    }
    if (Object.keys(settings).length > 0) commandSource = "launch settings";
  }
  // What a launcher said about the run in its own words: its label, the arm, the limits it set.
  const launcher: Json = {};
  for (const key of ["label", "task", "arm", "seats", "agents", "minutes", "model", "effort", "budget", "carry", "snapshot", "loop", "rest", "turn_limit_minutes", "limits", "cpu_set", "retry_note"]) {
    for (const holder of [launch, settings]) {
      const value = holder[key];
      if (key in launcher || value === "" || (typeof value !== "string" && count(value) === null)) continue;
      launcher[key] = typeof value === "string" ? cleanReportText(value, 80) : value;
    }
  }
  if (text(settings.cli_commit)) launcher.cli_commit = (settings.cli_commit as string).slice(0, 10);
  if (text(launch.client)) launcher.client = cleanReportText(launch.client, 80);

  const scores: ReportScore[] = [];
  if (options.score) scores.push({ name: cleanReportText(options.score.name, 80) ?? "score", value: options.score.value, source: "given with the report" });
  const own = await readJson(join(recordDirectory, "score.json"));
  if (record(own)) {
    if (count(own.pass_fraction) !== null) scores.push({ name: "ProgramBench hidden tests passed", value: own.pass_fraction as number, scale: "fraction 0–1", source: "score.json" });
    else if (count(own.total_score) !== null) scores.push({ name: "ResearchClawBench rubric score", value: own.total_score as number, scale: "0–100 points, model-judged", source: "score.json" });
  }

  // A `said` ending carries the message that matched, which is Room content: only a bare marker is kept.
  let detail = cleanReportText(endedBy.detail, 200);
  if (detail !== null && String(endedBy.trigger ?? "").startsWith("said") && detail.length > 40) detail = null;

  const resume = record(episode.resume) ? episode.resume : null;
  const totalChecks = count(totals.checks);
  const label = recordLabel(recordDirectory);
  const now = options.now ?? (() => new Date());
  return {
    schema: REPORT_SCHEMA,
    id: episode.room_id as string,
    room_id: episode.room_id as string,
    goal_seq: count(goal.sequence),
    title: cleanReportText(label, 80) ?? (episode.room_id as string),
    family: options.experiment === undefined ? null : cleanReportText(options.experiment, 80),
    tags: (options.tags ?? []).map((tag) => cleanReportText(tag, 40) ?? "").filter((tag) => tag.length > 0).slice(0, 12),
    extracted_at: now().toISOString(),
    config: {
      command,
      command_source: commandSource,
      launcher: Object.keys(launcher).length > 0 ? launcher : null,
      n_agents: seats,
      agent_mix: [...mix].map(([key, times]) => {
        const [driver, model] = JSON.parse(key) as [string | null, string | null];
        return { driver, model, count: times };
      }),
      models: [...new Set(perAgent.map((agent) => agent.model).filter((model): model is string => typeof model === "string"))].sort(),
      drivers: [...new Set(perAgent.map((agent) => agent.driver).filter((driver): driver is string => typeof driver === "string"))].sort(),
      until: (Array.isArray(goal.until) ? goal.until : []).map((condition) => cleanReportText(condition, 120)),
      harness_mode: text(harness.mode),
      web_search: text(episode.web_search),
      isolated: typeof episode.isolated === "boolean" ? episode.isolated : null,
      reasoning_effort: text(episode.reasoning_effort) ?? text(launch.effort) ?? text(settings.effort),
      context_window: count(episode.context_window),
      compact_at: count(episode.compact_at),
      image: shortImage(episode.image),
      package_version: text(harness.package_version),
      client_commit: text(harness.client_commit)?.slice(0, 10) ?? null,
      turn_limit_s: count(episode.turn_limit_s),
      turn_policy: text(episode.turn_policy),
      loop: text(episode.loop),
      rest_s: count(episode.rest_s),
      message_routing: text(episode.message_routing),
      mention_gate: typeof episode.mention_gate === "boolean" ? episode.mention_gate : null,
      task_gate: typeof episode.task_gate === "boolean" ? episode.task_gate : null,
      modules: modulesLabel(episode.modules),
      initiation_policy: text(episode.initiation_policy),
      termination_policy: text(episode.termination_policy),
      workspace_layout: episode.trunk ? "forks" : null,
      resumed: resume !== null,
      resumed_seats: resume !== null && Array.isArray(resume.seats) ? resume.seats.filter((seat) => record(seat) && seat.resumed === true).length : null,
    },
    trace: { url: null, local_path: resolve(recordDirectory).split("/").filter((part) => part.length > 0).slice(-3).join("/"), notes: null },
    performance: {
      outcome: reportOutcome(endedBy.trigger, lastPassed),
      ended_by: cleanReportText(endedBy.trigger, 120),
      detail,
      metric_name: scores[0]?.name ?? null,
      metric_value: scores[0]?.value ?? null,
      metric_scale: scores[0]?.scale ?? null,
      metric_source: scores[0]?.source ?? null,
      scores,
      notes: null,
    },
    metrics: {
      started_at: isoSeconds(goal.started_at) ?? isoSeconds(runner.started_at),
      ended_at: isoSeconds(endedBy.at) ?? isoSeconds(runner.ended_at),
      duration_s: duration,
      n_agents: seats,
      turns: perAgent.length > 0 ? perAgent.reduce((sum, agent) => sum + ((agent.turns as number | null) ?? 0), 0) : null,
      failed_turns: perAgent.length > 0 ? perAgent.reduce((sum, agent) => sum + ((agent.failed_turns as number | null) ?? 0), 0) : null,
      wakes: wakes.length > 0 ? wakes.length : null,
      turns_cut_by_end: wakes.length > 0 ? cut : null,
      tokens_fresh: fresh,
      tokens_cached: cached,
      tokens_input: hasUsage ? input : null,
      tokens_output: hasUsage ? output : null,
      tokens_per_agent: fresh !== null && seats > 0 ? Math.round(fresh / seats) : null,
      tokens_per_min: fresh !== null && duration ? Math.round(fresh / (duration / 60)) : null,
      agent_busy_s: wakes.length > 0 ? Math.round(busy * 10) / 10 : null,
      parallelism: wakes.length > 0 && duration ? Math.round((busy / duration) * 100) / 100 : null,
      messages: count(totals.messages),
      checks: totalChecks ?? checks.length,
      checks_passed: checks.length > 0 ? checksPassed : totalChecks === 0 ? 0 : null,
      first_pass_s: firstPass,
      snapshots: count(totals.snapshots),
    },
    per_agent: perAgent,
  };
}

/** Directories under a path that hold a goal record. Workspaces, homes and git stores are not entered. */
export async function findRecords(path: string, limit = 5000): Promise<string[]> {
  const skipped = new Set(["node_modules", ".git", "workspace.git", "snapshots.git", "agents", "home", "work", "workspace", "gateway"]);
  const found: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (found.length >= limit || depth > 8) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "episode.json")) {
      found.push(directory);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isDirectory() && !skipped.has(entry.name)) await visit(join(directory, entry.name), depth + 1);
    }
  };
  if (!(await stat(path).then((entry) => entry.isDirectory(), () => false))) return [];
  await visit(resolve(path), 0);
  return found;
}

export interface ReportDelivery {
  to: string;
  kind: "directory" | "url" | "sharednet";
  delivered: number;
}

export interface ReportDependencies {
  fetch: typeof globalThis.fetch;
  env: Record<string, string | undefined>;
  cwd: string;
  /**
   * The SharedNet service this CLI is signed in to, for `--to sharednet`: its origin, and the
   * account's key, read only when a report is actually sent there.
   */
  service?: { baseUrl: string; apiKey(): Promise<string> };
}

export type ReportTarget = { kind: "url"; url: URL } | { kind: "directory"; path: string } | { kind: "sharednet"; board: string | null };

/**
 * `--to` as a place: `sharednet` (the account's catalogue on the service, or `sharednet:<id>`
 * for a catalogue it was let into, `sharednet:me` for its own), a URL that takes rows, or a
 * directory that keeps one file a run.
 */
export function reportTarget(to: string, cwd: string): ReportTarget {
  const named = /^sharednet(?::(.+))?$/.exec(to);
  if (named) {
    const board = named[1] ?? null;
    if (board !== null && !/^[A-Za-z0-9_.@-]{1,200}$/.test(board)) throw localError("invalid_arguments", "--to sharednet:<catalogue> names a catalogue by its id, or `me` for your own.");
    return { kind: "sharednet", board };
  }
  if (/^https?:\/\//i.test(to)) {
    let url: URL;
    try {
      url = new URL(to);
    } catch {
      throw localError("invalid_arguments", "--to is a directory or an https URL.");
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !loopback) throw localError("invalid_arguments", "--to takes https, or http on this machine only: a report is not sent in the clear.");
    if (url.username || url.password) throw localError("invalid_arguments", "--to must not carry a name or a password; give the token as SHAREDNET_REPORT_TOKEN.");
    return { kind: "url", url };
  }
  return { kind: "directory", path: resolve(cwd, to) };
}

/**
 * Hands rows over. A directory gets one `<id>.json` a run, written whole or not at all. A URL gets
 * `POST {schema, rows}` in batches, with `SHAREDNET_REPORT_TOKEN` as the bearer token when it is
 * set. The account's SharedNet key is never sent: the place is one the person named, not the service.
 */
export async function deliverReport(rows: readonly ReportRow[], to: string, dependencies: ReportDependencies): Promise<ReportDelivery> {
  const target = reportTarget(to, dependencies.cwd);
  if (target.kind === "directory") {
    await mkdir(target.path, { recursive: true });
    for (const row of rows) {
      const name = `${row.id.replace(/[^A-Za-z0-9_.@-]/g, "_")}${row.goal_seq !== null && row.goal_seq > 1 ? `@${row.goal_seq}` : ""}.json`;
      const partial = join(target.path, `.${name}.${process.pid}.partial`);
      await writeFile(partial, `${JSON.stringify(row, null, 1)}\n`, { mode: 0o644 });
      await rename(partial, join(target.path, name));
    }
    return { to: target.path, kind: "directory", delivered: rows.length };
  }
  if (target.kind === "sharednet") return deliverToService(rows, target.board, dependencies);
  const token = dependencies.env.SHAREDNET_REPORT_TOKEN;
  let delivered = 0;
  for (let start = 0; start < rows.length; start += 50) {
    const batch = rows.slice(start, start + 50);
    let response: Response;
    try {
      response = await dependencies.fetch(target.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ schema: REPORT_SCHEMA, rows: batch }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new CliError("report_not_delivered", `${target.url.origin} did not answer; ${delivered} of ${rows.length} rows were delivered.`, 5);
    }
    if (!response.ok) throw new CliError("report_not_delivered", `${target.url.origin} answered ${response.status}; ${delivered} of ${rows.length} rows were delivered.`, 5);
    delivered += batch.length;
  }
  return { to: `${target.url.origin}${target.url.pathname}`, kind: "url", delivered };
}

/**
 * Rows to the SharedNet service's catalogue (`POST /api/scaling/runs`), as the account, by its
 * own key: the one place a report goes with that key, because it is the service the key is for.
 * A row with no trace link gets the Room's own address there. Batches stay under what one
 * request may carry; a refusal says how far it got and what the service said.
 */
async function deliverToService(rows: readonly ReportRow[], board: string | null, dependencies: ReportDependencies): Promise<ReportDelivery> {
  const service = dependencies.service;
  if (!service) throw localError("invalid_arguments", "--to sharednet needs the SharedNet service this CLI signs in to.");
  const key = await service.apiKey();
  const sent = rows.map((row) => (row.trace.url ? row : { ...row, trace: { ...row.trace, url: `${service.baseUrl}/chat?room=${encodeURIComponent(row.room_id)}`, url_kind: "room" } }));
  const batches: ReportRow[][] = [];
  let bytes = 0;
  for (const row of sent) {
    const size = Buffer.byteLength(JSON.stringify(row), "utf8");
    const last = batches[batches.length - 1];
    if (!last || last.length >= 50 || bytes + size > 2_500_000) {
      batches.push([row]);
      bytes = size;
    } else {
      last.push(row);
      bytes += size;
    }
  }
  let delivered = 0;
  let catalogue = board;
  for (const batch of batches) {
    let response: Response;
    try {
      response = await dependencies.fetch(`${service.baseUrl}/api/scaling/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ schema: REPORT_SCHEMA, rows: batch, ...(board === null ? {} : { board }) }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new CliError("report_not_delivered", `SharedNet did not answer; ${delivered} of ${rows.length} rows were delivered.`, 5);
    }
    const answer = (await response.json().catch(() => null)) as { board?: unknown; error?: { message?: unknown } } | null;
    if (!response.ok) {
      const said = typeof answer?.error?.message === "string" ? ` ${answer.error.message}` : "";
      throw new CliError("report_not_delivered", `SharedNet answered ${response.status};${said} ${delivered} of ${rows.length} rows were delivered.`.replace(";  ", "; "), response.status === 401 || response.status === 403 ? 3 : 5);
    }
    if (typeof answer?.board === "string") catalogue = answer.board;
    delivered += batch.length;
  }
  return { to: `sharednet${catalogue ? `:${catalogue}` : ""}`, kind: "sharednet", delivered };
}

/**
 * Rows somebody already made: a JSON file holding one row, an array of rows or `{rows: [...]}`,
 * or a directory of such files (what `--to <dir>` writes). Lets a folder that collected reports on
 * a machine with no route to the service be handed on from one that has.
 */
export async function readRows(path: string): Promise<ReportRow[]> {
  const files: string[] = [];
  const entry = await stat(path).catch(() => null);
  if (!entry) throw localError("invalid_arguments", `--rows ${path} is not a file or a directory.`);
  if (entry.isDirectory()) {
    for (const name of (await readdir(path)).sort()) if (name.endsWith(".json") && !name.startsWith(".")) files.push(join(path, name));
  } else {
    files.push(path);
  }
  const rows: ReportRow[] = [];
  for (const file of files) {
    const value = await readJson(file);
    const found = Array.isArray(value) ? value : record(value) && Array.isArray(value.rows) ? value.rows : [value];
    for (const row of found) {
      if (!record(row) || row.schema !== REPORT_SCHEMA || !text(row.room_id) || !record(row.metrics) || !record(row.config) || !record(row.performance)) {
        throw localError("invalid_arguments", `${file} holds something that is not a row \`goal report\` makes (schema ${REPORT_SCHEMA}).`);
      }
      rows.push({ ...(row as ReportRow), trace: record(row.trace) ? row.trace : { url: null, local_path: null, notes: null }, per_agent: Array.isArray(row.per_agent) ? (row.per_agent as Json[]) : [], tags: Array.isArray(row.tags) ? (row.tags as string[]) : [], goal_seq: count(row.goal_seq), id: text(row.id) ?? (row.room_id as string) });
    }
  }
  return rows;
}

/** `--score "<name>=<number>"`. */
export function parseReportScore(value: string | undefined): { name: string; value: number } | undefined {
  if (value === undefined) return undefined;
  const at = value.lastIndexOf("=");
  const name = at === -1 ? "" : value.slice(0, at).trim();
  const number = at === -1 ? Number.NaN : Number(value.slice(at + 1).trim());
  if (name.length === 0 || value.slice(at + 1).trim().length === 0 || !Number.isFinite(number)) {
    throw localError("invalid_arguments", '--score is a name and a number, such as --score "hidden tests passed=0.22".');
  }
  return { name, value: number };
}

/**
 * What `goal run` writes into its record about its own launch: the arguments after `sharednet`,
 * with a URL's name, password and query removed. The session and the key never reach here: one is
 * taken out of the arguments before a command sees them, the other is never an argument.
 */
export function launchArguments(argv: readonly string[]): string[] {
  return argv.map((argument) => {
    if (!/^https?:\/\//i.test(argument)) return argument;
    try {
      const url = new URL(argument);
      url.username = "";
      url.password = "";
      url.search = "";
      return url.toString();
    } catch {
      return argument;
    }
  });
}
