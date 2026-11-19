/**
 * The workspace as a participant: it notices that a file changed, works out which seats that
 * matters to, and tells them at a time they can use it (`--env-push`).
 *
 * The runner does all of it, with no model behind it:
 *
 *   observe   a scan of the workspace every few seconds finds files that changed, appeared or went
 *   attribute a change is by the seat whose turn showed an edit of that file, or else by the one
 *             seat that was in a turn; with several in a turn and no edit seen, the author is unknown
 *   interest  a seat's files are the workspace paths its turns have mentioned, as input or output
 *   push      a seat is told about a change, by someone else, to a file it has an interest in
 *             (`--env-audience affected`) or to any file (`all`)
 *
 * The levels of `--env-push` add up, each one a time at which a seat is told:
 *
 *   on-wake    with its next wake, whatever caused the wake
 *   on-event   also by an `[env]` line that names it, which wakes it when it is idle
 *   on-action  also inside its turn (Claude Code seats): an edit to a file that changed under it
 *              is held once, and other changes arrive after its next tool call
 *
 * Off by default. Every change and every delivery is logged in `environment.ndjson`.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { localError } from "../errors.ts";

export type EnvPush = "off" | "on-wake" | "on-event" | "on-action";
export type EnvAudience = "affected" | "all";
export interface EnvironmentModule { push: EnvPush; audience: EnvAudience }

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

// ---------------------------------------------------------------------------------------------
// Observing the workspace

export interface FileState { mtimeMs: number; size: number }
export type Snapshot = Map<string, FileState>;
export interface Change { path: string; kind: "changed" | "new" | "deleted" }

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

export function diffSnapshots(before: Snapshot, after: Snapshot): Change[] {
  const changes: Change[] = [];
  for (const [path, now] of after) {
    const was = before.get(path);
    if (!was) changes.push({ path, kind: "new" });
    else if (was.mtimeMs !== now.mtimeMs || was.size !== now.size) changes.push({ path, kind: "changed" });
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
export function pathsIn(raw: string, known: ReadonlySet<string>, mount = "/workspace", byEnding?: ReadonlyMap<string, string | null>): string[] {
  const found = new Set<string>();
  // A record is JSON: a line break inside a string is written \n, which would run into the next word.
  const line = raw.replace(/\\[nrt]/g, " ");
  for (const match of line.matchAll(TOKEN)) {
    const token = match[0];
    const at = match.index;
    const absolute = at > 0 && line[at - 1] === "/" ? `/${token}` : token;
    let hit: string | null = null;
    for (const candidate of [workspacePath(absolute, mount), workspacePath(token, mount)]) {
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

// ---------------------------------------------------------------------------------------------
// The environment's own state

export interface Note {
  id: string;
  seat: string;
  path: string;
  kind: Change["kind"];
  /** The author, or null when several seats were in a turn and none showed an edit. */
  by: string | null;
  candidates: string[];
  at: number;
  /** Why this seat: it edited the file, it only read it, or the audience is everyone. */
  interest: "edited" | "read" | "all";
  seenTurn: number | null;
}

export type Delivery = "wake" | "post" | "note" | "held-edit";

export interface EnvironmentOptions {
  audience: EnvAudience;
  /** A file a seat was told about is not announced to it again within this time. */
  repeatMs?: number;
  /** How far back a seat's own mention of a file counts as its own change, when the author is unknown. */
  ownMs?: number;
}

interface Seen { at: number; turn: number; edited: number | null }

/** More known files than this on one line of a turn's record make it a listing. */
export const LISTING = 8;

export class Environment {
  private readonly seen = new Map<string, Map<string, Seen>>();
  private readonly pending = new Map<string, Map<string, Note>>();
  private readonly told = new Map<string, number>();
  private known = new Set<string>();
  private byEnding = new Map<string, string | null>();
  private serial = 0;
  private readonly repeatMs: number;
  private readonly ownMs: number;
  private readonly seats: readonly string[];
  private readonly options: EnvironmentOptions;

  constructor(seats: readonly string[], options: EnvironmentOptions) {
    this.seats = seats;
    this.options = options;
    this.repeatMs = options.repeatMs ?? 60_000;
    this.ownMs = options.ownMs ?? 20_000;
    for (const seat of seats) { this.seen.set(seat, new Map()); this.pending.set(seat, new Map()); }
  }

  /** The files the workspace holds now; a seat's interest is counted only in these. */
  know(files: Iterable<string>): void {
    this.known = new Set(files);
    this.byEnding = endings(this.known);
  }

