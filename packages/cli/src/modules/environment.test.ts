// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_HOOK, Environment, describeNote, diffSnapshots, editsIn, endings, envLineForAnother, envMessage, hookNotes, parseEnvAudience, parseEnvPush, pathsIn, renderNotes, snapshot, workspacePath } from "./environment.ts";

const made: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "sharednet-env-"));
  made.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

const read = (file: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `/workspace/${file}` } }] } });
const edit = (file: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `/workspace/${file}`, old_string: "a", new_string: "b" } }] } });

describe("the environment's options", () => {
  it("parses the push level and the audience, and refuses an audience with no push", () => {
    expect(parseEnvPush(undefined)).toBe("off");
    expect(parseEnvPush("on-action")).toBe("on-action");
    expect(() => parseEnvPush("always")).toThrow(/off, on-wake, on-event or on-action/);
    expect(parseEnvAudience(undefined, "off")).toBe("affected");
    expect(parseEnvAudience("all", "on-wake")).toBe("all");
    expect(() => parseEnvAudience("all", "off")).toThrow(/needs --env-push/);
    expect(() => parseEnvAudience("some", "on-wake")).toThrow(/affected or all/);
  });
});

describe("observing the workspace", () => {
  it("finds files that changed, appeared or went, and leaves dot folders and build output out", async () => {
    const root = await temporary();
    await mkdir(join(root, "src"));
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "src", "a.c"), "one");
    await writeFile(join(root, "src", "gone.c"), "x");
    await writeFile(join(root, ".git", "HEAD"), "ref");
    await writeFile(join(root, "node_modules", "m.js"), "m");
    await writeFile(join(root, "src", "a.o"), "compiled");
    const before = await snapshot(root);
    expect([...before.keys()].sort()).toEqual(["src/a.c", "src/gone.c"]);
    await writeFile(join(root, "src", "a.c"), "one and more");
    await writeFile(join(root, "new.md"), "n");
    await rm(join(root, "src", "gone.c"));
    expect(diffSnapshots(before, await snapshot(root))).toEqual([{ path: "new.md", kind: "new" }, { path: "src/a.c", kind: "changed" }, { path: "src/gone.c", kind: "deleted" }]);
    // The same size at another time is a change too.
    const same = await snapshot(root);
    await utimes(join(root, "new.md"), new Date(1_000_000), new Date(1_000_000));
    expect(diffSnapshots(same, await snapshot(root))).toEqual([{ path: "new.md", kind: "changed" }]);
  });
});

describe("what a turn's record shows", () => {
  const known = new Set(["src/a.c", "README.md", "tools/run.sh"]);
  it("names the known files a line mentions, by either spelling", () => {
    expect(workspacePath("/workspace/src/a.c")).toBe("src/a.c");
    expect(workspacePath("./src/a.c,")).toBe("src/a.c");
    expect(pathsIn(read("src/a.c"), known)).toEqual(["src/a.c"]);
    expect(pathsIn('{"command":"sed -n 1,20p src/a.c && sh ./tools/run.sh; cat other.c"}', known).sort()).toEqual(["src/a.c", "tools/run.sh"]);
    expect(pathsIn("nothing here: a.c src/", known)).toEqual([]);
  });
  it("recognises a file written from a folder inside the workspace, when only one file ends that way", () => {
    const files = ["project/src/a.c", "project/src/util/a.c", "project/Makefile", "project/tools/run.sh", "other/tools/run.sh", "project/test"];
    const all = new Set(files);
    const byEnding = endings(files);
    // src/a.c is project/src/a.c; a.c alone and tools/run.sh are each two files; a bare name needs an extension.
    expect(pathsIn('{"command":"cd project && cat src/a.c"}', all, "/workspace", byEnding)).toEqual(["project/src/a.c"]);
    expect(pathsIn('{"command":"cat util/a.c"}', all, "/workspace", byEnding)).toEqual(["project/src/util/a.c"]);
    expect(pathsIn('{"command":"cat a.c; sh tools/run.sh; make test"}', all, "/workspace", byEnding)).toEqual([]);
    expect(pathsIn('{"command":"cat src/a.c"}', all)).toEqual([]);
  });
  it("names the files a line edits: an edit tool's file, or a patch's", () => {
    expect(editsIn(edit("src/a.c"))).toEqual(["src/a.c"]);
    expect(editsIn(read("src/a.c"))).toEqual([]);
    expect(editsIn('{"arguments":"*** Begin Patch\\n*** Update File: src/a.c\\n@@\\n*** Add File: new.c\\n"}')).toEqual(["src/a.c", "new.c"]);
  });
});

