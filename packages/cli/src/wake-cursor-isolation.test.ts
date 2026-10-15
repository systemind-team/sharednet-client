// @vitest-environment node

import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.ts";
import { getStoragePaths, writeRoomCredential, type StoredRoomCredential } from "./storage.ts";
import { cursorPlugin, cursorSummary } from "./wake-cursor.ts";
import { runTurn, type DeliveryContext, type SeatWake, type TurnOutcome, type TurnRunner, type TurnSpec, type WakeInput } from "./wake-driver.ts";
import { parseSeatWake, seatWakeFrom, wakePlugins } from "./wake-plugins.ts";

/**
 * The cursor plugin is experimental and not yet run against a signed-in Cursor CLI. What it must
 * not do is change anything for a machine that never binds a seat to it, or let anything the Cursor
 * CLI does take serve or another seat down with it. These are the regressions for that bar
 * (PR #30): (b) the registry, join and a serve with only claude-code, codex and command seats are as
 * on main; (c) malformed output, a non-zero exit, a hang, huge output and a missing program each
 * fail only the cursor seat's own delivery, cleanly.
 */

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanup.push(directory);
  return directory;
}

/** A directory of programs that do nothing; a test's runner answers for them. */
async function programs(...names: string[]): Promise<string> {
  const directory = await scratch("sharednet-iso-bin-");
  for (const name of names) {
    await writeFile(join(directory, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(directory, name), 0o755);
  }
  return directory;
}

/** A real program that does what a broken Cursor CLI might, for the real runner. */
async function script(body: string): Promise<string> {
  const directory = await scratch("sharednet-iso-agent-");
  const path = join(directory, "agent");
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** A Room service per Room: one addressed line, then a refusal that ends the seat's loop. */
function service(rooms: Record<string, { member: string; asked: string }>) {
  const posted: Record<string, string[]> = {};
  const acked: Record<string, number[]> = {};
  const waits: Record<string, number> = {};
  const unexpected: string[] = [];
  let hold: Record<string, Promise<void>> = {};
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const line = (roomId: string) => ({
    id: `msg_${roomId}`,
    room_id: roomId,
    sequence: 2,
    type: "message",
    content: rooms[roomId]!.asked,
    sender: { member_id: "i_HostHostHo", kind: "instance", name: "host" },
    created_at: "2026-10-15T10:00:00.000Z",
    mentions: [rooms[roomId]!.member],
  });
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const match = /^\/api\/v1\/rooms\/(rom_[A-Za-z0-9]+)(\/[a-z]+)?$/.exec(url.pathname);
    const roomId = match?.[1];
    if (!match || !roomId || !rooms[roomId]) {
      unexpected.push(`${init.method ?? "GET"} ${url.pathname}`);
      return json({ error: { code: "not_found", message: "no" } }, 404);
    }
    const method = init.method ?? "GET";
    const place = { subscription: { room_id: roomId, delivered_through: Math.max(1, ...(acked[roomId] ?? [])), acked_through: Math.max(1, ...(acked[roomId] ?? [])) } };
    if (match[2] === "/subscription") return json(place);
    if (match[2] === "/ack") {
      (acked[roomId] ??= []).push((JSON.parse(String(init.body)) as { through: number }).through);
      return json(place);
    }
    if (match[2] === "/wait") {
      waits[roomId] = (waits[roomId] ?? 0) + 1;
      if (waits[roomId] === 1) return json({ items: [line(roomId)], next_cursor: null, has_more: false });
      await hold[roomId];
      return json({ error: { code: "invalid_credentials", message: "Credentials are invalid." } }, 401);
    }
    if (match[2] === "/messages" && method === "GET") return json({ items: [line(roomId)], next_cursor: null, has_more: false });
    if (match[2] === "/messages" && method === "POST") {
      (posted[roomId] ??= []).push((JSON.parse(String(init.body)) as { content: string }).content);
      return json({ message: { ...line(roomId), sequence: 3, content: "posted" } }, 201);
    }
    unexpected.push(`${method} ${url.pathname}`);
    return json({ error: { code: "not_found", message: "no" } }, 404);
  }) as typeof globalThis.fetch;
  return { fetch, posted, acked, unexpected, holdWaits: (holds: Record<string, Promise<void>>) => (hold = holds) };
}

