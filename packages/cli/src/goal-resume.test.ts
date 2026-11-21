// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApiClient } from "./api-client.ts";
import { earlierRoomMarkdown, newcomerNote, planResume, readResumeSource, resumePrompt, roomControls, usageSince } from "./goal-resume.ts";
import { runCli, sayNextGoal } from "./cli.ts";
import { CliError } from "./errors.ts";
import { handleRequest } from "./server/handler.ts";
import { MemorySharedNetRepository } from "./server/memory-repository.ts";
import { DEFAULT_IMAGE, TurnReader, codexSessionUsage, containerName, openingPrompt, parseAgents, runGoal, type DockerRunner, type GoalRunInput, type GoalRunResult } from "./goal-run.ts";

const ROOM = "rom_NewRoom002";
const EARLIER_ROOM = "rom_OldRoom001";
const OWNER_KEY = "snk_owner-key-never-in-a-container";
const INVITE = "rit_invite-token-travels-by-environment";
const AT = "2026-11-20T09:00:00.000Z";
/** Made-up session ids, in the shapes Codex and Claude Code give theirs. */
const CODEX_SESSION = "01a1f9f1-0000-7000-8000-00000000c0de";
const CLAUDE_SESSION = "6f0e2d1c-1111-4222-8333-444455556666";

/**
 * Codex 0.162.1's own lines, recorded from two turns of one session (ids replaced): the first turn
 * of a session, then the same session resumed. The second `turn.completed` is the session's
 * running total, not the resumed turn's own use.
 */
const CODEX_FIRST_TURN = [
  `{"type":"thread.started","thread_id":"${CODEX_SESSION}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"ok"}}',
  '{"type":"turn.completed","usage":{"input_tokens":10989,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
];
const CODEX_RESUMED_TURN = [
  `{"type":"thread.started","thread_id":"${CODEX_SESSION}"}`,
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"again"}}',
  '{"type":"turn.completed","usage":{"input_tokens":21996,"cached_input_tokens":18176,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0}}',
];
/** The session file's own record of the first turn's end, as Codex wrote it. */
const CODEX_ROLLOUT_AFTER_FIRST_TURN = [
  `{"timestamp":"2026-11-20T08:11:28.000Z","ordinal":0,"type":"session_meta","payload":{"id":"${CODEX_SESSION}","cwd":"/workspace","cli_version":"0.162.1"}}`,
  '{"timestamp":"2026-11-20T08:11:29.046Z","ordinal":13,"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10989,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":10994},"last_token_usage":{"input_tokens":10989,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":10994},"model_context_window":258400}}}',
].join("\n");
/** Member tokens the fake service hands out, and the member each one enters as (`SHAREDNET_MEMBER_TOKEN`). */
const HANDED = new Map<string, string>();
/** Claude Code 2.1.300's answer to `--resume` with a session it does not have: one line, and exit 1. */
const CLAUDE_REFUSED = [
  `{"type":"result","subtype":"error_during_execution","duration_ms":0,"duration_api_ms":0,"is_error":true,"num_turns":0,"stop_reason":null,"session_id":"${CLAUDE_SESSION}","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}`,
];

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-goal-resume-"));
  cleanup.push(directory);
  return directory;
}

/**
 * An ended run's record, as goal run leaves it: four seats. codex-1 and claude-code-1 have their
 * homes and sessions; codex-2's home lost its session file; the earlier codex-3 never got a session.
 */
async function earlierRecord(episode: Record<string, unknown> = {}) {
  const record = await temporary();
  const zero = { input: 0, cached: 0, output: 0 };
  await writeFile(join(record, "episode.json"), JSON.stringify({
    schema_version: 1,
    room_id: EARLIER_ROOM,
    mention_gate: false,
    task_gate: false,
    message_routing: "broadcast",
    turn_policy: "legacy",
    modules: { state: { task_judge: "off", activity_view: false }, topology: "all", protocol: "free", information: null },
    agents: [
      { name: "codex-1", driver: "codex", model: "gpt-6-luna", member_id: "i_old1", session_id: CODEX_SESSION, turns: 1, failed_turns: 0, tokens: 1_906, usage: { input: 1_901, cached: 9_088, output: 5 } },
      { name: "codex-2", driver: "codex", model: null, member_id: "i_old2", session_id: "01a1f9f1-0000-7000-8000-0000000000b2", turns: 1, failed_turns: 0, tokens: 10, usage: { input: 5, cached: 0, output: 5 } },
      { name: "codex-3", driver: "codex", model: null, member_id: "i_old3", session_id: null, turns: 0, failed_turns: 0, tokens: 0, usage: zero },
      { name: "claude-code-1", driver: "claude-code", model: "sonnet", member_id: "i_old4", session_id: CLAUDE_SESSION, turns: 1, failed_turns: 0, tokens: 10, usage: { input: 5, cached: 0, output: 5 } },
    ],
    ...episode,
  }));
  await writeFile(join(record, "room.ndjson"), [
    JSON.stringify({ sequence: 1, content: "Pick a word.", sender: { member_id: "i_owner", name: "Ada" }, created_at: "2026-11-20T08:10:00.000Z" }),
    JSON.stringify({ sequence: 2, content: "hash 9f86d0", sender: { member_id: "i_old1", name: "codex-1" }, created_at: "2026-11-20T08:11:00.000Z" }),
    "not json",
  ].join("\n"));
  const codexHome = join(record, "agents", "codex-1", "home");
  await mkdir(join(codexHome, ".codex", "sessions", "2026", "11", "20"), { recursive: true });
  await writeFile(join(codexHome, ".codex", "sessions", "2026", "11", "20", `rollout-2026-11-20T08-11-28-${CODEX_SESSION}.jsonl`), `${CODEX_ROLLOUT_AFTER_FIRST_TURN}\n`);
  await writeFile(join(codexHome, ".codex", "config.toml"), '[mcp_servers.notes]\ncommand = "notes-mcp"\n');
  await mkdir(join(record, "agents", "codex-2", "home", ".codex", "sessions"), { recursive: true });
  const claudeHome = join(record, "agents", "claude-code-1", "home");
  await mkdir(join(claudeHome, ".claude", "projects", "-workspace"), { recursive: true });
  await writeFile(join(claudeHome, ".claude", "projects", "-workspace", `${CLAUDE_SESSION}.jsonl`), "{}\n");
  return record;
}

