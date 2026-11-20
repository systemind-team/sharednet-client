/**
 * The workspace's layout (`--workspace-layout`): where a seat's work happens and how it reaches
 * the others.
 *
 *   shared  one folder, mounted in every seat's container: a write is everyone's at once (the default)
 *   forks   each seat works in its own fork, a git clone of the trunk, and nobody else sees a change
 *           until it lands. The trunk is the `--workspace` folder's own repository, and only the
 *           runner writes it: a seat commits in its fork and runs `sharednet land`, the runner
 *           merges that commit into the trunk, refuses it when it conflicts with what landed in the
 *           meantime, and with `--land-check <command>` accepts it only if the command passes in a
 *           clean copy of the result
 *
 * How a landing travels. A seat's container sees the trunk read-only, so it cannot push. It writes
 * a request and a git bundle of its commits into a folder of its own; the runner, on this machine,
 * reads the bundle into the trunk's repository (pack data, checked as it is read: the runner never
 * opens a repository a seat controls), merges, runs the check, moves the trunk's branch, brings
 * the trunk's files up to it, and writes the answer back. One landing at a time, in the order asked.
 *
 * Every request and its outcome is logged in `landings.ndjson`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { localError } from "../errors.ts";

export type WorkspaceLayout = "shared" | "forks";
export interface WorkspaceModule { layout: WorkspaceLayout; landCheck: string | null }

/** Where a seat of a forked workspace sees things; its own fork is at /workspace, as the shared folder would be. */
export const CONTAINER_TRUNK = "/trunk";
export const CONTAINER_FORKS = "/forks";
export const CONTAINER_LAND = "/landing";
/** Where the checks' container sees the clean copy a landing check runs in. */
export const CONTAINER_LAND_CHECKS = "/landing-checks";
/** The longest a landing check may run; a check that hangs would hold every later landing. */
export const LAND_CHECK_LIMIT_S = 600;
/** How often the runner looks for a landing request. */
export const LAND_POLL_MS = 1_000;
/** How long `sharednet land` waits for its answer before it says the landing is still with the runner. */
export const LAND_WAIT_MS = 100_000;

export function parseWorkspaceLayout(raw: string | undefined): WorkspaceLayout {
  if (raw === undefined) return "shared";
  if (raw === "shared" || raw === "forks") return raw;
  throw localError("invalid_arguments", "--workspace-layout is shared or forks.");
}

export function parseLandCheck(raw: string | undefined, layout: WorkspaceLayout): string | null {
  if (raw === undefined) return null;
  if (layout !== "forks") throw localError("invalid_arguments", "--land-check needs --workspace-layout forks: in a shared workspace nothing lands.");
  if (raw.trim() === "") throw localError("invalid_arguments", "--land-check is a shell command, such as ./compile.sh.");
  return raw;
}

/** What a seat is told first about a forked workspace. */
export function forksHelp(input: { branch: string; landCheck: string | null; single: boolean }): string {
  const check = input.landCheck === null ? "" : ` It accepts a landing only if this passes in a clean copy of the result: ${input.landCheck.length > 200 ? `${input.landCheck.slice(0, 197)}...` : input.landCheck}`;
  return [
    `The trunk is the accepted work, and it is what the goal is judged on: ${CONTAINER_TRUNK} here (read-only), \`origin\` in your fork, branch ${input.branch}. It changes only when a landing is accepted.`,
    `To land your work: commit it in /workspace, then run \`sharednet land "<what changed, in one line>"\`. The runner merges your commit into the trunk.${input.single ? "" : " It refuses a landing that conflicts with what has landed since you last pulled: then run `git pull`, resolve, commit, and land again."}${check}`,
    ...(input.single ? [] : [`Others' landings reach your fork only when you run \`git pull\`. A teammate's fork can be read at ${CONTAINER_FORKS}/<name>.`]),
    "Your fork is where you try things: nothing in it reaches the trunk until you land it, and work that has not landed when the Room ends is not part of the result. Land small steps, often.",
  ].join(" ");
}

// ---------------------------------------------------------------------------------------------
// git

