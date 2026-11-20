import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../errors.ts";
import { Trunk, forkSetup, forksHelp, parseLandCheck, parseWorkspaceLayout, pendingLandings, prepareTrunk, readLandRequest, requestLanding, type LandResult } from "./workspace.ts";

const made: string[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A trunk with one file, and a fork per seat as a seat's container would make it, all on this machine. */
async function world(seats: string[] = ["a", "b"]) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-forks-"));
  made.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "main.c"), "int main(void) { return 0; }\n");
  await writeFile(join(workspace, "notes.md"), "one\ntwo\nthree\n");
  const info = await prepareTrunk(workspace, join(root, "record"));
  const forks: Record<string, string> = {};
  const landing: Record<string, string> = {};
  for (const seat of seats) {
    forks[seat] = join(root, "forks", seat);
    landing[seat] = join(root, "landing", seat);
    await mkdir(landing[seat]!, { recursive: true });
    git(root, "clone", "--quiet", "--no-hardlinks", workspace, forks[seat]!);
    git(forks[seat]!, "config", "user.name", seat);
    git(forks[seat]!, "config", "user.email", `${seat}@sharednet.invalid`);
    git(forks[seat]!, "config", "pull.rebase", "false");
  }
  const commit = async (seat: string, file: string, content: string, message = `${seat} changes ${file}`) => {
    await writeFile(join(forks[seat]!, file), content);
    git(forks[seat]!, "add", "-A");
    git(forks[seat]!, "commit", "--quiet", "-m", message);
    return git(forks[seat]!, "rev-parse", "HEAD");
  };
  const env = (seat: string) => ({ SHAREDNET_LAND_DIR: landing[seat]!, SHAREDNET_FORK: forks[seat]!, SHAREDNET_TRUNK_BRANCH: info.branch });
  /** The seat asks; the runner, here, answers every request it finds, as goal run's loop does. */
  const land = async (trunk: Trunk, seat: string, note?: string) => {
    const answered = new Set<string>();
    const results: LandResult[] = [];
    let asked = false;
    const asking = requestLanding(note, {
      env: env(seat),
      waitMs: 5_000,
      sleep: async () => {
        for (const pending of await pendingLandings(join(root, "landing"), seats, answered)) {
          const request = await readLandRequest(landing[pending.seat]!, pending.n);
          const result = await trunk.land(pending.seat, request!, join(landing[pending.seat]!, `${pending.n}.bundle`));
          answered.add(`${pending.seat}/${pending.n}`);
          results.push(result);
          await writeFile(join(landing[pending.seat]!, `${pending.n}.result.json`), JSON.stringify(result));
        }
        asked = true;
      },
    });
    const said = await asking.then((value) => ({ value, error: null as CliError | null }), (error: CliError) => ({ value: null, error }));
    return { ...said, results, asked };
  };
  return { root, workspace, info, forks, landing, commit, env, land };
}

describe("the workspace layout's options", () => {
  it("is shared unless forks is asked for", () => {
    expect(parseWorkspaceLayout(undefined)).toBe("shared");
    expect(parseWorkspaceLayout("forks")).toBe("forks");
    expect(() => parseWorkspaceLayout("branches")).toThrow(/shared or forks/);
  });

  it("takes a landing check only where something lands", () => {
    expect(parseLandCheck(undefined, "shared")).toBeNull();
    expect(parseLandCheck("./compile.sh", "forks")).toBe("./compile.sh");
    expect(() => parseLandCheck("./compile.sh", "shared")).toThrow(/needs --workspace-layout forks/);
    expect(() => parseLandCheck("  ", "forks")).toThrow(/shell command/);
  });

  it("tells a seat where the trunk is, how to land, and what the check is", () => {
    const team = forksHelp({ branch: "main", landCheck: "./compile.sh && ./executable -version", single: false });
    expect(team).toContain("/trunk here (read-only)");
    expect(team).toContain('sharednet land "<what changed, in one line>"');
    expect(team).toContain("./compile.sh && ./executable -version");
    expect(team).toContain("/forks/<name>");
    expect(team).toContain("not part of the result");
    const alone = forksHelp({ branch: "main", landCheck: null, single: true });
    expect(alone).not.toContain("/forks/<name>");
    expect(alone).not.toContain("clean copy");
  });

  it("gives a seat its name on its commits and a clone of the trunk", () => {
    const script = forkSetup("claude-code-2");
    expect(script).toContain("user.name 'claude-code-2'");
    expect(script).toContain("git clone --quiet --no-hardlinks /trunk /workspace");
    expect(script).toContain("pull.rebase false");
  });
});

