// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENV_HOOK, Environment, containerPath, describeNote, diffSnapshots, editsIn, endings, envLineForAnother, envMessage, fileKey, folderAfter, foldersIn,
  hookNotes, hostPath, parseEnvAudience, parseEnvPush, parseEnvWatch, pathsIn, readLine, renderNotes, sameBytes, snapshot, snapshotRoots, withoutHeredocs, workspacePath,
} from "./environment.ts";

const made: string[] = [];
async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), "sharednet-env-"));
  made.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

// Lines as Claude Code and Codex write them in a turn's record.
const bash = (command: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
const edit = (file: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `/workspace/${file}`, old_string: "a", new_string: "b" } }] } });
const result = (text = "ok") => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: text }] } });
const codexStart = (command: string) => JSON.stringify({ type: "item.started", item: { type: "command_execution", command } });
const codexEnd = (output = "") => JSON.stringify({ type: "item.completed", item: { type: "command_execution", aggregated_output: output } });

describe("the environment's options", () => {
  it("parses the push level, the audience and the watched folders, and refuses an audience or a folder with no push", () => {
    expect(parseEnvPush(undefined)).toBe("off");
    expect(parseEnvPush("on-action")).toBe("on-action");
    expect(() => parseEnvPush("always")).toThrow(/off, on-wake, on-event or on-action/);
    expect(parseEnvAudience(undefined, "off")).toBe("affected");
    expect(parseEnvAudience("all", "on-wake")).toBe("all");
    expect(() => parseEnvAudience("all", "off")).toThrow(/needs --env-push/);
    expect(() => parseEnvAudience("some", "on-wake")).toThrow(/affected or all/);
    expect(parseEnvWatch([], "off")).toEqual([]);
    expect(parseEnvWatch(["/runs/7/best:/workspace/best/", "C:/notes:/notes"], "on-wake")).toEqual([{ host: "/runs/7/best", mount: "/workspace/best" }, { host: "C:/notes", mount: "/notes" }]);
    expect(() => parseEnvWatch(["best:/workspace/best"], "off")).toThrow(/needs --env-push/);
    expect(() => parseEnvWatch(["best"], "on-wake")).toThrow(/<folder>:<absolute path in the containers>/);
  });
});

describe("observing the workspace", () => {
  const plain = (changes: Array<{ path: string; kind: string }>) => changes.map(({ path, kind }) => ({ path, kind }));
  it("finds files that changed, appeared or went, with the time each was written, and leaves dot folders and build output out", async () => {
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
    const changes = diffSnapshots(before, await snapshot(root));
    expect(plain(changes)).toEqual([{ path: "new.md", kind: "new" }, { path: "src/a.c", kind: "changed" }, { path: "src/gone.c", kind: "deleted" }]);
    expect(changes.map((change) => typeof change.mtimeMs)).toEqual(["number", "number", "undefined"]);
    // The same size at another time is a change too.
    const same = await snapshot(root);
    await utimes(join(root, "new.md"), new Date(1_000_000), new Date(1_000_000));
    expect(diffSnapshots(same, await snapshot(root))).toEqual([{ path: "new.md", kind: "changed", mtimeMs: 1_000_000 }]);
  });
});