export type Git = (args: readonly string[], options: { cwd: string; env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runGit: Git = (args, options) =>
  new Promise((resolveGit) => {
    execFile("git", [...args], { cwd: options.cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...options.env }, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolveGit({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const RUNNER = ["-c", "user.name=sharednet goal", "-c", "user.email=goal@sharednet.invalid"];
const lastLine = (text: string) => text.trim().split("\n").at(-1) ?? "";
const short = (sha: string) => sha.slice(0, 9);

// ---------------------------------------------------------------------------------------------
// The trunk, on this machine

export interface TrunkInfo { branch: string; head: string; made: boolean }

/**
 * Makes the workspace ready to be a trunk, before anything else of the run exists. A folder that
 * is not a repository becomes one, with what it holds as the first commit. A repository must have
 * nothing uncommitted: a seat's fork is a clone, and would not have it.
 * `record` is where the run's record goes; inside the workspace, it is kept out of the trunk.
 */
export async function prepareTrunk(workspace: string, record: string | null, git: Git = runGit): Promise<TrunkInfo> {
  const run = (args: readonly string[]) => git(args, { cwd: workspace });
  const dotGit = join(workspace, ".git");
  const made = !existsSync(dotGit);
  if (made) {
    const init = await run(["init", "--quiet", "--initial-branch=main"]);
    if (init.code !== 0) throw localError("workspace_not_ready", `--workspace-layout forks keeps the trunk in git, and ${workspace} could not be made a repository: ${lastLine(init.stderr) || "git is not here"}.`);
  } else if (!(await lstat(dotGit)).isDirectory()) {
    throw localError("workspace_not_ready", `${workspace} is a linked worktree or a submodule: its repository is elsewhere, where the seats' containers cannot read it. Give --workspace a folder with its own .git.`);
  }
  // The seats' own bookkeeping and the run's record are not work.
  const excluded = [".sharednet/"];
  const inside = record === null ? ".." : relative(workspace, record);
  if (inside !== "" && !inside.startsWith("..") && !isAbsolute(inside)) excluded.push(`/${inside.split("\\").join("/")}/`);
  const exclude = join(dotGit, "info", "exclude");
  const before = await readFile(exclude, "utf8").catch(() => "");
  const missing = excluded.filter((line) => !before.split("\n").includes(line));
  if (missing.length > 0) {
    await mkdir(join(dotGit, "info"), { recursive: true });
    await writeFile(exclude, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);
  }
  const branch = (await run(["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
  if (!branch) throw localError("workspace_not_ready", `${workspace} is not on a branch (a detached HEAD), and a landing needs a branch to land on. Check one out, then run again.`);
  const born = (await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])).code === 0;
  if (!born) {
    await run(["add", "-A"]);
    const first = await run([...RUNNER, "commit", "--quiet", "--allow-empty", "-m", "The workspace as the run found it"]);
    if (first.code !== 0) throw localError("workspace_not_ready", `The workspace's first commit could not be made: ${lastLine(first.stderr)}.`);
  } else {
    const dirty = (await run(["status", "--porcelain", "--untracked-files=all"])).stdout.split("\n").filter(Boolean);
    if (dirty.length > 0) {
      const named = dirty.slice(0, 3).map((line) => line.slice(3)).join(", ");
      throw localError("workspace_not_clean", `${workspace} has ${dirty.length} ${dirty.length === 1 ? "file" : "files"} with changes that are not committed (${named}${dirty.length > 3 ? ", ..." : ""}). A seat's fork is a clone of what is committed, so it would not have them: commit or stash them, then run again.`);
    }
  }
  const head = (await run(["rev-parse", "HEAD"])).stdout.trim();
  return { branch, head, made };
}

/** What a seat's container does once, as the seat's user, to have its fork: its name on its commits, and a clone of the trunk. */
export function forkSetup(seat: string): string {
  return [
    `git config --global user.name '${seat}'`,
    `git config --global user.email '${seat}@sharednet.invalid'`,
    // `git pull` merges: with no choice made, git refuses to pull once the fork and the trunk have both moved.
    "git config --global pull.rebase false",
    `git clone --quiet --no-hardlinks ${CONTAINER_TRUNK} /workspace`,
    "printf '.sharednet/\\n' >> /workspace/.git/info/exclude",
  ].join(" && ");
}

export interface LandRequest { n: number; sha: string; note: string }
export interface LandedFile { path: string; kind: "changed" | "new" | "deleted" }
export type LandResult =
  | { landed: true; n: number; commit: string; candidate: string; kind: "fast-forward" | "merge"; files: LandedFile[]; check?: { exit_code: number; ms: number } }
  | { landed: false; n: number; reason: "conflict" | "check" | "nothing" | "invalid" | "error"; detail: string; paths?: string[]; check?: { exit_code: number; ms: number; output: string } };

export interface TrunkOptions {
  git?: Git;
  /** The landing check: run on the commit the trunk would move to, before it moves. Left out, nothing is checked. */
  check?: (commit: string, seat: string, n: number) => Promise<{ code: number; output: string }>;
  now?: () => number;
}

const SHA = /^[0-9a-f]{40,64}$/;
const REQUEST_LIMIT = 64 * 1024;
const NOTE_LIMIT = 300;

/** The landing requests no answer has been written for, oldest first. `answered` holds `<seat>/<n>` for the ones this runner has answered. */
export async function pendingLandings(root: string, seats: readonly string[], answered: ReadonlySet<string>): Promise<Array<{ seat: string; n: number; at: number }>> {
  const pending: Array<{ seat: string; n: number; at: number }> = [];
  for (const seat of seats) {
    const names = await readdir(join(root, seat)).catch(() => [] as string[]);
    for (const name of names) {
      const n = Number(/^(\d{1,6})\.request\.json$/.exec(name)?.[1] ?? Number.NaN);
      if (!Number.isInteger(n) || answered.has(`${seat}/${n}`) || names.includes(`${n}.result.json`)) continue;
      const info = await lstat(join(root, seat, name)).catch(() => null);
      if (info) pending.push({ seat, n, at: info.mtimeMs });
    }
  }
  return pending.sort((a, b) => a.at - b.at || a.seat.localeCompare(b.seat) || a.n - b.n);
}

/** A seat's request, or null when it is not one: a seat writes this file, so nothing in it is taken on trust. */
export async function readLandRequest(directory: string, n: number): Promise<LandRequest | null> {
  const path = join(directory, `${n}.request.json`);
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size > REQUEST_LIMIT) return null;
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { sha?: unknown; note?: unknown };
    if (typeof raw.sha !== "string" || !SHA.test(raw.sha)) return null;
    const note = typeof raw.note === "string" ? raw.note.replace(/\s+/g, " ").trim().slice(0, NOTE_LIMIT) : "";
    return { n, sha: raw.sha, note };
  } catch {
    return null;
  }
}

/** The trunk of a forked workspace: the `--workspace` folder's own repository, written by the runner alone. */
export class Trunk {
  readonly workspace: string;
  readonly branch: string;
  private readonly git: Git;
  private readonly options: TrunkOptions;

  constructor(workspace: string, branch: string, options: TrunkOptions = {}) {
    this.workspace = workspace;
    this.branch = branch;
    this.options = options;
    this.git = options.git ?? runGit;
  }

  private run(args: readonly string[], env?: Record<string, string>) {
    return this.git(args, { cwd: this.workspace, ...(env ? { env } : {}) });
  }

  /** The trunk's commit now. */
  async head(): Promise<string> {
    return (await this.run(["rev-parse", "--verify", "--quiet", `refs/heads/${this.branch}^{commit}`])).stdout.trim();
  }

  /** Every file the trunk holds now. */
  async files(): Promise<string[]> {
    return (await this.run(["ls-tree", "-r", "--name-only", "-z", `refs/heads/${this.branch}`])).stdout.split("\0").filter(Boolean);
  }

  /** A clean copy of one commit's files in `directory`, with no repository in it. */
  async export(commit: string, directory: string): Promise<void> {
    await mkdir(directory, { recursive: true });
    const index = `${directory}.index`;
    const env = { GIT_INDEX_FILE: index };
    const read = await this.run(["read-tree", commit], env);
    const written = read.code === 0 ? await this.run(["checkout-index", "--all", "--force", `--prefix=${directory}/`], env) : read;
    await rm(index, { force: true });
    if (written.code !== 0) throw new Error(`the commit could not be copied out: ${lastLine(written.stderr)}`);
  }

  /**
   * One landing: the seat's commit comes in from its bundle, is merged with the trunk, is checked,
   * and only then moves the trunk. Nothing of the trunk changes unless it lands.
   */
  async land(seat: string, request: LandRequest, bundle: string): Promise<LandResult> {
    const n = request.n;
    const refuse = (reason: "conflict" | "check" | "nothing" | "invalid" | "error", detail: string, more: { paths?: string[]; check?: { exit_code: number; ms: number; output: string } } = {}): LandResult => ({ landed: false, n, reason, detail, ...more });
    const info = await lstat(bundle).catch(() => null);
    if (!info?.isFile()) return refuse("invalid", "The landing's bundle is not there.");
    const ref = `refs/sharednet/landings/${seat}/${n}`;
    // Pack data from a seat: every object is checked as it is read.
    const fetched = await this.run(["-c", "fetch.fsckObjects=true", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", bundle, `+refs/sharednet/land/${n}:${ref}`]);
    if (fetched.code !== 0) return refuse("invalid", `The landing's bundle could not be read into the trunk: ${lastLine(fetched.stderr) || "git refused it"}.`);
    const candidate = (await this.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).stdout.trim();
    if (candidate !== request.sha) return refuse("invalid", "The bundle does not hold the commit the request names.");
    const head = await this.head();
    if (!head) return refuse("error", `The trunk has no branch ${this.branch} any more.`);
    const within = (a: string, b: string) => this.run(["merge-base", "--is-ancestor", a, b]).then((result) => result.code === 0);
    if (await within(candidate, head)) return refuse("nothing", `Commit ${short(candidate)} is already in the trunk.`);
    let commit = candidate;
    let kind: "fast-forward" | "merge" = "fast-forward";
    if (!(await within(head, candidate))) {
      const merged = await this.run(["merge-tree", "--write-tree", "--name-only", "--no-messages", head, candidate]);
      const lines = merged.stdout.split("\n").filter(Boolean);
      if (merged.code === 1) return refuse("conflict", "The commit conflicts with what has landed since the fork last pulled.", { paths: [...new Set(lines.slice(1))] });
      if (merged.code !== 0 || !SHA.test(lines[0] ?? "")) return refuse("conflict", "The commit is not built on the trunk as it is now, and this machine's git cannot merge it without a checkout.");
      const made = await this.run([...RUNNER, "commit-tree", lines[0]!, "-p", head, "-p", candidate, "-m", `Merge ${seat}'s landing ${n}${request.note ? `: ${request.note}` : ""}`]);
      if (made.code !== 0) return refuse("error", `The merge commit could not be made: ${lastLine(made.stderr)}.`);
      commit = made.stdout.trim();
      kind = "merge";
    }
    let check: { exit_code: number; ms: number } | undefined;
    if (this.options.check) {
      const now = this.options.now ?? Date.now;
      const started = now();
      const result = await this.options.check(commit, seat, n).catch((error: unknown) => ({ code: 1, output: error instanceof Error ? error.message : "the check could not be run" }));
      check = { exit_code: result.code, ms: now() - started };
      if (result.code !== 0) return refuse("check", "The landing check failed on the result.", { check: { ...check, output: result.output } });
    }
    // One landing at a time, so the trunk is where it was; if something else moved it, nothing lands.
    const moved = await this.run(["update-ref", "-m", `landing ${n} by ${seat}`, `refs/heads/${this.branch}`, commit, head]);
    if (moved.code !== 0) return refuse("error", `The trunk moved while the landing was being made: ${lastLine(moved.stderr)}.`);
    // The trunk's own files follow its branch; what a check left changed in them is not work.
    await this.run(["reset", "--hard", "--quiet", `refs/heads/${this.branch}`]);
    const KIND = { A: "new", D: "deleted" } as const;
    const files = (await this.run(["diff", "--name-status", "--no-renames", "-z", head, commit])).stdout.split("\0").filter(Boolean);
    const changed: LandedFile[] = [];
    for (let index = 0; index + 1 < files.length; index += 2) changed.push({ path: files[index + 1]!, kind: KIND[files[index] as "A" | "D"] ?? "changed" });
    return { landed: true, n, commit, candidate, kind, files: changed, ...(check ? { check } : {}) };
  }
}

// ---------------------------------------------------------------------------------------------
// In a seat's container: `sharednet land`

export interface LandDependencies {
  env: Record<string, string | undefined>;
  sleep?: (ms: number) => Promise<void>;
  git?: Git;
  /** How long to wait for the runner's answer. */
  waitMs?: number;
}

/**
 * `sharednet land "<what changed>"`: asks the runner to land the fork's last commit on the trunk,
 * and waits for the answer. A landing that is refused is an error, with what to do next.
 */
export async function requestLanding(note: string | undefined, dependencies: LandDependencies): Promise<Record<string, unknown>> {
  const directory = dependencies.env.SHAREDNET_LAND_DIR;
  if (!directory) throw localError("workspace_shared", "This run's workspace is one shared folder: every write is already everyone's, and there is nothing to land.");
  const fork = dependencies.env.SHAREDNET_FORK ?? "/workspace";
  const branch = dependencies.env.SHAREDNET_TRUNK_BRANCH ?? "main";
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms)));
  const git = (args: readonly string[]) => (dependencies.git ?? runGit)(args, { cwd: fork });
  const head = await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.code !== 0) throw localError("nothing_to_land", `Nothing is committed in ${fork}: commit your work, then land.`);
  const sha = head.stdout.trim();
  const uncommitted = (await git(["status", "--porcelain"])).stdout.split("\n").filter(Boolean).length;
  const left = uncommitted > 0 ? { uncommitted, uncommitted_note: `${uncommitted} ${uncommitted === 1 ? "file has" : "files have"} changes that are not committed: they are not part of this landing.` } : {};

  // A landing already asked for this commit and not answered yet: wait for that answer.
  const names = await readdir(directory).catch(() => [] as string[]);
  const numbers = names.flatMap((name) => { const n = /^(\d{1,6})\.request\.json$/.exec(name)?.[1]; return n === undefined ? [] : [Number(n)]; }).sort((a, b) => a - b);
  let n = -1;
  for (const number of numbers) {
    if (names.includes(`${number}.result.json`)) continue;
    const asked = await readFile(join(directory, `${number}.request.json`), "utf8").then((text) => (JSON.parse(text) as { sha?: string }).sha, () => undefined);
    if (asked === sha) n = number;
  }
  if (n === -1) {
    const ahead = (await git(["rev-list", "--count", sha, "--not", "--remotes=origin"])).stdout.trim();
    if (ahead === "0") {
      throw localError("nothing_to_land", `Your last commit (${short(sha)}) is already in the trunk as your fork last fetched it: there is nothing to land.${uncommitted > 0 ? ` ${uncommitted} ${uncommitted === 1 ? "file has" : "files have"} changes that are not committed: commit them first.` : ""}`);
    }
    n = (numbers.at(-1) ?? 0) + 1;
    const subject = note?.trim() || (await git(["log", "-1", "--format=%s", sha])).stdout.trim();
    const ref = `refs/sharednet/land/${n}`;
    const marked = await git(["update-ref", ref, sha]);
    // Everything the trunk already has, as the fork last fetched it, stays out of the bundle.
    const bundled = marked.code === 0 ? await git(["bundle", "create", "--quiet", join(directory, `${n}.bundle.tmp`), ref, "--not", "--remotes=origin"]) : marked;
    if (bundled.code !== 0) throw localError("landing_failed", `The landing could not be packed: ${lastLine(bundled.stderr) || "git refused"}.`);
    // The runner reads these as another user.
    await chmod(join(directory, `${n}.bundle.tmp`), 0o644);
    await rename(join(directory, `${n}.bundle.tmp`), join(directory, `${n}.bundle`));
    await writeFile(join(directory, `${n}.request.tmp`), `${JSON.stringify({ n, sha, note: subject.replace(/\s+/g, " ").slice(0, NOTE_LIMIT) })}\n`, { mode: 0o644 });
    await chmod(join(directory, `${n}.request.tmp`), 0o644);
    await rename(join(directory, `${n}.request.tmp`), join(directory, `${n}.request.json`));
  }

  const waitMs = dependencies.waitMs ?? LAND_WAIT_MS;
  let result: LandResult | null = null;
  for (let waited = 0; result === null; waited += 300) {
    result = await readFile(join(directory, `${n}.result.json`), "utf8").then((text) => JSON.parse(text) as LandResult, () => null);
    if (result !== null || waited >= waitMs) break;
    await sleep(300);
  }
  if (result === null) {
    throw localError("landing_pending", `Landing ${n} (${short(sha)}) is still with the runner: another landing is ahead of it, or its check is running. Run \`sharednet land\` again to wait for the answer.`);
  }
  if (result.landed) {
    // The fork learns where the trunk is now.
    await git(["fetch", "--quiet", "origin"]);
    return {
      landed: true,
      landing: n,
      commit: result.commit,
      trunk: branch,
      kind: result.kind,
      files: result.files.length,
      ...(result.kind === "merge" ? { note: "The trunk merged your commit with what had landed since you last pulled. Run `git pull` to have the rest in your fork." } : {}),
      ...left,
    };
  }
  if (result.reason === "conflict") {
    const paths = result.paths?.length ? `, in ${result.paths.slice(0, 12).join(", ")}${result.paths.length > 12 ? ` and ${result.paths.length - 12} more` : ""}` : "";
    throw localError("landing_conflict", `Not landed: your commit conflicts with what has landed on the trunk since you last pulled${paths}. Run \`git pull\` in ${fork}, resolve the conflicts, commit, and land again.`);
  }
  if (result.reason === "check") {
    throw localError("landing_check_failed", `Not landed: the landing check failed on the result (exit ${result.check?.exit_code ?? 1}). Fix it in your fork, commit, and land again. The check's last output:\n${result.check?.output ?? ""}`);
  }
  if (result.reason === "nothing") throw localError("nothing_to_land", `Not landed: ${result.detail}`);
  throw localError("landing_failed", `Not landed: ${result.detail}`);
}
