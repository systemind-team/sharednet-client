// @vitest-environment node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "./api-client.ts";
import { resolveGoalRunHarnessMode } from "./harness-modes.ts";
import {
  AGENT_DOCKERFILE,
  DEFAULT_IMAGE,
  GATEWAY_IMAGE,
  TurnReader,
  codexApi,
  codexSessionUsage,
  containerName,
  discoverCodeProvenance,
  freshTokens,
  geminiSetupCommand,
  gatewayTemplate,
  keyPlaceholders,
  isolationNames,
  loopbackPort,
  openingPrompt,
  parseAgents,
  prepareRun,
  routeWake,
  withoutTaskActs,
  runContainers,
  runGoal,
  scrubHome,
  turnCommand,
  parseDisallowedTools,
  wakePrompt,
  type DockerRunner,
  type RunPlan,
} from "./goal-run.ts";

const ROOM = "rom_AbCdEfGhIj";
const OWNER_KEY = "snk_owner-key-never-in-a-container";
const INVITE = "rit_invite-token-travels-by-environment";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("optional mention routing", () => {
  const seats = [{ name: "codex-1", member_id: "A" }, { name: "codex-2", member_id: "B" }];
  it.each([
    ["@codex-1 check this", ["codex-1"]],
    ["@B check this", ["codex-2"]],
    ["@all changed interface", ["codex-1", "codex-2"]],
    ["new public result", ["codex-1", "codex-2"]],
    ["@unknown result", ["codex-1", "codex-2"]],
  ])("routes %s while leaving broadcast available", (content, names) => {
    const wake = { wake_id: "w1", fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: content as string }] };
    expect(seats.filter(s => routeWake(wake, s, seats, "mentions").messages.length).map(s => s.name)).toEqual(names);
    expect(routeWake(wake, seats[0]!, seats, "broadcast")).toBe(wake);
  });

  it.each([
    ["@codex-1 check this", ["codex-1"]],
    ["@B check this", ["codex-2"]],
    ["@codex-1 @codex-2 both of you", ["codex-1", "codex-2"]],
    ["@all changed interface", ["codex-1", "codex-2"]],
    ["new public result", []],
    ["@unknown result", []],
    ["@codex-10 is not on the roster", []],
  ])("under mentions-only, %s wakes only the seats it names", (content, names) => {
    const wake = { wake_id: "w1", fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: content as string }] };
    expect(seats.filter(s => routeWake(wake, s, seats, "mentions-only").messages.length).map(s => s.name)).toEqual(names);
  });

  it("keeps, in one wake, only the lines addressed to the seat", () => {
    const wake = { wake_id: "w1", fired: ["message"], from: 1, through: 4, events: [], messages: [{ sequence: 2, content: "notes for the board" }, { sequence: 3, content: "@codex-2 please review" }, { sequence: 4, content: "@codex-1 rebase first" }] };
    expect(routeWake(wake, seats[0]!, seats, "mentions-only").messages.map(m => m.sequence)).toEqual([4]);
    expect(routeWake(wake, seats[0]!, seats, "mentions").messages.map(m => m.sequence)).toEqual([2, 4]);
  });
});

describe("task acts in wakes", () => {
  it("drops claims and completions, so a wake of task acts alone wakes nobody", () => {
    const act = '[sharednet-task:v1] {"op":"claim","title":"Parser"}';
    const wake = { wake_id: "w1", fired: ["message"], from: 1, through: 3, events: [], messages: [{ sequence: 2, content: act }, { sequence: 3, content: "build is green" }] };
    expect(withoutTaskActs(wake).messages.map(m => m.sequence)).toEqual([3]);
    expect(withoutTaskActs({ ...wake, messages: [wake.messages[0]!] }).messages).toEqual([]);
  });
});

async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "sharednet-goal-run-"));
  cleanup.push(dir);
  return dir;
}

describe("--agent", () => {
  it("names each seat after its driver, and takes a model after a colon", () => {
    expect(parseAgents(["codex:gpt-6-luna", "codex", "claude-code:claude-sonnet-5-5"])).toEqual([
      { name: "codex-1", driver: "codex", model: "gpt-6-luna" },
      { name: "codex-2", driver: "codex", model: null },
      { name: "claude-code-1", driver: "claude-code", model: "claude-sonnet-5-5" },
    ]);
    for (const raws of [[], ["unknown"], ["codex:bad model"], Array.from({ length: 129 }, () => "codex")]) {
      expect(() => parseAgents(raws), raws.join(" ")).toThrow();
    }
  });

  it("takes a model name with a router's variant after a colon of its own", () => {
    expect(parseAgents(["codex:qwen/qwen3.8-27b:nitro"])).toEqual([{ name: "codex-1", driver: "codex", model: "qwen/qwen3.8-27b:nitro" }]);
    expect(() => parseAgents(["codex::nitro"])).toThrow();
    expect(() => parseAgents(["codex:qwen 3"])).toThrow();
  });

  it("starts up to fifty, so a team can be scaled past eight", () => {
    const seats = parseAgents(Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? "codex" : "claude-code")));
    expect(seats).toHaveLength(50);
    expect(seats.at(-2)).toEqual({ name: "codex-25", driver: "codex", model: null });
    expect(seats.at(-1)).toEqual({ name: "claude-code-25", driver: "claude-code", model: null });
    expect(new Set(seats.map((seat) => seat.name)).size).toBe(50);
  });
});

