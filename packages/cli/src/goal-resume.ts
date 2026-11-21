import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { localError } from "./errors.ts";
import type { AgentSpec, Driver, Usage } from "./goal-run.ts";

/**
 * `goal run --resume-from <record>`: the next Goal for a swarm that has already worked.
 *
 * A run's record keeps each seat's home (`agents/<seat>/home/`), and a harness keeps its sessions
 * in its home: Codex in `.codex/sessions/`, Claude Code in `.claude/projects/`. So an ended run's
 * agents are still on this machine. A run that names the record takes them up again: a seat of
 * the same name and harness gets its home back, and its first turn resumes its own session with
 * the new goal, where a fresh seat would start a session with the whole opening.
 *
 * What comes back is the seat's home and the workspace. Its container is new, so are its seat in
 * the Room and the Room itself, and the record strips every sign-in from a home, so each is put
 * back the way a new seat gets one. A seat that cannot be taken up (new to the team, another
 * harness, no session kept, a harness that refuses the session) starts fresh, and the run's
 * record says which seats were resumed and why the others were not.
 */

/** Why a seat of a resumed run started a fresh session instead. */
export type FreshReason =
  /** The earlier run had no seat of this name. */
  | "new_seat"
  /** The earlier seat of this name ran another harness. */
  | "other_harness"
  /** The earlier seat never got as far as a session. */
  | "no_session"
  /** The record does not hold the seat's home. */
  | "no_home"
  /** The home does not hold the session's file. */
  | "no_session_file"
  /** The home could not be put into the seat's new container. */
  | "home_not_restored"
  /** The harness did not take the session up when asked to resume it. */
  | "harness_refused"
  /** The run ended before the seat's first turn showed whether the session was taken up. */
  | "ended_first";

interface EarlierSeat {
  name: string;
  driver: Driver;
  sessionId: string | null;
  /** What the earlier run counted for the seat, and what that run itself had left out as earlier still. */
  usage: Usage;
  baseline: Usage;
}

/** An earlier run's record, as far as taking its seats up again needs it. */
export interface ResumeSource {
  /** The record's directory on this machine. */
  record: string;
  /** The Room that run worked in. */
  roomId: string | null;
  seats: EarlierSeat[];
  /** How that run's Room worked (`roomControls`), to tell a resumed seat only what has changed. */
  controls: string;
}

/** A seat that is to be taken up again. */
export interface SeatResume {
  sessionId: string;
  /** The seat's saved home on this machine. */
  home: string;
  /**
   * What the session had used when the earlier run ended. Codex reports a resumed session's
   * running total, so this run counts only what comes after it.
   */
  baseline: Usage;
}

export interface ResumePlan {
  seats: Map<string, SeatResume>;
  fresh: Map<string, FreshReason>;
}

const ZERO: Usage = { input: 0, cached: 0, output: 0 };
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const usageOf = (value: unknown): Usage => (record(value) ? { input: count(value.input), cached: count(value.cached), output: count(value.output) } : { ...ZERO });

export function addUsage(left: Usage, right: Usage): Usage {
  return { input: left.input + right.input, cached: left.cached + right.cached, output: left.output + right.output };
}

/** A session's running total less what it had used before this run; never below nothing. */
export function usageSince(total: Usage, baseline: Usage): Usage {
  return { input: Math.max(0, total.input - baseline.input), cached: Math.max(0, total.cached - baseline.cached), output: Math.max(0, total.output - baseline.output) };
}

/**
 * How a Room works, as far as a seat's opening tells it: the gates, who a message wakes, the turn
 * policy and the modules. Two runs with the same answer here gave their seats the same rules.
 */
export function roomControls(input: { mentionGate: unknown; taskGate: unknown; messageRouting: unknown; turnPolicy: unknown; modules: unknown; seats: readonly string[] }): string {
  const islands = record(input.modules) && input.modules.topology !== "all";
  return JSON.stringify({
    mention_gate: input.mentionGate ?? null,
    task_gate: input.taskGate ?? null,
    message_routing: input.messageRouting ?? null,
    turn_policy: input.turnPolicy ?? null,
    modules: input.modules ?? null,
    alone: input.seats.length === 1,
    // Islands are dealt by seat, so the same rule over another team is another rule.
    ...(islands ? { seats: [...input.seats] } : {}),
  });
}

