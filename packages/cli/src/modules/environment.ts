/**
 * The workspace as a participant: it notices that a file changed, works out which seats that
 * matters to, and tells them at a time they can use it (`--env-push`).
 *
 * The runner does all of it, with no model behind it:
 *
 *   observe   a scan of the workspace every few seconds finds files that changed, appeared or went,
 *             and the time each was written
 *   interest  a seat's files are the workspace paths its turns have named, in a command or in what
 *             a command printed, read from where the seat's shell was standing at the time
 *   attribute a change is by the seat that had a command running when the file was written; with
 *             several running, by the one whose command named the file, or else the one whose
 *             shell stood in a folder that holds it (git and build scripts name no files);
 *             otherwise the author is unknown and the note names the seats that were working
 *   push      a seat is told about a change, by someone else, to a file it has an interest in
 *             (`--env-audience affected`) or to any file (`all`)
 *   copies    a folder mounted beside the workspace (`--env-watch`) is shared: where each seat
 *             works on its own copy of the files and lands into the shared one, a seat is told
 *             when a shared file changes and no longer matches the copy it holds
 *
 * The levels of `--env-push` add up, each one a time at which a seat is told:
 *
 *   on-wake    with its next wake, whatever caused the wake
 *   on-event   also by an `[env]` line that names it, which wakes it when it is idle
 *   on-action  also inside its turn (Claude Code seats): a write to a file that changed under it
 *              is held once, and other changes arrive after its next tool call
 *
 * Off by default. Every change and every delivery is logged in `environment.ndjson`.
 */
import { readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { localError } from "../errors.ts";

export type EnvPush = "off" | "on-wake" | "on-event" | "on-action";
export type EnvAudience = "affected" | "all";
/** A folder the environment watches besides the workspace: where it is on this machine, and where the seats see it. */
export interface WatchRoot { host: string; mount: string }
export interface EnvironmentModule { push: EnvPush; audience: EnvAudience; watch: WatchRoot[] }

export const ENV_MARK = "[env]";
export const ENV_HELP = `The workspace itself tells you when a file you have read or changed is changed by someone else: with a wake, or in a line that starts with ${ENV_MARK}, or inside your turn. No model writes these; they come from the files. When one names a file you rely on, look at the file again before you build on what you remember of it.`;

export function parseEnvPush(raw: string | undefined): EnvPush {
  if (raw === undefined) return "off";
  if (raw === "off" || raw === "on-wake" || raw === "on-event" || raw === "on-action") return raw;
  throw localError("invalid_arguments", "--env-push is off, on-wake, on-event or on-action.");
}

export function parseEnvAudience(raw: string | undefined, push: EnvPush): EnvAudience {
  if (raw === undefined) return "affected";
  if (push === "off") throw localError("invalid_arguments", "--env-audience needs --env-push.");
  if (raw === "affected" || raw === "all") return raw;
  throw localError("invalid_arguments", "--env-audience is affected or all.");
}

/** `--env-watch <folder>:<path in the containers>`, for a folder that is mounted into the seats beside the workspace. */
export function parseEnvWatch(raw: readonly string[], push: EnvPush): WatchRoot[] {
  if (raw.length > 0 && push === "off") throw localError("invalid_arguments", "--env-watch needs --env-push.");
  return raw.map((item) => {
    const cut = item.lastIndexOf(":/");
    const host = cut === -1 ? "" : item.slice(0, cut);
    const mount = cut === -1 ? "" : item.slice(cut + 1).replace(/\/+$/, "");
    if (!host || !mount) throw localError("invalid_arguments", "--env-watch is <folder>:<absolute path in the containers>, such as ./best:/workspace/best.");
    return { host, mount };
  });
}

// ---------------------------------------------------------------------------------------------
// Observing the workspace

export interface FileState { mtimeMs: number; size: number }
export type Snapshot = Map<string, FileState>;
/** A file that is not as it was at the last scan; `mtimeMs` is when it was written, for one that is still there. */
export interface Change { path: string; kind: "changed" | "new" | "deleted"; mtimeMs?: number }

const SKIPPED = new Set(["node_modules", "__pycache__", "target", "dist", "build"]);
/** What a compiler leaves behind: it changes with every build and nobody reads it. */
const ARTIFACT = /\.(?:o|a|so|obj|pyc|class|gch|lo|la)$/;
export const SNAPSHOT_LIMIT = 20_000;

/** Every file under root with its time and size; dot folders, build folders and compiler output are left out. */
export async function snapshot(root: string, limit = SNAPSHOT_LIMIT): Promise<Snapshot> {
  const files: Snapshot = new Map();
  const walk = async (prefix: string): Promise<void> => {
    const items = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (files.size >= limit) return;
      if (item.name.startsWith(".") || SKIPPED.has(item.name)) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(path);
      else if (item.isFile() && !ARTIFACT.test(item.name)) {
        const info = await stat(join(root, path)).catch(() => null);
        if (info) files.set(path, { mtimeMs: info.mtimeMs, size: info.size });
      }
    }
  };
  await walk("");
  return files;
}

