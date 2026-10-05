// @vitest-environment node

import { describe, expect, it } from "vitest";

import { mentions, nextCronTime, parseCron, parseDuration, parseTrigger, saidIn, triggerTakesParameter, wakeIdentity } from "./triggers.ts";

/** A local wall-clock time, so the calendar cases hold in any time zone the suite runs in. */
const local = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second).getTime();

const NOW = local(2026, 10, 5, 12, 3, 30);

describe("the trigger language", () => {
  it("reads every kind, with or without the colon, and names each one the same way", () => {
    expect(parseTrigger("message", NOW)).toEqual({ kind: "message", label: "message" });
    expect(parseTrigger("mention", NOW)).toEqual({ kind: "mention", label: "mention" });
    expect(parseTrigger("closed", NOW)).toEqual({ kind: "closed", label: "closed" });
    expect(parseTrigger("count 5", NOW)).toEqual({ kind: "count", label: "count 5", count: 5 });
    expect(parseTrigger("count: 5", NOW)).toEqual(parseTrigger("count 5", NOW));
    expect(parseTrigger("idle: 30s", NOW)).toMatchObject({ kind: "idle", label: "idle 30s", ms: 30_000 });
    expect(parseTrigger("every 10m", NOW)).toMatchObject({ kind: "every", label: "every 10m", ms: 600_000 });
    expect(parseTrigger("after 2h", NOW)).toMatchObject({ kind: "after", label: "after 2h", ms: 7_200_000 });
    expect(parseTrigger("check: pytest -q tests/hidden", NOW)).toEqual({ kind: "check", label: "check pytest -q tests/hidden", command: "pytest -q tests/hidden" });
    expect(parseTrigger('cron: "*/15 9-17 * * 1-5"', NOW)).toMatchObject({ kind: "cron", label: "cron */15 9-17 * * 1-5" });
    expect(parseTrigger("said: DONE", NOW)).toMatchObject({ kind: "said", label: "said DONE", pattern: "DONE", expression: null });
  });

  it("refuses what is not a trigger, so a typo never becomes a wait that cannot fire", () => {
    for (const raw of ["sometimes", "message now", "count 0", "count many", "idle 0s", "every 10x", "said /(/", "cron * * *", "cron 61 * * * *", "at yesterday", "at 25:00", "check"]) {
      expect(() => parseTrigger(raw, NOW), raw).toThrow();
    }
    // The 31st of February never comes round; that is a mistake, not a long wait.
    expect(() => parseTrigger("cron 0 0 31 2 *", NOW)).toThrow(/never comes round/);
    expect(() => parseTrigger(`said ${"x".repeat(257)}`, NOW)).toThrow();
  });

  it("knows which bare kinds take their parameter from the next argument", () => {
    expect(triggerTakesParameter("every")).toBe(true);
    expect(triggerTakesParameter("count")).toBe(true);
    expect(triggerTakesParameter("every 10m")).toBe(false);
    expect(triggerTakesParameter("message")).toBe(false);
    expect(triggerTakesParameter("sometimes")).toBe(false);
  });

  it("reads durations in seconds, minutes, hours and days", () => {
    expect(parseDuration("45", "--x")).toBe(45_000);
    expect(parseDuration("45s", "--x")).toBe(45_000);
    expect(parseDuration("3m", "--x")).toBe(180_000);
    expect(parseDuration("2h", "--x")).toBe(7_200_000);
    expect(parseDuration("2d", "--x")).toBe(172_800_000);
    expect(() => parseDuration("0s", "--x")).toThrow();
  });

  it("puts `at HH:MM` at its next occurrence, and reads a full date-time as given", () => {
    const later = parseTrigger("at 13:00", NOW);
    expect(later).toMatchObject({ kind: "at", time: local(2026, 10, 5, 13, 0) });
    // 12:00 has already gone today, so it is tomorrow's.
    expect(parseTrigger("at 12:00", NOW)).toMatchObject({ time: local(2026, 10, 6, 12, 0) });
    expect(parseTrigger("at 2026-10-06T09:00:00Z", NOW)).toMatchObject({ time: Date.parse("2026-10-06T09:00:00Z") });
    expect(parseTrigger("at 2026-10-06T09:00", NOW)).toMatchObject({ time: local(2026, 10, 6, 9, 0) });
  });
});