describe("who is told about a change", () => {
  const seats = ["cc-1", "cc-2", "cc-3"];
  const changed = [{ path: "src/a.c", kind: "changed" as const }];
  const start = () => {
    const env = new Environment(seats, { audience: "affected" });
    env.know(["src/a.c", "src/b.c", "README.md"]);
    return env;
  };

  it("tells a seat that read the file, names the seat that edited it, and tells nobody without an interest", () => {
    const env = start();
    env.sawLine("cc-1", 3, read("src/a.c"), 1_000);
    env.sawLine("cc-2", 5, edit("src/a.c"), 50_000);
    const added = env.observe(changed, new Set(["cc-2", "cc-3"]), 48_000, 53_000);
    expect(added).toMatchObject([{ seat: "cc-1", path: "src/a.c", by: "cc-2", interest: "read", seenTurn: 3 }]);
    expect(env.waiting("cc-2")).toEqual([]);
    expect(env.waiting("cc-3")).toEqual([]);
    expect(describeNote(added[0]!, 63_000)).toBe("src/a.c changed 10 s ago, by cc-2; you last had it in turn 3");
  });

  it("takes the one seat in a turn for the author, and says so when there are several", () => {
    const env = start();
    env.sawLine("cc-1", 1, edit("src/a.c"), 1_000);
    expect(env.observe(changed, new Set(["cc-3"]), 60_000, 65_000)).toMatchObject([{ seat: "cc-1", by: "cc-3", interest: "edited" }]);
    const other = start();
    other.sawLine("cc-1", 1, read("src/a.c"), 1_000);
    const [note] = other.observe(changed, new Set(["cc-2", "cc-3"]), 60_000, 65_000);
    expect(note).toMatchObject({ seat: "cc-1", by: null, candidates: ["cc-2", "cc-3"] });
    expect(describeNote(note!, 200_000)).toBe("src/a.c changed 2 min ago, by cc-2 or cc-3 (in a turn at the time); you last had it in turn 1");
  });

  it("says so when no seat was in a turn", () => {
    const env = start();
    env.sawLine("cc-1", 4, read("src/a.c"), 1_000);
    const [note] = env.observe(changed, new Set(), 60_000, 65_000);
    expect(note).toMatchObject({ by: null, candidates: [] });
    expect(describeNote(note!, 70_000)).toBe("src/a.c changed 5 s ago, by no seat in a turn (a check, a probe, or something a seat left running); you last had it in turn 4");
  });

  it("does not tell a seat about what is most likely its own change", () => {
    const env = start();
    // Two seats in a turn, no edit seen: the one that was just working with the file is the author.
    env.sawLine("cc-2", 2, '{"command":"sed -i s/a/b/ src/a.c"}', 59_000);
    env.sawLine("cc-3", 2, read("src/a.c"), 1_000);
    expect(env.observe(changed, new Set(["cc-2", "cc-3"]), 60_000, 65_000).map((note) => note.seat)).toEqual(["cc-3"]);
  });

  it("does not count a listing as a reading", () => {
    const env = new Environment(seats, { audience: "affected" });
    const files = Array.from({ length: 12 }, (_, index) => `src/f${index}.c`);
    env.know(files);
    env.sawLine("cc-1", 1, JSON.stringify({ content: files.join("\n") }), 1_000);
    expect(env.interest("cc-1")).toEqual([]);
    expect(env.observe([{ path: "src/f1.c", kind: "changed" }], new Set(["cc-2"]), 5_000, 6_000)).toEqual([]);
  });

  it("with the audience all, tells every other seat, and about new files too", () => {
    const env = new Environment(seats, { audience: "all" });
    env.know(["src/a.c"]);
    const added = env.observe([{ path: "src/new.c", kind: "new" }], new Set(["cc-2"]), 5_000, 6_000);
    expect(added.map((note) => [note.seat, note.by, note.interest])).toEqual([["cc-1", "cc-2", "all"], ["cc-3", "cc-2", "all"]]);
    expect(describeNote(added[0]!, 7_000)).toBe("src/new.c is new 1 s ago, by cc-2");
  });

  it("keeps one note per file until it is given, and does not repeat a file within a minute of telling", () => {
    const env = start();
    env.sawLine("cc-1", 1, read("src/a.c"), 1_000);
    expect(env.observe(changed, new Set(["cc-2"]), 5_000, 6_000)).toHaveLength(1);
    expect(env.observe(changed, new Set(["cc-3"]), 6_000, 11_000)).toHaveLength(0);
    const [waiting] = env.waiting("cc-1");
    // Two authors by now: the note no longer names one.
    expect(waiting).toMatchObject({ by: null, candidates: ["cc-2", "cc-3"], at: 11_000 });
    expect(env.delivered("cc-1", [waiting!.id], 12_000)).toHaveLength(1);
    expect(env.waiting("cc-1")).toEqual([]);
    expect(env.observe(changed, new Set(["cc-2"]), 12_000, 30_000)).toHaveLength(0);
    expect(env.observe(changed, new Set(["cc-2"]), 30_000, 80_000)).toHaveLength(1);
  });
});

