// @vitest-environment node
import { describe, expect, it } from "vitest";
import { claimTask, projectTasks, taskMessage, pendingMentions, controlPaths, noteRead, readThrough, withControlLock } from "./board-controls.ts";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

const msg = (sequence: number, sender: string, content: string) => ({ sequence, content, sender: { member_id: sender, name: sender } });

describe("task title ownership", () => {
  it("rejects empty titles and collapses case and all whitespace", () => {
    expect(() => taskMessage("claim", " \t\n")).toThrow();
    const tasks = projectTasks([msg(2, "B", taskMessage("claim", "fix parser")), msg(1, "A", taskMessage("claim", " Fix\tParser "))]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ key: "fixparser", owner: "A", status: "claimed", claim_sequence: 1 });
  });
  it("ignores foreign completion, malformed markers and duplicate claims after done", () => {
    expect(projectTasks([
      msg(1, "A", taskMessage("claim", "Parser")), msg(2, "B", taskMessage("done", "parser")),
      msg(3, "B", "[sharednet-task:v1] not-json"),
    ])[0]?.status).toBe("claimed");
    const tasks = projectTasks([msg(1, "A", taskMessage("claim", "Parser")), msg(2, "A", taskMessage("done", "parser")), msg(3, "B", taskMessage("claim", "PARSER"))]);
    expect(tasks[0]).toMatchObject({ owner: "A", status: "done", done_sequence: 2 });
  });
  it("settles simultaneous claims by committed sequence, not precheck timing", async () => {
    const messages: ReturnType<typeof msg>[] = [];
    let release!: () => void;
    const together = new Promise<void>(resolve => { release = resolve; });
    const board = (who: string) => ({
      list: async () => [...messages],
      post: async (content: string) => {
        const message = msg(messages.length + 1, who, content); messages.push(message);
        if (messages.length === 2) release();
        await together; return message;
      },
    });
    const results = await Promise.allSettled([claimTask(board("A"), "A", "Fix Parser"), claimTask(board("B"), "B", "fixparser")]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(projectTasks(messages)[0]?.owner).toBe("A");
  });
  it("does not grant a claim when replay has not reached its committed sequence", async () => {
    const board = { list: async () => [], post: async (content: string) => msg(8, "A", content) };
    await expect(claimTask(board, "A", "build")).rejects.toThrow(/incomplete/i);
  });
});

describe("before-say addressed messages", () => {
  it.runIf(process.platform === "linux")("recovers an unreaped zombie owner inside a container without init", async () => {
    const root = await mkdtemp(join(tmpdir(), "sn-zombie-lock-"));
    const paths = controlPaths({ HOME: root }, { base_url: "https://example.test", room_id: "r1", member_id: "A" });
    const worker = `import {withControlLock} from ${JSON.stringify(new URL("./board-controls.ts", import.meta.url).href)}; await withControlLock(${JSON.stringify(paths)}, "task", async () => { console.log("locked"); setInterval(() => {}, 1000); await new Promise(() => {}); });`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", `import {spawn} from 'node:child_process'; const c=spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', ${JSON.stringify(worker)}]); c.stdout.once('data', () => { console.log(c.pid); process.kill(process.pid, 'SIGSTOP'); });`], { stdio: ["ignore", "pipe", "pipe"] });
    let pid: number | undefined;
    const state = async (pid: number) => { const s = await readFile(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2, s.lastIndexOf(")") + 3); };
    const until = async (check: () => Promise<boolean>) => { const deadline = Date.now() + 2000; while (!await check()) { if (Date.now() > deadline) throw Error("process state timeout"); await new Promise(r => setTimeout(r, 10)); } };
    try {
      pid = Number(String((await once(parent.stdout!, "data"))[0]).trim());
      await until(async () => await state(parent.pid!) === "T");
      process.kill(pid, "SIGKILL");
      await until(async () => await state(pid!) === "Z");
      await expect(withControlLock(paths, "task", async () => "recovered")).resolves.toBe("recovered");
    } finally {
      if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
      parent.kill("SIGCONT");
      const stopped = once(parent, "exit"); parent.kill("SIGTERM"); await stopped;
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recovers a killed lock owner and serializes concurrent recovery attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sn-dead-lock-"));
    const paths = controlPaths({ HOME: root }, { base_url: "https://example.test", room_id: "r1", member_id: "A" });
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      `import {withControlLock} from ${JSON.stringify(new URL("./board-controls.ts", import.meta.url).href)}; await withControlLock(${JSON.stringify(paths)}, "task", async () => { console.log("locked"); await new Promise(() => { setInterval(() => {}, 1000); }); });`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      const stopped = once(child, "exit");
      child.kill("SIGKILL"); await stopped;
      let active = 0, maximum = 0;
      await Promise.all(Array.from({ length: 4 }, () => withControlLock(paths, "task", async () => {
        maximum = Math.max(maximum, ++active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
      })));
      expect(maximum).toBe(1);
    } finally { child.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
  });
  it("keeps concurrent read watermarks monotonic and isolates rooms and seats", async () => {
    const root = await mkdtemp(join(tmpdir(), "sn-read-watermark-"));
    try {
      const seat = { base_url: "https://example.test", room_id: "r1", member_id: "A" };
      const paths = controlPaths({ HOME: root }, seat);
      await Promise.all([9, 1, 4, 18, 2].map(n => noteRead(paths, n)));
      expect(await readThrough(paths)).toBe(18);
      expect(await readThrough(controlPaths({ HOME: root }, { ...seat, member_id: "B" }))).toBe(0);
      expect(await readThrough(controlPaths({ HOME: root }, { ...seat, room_id: "r2" }))).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("uses the greater watermark, excludes own speech and unrelated messages", () => {
    const messages = [msg(2, "A", "@B old"), msg(4, "A", "@B fix this"), msg(5, "C", "@A irrelevant"), msg(6, "B", "@B self"), msg(7, "A", "@all changed interface")];
    expect(pendingMentions(messages, { memberId: "B", name: "B" }, 3, 0).map(m => m.sequence)).toEqual([4, 7]);
    expect(pendingMentions(messages, { memberId: "B", name: "B" }, 3, 6).map(m => m.sequence)).toEqual([7]);
  });
  it("does not mistake longer names for this recipient", () => {
    expect(pendingMentions([msg(1, "A", "@Bobcat ping")], { memberId: "B", name: "Bob" }, 0, 0)).toEqual([]);
  });
});
