/**
 * Module slot 3, protocol (organisation and management theory): what a message must contain.
 *
 *  - `free` (the default): any text, as before.
 *  - `sbar`: a message that asks something of a named teammate (it names someone with @name,
 *    other than @all) must carry the four parts of an SBAR handoff, the structure hospitals and
 *    the US Navy use so that a request survives a change of hands:
 *      S: situation      what is happening now
 *      B: background     what the reader needs to know to act on it (paths, commits, evidence)
 *      A: assessment     what the sender thinks is going on
 *      R: recommendation what the sender asks the reader to do
 *    `sharednet say` refuses a directed message without them and shows the template. Messages
 *    to nobody or to @all stay free. Each wake then lists what has been asked of the woken seat:
 *    the R: part of every directed message to it.
 */
import { localError } from "../errors.ts";
import { mentions } from "../triggers.ts";

export type MessageSchema = "free" | "sbar";

export function parseMessageSchema(raw: string | undefined): MessageSchema {
  if (raw === undefined || raw === "free") return "free";
  if (raw === "sbar") return "sbar";
  throw localError("invalid_arguments", "--message-schema is free or sbar.");
}

const PARTS = [
  ["S", "situation"],
  ["B", "background"],
  ["A", "assessment"],
  ["R", "recommendation"],
] as const;

const partPattern = (letter: string, word: string) => new RegExp(`(^|[\\n|;]|\\s)(${letter}|${word})\\s*:`, "iu");

/** Whether a message asks something of a named teammate: it names someone other than @all. */
export function isDirected(content: string): boolean {
  for (const match of content.matchAll(/(^|[^\p{L}\p{N}_-])@([\p{L}\p{N}_.-]+)/gu)) {
    if (match[2]!.toLowerCase() !== "all") return true;
  }
  return false;
}

/** The SBAR parts a message lacks, as letters. */
export function sbarMissing(content: string): string[] {
  return PARTS.filter(([letter, word]) => !partPattern(letter, word).test(content)).map(([letter]) => letter);
}

export const SBAR_TEMPLATE = '@<name> S: <what is happening> | B: <what they need to know: paths, commits, evidence> | A: <what you think is going on> | R: <what you ask them to do>';

export function sbarRefusal(missing: readonly string[]): string {
  return `Nothing was posted. A message that names a teammate is a handoff and needs all four SBAR parts; it lacks ${missing.join(", ")}. Write it as: ${SBAR_TEMPLATE}`;
}

export const SBAR_HELP = [
  "A message that names a teammate with @name is a handoff, and must have the four SBAR parts (sharednet say refuses it otherwise):",
  `  ${SBAR_TEMPLATE}`,
  "Messages to nobody or to @all are free text.",
].join("\n");

interface Message { sequence: number; content: string; sender?: { member_id?: string; name?: string | null } }

/** The R: part of a handoff, or the whole message when it has none. */
export function recommendationOf(content: string): string {
  const match = /(?:^|[\n|;]|\s)(?:R|recommendation)\s*:\s*([\s\S]*)$/iu.exec(content);
  const text = (match ? match[1]! : content).replace(/\s+/gu, " ").trim();
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** What has been asked of this seat in a wake: one line per directed message to it. */
export function requestsFor(messages: readonly Message[], seat: { name: string; member_id?: string | null }): string[] {
  return messages
    .filter((message) => message.sender?.name !== seat.name && mentions(message.content, { memberId: seat.member_id ?? "", name: seat.name }) && isDirected(message.content))
    .map((message) => `- #${message.sequence} ${message.sender?.name ?? message.sender?.member_id ?? "someone"} asks: ${recommendationOf(message.content)}`);
}

export function renderRequests(lines: readonly string[]): string {
  return lines.length === 0 ? "" : ["Asked of you (the R: part of each handoff to you):", ...lines].join("\n");
}