async function machine(seats: Array<{ roomId: string; memberId: string; wake: (bin: string, cwd: string) => SeatWake }>) {
  const root = await scratch("sharednet-iso-");
  const bin = await programs("claude", "codex", "agent", "adapter.sh");
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const env: Record<string, string> = { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), PATH: bin, CODEX_HOME: join(root, "codex-home") };
  const paths = getStoragePaths(env);
  for (const seat of seats) {
    const credential: StoredRoomCredential = {
      schema_version: 1,
      base_url: "https://www.sharednet.ai",
      room_id: seat.roomId,
      member_id: seat.memberId,
      name: seat.memberId.slice(2).toLowerCase(),
      member_token: `sni_${"M".repeat(43)}`,
      joined_at: "2026-10-15T00:00:00.000Z",
      room_type: "board",
      wake: seat.wake(bin, work),
    };
    await writeRoomCredential(paths, credential);
  }
  return { root, bin, work, env };
}

/** Answers every program by what it was asked, as the real ones would when all is well. */
function healthy(spec: TurnSpec): TurnOutcome {
  const program = basename(spec.command);
  const done = (stdout: string): TurnOutcome => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
  if (spec.args[0] === "--version") return done(`${program} 1.0.0\n`);
  if (spec.args.join(" ") === "auth status --json") return done('{"loggedIn":true}');
  if (spec.args.join(" ") === "login status") return done("Logged in using ChatGPT\n");
  if (program === "claude") return done(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "@host claude here" }));
  if (program === "codex") return done([{ type: "item.completed", item: { type: "agent_message", text: "@host codex here" } }, { type: "turn.completed", usage: {} }].map((event) => JSON.stringify(event)).join("\n"));
  if (program === "adapter.sh") return done("@host adapter here\n");
  return { exitCode: 1, stdout: "", stderr: `unexpected ${program}`, timedOut: false };
}

const MAIN_SEATS = [
  { roomId: "rom_ClaudeRoom", memberId: "i_ClaudeSeat", wake: (bin: string, cwd: string): SeatWake => ({ driver: "claude-code", session: "6613bb00", cwd, command: join(bin, "claude") }) },
  { roomId: "rom_CodexRoom", memberId: "i_CodexSeat0", wake: (bin: string, cwd: string): SeatWake => ({ driver: "codex", session: "019a-thread", cwd, command: join(bin, "codex"), codex_home: "/codex-home" }) },
  { roomId: "rom_CommandRoom", memberId: "i_CommandSeat", wake: (bin: string, cwd: string): SeatWake => ({ driver: "command", cwd, command: join(bin, "adapter.sh") }) },
];