/** The name a file goes by: relative to the workspace when the seats see it there, else its whole path in the containers. */
export function fileKey(mount: string, relative: string, workspace = "/workspace"): string {
  if (mount === workspace) return relative;
  return mount.startsWith(`${workspace}/`) ? `${mount.slice(workspace.length + 1)}/${relative}` : `${mount}/${relative}`;
}

/** Where the seats see a file. */
export function containerPath(key: string, workspace = "/workspace"): string {
  return key.startsWith("/") ? key : `${workspace}/${key}`;
}

/** One snapshot of every watched folder, each file under the name the seats know it by. */
export async function snapshotRoots(roots: readonly WatchRoot[], limit = SNAPSHOT_LIMIT): Promise<Snapshot> {
  const all: Snapshot = new Map();
  for (const root of roots) {
    for (const [relative, state] of await snapshot(root.host, limit - all.size)) all.set(fileKey(root.mount, relative), state);
  }
  return all;
}

/** Where a watched file is on this machine, or null for a name no watched folder holds. */
export function hostPath(roots: readonly WatchRoot[], key: string, workspace = "/workspace"): string | null {
  const where = containerPath(key, workspace);
  const root = [...roots].sort((a, b) => b.mount.length - a.mount.length).find((candidate) => where.startsWith(`${candidate.mount}/`));
  return root ? join(root.host, where.slice(root.mount.length + 1)) : null;
}

/** Whether two watched files hold the same bytes now. Files over 2 MB, and any that cannot be read, count as different. */
export function sameBytes(roots: readonly WatchRoot[], a: string, b: string): boolean {
  const one = hostPath(roots, a);
  const other = hostPath(roots, b);
  if (one === null || other === null) return false;
  try {
    const size = statSync(one).size;
    if (size !== statSync(other).size || size > 2_000_000) return false;
    return readFileSync(one).equals(readFileSync(other));
  } catch {
    return false;
  }
}

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, now] of after) {
    const was = before.get(path);
    if (!was) changes.push({ path, kind: "new", mtimeMs: now.mtimeMs });
    else if (was.mtimeMs !== now.mtimeMs || was.size !== now.size) changes.push({ path, kind: "changed", mtimeMs: now.mtimeMs });
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push({ path, kind: "deleted" });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------------------------
// What a seat's turn shows

const TOKEN = /[A-Za-z0-9_@+][A-Za-z0-9_@+.\/-]*/g;
const EDIT_TOOL = /"name"\s*:\s*"(?:Edit|Write|MultiEdit|NotebookEdit)"/;
const FILE_PATH = /"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const PATCH_FILE = /\*\*\* (?:Update|Add|Delete) File: ([^\s"\\]+)/g;

