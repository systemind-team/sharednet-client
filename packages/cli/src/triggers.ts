import { createHash } from "node:crypto";

import { localError } from "./errors.ts";

/**
 * The trigger language (decision 2026-10-05, goal mode and one wait): when a
 * wait wakes, and, with the same words, when a goal Room ends. One parser, so
 * the two can never mean different things by the same trigger.
 *
 *   message                 another member said something
 *   mention                 a message addresses this seat: @its-name or @its-id
 *   said <text|/re/flags>   a message contains the text, or matches the expression
 *   count <n>               n messages since the last wake
 *   idle <duration>         something was said, then nothing for that long
 *   every <duration>        on a clock
 *   cron "<m h dom mon dow>"  on a calendar, in this machine's time zone
 *   after <duration>        once, that long after the wait started
 *   at <time>               once: an ISO date-time, or HH:MM (the next one)
 *   check <command>         the command exits 0 here; fires when it starts to
 *   closed                  the Room was closed
 *
 * `kind: parameter` and `kind parameter` are the same trigger.
 */
export type Trigger =
  | { kind: "message"; label: string }
  | { kind: "mention"; label: string }
  | { kind: "said"; label: string; pattern: string; expression: RegExp | null }
  | { kind: "count"; label: string; count: number }
  | { kind: "idle"; label: string; ms: number }
  | { kind: "every"; label: string; ms: number }
  | { kind: "cron"; label: string; schedule: CronSchedule }
  | { kind: "after"; label: string; ms: number }
  | { kind: "at"; label: string; time: number }
  | { kind: "check"; label: string; command: string }
  | { kind: "closed"; label: string };

export type TriggerKind = Trigger["kind"];

const PARAMETERLESS = new Set<TriggerKind>(["message", "mention", "closed"]);
const KINDS = new Set<TriggerKind>(["message", "mention", "said", "count", "idle", "every", "cron", "after", "at", "check", "closed"]);

const USAGE =
  "--on takes message, mention, said <text>, count <n>, idle <duration>, every <duration>, cron \"<m h dom mon dow>\", after <duration>, at <time>, check <command>, or closed.";

/** Does this kind take a parameter? A bare `--on every` may find it in the next argument. */
export function triggerTakesParameter(raw: string): boolean {
  const kind = /^([a-z]+)/.exec(raw.trim())?.[1] as TriggerKind | undefined;
  return kind !== undefined && KINDS.has(kind) && !PARAMETERLESS.has(kind) && splitTrigger(raw).parameter === "";
}

function splitTrigger(raw: string): { kind: string; parameter: string } {
  const match = /^([a-z]+)\s*:?\s*([\s\S]*)$/.exec(raw.trim());
  if (!match) throw localError("invalid_trigger", USAGE);
  return { kind: match[1]!, parameter: match[2]!.trim() };
}

/** "30s", "10m", "1h", "2d", or plain seconds, as milliseconds. */
export function parseDuration(value: string | undefined, option: string): number {
  const match = value === undefined ? null : /^(\d+)(s|m|h|d)?$/.exec(value);
  if (!match || Number(match[1]) < 1) {
    throw localError("invalid_duration", `${option} takes a duration such as 30s, 10m, 1h, or 2d.`);
  }
  const unit = match[2] === "d" ? 86_400_000 : match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1000;
  return Number(match[1]) * unit;
}

export function parseCount(value: string | undefined, option: string): number | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d*$/.test(value)) {
    throw localError("invalid_count", `${option} must be a whole number of at least 1.`);
  }
  return Number(value);
}

/** One trigger, from what follows `--on`. `now` anchors `at HH:MM` to its next occurrence. */
export function parseTrigger(raw: string, now: number): Trigger {
  const { kind, parameter } = splitTrigger(raw);
  if (!KINDS.has(kind as TriggerKind)) throw localError("invalid_trigger", USAGE);
  if (PARAMETERLESS.has(kind as TriggerKind)) {
    if (parameter !== "") throw localError("invalid_trigger", `--on ${kind} takes no parameter.`);
    return { kind: kind as "message" | "mention" | "closed", label: kind };
  }
  if (parameter === "") throw localError("invalid_trigger", `--on ${kind} needs a parameter. ${USAGE}`);
  switch (kind) {
    case "count": {
      const count = parseCount(parameter, "--on count");
      return { kind: "count", label: `count ${count}`, count: count! };
    }
    case "idle":
    case "every":
    case "after": {
      const ms = parseDuration(parameter, `--on ${kind}`);
      return { kind, label: `${kind} ${parameter}`, ms };
    }
    case "said": {
      const literal = /^\/([\s\S]+)\/([a-z]*)$/.exec(parameter);
      let expression: RegExp | null = null;
      if (literal) {
        try {
          expression = new RegExp(literal[1]!, literal[2]);
        } catch {
          throw localError("invalid_trigger", "--on said takes text, or /an expression/ that compiles.");
        }
      }
      if ([...parameter].length > 256) throw localError("invalid_trigger", "--on said takes 1 to 256 characters.");
      return { kind: "said", label: `said ${parameter}`, pattern: parameter, expression };
    }
    case "cron": {
      const expression = parameter.replace(/^["']|["']$/g, "").trim();
      const schedule = parseCron(expression);
      // A calendar that never comes round (the 31st of February) is a typo, not a wait.
      nextCronTime(schedule, now);
      return { kind: "cron", label: `cron ${expression}`, schedule };
    }
    case "at": {
      return { kind: "at", label: `at ${parameter}`, time: parseAt(parameter, now) };
    }
    case "check": {
      return { kind: "check", label: `check ${parameter}`, command: parameter };
    }
  }
  throw localError("invalid_trigger", USAGE);
}

/** An ISO date-time (with or without an offset; without one it is this machine's time), or HH:MM next. */
function parseAt(value: string, now: number): number {
  const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value)) {
    const time = Date.parse(value.replace(" ", "T"));
    if (Number.isFinite(time)) return time;
  }
  throw localError("invalid_trigger", "--on at takes an ISO date-time such as 2026-10-06T09:00, or HH:MM.");
}