describe("(b) with no seat bound to cursor, everything is as on main", () => {
  // Every environment a join can be run from that the existing plugins (or none) recognise, alone and
  // inside Cursor: Cursor's markers must change nothing about what is captured.
  const HARNESSES: Record<string, Record<string, string>> = {
    none: { PATH: "" },
    codex: { CODEX_SESSION_ID: "019a-codex-thread", CODEX_HOME: "/codex-home", PATH: "" },
    "codex thread": { CODEX_THREAD_ID: "019a-codex-thread", PATH: "" },
    "claude-code": { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "6613", PATH: "" },
    "claude-code open chat": { CLAUDE_CODE_SESSION_ID: "6613", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_PID: "4321", PATH: "" },
    "claude-code headless": { CLAUDE_CODE_SESSION_ID: "6613", CLAUDE_CODE_SESSION_ATTENDED: "0", CLAUDE_PID: "4321", PATH: "" },
    codebuddy: { CODEBUDDY_SESSION_ID: "cb-1", CODEBUDDY_CONFIG_DIR: "/home/yu/.codebuddy", PATH: "" },
    workbuddy: { CODEBUDDY_SESSION_ID: "wb-1", CODEBUDDY_HOST: "workbuddy-desktop", CODEBUDDY_CONFIG_DIR: "/home/yu/.workbuddy", WORKBUDDY_CONFIG_DIR: "/home/yu/.workbuddy", PATH: "" },
  };
  const CURSOR_MARKERS = { CURSOR_AGENT: "1", CURSOR_TRACE_ID: "editor-trace", CURSOR_AGENT_WORKER_ID: "pw_1", CURSOR_WAKE: "1", CURSOR_SANDBOX: "seatbelt" };

  it("captures at join exactly what the registry without cursor captures, from any harness, inside Cursor or not; cursor itself never", () => {
    const mainRegistry = wakePlugins.filter((plugin) => plugin.driver !== "cursor");
    // The registry is main's, in main's order, with cursor added before command.
    expect(mainRegistry.map((plugin) => plugin.driver)).toEqual(["codex", "claude-code", "codebuddy", "command"]);
    const firstOf = (env: Record<string, string>) => {
      for (const plugin of mainRegistry) {
        const wake = plugin.capture(env, "/w");
        if (wake) return wake;
      }
      return null;
    };
    for (const [name, env] of Object.entries(HARNESSES)) {
      for (const [where, inside] of [["outside Cursor", env], ["inside Cursor", { ...env, ...CURSOR_MARKERS }]] as const) {
        expect(seatWakeFrom(inside, "/w"), `${name} ${where}`).toEqual(firstOf(inside));
        expect(seatWakeFrom(inside, "/w")?.driver, `${name} ${where}`).not.toBe("cursor");
        expect(cursorPlugin.capture(inside, "/w"), `${name} ${where}`).toBeNull();
      }
      // Cursor's markers change nothing about what any harness is captured as.
      expect(seatWakeFrom({ ...env, ...CURSOR_MARKERS }, "/w"), name).toEqual(seatWakeFrom(env, "/w"));
    }
  });

  it("reads every stored wake of the other drivers as before", () => {
    const stored: Array<[unknown, unknown]> = [
      [{ driver: "codex", session: "019a", cwd: "/w", command: "codex", codex_home: "/h", turn_limit_ms: 90 * 60_000 }, { driver: "codex", session: "019a", cwd: "/w", command: "codex", codex_home: "/h", turn_limit_ms: 90 * 60_000 }],
      [{ driver: "claude-code", session: "6613", cwd: "/w", command: "claude", live_pid: 4321, codex_home: "" }, { driver: "claude-code", session: "6613", cwd: "/w", command: "claude", live_pid: 4321 }],
      [{ driver: "codebuddy", session: "wb-1", cwd: "/w", command: "codebuddy", config_dir: "/c" }, { driver: "codebuddy", session: "wb-1", cwd: "/w", command: "codebuddy", config_dir: "/c" }],
      [{ driver: "command", cwd: "/w", command: "/bin/adapter" }, { driver: "command", cwd: "/w", command: "/bin/adapter" }],
      [{ driver: "claude-code", cwd: "/w", command: "claude" }, undefined],
      [{ driver: "gemini-cli", session: "s", cwd: "/w", command: "x" }, undefined],
      [{ driver: "codex", session: "s", cwd: "/w", command: "codex", turn_limit_ms: 5 }, undefined],
    ];
    for (const [value, expected] of stored) expect(parseSeatWake(value), JSON.stringify(value)).toEqual(expected);
  });

  it("serves claude-code, codex and command seats exactly as main does, and never asks the cursor plugin anything", async () => {
    const deliver = vi.spyOn(cursorPlugin, "deliver");
    const check = vi.spyOn(cursorPlugin, "check");
    const capture = vi.spyOn(cursorPlugin, "capture");
    const space = await machine(MAIN_SEATS);
    const room = service({
      rom_ClaudeRoom: { member: "i_ClaudeSeat", asked: "@claudeseat status?" },
      rom_CodexRoom: { member: "i_CodexSeat0", asked: "@codexseat0 status?" },
      rom_CommandRoom: { member: "i_CommandSeat", asked: "@commandseat status?" },
    });
    const turns: TurnSpec[] = [];
    const run: TurnRunner = async (spec) => (turns.push(spec), healthy(spec));
    const stderr: string[] = [];
    const exitCode = await runCli(["serve", "--json"], {
      env: space.env,
      fetch: room.fetch,
      cwd: space.work,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
      sleep: async () => undefined,
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
      runTurn: run,
      rescanMs: 3_600_000,
      processProbe: { supported: true, alive: () => false, identity: (pid) => `test-start-${pid}`, argv: () => null },
    });

    expect(exitCode).toBe(0);
    expect(room.unexpected).toEqual([]);
    // What each program was asked, in each seat's order, byte for byte (the prompt by its hash, the
    // machine's scratch root written as <root>). Recorded against main (194ad3c) with this same test.
    const asked = (spec: TurnSpec) => {
      const text = (value: string) => value.split(space.root).join("<root>").split(space.bin).join("<bin>");
      return `${basename(spec.command)} ${spec.args.map(text).join(" ")} | cwd ${text(spec.cwd)} | env ${Object.keys(spec.env).sort().join(",")} | input ${spec.input === "" ? "-" : sha(text(spec.input))} | ${spec.timeoutMs}ms`;
    };
    const byProgram = (program: string) => turns.filter((spec) => basename(spec.command) === program).map(asked);
    expect({ claude: byProgram("claude"), codex: byProgram("codex"), adapter: byProgram("adapter.sh") }).toEqual(MAIN_TURNS);
    expect(turns.map((spec) => basename(spec.command)).filter((program) => !["claude", "codex", "adapter.sh"].includes(program))).toEqual([]);
    expect(room.posted).toEqual({ rom_ClaudeRoom: ["@host claude here"], rom_CodexRoom: ["@host codex here"], rom_CommandRoom: ["@host adapter here"] });
    expect(room.acked).toEqual({ rom_ClaudeRoom: [2], rom_CodexRoom: [2], rom_CommandRoom: [2] });
    const log = stderr.join("").split(space.bin).join("<bin>").split("\n").filter((line) => line !== "").sort();
    expect(log).toEqual(MAIN_LOG);
    // The cursor plugin was never asked to capture, check or deliver anything.
    expect(deliver).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  // Recorded by running the test above against origin/codex/bootstrap-base 194ad3c (main, no cursor plugin).
  const MAIN_TURNS = {
    claude: [
      "claude --version | cwd <root>/work | env CODEX_HOME,HOME,PATH,XDG_CONFIG_HOME,XDG_STATE_HOME | input - | 5000ms",
      "claude auth status --json | cwd <root>/work | env CODEX_HOME,HOME,PATH,XDG_CONFIG_HOME,XDG_STATE_HOME | input - | 15000ms",
      "claude -p --resume 6613bb00 --output-format json | cwd <root>/work | env CODEX_HOME,HOME,PATH,SHAREDNET_SEAT,XDG_CONFIG_HOME,XDG_STATE_HOME | input b1d120aeb4d28dd1 | 2400000ms",
    ],
    codex: [
      "codex --version | cwd <root>/work | env CODEX_HOME,HOME,PATH,XDG_CONFIG_HOME,XDG_STATE_HOME | input - | 5000ms",
      "codex login status | cwd <root>/work | env CODEX_HOME,HOME,PATH,XDG_CONFIG_HOME,XDG_STATE_HOME | input - | 15000ms",
      'codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" 019a-thread - | cwd <root>/work | env CODEX_HOME,HOME,PATH,SHAREDNET_SEAT,XDG_CONFIG_HOME,XDG_STATE_HOME | input 65095413623dbb00 | 2400000ms',
    ],
    adapter: [
      "adapter.sh  | cwd <root>/work | env CODEX_HOME,HOME,PATH,SHAREDNET_ROOM_ID,SHAREDNET_SEAT,XDG_CONFIG_HOME,XDG_STATE_HOME | input 9ba1977f6708d9f7 | 2400000ms",
    ],
  };
  const MAIN_LOG: string[] = [
    "serve: rom_ClaudeRoom claudeseat (i_ClaudeSeat) wake warning: session failed: no transcript for session 6613bb00 under the Claude Code projects directory, so `claude --resume` has nothing to resume. Set the session again from inside it (`sharednet wake set claude-code`) or give `--resume <session id>`. Check with `sharednet wake check --as i_ClaudeSeat`.",
    "serve: rom_ClaudeRoom claudeseat (i_ClaudeSeat) wakes claude-code 6613bb00 when addressed",
    "serve: rom_ClaudeRoom claudeseat finished its turn: @host claude here",
    "serve: rom_ClaudeRoom i_ClaudeSeat stopped: invalid_credentials",
    "serve: rom_CodexRoom codexseat0 (i_CodexSeat0) wake warning: session failed: no rollout for thread 019a-thread under /codex-home/sessions, so `codex exec resume` has nothing to resume. Set the thread again from inside it (`sharednet wake set codex`) or give `--resume <thread id>`. Check with `sharednet wake check --as i_CodexSeat0`.",
    "serve: rom_CodexRoom codexseat0 (i_CodexSeat0) wakes codex 019a-thread when addressed",
    "serve: rom_CodexRoom codexseat0 finished its turn: @host codex here",
    "serve: rom_CodexRoom i_CodexSeat0 stopped: invalid_credentials",
    "serve: rom_CommandRoom commandseat (i_CommandSeat) wakes command <bin>/adapter.sh when addressed",
    "serve: rom_CommandRoom commandseat finished its turn: @host adapter here",
    "serve: rom_CommandRoom i_CommandSeat stopped: invalid_credentials",
    "serve: sitting in 3 Room(s): rom_ClaudeRoom, rom_CodexRoom, rom_CommandRoom",
  ];

});

describe("(c) nothing the Cursor CLI does takes down serve or holds up another seat", () => {
  const SEATS = [
    MAIN_SEATS[0]!,
    { roomId: "rom_CursorRoom", memberId: "i_CursorSeat", wake: (bin: string, cwd: string): SeatWake => ({ driver: "cursor", session: "8f1c0d6e-2b7a-4c1e-9d11-0a5b3c2d1e00", cwd, command: join(bin, "agent") }) },
  ];
  const ROOMS = {
    rom_ClaudeRoom: { member: "i_ClaudeSeat", asked: "@claudeseat status?" },
    rom_CursorRoom: { member: "i_CursorSeat", asked: "@cursorseat status?" },
  };
  const junk = "warning: something\n".repeat(14_000);
  const BEHAVIOURS: Array<[string, TurnOutcome, string]> = [
    ["malformed JSON", { exitCode: 0, stdout: '{"type":"result","subtype":"success","is_error":fal', stderr: "", timedOut: false }, "the Cursor CLI printed no result object"],
    ["a result that is not the success object", { exitCode: 0, stdout: JSON.stringify({ type: "result", is_error: false, result: 7 }), stderr: "", timedOut: false }, "not the documented success object"],
    ["a non-zero exit", { exitCode: 1, stdout: "", stderr: "Error: Not authenticated\n", timedOut: false }, "the cursor command exited 1"],
    ["a hang, stopped at its limit", { exitCode: 143, stdout: "", stderr: "", timedOut: true }, "turn was stopped after 40 minutes"],
    ["huge output (256 KiB of lines that are not JSON)", { exitCode: 0, stdout: `${junk}{"type":"result"`, stderr: junk, timedOut: false }, "the Cursor CLI printed no result object"],
    ["a missing program", { exitCode: 127, stdout: "", stderr: "Error: spawn agent ENOENT", timedOut: false }, "the cursor command exited 127"],
  ];

  it.each(BEHAVIOURS)("%s: the other seat is answered while the cursor turn is still running, and the cursor seat fails cleanly", async (_name, outcome, notice) => {
    const space = await machine(SEATS);
    const room = service(ROOMS);
    // The cursor turn is held open until the claude seat has posted its reply.
    let claudeReplied!: () => void;
    const replied = new Promise<void>((resolve) => (claudeReplied = resolve));
    // And the claude turn starts only once the cursor turn is open, so the order is fixed.
    let cursorOpened!: () => void;
    const opened = new Promise<void>((resolve) => (cursorOpened = resolve));
    let cursorTurnOpen = false;
    let claudeRepliedWhileCursorOpen = false;
    const run: TurnRunner = async (spec) => {
      const program = basename(spec.command);
      if (program === "agent" && spec.args[0] === "-p") {
        cursorTurnOpen = true;
        cursorOpened();
        await replied;
        cursorTurnOpen = false;
        return outcome;
      }
      if (program === "agent" && spec.args[0] === "status") return { exitCode: 0, stdout: '{"isAuthenticated":true}', stderr: "", timedOut: false };
      if (program === "claude" && spec.args[0] === "-p") await opened;
      return healthy(spec);
    };
    const watching: typeof globalThis.fetch = async (input, init) => {
      const answer = await room.fetch(input, init);
      if (init?.method === "POST" && String(input).includes("rom_ClaudeRoom/messages")) {
        claudeRepliedWhileCursorOpen = cursorTurnOpen;
        claudeReplied();
      }
      return answer;
    };
    const stderr: string[] = [];
    const exitCode = await runCli(["serve", "--json"], {
      env: space.env,
      fetch: watching,
      cwd: space.work,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
      sleep: async () => undefined,
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
      runTurn: run,
      rescanMs: 3_600_000,
      processProbe: { supported: true, alive: () => false, identity: (pid) => `test-start-${pid}`, argv: () => null },
    });

    expect(exitCode).toBe(0);
    expect(room.unexpected).toEqual([]);
    expect(claudeRepliedWhileCursorOpen).toBe(true);
    expect(room.posted.rom_ClaudeRoom).toEqual(["@host claude here"]);
    // The cursor seat says it failed, in its own Room, and its line is handled (not retried forever).
    expect(room.posted.rom_CursorRoom).toHaveLength(1);
    expect(room.posted.rom_CursorRoom![0]).toContain(notice);
    expect(room.acked).toEqual({ rom_ClaudeRoom: [2], rom_CursorRoom: [2] });
    // Nothing the CLI printed is posted to the Room raw.
    expect(room.posted.rom_CursorRoom![0]!.length).toBeLessThan(400);
  });

  it("a missing Cursor program holds back only the cursor seat at serve's start; the other seat is served", async () => {
    const space = await machine(SEATS);
    await rm(join(space.bin, "agent"));
    const room = service(ROOMS);
    const stopping = new AbortController();
    // The cursor seat keeps looking for its program; serve is stopped once the other seat is done.
    room.holdWaits({ rom_ClaudeRoom: Promise.resolve() });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const answer = await room.fetch(input, init);
      if (init?.method === "POST" && String(input).includes("rom_ClaudeRoom/messages")) setTimeout(() => stopping.abort(), 20);
      return answer;
    };
    const stderr: string[] = [];
    const turns: TurnSpec[] = [];
    const exitCode = await runCli(["serve", "--json"], {
      env: space.env,
      fetch,
      cwd: space.work,
      now: () => new Date("2026-10-15T10:00:00.000Z"),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      stdout: () => undefined,
      stderr: (value) => stderr.push(value),
      runTurn: async (spec) => (turns.push(spec), healthy(spec)),
      rescanMs: 3_600_000,
      signal: stopping.signal,
      processProbe: { supported: true, alive: () => false, identity: (pid) => `test-start-${pid}`, argv: () => null },
    });
    expect(exitCode).toBe(0);
    expect(room.posted).toEqual({ rom_ClaudeRoom: ["@host claude here"] });
    expect(stderr.join("")).toContain(`rom_CursorRoom cursorseat (i_CursorSeat) not driven: program failed: ${join(space.bin, "agent")} is not executable`);
    // None of the cursor seat's lines were read or acknowledged while its program was missing.
    expect(room.acked.rom_CursorRoom).toBeUndefined();
    expect(turns.some((spec) => basename(spec.command) === "agent")).toBe(false);
  });
});

describe("(c) the cursor plugin's own delivery fails cleanly, through the real runner", () => {
  const CHAT = "8f1c0d6e-2b7a-4c1e-9d11-0a5b3c2d1e00";
  const about = { roomId: "rom_AbCdEfGhIj", seat: "helper", memberId: "i_SeatSeatSe", messages: [], from: 1, through: 2 };
  const input: WakeInput = { ...about, prompt: "[SharedNet] TURN PROMPT\n#2 ann: @helper hi", livePrompt: "live" };
  const context = (timeoutMs: number): DeliveryContext => ({ env: { PATH: "/usr/bin:/bin" }, run: runTurn, chatOpen: () => false, timeoutMs });
  const posix = process.platform !== "win32";

  it.runIf(posix)("malformed JSON on exit 0 is a failed delivery that says what was wrong", async () => {
    const command = await script(`printf '%s' '{"type":"result","subtype":"success","is_error":fal'`);
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: await scratch("sharednet-iso-cwd-"), command };
    expect(await cursorPlugin.deliver(wake, input, context(10_000))).toMatchObject({ kind: "failed", why: "the Cursor CLI printed no result object", timedOut: false });
  });

  it.runIf(posix)("a non-zero exit is a failed delivery with the exit and the CLI's last words", async () => {
    const command = await script(`echo 'Error: Not authenticated' >&2; exit 3`);
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: await scratch("sharednet-iso-cwd-"), command };
    expect(await cursorPlugin.deliver(wake, input, context(10_000))).toMatchObject({ kind: "failed", why: "the cursor command exited 3", detail: "Error: Not authenticated", timedOut: false });
  });

  it.runIf(posix)("a hang is stopped at the turn's limit, with whatever it started, and is a failed delivery", async () => {
    const command = await script(`sleep 30 & sleep 30; echo late`);
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: await scratch("sharednet-iso-cwd-"), command };
    const started = Date.now();
    const delivery = await cursorPlugin.deliver(wake, input, context(500));
    expect(delivery).toMatchObject({ kind: "failed", timedOut: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.runIf(posix)("huge output is kept to its last 256 KiB, and reading it parses a bounded number of lines", async () => {
    // About 12 MB of lines that look like objects but are not JSON, then a valid success object.
    const command = await script(`i=0; while [ $i -lt 2000 ]; do printf '{"x"}\\n%.0s' $(seq 1 1000); i=$((i+1)); done; printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"done"}'`);
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: await scratch("sharednet-iso-cwd-"), command };
    const parse = vi.spyOn(JSON, "parse");
    expect(await cursorPlugin.deliver(wake, input, context(60_000))).toEqual({ kind: "replied", reply: "done" });
    parse.mockClear();
    // Without a result at the end: every one of the ~43,000 kept lines looks like an object, and
    // still only a bounded number are parsed (each one a thrown error), so serve's thread is not held.
    const kept = '{"x"}\n'.repeat(Math.floor((256 * 1024) / 6));
    expect(cursorSummary(kept)).toMatchObject({ ok: false, said: "the Cursor CLI printed no result object" });
    expect(parse.mock.calls.length).toBeLessThanOrEqual(65);
  }, 120_000);

  it.runIf(posix)("a missing program, or a seat directory that is gone, is a failed delivery, not a thrown error", async () => {
    const cwd = await scratch("sharednet-iso-cwd-");
    const missing: SeatWake = { driver: "cursor", session: CHAT, cwd, command: join(cwd, "no-such-agent") };
    expect(await cursorPlugin.deliver(missing, input, context(10_000))).toMatchObject({ kind: "failed", why: "the cursor command exited 127", timedOut: false });
    const command = await script("exit 0");
    const gone: SeatWake = { driver: "cursor", session: CHAT, cwd: join(cwd, "gone"), command };
    expect(await cursorPlugin.deliver(gone, input, context(10_000))).toMatchObject({ kind: "failed", why: "the cursor command exited 127", timedOut: false });
  });

  it.runIf(posix)("a prompt no argument can carry (a NUL byte from the Room) is a failed delivery, not a thrown error", async () => {
    const command = await script("exit 0");
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: await scratch("sharednet-iso-cwd-"), command };
    expect(await cursorPlugin.deliver(wake, { ...input, prompt: "a\u0000b" }, context(10_000))).toMatchObject({ kind: "failed", timedOut: false });
  });

  it.runIf(posix)("the check's steps are bounded too: a hung `status` is only a warning", async () => {
    const directory = await scratch("sharednet-iso-agent-");
    const command = join(directory, "agent");
    await writeFile(command, `#!/bin/sh\ncase "$1" in --version) echo 2026.10.14;; *) sleep 30;; esac\n`);
    await chmod(command, 0o755);
    const wake: SeatWake = { driver: "cursor", session: CHAT, cwd: directory, command };
    // Only `status` is cut short; `--version` keeps its own limit, so a loaded machine does not fail the program step.
    const shortRun: TurnRunner = (spec) => runTurn(spec.args[0] === "status" ? { ...spec, timeoutMs: 500 } : spec);
    const checked = await cursorPlugin.check(wake, { PATH: "/usr/bin:/bin" }, shortRun);
    expect(checked.ok).toBe(true);
    expect(checked.steps?.map((step) => [step.step, step.status])).toEqual([["program", "ok"], ["signed_in", "warning"], ["session", "skipped"]]);
    expect(checked.steps![1]!.message).toContain("did not answer");
  });
});