describe("the record a run resumes from", () => {
  it("is refused unless it is a goal run's record", async () => {
    const empty = await temporary();
    await expect(readResumeSource(empty)).rejects.toMatchObject({ code: "invalid_arguments" });
    await writeFile(join(empty, "episode.json"), JSON.stringify({ room_id: EARLIER_ROOM }));
    await expect(readResumeSource(empty)).rejects.toMatchObject({ code: "invalid_arguments" });
    await expect(readResumeSource(join(empty, "nowhere"))).rejects.toMatchObject({ code: "invalid_arguments" });
  });

  it("names the seats to take up again, and why each other seat starts fresh", async () => {
    const source = await readResumeSource(await earlierRecord());
    expect(source.roomId).toBe(EARLIER_ROOM);
    const plan = await planResume(source, parseAgents(["codex", "codex", "codex", "codex", "claude-code:opus"]), codexSessionUsage);
    // Same name and same harness: taken up again, even with another model. The baseline is the session file's own total.
    expect([...plan.seats.keys()]).toEqual(["codex-1", "claude-code-1"]);
    expect(plan.seats.get("codex-1")).toEqual({ sessionId: CODEX_SESSION, home: join(source.record, "agents", "codex-1", "home"), baseline: { input: 1_901, cached: 9_088, output: 5 } });
    expect(plan.seats.get("claude-code-1")!.baseline).toEqual({ input: 0, cached: 0, output: 0 });
    expect(Object.fromEntries(plan.fresh)).toEqual({ "codex-2": "no_session_file", "codex-3": "no_session", "codex-4": "new_seat" });
    // The same name under another harness is another agent.
    const swapped = await planResume({ ...source, seats: source.seats.map((seat) => (seat.name === "codex-1" ? { ...seat, driver: "claude-code" as const } : seat)) }, parseAgents(["codex"]), codexSessionUsage);
    expect(Object.fromEntries(swapped.fresh)).toEqual({ "codex-1": "other_harness" });
    // A record whose homes were removed resumes nobody.
    await rm(join(source.record, "agents"), { recursive: true });
    expect(Object.fromEntries((await planResume(source, parseAgents(["codex", "claude-code"]), codexSessionUsage)).fresh)).toEqual({ "codex-1": "no_home", "claude-code-1": "no_home" });
  });

  it("takes a session's earlier total from what the earlier runs counted when its file holds none", async () => {
    // The earlier run was itself resumed: it counted 1,906 on top of a baseline it recorded.
    const record = await earlierRecord({ resume: { seats: { "codex-1": { resumed: true, session_id: CODEX_SESSION, baseline: { input: 4_000, cached: 30_000, output: 600 } } } } });
    const file = join(record, "agents", "codex-1", "home", ".codex", "sessions", "2026", "11", "20", `rollout-2026-11-20T08-11-28-${CODEX_SESSION}.jsonl`);
    await writeFile(file, '{"type":"session_meta","payload":{}}\n');
    const plan = await planResume(await readResumeSource(record), parseAgents(["codex"]), codexSessionUsage);
    expect(plan.seats.get("codex-1")!.baseline).toEqual({ input: 5_901, cached: 39_088, output: 605 });
  });

  it("counts a resumed Codex session from where the earlier run left it", () => {
    const reader = new TurnReader("codex");
    for (const line of CODEX_RESUMED_TURN) reader.line(line);
    // The stream reports the running total of both turns; the earlier turn is the baseline.
    expect(reader.reading.usage).toEqual({ input: 3_820, cached: 18_176, output: 10 });
    expect(usageSince(reader.reading.usage!, codexSessionUsage(CODEX_ROLLOUT_AFTER_FIRST_TURN)!)).toEqual({ input: 1_919, cached: 9_088, output: 5 });
    expect(usageSince({ input: 1, cached: 2, output: 3 }, { input: 5, cached: 1, output: 3 })).toEqual({ input: 0, cached: 1, output: 0 });
  });

  it("tells a harness that took a session up from one that refused", () => {
    const took = new TurnReader("codex");
    for (const line of CODEX_RESUMED_TURN) took.line(line);
    expect(took.started).toBe(true);
    // Codex answers an unknown session on stderr alone: no line at all.
    expect(new TurnReader("codex").started).toBe(false);
    const claude = new TurnReader("claude-code");
    claude.line(JSON.stringify({ type: "system", subtype: "init", session_id: CLAUDE_SESSION }));
    expect(claude.started).toBe(true);
    // Claude Code names the session it was asked for even as it refuses it.
    const refused = new TurnReader("claude-code");
    for (const line of CLAUDE_REFUSED) refused.line(line);
    expect(refused.reading).toMatchObject({ sessionId: CLAUDE_SESSION, failed: true });
    expect(refused.started).toBe(false);
  });
});