/** A path as the workspace knows it: relative, without the container's mount point. */
export function workspacePath(raw: string, mount = "/workspace"): string {
  let path = raw.trim();
  if (path.startsWith(`${mount}/`)) path = path.slice(mount.length + 1);
  while (path.startsWith("./")) path = path.slice(2);
  return path.replace(/[.,:;)\]'"]+$/, "");
}

/**
 * Every way a known file can be written from a folder inside the workspace: `src/a.c` and `a.c`
 * for `project/src/a.c`. An ending that two files share names neither, and a bare name counts
 * only when it has an extension (a file called `test` is not every mention of the word).
 */
export function endings(known: Iterable<string>): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const path of known) {
    for (let cut = path.indexOf("/"); cut !== -1; cut = path.indexOf("/", cut + 1)) {
      const ending = path.slice(cut + 1);
      if (!ending.includes("/") && !ending.includes(".")) continue;
      index.set(ending, index.has(ending) ? null : path);
    }
  }
  return index;
}

/** The known workspace files one line of a turn's record mentions. */
export function pathsIn(raw: string, known: ReadonlySet<string>, mount = "/workspace", byEnding?: ReadonlyMap<string, string | null>, cwd?: string): string[] {
  const found = new Set<string>();
  // A record is JSON: a line break inside a string is written \n, which would run into the next word.
  const line = raw.replace(/\\[nrt]/g, " ");
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index;
    const absolute = at > 0 && line[at - 1] === "/" ? `/${token}` : token;
    let hit: string | null = null;
    // As written from the root of the file system, from where the seat's shell stands, or from the workspace.
    const fromCwd = cwd && absolute === token ? [workspacePath(posix.normalize(posix.join(cwd, workspacePath(token, mount))), mount)] : [];
    for (const candidate of [workspacePath(absolute, mount), ...fromCwd, workspacePath(token, mount)]) {
      if (known.has(candidate)) { hit = candidate; break; }
    }
    // Written from a folder inside the workspace: the one known file that ends this way.
    if (hit === null && byEnding) hit = byEnding.get(workspacePath(token, mount)) ?? null;
    if (hit !== null) found.add(hit);
  }
  return [...found];
}

/** The files one line of a turn's record edits: a Claude Code edit tool's file, or a patch's files. */
export function editsIn(line: string, mount = "/workspace"): string[] {
  const found = new Set<string>();
  if (EDIT_TOOL.test(line)) for (const match of line.matchAll(FILE_PATH)) found.add(workspacePath(match[1]!.replace(/\\(.)/g, "$1"), mount));
  for (const match of line.matchAll(PATCH_FILE)) found.add(workspacePath(match[1]!, mount));
  return [...found];
}

/** What one line of a turn's record means to the environment. */
export interface LineReading {
  /** The tool calls this line starts, each as its text: a command, or a tool's input. */
  starts: string[];
  /** The line carries a tool's result: the calls in flight are over. */
  ends: boolean;
  /** Each command starts in the session's folder again (Codex); Claude Code's shell stays where the last one left it. */
  fresh: boolean;
}

const QUIET: LineReading = Object.freeze({ starts: Object.freeze([]) as unknown as string[], ends: false, fresh: false });

/** Reads a line of Claude Code's or Codex's turn record; any other line starts and ends nothing. */
export function readLine(line: string): LineReading {
  if (!line.startsWith("{")) return QUIET;
  let record: { type?: string; message?: { content?: unknown }; item?: { type?: string; command?: unknown } };
  try { record = JSON.parse(line); } catch { return QUIET; }
  const content = Array.isArray(record.message?.content) ? (record.message!.content as Array<{ type?: string; name?: string; input?: { command?: unknown } }>) : [];
  if (record.type === "assistant") {
    const starts = content.filter((part) => part?.type === "tool_use").map((part) => (typeof part.input?.command === "string" ? part.input.command : JSON.stringify(part.input ?? {})));
    return starts.length > 0 ? { starts, ends: false, fresh: false } : QUIET;
  }
  if (record.type === "user") return content.some((part) => part?.type === "tool_result") ? { starts: [], ends: true, fresh: false } : QUIET;
  if (record.type === "item.started" && typeof record.item?.command === "string") return { starts: [record.item.command], ends: false, fresh: true };
  if (record.type === "item.completed" && record.item?.type !== "agent_message" && record.item?.type !== "reasoning") return { starts: [], ends: true, fresh: true };
  return QUIET;
}

