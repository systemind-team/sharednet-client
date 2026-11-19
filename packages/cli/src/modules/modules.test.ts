// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Task } from "../board-controls.ts";
import { moduleHelp, openingPrompt } from "../goal-run.ts";
import { DEFAULT_MODULES, describeModules, isDefaultModules, seatEnvironment, type HarnessModules } from "./index.ts";
import { parseProbe, probeMessage } from "./information.ts";
import { isDirected, parseMessageSchema, recommendationOf, renderRequests, requestsFor, sbarMissing, sbarRefusal } from "./protocol.ts";
import { closestHeldTask, duplicateRefusal, parseTaskJudge, renderActivity, titleOverlap } from "./state.ts";
import { crossesIslands, islandsOf, parseTopology, reachable, topologyHelp } from "./topology.ts";

const task = (title: string, owner: string, status: Task["status"] = "claimed"): Task => ({ key: title.toLowerCase().replace(/\s/gu, ""), title, owner, owner_name: owner, status, claim_sequence: 1 });

describe("state slot", () => {
  it("parses the judge and refuses anything else", () => {
    expect(parseTaskJudge(undefined)).toBe("off");
    expect(parseTaskJudge("lexical")).toBe("lexical");
    expect(() => parseTaskJudge("llm")).toThrow(/off or lexical/);
  });
  it("finds the held task a new title duplicates, and ignores the claimant's own and finished ones", () => {
    expect(titleOverlap("WAV PCM conversion core", "wav pcm conversion")).toBe(1);
    expect(titleOverlap("FLAC decoding", "metadata for AIFF")).toBe(0);
    const tasks = [task("static info: -version -formats -codecs replay", "cc-2"), task("FLAC decode", "cc-3", "done"), task("WAV conversion", "me")];
    const held = closestHeldTask("replay of -version and -formats static info", tasks, "me");
    expect(held?.task.owner).toBe("cc-2");
    expect(closestHeldTask("FLAC decoding", tasks, "me")).toBeNull();
    expect(closestHeldTask("WAV conversion with dither", tasks, "me")).toBeNull();
    expect(closestHeldTask("hash muxers md5 framecrc", tasks, "me")).toBeNull();
    expect(duplicateRefusal("x", held!)).toMatch(/Nothing was claimed.*cc-2.*--distinct/su);
  });
  it("renders who is doing what from the runner's record and the task acts", () => {
    const view = renderActivity(
      [{ name: "cc-1", busy: true, turns: 2 }, { name: "cc-2", busy: false, turns: 1 }, { name: "cc-3", busy: false, turns: 0 }],
      [task("WAV core", "cc-1"), task("FLAC", "cc-1", "done")],
      "cc-2",
    );
    expect(view).toContain('- cc-1: in a turn; holds "WAV core"; 1 done');
    expect(view).toContain("- cc-2 (you): this turn; holds no task");
    expect(view).toContain("- cc-3: not started; holds no task");
  });
});

describe("topology slot", () => {
  const seats = [{ name: "a", member_id: "i_a" }, { name: "b", member_id: "i_b" }, { name: "c", member_id: "i_c" }, { name: "d", member_id: "i_d" }];
  const msg = (sequence: number, from: string | null, content: string) => ({ sequence, content, ...(from ? { sender: { member_id: `i_${from}`, name: from } } : { sender: { name: "runner" } }) });
  it("parses all and islands:K", () => {
    expect(parseTopology(undefined)).toEqual({ kind: "all" });
    expect(parseTopology("islands:2")).toEqual({ kind: "islands", count: 2 });
    expect(() => parseTopology("islands:1")).toThrow();
    expect(() => parseTopology("ring")).toThrow();
  });
  it("deals islands round-robin and keeps everything under all", () => {
    expect([...islandsOf(["a", "b", "c", "d"], { kind: "islands", count: 2 }).values()]).toEqual([0, 1, 0, 1]);
    const wake = { messages: [msg(1, "b", "hi")] };
    expect(reachable(wake, seats[0]!, seats, { kind: "all" })).toBe(wake);
  });
  it("lets a message cross islands only when it names the reader, starts with [share], or comes from the runner", () => {
    const wake = { messages: [msg(1, "c", "same island"), msg(2, "b", "other island"), msg(3, "b", "[share] accepted 4a1b"), msg(4, "d", "@a can you look"), msg(5, null, "check failed")] };
    const seen = reachable(wake, seats[0]!, seats, { kind: "islands", count: 2 }).messages.map((m) => m.sequence);
    expect(seen).toEqual([1, 3, 4, 5]);
    expect(crossesIslands("  [SHARE] x")).toBe(true);
    expect(topologyHelp("a", ["a", "b", "c", "d"], { kind: "islands", count: 2 }).join(" ")).toMatch(/island 1, with c/u);
    expect(topologyHelp("a", ["a"], { kind: "all" })).toEqual([]);
  });
});