describe("what a resumed swarm is told", () => {
  const base = {
    seat: "codex-1",
    seats: ["codex-1", "codex-2", "claude-code-1"],
    resumed: new Set(["codex-1", "claude-code-1"]),
    roomId: ROOM,
    earlierRoomId: EARLIER_ROOM,
    earlierRooms: "earlier-rooms/rom_OldRoom001.md",
    workspace: "/workspace",
    goal: "Say the word you picked.\n",
    goalSequence: 1,
    until: ["check python3 check.py", "said DONE", "after 10m"],
    today: "2026-11-20",
    rules: null,
  };

  it("gives a seat taken up again the new goal and what changed, not the opening over again", () => {
    const prompt = resumePrompt(base);
    expect(prompt).toContain("You are still codex-1, and this is a new Goal for the same swarm.");
    expect(prompt).toContain("Your session from the earlier Goal has been resumed");
    expect(prompt).toContain("The new goal (message #1):\n<goal>\nSay the word you picked.\n</goal>");
    expect(prompt).toContain(`- The Room is new: ${ROOM}. The earlier Room, ${EARLIER_ROOM}, has ended`);
    expect(prompt).toContain("- What was said earlier is in earlier-rooms/rom_OldRoom001.md in /workspace, oldest first.");
    expect(prompt).toContain("- Today is 2026-11-20 (UTC).");
    expect(prompt).toContain("- The team: claude-code-1 is resumed as you are. codex-2 is a new session and remembers nothing of the earlier Goal.");
    expect(prompt).toContain("- Your container is new.");
    expect(prompt).toContain("- This Room ends when the first of these happens: check python3 check.py; said DONE; after 10m.");
    expect(prompt).toContain('- Say "DONE" in the Room only when you believe the new goal is met: saying it runs the check.');
    expect(prompt.endsWith("How you talk in the Room and how you are woken are as they were.")).toBe(true);
    // None of what an opening teaches is said again.
    const seats = parseAgents(["codex", "codex", "claude-code"]);
    const opening = openingPrompt({ seat: seats[0]!, seats, roomId: ROOM, goal: base.goal, goalSequence: 1, until: base.until });
    for (const taught of ["sharednet read --last 30 --json", 'sharednet say "…" --json', "Do not run `sharednet wait`", "Lines from `runner`", "Agree in the Room who does what"]) {
      expect(opening).toContain(taught);
      expect(prompt).not.toContain(taught);
    }
  });

  it("states the Room's rules again only when they are not the earlier run's", () => {
    const earlier = roomControls({ mentionGate: false, taskGate: false, messageRouting: "broadcast", turnPolicy: "legacy", modules: { topology: "all" }, seats: ["codex-1", "codex-2"] });
    expect(roomControls({ mentionGate: false, taskGate: false, messageRouting: "broadcast", turnPolicy: "legacy", modules: { topology: "all" }, seats: ["codex-1", "codex-2"] })).toBe(earlier);
    // Another routing, a seat now alone, or a record from before the modules: the rules are told again.
    expect(roomControls({ mentionGate: false, taskGate: false, messageRouting: "mentions-only", turnPolicy: "legacy", modules: { topology: "all" }, seats: ["codex-1", "codex-2"] })).not.toBe(earlier);
    expect(roomControls({ mentionGate: false, taskGate: false, messageRouting: "broadcast", turnPolicy: "legacy", modules: { topology: "all" }, seats: ["codex-1"] })).not.toBe(earlier);
    expect(roomControls({ mentionGate: false, taskGate: false, messageRouting: "broadcast", turnPolicy: "legacy", modules: undefined, seats: ["codex-1", "codex-2"] })).not.toBe(earlier);
    // Islands are dealt by seat: the same rule over another team reads differently.
    const islands = (names: string[]) => roomControls({ mentionGate: false, taskGate: false, messageRouting: "broadcast", turnPolicy: "legacy", modules: { topology: "islands:2" }, seats: names });
    expect(islands(["codex-1", "codex-2"])).not.toBe(islands(["codex-1", "codex-3"]));
    const prompt = resumePrompt({ ...base, seats: ["codex-1", "codex-2"], resumed: new Set(["codex-1", "codex-2"]), rules: ["A message wakes only the teammates it names with @name."] });
    expect(prompt).toContain("How the Room works has changed too:\nA message wakes only the teammates it names with @name.");
    expect(prompt).not.toContain("are as they were");
    expect(prompt).toContain("- The team: codex-2 is resumed as you are.");
  });

  it("says less where there is less to say: a seat alone, no earlier Room on file, no claim to make", () => {
    const prompt = resumePrompt({ ...base, seats: ["codex-1"], resumed: new Set(["codex-1"]), earlierRoomId: null, earlierRooms: null, until: ["after 10m"] });
    expect(prompt).toContain("- The team: You are the only agent of this Goal.");
    expect(prompt).toContain(`- The Room is new: ${ROOM}. The earlier Room has ended`);
    expect(prompt).not.toContain("What was said earlier");
    expect(prompt).not.toContain("only when you believe");
  });

  it("says the Room is the same when the next goal is said in the earlier Goal's own Room", () => {
    const prompt = resumePrompt({ ...base, roomId: EARLIER_ROOM, goalSequence: 41 });
    expect(prompt).toContain(`- The Room is the same, ${EARLIER_ROOM}: the earlier goal has ended and this is its next one, at message #41. Everything before #41 belongs to the earlier Goal.`);
    expect(prompt).toContain("You speak in it from a new seat under the same name");
    expect(prompt).toContain("The new goal (message #41):");
    expect(prompt).not.toContain("The Room is new");
    expect(prompt).not.toContain("numbered from #1 again");
    const note = newcomerNote({ seat: "codex-2", seats: base.seats, resumed: base.resumed, earlierRoomId: EARLIER_ROOM, earlierRooms: null, workspace: "/workspace", roomId: EARLIER_ROOM, goalSequence: 41 });
    expect(note).toBe("This swarm has worked before, on an earlier Goal in this Room (the messages before #41). codex-1 and claude-code-1 are the same sessions that worked on it, resumed with what they remember; you are a new session and start without that memory.");
  });

  it("tells a seat that starts fresh in a resumed swarm who remembers and where the earlier Room is", () => {
    const note = newcomerNote({ seat: "codex-2", seats: base.seats, resumed: base.resumed, earlierRoomId: EARLIER_ROOM, earlierRooms: base.earlierRooms, workspace: "/workspace" });
    expect(note).toBe(`This swarm has worked before, on an earlier Goal in Room ${EARLIER_ROOM}. codex-1 and claude-code-1 are the same sessions that worked on it, resumed with what they remember; you are a new session and start without that memory. What was said then is in earlier-rooms/rom_OldRoom001.md in /workspace, oldest first.`);
    expect(newcomerNote({ seat: "codex-2", seats: base.seats, resumed: new Set(), earlierRoomId: null, earlierRooms: null, workspace: "/workspace" })).toBe("This swarm has worked before, on an earlier Goal in an earlier Room. None of its sessions is here: every agent of this Goal is a new session.");
  });

  it("writes the earlier Room down as a file to search, oldest first", () => {
    const said = earlierRoomMarkdown(EARLIER_ROOM, `${JSON.stringify({ sequence: 2, content: " hash 9f86d0 ", sender: { name: "codex-1" }, created_at: "2026-11-20T08:11:00.000Z" })}\nnot json\n${JSON.stringify({ sequence: 3, content: "ok", sender_instance_id: "i_x" })}\n`);
    expect(said).toBe(`# What was said in ${EARLIER_ROOM}\n\nThe Room of an earlier Goal of this swarm, which has ended. Oldest first; \`runner\` is the Room's own machinery, not a person.\n\n#2 2026-11-20 08:11 codex-1: hash 9f86d0\n\n#3 i_x: ok\n`);
    expect(earlierRoomMarkdown(null, "")).toContain("(Nothing was said.)");
  });
});

type Call = { args: readonly string[]; env: Record<string, string>; input?: string };

/**
 * One whole run of four seats that is asked to resume the record above. Each seat takes its first
 * turn (twice, if its session is refused), is woken once, takes one more turn and waits; when every
 * seat waits, a DONE ends the Room.
 */