  /** One line of a seat's turn record: the files it mentions, and the ones it edits. */
  sawLine(seat: string, turn: number, line: string, at: number): void {
    const mine = this.seen.get(seat);
    if (!mine) return;
    const edits = new Set(editsIn(line));
    // A line that names many files is a listing or a search, not a reading of each of them.
    const mentioned = pathsIn(line, this.known, "/workspace", this.byEnding);
    for (const path of new Set([...(mentioned.length > LISTING ? [] : mentioned), ...edits])) {
      const before = mine.get(path);
      mine.set(path, { at, turn, edited: edits.has(path) ? at : before?.edited ?? null });
    }
  }

  /** The files a seat has an interest in, with the turn that last showed each. */
  interest(seat: string): Array<{ path: string; turn: number; edited: boolean }> {
    return [...(this.seen.get(seat) ?? [])].map(([path, seen]) => ({ path, turn: seen.turn, edited: seen.edited !== null }));
  }

  /** Changes found by a scan: who made each, and who is told. Returns the notes this adds. */
  observe(changes: readonly Change[], busy: ReadonlySet<string>, since: number, at: number): Note[] {
    const added: Note[] = [];
    for (const change of changes) {
      const editors = this.seats.filter((seat) => {
        const edited = this.seen.get(seat)?.get(change.path)?.edited ?? null;
        return edited !== null && edited >= since - this.ownMs;
      });
      const candidates = editors.length > 0 ? editors : this.seats.filter((seat) => busy.has(seat));
      const by = candidates.length === 1 ? candidates[0]! : null;
      for (const seat of this.seats) {
        if (seat === by) continue;
        const seen = this.seen.get(seat)!.get(change.path);
        // With the author unknown, a seat that was just working with the file is taken to be the author.
        if (by === null && candidates.includes(seat) && seen && seen.at >= since - this.ownMs) continue;
        if (this.options.audience === "affected" && !seen) continue;
        const last = this.told.get(`${seat}\n${change.path}`);
        if (last !== undefined && at - last < this.repeatMs) continue;
        const queue = this.pending.get(seat)!;
        const earlier = queue.get(change.path);
        const note: Note = {
          id: earlier?.id ?? `n${(this.serial += 1)}`,
          seat,
          path: change.path,
          kind: change.kind,
          by: earlier && earlier.by !== by ? null : by,
          candidates: [...new Set([...(earlier?.candidates ?? []), ...candidates])].filter((name) => name !== seat),
          at,
          interest: seen ? (seen.edited !== null ? "edited" : "read") : "all",
          seenTurn: seen?.turn ?? null,
        };
        queue.set(change.path, note);
        if (!earlier) added.push(note);
      }
    }
    return added;
  }

  /** What a seat has not been told yet, oldest first. */
  waiting(seat: string): Note[] {
    return [...(this.pending.get(seat)?.values() ?? [])].sort((a, b) => a.at - b.at || a.path.localeCompare(b.path));
  }

  /** The notes are with the seat now. */
  delivered(seat: string, ids: readonly string[], at: number): Note[] {
    const queue = this.pending.get(seat);
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
  const who = note.by ?? (note.candidates.length > 0 ? `${note.candidates.join(" or ")} (in a turn at the time)` : "no seat in a turn (a check, a probe, or something a seat left running)");
  const mine = note.interest === "edited" ? `you edited it in turn ${note.seenTurn}` : note.interest === "read" ? `you last had it in turn ${note.seenTurn}` : null;
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
  return notes.map((note) => ({ id: note.id, file: `${mount}/${note.path}`, at: note.at, text: describeNote(note, null) }));
}

// ---------------------------------------------------------------------------------------------
// Inside a Claude Code seat's turn (on-action)

export const ENV_HOOK_DIR = "/tmp/sharednet-env";
export const ENV_HOOK_PATH = "/usr/local/lib/sharednet-env-hook.cjs";

/**
 * Claude Code runs this before and after each tool call. Before an edit to a file that changed
 * under the seat, it holds the edit once and says who changed the file. After any tool call, it
 * hands over the other changes waiting for the seat. Each note is given once.
 */
export const ENV_HOOK = String.raw`
const fs = require('node:fs');
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
const target = input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path);
if (event === 'PreToolUse') {
  if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(input.tool_name) || !target) process.exit(0);
  const mine = waiting.filter((note) => note.file === target);
  if (mine.length === 0) process.exit(0);
  give(mine, 'held-edit');
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'SharedNet workspace: ' + mine.map((note) => note.text).join('; ') + '. This edit was held once and nothing was written. Read the file as it is now, then repeat or revise the edit.' } }));
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
  PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: `node ${ENV_HOOK_PATH}` }] }],
  PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `node ${ENV_HOOK_PATH}` }] }],
};