describe("making a workspace a trunk", () => {
  it("makes a folder a repository, with what it holds as the first commit and the record left out", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-trunk-"));
    made.push(root);
    await writeFile(join(root, "a.txt"), "a\n");
    await mkdir(join(root, "runs", "rom_1"), { recursive: true });
    await writeFile(join(root, "runs", "rom_1", "room.ndjson"), "{}\n");
    await mkdir(join(root, ".sharednet"));
    await writeFile(join(root, ".sharednet", "state.json"), "{}\n");
    const info = await prepareTrunk(root, join(root, "runs"));
    expect(info).toMatchObject({ branch: "main", made: true });
    expect(git(root, "ls-tree", "-r", "--name-only", "HEAD")).toBe("a.txt");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "log", "-1", "--format=%an")).toBe("sharednet goal");
  });

  it("keeps a repository as it is, on the branch it is on", async () => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-trunk-"));
    made.push(root);
    git(root, "init", "--quiet", "--initial-branch=work");
    await writeFile(join(root, "a.txt"), "a\n");
    git(root, "add", "-A");
    git(root, "-c", "user.name=me", "-c", "user.email=me@example.invalid", "commit", "--quiet", "-m", "mine");
    const head = git(root, "rev-parse", "HEAD");
    expect(await prepareTrunk(root, null)).toEqual({ branch: "work", head, made: false });
    // Asked twice, it changes nothing the second time.
    const exclude = await readFile(join(root, ".git", "info", "exclude"), "utf8");
    await prepareTrunk(root, null);
    expect(await readFile(join(root, ".git", "info", "exclude"), "utf8")).toBe(exclude);
  });

  it("refuses a repository with uncommitted changes, and names them", async () => {
    const { workspace } = await world([]);
    await writeFile(join(workspace, "main.c"), "changed\n");
    await writeFile(join(workspace, "new.c"), "new\n");
    await expect(prepareTrunk(workspace, null)).rejects.toThrow(/2 files with changes that are not committed \(main\.c, new\.c\)/);
  });

  it("refuses a detached HEAD", async () => {
    const { workspace } = await world([]);
    git(workspace, "checkout", "--quiet", "--detach");
    await expect(prepareTrunk(workspace, null)).rejects.toThrow(/not on a branch/);
  });
});

