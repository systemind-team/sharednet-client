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
export type Trigger = {
    kind: "message";
    label: string;
} | {
    kind: "mention";
    label: string;
} | {
    kind: "said";
    label: string;
    pattern: string;
    expression: RegExp | null;
} | {
    kind: "count";
    label: string;
    count: number;
} | {
    kind: "idle";
    label: string;
    ms: number;
} | {
    kind: "every";
    label: string;
    ms: number;
} | {
    kind: "cron";
    label: string;
    schedule: CronSchedule;
} | {
    kind: "after";
    label: string;
    ms: number;
} | {
    kind: "at";
    label: string;
    time: number;
} | {
    kind: "check";
    label: string;
    command: string;
} | {
    kind: "closed";
    label: string;
};
export type TriggerKind = Trigger["kind"];
/** Does this kind take a parameter? A bare `--on every` may find it in the next argument. */
export declare function triggerTakesParameter(raw: string): boolean;
/** "30s", "10m", "1h", "2d", or plain seconds, as milliseconds. */
export declare function parseDuration(value: string | undefined, option: string): number;
export declare function parseCount(value: string | undefined, option: string): number | null;
/** One trigger, from what follows `--on`. `now` anchors `at HH:MM` to its next occurrence. */
export declare function parseTrigger(raw: string, now: number): Trigger;
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
export declare function parseCron(expression: string): CronSchedule;
/** The first whole minute strictly after `after` that the schedule names, in this machine's time. */
export declare function nextCronTime(schedule: CronSchedule, after: number): number;
/** Is this seat addressed: `@` and its name or its Instance id, not followed by more of a name. */
export declare function mentions(content: string, seat: {
    memberId: string;
    name: string | null;
}): boolean;
export declare function saidIn(content: string, trigger: Extract<Trigger, {
    kind: "said";
}>): boolean;
/**
 * A wake's identity is what it carries, not when it was built: the same
 * unhandled batch offered again after a crash is the same wake, so its reply
 * reuses the same idempotency key and the Room takes it once. A wake that
 * carries no messages (a clock, a check) is identified by when it fired.
 */
export declare function wakeIdentity(parts: {
    roomId: string;
    memberId: string;
    from: number;
    through: number;
    fired: readonly string[];
    messageCount: number;
    firedAt: number;
}): {
    wakeId: string;
    replyKey: string;
};