describe("protocol slot", () => {
  it("tells directed messages from free ones", () => {
    expect(isDirected("@cc-4 please review")).toBe(true);
    expect(isDirected("@all stop")).toBe(false);
    expect(isDirected("mail me at x@y.com")).toBe(false);
    expect(isDirected("no mention")).toBe(false);
  });
  it("names the SBAR parts a handoff lacks", () => {
    expect(sbarMissing("@b S: build red | B: commit 1a2b | A: link order | R: rebase and rerun")).toEqual([]);
    expect(sbarMissing("@b situation: x\nbackground: y\nassessment: z\nrecommendation: w")).toEqual([]);
    expect(sbarMissing("@b please review 1a2b")).toEqual(["S", "B", "A", "R"]);
    expect(sbarRefusal(["A", "R"])).toMatch(/lacks A, R.*S: <what is happening>/su);
    expect(parseMessageSchema("sbar")).toBe("sbar");
    expect(() => parseMessageSchema("json")).toThrow();
  });
  it("lists what was asked of a seat, from the R: part", () => {
    const messages = [
      { sequence: 7, content: "@b S: x | B: y | A: z | R: rebase onto best and rerun the difftest", sender: { name: "a" } },
      { sequence: 8, content: "@c R: not for b", sender: { name: "a" } },
      { sequence: 9, content: "@all R: everyone", sender: { name: "a" } },
    ];
    const asked = requestsFor(messages, { name: "b" });
    expect(asked).toEqual(["- #7 a asks: rebase onto best and rerun the difftest"]);
    expect(renderRequests(asked)).toMatch(/^Asked of you/u);
    expect(renderRequests([])).toBe("");
    expect(recommendationOf("no parts at all")).toBe("no parts at all");
  });
});

describe("information slot", () => {
  it("validates the probe options", () => {
    expect(parseProbe(undefined, undefined)).toBeNull();
    expect(parseProbe("python3 probe.py", undefined)).toEqual({ command: "python3 probe.py", everyMs: 300_000 });
    expect(() => parseProbe(undefined, 60_000)).toThrow(/needs --probe/);
    expect(() => parseProbe("x", 1_000)).toThrow(/at least 1m/);
  });
  it("posts nothing for empty output and caps a long one", () => {
    expect(probeMessage("  \n")).toBeNull();
    expect(probeMessage("3 new clusters")).toBe("@all [probe] 3 new clusters");
    expect(probeMessage("x".repeat(5000))!.length).toBeLessThanOrEqual(1800 + "@all [probe] ".length);
  });
});

describe("the slots together", () => {
  const all: HarnessModules = { taskJudge: "lexical", activityView: true, topology: { kind: "islands", count: 2 }, messageSchema: "sbar", probe: { command: "p", everyMs: 60_000 }, environment: { push: "on-event", audience: "affected", watch: [{ host: "/runs/7/best", mount: "/workspace/best" }] } };
  it("has today's behaviour as its default", () => {
    expect(isDefaultModules(DEFAULT_MODULES)).toBe(true);
    expect(isDefaultModules(all)).toBe(false);
    expect(seatEnvironment(DEFAULT_MODULES)).toEqual([]);
    expect(seatEnvironment(all)).toEqual(["-e", "SHAREDNET_TASK_JUDGE=lexical", "-e", "SHAREDNET_MESSAGE_SCHEMA=sbar"]);
    expect(describeModules(all)).toEqual({ state: { task_judge: "lexical", activity_view: true }, topology: "islands:2", protocol: "sbar", information: { probe: "p", every_ms: 60_000 }, environment: { push: "on-event", audience: "affected", watch: ["/workspace/best"] } });
    expect(describeModules(DEFAULT_MODULES).environment).toBeNull();
  });
  it("leaves the opening prompt exactly as it was when every slot is at its default", () => {
    const input = { seat: { driver: "claude-code" as const, model: null, name: "a" }, seats: [{ driver: "claude-code" as const, model: null, name: "a" }, { driver: "claude-code" as const, model: null, name: "b" }], roomId: "rom_x", goal: "g", goalSequence: 1, until: ["after 10m"] };
    expect(openingPrompt({ ...input, modules: DEFAULT_MODULES })).toBe(openingPrompt(input));
    expect(moduleHelp("a", ["a", "b"], DEFAULT_MODULES)).toEqual([]);
    const withAll = openingPrompt({ ...input, modules: all });
    for (const marker of ["--distinct", "who is doing what", "island 1", "SBAR", "[probe]", "[env]"]) expect(withAll).toContain(marker);
  });
});