// ---- cron ----

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** cron's rule: when both day fields are restricted, either may match. */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
}

const CRON_USAGE = 'cron takes five fields, minute hour day month weekday, such as "0 9 * * 1-5" or "*/15 * * * *".';

function cronField(field: string, low: number, high: number): Set<number> {
  const values = new Set<number>();
  for (const item of field.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (!match) throw localError("invalid_trigger", CRON_USAGE);
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = low;
    let to = high;
    if (match[1] !== "*") {
      from = Number(match[2]);
      // "5/15" is cron for "from 5, every 15"; "5" alone is just 5.
      to = match[3] !== undefined ? Number(match[3]) : match[4] !== undefined ? high : from;
    }
    if (step < 1 || from < low || to > high || from > to) throw localError("invalid_trigger", CRON_USAGE);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw localError("invalid_trigger", CRON_USAGE);
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = cronField(weekday, 0, 7);
  // Sunday is 0 and 7.
  if (weekdays.has(7)) weekdays.add(0);
  weekdays.delete(7);
  return {
    minutes: cronField(minute, 0, 59),
    hours: cronField(hour, 0, 23),
    days: cronField(day, 1, 31),
    months: cronField(month, 1, 12),
    weekdays,
    daysRestricted: !day.startsWith("*"),
    weekdaysRestricted: !weekday.startsWith("*"),
  };
}

function cronDayMatches(schedule: CronSchedule, at: Date): boolean {
  const day = schedule.days.has(at.getDate());
  const weekday = schedule.weekdays.has(at.getDay());
  if (schedule.daysRestricted && schedule.weekdaysRestricted) return day || weekday;
  if (schedule.daysRestricted) return day;
  if (schedule.weekdaysRestricted) return weekday;
  return true;
}

/** The first whole minute strictly after `after` that the schedule names, in this machine's time. */
export function nextCronTime(schedule: CronSchedule, after: number): number {
  const at = new Date(after);
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  // Five years of whole steps covers every real calendar, the 29th of February included.
  const limit = after + 5 * 366 * 86_400_000;
  while (at.getTime() <= limit) {
    if (!schedule.months.has(at.getMonth() + 1)) {
      at.setMonth(at.getMonth() + 1, 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cronDayMatches(schedule, at)) {
      at.setDate(at.getDate() + 1);
      at.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(at.getHours())) {
      at.setHours(at.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(at.getMinutes())) {
      at.setMinutes(at.getMinutes() + 1, 0, 0);
      continue;
    }
    return at.getTime();
  }
  throw localError("invalid_trigger", `That cron schedule never comes round. ${CRON_USAGE}`);
}

// ---- matching messages ----

/** Is this seat addressed: `@` and its name or its Instance id, not followed by more of a name. */
export function mentions(content: string, seat: { memberId: string; name: string | null }): boolean {
  const lowered = content.toLowerCase();
  for (const handle of [seat.memberId, seat.name]) {
    if (!handle) continue;
    const needle = `@${handle.toLowerCase()}`;
    let index = lowered.indexOf(needle);
    while (index !== -1) {
      const next = lowered.charAt(index + needle.length);
      if (next === "" || !/[\p{L}\p{N}_-]/u.test(next)) return true;
      index = lowered.indexOf(needle, index + 1);
    }
  }
  return false;
}

export function saidIn(content: string, trigger: Extract<Trigger, { kind: "said" }>): boolean {
  if (trigger.expression) {
    trigger.expression.lastIndex = 0;
    return trigger.expression.test(content);
  }
  return content.includes(trigger.pattern);
}

// ---- wake identity ----

/**
 * A wake's identity is what it carries, not when it was built: the same
 * unhandled batch offered again after a crash is the same wake, so its reply
 * reuses the same idempotency key and the Room takes it once. A wake that
 * carries no messages (a clock, a check) is identified by when it fired.
 */
export function wakeIdentity(parts: {
  roomId: string;
  memberId: string;
  from: number;
  through: number;
  fired: readonly string[];
  messageCount: number;
  firedAt: number;
}): { wakeId: string; replyKey: string } {
  const basis = [
    parts.roomId,
    parts.memberId,
    String(parts.from),
    String(parts.through),
    parts.fired.join("\u0000"),
    parts.messageCount > 0 ? "" : String(parts.firedAt),
  ].join("\u0001");
  const digest = createHash("sha256").update(basis).digest();
  const wakeId = `wk_${digest.subarray(0, 12).toString("base64url")}`;
  // The service takes UUIDv4-shaped keys: the version and variant bits are set, the rest is the digest.
  const bytes = Buffer.from(digest.subarray(12, 28));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const replyKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { wakeId, replyKey };
}
