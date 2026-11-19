/**
 * Module slot 4, information: what the team does not yet know, put in front of it.
 *
 * A probe (`--probe "<command>" --probe-every 5m`) is a command the runner runs on a fixed clock
 * in the checks container, on the shared workspace, with no model behind it. Whatever it prints
 * is posted to the Room as a `[probe]` line from the runner, addressed to @all; an empty output
 * posts nothing. A probe is a source of information, not a judge: it can be a differential tester
 * that runs the reference and the team's current build on inputs nobody has tried and reports the
 * clusters where they disagree (the discovery gap: a team stops finding what else to test long
 * before it stops fixing what it knows), a coverage count, or a measure of how alike the seats'
 * lines of work are. Off by default.
 */
import { localError } from "../errors.ts";

export interface Probe {
  command: string;
  everyMs: number;
}

export const PROBE_MARK = "[probe]";

/** The probe from the two options, or null when there is none. */
export function parseProbe(command: string | undefined, everyMs: number | undefined): Probe | null {
  if (command === undefined) {
    if (everyMs !== undefined) throw localError("invalid_arguments", "--probe-every needs --probe <command>.");
    return null;
  }
  if (!command.trim()) throw localError("invalid_arguments", "--probe needs a command.");
  const every = everyMs ?? 5 * 60_000;
  if (every < 60_000) throw localError("invalid_arguments", "--probe-every is at least 1m.");
  return { command, everyMs: every };
}

/** The Room line for a probe's output, or null when it printed nothing. */
export function probeMessage(stdout: string, maxChars = 1800): string | null {
  const text = stdout.trim();
  if (!text) return null;
  const body = text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
  return `@all ${PROBE_MARK} ${body}`;
}

export const PROBE_HELP = `Lines that start with ${PROBE_MARK} come from a probe the runner runs every few minutes, with no model behind it: they report what it found, such as inputs on which the team's build and the reference disagree. Treat them as data to act on.`;
