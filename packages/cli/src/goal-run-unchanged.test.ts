// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "./api-client.ts";
import { DEFAULT_IMAGE, containerName, openingPrompt, parseAgents, runGoal, turnCommand, wakePrompt, type DockerRunner, type GoalRunInput, type RunPlan } from "./goal-run.ts";

/**
 * A `goal run` that does not ask to resume a swarm is what it was before the option existed: other
 * people's experiments run on it. These cases run whole Goals against a fake Docker and a fake
 * service, write down everything the run did (every Docker call, every request that changes the
 * Room, every line it logged, its result and its record), and hold that to hashes taken from the
 * code before `--resume-from` was added (commit 7e8f89b). A change to any prompt, argument, record
 * field or log line of an ordinary run fails here.
 */

const ROOM = "rom_AbCdEfGhIj";
const OWNER_KEY = "snk_owner-key-never-in-a-container";
const INVITE = "rit_invite-token-travels-by-environment";
const AT = "2026-10-05T12:00:00.000Z";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-goal-unchanged-"));
  cleanup.push(directory);
  return directory;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * One whole run, written down in an order that does not depend on timing: each seat takes its
 * opening turn, is woken once, takes a second turn and then waits; when every seat waits, the first
 * one's DONE arrives and ends the Room.
 */