const CD = /(?:^|&&|\|\||;|\n|\(|\{)\s*cd\s+(?:--\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)<>]+))/g;

/** Where a shell stands after a command, from where it stood: each `cd` in the command, read before any here-document. */
export function folderAfter(cwd: string, command: string): string {
  const heredoc = command.indexOf("<<");
  let now = cwd;
  for (const match of (heredoc === -1 ? command : command.slice(0, heredoc)).matchAll(CD)) {
    const target = match[1] ?? match[2] ?? match[3]!;
    if (target === "-" || target.startsWith("~") || /[$`*?]/.test(target)) continue;
    now = posix.normalize(target.startsWith("/") ? target : posix.join(now, target));
    if (now.length > 1 && now.endsWith("/")) now = now.slice(0, -1);
  }
  return now;
}

// ---------------------------------------------------------------------------------------------
// The environment's own state

export interface Note {
  id: string;
  seat: string;
  path: string;
  kind: Change["kind"];
  /** The author, or null when it cannot be told apart from the other seats that were working. */
  by: string | null;
  candidates: string[];
  at: number;
  /** Why this seat: it changed the file itself earlier, it only read it, or the audience is everyone. */
  interest: "edited" | "read" | "all";
  seenTurn: number | null;
  /** The seat's own copy of a shared file, when that copy is why it is told. */
  copy?: string;
}

export type Delivery = "wake" | "post" | "note" | "held-edit";

export interface EnvironmentOptions {
  audience: EnvAudience;
  /** A file a seat was told about is not announced to it again within this time. */
  repeatMs?: number;
  /** How far back a seat's own mention of a file counts as its own change, when the author is unknown. */
  ownMs?: number;
  /** A file a seat only read stops being its concern after this many of its turns without naming it. */
  interestTurns?: number;
  /** Where the seats see the workspace, and where each seat's shell starts. */
  mount?: string;
  /** The shared folders, as the start of their files' names (`best/`): a seat may hold its own copy of a file in one. */
  shared?: readonly string[];
  /** Whether two files hold the same bytes now; left out, a copy always counts as different. */
  identical?: (a: string, b: string) => boolean;
}

interface Seen { at: number; turn: number; edited: number | null }
interface Span { start: number; end: number | null }
interface Call extends Span { paths: Set<string>; cwd: string }
interface SeatState { seen: Map<string, Seen>; pending: Map<string, Note>; calls: Call[]; turns: Span[]; turn: number; cwd: string }

/** More known files than this in what a command printed make it a listing, not a reading of each. */
export const LISTING = 8;
/** How far a file's written time and a command's times, taken on two clocks' readings, may be apart. */
export const CLOCK_SLACK_MS = 2_000;
const KEPT_CALLS = 400;

export class Environment {
  private readonly state = new Map<string, SeatState>();
  private readonly told = new Map<string, number>();
  private known = new Set<string>();
  private byEnding = new Map<string, string | null>();
  private serial = 0;
  private readonly repeatMs: number;
  private readonly ownMs: number;
  private readonly interestTurns: number;
  private readonly mount: string;
  private readonly seats: readonly string[];
  private readonly options: EnvironmentOptions;

  constructor(seats: readonly string[], options: EnvironmentOptions) {
    this.seats = seats;
    this.options = options;
    this.repeatMs = options.repeatMs ?? 60_000;
    this.ownMs = options.ownMs ?? 20_000;
    this.interestTurns = options.interestTurns ?? 6;
    this.mount = options.mount ?? "/workspace";
    for (const seat of seats) this.state.set(seat, { seen: new Map(), pending: new Map(), calls: [], turns: [], turn: 0, cwd: this.mount });
  }

  /** The files the workspace holds now; a seat's interest is counted only in these. */
  know(files: Iterable<string>): void {
    this.known = new Set(files);
    this.byEnding = endings(this.known);
  }

  /** A seat's turn begins: it is working from now on. */
  turnStarted(seat: string, turn: number, at: number): void {
    const mine = this.state.get(seat);
    if (!mine) return;
    mine.turn = Math.max(mine.turn, turn);
    if (mine.turns.at(-1)?.end !== null) mine.turns.push({ start: at, end: null });
  }

  /** A seat's turn is over, and so is any command it left without a result. */
  turnEnded(seat: string, at: number): void {
    const mine = this.state.get(seat);
    if (!mine) return;
    for (const span of [...mine.turns, ...mine.calls]) if (span.end === null) span.end = at;
  }

  /** One line of a seat's turn record: the commands it starts or ends, and the files it names. */
  sawLine(seat: string, turn: number, line: string, at: number): void {
    const mine = this.state.get(seat);
    if (!mine) return;
    this.turnStarted(seat, turn, at);
    const reading = readLine(line);
    if (reading.ends) for (const call of mine.calls) if (call.end === null) call.end = at;
    const named = new Set<string>();
    for (const command of reading.starts) {
      // A file is named from where the shell stands once the command's own `cd`s have run.
      const cwd = folderAfter(reading.fresh ? this.mount : mine.cwd, command);
      if (!reading.fresh) mine.cwd = cwd;
      const paths = new Set(pathsIn(command, this.known, this.mount, this.byEnding, cwd));
      mine.calls.push({ start: at, end: null, paths, cwd });
      for (const path of paths) named.add(path);
    }
    if (mine.calls.length > KEPT_CALLS) mine.calls.splice(0, mine.calls.length - KEPT_CALLS);
    const edits = new Set(editsIn(line, this.mount));
    if (reading.starts.length === 0) {
      // What a command printed, or a line of another kind: many files on it are a listing.
      const mentioned = pathsIn(line, this.known, this.mount, this.byEnding, mine.cwd);
      if (mentioned.length <= LISTING) for (const path of mentioned) named.add(path);
    }
    for (const path of new Set([...named, ...edits])) {
      const before = mine.seen.get(path);
      mine.seen.set(path, { at, turn, edited: edits.has(path) ? at : before?.edited ?? null });
    }
  }

  /** The files a seat has an interest in, with the turn that last showed each. */
  interest(seat: string): Array<{ path: string; turn: number; edited: boolean }> {
    return [...(this.state.get(seat)?.seen ?? [])].map(([path, seen]) => ({ path, turn: seen.turn, edited: seen.edited !== null }));
  }

  /** Where a seat's shell stands, as far as its commands have shown. */
  folder(seat: string): string | null { return this.state.get(seat)?.cwd ?? null; }

  /** Changes found by a scan, since the scan before it: who made each, and who is told. Returns the notes this adds. */
  observe(changes: readonly Change[], since: number, at: number): Note[] {
    const added: Note[] = [];
    for (const change of changes) {
      // When the file was written; one that is gone went at some time since the last scan.
      const from = (change.mtimeMs ?? since) - CLOCK_SLACK_MS;
      const to = (change.mtimeMs ?? at) + CLOCK_SLACK_MS;
      const then = (span: Span) => span.start <= to && (span.end ?? Number.POSITIVE_INFINITY) >= from;
      const having = (pick: (state: SeatState) => boolean) => this.seats.filter((seat) => pick(this.state.get(seat)!));
      const naming = having((state) => state.calls.some((call) => then(call) && call.paths.has(change.path)));
      const running = having((state) => state.calls.some(then));
      const working = having((state) => state.turns.some(then));
      // A command that names no file (git, a build script) changes what is under the folder it runs in:
      // the seat whose shell stood deepest in a folder that holds the file. The workspace's own root holds everything and says nothing.
      const where = containerPath(change.path, this.mount);
      const depth = (state: SeatState) => Math.max(-1, ...state.calls.filter((call) => then(call) && call.cwd !== this.mount && where.startsWith(`${call.cwd}/`)).map((call) => call.cwd.split("/").length));
      const deepest = Math.max(-1, ...running.map((seat) => depth(this.state.get(seat)!)));
      const inside = deepest === -1 ? [] : running.filter((seat) => depth(this.state.get(seat)!) === deepest);
      const candidates = naming.length > 0 ? naming : inside.length > 0 ? inside : running.length > 0 ? running : working;
      const by = candidates.length === 1 ? candidates[0]! : null;
      if (by !== null) {
        // The author has made the file its own: it is told when someone else changes it later.
        const own = this.state.get(by)!;
        own.seen.set(change.path, { at: own.seen.get(change.path)?.at ?? at, turn: own.seen.get(change.path)?.turn ?? own.turn, edited: change.mtimeMs ?? at });
      }
      const sharedRoot = (this.options.shared ?? []).find((prefix) => change.path.startsWith(prefix));
      for (const seat of this.seats) {
        if (seat === by) continue;
        const mine = this.state.get(seat)!;
        const lasting = (seen: Seen | undefined): seen is Seen => seen !== undefined && (seen.edited !== null || mine.turn - seen.turn <= this.interestTurns);
        let seen = mine.seen.get(change.path);
        // With the author unknown, a seat whose command named the file or ran in its folder, or that was just working with it, is taken to be the author.
        if (by === null && candidates.includes(seat) && (naming.includes(seat) || inside.includes(seat) || (seen !== undefined && seen.at >= from - this.ownMs))) continue;
        let copy: string | undefined;
        if (!lasting(seen) && sharedRoot !== undefined) {
          // The seat's own copy of the shared file: the same path under another folder, the one it had last.
          const ending = `/${change.path.slice(sharedRoot.length)}`;
          for (const [path, held] of mine.seen) {
            if (path === change.path || path.startsWith(sharedRoot) || !`/${path}`.endsWith(ending) || !lasting(held)) continue;
            if (copy === undefined || held.at > mine.seen.get(copy)!.at) copy = path;
          }
          if (copy !== undefined && change.kind !== "deleted" && this.options.identical?.(change.path, copy)) copy = undefined;
          if (copy !== undefined) seen = mine.seen.get(copy);
        }
        const interested = lasting(seen);
        if (this.options.audience === "affected" && !interested) continue;
        const last = this.told.get(`${seat}\n${change.path}`);
        if (last !== undefined && at - last < this.repeatMs) continue;
        const earlier = mine.pending.get(change.path);
        const note: Note = {
          id: earlier?.id ?? `n${(this.serial += 1)}`,
          seat,
          path: change.path,
          kind: change.kind,
          by: earlier && earlier.by !== by ? null : by,
          candidates: [...new Set([...(earlier?.candidates ?? []), ...candidates])].filter((name) => name !== seat),
          at: change.mtimeMs ?? at,
          interest: interested ? (seen!.edited !== null ? "edited" : "read") : "all",
          seenTurn: interested ? seen!.turn : null,
          ...(copy !== undefined ? { copy } : {}),
        };
        mine.pending.set(change.path, note);
        if (!earlier) added.push(note);
      }
    }
    return added;
  }

  /** What a seat has not been told yet, oldest first. */
  waiting(seat: string): Note[] {
    return [...(this.state.get(seat)?.pending.values() ?? [])].sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  }

  /** The notes are with the seat now. */
  delivered(seat: string, ids: readonly string[], at: number): Note[] {
    const queue = this.state.get(seat)?.pending;
    if (!queue) return [];
    const gone: Note[] = [];
    for (const note of [...queue.values()]) {
      if (!ids.includes(note.id)) continue;
      queue.delete(note.path);
      this.told.set(`${seat}\n${note.path}`, at);
      gone.push(note);
    }
    return gone;
  }
}

// ---------------------------------------------------------------------------------------------
// What a seat is told

const ago = (ms: number) => (ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : `${Math.round(ms / 60_000)} min ago`);
const VERB = { changed: "changed", new: "is new", deleted: "was deleted" } as const;

/** One change, in one sentence, for the seat it goes to. With now left out, the age is the mark {ago}. */
export function describeNote(note: Note, now: number | null): string {
  const who = note.by ?? (note.candidates.length > 0 ? `${note.candidates.join(" or ")} (working at the time)` : "no seat that was working (a check, a probe, or something a seat left running)");
  const had = note.interest === "edited" ? `you edited in turn ${note.seenTurn}` : `you last had in turn ${note.seenTurn}`;
  const mine = note.copy !== undefined ? `it no longer matches your copy ${note.copy}, which ${had}`
    : note.interest === "edited" ? `you edited it in turn ${note.seenTurn}` : note.interest === "read" ? `you last had it in turn ${note.seenTurn}` : null;
  return `${note.path} ${VERB[note.kind]} ${now === null ? "{ago}" : ago(now - note.at)}, by ${who}${mine ? `; ${mine}` : ""}`;
}

export const NOTE_LIMIT = 12;

/** The part of a wake that says what changed under the seat, or null when nothing did. */
export function renderNotes(notes: readonly Note[], now: number): string | null {
  if (notes.length === 0) return null;
  const shown = notes.slice(0, NOTE_LIMIT).map((note) => `- ${describeNote(note, now)}`);
  const rest = notes.length > NOTE_LIMIT ? [`- and ${notes.length - NOTE_LIMIT} more files`] : [];
  return ["Changed in the workspace by others since you last saw these files:", ...shown, ...rest].join("\n");
}

/** The Room line that tells one seat, and wakes it when it is idle. */
export function envMessage(seat: string, notes: readonly Note[], now: number, maxChars = 1800): string {
  const shown = notes.slice(0, NOTE_LIMIT).map((note) => describeNote(note, now));
  const rest = notes.length > NOTE_LIMIT ? [`and ${notes.length - NOTE_LIMIT} more files`] : [];
  const body = [...shown, ...rest].join("; ");
  return `@${seat} ${ENV_MARK} ${body.length > maxChars ? `${body.slice(0, maxChars - 3)}...` : body}`;
}

/** An [env] line that names another seat: it is for that seat alone and wakes nobody else. */
export function envLineForAnother(content: string, seat: string): boolean {
  const named = /^@(\S+) \[env\] /.exec(content);
  return named !== null && named[1] !== seat;
}

/** What the hook in a seat's container reads: the notes still waiting. The hook fills in each one's age when it gives it. */
export function hookNotes(notes: readonly Note[], mount = "/workspace"): Array<{ id: string; file: string; at: number; text: string }> {
  return notes.map((note) => ({ id: note.id, file: containerPath(note.path, mount), at: note.at, text: describeNote(note, null) }));
}

// ---------------------------------------------------------------------------------------------
// Inside a Claude Code seat's turn (on-action)

export const ENV_HOOK_DIR = "/tmp/sharednet-env";
export const ENV_HOOK_PATH = "/usr/local/lib/sharednet-env-hook.cjs";

/**
 * Claude Code runs this before and after each tool call. Before a write to a file that changed
 * under the seat (an edit tool on it, or a shell command that names it and writes), it holds the
 * call once and says who changed the file. After any tool call, it hands over the other changes
 * waiting for the seat. Each note is given once.
 */
export const ENV_HOOK = String.raw`
const fs = require('node:fs');
const path = require('node:path').posix;
const dir = process.env.SHAREDNET_ENV_DIR;
if (!dir) process.exit(0);
let input, pending;
try { input = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { process.exit(0); }
try { pending = JSON.parse(fs.readFileSync(dir + '/pending.json', 'utf8')); } catch { process.exit(0); }
let done = new Set();
try { done = new Set(fs.readFileSync(dir + '/delivered.ndjson', 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).id)); } catch {}
const age = (ms) => (ms < 90000 ? Math.max(1, Math.round(ms / 1000)) + ' s ago' : Math.round(ms / 60000) + ' min ago');
const waiting = pending.filter((note) => !done.has(note.id)).map((note) => ({ ...note, text: String(note.text).replace('{ago}', age(Date.now() - note.at)) }));
if (waiting.length === 0) process.exit(0);
const give = (notes, how) => fs.appendFileSync(dir + '/delivered.ndjson', notes.map((note) => JSON.stringify({ id: note.id, how, at: new Date().toISOString() }) + '\n').join(''));
const event = input.hook_event_name;
const tool = input.tool_input || {};
// A shell command writes when it redirects into a file, edits in place, moves or removes, or has git rewrite the tree.
const WRITES = /(^|[^0-9&>])>{1,2}(?![&>])|\btee\b|\bsed\s+(-[A-Za-z]*i|--in-place)|\bperl\s+-[A-Za-z]*i|\b(mv|cp|rm|patch|truncate|install)\s|\bgit\s+(apply|am|checkout|restore|reset|stash|merge|rebase|pull|cherry-pick|revert|clean)\b/;
const CD = /(?:^|&&|\|\||;|\n|\(|\{)\s*cd\s+(?:--\s+)?(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;&|)<>]+))/g;
function named(command, cwd) {
  const heredoc = command.indexOf('<<');
  let now = cwd;
  for (const m of (heredoc === -1 ? command : command.slice(0, heredoc)).matchAll(CD)) {
    const target = m[1] || m[2] || m[3];
    if (target === '-' || target.startsWith('~') || /[$\x60*?]/.test(target)) continue;
    now = path.normalize(target.startsWith('/') ? target : path.join(now, target));
  }
  const files = new Set();
  for (const m of command.matchAll(/[A-Za-z0-9_@+.\/-]+/g)) {
    const token = m[0].replace(/[.,:;]+$/, '');
    if (!token) continue;
    files.add(path.normalize(token.startsWith('/') ? token : path.join(now, token)));
  }
  return files;
}
if (event === 'PreToolUse') {
  let mine = [];
  let what = 'edit';
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name)) {
    const target = tool.file_path || tool.notebook_path;
    mine = target ? waiting.filter((note) => note.file === target) : [];
  } else if (input.tool_name === 'Bash' && typeof tool.command === 'string' && WRITES.test(tool.command)) {
    const files = named(tool.command, typeof input.cwd === 'string' && input.cwd ? input.cwd : '/workspace');
    mine = waiting.filter((note) => files.has(note.file));
    what = 'command';
  }
  if (mine.length === 0) process.exit(0);
  give(mine, 'held-edit');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'SharedNet workspace: ' + mine.map((note) => note.text).join('; ') + '. This ' + what + ' was held once and nothing was written. Look at the file as it is now, then repeat or revise the ' + what + '.' } }));
  process.exit(0);
}
if (event === 'PostToolUse') {
  give(waiting, 'note');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'SharedNet workspace, changed by others while you work: ' + waiting.map((note) => note.text).join('; ') + '. Look at a file again before you build on what you remember of it.' } }));
}
`;

/** How often the workspace is scanned, how long a change rests before an idle seat is told, and the least time between two [env] lines to one seat. */
export const ENV_SCAN_MS = 5_000;
export const ENV_SETTLE_MS = 15_000;
export const ENV_POST_GAP_MS = 120_000;

export const ENV_HOOKS = {
  PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [{ type: "command", command: `node ${ENV_HOOK_PATH}` }] }],
  PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${ENV_HOOK_PATH}` }] }],
};
