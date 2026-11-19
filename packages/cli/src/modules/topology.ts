/**
 * Module slot 2, topology (network science): which seat's messages reach which seat. Routing
 * (`--message-routing`) decides whom a message wakes; the topology decides, before that, whom it
 * can reach at all.
 *
 *  - `all` (the default): everyone can reach everyone, as before.
 *  - `islands:K`: the seats are dealt round-robin into K islands. A message reaches the sender's
 *    own island; it crosses to the others only when it names a seat there with @name, or when it
 *    starts with `[share]`. Lines from the runner reach everyone. The Room's history stays whole:
 *    `sharednet read` still shows every message to whoever asks for it.
 *
 * This is the island model of evolutionary search, with `[share]` as migration: islands explore
 * apart and pass on only what they choose to, which keeps a team from converging on one line too
 * early (Lazer and Friedman 2007; Mason and Watts 2012).
 */
import { localError } from "../errors.ts";
import { mentions } from "../triggers.ts";

export type Topology = { kind: "all" } | { kind: "islands"; count: number };

export const SHARE_MARK = "[share]";

export function parseTopology(raw: string | undefined): Topology {
  if (raw === undefined || raw === "all") return { kind: "all" };
  const match = /^islands:(\d{1,2})$/u.exec(raw);
  if (match && Number(match[1]) >= 2) return { kind: "islands", count: Number(match[1]) };
  throw localError("invalid_arguments", "--topology is all or islands:<K>, with K at least 2.");
}

/** Each seat's island, dealt round-robin in roster order. */
export function islandsOf(names: readonly string[], topology: Topology): Map<string, number> {
  const map = new Map<string, number>();
  names.forEach((name, index) => map.set(name, topology.kind === "islands" ? index % topology.count : 0));
  return map;
}

export function crossesIslands(content: string): boolean {
  return content.trimStart().toLowerCase().startsWith(SHARE_MARK);
}

interface Message { sequence: number; content: string; sender?: { member_id?: string; name?: string | null } }

/** The messages of a wake that can reach this seat under the topology. */
export function reachable<W extends { messages: Message[] }>(
  wake: W,
  seat: { name: string; member_id?: string | null },
  seats: ReadonlyArray<{ name: string; member_id?: string | null }>,
  topology: Topology,
): W {
  if (topology.kind === "all") return wake;
  const island = islandsOf(seats.map((s) => s.name), topology);
  const mine = island.get(seat.name);
  const seatOf = (message: Message) => seats.find((s) => (message.sender?.member_id && s.member_id === message.sender.member_id) || s.name === message.sender?.name);
  return {
    ...wake,
    messages: wake.messages.filter((message) => {
      const sender = seatOf(message);
      if (!sender) return true; // the runner, the owner: the goal's machinery reaches everyone
      if (island.get(sender.name) === mine) return true;
      if (crossesIslands(message.content)) return true;
      return mentions(message.content, { memberId: seat.member_id ?? "", name: seat.name });
    }),
  };
}

/** What a seat is told about its island in its first prompt. */
export function topologyHelp(seat: string, names: readonly string[], topology: Topology): string[] {
  if (topology.kind === "all") return [];
  const island = islandsOf(names, topology);
  const mates = names.filter((name) => name !== seat && island.get(name) === island.get(seat));
  return [
    `The team works in ${topology.count} islands. Yours is island ${(island.get(seat) ?? 0) + 1}${mates.length > 0 ? `, with ${mates.join(", ")}` : ", where you are alone"}.`,
    `What you say reaches your island. It reaches the other islands only when it names someone there with @name, or when it starts with ${SHARE_MARK}: use ${SHARE_MARK} for what the whole team should know, such as an accepted result or a dead end, and keep the rest within your island.`,
  ];
}