describe("folders mounted beside the workspace", () => {
  it("are watched too, each file under the name the seats know it by", async () => {
    const workspace = await temporary();
    const best = await temporary();
    const notes = await temporary();
    await writeFile(join(workspace, "PLAN.md"), "p");
    await mkdir(join(best, "src"));
    await writeFile(join(best, "src", "a.c"), "a");
    await writeFile(join(notes, "log.md"), "l");
    const roots = [{ host: workspace, mount: "/workspace" }, { host: best, mount: "/workspace/best" }, { host: notes, mount: "/notes" }];
    expect([...(await snapshotRoots(roots)).keys()]).toEqual(["PLAN.md", "best/src/a.c", "/notes/log.md"]);
    expect(fileKey("/workspace", "PLAN.md")).toBe("PLAN.md");
    expect(containerPath("best/src/a.c")).toBe("/workspace/best/src/a.c");
    expect(containerPath("/notes/log.md")).toBe("/notes/log.md");
    // A seat's record names the file as it sees it; an edit tool gives the whole path.
    const known = new Set(["PLAN.md", "best/src/a.c", "/notes/log.md"]);
    expect(pathsIn('{"command":"cat /workspace/best/src/a.c /notes/log.md"}', known).sort()).toEqual(["/notes/log.md", "best/src/a.c"]);
    expect(editsIn(JSON.stringify({ name: "Edit", input: { file_path: "/notes/log.md" } }))).toEqual(["/notes/log.md"]);
    // A file's place on this machine, and whether two of them hold the same bytes.
    expect(hostPath(roots, "best/src/a.c")).toBe(join(best, "src", "a.c"));
    expect(hostPath(roots, "PLAN.md")).toBe(join(workspace, "PLAN.md"));
    expect(hostPath(roots, "/elsewhere/x")).toBeNull();
    await mkdir(join(workspace, "mine", "src"), { recursive: true });
    await writeFile(join(workspace, "mine", "src", "a.c"), "a");
    expect(sameBytes(roots, "best/src/a.c", "mine/src/a.c")).toBe(true);
    await writeFile(join(workspace, "mine", "src", "a.c"), "b");
    expect(sameBytes(roots, "best/src/a.c", "mine/src/a.c")).toBe(false);
    expect(sameBytes(roots, "best/src/a.c", "mine/src/none.c")).toBe(false);
  });
});

describe("what a turn's record shows", () => {
  const known = new Set(["src/a.c", "README.md", "tools/run.sh"]);
  it("names the known files a line mentions, by either spelling", () => {
    expect(workspacePath("/workspace/src/a.c")).toBe("src/a.c");
    expect(workspacePath("./src/a.c,")).toBe("src/a.c");
    expect(pathsIn(edit("src/a.c"), known)).toEqual(["src/a.c"]);
    expect(pathsIn('{"command":"sed -n 1,20p src/a.c && sh ./tools/run.sh; cat other.c"}', known).sort()).toEqual(["src/a.c", "tools/run.sh"]);
    expect(pathsIn("nothing here: a.c src/", known)).toEqual([]);
  });
  it("reads a path from where the seat's shell stands, then from the workspace, then as the one file that ends that way", () => {
    const files = ["project/src/a.c", "other/src/a.c", "project/src/util/b.c", "project/Makefile", "NOTES.md", "project/test"];
    const all = new Set(files);
    const byEnding = endings(files);
    // src/a.c is two files: only the folder the shell stands in says which.
    expect(pathsIn("cat src/a.c", all, "/workspace", byEnding)).toEqual([]);
    expect(pathsIn("cat src/a.c", all, "/workspace", byEnding, "/workspace/other")).toEqual(["other/src/a.c"]);
    expect(pathsIn("cat ../../other/src/a.c a.c", all, "/workspace", byEnding, "/workspace/project/src").sort()).toEqual(["other/src/a.c", "project/src/a.c"]);
    // From a folder below, the workspace's own NOTES.md is still that file; util/b.c ends one file only.
    expect(pathsIn("cat NOTES.md util/b.c", all, "/workspace", byEnding, "/workspace/project").sort()).toEqual(["NOTES.md", "project/src/util/b.c"]);
    // A bare name counts as an ending only with an extension: `test` is a word.
    expect(pathsIn("make test", all, "/workspace", byEnding)).toEqual([]);
    // ./ and ../ are written from where the shell stands.
    expect(pathsIn("C=./src/a.c; sh ./test", all, "/workspace", byEnding, "/workspace/other")).toEqual(["other/src/a.c"]);
    expect(pathsIn("sh ./test && cat ../other/src/a.c", all, "/workspace", byEnding, "/workspace/project").sort()).toEqual(["other/src/a.c", "project/test"]);
  });
  it("follows a command's cd, and leaves a here-document's text alone", () => {
    expect(folderAfter("/workspace", "cd candidates/cc-1/repo && make")).toBe("/workspace/candidates/cc-1/repo");
    expect(folderAfter("/workspace/a", 'ls; cd "../b c" && cd sub')).toBe("/workspace/b c/sub");
    expect(folderAfter("/workspace/a", "cd /tmp && cd - ; cd $HOME; cd ~/x")).toBe("/tmp");
    expect(folderAfter("/workspace", "cat > run.sh <<'EOF'\ncd /somewhere/else\nEOF")).toBe("/workspace");
    expect(folderAfter("/workspace", "echo cd nowhere")).toBe("/workspace");
    // A command that changes folder twice is in both: each stretch with the folder it runs in.
    expect(foldersIn("/workspace", "cd a/repo && ./compile.sh; cd ../scratch; ./run in.flac")).toEqual({
      parts: [{ text: " && ./compile.sh", cwd: "/workspace/a/repo" }, { text: "; ./run in.flac", cwd: "/workspace/a/scratch" }],
      after: "/workspace/a/scratch",
    });
    expect(foldersIn("/workspace/a", "make")).toEqual({ parts: [{ text: "make", cwd: "/workspace/a" }], after: "/workspace/a" });
    expect(foldersIn("/workspace", "cd a")).toEqual({ parts: [{ text: "", cwd: "/workspace/a" }], after: "/workspace/a" });
    // A cd after a here-document is the command's again; one inside it, or in a here-string, is text.
    const script = "cd a/repo && python3 - <<'EOF'\nimport os\ncd /not/a/command\nEOF\ncd ../scratch && sh run.sh <<< 'cd /nor/this'";
    expect(withoutHeredocs(script)).toHaveLength(script.length);
    expect(withoutHeredocs(script)).not.toContain("/not/a/command");
    expect(foldersIn("/workspace", script).parts.map((part) => part.cwd)).toEqual(["/workspace/a/repo", "/workspace/a/scratch"]);
    expect(folderAfter("/workspace", "cat > a.txt <<A; cat > b.txt <<-'B'\ncd /one\nA\ncd /two\n\tB\ncd c")).toBe("/workspace/c");
  });
  it("knows which lines start a tool call and which end one, for Claude Code and for Codex", () => {
    expect(readLine(bash("cat a.c"))).toEqual({ starts: ["cat a.c"], ends: false, fresh: false });
    expect(readLine(edit("src/a.c")).starts[0]).toContain("/workspace/src/a.c");
    expect(readLine(result())).toMatchObject({ starts: [], ends: true });
    expect(readLine(codexStart("bash -lc 'cat a.c'"))).toEqual({ starts: ["bash -lc 'cat a.c'"], ends: false, fresh: true });
    expect(readLine(codexEnd())).toMatchObject({ starts: [], ends: true });
    for (const quiet of ["not json", JSON.stringify({ type: "system", subtype: "init" }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "cat a.c" }] } }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } })]) {
      expect(readLine(quiet)).toMatchObject({ starts: [], ends: false });
    }
  });
  it("names the files a line edits: an edit tool's file, or a patch's", () => {
    expect(editsIn(edit("src/a.c"))).toEqual(["src/a.c"]);
    expect(editsIn(bash("cat src/a.c"))).toEqual([]);
    expect(editsIn('{"arguments":"*** Begin Patch\\n*** Update File: src/a.c\\n@@\\n*** Add File: new.c\\n"}')).toEqual(["src/a.c", "new.c"]);
  });
});