describe("landing", () => {
  it("lands a commit built on the trunk as it is, and the trunk's files follow", async () => {
    const { workspace, info, commit, land } = await world();
    const sha = await commit("a", "main.c", "int main(void) { return 1; }\n");
    const trunk = new Trunk(workspace, info.branch);
    const { value, results } = await land(trunk, "a", "return 1");
    expect(results).toEqual([{ landed: true, n: 1, commit: sha, candidate: sha, kind: "fast-forward", files: [{ path: "main.c", kind: "changed" }] }]);
    expect(value).toMatchObject({ landed: true, landing: 1, commit: sha, trunk: "main", kind: "fast-forward", files: 1 });
    expect(await readFile(join(workspace, "main.c"), "utf8")).toBe("int main(void) { return 1; }\n");
    expect(await trunk.head()).toBe(sha);
    expect(await trunk.files()).toEqual(["main.c", "notes.md"]);
  });

  it("merges a commit that touches other files than what landed meanwhile, and says so", async () => {
    const { workspace, info, forks, commit, land } = await world();
    const trunk = new Trunk(workspace, info.branch);
    await commit("a", "main.c", "int main(void) { return 1; }\n");
    await land(trunk, "a");
    const mine = await commit("b", "util.c", "int util(void) { return 2; }\n");
    const { value, results } = await land(trunk, "b", "a helper");
    expect(results[0]).toMatchObject({ landed: true, kind: "merge", candidate: mine, files: [{ path: "util.c", kind: "new" }] });
    expect(value).toMatchObject({ landed: true, kind: "merge" });
    expect(String(value!.note)).toContain("git pull");
    expect(git(workspace, "log", "-1", "--format=%an: %s")).toBe("sharednet goal: Merge b's landing 1: a helper");
    expect(existsSync(join(workspace, "util.c"))).toBe(true);
    expect(await readFile(join(workspace, "main.c"), "utf8")).toContain("return 1");
    // The fork gets the rest with a pull, and is then exactly the trunk.
    git(forks.b!, "pull", "--quiet");
    expect(git(forks.b!, "rev-parse", "HEAD")).toBe(await trunk.head());
  });

  it("refuses a commit that conflicts with what landed, names the files, and leaves the trunk alone", async () => {
    const { workspace, info, forks, commit, land } = await world();
    const trunk = new Trunk(workspace, info.branch);
    const first = await commit("a", "main.c", "int main(void) { return 1; }\n");
    await land(trunk, "a");
    await commit("b", "main.c", "int main(void) { return 2; }\n");
    const { error, results } = await land(trunk, "b");
    expect(results[0]).toMatchObject({ landed: false, reason: "conflict", paths: ["main.c"] });
    expect(error?.code).toBe("landing_conflict");
    expect(error?.message).toContain("in main.c");
    expect(error?.message).toContain("git pull");
    expect(await trunk.head()).toBe(first);
    // After a pull and a resolution, the same seat lands.
    expect(() => git(forks.b!, "pull", "--quiet")).toThrow();
    await writeFile(join(forks.b!, "main.c"), "int main(void) { return 3; }\n");
    git(forks.b!, "add", "-A");
    git(forks.b!, "commit", "--quiet", "-m", "resolved");
    const again = await land(trunk, "b");
    expect(again.value).toMatchObject({ landed: true, landing: 2, kind: "fast-forward" });
    expect(await readFile(join(workspace, "main.c"), "utf8")).toContain("return 3");
  });

  it("runs the landing check on the result before the trunk moves, and refuses what fails it", async () => {
    const { root, workspace, info, commit, land } = await world();
    const seen: string[] = [];
    const trunk = new Trunk(workspace, info.branch, {
      check: async (sha, seat, n) => {
        const copy = join(root, "checks", `${seat}-${n}`);
        await trunk.export(sha, copy);
        const text = await readFile(join(copy, "main.c"), "utf8");
        seen.push(`${(await readdir(copy)).sort().join(",")}|${existsSync(join(copy, ".git"))}`);
        return text.includes("broken") ? { code: 2, output: "main.c:1: error: broken" } : { code: 0, output: "ok" };
      },
    });
    const before = await trunk.head();
    await commit("a", "main.c", "broken\n");
    const bad = await land(trunk, "a");
    expect(bad.results[0]).toMatchObject({ landed: false, reason: "check", check: { exit_code: 2, output: "main.c:1: error: broken" } });
    expect(bad.error?.code).toBe("landing_check_failed");
    expect(bad.error?.message).toContain("main.c:1: error: broken");
    expect(await trunk.head()).toBe(before);
    expect(await readFile(join(workspace, "main.c"), "utf8")).toContain("return 0");
    await commit("a", "main.c", "int main(void) { return 4; }\n");
    const good = await land(trunk, "a");
    expect(good.results[0]).toMatchObject({ landed: true, check: { exit_code: 0 } });
    // The check saw a clean copy: the files, and no repository.
    expect(seen).toEqual(["main.c,notes.md|false", "main.c,notes.md|false"]);
  });

  it("checks a merge as merged: what both seats did, together", async () => {
    const { root, workspace, info, commit, land } = await world();
    let together = "";
    const trunk = new Trunk(workspace, info.branch, {
      check: async (sha, seat, n) => {
        const copy = join(root, "checks", `${seat}-${n}`);
        await trunk.export(sha, copy);
        together = (await readdir(copy)).sort().join(",");
        return { code: 0, output: "" };
      },
    });
    await commit("a", "a.c", "a\n");
    await land(trunk, "a");
    await commit("b", "b.c", "b\n");
    await land(trunk, "b");
    expect(together).toBe("a.c,b.c,main.c,notes.md");
  });

  it("says there is nothing to land when the last commit is the trunk's own", async () => {
    const { workspace, info, forks, land } = await world();
    const trunk = new Trunk(workspace, info.branch);
    await writeFile(join(forks.a!, "main.c"), "not committed\n");
    const { error, asked } = await land(trunk, "a");
    expect(error?.code).toBe("nothing_to_land");
    expect(error?.message).toContain("1 file has changes that are not committed");
    expect(asked).toBe(false);
  });

  it("tells a seat about uncommitted changes that stay out of its landing", async () => {
    const { workspace, info, forks, commit, land } = await world();
    const trunk = new Trunk(workspace, info.branch);
    await commit("a", "main.c", "int main(void) { return 1; }\n");
    await writeFile(join(forks.a!, "scratch.txt"), "later\n");
    const { value } = await land(trunk, "a");
    expect(value).toMatchObject({ landed: true, uncommitted: 1 });
    expect(existsSync(join(workspace, "scratch.txt"))).toBe(false);
  });

  it("is refused in a shared workspace", async () => {
    await expect(requestLanding("x", { env: {} })).rejects.toThrow(/one shared folder/);
  });

  it("waits again for a landing it already asked for, and does not ask twice", async () => {
    const { workspace, info, landing, commit, env, land } = await world();
    const trunk = new Trunk(workspace, info.branch);
    await commit("a", "main.c", "int main(void) { return 1; }\n");
    const first = await requestLanding("slow", { env: env("a"), waitMs: 0, sleep: async () => undefined }).catch((error: CliError) => error);
    expect((first as CliError).code).toBe("landing_pending");
    expect((first as CliError).message).toContain("Run `sharednet land` again");
    const { value } = await land(trunk, "a");
    expect(value).toMatchObject({ landed: true, landing: 1 });
    expect((await readdir(landing.a!)).filter((name) => name.endsWith(".request.json"))).toEqual(["1.request.json"]);
  });

  it("answers landings oldest first, across seats", async () => {
    const { root, commit, env } = await world();
    await commit("b", "b.c", "b\n");
    await requestLanding(undefined, { env: env("b"), waitMs: 0, sleep: async () => undefined }).catch(() => undefined);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    await commit("a", "a.c", "a\n");
    await requestLanding(undefined, { env: env("a"), waitMs: 0, sleep: async () => undefined }).catch(() => undefined);
    const pending = await pendingLandings(join(root, "landing"), ["a", "b"], new Set());
    expect(pending.map((one) => `${one.seat}/${one.n}`)).toEqual(["b/1", "a/1"]);
    expect(await pendingLandings(join(root, "landing"), ["a", "b"], new Set(["b/1"]))).toHaveLength(1);
  });

  it("takes the commit's own subject as the note when none is given", async () => {
    const { landing, commit, env } = await world();
    await commit("a", "a.c", "a\n", "add   the a file");
    await requestLanding(undefined, { env: env("a"), waitMs: 0, sleep: async () => undefined }).catch(() => undefined);
    expect(await readLandRequest(landing.a!, 1)).toMatchObject({ n: 1, note: "add the a file" });
  });
});