async function transcript(agents: string[], plan: Partial<RunPlan>, input: Partial<GoalRunInput>): Promise<string> {
  const out = await temporary();
  const workspace = await temporary();
  const seats = parseAgents(agents);
  const parked = new Map<string, () => void>();
  const waits = new Map<string, number>();
  const turns = new Map<string, number>();
  const calls: Array<{ group: string; call: unknown }> = [];
  const docker: DockerRunner = async (args, options = {}) => {
    const container = args[0] === "exec" ? args.find((arg) => arg.startsWith(containerName(ROOM))) ?? "?" : "runner";
    calls.push({ group: container, call: { args, env: options.env ?? {}, ...(options.input === undefined ? {} : { input: options.input }) } });
    const at = args.findIndex((arg) => arg.startsWith(containerName(ROOM)));
    const command = args[0] === "exec" && at !== -1 ? args.slice(at + 1) : [];
    const name = seats.find((seat) => container === containerName(ROOM, seat.name))?.name ?? null;
    if (args[0] === "stop") for (const release of parked.values()) release();
    if (args[0] === "cp") {
      // A Codex home as it is copied out: the seat's token, the sign-in, and a session file with the session's own total.
      const target = args[2]!;
      const seat = seats.find((entry) => args[1]!.endsWith(`/${entry.name}`))!;
      await mkdir(join(target, ".config", "sharednet"), { recursive: true });
      await writeFile(join(target, ".config", "sharednet", "seat.json"), "{}");
      if (seat.driver === "codex") {
        await mkdir(join(target, ".codex", "sessions"), { recursive: true });
        await writeFile(join(target, ".codex", "auth.json"), "{}");
        await writeFile(
          join(target, ".codex", "sessions", `rollout-thread-${seat.name}.jsonl`),
          `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2_500, cached_input_tokens: 1_600, output_tokens: 250 } } } })}\n`,
        );
      }
    }
    let lines: string[] = [];
    let stdout = "";
    let code = 0;
    if (command[0] === "sharednet" && command[1] === "join") stdout = JSON.stringify({ member_id: `i_Seat${name!.replace(/[^a-z0-9]/g, "")}` });
    else if (command[0] === "sharednet" && command[1] === "task") stdout = JSON.stringify({ tasks: [] });
    else if (command.includes("codex") || command.includes("claude")) {
      const turn = (turns.get(name!) ?? 0) + 1;
      turns.set(name!, turn);
      lines = command.includes("codex")
        ? [
            JSON.stringify({ type: "thread.started", thread_id: `thread-${name}` }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000 * turn, cached_input_tokens: 800 * turn, output_tokens: 100 * turn } }),
          ]
        : [
            JSON.stringify({ type: "system", subtype: "init", session_id: `session-${name}` }),
            JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: `session-${name}`, usage: { input_tokens: 50, cache_creation_input_tokens: 150, cache_read_input_tokens: 800, output_tokens: 100 } }),
          ];
    } else if (command[0] === "sharednet" && command[1] === "wait") {
      const count = (waits.get(name!) ?? 0) + 1;
      waits.set(name!, count);
      if (count === 1) stdout = JSON.stringify({ wake_id: `wk_${name}`, fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: "@all split it", sender: { member_id: "i_other", name: "someone" } }] });
      else {
        await new Promise<void>((resolve) => parked.set(name!, resolve));
        code = 137;
      }
    }
    for (const line of lines) options.onLine?.(line);
    return { code, stdout, stderr: "" };
  };

  const goal = { message_id: "msg_goal000001", sequence: 1, until: ["said DONE", "after 2h"], started_at: AT, ended_by: null };
  const requests: string[] = [];
  let claimed = false;
  const client = {
    async request(method: string, path: string, token: string, body?: unknown) {
      if (method !== "GET") requests.push(JSON.stringify([method, path, token, body ?? null]));
      if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, type: input.roomType ?? "board", state: "open", goal }, memberships: [] };
      if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (claimed || parked.size < seats.length) return { items: [] };
        claimed = true;
        return { items: [{ sequence: 3, content: "DONE", sender: { member_id: "i_other", name: "someone" }, created_at: AT }] };
      }
      if (method === "POST" && path === `/rooms/${ROOM}/close`) return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: AT } } } };
      if (method === "POST" && path === `/rooms/${ROOM}/owner-messages`) return { message: {} };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as ApiClient;

  const logged: string[] = [];
  const result = await runGoal(
    client,
    "sni_owner-seat",
    OWNER_KEY,
    {
      plan: { image: DEFAULT_IMAGE, agents: seats, workspace, cli: { root: "/opt/cli", entry: "src/main.ts" }, codexAuth: null, claudeAuth: null, ...plan },
      roomId: ROOM,
      inviteToken: INVITE,
      goal: "Make it pass.\n\n- [ ] the tests pass",
      goalSequence: 1,
      until: goal.until,
      baseUrl: "http://127.0.0.1:3117",
      out,
      checkEveryMs: 60_000,
      quietChecks: false,
      codeProvenance: { clientCommit: "c".repeat(40), runnerCommit: "c".repeat(40), sourceWorktreeDirty: false, packageVersion: "0.1.17", packageManifestSha256: "1".repeat(64), entrySha256: "2".repeat(64), codeTreeSha256: "3".repeat(64) },
      ...input,
    },
    { docker, now: () => new Date(AT), sleep: async () => undefined, stderr: (line) => logged.push(line) },
  );

  const file = (name: string) => readFile(join(out, name), "utf8").catch(() => "(none)");
  const sorted = async (name: string) => (await file(name)).split("\n").filter(Boolean).sort().join("\n");
  const groups = [...new Set(calls.map((entry) => entry.group))].sort();
  const text = [
    ...groups.map((group) => `## docker ${group}\n${calls.filter((entry) => entry.group === group).map((entry) => JSON.stringify(entry.call)).join("\n")}`),
    `## requests\n${requests.join("\n")}`,
    `## log\n${logged.join("")}`,
    `## result\n${JSON.stringify(result)}`,
    `## episode.json\n${await file("episode.json")}`,
    `## wakes.ndjson\n${await sorted("wakes.ndjson")}`,
    `## routing.ndjson\n${await sorted("routing.ndjson")}`,
    `## room.ndjson\n${await file("room.ndjson")}`,
    `## checks.ndjson\n${await file("checks.ndjson")}`,
  ].join("\n\n");
  // The two directories are made for the test, and how many workspace snapshots were taken is git's
  // business on the machine that runs this; everything else in the transcript is the run's own.
  return text.split(out).join("<out>").split(workspace).join("<workspace>").replace(/"snapshots":\s*\d+/g, '"snapshots":"<n>"');
}