async function resumedRun(record: string, options: { input?: Partial<GoalRunInput>; failCopyInto?: string; service?: (method: string, path: string, token: string) => unknown } = {}) {
  const out = await temporary();
  const workspace = await temporary();
  const seats = parseAgents(["codex:gpt-6-luna", "codex", "codex", "claude-code:sonnet"]);
  const parked = new Map<string, () => void>();
  const waits = new Map<string, number>();
  const turns = new Map<string, number>();
  const calls: Call[] = [];
  const docker: DockerRunner = async (args, dockerOptions = {}) => {
    calls.push({ args, env: dockerOptions.env ?? {}, ...(dockerOptions.input === undefined ? {} : { input: dockerOptions.input }) });
    const at = args.findIndex((arg) => arg.startsWith(containerName(ROOM)));
    const container = at === -1 ? null : args[at]!;
    const command = args[0] === "exec" && at !== -1 ? args.slice(at + 1) : [];
    const name = seats.find((seat) => container === containerName(ROOM, seat.name))?.name ?? null;
    if (args[0] === "stop") for (const release of parked.values()) release();
    // A home copied into a container: refused for the seat the test names.
    if (args[0] === "cp" && args[2]!.startsWith(containerName(ROOM))) return { code: options.failCopyInto && args[2]!.includes(`-${options.failCopyInto}:`) ? 1 : 0, stdout: "", stderr: "no space left on device" };
    if (args[0] === "cp") {
      // A home copied out at the end: codex-1's session file now holds both runs' total.
      const target = args[2]!;
      if (args[1]!.endsWith("/codex-1")) {
        await mkdir(join(target, ".codex", "sessions"), { recursive: true });
        await writeFile(join(target, ".codex", "auth.json"), "{}");
        const total = { input_tokens: 32_000, cached_input_tokens: 27_000, output_tokens: 20 };
        await writeFile(join(target, ".codex", "sessions", `rollout-2026-11-20T08-11-28-${CODEX_SESSION}.jsonl`), `${JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } })}\n`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    let lines: string[] = [];
    let stdout = "";
    let code = 0;
    // A seat handed its earlier member's token enters as that member; one with the invite is a new member.
    if (command[0] === "sharednet" && command[1] === "join") stdout = JSON.stringify({ member_id: HANDED.get(dockerOptions.env?.SHAREDNET_MEMBER_TOKEN ?? "") ?? `i_New${name!.replace(/[^a-z0-9]/g, "")}` });
    else if (command.includes("codex")) {
      const turn = (turns.get(name!) ?? 0) + 1;
      turns.set(name!, turn);
      const resumed = command.includes("resume");
      if (name === "codex-1" && command.includes(CODEX_SESSION)) lines = turn === 1 ? CODEX_RESUMED_TURN : [`{"type":"thread.started","thread_id":"${CODEX_SESSION}"}`, '{"type":"turn.completed","usage":{"input_tokens":30000,"cached_input_tokens":26000,"output_tokens":15}}'];
      else lines = [...(resumed ? [] : [JSON.stringify({ type: "thread.started", thread_id: `thread-${name}` })]), JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1_000 * turn, cached_input_tokens: 800 * turn, output_tokens: 100 * turn } })];
    } else if (command.includes("claude")) {
      const turn = (turns.get(name!) ?? 0) + 1;
      turns.set(name!, turn);
      if (command.includes(CLAUDE_SESSION)) {
        lines = CLAUDE_REFUSED;
        code = 1;
      } else lines = [JSON.stringify({ type: "system", subtype: "init", session_id: "session-fresh" }), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "session-fresh", usage: { input_tokens: 50, cache_creation_input_tokens: 150, cache_read_input_tokens: 800, output_tokens: 100 } })];
    } else if (command[0] === "sharednet" && command[1] === "wait") {
      const count = (waits.get(name!) ?? 0) + 1;
      waits.set(name!, count);
      if (count === 1) stdout = JSON.stringify({ wake_id: `wk_${name}`, fired: ["message"], from: 1, through: 2, events: [], messages: [{ sequence: 2, content: "@all go on", sender: { member_id: "i_other", name: "someone" } }] });
      else {
        await new Promise<void>((resolve) => parked.set(name!, resolve));
        code = 137;
      }
    }
    for (const line of lines) dockerOptions.onLine?.(line);
    return { code, stdout, stderr: code === 1 ? `No conversation found with session ID: ${CLAUDE_SESSION}` : "" };
  };
  const goal = { message_id: "msg_goal000002", sequence: 1, until: ["said DONE", "budget 1M tokens", "after 2h"], started_at: AT, ended_by: null };
  let claimed = false;
  const client = {
    async request(method: string, path: string, token: string, body?: unknown) {
      const answered = options.service?.(method, path, token);
      if (answered instanceof Error) throw answered;
      if (answered !== undefined) return answered;
      if (method === "GET" && path === `/rooms/${ROOM}`) return { room: { id: ROOM, type: "board", state: "open", goal }, memberships: [] };
      if (method === "GET" && path.startsWith(`/rooms/${ROOM}/wait?`)) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        if (claimed || parked.size < seats.length) return { items: [] };
        claimed = true;
        return { items: [{ sequence: 3, content: "DONE", sender: { member_id: "i_other", name: "someone" }, created_at: AT }] };
      }
      if (method === "POST" && path === `/rooms/${ROOM}/close`) return { room: { state: "closed", goal: { ...goal, ended_by: { ...(body as object), at: AT } } } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as ApiClient;
  const logged: string[] = [];
  const result: GoalRunResult = await runGoal(
    client,
    "sni_owner-seat",
    OWNER_KEY,
    {
      plan: { image: DEFAULT_IMAGE, agents: seats, workspace, cli: { root: "/opt/cli", entry: "src/main.ts" }, codexAuth: { kind: "login", file: "/Users/someone/.codex/auth.json" }, claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" },
      roomId: ROOM,
      inviteToken: INVITE,
      goal: "Say the word you picked.",
      goalSequence: 1,
      until: goal.until,
      baseUrl: "https://www.sharednet.ai",
      out,
      checkEveryMs: 60_000,
      quietChecks: false,
      codeProvenance: { clientCommit: null, runnerCommit: null, sourceWorktreeDirty: null, packageVersion: "0.1.17", packageManifestSha256: null, entrySha256: null, codeTreeSha256: null },
      resume: { source: await readResumeSource(record), earlierRooms: null },
      ...options.input,
    },
    { docker, now: () => new Date(AT), sleep: async () => undefined, stderr: (line) => logged.push(line) },
  );
  const of = (seat: string) => calls.filter((call) => call.args[0] === "exec" && call.args.includes(containerName(ROOM, seat)));
  const harnessTurns = (seat: string) => of(seat).filter((call) => call.args.includes("codex") || call.args.includes("claude"));
  return { result, calls, of, harnessTurns, out, workspace, logged, episode: JSON.parse(await readFile(join(out, "episode.json"), "utf8")) as Record<string, any> };
}

describe("a run that resumes a swarm", () => {
  it("takes each matching seat up in its own session, with its home, and starts the others fresh", async () => {
    const record = await earlierRecord();
    const { result, calls, of, harnessTurns, out, workspace, logged, episode } = await resumedRun(record);

    // codex-1: its saved home goes into its new container and is made its own before the sign-in is put back and before it joins.
    const one = containerName(ROOM, "codex-1");
    const order = calls.map((call) => call.args.join(" "));
    // The home's contents, so it lands in place even when something (a worker's memory install) made the folder first.
    const copied = order.findIndex((line) => line === `cp ${join(record, "agents", "codex-1", "home")}/. ${one}:/home/agents/codex-1`);
    const owned = order.findIndex((line) => line.includes(one) && line.includes("chown -R node '/home/agents/codex-1'") && !line.includes("auth.json"));
    const signedIn = order.findIndex((line) => line.includes(one) && line.includes("cp /run/codex/auth.json '/home/agents/codex-1/.codex/auth.json'"));
    const joined = order.findIndex((line) => line.includes(one) && line.includes("sharednet join"));
    expect(copied).toBeGreaterThan(-1);
    expect([copied, owned, signedIn, joined]).toEqual([...[copied, owned, signedIn, joined]].sort((left, right) => left - right));
    // Only the seats that are taken up get a home put in: two copies in, four copies out at the end.
    expect(calls.filter((call) => call.args[0] === "cp" && call.args[2]!.startsWith(containerName(ROOM))).map((call) => call.args[2])).toEqual([`${one}:/home/agents/codex-1`, `${containerName(ROOM, "claude-code-1")}:/home/agents/claude-code-1`]);

    // Its first turn resumes its own session, and what it is told is the new goal, not the opening.
    const first = harnessTurns("codex-1")[0]!.args;
    expect(first.slice(first.indexOf("codex"), first.indexOf("codex") + 3)).toEqual(["codex", "exec", "resume"]);
    expect(first.at(-2)).toBe(CODEX_SESSION);
    expect(first.at(-1)).toContain("You are still codex-1, and this is a new Goal for the same swarm.");
    expect(first.at(-1)).toContain("<goal>\nSay the word you picked.\n</goal>");
    expect(first.at(-1)).toContain(`- The Room is new: ${ROOM}. The earlier Room, ${EARLIER_ROOM}, has ended`);
    expect(first.at(-1)).toContain("- Today is 2026-11-20 (UTC).");
    expect(first.at(-1)).toContain(`- What was said earlier is in earlier-rooms/${EARLIER_ROOM}.md in /workspace`);
    expect(first.at(-1)).toContain("- The team: claude-code-1 is resumed as you are. codex-2 and codex-3 are new sessions and remember nothing of the earlier Goal.");
    expect(first.at(-1)).not.toContain("sharednet read --last 30");
    // The same Room rules as the earlier run: none is told again.
    expect(first.at(-1)!.endsWith("How you talk in the Room and how you are woken are as they were.")).toBe(true);
    // Its later turns resume the same session with the wake, as in any run.
    expect(harnessTurns("codex-1")[1]!.args.at(-2)).toBe(CODEX_SESSION);
    expect(harnessTurns("codex-1")[1]!.args.at(-1)).toContain("New in the Room since your last turn");

    // codex-2 (its session file is gone) and codex-3 (it never had a session) start fresh, with the whole opening and a note.
    for (const seat of ["codex-2", "codex-3"]) {
      const opening = harnessTurns(seat)[0]!.args;
      expect(opening.includes("resume")).toBe(false);
      expect(opening.at(-1)).toContain(`You are ${seat}, one of 4 agents working on one goal in SharedNet Room ${ROOM}.`);
      expect(opening.at(-1)).toContain("sharednet read --last 30 --json");
      expect(opening.at(-1)!.endsWith(`This swarm has worked before, on an earlier Goal in Room ${EARLIER_ROOM}. codex-1 and claude-code-1 are the same sessions that worked on it, resumed with what they remember; you are a new session and start without that memory. What was said then is in earlier-rooms/${EARLIER_ROOM}.md in /workspace, oldest first.`)).toBe(true);
    }

    // claude-code-1: Claude Code refuses the session, so the seat starts again at once with a fresh session and the whole opening.
    const claude = harnessTurns("claude-code-1");
    expect(claude[0]!.args.slice(claude[0]!.args.indexOf("--resume"), claude[0]!.args.indexOf("--resume") + 2)).toEqual(["--resume", CLAUDE_SESSION]);
    expect(claude[0]!.args.at(-1)).toContain("You are still claude-code-1");
    expect(claude[1]!.args.includes("--resume")).toBe(false);
    expect(claude[1]!.args.at(-1)).toContain(`You are claude-code-1, one of 4 agents working on one goal in SharedNet Room ${ROOM}.`);
    expect(claude[2]!.args.slice(claude[2]!.args.indexOf("--resume"), claude[2]!.args.indexOf("--resume") + 2)).toEqual(["--resume", "session-fresh"]);
    // No wait stands between the refusal and the fresh start.
    const claudeCalls = of("claude-code-1").map((call) => (call.args.includes("claude") ? "turn" : call.args.includes("wait") ? "wait" : "other")).filter((kind) => kind !== "other");
    expect(claudeCalls.slice(0, 3)).toEqual(["turn", "turn", "wait"]);
    expect(logged.join("")).toContain("goal: claude-code-1 starts a fresh session (harness_refused); its earlier session was not resumed\n");

    // The record and the result say which seats were taken up and why the others were not.
    const expected = {
      from: record,
      room_id: EARLIER_ROOM,
      earlier_rooms: `earlier-rooms/${EARLIER_ROOM}.md`,
      seats: {
        "codex-1": { resumed: true, session_id: CODEX_SESSION, baseline: { input: 1_901, cached: 9_088, output: 5 }, prompt_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
        "codex-2": { resumed: false, reason: "no_session_file" },
        "codex-3": { resumed: false, reason: "no_session" },
        "claude-code-1": { resumed: false, reason: "harness_refused" },
      },
    };
    expect(episode.resume).toEqual(expected);
    expect(result.resume).toEqual(expected);
    // In a new Room no earlier member is taken up, and none is asked for.
    expect(episode.resume.members).toBeUndefined();
    expect(episode.agents.map((seat: { member_id: string }) => seat.member_id)).toEqual(["i_Newcodex1", "i_Newcodex2", "i_Newcodex3", "i_Newclaudecode1"]);
    expect(episode.agents.map((seat: { name: string; session_id: string }) => [seat.name, seat.session_id])).toEqual([["codex-1", CODEX_SESSION], ["codex-2", "thread-codex-2"], ["codex-3", "thread-codex-3"], ["claude-code-1", "session-fresh"]]);
    // A seat taken up was not given an opening, so it has no opening hash; every other seat has one.
    expect(episode.harness.opening_prompt_sha256).toEqual({ "codex-1": null, "codex-2": expect.any(String), "codex-3": expect.any(String), "claude-code-1": expect.any(String) });

    // Usage is this run's alone. codex-1's session file says 32,000 read (27,000 cached) and 20 written in all;
    // 10,989 (9,088 cached) and 5 of that were the earlier run's.
    expect(result.agents.find((seat) => seat.name === "codex-1")).toMatchObject({ tokens: 3_114, usage: { input: 3_099, cached: 17_912, output: 15 } });
    const wakes = (await readFile(join(out, "wakes.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seat: string; turn: number; tokens: number; failed: boolean; session_id: string | null });
    // Its first turn: the stream's running total (3,820 fresh read, 10 written) less the baseline (1,901 and 5).
    expect(wakes.find((line) => line.seat === "codex-1" && line.turn === 1)).toMatchObject({ tokens: 1_924, failed: false, session_id: CODEX_SESSION });
    expect(wakes.find((line) => line.seat === "claude-code-1" && line.turn === 1)).toMatchObject({ tokens: 0, failed: true });
    expect(result.tokens).toBe(result.agents.reduce((sum, seat) => sum + seat.tokens, 0));

    // What was said in the earlier Room is in the workspace, readable by the Agents' user.
    const file = join(workspace, "earlier-rooms", `${EARLIER_ROOM}.md`);
    expect(await readFile(file, "utf8")).toContain("#2 2026-11-20 08:11 codex-1: hash 9f86d0");
    expect((await stat(file)).mode & 0o044).toBe(0o044);
    expect((await stat(join(workspace, "earlier-rooms"))).mode & 0o055).toBe(0o055);
    // No sign-in and no key is in anything the run was told or wrote down.
    expect(JSON.stringify(calls)).not.toContain(OWNER_KEY);
  });

  it("starts a seat fresh when its home cannot be put back, and names a file it is given instead of writing one", async () => {
    const record = await earlierRecord();
    const { harnessTurns, calls, episode, workspace } = await resumedRun(record, { failCopyInto: "codex-1", input: { resume: { source: await readResumeSource(record), earlierRooms: "PREVIOUS_ROOM.md" } } });
    expect(episode.resume.seats["codex-1"]).toEqual({ resumed: false, reason: "home_not_restored" });
    expect(episode.resume.earlier_rooms).toBe("PREVIOUS_ROOM.md");
    // What was half copied is removed, and the seat gets the opening.
    expect(calls.some((call) => call.args.join(" ").endsWith(`${containerName(ROOM, "codex-1")} rm -rf /home/agents/codex-1`))).toBe(true);
    expect(harnessTurns("codex-1")[0]!.args.includes("resume")).toBe(false);
    expect(harnessTurns("codex-1")[0]!.args.at(-1)).toContain("What was said then is in PREVIOUS_ROOM.md in /workspace, oldest first.");
    // Its usage is then the fresh session's whole total: nothing is taken off.
    await expect(stat(join(workspace, "earlier-rooms"))).rejects.toThrow();
  });

  it("tells a resumed seat the Room's rules again when the run's are not the earlier run's", async () => {
    const record = await earlierRecord();
    const { harnessTurns } = await resumedRun(record, { input: { messageRouting: "mentions-only" } });
    const first = harnessTurns("codex-1")[0]!.args.at(-1)!;
    expect(first).toContain("How the Room works has changed too:\nA message wakes only the teammates it names with @name");
    expect(first).not.toContain("are as they were");
  });
});

describe("the same agents as the same members, in the earlier run's own Room", () => {
  const MEMBERS = { "codex-1": "i_OldSeat001", "codex-2": "i_OldSeat002", "codex-3": "i_OldSeat003", "claude-code-1": "i_OldSeat004" };
  /** The earlier run's record, in this run's own Room (`--room`), with the member each seat was there. */
  async function sameRoomRecord() {
    const record = await earlierRecord({ room_id: ROOM });
    const episode = JSON.parse(await readFile(join(record, "episode.json"), "utf8")) as { agents: Array<{ name: keyof typeof MEMBERS; member_id: string }> };
    for (const agent of episode.agents) agent.member_id = MEMBERS[agent.name];
    await writeFile(join(record, "episode.json"), JSON.stringify(episode));
    return record;
  }
  /** The Room as the runner reads it: codex-3's seat now goes by another name. */
  const listed = { room: { id: ROOM, type: "board", state: "open", goal: { message_id: "msg_goal000002", sequence: 1, until: ["said DONE", "budget 1M tokens", "after 2h"], started_at: AT, ended_by: null } }, memberships: Object.entries(MEMBERS).map(([name, member_id]) => ({ member_id, name: name === "codex-3" ? "codex-3-renamed" : name, state: "active", kind: "guest" })) };
  const token = (memberId: string) => `sni_${memberId.slice(2).padEnd(43, "x")}`;

  it("takes each seat's earlier member up, joins the others as new, and says which and why", async () => {
    const record = await sameRoomRecord();
    const asked: string[] = [];
    const { result, calls, of, harnessTurns, episode, logged } = await resumedRun(record, {
      service: (method, path, key) => {
        if (method === "GET" && path === `/rooms/${ROOM}` && key === "sni_owner-seat") return listed;
        const match = new RegExp(`^/rooms/${ROOM}/members/(i_[A-Za-z0-9]+)/token$`).exec(path);
        if (method !== "POST" || !match) return undefined;
        asked.push(`${match[1]} ${key}`);
        // codex-2's seat is not one the service will hand back.
        if (match[1] === MEMBERS["codex-2"]) return new CliError("member_not_reissuable", "Only a seat this goal Room's own invite brought into being…", 3);
        HANDED.set(token(match[1]!), match[1]!);
        return { room: { id: ROOM }, membership: { member_id: match[1], name: "x", kind: "guest" }, member_token: token(match[1]!) };
      },
    });
    // The owner's key asks for each seat the Room still lists under its own name, and only those.
    expect(asked).toEqual([MEMBERS["codex-1"], MEMBERS["codex-2"], MEMBERS["claude-code-1"]].map((id) => `${id} ${OWNER_KEY}`));
    // A taken-up seat enters with the handed token, by environment and in no argument; the others with the invite.
    const join = (seat: string) => of(seat).find((call) => call.args.includes("join"))!;
    for (const seat of ["codex-1", "claude-code-1"]) {
      expect(join(seat).env).toMatchObject({ SHAREDNET_MEMBER_TOKEN: token(MEMBERS[seat as keyof typeof MEMBERS]) });
      expect(join(seat).env).not.toHaveProperty("SHAREDNET_INVITE_TOKEN");
    }
    for (const seat of ["codex-2", "codex-3"]) {
      expect(join(seat).env).toMatchObject({ SHAREDNET_INVITE_TOKEN: INVITE });
      expect(join(seat).env).not.toHaveProperty("SHAREDNET_MEMBER_TOKEN");
    }
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain("sni_OldSeat");
    expect(JSON.stringify(calls)).not.toContain(OWNER_KEY);
    // The record: one member per agent where it could be, and why not where it could not.
    const members = {
      "codex-1": { taken_up: true, member_id: MEMBERS["codex-1"] },
      "codex-2": { taken_up: false, member_id: MEMBERS["codex-2"], reason: "member_not_reissuable" },
      "codex-3": { taken_up: false, member_id: MEMBERS["codex-3"], reason: "not_in_room" },
      "claude-code-1": { taken_up: true, member_id: MEMBERS["claude-code-1"] },
    };
    expect(episode.resume.members).toEqual(members);
    expect(result.resume?.members).toEqual(members);
    expect(episode.agents.map((seat: { name: string; member_id: string }) => [seat.name, seat.member_id])).toEqual([
      ["codex-1", MEMBERS["codex-1"]], ["codex-2", "i_Newcodex2"], ["codex-3", "i_Newcodex3"], ["claude-code-1", MEMBERS["claude-code-1"]],
    ]);
    // Each seat's later commands speak as the member it is.
    expect(harnessTurns("codex-1")[0]!.args).toContain(`SHAREDNET_SEAT=${MEMBERS["codex-1"]}`);
    expect(logged.join("")).toContain(`goal: codex-1 takes up its earlier member ${MEMBERS["codex-1"]}\n`);
    expect(logged.join("")).toContain(`goal: codex-2 joins as a new member; its earlier member ${MEMBERS["codex-2"]} was not taken up (member_not_reissuable)\n`);
    // What each is told: the resumed seat speaks from the same seat; a fresh session in an old seat is told whose lines those were.
    const first = harnessTurns("codex-1")[0]!.args.at(-1)!;
    expect(first).toContain(`- The Room is the same, ${ROOM}`);
    expect(first).toContain("You speak in it from the same seat as before: your earlier lines and this Goal's are one member's.");
    expect(first).not.toContain("from a new seat");
    // claude-code-1's session was refused, so it starts fresh in the seat it had.
    const fresh = harnessTurns("claude-code-1")[1]!.args.at(-1)!;
    expect(fresh).toContain("You speak from the seat claude-code-1 had in the earlier Goal: its lines before #1 were said from it by a session you do not remember.");
    // codex-2 is a new member and a new session: told nothing about a seat it does not have.
    expect(harnessTurns("codex-2")[0]!.args.at(-1)).not.toContain("You speak from the seat");
  });

  it("joins every seat as a new member, as before, when the service cannot hand a seat back", async () => {
    const record = await sameRoomRecord();
    const { episode, harnessTurns, of } = await resumedRun(record, {
      service: (method, path) => {
        if (method === "GET" && path === `/rooms/${ROOM}`) return listed;
        // An older service has no such route.
        if (method === "POST" && path.endsWith("/token")) return new CliError("route_not_found", "Route was not found.", 4);
        return undefined;
      },
    });
    expect(Object.values(episode.resume.members).map((member: any) => member.reason)).toEqual(["route_not_found", "route_not_found", "route_not_found", "not_in_room"].sort((left, right) => (left === "not_in_room" ? -1 : right === "not_in_room" ? 1 : 0)));
    for (const seat of ["codex-1", "codex-2", "codex-3", "claude-code-1"]) expect(of(seat).find((call) => call.args.includes("join"))!.env).toMatchObject({ SHAREDNET_INVITE_TOKEN: INVITE });
    expect(harnessTurns("codex-1")[0]!.args.at(-1)).toContain("You speak in it from a new seat under the same name; the seat you spoke from before is no longer used.");
  });

  it("joins as new when the Room cannot be read, and when the seat's own join with the handed token fails", async () => {
    const record = await sameRoomRecord();
    // The runner's first read of the Room fails; the goal's own reads after it do not.
    let reads = 0;
    const unread = await resumedRun(record, { service: (method, path) => (method === "GET" && path === `/rooms/${ROOM}` && (reads += 1) === 1 ? new CliError("service_unavailable", "down", 5) : undefined) });
    expect(Object.values(unread.episode.resume.members).every((member: any) => member.taken_up === false && member.reason === "room_unreadable")).toBe(true);
    const failing = await resumedRun(record, {
      service: (method, path) => {
        if (method === "GET" && path === `/rooms/${ROOM}`) return listed;
        // A token that enters as nobody the run expects.
        if (method === "POST" && path.endsWith("/token")) return { membership: { member_id: path.split("/")[4] }, member_token: `sni_${"z".repeat(43)}` };
        return undefined;
      },
    });
    expect(failing.episode.resume.members["codex-1"]).toEqual({ taken_up: false, member_id: MEMBERS["codex-1"], reason: "join_failed" });
    // It tried the handed token once, then joined with the invite.
    expect(failing.of("codex-1").filter((call) => call.args.includes("join")).map((call) => Object.keys(call.env).find((key) => key.endsWith("_TOKEN")))).toEqual(["SHAREDNET_MEMBER_TOKEN", "SHAREDNET_INVITE_TOKEN"]);
  });
});

describe("a seat handed its earlier member (SHAREDNET_MEMBER_TOKEN)", () => {
  const OWNER = `snk_${"g".repeat(43)}`;
  /** The client's own service, in memory: the owner's run made a goal Room and an agent joined it with the run's invite. */
  async function swarm() {
    const store = new MemorySharedNetRepository({ accounts: [{ authUserId: "ada", apiKey: OWNER, displayName: "Ada" }] });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => handleRequest(new Request(input, init), store)) as typeof globalThis.fetch;
    const api = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:3001/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(method === "POST" && /\/rooms$|\/messages$/.test(path) ? { "idempotency-key": crypto.randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const runner = await api("POST", "/instances", OWNER, { runtime_kind: "custom", cli_version: "0.1.3" });
    const room = await api("POST", "/rooms", runner.body.token, { name: "Swarm" });
    const roomId = room.body.room.id as string;
    await api("POST", `/rooms/${roomId}/goal`, OWNER, { content: "First goal.", until: ["after 1h"] });
    const invite = await api("POST", `/rooms/${roomId}/invites`, runner.body.token);
    const seat = await api("POST", `/rooms/${roomId}/join`, invite.body.token, { name: "codex-1" });
    await api("POST", `/rooms/${roomId}/messages`, seat.body.member_token, { content: "HASH codex-1 9f86d0" });
    return { fetch, api, roomId, memberId: seat.body.membership.member_id as string, oldToken: seat.body.member_token as string, runnerToken: runner.body.token as string };
  }
  async function cli(argv: string[], fetch: typeof globalThis.fetch, env: Record<string, string>, home: string) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runCli(argv, {
      cwd: join(home, "workspace"),
      env: { HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state"), SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_WAKE: "off", ...env },
      fetch,
      sleep: async () => undefined,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
  }

  it("enters the Room as that member, takes its place after the newest line, and speaks as it", async () => {
    const { fetch, api, roomId, memberId, oldToken, runnerToken } = await swarm();
    // The goal ends; the owner opens the Room again, says the next goal and takes the seat up.
    await api("POST", `/rooms/${roomId}/close`, OWNER, { trigger: "said DONE", detail: null });
    await api("POST", `/rooms/${roomId}/reopen`, OWNER);
    const next = await api("POST", `/rooms/${roomId}/goal`, OWNER, { content: "Second goal.", until: ["after 1h"] });
    const handed = await api("POST", `/rooms/${roomId}/members/${memberId}/token`, OWNER);
    expect(handed.status).toBe(200);
    const home = await temporary();
    await mkdir(join(home, "workspace"), { recursive: true });
    const joined = await cli(["join", roomId, "--name", "codex-1", "--json"], fetch, { SHAREDNET_MEMBER_TOKEN: handed.body.member_token }, home);
    expect(joined.exitCode).toBe(0);
    const said = JSON.parse(joined.stdout);
    expect(said).toMatchObject({ member_id: memberId, name: "codex-1", as: "handed", last_sequence: next.body.message.sequence });
    // The token is in the seat's own credential file, and in nothing it printed.
    expect(joined.stdout + joined.stderr).not.toContain(handed.body.member_token);
    // Its place is after the next goal's message: the earlier goal's lines are not handed to it again.
    const place = await api("GET", `/rooms/${roomId}/subscription`, handed.body.member_token);
    expect(place.body.subscription.acked_through).toBe(next.body.message.sequence);
    const spoke = await cli(["say", "WORD codex-1 thistledown", "--json"], fetch, {}, home);
    expect(spoke.exitCode).toBe(0);
    const log = await api("GET", `/rooms/${roomId}/messages?after=0&limit=100`, runnerToken);
    expect(log.body.items.filter((message: any) => message.sender_instance_id === memberId).map((message: any) => message.content)).toEqual(["HASH codex-1 9f86d0", "WORD codex-1 thistledown"]);
    const view = await api("GET", `/rooms/${roomId}`, runnerToken);
    expect(view.body.memberships.filter((member: any) => member.name === "codex-1")).toHaveLength(1);
    expect((await api("GET", `/rooms/${roomId}`, oldToken)).status).toBe(401);
  });

  it("takes only a member token, and neither an invite nor a claim beside it", async () => {
    const { fetch, roomId } = await swarm();
    const home = await temporary();
    await mkdir(join(home, "workspace"), { recursive: true });
    const malformed = await cli(["join", roomId, "--json"], fetch, { SHAREDNET_MEMBER_TOKEN: "rit_not-a-member-token" }, home);
    expect(malformed.exitCode).not.toBe(0);
    expect(malformed.stderr).toContain("SHAREDNET_MEMBER_TOKEN holds a seat's member token");
    const both = await cli(["join", roomId, "--json"], fetch, { SHAREDNET_MEMBER_TOKEN: `sni_${"a".repeat(43)}`, SHAREDNET_INVITE_TOKEN: `rit_${"b".repeat(43)}` }, home);
    expect(both.exitCode).not.toBe(0);
    expect(both.stderr).toContain("it takes no invite and no claim");
  });
});

describe("goal run --resume-from on the command line", () => {
  async function refused(argv: string[], files: Record<string, string> = {}) {
    const root = await temporary();
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(root, name, ".."), { recursive: true });
      await writeFile(join(root, name), content);
    }
    const stderr: string[] = [];
    let requests = 0;
    const exitCode = await runCli(argv, {
      cwd: root,
      env: { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_API_KEY: "snk_never-sent" },
      fetch: (async () => { requests += 1; throw new Error("nothing may be sent"); }) as unknown as typeof globalThis.fetch,
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
    });
    return { exitCode, stderr: stderr.join(" "), requests };
  }
  const run = ["goal", "run", "TASK.md", "--agent", "codex", "--until", "after: 1h"];

  it("refuses, before anything is sent, a record that is not one and the options it does not go with", async () => {
    const notARecord = await refused([...run, "--resume-from", "runs/nothing"], { "TASK.md": "Do it." });
    expect(notARecord.exitCode).not.toBe(0);
    expect(notARecord.stderr).toContain("is not a goal run's record");
    const alone = await refused([...run, "--earlier-rooms", "PREVIOUS_ROOM.md"], { "TASK.md": "Do it." });
    expect(alone.stderr).toContain("it goes with --resume-from");
    const frozen = await refused(["goal", "run", "TASK.md", "--agent", "codex:gpt-test", "--until", "after: 1h", "--harness-mode", "research/baseline@1", "--resume-from", "runs/earlier"], { "TASK.md": "Do it." });
    expect(frozen.stderr).toContain("--resume-from is not part of one");
    const compiled = await refused([...run, "--type", "compiled", "--resume-from", "runs/earlier"], { "TASK.md": "Do it." });
    expect(compiled.stderr).toContain("--resume-from is for plain board Rooms");
    const episode = JSON.stringify({ room_id: EARLIER_ROOM, agents: [] });
    for (const file of ["../PREVIOUS_ROOM.md", "/etc/hostname", "missing.md"]) {
      const outside = await refused([...run, "--resume-from", "runs/earlier", "--earlier-rooms", file], { "TASK.md": "Do it.", "runs/earlier/episode.json": episode });
      expect(outside.stderr).toContain("is not a file in the workspace");
    }
    for (const result of [notARecord, alone, frozen, compiled]) expect(result.requests).toBe(0);
  });

  it("refuses, before anything is sent, a --room that is not a Room id or does not go with the other options", async () => {
    const notAnId = await refused([...run, "--room", "my-room"], { "TASK.md": "Do it." });
    expect(notAnId.stderr).toContain("--room names a Room of yours by its id");
    const compiled = await refused([...run, "--type", "compiled", "--room", EARLIER_ROOM], { "TASK.md": "Do it." });
    expect(compiled.stderr).toContain("--room is for plain board Rooms");
    const named = await refused([...run, "--name", "Another", "--room", EARLIER_ROOM], { "TASK.md": "Do it." });
    expect(named.stderr).toContain("--name names a new Room");
    const frozen = await refused(["goal", "run", "TASK.md", "--agent", "codex:gpt-test", "--until", "after: 1h", "--harness-mode", "research/baseline@1", "--room", EARLIER_ROOM], { "TASK.md": "Do it." });
    expect(frozen.stderr).toContain("--resume-from is not part of one");
    const episode = JSON.stringify({ room_id: EARLIER_ROOM, agents: [] });
    const overwrite = await refused([...run, "--resume-from", "runs/earlier", "--out", "runs/earlier"], { "TASK.md": "Do it.", "runs/earlier/episode.json": episode });
    expect(overwrite.stderr).toContain("cannot be the record --resume-from reads");
    for (const result of [notAnId, compiled, named, frozen, overwrite]) expect(result.requests).toBe(0);
  });
});

describe("the next goal of a Room that exists (goal run --room)", () => {
  /** A service that answers the three calls, or refuses the one named. */
  function service(refuse: { path?: string; code?: string; room?: Record<string, unknown> } = {}) {
    const calls: Array<{ method: string; path: string; token: string; body: unknown }> = [];
    const fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v1/, "");
      calls.push({ method: init?.method ?? "GET", path, token: String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /, ""), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (refuse.path && path.endsWith(refuse.path)) return new Response(JSON.stringify({ error: { code: refuse.code ?? "room_not_found", message: "Room was not found." } }), { status: refuse.code === "goal_already_set" ? 409 : 404, headers: { "content-type": "application/json" } });
      const body = path.endsWith("/reopen") ? { room: { id: EARLIER_ROOM, type: "board", state: "open", ...refuse.room } }
        : path.endsWith("/join") ? { room: { id: EARLIER_ROOM }, membership: { member_id: "i_runner0001" } }
        : { room: { id: EARLIER_ROOM }, message: { id: "msg_next000001", sequence: 41 } };
      return new Response(JSON.stringify(body), { status: path.endsWith("/goal") ? 201 : 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    return { calls, client: new ApiClient("http://127.0.0.1:3001", fetch) };
  }

  it("opens the Room again by the owner's key, seats the runner in it, and says the goal there", async () => {
    const { calls, client } = service();
    const started = await sayNextGoal(client, "snk_owner", "sni_runner", EARLIER_ROOM, "Say the word.", ["after 10m"]);
    expect(started.message).toMatchObject({ sequence: 41 });
    expect(calls.map((call) => `${call.method} ${call.path} ${call.token}`)).toEqual([
      `POST /rooms/${EARLIER_ROOM}/reopen snk_owner`,
      `POST /rooms/${EARLIER_ROOM}/join sni_runner`,
      `POST /rooms/${EARLIER_ROOM}/goal snk_owner`,
    ]);
    expect(calls[2]!.body).toEqual({ content: "Say the word.", until: ["after 10m"] });
  });

  it("says room_not_reusable for any refusal on the way, before an Agent starts", async () => {
    for (const [refuse, said] of [
      [{ path: "/reopen", code: "room_not_found" }, null],
      [{ path: "/goal", code: "goal_already_set" }, null],
      [{ room: { type: "compiled" } }, "it is not a plain board Room."],
      [{ room: { kind: "direct" } }, "it is not a plain board Room."],
    ] as const) {
      const { client } = service(refuse);
      const error = await sayNextGoal(client, "snk_owner", "sni_runner", EARLIER_ROOM, "Go.", ["after 10m"]).then(() => null, (caught: unknown) => caught as { code: string; message: string });
      expect(error?.code).toBe("room_not_reusable");
      // The service's refusal in the CLI's words, or what the CLI found itself.
      expect(error?.message).toMatch(said === null ? new RegExp(`^${EARLIER_ROOM} cannot take this Goal: .+`) : new RegExp(`^${EARLIER_ROOM} cannot take this Goal: ${said.replace(".", "\\.")}$`));
    }
  });
});