describe("what a seat is told", () => {
  const note = (path: string, by: string | null = "cc-2") => ({ id: `n-${path}`, seat: "cc-1", path, kind: "changed" as const, by, candidates: by ? [by] : [], at: 10_000, interest: "read" as const, seenTurn: 2 });
  it("renders a wake's part, a Room line for one seat, and the hook's notes", () => {
    expect(renderNotes([], 20_000)).toBeNull();
    expect(renderNotes([note("src/a.c")], 20_000)).toBe("Changed in the workspace by others since you last saw these files:\n- src/a.c changed 10 s ago, by cc-2; you last had it in turn 2");
    const many = Array.from({ length: 14 }, (_, index) => note(`f${index}.c`));
    expect(renderNotes(many, 20_000)).toMatch(/- and 2 more files$/);
    const line = envMessage("cc-1", [note("src/a.c"), note("src/b.c")], 20_000);
    expect(line).toBe("@cc-1 [env] src/a.c changed 10 s ago, by cc-2; you last had it in turn 2; src/b.c changed 10 s ago, by cc-2; you last had it in turn 2");
    expect(envLineForAnother(line, "cc-3")).toBe(true);
    expect(envLineForAnother(line, "cc-1")).toBe(false);
    expect(envLineForAnother("@cc-1 please look at src/a.c", "cc-3")).toBe(false);
    // The hook fills in the age when it gives the note, which may be minutes after it was written.
    expect(hookNotes([note("src/a.c")])).toEqual([{ id: "n-src/a.c", file: "/workspace/src/a.c", at: 10_000, text: "src/a.c changed {ago}, by cc-2; you last had it in turn 2" }]);
  });
});

describe("the hook inside a Claude Code seat's turn", () => {
  const run = (script: string, dir: string, input: unknown) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), env: { ...process.env, SHAREDNET_ENV_DIR: dir }, encoding: "utf8" });
  it("holds an edit to a file that changed under the seat once, hands the rest over after a tool call, and gives each note once", async () => {
    const dir = await temporary();
    const script = join(dir, "hook.cjs");
    await writeFile(script, ENV_HOOK);
    const preEdit = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/workspace/src/a.c" } };
    const post = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
    // Nothing waiting: silent.
    expect(run(script, dir, preEdit).stdout).toBe("");
    await writeFile(join(dir, "pending.json"), JSON.stringify([
      { id: "n1", file: "/workspace/src/a.c", at: Date.now() - 10_000, text: "src/a.c changed {ago}, by cc-2" },
      { id: "n2", file: "/workspace/src/b.c", at: Date.now() - 300_000, text: "src/b.c changed {ago}, by cc-3" },
    ]));
    // An edit to another file goes through.
    expect(run(script, dir, { ...preEdit, tool_input: { file_path: "/workspace/src/z.c" } }).stdout).toBe("");
    const held = JSON.parse(run(script, dir, preEdit).stdout);
    expect(held.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(held.hookSpecificOutput.permissionDecisionReason).toMatch(/src\/a\.c changed 1[0-2] s ago, by cc-2\. This edit was held once/);
    // The same edit again is let through.
    expect(run(script, dir, preEdit).stdout).toBe("");
    const told = JSON.parse(run(script, dir, post).stdout);
    expect(told.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(told.hookSpecificOutput.additionalContext).toMatch(/^SharedNet workspace, changed by others while you work: src\/b\.c changed 5 min ago, by cc-3\./);
    expect(run(script, dir, post).stdout).toBe("");
    const given = (await readFile(join(dir, "delivered.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(given.map((record) => [record.id, record.how])).toEqual([["n1", "held-edit"], ["n2", "note"]]);
  });
});