describe("cron", () => {
  it("reads lists, ranges, steps, and both names for Sunday", () => {
    const schedule = parseCron("0,30 9-11 1-7/3 */6 7");
    expect([...schedule.minutes]).toEqual([0, 30]);
    expect([...schedule.hours]).toEqual([9, 10, 11]);
    expect([...schedule.days]).toEqual([1, 4, 7]);
    expect([...schedule.months]).toEqual([1, 7]);
    expect([...schedule.weekdays]).toEqual([0]);
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
  });

  it("finds the next minute the calendar names, strictly after now", () => {
    const every15 = parseCron("*/15 * * * *");
    expect(nextCronTime(every15, NOW)).toBe(local(2026, 10, 5, 12, 15));
    expect(nextCronTime(every15, local(2026, 10, 5, 12, 15))).toBe(local(2026, 10, 5, 12, 30));
    // Weekdays at nine: Monday the 5th has passed nine, so Tuesday.
    expect(nextCronTime(parseCron("0 9 * * 1-5"), NOW)).toBe(local(2026, 10, 6, 9, 0));
    // Friday the 9th at 18:00 rolls over the weekend to Monday.
    expect(nextCronTime(parseCron("0 9 * * 1-5"), local(2026, 10, 9, 18, 0))).toBe(local(2026, 10, 12, 9, 0));
    // New Year, and the 29th of February of the next leap year.
    expect(nextCronTime(parseCron("0 0 1 1 *"), NOW)).toBe(local(2027, 1, 1, 0, 0));
    expect(nextCronTime(parseCron("0 0 29 2 *"), NOW)).toBe(local(2028, 2, 29, 0, 0));
  });

  it("follows cron's rule that two restricted day fields match on either", () => {
    // The 13th, or any Friday: Friday the 9th comes first.
    expect(nextCronTime(parseCron("0 0 13 * 5"), NOW)).toBe(local(2026, 10, 9, 0, 0));
    // With the weekday left open, only the 13th.
    expect(nextCronTime(parseCron("0 0 13 * *"), NOW)).toBe(local(2026, 10, 13, 0, 0));
  });
});

describe("what a message wakes", () => {
  const seat = { memberId: "i_KlMnOpQrSt", name: "claude-code" };

  it("is a mention when it addresses the seat by name or id, and not a longer name that starts the same", () => {
    expect(mentions("@claude-code can you take W3?", seat)).toBe(true);
    expect(mentions("over to you, @Claude-Code.", seat)).toBe(true);
    expect(mentions("@i_KlMnOpQrSt please", seat)).toBe(true);
    expect(mentions("@claude-code-2 not you", seat)).toBe(false);
    expect(mentions("claude-code without the at", seat)).toBe(false);
    expect(mentions("@Xisen (local) said so", { memberId: "i_x", name: "Xisen (local)" })).toBe(true);
    expect(mentions("@someone", { memberId: "i_x", name: null })).toBe(false);
  });

  it("matches `said` as text, or as an expression with its flags", () => {
    const text = parseTrigger("said DONE", NOW);
    const expression = parseTrigger("said /^done\\b/i", NOW);
    if (text.kind !== "said" || expression.kind !== "said") throw new Error("not said");
    expect(saidIn("All DONE here", text)).toBe(true);
    expect(saidIn("all done here", text)).toBe(false);
    expect(saidIn("Done: tests pass", expression)).toBe(true);
    expect(saidIn("not done", expression)).toBe(false);
  });
});

describe("a wake's identity", () => {
  const base = { roomId: "rom_AbCdEfGhIj", memberId: "i_KlMnOpQrSt", from: 4, through: 9, fired: ["message"], messageCount: 3, firedAt: NOW };

  it("is what the wake carries, so the same batch offered again is the same wake with the same reply key", () => {
    const first = wakeIdentity(base);
    expect(first.wakeId).toMatch(/^wk_[A-Za-z0-9_-]{16}$/);
    // The key the service accepts: UUID version 4, variant 10xx.
    expect(first.replyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(wakeIdentity({ ...base, firedAt: NOW + 60_000 })).toEqual(first);
    expect(wakeIdentity({ ...base, through: 10 }).wakeId).not.toBe(first.wakeId);
    expect(wakeIdentity({ ...base, fired: ["mention"] }).wakeId).not.toBe(first.wakeId);
  });

  it("is when it fired, for a wake that carries no messages", () => {
    const clock = { ...base, from: 9, through: 9, fired: ["every 10m"], messageCount: 0 };
    expect(wakeIdentity(clock).wakeId).not.toBe(wakeIdentity({ ...clock, firedAt: NOW + 600_000 }).wakeId);
  });
});
