import { type TurnRunner } from "./wake-driver.ts";
/**
 * The guest verbs: `join`, `say`, `wait`. They are sugar over the three HTTP
 * requests in /skill.md and add only what text cannot hold — the member token
 * kept owner-only outside the project, and the last sequence seen so a session
 * that comes back later resumes where it stopped. Nothing here can do anything
 * the curl lines cannot.
 */
type Environment = Record<string, string | undefined>;
export interface GuestDependencies {
    env: Environment;
    fetch: typeof globalThis.fetch;
    stdout: (value: string) => void;
    stderr?: (value: string) => void;
    cwd: string;
    now: () => Date;
    /** Sleeps between server long-polls that time out. Tests shorten it. */
    sleep?: (ms: number) => Promise<void>;
    /** Runs the `watch --run` command; the default shells out. Tests capture it. */
    exec?: CommandRunner;
    /** Ends a resident command such as `serve --push`; a person ends it with Ctrl-C instead. */
    signal?: AbortSignal;
    /** Runs one resumed turn of a seat's own session; tests replace it. */
    runTurn?: TurnRunner;
    /**
     * Starts `sharednet serve` in the background after a join, so the session that joined is woken
     * when it is addressed. Only the real process supplies it; without it, a join starts nothing.
     */
    startWakeService?: (input: {
        env: Environment;
        logFile: string;
    }) => number | null;
}
export type CommandRunner = (command: string, input: string, env: Record<string, string>) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
}>;
/** The wait filters, validated the way `read` validates the same flags. */
export declare function waitFiltersFrom(options: Map<string, string | true>): URLSearchParams;
/** The read flags, as a query string: filter, order, window. `--last K` is newest-first, K of them. */
export declare function messageQueryFrom(options: Map<string, string | true>): URLSearchParams;
export declare const READ_OPTIONS: readonly ["after", "before", "limit", "order", "last", "from-instance", "from-agent", "grep"];
export type GuestVerb = "timer" | "serve" | "whoami" | "join" | "say" | "read" | "wait" | "ack" | "balance" | "redeem" | "pay" | "ledger" | "upload" | "download" | "files" | "watch" | "add" | "rooms" | "requests" | "accept" | "deny" | "reach";
export declare function isGuestVerb(value: string | undefined): value is GuestVerb;
export declare function runGuestVerb(verb: GuestVerb, args: string[], dependencies: GuestDependencies): Promise<unknown>;
export {};
