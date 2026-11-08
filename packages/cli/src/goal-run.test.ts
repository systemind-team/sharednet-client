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
  TurnReader,
  codexSessionUsage,
  containerName,
  discoverCodeProvenance,
  freshTokens,
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
    for (const raws of [[], ["gemini"], ["codex:bad model"], Array.from({ length: 51 }, () => "codex")]) {
      expect(() => parseAgents(raws), raws.join(" ")).toThrow();
    }
  });

  it("starts up to fifty, so a team can be scaled past eight", () => {
    const seats = parseAgents(Array.from({ length: 50 }, (_, index) => (index % 2 === 0 ? "codex" : "claude-code")));
    expect(seats).toHaveLength(50);
    expect(seats.at(-2)).toEqual({ name: "codex-25", driver: "codex", model: null });
    expect(seats.at(-1)).toEqual({ name: "claude-code-25", driver: "claude-code", model: null });
    expect(new Set(seats.map((seat) => seat.name)).size).toBe(50);
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
  });

  it("tells every Agent about the all-Agent completion barrier and reset rule", () => {
    const seats = parseAgents(["codex", "claude-code"]);
    const opening = openingPrompt({
      seat: seats[0]!,
      seats,
      roomId: ROOM,
      goal: "Make the tests pass.",
      goalSequence: 1,
      until: ["check pytest -q", "said /^DONE$/", "after 1h"],
      terminationPolicy: "all-agents",
    });
    expect(opening).toContain("Completion requires a matching claim from every Agent");
    expect(opening).toContain("every Agent must confirm again after repair");
    expect(opening).not.toContain("Room ends when the first");
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

  it.each([["board", false, false], ["compiled", false, false], ["board", true, false], ["board", false, true], ["board", true, true]] as const)("runs every %s seat with mention=%s task=%s until the budget is spent and keeps credentials private", async (roomType, mentionGate, taskGate) => {
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
    const harnessMode = roomType === "board" && !mentionGate && !taskGate
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
        ...(harnessMode ? {
          harnessMode,
          // The CLI passes canonical defaults after it rejects explicit policy flags.
          initiationPolicy: "all" as const,
          terminationPolicy: "first" as const,
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
    expect(episode).toMatchObject({ image: DEFAULT_IMAGE, web_search: "live", turn_limit_s: 1200, totals: { tokens: 1_900, cached_tokens: 5_600 }, ended_by: { trigger: "budget 1k tokens" } });
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

  async function runInitiationPolicy(
    policy: "default" | "random-single",
    seed = 0,
    terminationPolicy: "first" | "all-agents" = "first",
  ) {
    const out = await temporary();
    const workspace = await temporary();
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseAgents(["codex:gpt-test", "codex:gpt-test", "codex:gpt-test"]),
      workspace,
      cli: { root: "/opt/cli", entry: "src/main.ts" },
      codexAuth: { kind: "api-key" },
      claudeAuth: null,
    };
    const members = new Map([
      ["codex-1", "i_CodexOne01"],
      ["codex-2", "i_CodexTwo02"],
      ["codex-3", "i_CodexThree3"],
    ]);
    const names = new Map([...members].map(([name, member]) => [member, name]));
    const prompts: Array<{ seat: string; prompt: string }> = [];
    const waits = new Map<string, number>();
    const { docker } = fakeDocker((_call, command) => {
      const member = _call.args.find((arg) => arg.startsWith("SHAREDNET_SEAT="))?.slice("SHAREDNET_SEAT=".length) ?? null;
      if (command[0] === "sharednet" && command[1] === "join") {
        const name = command[command.indexOf("--name") + 1]!;
        return { stdout: JSON.stringify({ member_id: members.get(name) }) };
      }
      if (command[0] === "sharednet" && command[1] === "wait") {
        const count = (waits.get(member!) ?? 0) + 1;
        waits.set(member!, count);
        if (count === 1) {
          return {
            stdout: JSON.stringify({
              wake_id: `wk_${member}`,
              fired: ["message"],
              from: 1,
              through: 2,
              events: [],
              messages: [{ sequence: 2, content: "First delivered wake.", sender: { member_id: "i_owner", name: "owner" } }],
            }),
          };
        }
        return { stdout: JSON.stringify({ wake_id: null, fired: ["closed"], from: 2, through: 2, events: [{ kind: "closed" }], messages: [] }) };
      }
      if (command[2] === "codex") {
        const name = names.get(member!)!;
        prompts.push({ seat: name, prompt: command.at(-1)! });
        const resumed = command[4] === "resume";
        return {
          lines: [
            ...(resumed ? [] : [JSON.stringify({ type: "thread.started", thread_id: `thread-${member}` })]),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }),
          ],
        };
      }
      return {};
    });
    const goal = {
      message_id: "msg_goal000001",
      sequence: 1,
      until: ["said FINISH", "after 1h"],
      started_at: "2026-10-21T00:00:00.000Z",
      ended_by: null,
    };
    let finishDelivered = 0;
    let closeCount = 0;
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "GET" && path === `/rooms/${ROOM}`) {
          return { room: { id: ROOM, type: "board", state: "open", goal }, memberships: [] };
        }
        if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
          while (new Set(prompts.map((entry) => entry.seat)).size < 3 || prompts.length < 4) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          if (terminationPolicy === "all-agents") {
            const sender_instance_id = [...members.values()][finishDelivered];
            if (!sender_instance_id) return { items: [] };
            finishDelivered += 1;
            return { items: [{ sequence: finishDelivered + 2, content: "FINISH", sender_instance_id }] };
          }
          if (finishDelivered > 0) return { items: [] };
          finishDelivered = 1;
          return { items: [{ sequence: 3, content: "FINISH", sender_instance_id: "i_owner" }] };
        }
        if (method === "POST" && path === `/rooms/${ROOM}/close`) {
          if (terminationPolicy === "all-agents" && finishDelivered < members.size) throw new Error("all-agents closed before every claim arrived");
          closeCount += 1;
          return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: "2026-10-21T00:01:00.000Z" } } } };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    } as unknown as ApiClient;
    let tick = Date.parse("2026-10-21T00:00:00.000Z");
    const policyOptions = policy === "random-single"
      ? { initiationPolicy: "random-single" as const, terminationPolicy, policySeed: seed }
      : { terminationPolicy };
    await runGoal(
      client,
      "sni_owner-seat",
      OWNER_KEY,
      {
        plan,
        roomType: "board",
        roomId: ROOM,
        inviteToken: INVITE,
        goal: "Implement the parser.\n",
        goalSequence: 1,
        until: goal.until,
        baseUrl: "https://www.sharednet.ai",
        out,
        checkEveryMs: 60_000,
        quietChecks: true,
        codeProvenance: {
          clientCommit: "1".repeat(40),
          runnerCommit: "1".repeat(40),
          sourceWorktreeDirty: false,
          packageVersion: "0.1.17-test",
          packageManifestSha256: "2".repeat(64),
          entrySha256: "3".repeat(64),
          codeTreeSha256: "4".repeat(64),
        },
        ...policyOptions,
      },
      { docker, now: () => new Date((tick += 1_000)), sleep: async () => undefined },
    );
    const firstPrompts = new Map<string, string>();
    for (const entry of prompts) if (!firstPrompts.has(entry.seat)) firstPrompts.set(entry.seat, entry.prompt);
    return {
      out,
      firstPrompts,
      episode: JSON.parse(await readFile(join(out, "episode.json"), "utf8")),
      policy: (await readFile(join(out, "policy.ndjson"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      closeCount,
    };
  }

  it.each([
    ["all", "first"],
    ["random-single", "first"],
    ["all", "all-agents"],
    ["random-single", "all-agents"],
  ] as const)("runs the %s × %s arm through fake Docker and service end to end", async (initiationPolicy, terminationPolicy) => {
    const run = await runInitiationPolicy(initiationPolicy === "all" ? "default" : "random-single", 20261021, terminationPolicy);
    expect(run.episode).toMatchObject({
      initiation_policy: initiationPolicy,
      termination_policy: terminationPolicy,
      ended_by: { trigger: "said FINISH" },
      policy_seed: initiationPolicy === "random-single" ? 20261021 : null,
      completion_required_agent_member_ids: terminationPolicy === "all-agents" ? [...membersForPolicyTest().values()] : [],
      completion_confirmed_agent_member_ids: terminationPolicy === "all-agents" ? [...membersForPolicyTest().values()] : [],
      completion_reset_count: 0,
    });
    if (initiationPolicy === "random-single") {
      expect(run.episode.starter).toMatch(/^codex-/);
      expect(run.episode.starter_member_id).toBe(membersForStarter(run.episode.starter));
    } else {
      expect(run.episode).toMatchObject({ starter: null, starter_member_id: null });
    }
    expect(run.closeCount).toBe(1);
    const starts = run.policy.filter((event: { type?: string }) => event.type === "agent_started");
    expect(starts).toHaveLength(3);
    expect(starts.filter((event: { reason?: string }) => event.reason === "initial")).toHaveLength(initiationPolicy === "all" ? 3 : 1);
    expect(starts.filter((event: { reason?: string }) => event.reason === "wake")).toHaveLength(initiationPolicy === "all" ? 0 : 2);
    const immediatePrompts = [...run.firstPrompts.values()].filter((prompt) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."));
    expect(immediatePrompts).toHaveLength(initiationPolicy === "all" ? 3 : 1);
    expect(run.policy.filter((event: { type?: string }) => event.type === "starter_selected")).toHaveLength(initiationPolicy === "random-single" ? 1 : 0);
    expect(run.policy.filter((event: { type?: string }) => event.type === "completion_confirmed")).toHaveLength(terminationPolicy === "all-agents" ? 3 : 0);
    expect(run.policy.filter((event: { type?: string }) => event.type === "completion_quorum")).toHaveLength(terminationPolicy === "all-agents" ? 1 : 0);
  });

  it("keeps all and first as the recorded defaults, with every Agent starting immediately", async () => {
    const run = await runInitiationPolicy("default");
    expect([...run.firstPrompts.values()].filter((prompt) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."))).toHaveLength(3);
    expect(run.episode).toMatchObject({
      initiation_policy: "all",
      termination_policy: "first",
      policy_seed: null,
      starter: null,
    });
  });

  it("selects one reproducible starter and gives each dormant Agent the goal with its first wake", async () => {
    const first = await runInitiationPolicy("random-single", 20261021);
    const repeated = await runInitiationPolicy("random-single", 20261021);
    const immediate = [...first.firstPrompts].filter(([, prompt]) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."));
    expect(immediate).toHaveLength(1);
    const starter = immediate[0]![0];
    expect(
      [...first.firstPrompts]
        .filter(([seat]) => seat !== starter)
        .every(([, prompt]) => prompt.includes("<goal>\nImplement the parser.\n</goal>") && prompt.includes("#2 owner: First delivered wake.")),
    ).toBe(true);
    expect(
      [...repeated.firstPrompts].find(([, prompt]) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."))?.[0],
    ).toBe(starter);
  });

  it("records the selected policies, seed, and starter in the episode", async () => {
    const run = await runInitiationPolicy("random-single", 20261021);
    const starter = [...run.firstPrompts].find(([, prompt]) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."))![0];
    expect(run.episode).toMatchObject({
      initiation_policy: "random-single",
      termination_policy: "first",
      policy_seed: 20261021,
      starter,
    });
  });

  it("writes reproducible starter-selection evidence with the selected member identity", async () => {
    const run = await runInitiationPolicy("random-single", 20261021);
    const starter = [...run.firstPrompts].find(([, prompt]) => prompt.includes("<goal>") && !prompt.includes("First delivered wake."))![0];
    const policy = (await readFile(join(run.out, "policy.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(policy).toContainEqual(expect.objectContaining({
      type: "starter_selected",
      at: expect.stringMatching(/^2026-10-21T/),
      initiation_policy: "random-single",
      policy_seed: 20261021,
      starter,
      member_id: membersForStarter(starter),
    }));
  });
});

function membersForStarter(starter: string): string {
  return membersForPolicyTest().get(starter)!;
}

function membersForPolicyTest(): Map<string, string> {
  return new Map([
    ["codex-1", "i_CodexOne01"],
    ["codex-2", "i_CodexTwo02"],
    ["codex-3", "i_CodexThree3"],
  ]);
}

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