describe("what a seat writes is not taken on trust", () => {
  it("does not read a request that is a link, is not JSON, or names no commit", async () => {
    const { root, landing } = await world();
    await writeFile(join(root, "secret"), JSON.stringify({ sha: "a".repeat(40), note: "x" }));
    await symlink(join(root, "secret"), join(landing.a!, "1.request.json"));
    await writeFile(join(landing.a!, "2.request.json"), "not json");
    await writeFile(join(landing.a!, "3.request.json"), JSON.stringify({ sha: "HEAD; rm -rf /", note: "x" }));
    await writeFile(join(landing.a!, "4.request.json"), JSON.stringify({ sha: "b".repeat(40), note: "a\nnote ".repeat(200) }));
    expect(await readLandRequest(landing.a!, 1)).toBeNull();
    expect(await readLandRequest(landing.a!, 2)).toBeNull();
    expect(await readLandRequest(landing.a!, 3)).toBeNull();
    const kept = await readLandRequest(landing.a!, 4);
    expect(kept?.note.length).toBe(300);
    expect(kept?.note).not.toContain("\n");
  });

  it("refuses a bundle that is not one, or that holds another commit than the request names", async () => {
    const { workspace, info, landing, commit, env } = await world();
    const trunk = new Trunk(workspace, info.branch);
    const before = await trunk.head();
    await writeFile(join(landing.a!, "7.bundle"), "not a bundle");
    expect(await trunk.land("a", { n: 7, sha: "c".repeat(40), note: "" }, join(landing.a!, "7.bundle"))).toMatchObject({ landed: false, reason: "invalid" });
    expect(await trunk.land("a", { n: 8, sha: "c".repeat(40), note: "" }, join(landing.a!, "8.bundle"))).toMatchObject({ landed: false, reason: "invalid" });
    await commit("a", "a.c", "a\n");
    await requestLanding(undefined, { env: env("a"), waitMs: 0, sleep: async () => undefined }).catch(() => undefined);
    expect(await trunk.land("a", { n: 1, sha: "d".repeat(40), note: "" }, join(landing.a!, "1.bundle"))).toMatchObject({ landed: false, reason: "invalid", detail: "The bundle does not hold the commit the request names." });
    expect(await trunk.head()).toBe(before);
  });
});
