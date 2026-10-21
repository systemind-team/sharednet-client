/**
 * Waking the session that took a seat (wait, the drivers).
 *
 * A seat joined from inside a Codex or Claude Code session remembers that session: the harness's
 * own session id, the directory it worked in, and the harness command. When the seat is addressed
 * in its Room — by a member, a hook or the clock, always as an @ line — `sharednet serve` resumes
 * that same session with what was said, so the agent answers knowing everything it knew when it
 * joined, and posts the turn's last message as the seat's reply. Nothing here starts a fresh agent:
 * a seat with no session to resume is not driven.
 *
 * The reply is relayed rather than left to the agent because a resumed turn may not reach the Room
 * itself: `codex exec resume` runs read-only and offline unless told otherwise, and `claude -p` may
 * not be allowed to run commands. Relaying makes answering depend on nothing but the turn finishing.
 *
 * Verified on 2026-10-05 with Codex 0.160.0: inside a session CODEX_SESSION_ID is the thread id that
 * `codex exec resume` takes, and the resumed thread remembers its earlier turns. Claude Code exports
 * CLAUDE_CODE_SESSION_ID, which `claude -p --resume` takes; that needs the `claude` command signed in.
 */
type Environment = Record<string, string | undefined>;
export type WakeDriver = "codex" | "claude-code";
export interface SeatWake {
    driver: WakeDriver;
    /** The harness's own session id: what `codex exec resume` and `claude --resume` take. */
    session: string;
    /** Where the session worked when it joined; a resumed turn runs there. */
    cwd: string;
    /** The harness command, resolved on the joining session's PATH when it could be. */
    command: string;
    /** Codex finds a session only under the CODEX_HOME it was started with. */
    codex_home?: string;
}
/** The session this process runs in, when it is one a wake can resume. */
export declare function seatWakeFrom(env: Environment, cwd: string): SeatWake | null;
/** A stored wake, or nothing: a seat file with a damaged wake is still a seat, just not driven. */
export declare function parseSeatWake(value: unknown): SeatWake | undefined;
export declare function harnessFreeEnv(env: Environment): Record<string, string>;
/** True inside a harness sandbox, where a background service would inherit the sandbox. */
export declare function sandboxed(env: Environment): boolean;
interface WakeMessage {
    sequence: number;
    content: string;
    sender?: {
        member_id?: string;
        name?: string | null;
        kind?: string;
    };
}
/** What a turn ends with when it has nothing to say back; nothing is posted then. */
export declare const NO_REPLY = "(no reply)";
/** What a resumed session is told: where it was addressed, and everything said since its last turn. */
export declare function wakeTurnPrompt(input: {
    roomId: string;
    seat: string;
    memberId: string;
    messages: WakeMessage[];
    from: number;
    through: number;
}): string;
export interface TurnSpec {
    command: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    /** The prompt, on standard input, so no length or quoting limit applies. */
    input: string;
    timeoutMs: number;
}
export interface TurnOutcome {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}
export type TurnRunner = (spec: TurnSpec) => Promise<TurnOutcome>;
/**
 * Whether the person chose a sandbox for Codex: a top-level `sandbox_mode` in its config.toml. A
 * profile's choice applies only to runs that name the profile, so it does not count.
 */
export declare function codexSandboxChosen(codexHome: string): boolean;
/** One resumed turn of the seat's own session, asking nothing of a person. */
export declare function turnSpec(wake: SeatWake, prompt: string, env: Environment, memberId: string, timeoutMs: number): TurnSpec;
/** The reply a finished turn leaves for the Room, or null when it chose to say nothing. */
export declare function replyFrom(said: string | null, limitBytes: number): string | null;
/** How the turn went, read off the harness's own JSON: whether it finished, and its last words. */
export declare function turnSummary(driver: WakeDriver, stdout: string): {
    ok: boolean;
    said: string | null;
};
export declare const runTurn: TurnRunner;
/**
 * Starts `sharednet serve` in the background, out of the joining session's process group so it
 * outlives the session's command, writing to `logFile`. The pid, or null when it did not start.
 */
export declare function startWakeService(input: {
    env: Environment;
    logFile: string;
    entry: string;
    execPath: string;
    execArgv: readonly string[];
}): number | null;
export {};