describe("who is told about a change", () => {
  const seats = ["cc-1", "cc-2", "cc-3"];
  const start = (audience: "affected" | "all" = "affected") => {
    const env = new Environment(seats, { audience });
    env.know(["src/a.c", "src/b.c", "README.md"]);
    return env;
  };
  /** A command a seat ran, from its start to its result. */
  const ran = (env: Environment, seat: string, turn: number, command: string, from: number, to: number) => {
    env.sawLine(seat, turn, bash(command), from);
    env.sawLine(seat, turn, result(), to);
  };
  const changed = (mtimeMs: number, path = "src/a.c") => [{ path, kind: "changed" as const, mtimeMs }];

  it("tells a seat that read the file, and names the seat whose command was writing it", () => {
    const env = start();
    ran(env, "cc-1", 3, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-1", 2_000);
    // Two seats have commands running when the file is written; one of them names it.
    ran(env, "cc-3", 2, "make -C other", 49_000, 52_000);
    ran(env, "cc-2", 5, "cd /workspace && cat > src/a.c <<'EOF'\nint a;\nEOF", 50_000, 51_000);
    const added = env.observe(changed(50_500), 48_000, 53_000);
    expect(added).toMatchObject([{ seat: "cc-1", path: "src/a.c", by: "cc-2", interest: "read", seenTurn: 3, at: 50_500 }]);
    expect(env.waiting("cc-2")).toEqual([]);
    expect(env.waiting("cc-3")).toEqual([]);
    expect(describeNote(added[0]!, 60_500)).toBe("src/a.c changed 10 s ago, by cc-2; you last had it in turn 3");
  });

  it("takes the one seat with a command running for the author, and failing that the one seat in a turn", () => {
    const env = start();
    ran(env, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-1", 2_000);
    // The command does not name the file: git rewrote it.
    ran(env, "cc-3", 4, "git reset -q --hard origin/main", 60_000, 66_000);
    env.turnStarted("cc-2", 2, 55_000);
    expect(env.observe(changed(63_000), 60_000, 65_000)).toMatchObject([{ seat: "cc-1", by: "cc-3" }]);

    const other = start();
    ran(other, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    other.turnEnded("cc-1", 2_000);
    // In a turn, with no command on record at that moment.
    other.turnStarted("cc-2", 2, 55_000);
    expect(other.observe(changed(63_000), 60_000, 65_000)).toMatchObject([{ seat: "cc-1", by: "cc-2" }]);
  });

  it("names the seats that were working when it cannot tell them apart, and says so when none was", () => {
    const env = start();
    ran(env, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-1", 2_000);
    ran(env, "cc-2", 2, "make", 60_000, 70_000);
    ran(env, "cc-3", 2, "sh build.sh", 61_000, 69_000);
    const [note] = env.observe(changed(63_000), 60_000, 65_000);
    expect(note).toMatchObject({ seat: "cc-1", by: null, candidates: ["cc-2", "cc-3"] });
    expect(describeNote(note!, 183_000)).toBe("src/a.c changed 2 min ago, by cc-2 or cc-3 (working at the time); you last had it in turn 1");

    const quiet = start();
    ran(quiet, "cc-1", 4, "cat src/a.c", 1_000, 1_500);
    quiet.turnEnded("cc-1", 2_000);
    const [outside] = quiet.observe(changed(63_000), 60_000, 65_000);
    expect(outside).toMatchObject({ by: null, candidates: [] });
    expect(describeNote(outside!, 68_000)).toBe("src/a.c changed 5 s ago, by no seat that was working (a check, a probe, or something a seat left running); you last had it in turn 4");
  });

  it("does not tell a seat about its own change: a turn that ended before the scan still wrote the file", () => {
    const env = start();
    ran(env, "cc-3", 2, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-3", 2_000);
    // cc-1 writes the file as its turn's last act; the scan comes after the turn is over, with others in a turn.
    ran(env, "cc-1", 6, "printf x >> src/a.c", 62_000, 62_400);
    env.turnEnded("cc-1", 62_500);
    env.turnStarted("cc-2", 3, 50_000);
    const added = env.observe(changed(62_200), 60_000, 65_000);
    expect(added.map((note) => [note.seat, note.by])).toEqual([["cc-3", "cc-1"]]);
  });

  it("takes the seat whose shell stood in the file's folder for the author of what git or a build rewrote there", () => {
    const env = new Environment(seats, { audience: "affected" });
    env.know(["candidates/cc-1/repo/src/a.c", "candidates/cc-2/repo/src/a.c", "NOTES.md"]);
    ran(env, "cc-3", 1, "cat /workspace/candidates/cc-1/repo/src/a.c /workspace/NOTES.md", 1_000, 1_500);
    env.turnEnded("cc-3", 2_000);
    // Two seats run commands that name no file, each in its own folder.
    ran(env, "cc-1", 2, "cd /workspace/candidates/cc-1/repo", 59_000, 59_100);
    ran(env, "cc-1", 2, "git rebase --abort; git reset -q --hard origin/main", 60_000, 66_000);
    ran(env, "cc-2", 2, "cd /workspace/candidates/cc-2/repo && sh compile.sh", 61_000, 69_000);
    const added = env.observe([{ path: "candidates/cc-1/repo/src/a.c", kind: "changed", mtimeMs: 63_000 }, { path: "candidates/cc-1/repo/src/old.c", kind: "deleted" }], 60_000, 65_000);
    expect(added.map((note) => [note.seat, note.path, note.by])).toEqual([["cc-3", "candidates/cc-1/repo/src/a.c", "cc-1"]]);
    expect(env.waiting("cc-1")).toEqual([]);
    // The workspace's own root holds every file: standing there says nothing about who wrote one.
    const next = env.observe([{ path: "NOTES.md", kind: "changed", mtimeMs: 63_500 }], 65_000, 70_000);
    expect(next).toMatchObject([{ seat: "cc-3", by: null, candidates: ["cc-1", "cc-2"] }]);
  });

  it("places a command in every folder it changes into: a build in one folder, then a run from another", () => {
    const env = new Environment(seats, { audience: "affected" });
    env.know(["candidates/cc-1/repo/executable", "candidates/cc-1/repo/main.c", "candidates/cc-2/repo/executable", "candidates/cc-1/scratch/in.flac"]);
    // cc-1 built both files before, so they are its own; cc-2 is at work in its own folder all along.
    ran(env, "cc-1", 1, "cd /workspace/candidates/cc-1/repo && sh compile.sh", 1_000, 2_000);
    env.observe([{ path: "candidates/cc-1/repo/executable", kind: "changed", mtimeMs: 1_500 }, { path: "candidates/cc-1/repo/main.c", kind: "changed", mtimeMs: 1_500 }], 0, 3_000);
    env.sawLine("cc-2", 2, bash("cd /workspace/candidates/cc-2/repo && sleep 300"), 50_000);
    // The build is in repo, the command ends in scratch: git rewrote main.c, which the command never names.
    ran(env, "cc-1", 2, "cd /workspace/candidates/cc-1/repo && git checkout -q FETCH_HEAD && sh compile.sh; cd ../scratch; cmp out.wav ref.wav", 60_000, 64_000);
    expect(env.folder("cc-1")).toBe("/workspace/candidates/cc-1/scratch");
    expect(env.observe([{ path: "candidates/cc-1/repo/main.c", kind: "changed", mtimeMs: 62_000 }], 55_000, 65_000)).toEqual([]);
    // The file is named as ./executable in one folder and ../repo/executable in the next.
    ran(env, "cc-1", 3, "cd ../repo && sh compile.sh; C=./executable; cd /workspace/candidates/cc-1/scratch; ../repo/executable -i in.flac out.wav", 160_000, 164_000);
    expect(env.observe([{ path: "candidates/cc-1/repo/executable", kind: "changed", mtimeMs: 162_000 }], 155_000, 165_000)).toEqual([]);
    expect(env.waiting("cc-1")).toEqual([]);
  });

  it("tells a seat when a shared file changes and no longer matches the copy the seat holds", () => {
    const matching = new Set<string>();
    const env = new Environment(seats, { audience: "affected", shared: ["best/"], identical: (a, b) => matching.has(`${a} ${b}`) });
    env.know(["best/src/main.c", "candidates/cc-1/repo/src/main.c", "candidates/cc-2/repo/src/main.c"]);
    // Two builders, each writing its own copy.
    for (const [seat, at] of [["cc-1", 1_000], ["cc-2", 3_000]] as const) {
      ran(env, seat, 1, `cd /workspace/candidates/${seat}/repo && cat > src/main.c <<'EOF'\nint main;\nEOF`, at, at + 500);
      expect(env.observe([{ path: `candidates/${seat}/repo/src/main.c`, kind: "changed", mtimeMs: at + 200 }], at - 500, at + 900)).toEqual([]);
      env.turnEnded(seat, at + 1_000);
    }
    // The third seat lands cc-2's copy into the shared folder: it now matches cc-2's and not cc-1's.
    matching.add("best/src/main.c candidates/cc-2/repo/src/main.c");
    ran(env, "cc-3", 4, "tools/promote cc-2 f012de2", 60_000, 62_000);
    const added = env.observe([{ path: "best/src/main.c", kind: "changed", mtimeMs: 61_000 }], 58_000, 63_000);
    expect(added).toMatchObject([{ seat: "cc-1", path: "best/src/main.c", by: "cc-3", interest: "edited", copy: "candidates/cc-1/repo/src/main.c" }]);
    expect(describeNote(added[0]!, 66_000)).toBe("best/src/main.c changed 5 s ago, by cc-3; it no longer matches your copy candidates/cc-1/repo/src/main.c, which you edited in turn 1");
    expect(env.waiting("cc-2")).toEqual([]);
    // A file that is not in a shared folder has no copies: cc-1's own file changing tells nobody about cc-2's.
    ran(env, "cc-1", 2, "cd /workspace/candidates/cc-1/repo && printf x >> src/main.c", 90_000, 90_500);
    expect(env.observe([{ path: "candidates/cc-1/repo/src/main.c", kind: "changed", mtimeMs: 90_200 }], 88_000, 91_000)).toEqual([]);
  });

  it("leaves both out when two seats' commands named the file at once, and tells a third", () => {
    const env = start();
    ran(env, "cc-3", 2, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-3", 2_000);
    ran(env, "cc-1", 6, "sed -i s/a/b/ src/a.c", 62_000, 63_000);
    ran(env, "cc-2", 6, "sed -i s/c/d/ src/a.c", 62_100, 63_100);
    const added = env.observe(changed(62_500), 60_000, 65_000);
    expect(added).toMatchObject([{ seat: "cc-3", by: null, candidates: ["cc-1", "cc-2"] }]);
  });

  it("makes the file the author's own: it is told when someone else changes it later", () => {
    const env = start();
    ran(env, "cc-2", 1, "cat > src/a.c <<'EOF'\nx\nEOF", 10_000, 11_000);
    expect(env.observe(changed(10_500), 8_000, 13_000)).toEqual([]);
    expect(env.interest("cc-2")).toEqual([{ path: "src/a.c", turn: 1, edited: true }]);
    // Many turns later, another seat rewrites it.
    env.turnEnded("cc-2", 12_000);
    env.turnStarted("cc-2", 20, 500_000);
    ran(env, "cc-1", 9, "cat > src/a.c <<'EOF'\ny\nEOF", 600_000, 601_000);
    const added = env.observe(changed(600_500), 598_000, 603_000);
    expect(added).toMatchObject([{ seat: "cc-2", by: "cc-1", interest: "edited", seenTurn: 1 }]);
    expect(describeNote(added[0]!, 610_500)).toBe("src/a.c changed 10 s ago, by cc-1; you edited it in turn 1");
  });

  it("lets a reading lapse after six of the seat's turns, and keeps an edit", () => {
    const env = start();
    ran(env, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    env.sawLine("cc-3", 1, edit("src/a.c"), 1_200);
    env.sawLine("cc-3", 1, result(), 1_300);
    for (const seat of ["cc-1", "cc-3"]) { env.turnEnded(seat, 2_000); env.turnStarted(seat, 8, 400_000); env.turnEnded(seat, 401_000); }
    ran(env, "cc-2", 3, "printf x >> src/a.c", 500_000, 501_000);
    expect(env.observe(changed(500_500), 498_000, 503_000).map((note) => [note.seat, note.interest])).toEqual([["cc-3", "edited"]]);
  });

  it("follows each seat's shell: Claude Code's stays where a command left it, Codex's starts over", () => {
    const env = new Environment(["cc-1", "cx-1"], { audience: "affected" });
    env.know(["project/src/a.c", "other/src/a.c"]);
    ran(env, "cc-1", 1, "cd /workspace/project/src", 1_000, 1_100);
    ran(env, "cc-1", 1, "cat a.c", 1_200, 1_300);
    expect(env.folder("cc-1")).toBe("/workspace/project/src");
    expect(env.interest("cc-1")).toEqual([{ path: "project/src/a.c", turn: 1, edited: false }]);
    env.sawLine("cx-1", 1, codexStart("cd other && cat src/a.c"), 2_000);
    env.sawLine("cx-1", 1, codexEnd("int a;"), 2_100);
    env.sawLine("cx-1", 1, codexStart("cat src/a.c"), 2_200);
    env.sawLine("cx-1", 1, codexEnd(), 2_300);
    expect(env.interest("cx-1")).toEqual([{ path: "other/src/a.c", turn: 1, edited: false }]);
    expect(env.folder("cx-1")).toBe("/workspace");
    // A command that ends outside the workspace: Claude Code puts the shell back and says so in the result.
    env.sawLine("cc-1", 2, bash("cd /tmp && ls"), 3_000);
    expect(env.folder("cc-1")).toBe("/tmp");
    env.sawLine("cc-1", 2, result("a.txt\nShell cwd was reset to /workspace"), 3_100);
    expect(env.folder("cc-1")).toBe("/workspace");
  });

  it("counts every file a command names, and takes many files in what a command printed for a listing", () => {
    const env = new Environment(seats, { audience: "affected" });
    const files = Array.from({ length: 12 }, (_, index) => `src/f${index}.c`);
    env.know(files);
    env.sawLine("cc-1", 1, bash("ls src"), 1_000);
    env.sawLine("cc-1", 1, result(files.join("\n")), 1_100);
    expect(env.interest("cc-1")).toEqual([]);
    ran(env, "cc-2", 1, `gcc -c ${files.join(" ")}`, 2_000, 2_500);
    expect(env.interest("cc-2")).toHaveLength(12);
  });

  it("with the audience all, tells every other seat, and about new files too", () => {
    const env = start("all");
    ran(env, "cc-2", 1, "touch src/new.c", 5_000, 5_500);
    const added = env.observe([{ path: "src/new.c", kind: "new", mtimeMs: 5_200 }], 4_000, 6_000);
    expect(added.map((note) => [note.seat, note.by, note.interest])).toEqual([["cc-1", "cc-2", "all"], ["cc-3", "cc-2", "all"]]);
    expect(describeNote(added[0]!, 6_200)).toBe("src/new.c is new 1 s ago, by cc-2");
  });

  it("puts a file that is gone anywhere since the last scan", () => {
    const env = start();
    ran(env, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-1", 2_000);
    ran(env, "cc-2", 2, "rm src/a.c", 61_000, 61_200);
    const added = env.observe([{ path: "src/a.c", kind: "deleted" }], 60_000, 65_000);
    expect(added).toMatchObject([{ seat: "cc-1", by: "cc-2", kind: "deleted", at: 65_000 }]);
    expect(describeNote(added[0]!, 70_000)).toBe("src/a.c was deleted 5 s ago, by cc-2; you last had it in turn 1");
  });

  it("keeps one note per file until it is given, and does not repeat a file within a minute of telling", () => {
    const env = start();
    const forOne = (notes: Array<{ seat: string }>) => notes.filter((note) => note.seat === "cc-1");
    ran(env, "cc-1", 1, "cat src/a.c", 1_000, 1_500);
    env.turnEnded("cc-1", 2_000);
    ran(env, "cc-2", 1, "printf x >> src/a.c", 5_000, 5_500);
    expect(forOne(env.observe(changed(5_200), 4_000, 6_000))).toHaveLength(1);
    ran(env, "cc-3", 1, "printf y >> src/a.c", 10_000, 10_500);
    // Nothing new for cc-1, whose note is still waiting; cc-2, which wrote the file first, now has one.
    expect(env.observe(changed(10_200), 6_000, 11_000)).toMatchObject([{ seat: "cc-2", by: "cc-3", interest: "edited" }]);
    const [waiting] = env.waiting("cc-1");
    // Two authors by now: the note no longer names one.
    expect(waiting).toMatchObject({ by: null, candidates: ["cc-2", "cc-3"], at: 10_200 });
    expect(env.delivered("cc-1", [waiting!.id], 12_000)).toHaveLength(1);
    expect(env.waiting("cc-1")).toEqual([]);
    ran(env, "cc-2", 1, "printf z >> src/a.c", 29_000, 29_500);
    expect(forOne(env.observe(changed(29_200), 12_000, 30_000))).toHaveLength(0);
    ran(env, "cc-2", 1, "printf z >> src/a.c", 79_000, 79_500);
    expect(forOne(env.observe(changed(79_200), 30_000, 80_000))).toHaveLength(1);
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
  const prepared = async (notes: Array<{ id: string; file: string; seconds: number; by: string }>) => {
    const dir = await temporary();
    const script = join(dir, "hook.cjs");
    await writeFile(script, ENV_HOOK);
    if (notes.length > 0) {
      await writeFile(join(dir, "pending.json"), JSON.stringify(notes.map((note) => ({ id: note.id, file: note.file, at: Date.now() - note.seconds * 1000, text: `${note.file.replace("/workspace/", "")} changed {ago}, by ${note.by}` }))));
    }
    const given = async () => (await readFile(join(dir, "delivered.ndjson"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((record) => [record.id, record.how]);
    return { dir, script, given };
  };
  const preEdit = (file: string) => ({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: file } });
  const preBash = (command: string, cwd = "/workspace") => ({ hook_event_name: "PreToolUse", tool_name: "Bash", cwd, tool_input: { command } });
  const post = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

  it("holds an edit to a file that changed under the seat once, hands the rest over after a tool call, and gives each note once", async () => {
    const silent = await prepared([]);
    expect(run(silent.script, silent.dir, preEdit("/workspace/src/a.c")).stdout).toBe("");
    const { dir, script, given } = await prepared([{ id: "n1", file: "/workspace/src/a.c", seconds: 10, by: "cc-2" }, { id: "n2", file: "/workspace/src/b.c", seconds: 300, by: "cc-3" }]);
    // An edit to another file goes through.
    expect(run(script, dir, preEdit("/workspace/src/z.c")).stdout).toBe("");
    const held = JSON.parse(run(script, dir, preEdit("/workspace/src/a.c")).stdout);
    expect(held.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(held.hookSpecificOutput.permissionDecisionReason).toMatch(/src\/a\.c changed 1[0-2] s ago, by cc-2\. This edit was held once and nothing was written/);
    // The same edit again is let through.
    expect(run(script, dir, preEdit("/workspace/src/a.c")).stdout).toBe("");
    const told = JSON.parse(run(script, dir, post).stdout);
    expect(told.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(told.hookSpecificOutput.additionalContext).toMatch(/^SharedNet workspace, changed by others while you work: src\/b\.c changed 5 min ago, by cc-3\./);
    expect(run(script, dir, post).stdout).toBe("");
    expect(await given()).toEqual([["n1", "held-edit"], ["n2", "note"]]);
  });

  it("holds a shell command that writes a file that changed under the seat, read from where the shell stands, and lets a reading through", async () => {
    const note = { id: "n1", file: "/workspace/candidates/cc-1/repo/src/main.c", seconds: 20, by: "cc-4" };
    for (const [command, cwd] of [
      ["cd /workspace/candidates/cc-1/repo && cat > src/main.c <<'EOF'\nint main;\nEOF", "/workspace"],
      ["sed -i s/a/b/ src/main.c", "/workspace/candidates/cc-1/repo"],
      ["git checkout -- main.c", "/workspace/candidates/cc-1/repo/src"],
      ["python3 gen.py | tee /workspace/candidates/cc-1/repo/src/main.c", "/tmp"],
      // The write is in the folder the command stands in at that point, not the one it ends in.
      ["cd /workspace/candidates/cc-1/repo && sed -i s/a/b/ src/main.c; cd /tmp; ls", "/workspace"],
      ["python3 - <<'EOF'\nprint('cd /tmp')\nEOF\ncd /workspace/candidates/cc-1/repo/src && git checkout -- main.c", "/tmp"],
    ] as const) {
      const { dir, script, given } = await prepared([note]);
      const held = JSON.parse(run(script, dir, preBash(command, cwd)).stdout);
      expect(held.hookSpecificOutput.permissionDecisionReason).toMatch(/src\/main\.c changed 2[0-2] s ago, by cc-4\. This command was held once and nothing was written/);
      expect(run(script, dir, preBash(command, cwd)).stdout).toBe("");
      expect(await given()).toEqual([["n1", "held-edit"]]);
    }
    const { dir, script, given } = await prepared([note]);
    // A reading, a write to another seat's copy of the same name, a redirect of an error stream and output thrown away are not held.
    for (const [command, cwd] of [
      ["sh check.sh src/main.c >/dev/null 2>&1; echo rc=$?", "/workspace/candidates/cc-1/repo"],
      ["cd /workspace/candidates/cc-2/repo && sed -i s/a/b/ src/main.c; cd /workspace/candidates/cc-1/repo; ls", "/workspace"],
      ["cat src/main.c | head -40", "/workspace/candidates/cc-1/repo"],
      ["cat > src/main.c <<'EOF'\nx\nEOF", "/workspace/candidates/cc-2/repo"],
      ["grep -n main src/main.c 2>&1", "/workspace/candidates/cc-1/repo"],
    ] as const) expect(run(script, dir, preBash(command, cwd)).stdout).toBe("");
    expect(await given()).toEqual([]);
  });
});