/** Reads the record a run is asked to resume from; anything that is not a goal run's record is refused before a Room exists. */
export async function readResumeSource(directory: string): Promise<ResumeSource> {
  const refuse = () => localError("invalid_arguments", `--resume-from ${directory} is not a goal run's record: it has no episode.json that lists the run's agents.`);
  let episode: unknown;
  try {
    episode = JSON.parse(await readFile(join(directory, "episode.json"), "utf8"));
  } catch {
    throw refuse();
  }
  if (!record(episode) || !Array.isArray(episode.agents)) throw refuse();
  const earlier = record(episode.resume) && record(episode.resume.seats) ? episode.resume.seats : {};
  const seats = episode.agents.flatMap((agent): EarlierSeat[] => {
    if (!record(agent) || typeof agent.name !== "string" || (agent.driver !== "codex" && agent.driver !== "claude-code")) return [];
    const before = earlier[agent.name];
    return [{
      name: agent.name,
      driver: agent.driver,
      sessionId: typeof agent.session_id === "string" && SESSION_ID.test(agent.session_id) ? agent.session_id : null,
      usage: usageOf(agent.usage),
      baseline: record(before) ? usageOf(before.baseline) : { ...ZERO },
    }];
  });
  return {
    record: resolve(directory),
    roomId: typeof episode.room_id === "string" && /^rom_[0-9A-Za-z]{6,40}$/.test(episode.room_id) ? episode.room_id : null,
    seats,
    controls: roomControls({
      mentionGate: episode.mention_gate,
      taskGate: episode.task_gate,
      messageRouting: episode.message_routing,
      turnPolicy: episode.turn_policy,
      modules: episode.modules,
      seats: seats.map((seat) => seat.name),
    }),
  };
}

async function sessionFile(home: string, driver: Driver, sessionId: string): Promise<string | null> {
  const root = driver === "codex" ? join(home, ".codex", "sessions") : join(home, ".claude", "projects");
  const files = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  // Codex names a session's file rollout-<time>-<id>.jsonl; Claude Code names it <id>.jsonl, under the directory it worked in.
  const found = files.find((name) => (driver === "codex" ? name.endsWith(`${sessionId}.jsonl`) : name === `${sessionId}.jsonl` || name.endsWith(`/${sessionId}.jsonl`)));
  return found ? join(root, found) : null;
}

/**
 * Which seats of this run are taken up again. A seat is the same seat when its name and its
 * harness are the earlier run's; its model may have changed. `codexTotal` reads a Codex session
 * file's own running total.
 */
export async function planResume(source: ResumeSource, agents: readonly AgentSpec[], codexTotal: (rollout: string) => Usage | null): Promise<ResumePlan> {
  const plan: ResumePlan = { seats: new Map(), fresh: new Map() };
  for (const agent of agents) {
    const earlier = source.seats.find((seat) => seat.name === agent.name);
    if (!earlier) { plan.fresh.set(agent.name, "new_seat"); continue; }
    if (earlier.driver !== agent.driver) { plan.fresh.set(agent.name, "other_harness"); continue; }
    if (earlier.sessionId === null) { plan.fresh.set(agent.name, "no_session"); continue; }
    const home = join(source.record, "agents", agent.name, "home");
    // A real directory: a link would be copied as a link, and the seat would have no home.
    if (!(await lstat(home).then((entry) => entry.isDirectory(), () => false))) { plan.fresh.set(agent.name, "no_home"); continue; }
    const file = await sessionFile(home, agent.driver, earlier.sessionId);
    if (file === null) { plan.fresh.set(agent.name, "no_session_file"); continue; }
    // The session's own file is exact. Without a total in it, what the earlier run counted, on top of what that run had left out.
    const total = agent.driver === "codex" ? await readFile(file, "utf8").then(codexTotal, () => null) : null;
    plan.seats.set(agent.name, { sessionId: earlier.sessionId, home, baseline: agent.driver === "codex" ? total ?? addUsage(earlier.usage, earlier.baseline) : { ...ZERO } });
  }
  return plan;
}

/** Where goal run writes what was said in the earlier Room, inside the workspace. */
export function earlierRoomFile(roomId: string | null): string {
  return `earlier-rooms/${roomId ?? "earlier-room"}.md`;
}

/** A run's record of its Room (`room.ndjson`) as a file to search: one message a paragraph, oldest first. */
export function earlierRoomMarkdown(roomId: string | null, ndjson: string): string {
  const lines: string[] = [];
  for (const row of ndjson.split("\n")) {
    if (!row.trim()) continue;
    let message: unknown;
    try { message = JSON.parse(row); } catch { continue; }
    if (!record(message) || typeof message.content !== "string" || !Number.isInteger(message.sequence)) continue;
    const sender = record(message.sender) ? message.sender : {};
    const name = typeof sender.name === "string" ? sender.name : typeof sender.member_id === "string" ? sender.member_id : typeof message.sender_instance_id === "string" ? message.sender_instance_id : "someone";
    const at = typeof message.created_at === "string" ? `${message.created_at.slice(0, 16).replace("T", " ")} ` : "";
    lines.push(`#${message.sequence} ${at}${name}: ${message.content.trim()}`);
  }
  const head = `# What was said in ${roomId ?? "the earlier Room"}\n\nThe Room of an earlier Goal of this swarm, which has ended. Oldest first; \`runner\` is the Room's own machinery, not a person.\n`;
  return `${head}\n${lines.length > 0 ? lines.join("\n\n") : "(Nothing was said.)"}\n`;
}