describe("goal run without --resume-from is what it was", () => {
  it.each([
    [
      "two Codex seats on a login, every default",
      ["codex:gpt-6-luna", "codex"],
      { codexAuth: { kind: "login", file: "/Users/someone/.codex/auth.json" } },
      {},
      "fd31cb3aeae8ec0fd6ab4ee33d047bc2d24cb4069003a7847973407d9c337373",
    ],
    [
      "a Codex and a Claude Code seat with the gates, mentions-only, tuned Codex and no web",
      ["codex:gpt-6.1-sol", "claude-code:sonnet"],
      { codexAuth: { kind: "api-key" }, claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" },
      { mentionGate: true, taskGate: true, messageRouting: "mentions-only", webSearch: "off", disallowedTools: ["ScheduleWakeup"], turnLimitMs: 600_000, codexModel: { reasoningEffort: "low", contextWindow: 262_144, compactAt: 200_000 } },
      "25564dbabc2e5b923d9a61f3a9dae3dc3a415fff1098f123a23db66eac85d325",
    ],
    [
      "one Claude Code seat alone, with the activity view",
      ["claude-code"],
      { claudeAuth: "ANTHROPIC_API_KEY" },
      { modules: { taskJudge: "off", activityView: true, topology: { kind: "all" }, messageSchema: "free", probe: null } },
      "ae2833eb7e8dfbd9132fb13a1add95207f183b1859e67a53c159f38d1e28a548",
    ],
    [
      "two Codex seats taking cooperative turns",
      ["codex", "codex"],
      { codexAuth: { kind: "api-key" } },
      { turnPolicy: "cooperative-v1" },
      "63a64e9674e294602ae0ee29f43a30177ce3cff27e3fba8058da6a10fe2c0cb5",
    ],
  ] as const)("%s", async (_name, agents, plan, input, expected) => {
    const text = await transcript([...agents], plan as Partial<RunPlan>, input as Partial<GoalRunInput>);
    if (process.env.SHAREDNET_PRINT_PINS) console.log(`PIN ${_name}: ${sha(text)} (${text.length} chars)`);
    expect(sha(text)).toBe(expected);
  });

  it("gives the same prompts and the same harness commands", () => {
    const seats = parseAgents(["codex", "claude-code:sonnet", "codex:gpt-6-luna"]);
    const prompts = [
      openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: "Ship it.\n", goalSequence: 1, until: ["check python3 check.py", "said DONE", "after 1h"] }),
      openingPrompt({ seat: seats[1]!, seats, roomId: ROOM, goal: "Ship it.", goalSequence: 4, until: ["budget 2M tokens"], mentionGate: true, taskGate: true, messageRouting: "mentions" }),
      openingPrompt({ seat: seats[2]!, seats, roomId: ROOM, goal: "Ship it.", goalSequence: 1, until: ["after 1h"], messageRouting: "mentions-only", turnPolicy: "cooperative-v1" }),
      openingPrompt({ seat: seats[0]!, seats: [seats[0]!], roomId: ROOM, goal: "Ship it.", goalSequence: 1, until: ["said DONE", "after 1h"] }),
      openingPrompt({ seat: seats[0]!, seats: seats.map((seat, index) => ({ ...seat, member_id: `i_member${index}` })), roomType: "compiled", roomId: ROOM, goal: "Ship it.", goalSequence: 1, until: ["after 1h"] }),
      openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: "Ship it.", goalSequence: 1, until: ["after 1h"], modules: { taskJudge: "lexical", activityView: true, topology: { kind: "islands", count: 2 }, messageSchema: "sbar", probe: { command: "python3 probe.py", everyMs: 60_000 } } }),
      wakePrompt({ wake_id: "wk_1", fired: ["message"], messages: [{ sequence: 7, content: "@codex-1 look", sender: { name: "claude-code-1" } }], events: [], from: 6, through: 7 }),
      wakePrompt({ wake_id: "wk_1", fired: ["message"], messages: [{ sequence: 7, content: "look", sender: { member_id: "i_x" } }], events: [], from: 6, through: 7 }, "cooperative-v1"),
    ];
    const commands = [
      turnCommand(seats[0]!, "p", null),
      turnCommand(seats[0]!, "p", "thread-1"),
      turnCommand(seats[2]!, "p", "thread-1", "off", 600, { url: "http://gateway:8080/v1", custom: false }, { reasoningEffort: "high", contextWindow: 262_144, compactAt: 200_000 }),
      turnCommand(seats[2]!, "p", null, "live", 1_200, { url: "https://openrouter.ai/api/v1", custom: true }),
      turnCommand(seats[1]!, "p", null),
      turnCommand(seats[1]!, "p", "session-1", "off", 1_200, null, {}, ["ScheduleWakeup"]),
    ];
    if (process.env.SHAREDNET_PRINT_PINS) console.log(`PIN prompts: ${sha(JSON.stringify(prompts))}\nPIN commands: ${sha(JSON.stringify(commands))}`);
    expect(sha(JSON.stringify(prompts))).toBe("696c3fa7a5839a665461fa18149fa424be1874ca9846461db4c4ce7ad1fa831e");
    expect(sha(JSON.stringify(commands))).toBe("e8f03f4fffe7ffa60e6f7d161a8d746d70f93686fd9aad7373bc503e858c3aee");
  });
});
