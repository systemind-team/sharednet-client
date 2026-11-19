/**
 * Module slot 1, state (systems abstractions): what a run knows about who does what, beyond the
 * Room's prose. Two opt-in pieces on top of the board's title tasks (board-controls.ts):
 *
 *  - A duplicate judge for claims (`--task-judge lexical`). A claim whose title is close to a task
 *    someone else holds is refused, with that task and its owner named, until the claimant either
 *    takes other work or says how its own differs (`task claim "<title>" --distinct "<how>"`).
 *    Exact titles were already exclusive: the first claim on the board wins.
 *  - The activity view (`--activity-view`). Every wake carries who is in a turn, who is idle and
 *    who holds which task, from the runner's own record and the task acts, not from what anyone
 *    said about themselves.
 *
 * Both are off by default: without the options, `goal run` and `task claim` behave as before.
 */
import type { Task } from "../board-controls.ts";
import { localError } from "../errors.ts";

export type TaskJudge = "off" | "lexical";

export function parseTaskJudge(raw: string | undefined): TaskJudge {
  if (raw === undefined || raw === "off") return "off";
  if (raw === "lexical") return "lexical";
  throw localError("invalid_arguments", "--task-judge is off or lexical.");
}

// Words that say nothing about which part of the work a title means.
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "by", "from", "at", "as", "is", "are", "be",
  "this", "that", "it", "its", "into", "via", "per", "all", "add", "implement", "support", "make", "fix", "handle",
  "write", "new", "work", "task", "part", "line", "do", "build", "basic", "initial", "first", "more", "some",
]);

/** A title's content words, lower-cased and with plural and verb endings taken off. */
export function titleTerms(title: string): Set<string> {
  const terms = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    const stem = raw.length > 4 ? raw.replace(/(ing|ed|es|s)$/u, "") : raw;
    terms.add(stem || raw);
  }
  return terms;
}

/** The share of the shorter title's words that the other title has too: 1 when one is inside the other. */
export function titleOverlap(a: string, b: string): number {
  const x = titleTerms(a);
  const y = titleTerms(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const term of x) if (y.has(term)) shared += 1;
  return shared / Math.min(x.size, y.size);
}

/** From this overlap on, two titles are taken to name the same work. */
export const DUPLICATE_OVERLAP = 0.6;

/** The task someone else holds that a new title most likely duplicates, or null. */
export function closestHeldTask(title: string, tasks: readonly Task[], me: string): { task: Task; overlap: number } | null {
  let best: { task: Task; overlap: number } | null = null;
  for (const task of tasks) {
    if (task.status !== "claimed" || task.owner === me) continue;
    const overlap = titleOverlap(title, task.title);
    if (overlap >= DUPLICATE_OVERLAP && (best === null || overlap > best.overlap)) best = { task, overlap };
  }
  return best;
}

/** What the claimant is told when the judge refuses a claim. */
export function duplicateRefusal(title: string, held: { task: Task; overlap: number }): string {
  const owner = held.task.owner_name ?? held.task.owner;
  return [
    `Nothing was claimed: "${title}" looks like "${held.task.title}", which ${owner} holds (overlap ${held.overlap.toFixed(2)}).`,
    `Take other work, or coordinate with @${owner}. If your work really differs, claim it again with --distinct "<how yours differs>".`,
  ].join(" ");
}

export interface SeatActivity {
  name: string;
  member_id?: string | null;
  busy: boolean;
  turns: number;
}

/** The activity view: one line per seat, from the runner's record and the task acts. */
export function renderActivity(seats: readonly SeatActivity[], tasks: readonly Task[], me: string): string {
  const held = (seat: SeatActivity) => tasks.filter((task) => task.status === "claimed" && (task.owner_name === seat.name || (seat.member_id && task.owner === seat.member_id)));
  const done = (seat: SeatActivity) => tasks.filter((task) => task.status === "done" && (task.owner_name === seat.name || (seat.member_id && task.owner === seat.member_id))).length;
  const lines = seats.map((seat) => {
    const holding = held(seat);
    // The view is built just before the reader's own turn starts, so its own record still says idle.
    const state = seat.name === me ? "this turn" : seat.busy ? "in a turn" : seat.turns === 0 ? "not started" : "idle";
    const tasksText = holding.length > 0 ? `holds ${holding.map((task) => `"${task.title}"`).join(", ")}` : "holds no task";
    const finished = done(seat);
    return `- ${seat.name}${seat.name === me ? " (you)" : ""}: ${state}; ${tasksText}${finished > 0 ? `; ${finished} done` : ""}`;
  });
  return ["Who is doing what (from the runner's record and the task acts, not from what anyone said):", ...lines].join("\n");
}

export const ACTIVITY_HELP = "Each time you are woken, the message ends with who is doing what: who is in a turn, who is idle and who holds which task. Use it to pick work nobody holds.";

export const TASK_JUDGE_HELP = "A claim whose title is close to a task someone else holds is refused with that task named: take other work, coordinate with its owner, or claim again with --distinct \"<how yours differs>\".";