function list(names: readonly string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * What a seat that is taken up again is told first. It has its own memory of the earlier Goal and
 * of how a Room works, so this is the new goal and only what is different: the Room, the date,
 * the team, the container, how this Room ends, and the Room's rules when those have changed.
 */
export function resumePrompt(input: {
  seat: string;
  /** Every seat of this run, and which of them are being taken up again. */
  seats: readonly string[];
  resumed: ReadonlySet<string>;
  roomId: string;
  earlierRoomId: string | null;
  /** The file in the workspace that holds what was said earlier, or null when there is none. */
  earlierRooms: string | null;
  workspace: string;
  goal: string;
  goalSequence: number;
  until: readonly string[];
  /** Today's date, UTC: `2026-11-20`. */
  today: string;
  /** The Room's rules as an opening states them, when they are not the earlier run's; null when they are the same. */
  rules: readonly string[] | null;
}): string {
  const others = input.seats.filter((name) => name !== input.seat);
  const same = others.filter((name) => input.resumed.has(name));
  const fresh = others.filter((name) => !input.resumed.has(name));
  const team = others.length === 0
    ? "You are the only agent of this Goal."
    : [
        same.length > 0 ? `${list(same)} ${same.length === 1 ? "is" : "are"} resumed as you are.` : "",
        fresh.length > 0 ? `${list(fresh)} ${fresh.length === 1 ? "is a new session and remembers" : "are new sessions and remember"} nothing of the earlier Goal.` : "",
      ].filter(Boolean).join(" ");
  const claims = input.until.filter((trigger) => trigger.startsWith("said ")).map((trigger) => `"${trigger.slice(5)}"`);
  return [
    `You are still ${input.seat}, and this is a new Goal for the same swarm. Your session from the earlier Goal has been resumed: what you did, read and learned then is still yours, and so are your home directory and the files in ${input.workspace}.`,
    "",
    `The new goal (message #${input.goalSequence}):`,
    "<goal>",
    input.goal.trim(),
    "</goal>",
    "",
    "What is different now:",
    input.earlierRoomId === input.roomId
      ? `- The Room is the same, ${input.roomId}: the earlier goal has ended and this is its next one, at message #${input.goalSequence}. Everything before #${input.goalSequence} belongs to the earlier Goal. You speak in it from a new seat under the same name; the seat you spoke from before is no longer used.`
      : `- The Room is new: ${input.roomId}. ${input.earlierRoomId ? `The earlier Room, ${input.earlierRoomId},` : "The earlier Room"} has ended and nothing more is said there. \`sharednet\` now reads and speaks in the new Room, whose messages are numbered from #1 again.`,
    ...(input.earlierRooms ? [`- What was said earlier is in ${input.earlierRooms} in ${input.workspace}, oldest first. You were there; search the file when you need an exact line instead of reading it whole.`] : []),
    `- Today is ${input.today} (UTC).`,
    `- The team: ${team}`,
    `- Your container is new. Programs you left running are gone, and so is anything installed outside your home directory and ${input.workspace}.`,
    `- This Room ends when the first of these happens: ${input.until.join("; ")}.`,
    ...(claims.length > 0 ? [`- Say ${claims.join(" or ")} in the Room only when you believe the new goal is met: saying it runs the check.`] : []),
    ...(input.rules === null
      ? ["", "How you talk in the Room and how you are woken are as they were."]
      : ["", "How the Room works has changed too:", ...input.rules]),
  ].join("\n");
}

/**
 * What a seat that starts fresh in a resumed run is told after its opening: that the swarm has
 * worked before, who remembers it, and where what was said then can be read.
 */
export function newcomerNote(input: { seat: string; seats: readonly string[]; resumed: ReadonlySet<string>; earlierRoomId: string | null; earlierRooms: string | null; workspace: string; roomId?: string; goalSequence?: number }): string {
  const same = input.seats.filter((name) => name !== input.seat && input.resumed.has(name));
  // In the same Room the earlier Goal is the part of this Room before the new goal's message.
  const room = input.earlierRoomId !== null && input.earlierRoomId === input.roomId
    ? `this Room (the messages before #${input.goalSequence ?? 1})`
    : input.earlierRoomId ? `Room ${input.earlierRoomId}` : "an earlier Room";
  return [
    same.length > 0
      ? `This swarm has worked before, on an earlier Goal in ${room}. ${list(same)} ${same.length === 1 ? "is the same session that" : "are the same sessions that"} worked on it, resumed with what ${same.length === 1 ? "it remembers" : "they remember"}; you are a new session and start without that memory.`
      : `This swarm has worked before, on an earlier Goal in ${room}. None of its sessions is here: every agent of this Goal is a new session.`,
    ...(input.earlierRooms ? [`What was said then is in ${input.earlierRooms} in ${input.workspace}, oldest first.`] : []),
  ].join(" ");
}