describe("Gemini native turns", () => {
  const session = "12345678-1234-4234-8234-123456789abc";
  const init = { type: "init", session_id: session, model: "gemini-4-argon" };
  const result = { type: "result", status: "success", stats: { total_tokens: 107, input_tokens: 100, input: 20, cached: 80, output_tokens: 7, tool_calls: 1 } };

  it.each([32, 64, 128])("plans %i independently named Gemini agents", count => {
    const agents = parseAgents(Array.from({ length: count }, () => "gemini:gemini-4-argon"));
    expect(agents).toHaveLength(count);
    expect(agents.at(-1)).toEqual({ name: `gemini-${count}`, driver: "gemini", model: "gemini-4-argon" });
    expect(new Set(runContainers(ROOM, agents)).size).toBe(count + 1);
  });

  it("uses headless JSON and an explicit UUID on resume", () => {
    const seat = parseAgents(["gemini:gemini-3.8-flash"])[0]!;
    expect(turnCommand(seat, "first", null)).toEqual(["timeout", "1200", "gemini", "--approval-mode", "yolo", "--output-format", "stream-json", "--model", "gemini-3.8-flash", "--prompt", "first"]);
    expect(turnCommand(seat, "next", session)).toContain(session);
    for (const invalid of ["latest", "1", "", "wrong-session"]) expect(() => turnCommand(seat, "next", invalid)).toThrow(/UUID/u);
    expect(AGENT_DOCKERFILE).toContain("@google/gemini-cli@0.70.0");
  });

  it("keeps assistant chunks, tools and fresh usage from the current process", () => {
    const reader = new TurnReader("gemini", session);
    for (const event of [init, { type: "message", role: "user", content: "ignored" }, { type: "message", role: "assistant", content: "Re", delta: true }, { type: "message", role: "assistant", content: "ady", delta: true }, { type: "tool_use", tool_id: "t1", tool_name: "run_shell_command", parameters: { command: "true" } }, { type: "tool_result", tool_id: "t1", status: "error", error: { type: "exit", message: "retryable tool failure" } }, { type: "error", severity: "warning", message: "warning" }, result]) reader.line(JSON.stringify(event));
    reader.finish();
    expect(reader.reading).toEqual({ sessionId: session, usage: { input: 20, cached: 80, output: 7 }, failed: false });
    expect(reader.started).toBe(true);
    expect(reader.completed).toBe(true);
    expect(reader.text).toBe("Ready");
    expect(reader.toolCalls).toBe(1);
  });

  it("counts generated reasoning tokens from the total rather than only visible candidates", () => {
    const reader = new TurnReader("gemini");
    reader.line(JSON.stringify(init));
    reader.line(JSON.stringify({ ...result, stats: { total_tokens: 10_100, input_tokens: 100, input: 100, cached: 0, output_tokens: 10 } }));
    reader.finish();
    expect(reader.reading).toEqual({ sessionId: session, usage: { input: 100, cached: 0, output: 10_000 }, failed: false });
    expect(freshTokens(reader.reading.usage)).toBe(10_100);
  });

  it.each([
    [init],
    [result],
    [init, { ...result, status: "error", error: { type: "quota", message: "exhausted" } }],
    [init, { type: "error", severity: "error", message: "failed" }, result],
    [{ ...init, session_id: "87654321-1234-4234-8234-123456789abc" }, result],
    [init, { ...result, stats: { ...result.stats, input: -1 } }],
    [init, { ...result, stats: { ...result.stats, output_tokens: "7" } }],
    [init, { ...result, stats: { input_tokens: 100, input: 20, cached: 80, output_tokens: 7 } }],
    [init, { ...result, stats: { ...result.stats, total_tokens: 106 } }],
    [init, { ...result, stats: { ...result.stats, total_tokens: "107" } }],
    [init, { ...result, stats: { ...result.stats, cached: 101 } }],
    [init, result, result],
    [init, null, result],
    [init, { type: "tool_use", tool_id: "missing", tool_name: "run_shell_command", parameters: {} }, result],
    [init, { type: "tool_result", tool_id: "unknown", status: "success" }, result],
    [init, { type: "unrecognized" }, result],
  ])("refuses incomplete, mismatched and failed stream %j", (...events) => {
    const reader = new TurnReader("gemini", session);
    for (const event of events) reader.line(JSON.stringify(event));
    reader.finish();
    expect(reader.reading.failed).toBe(true);
    expect(reader.completed).toBe(false);
  });

  it("requires a Gemini API key and refuses isolation before containers start", async () => {
    const home = await temporary();
    await writeFile(join(home, "package.json"), "{}");
    const agents = parseAgents(Array.from({ length: 128 }, () => "gemini"));
    const input = { agents, image: "candidate:1", workspace: home, home, entry: join(home, "main.ts") };
    const { docker, calls } = fakeDocker(call => ({ stdout: call.args[0] === "run" ? "0.70.0\n" : "" }));
    await expect(prepareRun({ ...input, env: {} }, docker, () => undefined)).rejects.toMatchObject({ code: "agent_auth_missing" });
    const plan = await prepareRun({ ...input, env: { GEMINI_API_KEY: "synthetic-gemini-key" } }, docker, () => undefined);
    expect(plan.geminiAuth).toBe("GEMINI_API_KEY");
    expect(plan.agents).toHaveLength(128);
    const defaultPlan = await prepareRun({ ...input, image: null, env: { GEMINI_API_KEY: "synthetic-gemini-key" } }, docker, () => undefined);
    expect(defaultPlan.image).toBe("sharednet-goal-agents:2");
    await expect(prepareRun({ ...input, isolate: true, env: { GEMINI_API_KEY: "synthetic-gemini-key" } }, docker, () => undefined)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(calls.filter(call => call.args[0] === "run").every(call => call.args.includes("--version") && call.args.includes("none") && !call.args.includes("-e"))).toBe(true);
  });

  it.each([{ code: 127, stdout: "" }, { code: 0, stdout: "not a CLI version" }])("refuses a custom image without a working Gemini binary: %j", async response => {
    const home = await temporary();
    await writeFile(join(home, "package.json"), "{}");
    const { docker, calls } = fakeDocker(call => call.args[0] === "run" ? response : {});
    await expect(prepareRun({ agents: parseAgents(["gemini"]), image: "older-worker:1", workspace: home, home, entry: join(home, "main.ts"), env: { GEMINI_API_KEY: "synthetic-key" } }, docker, () => undefined)).rejects.toMatchObject({ code: "agent_runtime_missing" });
    expect(calls.some(call => call.args.includes("--detach"))).toBe(false);
  });

  it("executes a disposable Gemini binary twice with its actual headless command and persisted session", async () => {
    const home = await temporary();
    const binary = join(home, "gemini");
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args=process.argv.slice(2);\nif(args[args.indexOf('--output-format')+1]!=='stream-json'||!args.includes('--prompt'))process.exit(42);\nconst path=process.env.HOME+'/synthetic-session';\nconst resumed=args.includes('--resume');\nif(resumed&&args[args.indexOf('--resume')+1]!==fs.readFileSync(path,'utf8'))process.exit(1);\nfs.writeFileSync(path,'${session}');\nfor(const event of [${JSON.stringify(init)},{type:'message',role:'assistant',content:resumed?'resumed':'first'},${JSON.stringify(result)}])process.stdout.write(JSON.stringify(event)+'\\n');\n`, { mode: 0o700 });
    const seat = parseAgents(["gemini"])[0]!;
    for (const previous of [null, session]) {
      const command = turnCommand(seat, "synthetic prompt", previous, "live", 5);
      const output = execFileSync(command[0]!, command.slice(1), { env: { PATH: `${home}:/usr/bin:/bin`, HOME: home }, encoding: "utf8", timeout: 6_000 });
      const reader = new TurnReader("gemini", previous);
      for (const line of output.trim().split("\n")) reader.line(line);
      reader.finish();
      expect(reader.reading.failed).toBe(false);
      expect(reader.reading.sessionId).toBe(session);
      expect(reader.text).toBe(previous ? "resumed" : "first");
    }
  });

  it("removes Gemini sign-ins from the exported home while retaining its session", async () => {
    const home = await temporary();
    const folder = join(home, ".gemini");
    await mkdir(folder);
    for (const file of ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json", "mcp-oauth-tokens.json", "a2a-oauth-tokens.json", ".env", "session.json"]) await writeFile(join(folder, file), "synthetic");
    await scrubHome(home);
    for (const file of ["oauth_creds.json", "google_accounts.json", "gemini-credentials.json", "mcp-oauth-tokens.json", "a2a-oauth-tokens.json", ".env"]) await expect(readFile(join(folder, file))).rejects.toThrow();
    expect(await readFile(join(folder, "session.json"), "utf8")).toBe("synthetic");
  });

  it("writes auth and each run's web policy without changing the seat's own settings", async () => {
    const home = await temporary();
    await mkdir(join(home, ".gemini"));
    const ownSettings = '{"model":{"name":"synthetic-model"}}';
    await writeFile(join(home, ".gemini", "settings.json"), ownSettings);
    for (const web of ["off", "live"] as const) {
      const command = geminiSetupCommand(web);
      execFileSync(process.execPath, command.slice(1), { env: { HOME: home }, timeout: 5_000 });
      const settings = JSON.parse(await readFile(join(home, ".gemini", "sharednet-settings.json"), "utf8"));
      expect(settings.security.auth.selectedType).toBe("gemini-api-key");
      expect(settings.tools.exclude).toEqual(web === "off" ? ["google_web_search", "web_fetch"] : []);
      expect(await readFile(join(home, ".gemini", "settings.json"), "utf8")).toBe(ownSettings);
    }
  });
});

describe("a turn", () => {
  it("starts a harness with nothing asked of a person, and resumes the same session on the next wake", () => {
    const codex = { name: "codex-1", driver: "codex" as const, model: "gpt-6-luna" };
    expect(turnCommand(codex, "the goal", null)).toEqual([
      "timeout", "1200", "codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-c", 'web_search="live"', "-m", "gpt-6-luna", "the goal",
    ]);
    expect(turnCommand(codex, "new lines", "thread-1").slice(2, 5)).toEqual(["codex", "exec", "resume"]);
    expect(turnCommand(codex, "new lines", "thread-1").slice(-2)).toEqual(["thread-1", "new lines"]);
    const claude = { name: "claude-code-1", driver: "claude-code" as const, model: null };
    expect(turnCommand(claude, "new lines", "session-1")).toEqual([
      "timeout", "1200", "claude", "-p", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "--resume", "session-1", "new lines",
    ]);
  });

  it("stops a turn at the run's turn limit, 20 minutes unless the run sets another", () => {
    const codex = { name: "codex-1", driver: "codex" as const, model: null };
    expect(turnCommand(codex, "the goal", null, "live", 2700).slice(0, 3)).toEqual(["timeout", "2700", "codex"]);
    const claude = { name: "claude-code-1", driver: "claude-code" as const, model: null };
    expect(turnCommand(claude, "new lines", "session-1", "live", 2700).slice(0, 3)).toEqual(["timeout", "2700", "claude"]);
  });

  it("gives Codex a provider of its own for a model API other than OpenAI's, over HTTP", () => {
    const [codex] = parseAgents(["codex:qwen/qwen3.8-27b"]);
    expect(codexApi(undefined)).toEqual({ origin: "https://api.openai.com", path: "/v1", custom: false });
    expect(codexApi("https://openrouter.ai/api/v1/")).toEqual({ origin: "https://openrouter.ai", path: "/api/v1", custom: true });
    expect(codexApi("https://api.openai.com")).toEqual({ origin: "https://api.openai.com", path: "/v1", custom: false });
    expect(() => codexApi("ftp://openrouter.ai")).toThrow();
    const turn = turnCommand(codex!, "the goal", null, "off", 1200, { url: "http://gateway:8080/api/v1", custom: true }).join(" ");
    expect(turn).toContain('-c model_provider="goal_api"');
    expect(turn).toContain('-c model_providers.goal_api.base_url="http://gateway:8080/api/v1"');
    expect(turn).toContain('-c model_providers.goal_api.env_key="OPENAI_API_KEY"');
    expect(turn).toContain('-c model_providers.goal_api.wire_api="responses"');
    expect(turn).toContain("-c model_providers.goal_api.supports_websockets=false");
    expect(turn).toContain("-m qwen/qwen3.8-27b");
    expect(turn).not.toContain("openai_base_url");
    // How hard the model reasons is set only when the run says so.
    const tuned = turnCommand(codex!, "the goal", null, "off", 1200, null, { reasoningEffort: "medium", contextWindow: 262144, compactAt: 150000 }).join(" ");
    expect(tuned).toContain('-c model_reasoning_effort="medium"');
    expect(tuned).toContain("-c model_context_window=262144");
    expect(tuned).toContain("-c model_auto_compact_token_limit=150000");
    expect(turn).not.toContain("model_reasoning_effort");
    expect(turn).not.toContain("model_context_window");
    // OpenAI's own API keeps Codex's built-in provider, at the gateway when the run is isolated.
    const openai = turnCommand(codex!, "the goal", null, "off", 1200, { url: "http://gateway:8080/v1", custom: false }).join(" ");
    expect(openai).toContain('-c openai_base_url="http://gateway:8080/v1"');
    expect(openai).not.toContain("model_provider");
  });

  it("keeps the tools a run names from Claude Code seats, next to web search when that is off", () => {
    const claude = { name: "claude-code-1", driver: "claude-code" as const, model: null };
    expect(turnCommand(claude, "the goal", null, "live", 1200, null, {}, ["ScheduleWakeup"])).toEqual([
      "timeout", "1200", "claude", "-p", "--disallowedTools", "ScheduleWakeup", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "the goal",
    ]);
    expect(turnCommand(claude, "the goal", null, "off", 1200, null, {}, ["ScheduleWakeup"]).slice(4, 8)).toEqual(["--disallowedTools", "WebSearch", "WebFetch", "ScheduleWakeup"]);
    const codex = { name: "codex-1", driver: "codex" as const, model: null };
    expect(turnCommand(codex, "the goal", null, "live", 1200, null, {}, ["ScheduleWakeup"])).toEqual(turnCommand(codex, "the goal", null, "live"));
    expect(parseDisallowedTools(undefined)).toEqual([]);
    expect(parseDisallowedTools("ScheduleWakeup, CronCreate,ScheduleWakeup")).toEqual(["ScheduleWakeup", "CronCreate"]);
    expect(() => parseDisallowedTools(",")).toThrow(/comma-separated list/u);
    expect(() => parseDisallowedTools("Bash(rm *)")).toThrow(/comma-separated list/u);
  });

  it("takes web search away from every Agent when it is off, for a benchmark that forbids the internet", () => {
    const codex = { name: "codex-1", driver: "codex" as const, model: null };
    const off = turnCommand(codex, "the goal", null, "off");
    expect(off).toContain('web_search="disabled"');
    expect(off).not.toContain('web_search="live"');
    const claude = { name: "claude-code-1", driver: "claude-code" as const, model: null };
    // The list of denied tools ends at the next flag, so the prompt stays the prompt.
    expect(turnCommand(claude, "the goal", null, "off")).toEqual([
      "timeout", "1200", "claude", "-p", "--disallowedTools", "WebSearch", "WebFetch", "--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions", "the goal",
    ]);
  });

  it("reads the session to resume and the spend from each harness's own stream, cached reads apart", () => {
    const codex = new TurnReader("codex");
    for (const event of [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.completed", usage: { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 50 } },
    ]) {
      codex.line(JSON.stringify(event));
    }
    codex.line("not json");
    // Codex counts cached input inside input_tokens; only 200 of the 1,000 were read fresh.
    expect(codex.reading).toEqual({ sessionId: "thread-1", usage: { input: 200, cached: 800, output: 50 }, failed: false });
    expect(freshTokens(codex.reading.usage)).toBe(250);
    const failed = new TurnReader("codex");
    failed.line(JSON.stringify({ type: "turn.failed", error: { message: "quota" } }));
    expect(failed.reading.failed).toBe(true);

    const claude = new TurnReader("claude-code");
    claude.line(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1" }));
    claude.line(JSON.stringify({ type: "result", session_id: "session-1", is_error: false, usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3_000, output_tokens: 40 } }));
    expect(claude.reading).toEqual({ sessionId: "session-1", usage: { input: 210, cached: 3_000, output: 40 }, failed: false });
  });

  it("reads a Codex session file's own running total, the last one written", () => {
    const line = (total: Record<string, number> | null) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: total ? { total_token_usage: total } : null } });
    const rollout = [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
      line(null),
      line({ input_tokens: 1_000, cached_input_tokens: 900, output_tokens: 10 }),
      line({ input_tokens: 2_449_151, cached_input_tokens: 2_321_664, output_tokens: 9_678 }),
      '{"type":"event_msg","payload":{"type":"token_cou',
    ].join("\n");
    expect(codexSessionUsage(rollout)).toEqual({ input: 127_487, cached: 2_321_664, output: 9_678 });
    expect(codexSessionUsage("")).toBeNull();
  });

  it("tells each Agent who it is, the goal, how the Room ends, and how to speak; a wake carries what was said", () => {
    const seats = parseAgents(["codex", "claude-code"]);
    const opening = openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: "Make the tests pass.\n", goalSequence: 1, until: ["check pytest -q", "said DONE", "after 1h"] });
    expect(opening).toContain("You are codex-1, one of 2 agents");
    expect(opening).toContain("The others: claude-code-1.");
    expect(opening).toContain("<goal>\nMake the tests pass.\n</goal>");
    expect(opening).toContain('Say "DONE" in the Room only when you believe the goal is met');
    expect(opening).toContain("Do not run `sharednet wait`");
    // Each Agent has a container of its own, so it is told what it shares and what it does not.
    expect(opening).toContain("You share this directory (/workspace) with the others, and only this one");
    const wake = wakePrompt({
      wake_id: "wk_1",
      fired: ["message"],
      from: 3,
      through: 5,
      events: [],
      messages: [
        { sequence: 4, content: "I take the parser.", sender: { member_id: "i_b", name: "claude-code-1" } },
        { sequence: 5, content: "check failed", sender: { member_id: "i_r", name: "runner" } },
      ],
    });
    expect(wake).toContain("#4 claude-code-1: I take the parser.");
    expect(wake).toContain("#5 runner: check failed");
  });

  it("gives a single seat a single-agent role without teammate instructions", () => {
    const seats = parseAgents(["codex:gpt-test"]);
    const opening = openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: "Make the tests pass.", goalSequence: 1, until: ["said DONE", "after 1h"] });
    expect(opening).toContain("You are codex-1, the only agent working on one goal");
    expect(opening).toContain("You work in this directory (/workspace)");
    expect(opening).not.toContain("The others:");
    expect(opening).not.toContain("with the others");
    expect(opening).not.toContain("Agree in the Room who does what");
    expect(opening).not.toContain("## Cooperative turns");
  });

  it("opts into bounded cooperative work without changing completion requirements or assigning specialist roles", () => {
    const seats = parseAgents(["codex:gpt-test", "codex:gpt-test"]);
    const input = { seat: seats[0]!, seats, roomId: ROOM, goal: "Make the tests pass.", goalSequence: 1, until: ["said /^DONE$/", "after 1h"] };
    const opening = openingPrompt({ ...input, turnPolicy: "cooperative-v1" });
    expect(opening).toContain("## Cooperative turns");
    expect(opening).toContain("Responsibilities are negotiated dynamically");
    expect(opening).toContain("Complete one coherent unit:");
    expect(opening).toContain("Then finish your response and end your turn.");
    expect(opening).toContain("If blocked on a teammate, post the specific request");
    expect(opening).toContain("Do not wait, sleep, poll");
    expect(opening).toContain("Ending a turn is a handoff, not a declaration of team completion.");
    expect(opening).toContain('Say "/^DONE$/" in the Room only when you believe the goal is met');
    expect(opening).not.toContain("do your part, and end your turn when there is nothing more to do now");
    expect(openingPrompt(input)).not.toContain("## Cooperative turns");
    expect(openingPrompt({ ...input, turnPolicy: "legacy" })).toBe(openingPrompt(input));
    const wake = { wake_id: "wk_cooperative", fired: ["message"], events: [], from: 1, through: 2, messages: [{ sequence: 2, content: "Please review.", sender: { name: "codex-2" } }] };
    expect(wakePrompt(wake, "cooperative-v1")).toContain("#2 codex-2: Please review.");
    expect(wakePrompt(wake, "cooperative-v1")).toContain("A handoff is not DONE.");
    expect(wakePrompt(wake)).toBe(wakePrompt(wake, "legacy"));
    expect(wakePrompt(wake)).not.toContain("cooperative-turn policy");
  });

  it("tells each seat which messages will wake it, for either mention routing", () => {
    const seats = parseAgents(["codex:gpt-test", "codex:gpt-test"]);
    const told = (messageRouting: "mentions" | "mentions-only") => openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: "Make the tests pass.", goalSequence: 1, until: ["said DONE", "after 1h"], messageRouting });
    expect(told("mentions-only")).toContain("A message that names nobody wakes nobody");
    expect(told("mentions-only")).toContain("@all wakes everyone");
    expect(told("mentions-only")).not.toContain("unknown-only names broadcast");
    expect(told("mentions")).toContain("unknown-only names broadcast");
    expect(told("mentions")).not.toContain("wakes nobody");
  });

  it("forwards only a development service on this machine's loopback into the container", () => {
    expect(loopbackPort("http://127.0.0.1:3117")).toBe(3117);
    expect(loopbackPort("https://www.sharednet.ai")).toBeNull();
  });
});

type DockerCall = { args: readonly string[]; env: Record<string, string>; input?: string };

/** Docker as goal run uses it, answering from a script. */
function fakeDocker(answer: (call: DockerCall, command: readonly string[]) => { code?: number; stdout?: string; stderr?: string; lines?: string[] } | Promise<{ code?: number; stdout?: string; stderr?: string; lines?: string[] }>) {
  const calls: DockerCall[] = [];
  const docker: DockerRunner = async (args, options = {}) => {
    const call: DockerCall = { args, env: options.env ?? {}, ...(options.input === undefined ? {} : { input: options.input }) };
    calls.push(call);
    // Every container of the run is named for the Room: an Agent's adds its seat.
    const container = args.findIndex((arg) => arg.startsWith(containerName(ROOM)));
    const command = args[0] === "exec" && container !== -1 ? args.slice(container + 1) : [];
    const result = await answer(call, command);
    for (const line of result.lines ?? []) options.onLine?.(line);
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { docker, calls };
}

describe("prepareRun", () => {
  const agents = parseAgents(["codex", "claude-code"]);

  it("refuses before anything exists: no Docker, a missing image, or a driver that cannot sign in", async () => {
    const home = await temporary();
    const entry = join(home, "cli", "src", "main.ts");
    await mkdir(join(home, "cli", "src"), { recursive: true });
    await writeFile(join(home, "cli", "package.json"), "{}");
    const base = { agents, image: null, workspace: home, home, entry };
    const down = fakeDocker(() => ({ code: 1 }));
    const pause = async () => undefined;
    await expect(prepareRun({ ...base, env: {} }, down.docker, () => undefined, pause)).rejects.toMatchObject({ code: "docker_unavailable" });

    const noImage = fakeDocker((call) => ({ code: call.args[0] === "image" ? 1 : 0 }));
    await expect(prepareRun({ ...base, image: "mine:1", env: {} }, noImage.docker, () => undefined, pause)).rejects.toMatchObject({ code: "image_not_found" });
    // No Codex login and no key: refused, though the image was built.
    await expect(prepareRun({ ...base, env: { ANTHROPIC_API_KEY: "sk-test" } }, noImage.docker, () => undefined, pause)).rejects.toMatchObject({ code: "agent_auth_missing" });
    expect(noImage.calls.find((call) => call.args[0] === "build")).toMatchObject({ args: ["build", "-t", DEFAULT_IMAGE, "-"], input: AGENT_DOCKERFILE });

    // Docker Desktop waking from idle: the image is there on the third look, and nothing is built.
    let looks = 0;
    const waking = fakeDocker((call) => ({ code: call.args[0] === "image" && ++looks < 3 ? 1 : 0 }));
    await prepareRun({ ...base, env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-test" } }, waking.docker, () => undefined, pause);
    expect(looks).toBe(3);
    expect(waking.calls.some((call) => call.args[0] === "build")).toBe(false);

    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "{}");
    const ready = fakeDocker(() => ({ code: 0 }));
    await expect(prepareRun({ ...base, env: {} }, ready.docker, () => undefined)).rejects.toMatchObject({ code: "agent_auth_missing" });
    const plan = await prepareRun({ ...base, env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test" } }, ready.docker, () => undefined);
    expect(plan).toMatchObject({
      image: DEFAULT_IMAGE,
      codexAuth: { kind: "login", file: realpathSync(join(home, ".codex", "auth.json")) },
      claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN",
      cli: { root: join(home, "cli"), entry: join("src", "main.ts") },
    });
    const withKey = await prepareRun({ ...base, env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-test" } }, ready.docker, () => undefined);
    expect(withKey).toMatchObject({ codexAuth: { kind: "api-key" }, claudeAuth: "ANTHROPIC_API_KEY" });
  });
});

describe("runGoal", () => {
  it.each([false, true])("bounds 128 native agent turns to eight and cancels pending work on end (cancel=%s)", async cancel => {
    const out = await temporary();
    const agents = parseAgents(Array.from({ length: 128 }, () => "gemini"));
    let active = 0;
    let peak = 0;
    let started = 0;
    let finished = 0;
    let stopped = false;
    let afterStop = 0;
    const releases: Array<() => void> = [];
    const { docker, calls } = fakeDocker(async (call, command) => {
      if (call.args[0] === "stop" || call.args[0] === "rm") { stopped = true; for (const release of releases.splice(0)) release(); }
      if (command[0] === "sharednet" && command[1] === "join") return { stdout: JSON.stringify({ member_id: `i_Gemini${command.at(-2)!.split("-").at(-1)}` }) };
      if (command[2] === "gemini") {
        if (stopped) afterStop += 1;
        started += 1;
        active += 1;
        peak = Math.max(peak, active);
        if (cancel) await new Promise<void>(resolve => releases.push(resolve));
        else await new Promise(resolve => setTimeout(resolve, 2));
        active -= 1;
        finished += 1;
        return { lines: [JSON.stringify({ type: "init", session_id: "12345678-1234-4234-8234-123456789abc", model: "gemini-4-argon" }), JSON.stringify({ type: "result", status: "success", stats: { total_tokens: 16, input_tokens: 3, input: 1, cached: 2, output_tokens: 3 } })] };
      }
      if (command[0] === "sharednet" && command[1] === "wait") return { stdout: JSON.stringify({ fired: ["closed"], messages: [] }) };
      return {};
    });
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["said DONE", "after 2h"], started_at: "2026-11-21T00:00:00.000Z", ended_by: null };
    const client = { async request(method: string, path: string, _token: string, body?: object) {
      if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, state: "open", type: "board", goal }, memberships: [] };
      if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
        await new Promise(resolve => setTimeout(resolve, 2));
        return { items: (cancel ? started >= 8 : finished === 128) ? [{ sequence: 2, content: "DONE", sender: { member_id: "i_synthetic", name: "someone" }, created_at: goal.started_at }] : [] };
      }
      if (method === "POST" && path.endsWith("/close")) return { room: { state: "closed", goal: { ...goal, ended_by: { ...body, at: goal.started_at } } } };
      throw new Error(`Unexpected ${method} ${path}`);
    } } as unknown as ApiClient;
    const result = await runGoal(client, "sni_synthetic", OWNER_KEY, { plan: { image: "synthetic:1", agents, workspace: out, cli: { root: "/opt/synthetic", entry: "main.js" }, codexAuth: null, claudeAuth: null, geminiAuth: "GEMINI_API_KEY" }, roomId: ROOM, inviteToken: INVITE, goal: "bounded synthetic agents", goalSequence: 1, until: goal.until, baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: false }, { docker, now: () => new Date(goal.started_at), sleep: async () => undefined });
    expect(peak).toBe(8);
    expect(started).toBe(cancel ? 8 : 128);
    expect(afterStop).toBe(0);
    expect(result.agents).toHaveLength(128);
    expect(result.tokens).toBe((cancel ? 8 : 128) * 14);
    expect(calls.filter(call => call.args[0] === "run")).toHaveLength(129);
    expect(calls.at(-1)?.args).toEqual(["rm", "--force", ...runContainers(ROOM, agents)]);
    const episode = JSON.parse(await readFile(join(out, "episode.json"), "utf8"));
    expect(episode.max_active_turns).toBe(8);
    const joinCall = calls.find(call => call.args.includes("join"));
    expect(joinCall?.env).toMatchObject({ GEMINI_CLI: "1" });
    expect(calls.filter(call => call.args.includes("gemini")).every(call => call.args.includes("GEMINI_API_KEY"))).toBe(true);
  });

  it("does not report a dirty source checkout as the clean client and runner commit", async () => {
    const root = await temporary();
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"name":"sharednet","version":"0.1.16"}\n');
    await writeFile(join(root, "src", "main.ts"), "export const version = 1;\n");
    for (const args of [
      ["init", "-q"],
      ["config", "user.name", "Harness Test"],
      ["config", "user.email", "harness@example.invalid"],
      ["remote", "add", "origin", "https://github.com/systemind-team/sharednet-client.git"],
      ["add", "."],
      ["commit", "-qm", "fixture"],
    ]) execFileSync("git", args, { cwd: root });

    const clean = await discoverCodeProvenance({ root, entry: "src/main.ts" });
    expect(clean).toMatchObject({
      clientCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      runnerCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      sourceWorktreeDirty: false,
      codeTreeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await writeFile(join(root, "src", "main.ts"), "export const version = 2;\n");
    const dirty = await discoverCodeProvenance({ root, entry: "src/main.ts" });
    expect(dirty).toMatchObject({ clientCommit: null, runnerCommit: null, sourceWorktreeDirty: true });
    expect(dirty.codeTreeSha256).not.toBe(clean.codeTreeSha256);
  });

  it("refuses metadata that names a frozen mode but resolves to different controls", async () => {
    const out = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex"]),
      workspace: out,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    let dockerCalls = 0;
    await expect(runGoal(
      {} as ApiClient,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan,
        roomId: ROOM,
        inviteToken: INVITE,
        goal: "g",
        goalSequence: 1,
        until: ["after 1h"],
        baseUrl: "https://www.sharednet.ai",
        out,
        checkEveryMs: 60_000,
        quietChecks: false,
        mentionGate: true,
        harnessMode: resolveGoalRunHarnessMode("research/baseline@1"),
      },
      { docker: async () => { dockerCalls += 1; return { code: 0, stdout: "", stderr: "" }; }, now: () => new Date() },
    )).rejects.toMatchObject({ code: "harness_mode_mismatch" });
    expect(dockerCalls).toBe(0);
  });

  it("enforces a frozen one-seat constraint before Docker work", async () => {
    const out = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex:gpt-test", "codex:gpt-test"]),
      workspace: out,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    const baseline = resolveGoalRunHarnessMode("research/baseline@1");
    const constrained = { ...baseline, profile: { ...baseline.profile, agents: 1 as const } };
    let dockerCalls = 0;
    await expect(runGoal(
      {} as ApiClient,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan,
        roomType: "board",
        roomId: ROOM,
        inviteToken: INVITE,
        goal: "g",
        goalSequence: 1,
        until: ["after 1h"],
        baseUrl: "https://www.sharednet.ai",
        out,
        checkEveryMs: 60_000,
        quietChecks: false,
        harnessMode: constrained,
        codeProvenance: {
          clientCommit: "1".repeat(40),
          runnerCommit: "1".repeat(40),
          sourceWorktreeDirty: false,
          packageVersion: "0.1.16",
          packageManifestSha256: "2".repeat(64),
          entrySha256: "3".repeat(64),
          codeTreeSha256: "4".repeat(64),
        },
      },
      { docker: async () => { dockerCalls += 1; return { code: 0, stdout: "", stderr: "" }; }, now: () => new Date() },
    )).rejects.toMatchObject({ code: "harness_agent_count_mismatch" });
    expect(dockerCalls).toBe(0);
  });

  it("refuses a frozen mode from a dirty source checkout before Docker work", async () => {
    const out = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex:gpt-6.1-sol"]),
      workspace: out,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    let dockerCalls = 0;
    await expect(runGoal(
      {} as ApiClient,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan,
        roomType: "board",
        roomId: ROOM,
        inviteToken: INVITE,
        goal: "g",
        goalSequence: 1,
        until: ["after 1h"],
        baseUrl: "https://www.sharednet.ai",
        out,
        checkEveryMs: 60_000,
        quietChecks: false,
        harnessMode: resolveGoalRunHarnessMode("research/baseline@1"),
        codeProvenance: {
          clientCommit: null,
          runnerCommit: null,
          sourceWorktreeDirty: true,
          packageVersion: "0.1.16",
          packageManifestSha256: "1".repeat(64),
          entrySha256: "2".repeat(64),
          codeTreeSha256: "3".repeat(64),
        },
      },
      { docker: async () => { dockerCalls += 1; return { code: 0, stdout: "", stderr: "" }; }, now: () => new Date() },
    )).rejects.toMatchObject({ code: "dirty_harness_source" });
    expect(dockerCalls).toBe(0);
  });

  it.each([
    ["board", false, false, "legacy"],
    ["compiled", false, false, "legacy"],
    ["board", true, false, "legacy"],
    ["board", false, true, "legacy"],
    ["board", true, true, "legacy"],
    ["board", false, false, "cooperative-v1"],
  ] as const)("runs every %s seat with mention=%s task=%s turn-policy=%s until the budget is spent and keeps credentials private", async (roomType, mentionGate, taskGate, turnPolicy) => {
    const out = await temporary();
    const workspace = await temporary();
    const cliRoot = await temporary();
    const packageManifest = '{"name":"sharednet","version":"0.1.16-test"}\n';
    const entrySource = 'import "../dist/main.js";\n';
    await mkdir(join(cliRoot, "src"), { recursive: true });
    await writeFile(join(cliRoot, "package.json"), packageManifest);
    await writeFile(join(cliRoot, "src", "main.ts"), entrySource);
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex:gpt-6-luna", "codex:gpt-6.1-sol"]),
      workspace,
      cli: { root: cliRoot, entry: "src/main.ts" },
      codexAuth: { kind: "login", file: "/Users/someone/.codex/auth.json" },
      claudeAuth: null,
    };
    const waits = new Map<string, number>();
    const turnsTaken = new Map<string, number>();
    const { docker, calls } = fakeDocker(async (call, command) => {
      const seat = call.args.find((arg) => arg.startsWith("SHAREDNET_SEAT="))?.slice("SHAREDNET_SEAT=".length) ?? null;
      if (command[0] === "sharednet" && command[1] === "join") {
        const name = command[command.indexOf("--name") + 1]!;
        return { stdout: JSON.stringify({ member_id: name === "codex-1" ? "i_CodexOne01" : "i_CodexTwo02" }) };
      }
      if (command[0] === "sharednet" && command[1] === "open") return { stdout: JSON.stringify({ protocol_version: "rac/1", sequence: (turnsTaken.get(seat!) ?? 0) + 1, digest: "abc", projection: { work: {} }, obligations: `Personal obligation for ${seat}`, events: [] }) };
      if (command[2] === "codex") {
        const resumed = command[4] === "resume";
        const turn = (turnsTaken.get(seat!) ?? 0) + 1;
        turnsTaken.set(seat!, turn);
        // A resumed session reports its running total: 300 fresh tokens per turn here.
        return {
          lines: [
            ...(resumed ? [] : [JSON.stringify({ type: "thread.started", thread_id: `thread-${seat}` })]),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "on it" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000 * turn, cached_input_tokens: 800 * turn, output_tokens: 100 * turn } }),
          ],
        };
      }
      if (command[0] === "sharednet" && command[1] === "wait") {
        const count = (waits.get(seat!) ?? 0) + 1;
        waits.set(seat!, count);
        if (mentionGate && seat === "i_CodexTwo02") {
          if (count === 1) return { stdout: JSON.stringify({ wake_id: "skip_two", fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: "@codex-1 handoff" }] }) };
          if (count === 2) return { stdout: JSON.stringify({ wake_id: "wk_i_CodexTwo02", fired: ["message"], from: 2, through: 3, events: [], messages: [{ sequence: 3, content: "@all shared result" }] }) };
        }
        // One wake each, then the Room closes.
        const wake =
          count === 1
            ? { wake_id: `wk_${seat}`, fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: "split it", sender: { member_id: "i_x", name: "codex-x" } }] }
            : { wake_id: null, fired: ["closed"], from: 2, through: 2, events: [{ kind: "closed" }], messages: [] };
        return { stdout: JSON.stringify(wake) };
      }
      if (call.args[0] === "cp") {
        const target = call.args[2]!;
        await mkdir(join(target, ".config", "sharednet", "rooms"), { recursive: true });
        await writeFile(join(target, ".config", "sharednet", "rooms", "seat.json"), '{"member_token":"sni_secret"}');
        await mkdir(join(target, ".codex", "sessions", "2026", "10", "05"), { recursive: true });
        await writeFile(join(target, ".codex", "auth.json"), "{}");
        // codex-1's session file saw more than its stream reported: a turn the end cut.
        const total = target.includes("codex-1")
          ? { input_tokens: 5_000, cached_input_tokens: 4_000, output_tokens: 300 }
          : { input_tokens: 2_000, cached_input_tokens: 1_600, output_tokens: 200 };
        const session = target.includes("codex-1") ? "thread-i_CodexOne01" : "thread-i_CodexTwo02";
        await writeFile(
          join(target, ".codex", "sessions", "2026", "10", "05", `rollout-2026-10-05T12-00-00-${session}.jsonl`),
          `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } })}\n`,
        );
      }
      return {};
    });

    // The Room as goal watch reads it: the budget is the end that fires.
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["budget 1k tokens", "after 2h"], started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
    const requests: string[] = [];
    const client = {
      async request(method: string, path: string, token: string, body?: unknown) {
        requests.push(`${method} ${path} ${token}`);
        if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, type: roomType, state: "open", goal }, memberships: [] };
        if (method === "GET" && path === `/rooms/${ROOM}/state`) return { protocol_version: "rac/1", sequence: 2, digest: "final-digest", projection: { work: {} }, obligations: "none", events: [{ seq: 1 }, { seq: 2 }] };
        if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { items: [] };
        }
        if (method === "POST" && path === `/rooms/${ROOM}/close`) {
          return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: "2026-10-05T12:05:00.000Z" } } } };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    } as unknown as ApiClient;

    let tick = Date.parse("2026-10-05T12:00:00.000Z");
    const harnessMode = roomType === "board" && !mentionGate && !taskGate && turnPolicy === "legacy"
      ? resolveGoalRunHarnessMode("research/baseline@1")
      : undefined;
    const result = await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan,
        roomType,
        mentionGate,
        taskGate,
        roomId: ROOM,
        inviteToken: INVITE,
        goal: "Make it pass.",
        goalSequence: 1,
        until: goal.until,
        baseUrl: "http://127.0.0.1:3117",
        out,
        checkEveryMs: 60_000,
        quietChecks: false,
        turnPolicy,
        ...(harnessMode ? {
          harnessMode,
        } : {}),
      },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );

    // Two turns each, 300 fresh tokens a turn: the budget ends the goal at 1,200, cached reads uncounted.
    expect(result.ended_by).toMatchObject({ trigger: "budget 1k tokens", detail: "1200 tokens" });
    // The record then takes each session's own file: codex-1's saw a cut turn (1,300), codex-2's matches its stream (600).
    expect(result.tokens).toBe(1_900);
    if (roomType === "compiled") {
      expect(JSON.parse(await readFile(join(out, "state.json"), "utf8"))).toMatchObject({ digest: "final-digest", sequence: 2 });
      expect((await readFile(join(out, "acts.ndjson"), "utf8")).trim().split("\n")).toHaveLength(2);
    }
    expect(result.agents.map((seat) => [seat.name, seat.tokens, seat.usage])).toEqual([
      ["codex-1", 1_300, { input: 1_000, cached: 4_000, output: 300 }],
      ["codex-2", 600, { input: 400, cached: 1_600, output: 200 }],
    ]);
    expect(result.agents.map((seat) => [seat.name, seat.member_id, seat.session_id, seat.turns])).toEqual([
      ["codex-1", "i_CodexOne01", "thread-i_CodexOne01", 2],
      ["codex-2", "i_CodexTwo02", "thread-i_CodexTwo02", 2],
    ]);

    // The second turn resumes the first turn's session, with the wake as its prompt, and the wake is then acknowledged.
    const turns = calls.filter((call) => call.args.includes("codex"));
    expect(turns.filter((call) => call.args.includes("resume") && call.args.includes("thread-i_CodexOne01"))).toHaveLength(1);
    // Every turn carries SHAREDNET_WAKE=off, so an agent's own `sharednet join` mid-turn starts no wake service.
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every(call => call.args.includes("SHAREDNET_MENTION_GATE=1") === mentionGate)).toBe(true);
    expect(turns.every(call => call.args.includes("SHAREDNET_TASK_GATE=1") === taskGate)).toBe(true);
    expect(turns.filter(call => !call.args.includes("resume")).every(call => call.args.includes("SHAREDNET_TURN_THROUGH=1"))).toBe(true);
    expect(turns.filter(call => call.args.includes("resume")).every(call => call.args.includes(`SHAREDNET_TURN_THROUGH=${mentionGate && call.args.includes("SHAREDNET_SEAT=i_CodexTwo02") ? 3 : 2}`))).toBe(true);
    if (mentionGate) {
      const routing = (await readFile(join(out, "routing.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(routing).toContainEqual(expect.objectContaining({ seat: "codex-2", skipped: [2], model_wake: false }));
      expect(calls.some(call => call.args.includes("ack") && call.args.includes("skip_two"))).toBe(true);
    }
    const initial = turns.find(call => !call.args.includes("resume"))!.args.at(-1)!;
    expect(initial.includes("## Cooperative turns")).toBe(turnPolicy === "cooperative-v1");
    expect(turns.filter(call => call.args.includes("resume")).every(call => call.args.at(-1)!.includes("A handoff is not DONE.") === (turnPolicy === "cooperative-v1"))).toBe(true);
    expect(initial.includes("Before doing work, understand the goal and claim")).toBe(taskGate);
    expect(initial.includes("Before you say something")).toBe(mentionGate);
    if (taskGate) {
      const taskPaths = turns.map(call => call.args.find(arg => arg.startsWith("SHAREDNET_TASK_FILE=")));
      expect(new Set(taskPaths).size).toBe(2);
    }
    const opens = calls.filter((call) => call.args.includes("open"));
    expect(opens).toHaveLength(roomType === "compiled" ? turns.length : 0);
    if (roomType === "compiled") {
      expect(turns.every((call) => call.args.at(-1)!.includes("Personal obligation for"))).toBe(true);
      expect(turns[0]!.args.at(-1)).toContain("i_CodexTwo02");
      expect(turns[0]!.args.at(-1)).toContain("sharednet act --data");
      expect(turns[0]!.args.at(-1)!.match(/This is a compiled Room/g)).toHaveLength(1);
      expect(turns[0]!.args.at(-1)).toContain("result_ref");
    }

    expect(turns.every((call) => call.args.join(" ").includes("-e SHAREDNET_WAKE=off"))).toBe(true);
    // Web search is live unless the run turns it off, and the record says which.
    expect(turns.every((call) => call.args.includes('web_search="live"'))).toBe(true);
    expect(calls.some((call) => call.args.join(" ").endsWith("sharednet ack wk_i_CodexOne01 --json"))).toBe(true);
    // Each seat joins with the invite in its environment, under its own home and name.
    const join1 = calls.find((call) => call.args.includes("join") && call.args.includes("codex-1"))!;
    expect(join1.env).toMatchObject({ SHAREDNET_INVITE_TOKEN: INVITE, CODEX_SESSION_ID: "goal-codex-1" });
    expect(join1.args.join(" ")).toContain("-e SHAREDNET_WAKE=off");
    expect(join1.args).toContain("HOME=/home/agents/codex-1");
    // The Agents use the runner's own address: the port is forwarded to this machine inside the container.
    expect(join1.args).toContain("SHAREDNET_BASE_URL=http://127.0.0.1:3117");
    expect(calls.find((call) => call.args.includes("--detach") && call.args[0] === "exec")!.args.slice(-1)).toEqual(["3117"]);
    expect(join1.args.join(" ")).not.toContain(INVITE);
    // The owner's key reads and closes the Room from this machine; no call into Docker ever carries it.
    expect(requests.some((line) => line === `POST /rooms/${ROOM}/close ${OWNER_KEY}`)).toBe(true);
    expect(calls.every((call) => !JSON.stringify(call).includes(OWNER_KEY))).toBe(true);
    // Each Agent runs in its own container and the checks in one more; every one mounts the shared workspace.
    const runs = calls.filter((call) => call.args[0] === "run");
    const named = (name: string) => runs.find((call) => call.args[call.args.indexOf("--name") + 1] === name)!;
    expect(runs.map((call) => call.args[call.args.indexOf("--name") + 1])).toEqual([containerName(ROOM), containerName(ROOM, "codex-1"), containerName(ROOM, "codex-2")]);
    expect(runs.every((call) => call.args.includes(`${workspace}:/workspace`))).toBe(true);
    // The host login stays read-only. Root copies it into each Agent's own home,
    // then gives only that Agent permission to read the private 0600 file. A
    // symlink would retain the host UID and fail when the image's UID differs.
    expect(named(containerName(ROOM, "codex-1")).args).toContain("/Users/someone/.codex/auth.json:/run/codex/auth.json:ro");
    expect(named(containerName(ROOM)).args.join(" ")).not.toContain("auth.json");
    const loginCopies = calls.filter((call) => call.args[0] === "exec" && call.args.includes("--user") && call.args[call.args.indexOf("--user") + 1] === "root" && call.args.join(" ").includes("cp /run/codex/auth.json"));
    expect(loginCopies).toHaveLength(2);
    expect(loginCopies.every((call) => call.args.join(" ").includes("chown -R node") && call.args.join(" ").includes("chmod 600"))).toBe(true);
    expect(calls.every((call) => !call.args.join(" ").includes("ln -sf /run/codex/auth.json"))).toBe(true);
    // Everything a seat runs, its join, its turns, its waits, runs in that seat's container alone.
    const asSeat = (memberId: string) => calls.filter((call) => call.args.includes(`SHAREDNET_SEAT=${memberId}`));
    expect(asSeat("i_CodexTwo02").length).toBeGreaterThan(0);
    expect(asSeat("i_CodexTwo02").every((call) => call.args.includes(containerName(ROOM, "codex-2")))).toBe(true);
    expect(asSeat("i_CodexOne01").every((call) => call.args.includes(containerName(ROOM, "codex-1")))).toBe(true);
    // Each Agent's container gets its own forwarder and its own sharednet command.
    const forwarders = calls.filter((call) => call.args[0] === "exec" && call.args.includes("--detach"));
    const target = (call: DockerCall) => call.args.find((arg) => arg.startsWith(containerName(ROOM)));
    expect(forwarders.map(target)).toEqual([containerName(ROOM, "codex-1"), containerName(ROOM, "codex-2")]);
    const installs = calls.filter((call) => call.args.join(" ").includes("cat > /usr/local/bin/sharednet"));
    expect(installs.map(target)).toEqual([containerName(ROOM, "codex-1"), containerName(ROOM, "codex-2")]);
    // Every container is stopped, each home is copied out of its own Agent's container, and every container is removed.
    const kinds = calls.map((call) => call.args[0]);
    expect(kinds.lastIndexOf("stop")).toBeLessThan(kinds.indexOf("cp"));
    expect(calls.find((call) => call.args[0] === "stop")!.args).toEqual(["stop", "--time", "5", ...runContainers(ROOM, plan.agents)]);
    expect(calls.filter((call) => call.args[0] === "cp").map((call) => call.args[1])).toEqual([
      `${containerName(ROOM, "codex-1")}:/home/agents/codex-1`,
      `${containerName(ROOM, "codex-2")}:/home/agents/codex-2`,
    ]);
    expect(calls.at(-1)!.args).toEqual(["rm", "--force", ...runContainers(ROOM, plan.agents)]);

    // The record: one line per turn, each Agent's stream and home, the token totals.
    const wakes = (await readFile(join(out, "wakes.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(wakes).toHaveLength(4);
    expect(wakes.find((line) => line.seat === "codex-1" && line.turn === 2)).toMatchObject({ wake_id: "wk_i_CodexOne01", fired: ["message"], tokens: 300 });
    expect(await readFile(join(out, "agents", "codex-1", "turn-001.jsonl"), "utf8")).toContain("thread.started");
    const home = join(out, "agents", "codex-1", "home");
    expect(await readFile(join(home, ".codex", "sessions", "2026", "10", "05", "rollout-2026-10-05T12-00-00-thread-i_CodexOne01.jsonl"), "utf8")).toContain("token_count");
    await expect(readFile(join(home, ".codex", "auth.json"))).rejects.toThrow();
    await expect(readFile(join(home, ".config", "sharednet", "rooms", "seat.json"))).rejects.toThrow();
    const episode = JSON.parse(await readFile(join(out, "episode.json"), "utf8"));
    expect(episode).toMatchObject({ image: DEFAULT_IMAGE, web_search: "live", turn_limit_s: 1200, turn_policy: turnPolicy, totals: { tokens: 1_900, cached_tokens: 5_600 }, ended_by: { trigger: "budget 1k tokens" } });
    expect(episode.harness.resolved_profile.turn_policy).toBe(turnPolicy);
    expect(episode.agents).toHaveLength(2);
    if (harnessMode) {
      expect(episode.harness).toMatchObject({
        mode: "research/baseline@1",
        spec_sha256: harnessMode.specSha256,
        resolved_profile: {
          command: "goal run",
          room_type: "board",
          delivery: "runner-owned-turn-loop",
          initial_wake: "all-seats",
          mention_gate: false,
          task_gate: false,
          message_routing: "broadcast",
          web_search: "live",
          turn_limit_s: 1200,
          until: goal.until,
        },
        client_commit: null,
        runner_commit: null,
        source_worktree_dirty: null,
        package_version: "0.1.16-test",
        package_manifest_sha256: createHash("sha256").update(packageManifest).digest("hex"),
        entry_sha256: createHash("sha256").update(entrySource).digest("hex"),
        code_tree_sha256: createHash("sha256").update(`src/main.ts\0${createHash("sha256").update(entrySource).digest("hex")}\n`).digest("hex"),
        image: DEFAULT_IMAGE,
        models: [
          { seat: "codex-1", driver: "codex", model: "gpt-6-luna" },
          { seat: "codex-2", driver: "codex", model: "gpt-6.1-sol" },
        ],
        goal_sha256: createHash("sha256").update("Make it pass.").digest("hex"),
      });
      expect(episode.harness.opening_prompt_sha256).toEqual({
        "codex-1": expect.stringMatching(/^[0-9a-f]{64}$/),
        "codex-2": expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    }
  });
});

describe("an isolated run", () => {
  it("is prepared only with a key the gateway can sign with, and its gateway image", async () => {
    const home = await temporary();
    await mkdir(join(home, "cli", "src"), { recursive: true });
    await writeFile(join(home, "cli", "package.json"), "{}");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), "{}");
    const base = { agents: parseAgents(["codex"]), image: null, workspace: home, home, entry: join(home, "cli", "src", "main.ts") };
    const ready = fakeDocker(() => ({ code: 0 }));
    // A Codex login lives in the container that uses it; the gateway can only sign with a key.
    await expect(prepareRun({ ...base, env: {}, isolate: true }, ready.docker, () => undefined)).rejects.toMatchObject({ code: "agent_auth_missing" });

    // The gateway's image is pulled when it is not here; the Codex seats' model origin is the one the run names.
    const missing = fakeDocker((call) => ({ code: call.args[0] === "image" && call.args.includes(GATEWAY_IMAGE) ? 1 : 0 }));
    const plan = await prepareRun({ ...base, env: { OPENAI_API_KEY: "sk-test" }, modelApi: "https://llm.example.test/v1", isolate: true, agentUser: "agent" }, missing.docker, () => undefined);
    expect(missing.calls.some((call) => call.args.join(" ") === `pull ${GATEWAY_IMAGE}`)).toBe(true);
    expect(plan).toMatchObject({ agentUser: "agent", isolation: { openai: "https://llm.example.test", anthropic: "https://api.anthropic.com" }, codexAuth: { kind: "api-key" } });
    // Another model API: its key in OPENAI_API_KEY, its path kept; a Codex login signs in to OpenAI alone.
    const routed = await prepareRun({ ...base, env: { OPENAI_API_KEY: "sk-or-test" }, modelApi: "https://openrouter.ai/api/v1", isolate: true }, ready.docker, () => undefined);
    expect(routed).toMatchObject({ isolation: { openai: "https://openrouter.ai" }, codexApi: { origin: "https://openrouter.ai", path: "/api/v1", custom: true } });
    await expect(prepareRun({ ...base, env: {}, modelApi: "https://openrouter.ai/api/v1" }, ready.docker, () => undefined)).rejects.toMatchObject({ code: "agent_auth_missing" });
    // What this machine's environment says about a model API chooses nothing: a run that names none uses OpenAI's, as before.
    const ambient = { OPENAI_BASE_URL: "https://elsewhere.example.test/v1", ANTHROPIC_BASE_URL: "https://elsewhere.example.test" };
    const login = await prepareRun({ ...base, env: ambient }, ready.docker, () => undefined);
    expect(login.codexAuth).toMatchObject({ kind: "login" });
    expect(login.codexApi).toBeUndefined();
    const keyed = await prepareRun({ ...base, agents: parseAgents(["codex", "claude-code"]), env: { ...ambient, OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" }, isolate: true }, ready.docker, () => undefined);
    expect(keyed.codexApi).toBeUndefined();
    expect(keyed.isolation).toEqual({ openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" });
    // The address goes into the gateway's configuration and Codex's: a plain host and path, nothing else.
    for (const bad of ["https://x;}server{listen/v1", "https://user:pass@llm.example.test/v1", "https://llm.example.test/v1?key=1", "https://llm.example.test/v1\"", "ftp://llm.example.test/v1", "llm.example.test/v1"]) {
      await expect(prepareRun({ ...base, env: { OPENAI_API_KEY: "sk-test" }, modelApi: bad }, ready.docker, () => undefined)).rejects.toMatchObject({ code: "invalid_arguments" });
    }
    // Not isolated, nothing changes: the default user and no gateway.
    expect(await prepareRun({ ...base, env: {} }, ready.docker, () => undefined)).toMatchObject({ agentUser: "node", isolation: null });
  });

  it("has a gateway that names the keys it signs with and holds none of them", () => {
    const placeholders = keyPlaceholders("0123456789abcdef0123456789abcdef");
    const template = gatewayTemplate({
      sharednet: "https://www.sharednet.ai",
      isolation: { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" },
      codex: true,
      claudeAuth: "ANTHROPIC_API_KEY",
      placeholders,
    });
    // A key goes only to an upstream whose certificate is valid for its name.
    expect(template.match(/proxy_ssl_verify on;/g)).toHaveLength(3);
    expect(template).toContain("proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;");
    expect(template).toContain("proxy_ssl_name api.openai.com;");
    expect(template).toContain("proxy_ssl_name api.anthropic.com;");
    // A request is signed only when it carries this run's placeholder; the plain SharedNet forward has no key to guard.
    expect(template).toContain('if ($http_authorization != "Bearer sk-isolated-0123456789abcdef0123456789abcdef") { return 403; }');
    expect(template).toContain('if ($http_x_api_key != "sk-ant-api03-isolated-0123456789abcdef0123456789abcdef") { return 403; }');
    expect(template.match(/return 403;/g)).toHaveLength(2);
    expect(template.indexOf("return 403;")).toBeLessThan(template.indexOf('proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";'));
    // A development service on this machine is reached over plain HTTP: nothing to verify there.
    expect(gatewayTemplate({ sharednet: "http://host.docker.internal:3001", isolation: { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" }, codex: false, claudeAuth: null, placeholders })).not.toContain("proxy_ssl_verify");
    // Each run makes its own placeholders, and they are safe to write into a configuration.
    expect(keyPlaceholders().OPENAI_API_KEY).toMatch(/^sk-isolated-[0-9a-f]{48}$/);
    expect(keyPlaceholders().OPENAI_API_KEY).not.toBe(keyPlaceholders().OPENAI_API_KEY);
    expect(() => keyPlaceholders('x"; }')).toThrow();
    expect(template).toContain("listen 8081;");
    expect(template).toContain("proxy_pass https://www.sharednet.ai;");
    expect(template).toContain('proxy_set_header Authorization "Bearer ${OPENAI_API_KEY}";');
    expect(template).toContain('proxy_set_header x-api-key "${ANTHROPIC_API_KEY}";');
    expect(gatewayTemplate({ sharednet: "https://www.sharednet.ai", isolation: { openai: "https://api.openai.com", anthropic: "https://api.anthropic.com" }, codex: false, claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN", placeholders }))
      .toContain('if ($http_authorization != "Bearer sk-ant-oat01-isolated-0123456789abcdef0123456789abcdef") { return 403; }');
  });

  it.each([
    ["OpenAI", undefined],
    ["another model API", "https://openrouter.ai/api/v1"],
  ] as const)("puts every container on an internal network behind the gateway, and keeps every key out, for %s", async (_name, baseUrl) => {
    const out = await temporary();
    const workspace = await temporary();
    const api = codexApi(baseUrl);
    const plan: RunPlan = {
      image: "programbench-agent:1",
      agentUser: "agent",
      isolation: { openai: api.origin, anthropic: "https://api.anthropic.com" },
      ...(api.custom ? { codexApi: api } : {}),
      agents: parseAgents(["codex:gpt-6-luna"]),
      workspace,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    const names = isolationNames(ROOM);
    const { docker, calls } = fakeDocker((call, command) => {
      if (call.args[0] === "inspect") return { stdout: "10.9.0.3\n" };
      if (command[0] === "sharednet" && command[1] === "join") return { stdout: JSON.stringify({ member_id: "i_RunnerSeat1" }) };
      if (command[2] === "codex") {
        return { lines: [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 100 } })] };
      }
      if (command[0] === "sharednet" && command[1] === "wait") return { stdout: JSON.stringify({ wake_id: null, fired: ["closed"], from: 1, through: 1, events: [{ kind: "closed" }], messages: [] }) };
      return {};
    });
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["budget 1k tokens", "after 2h"], started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, state: "open", goal }, memberships: [] };
        if (method === "POST" && path === `/rooms/${ROOM}/close`) return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: "2026-10-05T12:01:00.000Z" } } } };
        return { items: [] };
      },
    } as unknown as ApiClient;
    let tick = Date.parse("2026-10-05T12:00:00.000Z");
    await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      { plan, roomId: ROOM, inviteToken: INVITE, goal: "g", goalSequence: 1, until: goal.until, baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: true, webSearch: "off", ...(api.custom ? { codexModel: { reasoningEffort: "medium" as const, contextWindow: 262144, compactAt: 150000 } } : {}) },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );

    // The internal network first, then its gateway, which joins it as `gateway` and is the only container with a way out.
    expect(calls[0]!.args).toEqual(["network", "create", "--internal", names.network]);
    const gateway = calls.find((call) => call.args[0] === "run" && call.args.includes(names.gateway))!;
    expect(gateway.args).not.toContain("--network");
    expect(gateway.args).toContain(GATEWAY_IMAGE);
    expect(gateway.args.join(" ")).toContain("-e GATEWAY_TEMPLATE -e OPENAI_API_KEY");
    expect(gateway.env.GATEWAY_TEMPLATE).toContain(`proxy_pass ${api.origin};`);
    expect(calls.some((call) => call.args.join(" ") === `network connect --alias gateway ${names.network} ${names.gateway}`)).toBe(true);
    // Every other container is on the internal network, and none of them can reach this machine.
    const runs = calls.filter((call) => call.args[0] === "run" && !call.args.includes(names.gateway));
    expect(runs.map((call) => call.args[call.args.indexOf("--name") + 1])).toEqual([containerName(ROOM), containerName(ROOM, "codex-1")]);
    expect(runs.every((call) => call.args.join(" ").includes(`--network ${names.network}`))).toBe(true);
    expect(runs.every((call) => !call.args.includes("host.docker.internal:host-gateway"))).toBe(true);
    // The Agents run as the image's user, and reach SharedNet on their own loopback, forwarded to the gateway.
    const seatCalls = calls.filter((call) => call.args[0] === "exec" && call.args.includes(containerName(ROOM, "codex-1")) && !call.args.includes("root"));
    expect(seatCalls.every((call) => call.args[call.args.indexOf("--user") + 1] === "agent")).toBe(true);
    const forwarder = calls.find((call) => call.args[0] === "exec" && call.args.includes("--detach"))!;
    expect(forwarder.args.slice(-2)).toEqual(["8081", "gateway"]);
    const turn = calls.find((call) => call.args.includes("codex"))!;
    expect(turn.args).toContain("SHAREDNET_BASE_URL=http://127.0.0.1:8081");
    // Codex is pointed at the gateway by its config (it reads no OPENAI_BASE_URL), and holds a placeholder for the key.
    // Another API is a provider of Codex's own at the gateway, with that API's path.
    expect(turn.args.join(" ")).toContain(api.custom ? '-c model_providers.goal_api.base_url="http://gateway:8080/api/v1"' : '-c openai_base_url="http://gateway:8080/v1"');
    expect(turn.args.join(" ").includes('-c model_reasoning_effort="medium"')).toBe(api.custom);
    expect(turn.args.join(" ").includes("-c model_auto_compact_token_limit=150000")).toBe(api.custom);
    const held = turn.args.find((arg) => arg.startsWith("OPENAI_API_KEY="))!.slice("OPENAI_API_KEY=".length);
    expect(held).toMatch(/^sk-isolated-[0-9a-f]{48}$/);
    expect(gateway.env.GATEWAY_TEMPLATE).toContain(`if ($http_authorization != "Bearer ${held}") { return 403; }`);
    expect(gateway.env.GATEWAY_TEMPLATE).toContain("proxy_ssl_verify on;");
    // The home of an image that has none is made as root, for the Agents' user.
    expect(calls.some((call) => call.args.join(" ").includes("--user root") && call.args.join(" ").endsWith("mkdir -p /home/agents && chown agent /home/agents"))).toBe(true);

    // The owner's key never reaches Docker; the invite travels by the client's environment, as before.
    expect(calls.find((call) => call.args.includes("join"))!.env).toMatchObject({ SHAREDNET_INVITE_TOKEN: INVITE });
    expect(calls.every((call) => !JSON.stringify(call).includes(OWNER_KEY))).toBe(true);

    // The gateway's log goes into the record; the gateway and the network go with the containers.
    expect(calls.filter((call) => call.args[0] === "cp" && call.args[1]!.startsWith(names.gateway)).map((call) => [call.args[1], call.args[2]])).toEqual([
      [`${names.gateway}:/var/log/nginx/sharednet.log`, join(out, "gateway", "sharednet.log")],
      [`${names.gateway}:/var/log/nginx/openai.log`, join(out, "gateway", "openai.log")],
    ]);
    expect(calls.some((call) => call.args.join(" ") === `logs ${names.gateway}`)).toBe(true);
    expect(calls.slice(-3).map((call) => call.args.join(" "))).toEqual([
      ["rm", "--force", ...runContainers(ROOM, plan.agents)].join(" "),
      `rm --force ${names.gateway}`,
      `network rm ${names.network}`,
    ]);
    const episode = JSON.parse(await readFile(join(out, "episode.json"), "utf8"));
    expect(episode).toMatchObject({ isolated: true, agent_user: "agent", addresses: { "codex-1": "10.9.0.3" }, web_search: "off", reasoning_effort: api.custom ? "medium" : null, context_window: api.custom ? 262144 : null, compact_at: api.custom ? 150000 : null });
    // The API is written down when the run names one; a run that names none says nothing about it.
    expect(episode.model_api).toBe(api.custom ? baseUrl : undefined);
  });
});

describe("an image of your own", () => {
  it("is prepared for a user that can be named, and the default image keeps its own", async () => {
    const home = await temporary();
    await mkdir(join(home, "cli", "src"), { recursive: true });
    await writeFile(join(home, "cli", "package.json"), "{}");
    const base = { agents: parseAgents(["codex"]), image: "programbench-agent:1", workspace: home, home, entry: join(home, "cli", "src", "main.ts"), env: { OPENAI_API_KEY: "sk-test" } };
    const ready = fakeDocker(() => ({ code: 0 }));
    await expect(prepareRun({ ...base, agentUser: "bad user" }, ready.docker, () => undefined)).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(await prepareRun({ ...base, agentUser: "agent" }, ready.docker, () => undefined)).toMatchObject({ image: "programbench-agent:1", agentUser: "agent" });
    expect(await prepareRun({ ...base, agentUser: "1000:1000" }, ready.docker, () => undefined)).toMatchObject({ agentUser: "1000:1000" });
    expect(await prepareRun({ ...base, image: null }, ready.docker, () => undefined)).toMatchObject({ image: DEFAULT_IMAGE, agentUser: "node" });
  });

  it.each([
    ["an API key", { kind: "api-key" }],
    ["this machine's Codex login", { kind: "login", file: "/Users/someone/.codex/auth.json" }],
  ] as const)("runs the Agents as the image's user, signed in with %s, and makes their homes for that user", async (_name, codexAuth) => {
    const out = await temporary();
    const workspace = await temporary();
    const plan: RunPlan = {
      image: "programbench-agent:1",
      agentUser: "agent",
      agents: parseAgents(["codex"]),
      workspace,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth,
      claudeAuth: null,
    };
    const { docker, calls } = fakeDocker((_call, command) => {
      if (command[0] === "sharednet" && command[1] === "join") return { stdout: JSON.stringify({ member_id: "i_CodexOne01" }) };
      if (command[2] === "codex") return { lines: [JSON.stringify({ type: "thread.started", thread_id: "thread-1" }), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2_000, cached_input_tokens: 0, output_tokens: 100 } })] };
      if (command[0] === "sharednet" && command[1] === "wait") return { stdout: JSON.stringify({ wake_id: null, fired: ["closed"], from: 1, through: 1, events: [{ kind: "closed" }], messages: [] }) };
      return {};
    });
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["budget 1k tokens", "after 2h"], started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, state: "open", goal }, memberships: [] };
        if (method === "POST" && path === `/rooms/${ROOM}/close`) return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: "2026-10-05T12:01:00.000Z" } } } };
        return { items: [] };
      },
    } as unknown as ApiClient;
    let tick = Date.parse("2026-10-05T12:00:00.000Z");
    await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      { plan, roomId: ROOM, inviteToken: INVITE, goal: "g", goalSequence: 1, until: goal.until, baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: true },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );

    // The image's own user runs everything an Agent or a check runs; only setting the container up runs as root.
    const execs = calls.filter((call) => call.args[0] === "exec");
    const users = new Set(execs.map((call) => call.args[call.args.indexOf("--user") + 1]));
    expect(users).toEqual(new Set(["agent", "root"]));
    expect(execs.filter((call) => call.args.includes("codex")).every((call) => call.args[call.args.indexOf("--user") + 1] === "agent")).toBe(true);
    // The image has no home for the Agents, so one is made as root, for that user, before the seat is set up.
    const homes = execs.findIndex((call) => call.args.join(" ").endsWith("mkdir -p /home/agents && chown agent /home/agents"));
    expect(homes).toBeGreaterThan(-1);
    expect(execs[homes]!.args[execs[homes]!.args.indexOf("--user") + 1]).toBe("root");
    expect(homes).toBeLessThan(execs.findIndex((call) => call.args.includes("join")));
    expect(calls.filter((call) => call.args[0] === "run").every((call) => call.args.includes("programbench-agent:1"))).toBe(true);
    expect(JSON.parse(await readFile(join(out, "episode.json"), "utf8"))).toMatchObject({ image: "programbench-agent:1", agent_user: "agent" });
    // A login copied into the seat's home belongs to the user the turns run as, or Codex could not read it.
    const copied = execs.filter((call) => call.args.join(" ").includes("cp /run/codex/auth.json"));
    expect(copied).toHaveLength(codexAuth.kind === "login" ? 1 : 0);
    expect(copied.every((call) => call.args.join(" ").includes("chown -R agent '/home/agents/codex-1'"))).toBe(true);
  });
});

describe("a check", () => {
  it("runs in the checks' own container, on the shared workspace, under no Agent's home", async () => {
    const out = await temporary();
    const workspace = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["claude-code"]),
      workspace,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: null,
      claudeAuth: "ANTHROPIC_API_KEY",
    };
    const { docker, calls } = fakeDocker((_call, command) => {
      if (command[0] === "sharednet" && command[1] === "join") return { stdout: JSON.stringify({ member_id: "i_ClaudeOne01" }) };
      if (command[0] === "sharednet" && command[1] === "wait") {
        return { stdout: JSON.stringify({ wake_id: null, fired: ["closed"], from: 1, through: 1, events: [{ kind: "closed" }], messages: [] }) };
      }
      return {};
    });
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["check pytest -q", "after 2h"], started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, state: "open", goal }, memberships: [] };
        if (method === "POST" && path === `/rooms/${ROOM}/close`) {
          return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: "2026-10-05T12:01:00.000Z" } } } };
        }
        return { items: [] };
      },
    } as unknown as ApiClient;
    let tick = Date.parse("2026-10-05T12:00:00.000Z");
    const result = await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      { plan, taskGate: true, roomId: ROOM, inviteToken: INVITE, goal: "g", goalSequence: 1, until: goal.until, baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: true, webSearch: "off", turnLimitMs: 2_700_000 },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );

    const claudeTurn = calls.find(call => call.args.includes("claude"))!;
    expect(claudeTurn.args).toContain("SHAREDNET_TASK_GATE=1");
    const settings = JSON.parse(claudeTurn.args[claudeTurn.args.indexOf("--settings") + 1]!);
    expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
    expect(calls.some(call => call.input?.includes("permissionDecision: 'deny'"))).toBe(true);

    expect(result.ended_by).toMatchObject({ trigger: "check pytest -q" });
    // With web search off, the Claude Code seat's turn denies the web tools; the turn runs up to the run's
    // own limit; and the record says both.
    const turn = calls.find((call) => call.args.includes("claude"))!;
    expect(turn.args.join(" ")).toContain("--disallowedTools WebSearch WebFetch --output-format");
    expect(turn.args.join(" ")).toContain("timeout 2700 claude -p");
    expect(JSON.parse(await readFile(join(out, "episode.json"), "utf8"))).toMatchObject({ web_search: "off", turn_limit_s: 2700 });
    const check = calls.find((call) => call.args[0] === "exec" && call.args.slice(-3).join(" ") === "sh -c pytest -q")!;
    expect(check.args).toContain(containerName(ROOM));
    expect(check.args.some((arg) => arg.startsWith("HOME="))).toBe(false);
    // The checks' container has the shared workspace and nothing an Agent holds: no CLI, no sign-in.
    const checker = calls.find((call) => call.args[0] === "run" && call.args.includes(containerName(ROOM)))!;
    expect(checker.args).toEqual(["run", "--detach", "--name", containerName(ROOM), "--volume", `${workspace}:/workspace`, DEFAULT_IMAGE, "sleep", "infinity"]);
    expect(calls.at(-1)!.args).toEqual(["rm", "--force", containerName(ROOM, "claude-code-1"), containerName(ROOM)]);
  });
});

describe("a start that fails", () => {
  it("closes the Room it opened, says why, and leaves no container", async () => {
    const out = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex"]),
      workspace: out,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    const { docker, calls } = fakeDocker((_call, command) =>
      command[0] === "sharednet" && command[1] === "join" ? { code: 4, stderr: "room_full" } : {},
    );
    const closes: unknown[] = [];
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "POST" && path === `/rooms/${ROOM}/close`) closes.push(body);
        return {};
      },
    } as unknown as ApiClient;
    await expect(
      runGoal(client, "sni_owner-seat", OWNER_KEY, { plan, roomId: ROOM, inviteToken: INVITE, goal: "g", goalSequence: 1, until: ["after 1h"], baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: false }, {
        docker,
        now: () => new Date(),
        sleep: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "join_failed" });
    expect(closes).toEqual([{ detail: expect.stringContaining("goal run could not start: codex-1 could not join the Room") }]);
    expect(calls.at(-1)!.args).toEqual(["rm", "--force", ...runContainers(ROOM, plan.agents)]);
    // A key-signed Codex seat gets its key from the Docker client's environment, never from an argument.
    expect(calls.some((call) => call.args.includes("OPENAI_API_KEY"))).toBe(true);
  });
});

describe("scrubHome", () => {
  it("takes the seat's token and the harness's sign-in out of a home, and leaves the trace", async () => {
    const home = await temporary();
    await mkdir(join(home, ".claude", "projects", "w"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), "{}");
    await writeFile(join(home, ".claude", "projects", "w", "s.jsonl"), "{}\n");
    await scrubHome(home);
    await expect(readFile(join(home, ".claude", ".credentials.json"))).rejects.toThrow();
    expect(await readFile(join(home, ".claude", "projects", "w", "s.jsonl"), "utf8")).toBe("{}\n");
  });
});

describe("module slots in a run", () => {
  it("filters wakes by island, adds requests and the activity view, posts a probe, and records the modules", async () => {
    const out = await temporary();
    const workspace = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["claude-code", "claude-code"]),
      workspace,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: null,
      claudeAuth: "ANTHROPIC_API_KEY",
    };
    const seat1 = containerName(ROOM, "claude-code-1");
    const waits: Record<string, number> = {};
    const from2 = (sequence: number, content: string) => ({ sequence, content, sender: { member_id: "i_ClaudeTwo02", name: "claude-code-2" } });
    const { docker, calls } = fakeDocker((call, command) => {
      const mine = call.args.includes(seat1);
      if (command[0] === "sharednet" && command[1] === "join") return { stdout: JSON.stringify({ member_id: mine ? "i_ClaudeOne01" : "i_ClaudeTwo02" }) };
      if (command[0] === "sharednet" && command[1] === "task") return { stdout: JSON.stringify({ tasks: [{ key: "wav", title: "WAV core", owner: "i_ClaudeTwo02", owner_name: "claude-code-2", status: "claimed", claim_sequence: 2 }] }) };
      if (command[0] === "sharednet" && command[1] === "wait") {
        const n = (waits[mine ? "1" : "2"] = (waits[mine ? "1" : "2"] ?? 0) + 1);
        if (mine && n === 1) return { stdout: JSON.stringify({ wake_id: "wk_one", fired: ["message"], from: 1, through: 2, events: [], messages: [from2(2, "chatter in island two")] }) };
        if (mine && n === 2) return { stdout: JSON.stringify({ wake_id: "wk_two", fired: ["message"], from: 2, through: 3, events: [], messages: [from2(3, "@claude-code-1 S: wav done | B: 1a2b | A: matches | R: fetch it and run the difftest")] }) };
        return { stdout: JSON.stringify({ wake_id: null, fired: ["closed"], from: 3, through: 3, events: [{ kind: "closed" }], messages: [] }) };
      }
      if (command[0] === "sh" && command[2] === "python3 probe.py") return { stdout: "2 differences: -buildconf exits 1\n" };
      return {};
    });
    const posts: unknown[] = [];
    const goal = { message_id: "msg_goal000001", sequence: 1, until: ["after 2h"], started_at: "2026-10-05T12:00:00.000Z", ended_by: null };
    let tick = Date.parse("2026-10-05T12:00:00.000Z");
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "GET" && path === `/rooms/${ROOM}`) {
          // The goal's clock runs out once both seats have had their turns.
          const over = calls.filter(call => call.args.includes("claude")).length >= 3;
          return { room: { id: ROOM, state: over ? "closed" : "open", goal: over ? { ...goal, ended_by: { trigger: "after 2h", at: new Date(tick).toISOString() } } : goal }, memberships: [] };
        }
        if (method === "POST" && path === `/rooms/${ROOM}/owner-messages`) { posts.push(body); return { message: {} }; }
        if (method === "POST" && path === `/rooms/${ROOM}/close`) return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: new Date(tick).toISOString() } } } };
        return { items: [] };
      },
    } as unknown as ApiClient;
    await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan, roomId: ROOM, inviteToken: INVITE, goal: "g", goalSequence: 1, until: goal.until, baseUrl: "https://www.sharednet.ai", out, checkEveryMs: 60_000, quietChecks: true, messageRouting: "mentions-only",
        modules: { taskJudge: "lexical", activityView: true, topology: { kind: "islands", count: 2 }, messageSchema: "sbar", probe: { command: "python3 probe.py", everyMs: 60_000 } },
        disallowedTools: ["ScheduleWakeup"],
      },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );
    // The line from the other island that names nobody woke nobody; the handoff that names the seat crossed.
    const routing = (await readFile(join(out, "routing.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(routing.find(r => r.seat === "claude-code-1" && r.wake_id === "wk_one")).toMatchObject({ delivered: [], skipped: [2] });
    const turns = calls.filter(call => call.args.includes(seat1) && call.args.includes("claude"));
    const woken = turns.at(-1)!.args.at(-1)!;
    expect(woken).toContain("#3 claude-code-2: @claude-code-1 S: wav done");
    expect(woken).toContain("Asked of you (the R: part of each handoff to you):\n- #3 claude-code-2 asks: fetch it and run the difftest");
    expect(woken).toContain('- claude-code-2: idle; holds "WAV core"');
    expect(turns[0]!.args.at(-1)).toContain("Yours is island 1, where you are alone.");
    expect(turns[0]!.args).toContain("SHAREDNET_MESSAGE_SCHEMA=sbar");
    expect(turns[0]!.args).toContain("SHAREDNET_TASK_JUDGE=lexical");
    expect(turns[0]!.args.slice(turns[0]!.args.indexOf("--disallowedTools"), turns[0]!.args.indexOf("--disallowedTools") + 2)).toEqual(["--disallowedTools", "ScheduleWakeup"]);
    expect(posts).toContainEqual({ content: "@all [probe] 2 differences: -buildconf exits 1", as: "runner" });
    expect(JSON.parse(await readFile(join(out, "episode.json"), "utf8")).disallowed_tools).toEqual(["ScheduleWakeup"]);
    expect(JSON.parse(await readFile(join(out, "episode.json"), "utf8")).modules).toEqual({ state: { task_judge: "lexical", activity_view: true }, topology: "islands:2", protocol: "sbar", information: { probe: "python3 probe.py", every_ms: 60_000 } });
  });
});
