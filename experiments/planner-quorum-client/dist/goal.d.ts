import type { Coordination } from "./coordination.js";
import type { ApiClient } from "./api-client.ts";
import { type Trigger } from "./triggers.ts";
/** A budget is counted in tokens, the one spend both harnesses report; it needs `goal run`, which reads it. */
export type UntilTrigger = Trigger | {
    kind: "budget";
    label: string;
    tokens: number;
};
/**
 * One `--until`, in the words of `wait --on` plus `budget`, as the service
 * takes it: `at 17:30` becomes the next 17:30 with this machine's offset,
 * because the service cannot know this machine's clock.
 */
export declare function parseUntil(raw: string, now: number): {
    wire: string;
    trigger: UntilTrigger;
};
/**
 * Every `--until`, refusing a goal that names no bound before anything is sent. A budget is
 * only offered where it is measured: `goal run` starts the Agents and reads their usage; a
 * Room whose Agents someone else started would carry a bound that nothing enforces.
 */
export declare function parseUntilList(raws: readonly string[], now: number, options?: {
    budget?: boolean;
}): {
    wire: string[];
    triggers: UntilTrigger[];
};
/** Make a Room this account owns a goal Room: the goal is said as the owner's first line. */
export declare function startGoal(client: ApiClient, apiKey: string, roomId: string, content: string, until: readonly string[]): Promise<{
    room: unknown;
    message: unknown;
}>;
export type CheckRunner = (command: string, cwd: string) => Promise<{
    exitCode: number;
    output: string;
}>;
export interface GoalWatchDependencies {
    coordination?: Coordination;
    now: () => Date;
    sleep?: (ms: number) => Promise<void>;
    stderr?: (value: string) => void;
    /** Runs a `check` in the workspace; tests replace it. */
    check?: CheckRunner;
    /** Takes a workspace snapshot; tests replace it, and null turns snapshots off. */
    snapshot?: ((label: string) => Promise<string | null>) | null;
    /** Tokens the Agents have used so far, when this runner started them (`goal run`); a budget is judged on it. */
    spend?: () => number;
}
export interface GoalWatchOptions {
    roomId: string;
    /** Where the Agents work; checks run here and its snapshots are taken from here. */
    workspace: string;
    /** Where the record goes: room.ndjson, checks.ndjson, episode.json, workspace.git. */
    out: string;
    checkEveryMs: number;
    /** Do not post a failing check back into the Room (a controlled experiment). */
    quietChecks: boolean;
    /** Read the Room's state at least this often, to notice an end the service or the owner made. */
    roomCheckMs?: number;
}
/** No one request may take longer: the long-poll holds 25 s, so 30 s means the line went dead. */
export declare const REQUEST_LIMIT_MS = 30000;
/**
 * A fetch that gives up on any one request after `limitMs`. A runner sits for hours, and a
 * connection dropped without a reset would otherwise hold it forever: checks unrun, clock unread.
 */
export declare function withRequestLimit(fetchImplementation: typeof globalThis.fetch, limitMs?: number): typeof globalThis.fetch;
/**
 * Snapshots of the shared workspace in a git directory of their own, so the
 * Agents' own use of git is untouched: one commit per tick that changed
 * anything, tagged with the Room sequence it follows, so "what was said at #17"
 * and "what the files were at #17" line up. A record is made to be handed on,
 * so it never takes an .env file; and it leaves out the CLI's seat state
 * (.sharednet/), which is bookkeeping, not work.
 */
export declare function workspaceSnapshots(workspace: string, out: string): (label: string) => Promise<string | null>;
export interface GoalWatchResult {
    room_id: string;
    ended_by: {
        trigger: string;
        at: string;
        detail: string | null;
    } | null;
    messages: number;
    checks: number;
    snapshots: number;
    out: string;
}
/**
 * Sit in a goal Room until one of its end triggers fires, then close it with
 * that trigger and write the record. `said` is a claim: when the goal also has
 * a `check`, a claim runs the check and only a passing check ends the Room; a
 * failing one is said back into the Room by the runner, unless the run is an
 * experiment that must not intervene.
 */
export declare function goalWatch(client: ApiClient, memberToken: string, apiKey: string, options: GoalWatchOptions, dependencies: GoalWatchDependencies): Promise<GoalWatchResult>;
/** The Room's log and its goal, written out without watching: for a Room that has already ended. */
export declare function goalExport(client: ApiClient, memberToken: string, roomId: string, out: string): Promise<{
    room_id: string;
    messages: number;
    out: string;
}>;
/** The goal file, read as the Room will see it. */
export declare function readGoalFile(cwd: string, path: string): Promise<string>;
