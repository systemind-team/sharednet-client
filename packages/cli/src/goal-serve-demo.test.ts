// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "./api-client.ts";
import { DEFAULT_IMAGE, containerName, type DockerRunner, type RunPlan } from "./goal-run.ts";
import { assertServeDemoGoalUnaddressed, parseServeDemoAgents, runServeGoalDemo, serveKickoff, serveSessionPrompt } from "./goal-serve-demo.ts";

const ROOM = "rom_AbCdEfGhIj";
const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-serve-goal-"));
  cleanup.push(directory);
  return directory;
}

describe("serve-first Goal demo", () => {
  it("defaults to three Codex agents and refuses any topology other than three Codex seats", () => {
    expect(parseServeDemoAgents([])).toEqual([
      { name: "codex-1", driver: "codex", model: null },
      { name: "codex-2", driver: "codex", model: null },
      { name: "codex-3", driver: "codex", model: null },
    ]);
    expect(parseServeDemoAgents(["codex:gpt-6-luna", "codex:gpt-6-luna", "codex:gpt-6-luna"])).toHaveLength(3);
    for (const agents of [["codex"], ["codex", "codex"], ["codex", "codex", "codex", "codex"], ["codex", "claude-code", "codex"]]) {
      expect(() => parseServeDemoAgents(agents)).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    }
  });

  it("seeds either only the coordinator or all three seats with exact member ids", () => {
    const seats = [
      { name: "codex-1", member_id: "i_AgentOne01" },
      { name: "codex-2", member_id: "i_AgentTwo02" },
      { name: "codex-3", member_id: "i_AgentTre03" },
    ];
    const first = serveKickoff("first", seats, 4);
    expect(first).toContain("@i_AgentOne01");
    expect(first).not.toContain("@i_AgentTwo02");
    expect(first).not.toContain("@i_AgentTre03");
    expect(first).toContain("Goal #4");

    const all = serveKickoff("all", seats, 4);
    for (const seat of seats) expect(all).toContain(`@${seat.member_id}`);
    expect(all).toContain("Goal #4");
  });

  it("keeps the Goal line unaddressed so kickoff is the only initial wake", () => {
    expect(() => assertServeDemoGoalUnaddressed("Build it, then report the result.")).not.toThrow();
    for (const content of ["(@all) start", "hello,@codex-1", "review by @Codex-2", "@codex-3 finish"]) {
      expect(() => assertServeDemoGoalUnaddressed(content)).toThrow(expect.objectContaining({ code: "invalid_arguments" }));
    }
  });

  it("gives first and all different roles while every thread knows the end contract", () => {
    const seats = parseServeDemoAgents([]);
    const first = seats.map((seat) => serveSessionPrompt(seat, seats, ["said DONE", "after 20m"], "first"));
    expect(first[0]).toContain("delegate distinct work");
    expect(first[1]).toContain("Wait for the coordinator's direct assignment");
    expect(first[2]).toContain("Wait for the coordinator's direct assignment");
    const all = seats.map((seat) => serveSessionPrompt(seat, seats, ["said DONE", "after 20m"], "all"));
    expect(all[0]).toContain("Coordinate the simultaneous start");
    expect(all[1]).toContain("primary solution and evidence");
    expect(all[2]).toContain("independent critique and verification");
    for (const prompt of [...first, ...all]) {
      expect(prompt).toContain("said DONE; after 20m");
      expect(prompt).toContain("The coordinator alone makes any completion claim");
    }
  });

  it("starts three real listeners before the Goal and kickoff, and never emulates delivery with wait or ack", async () => {
    const out = await temporary();
    const workspace = await temporary();
    const events: string[] = [];
    const members = new Map([
      ["codex-1", "i_AgentOne01"],
      ["codex-2", "i_AgentTwo02"],
      ["codex-3", "i_AgentTre03"],
    ]);
    const threads = new Map([
      ["codex-1", "thread-one"],
      ["codex-2", "thread-two"],
      ["codex-3", "thread-three"],
    ]);
    const calls: string[][] = [];
    const callEnvironments: Array<Record<string, string>> = [];
    const statusChecks = new Map<string, number>();
    const docker: DockerRunner = async (args, options = {}) => {
      calls.push([...args]);
      callEnvironments.push(options.env ?? {});
      const container = args.find((argument) => argument.startsWith(`sharednet-goal-${ROOM}-codex-`));
      const name = container?.slice(`sharednet-goal-${ROOM}-`.length) ?? null;
      const commandAt = container ? args.indexOf(container) + 1 : -1;
      const command = commandAt > 0 ? args.slice(commandAt) : [];
      if (command[0] === "sharednet" && command[1] === "join") {
        return { code: 0, stdout: JSON.stringify({ member_id: members.get(name!) }), stderr: "" };
      }
      if (command.includes("codex") && command.includes("exec") && !command.includes("resume")) {
        events.push(`bootstrap:${name}`);
        return {
          code: 0,
          stdout: `${JSON.stringify({ type: "thread.started", thread_id: threads.get(name!) })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`,
          stderr: "",
        };
      }
      if (command[0] === "sharednet" && command[1] === "serve" && command.includes("--status")) {
        const attempt = (statusChecks.get(name!) ?? 0) + 1;
        statusChecks.set(name!, attempt);
        const state = name === "codex-1" && attempt <= 121 ? "retrying" : "listening";
        if (state === "listening") events.push(`listening:${name}`);
        return {
          code: 0,
          stdout: JSON.stringify({ running: true, wake_protocol: "wake-plugins-v1", seats: [{ room_id: ROOM, member_id: members.get(name!), state }] }),
          stderr: "",
        };
      }
      if (command.join(" ").includes("sharednet serve --rooms")) events.push(`serve:${name}`);
      options.onLine?.("");
      return { code: 0, stdout: "", stderr: "" };
    };
    const ownerMessages: string[] = [];
    const ownerMessageBodies: Array<{ content: string; as?: string }> = [];
    let watchOptions: Record<string, unknown> | null = null;
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "POST" && path === `/rooms/${ROOM}/goal`) {
          events.push("goal");
          return { room: {}, message: { sequence: 1 } };
        }
        if (method === "POST" && path === `/rooms/${ROOM}/owner-messages`) {
          events.push("kickoff");
          ownerMessageBodies.push(body as { content: string; as?: string });
          ownerMessages.push((body as { content: string }).content);
          return { message: { sequence: 2 } };
        }
        return {};
      },
    } as unknown as ApiClient;
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseServeDemoAgents([]),
      workspace,
      cli: { root: "/opt/sharednet-cli", entry: "src/main.ts" },
      codexAuth: { kind: "login", file: "/home/owner/.codex/auth.json" },
      claudeAuth: null,
    };

    const result = await runServeGoalDemo(
      client,
      "sni_owner-seat",
      "snk_owner-secret",
      {
        plan,
        roomId: ROOM,
        inviteToken: "rit_invite-secret",
        goal: "Build the demo.",
        until: ["after 20m"],
        baseUrl: "https://www.sharednet.ai",
        out,
        checkEveryMs: 60_000,
        quietChecks: true,
        kickoff: "first",
      },
      {
        docker,
        now: () => new Date("2026-10-14T20:00:00.000Z"),
        uid: 4242,
        gid: 4343,
        sleep: async () => undefined,
        watch: async (_client, _memberToken, _apiKey, options) => {
          watchOptions = options as unknown as Record<string, unknown>;
          return { room_id: ROOM, ended_by: { trigger: "after 20m", at: "2026-10-14T20:20:00.000Z", detail: null }, messages: 2, checks: 0, snapshots: 0, out };
        },
      },
    );

    expect(events.filter((event) => event.startsWith("listening:"))).toHaveLength(3);
    expect(statusChecks.get("codex-1")).toBe(122);
    expect(events.indexOf("goal")).toBeGreaterThan(Math.max(...events.map((event, index) => event.startsWith("listening:") ? index : -1)));
    expect(events.indexOf("kickoff")).toBeGreaterThan(events.indexOf("goal"));
    expect(ownerMessages).toHaveLength(1);
    expect(ownerMessageBodies[0]).toMatchObject({ as: "runner" });
    expect(ownerMessages[0]).toContain("@i_AgentOne01");
    expect(ownerMessages[0]).not.toContain("@i_AgentTwo02");
    expect(ownerMessages[0]).toContain("codex-2=i_AgentTwo02");
    expect(watchOptions).toMatchObject({ ignoreThrough: 2 });
    expect(calls.some((args) => args.includes("wait") || args.includes("ack"))).toBe(false);
    expect(calls.filter((args) => args.join(" ").includes("sharednet serve --rooms"))).toHaveLength(3);
    expect(calls.filter((args) => args[0] === "run" && args.some((arg) => arg.endsWith("/auth.json:/run/codex/auth.json:ro")))).toHaveLength(3);
    const agentExecs = calls.filter((args) => args[0] === "exec" && args.includes("--user") && args[args.indexOf("--user") + 1] !== "root");
    expect(agentExecs.length).toBeGreaterThan(0);
    expect(agentExecs.every((args) => args[args.indexOf("--user") + 1] === "4242:4343")).toBe(true);
    expect(calls.filter((args) => args[0] === "exec" && args.includes("chown")).every((args) => args.join(" ").includes("chown -R 4242:4343"))).toBe(true);
    expect(calls.flat().join(" ")).not.toContain("snk_owner-secret");
    expect(calls.flat().join(" ")).not.toContain("rit_invite-secret");
    const copies = calls.filter((args) => args[0] === "cp");
    expect(copies).toHaveLength(6);
    expect(copies.every((args) => args[1]?.endsWith("/.codex/sessions") || args[1]?.endsWith("/serve.log"))).toBe(true);
    expect(copies.some((args) => args[1]?.endsWith("/codex-1"))).toBe(false);
    for (const [name, thread] of threads) {
      const bootstrap = calls.find((args) => args.includes(containerName(ROOM, name)) && args.includes("codex") && args.includes("exec") && !args.includes("resume"))!;
      expect(bootstrap.at(-1)).toContain("after 20m");
      expect(bootstrap.at(-1)).toContain("The coordinator alone makes any completion claim");
      const joinIndex = calls.findIndex((args) => args.includes(containerName(ROOM, name)) && args.includes("join"));
      expect(joinIndex).toBeGreaterThan(-1);
      expect(callEnvironments[joinIndex]).toMatchObject({ CODEX_SESSION_ID: thread });
      const wake = calls.find((args) => args.includes(containerName(ROOM, name)) && args.includes("wake") && args.includes("set"))!;
      expect(wake).toContain(thread);
      const limit = calls.find((args) => args.includes(containerName(ROOM, name)) && args.includes("wake") && args.includes("limit"))!;
      expect(limit).toContain("1200s");
    }
    expect(result.agents.map((agent) => agent.session_id)).toEqual(["thread-one", "thread-two", "thread-three"]);
    expect(JSON.parse(await readFile(join(out, "serve-demo.json"), "utf8"))).toMatchObject({ mode: "real-serve", kickoff: "first" });
    expect(calls.at(-1)).toEqual(["rm", "--force", containerName(ROOM, "codex-1"), containerName(ROOM, "codex-2"), containerName(ROOM, "codex-3"), containerName(ROOM)]);
  });

  it("closes the Goal Room before removing containers when its watcher fails", async () => {
    const out = await temporary();
    const workspace = await temporary();
    const members = new Map([
      ["codex-1", "i_AgentOne01"],
      ["codex-2", "i_AgentTwo02"],
      ["codex-3", "i_AgentTre03"],
    ]);
    const lifecycle: string[] = [];
    const dockerCalls: string[][] = [];
    const docker: DockerRunner = async (args) => {
      dockerCalls.push([...args]);
      if (args[0] === "rm") lifecycle.push("rm");
      const container = args.find((argument) => argument.startsWith(`sharednet-goal-${ROOM}-codex-`));
      const name = container?.slice(`sharednet-goal-${ROOM}-`.length) ?? null;
      const command = container ? args.slice(args.indexOf(container) + 1) : [];
      if (command.includes("codex") && command.includes("exec") && !command.includes("resume")) {
        return { code: 0, stdout: `${JSON.stringify({ type: "thread.started", thread_id: `thread-${name}` })}\n${JSON.stringify({ type: "turn.completed", usage: {} })}\n`, stderr: "" };
      }
      if (command[0] === "sharednet" && command[1] === "join") {
        return { code: 0, stdout: JSON.stringify({ member_id: members.get(name!) }), stderr: "" };
      }
      if (command[0] === "sharednet" && command[1] === "serve" && command.includes("--status")) {
        return { code: 0, stdout: JSON.stringify({ running: true, wake_protocol: "wake-plugins-v1", seats: [{ room_id: ROOM, member_id: members.get(name!), state: "listening" }] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const closes: Array<Record<string, unknown>> = [];
    const client = {
      async request(method: string, path: string, _token: string, body?: unknown) {
        if (method === "POST" && path.endsWith("/goal")) return { room: {}, message: { sequence: 1 } };
        if (method === "POST" && path.endsWith("/owner-messages")) return { message: { sequence: 2 } };
        if (method === "POST" && path.endsWith("/close")) {
          lifecycle.push("close");
          closes.push(body as Record<string, unknown>);
          return { room: { state: "closed" } };
        }
        return {};
      },
    } as unknown as ApiClient;
    const plan: RunPlan = {
      image: DEFAULT_IMAGE,
      agents: parseServeDemoAgents([]),
      workspace,
      cli: { root: "/opt/sharednet-cli", entry: "src/main.ts" },
      codexAuth: { kind: "login", file: "/home/owner/.codex/auth.json" },
      claudeAuth: null,
    };

    await expect(runServeGoalDemo(client, "sni_owner-seat", "snk_owner-secret", {
      plan,
      roomId: ROOM,
      inviteToken: "rit_invite-secret",
      goal: "Build the demo.",
      until: ["after 20m"],
      baseUrl: "https://www.sharednet.ai",
      out,
      checkEveryMs: 60_000,
      quietChecks: true,
      kickoff: "first",
    }, {
      docker,
      now: () => new Date("2026-10-14T20:00:00.000Z"),
      uid: 4242,
      gid: 4343,
      sleep: async () => undefined,
      watch: async () => { throw new Error("watch exploded"); },
    })).rejects.toThrow("watch exploded");

    expect(closes).toEqual([{ trigger: "runner_error", detail: "goal serve-demo stopped: watch exploded" }]);
    expect(lifecycle).toEqual(["close", "rm"]);
    expect(dockerCalls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });
});
