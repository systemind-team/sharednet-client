/**
 * Which coding-agent driver is running this CLI, read off the driver's own
 * environment. Everything here is diagnostic: it names the seat on the Web and
 * picks its icon, and the session anchor feeds the local Instance key. Nothing
 * is trusted for authorization.
 *
 * Markers verified on 2026-09-06 on macOS:
 *   Claude Code   CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT
 *                 (claude-desktop | cli), CLAUDE_AGENT_SDK_VERSION
 *   Codex CLI     CODEX_SESSION_ID, CODEX_THREAD_ID (lineage, not a session),
 *                 CODEX_CI=1 under `codex exec`; parent process is `codex`
 * The OpenCode, OpenHands, Gemini CLI and Cursor markers below are taken from
 * their documentation and not yet verified on a machine; the parent-process
 * fallback covers a driver whose variables differ.
 *
 * Muse, Meta's hosted personal agent, runs every command in a "runtime cell"
 * whose environment the host renders: JARVIS_HOME=/home/hatch and
 * JARVIS_BIN_DIR=/opt/hatch/bin among it (`opt/hatch/runtime-cell/guest.env`
 * in the unofficial archive win4r/MuseAI-Skills). The cell's machine name,
 * htch-runtime, is the one marker production has shown: the three Muse seats
 * taken before Muse was recognised reported it, with the workspace `hatch`.
 */
export type RuntimeSource = "detected" | "declared";
export interface DetectedRuntime {
    /** A handle such as `claude-code`; `custom` when nothing was recognised. */
    kind: string;
    /** The driver's exact session id, kept on this machine and only ever HMACed. */
    anchor: string | null;
    version: string | null;
    entrypoint: string | null;
    source: RuntimeSource;
    /**
     * The parent process name when nothing matched at all. Detection can only
     * recognise drivers someone wrote down, so the unrecognised ones used to
     * vanish into `custom` and take the evidence with them. Reporting the name
     * turns "which drivers are we missing?" from a guess into a query over
     * `runtime_metadata`. Absent whenever detection succeeded.
     */
    unrecognisedParent?: string | null;
    /**
     * Set when a harness declared the runtime: the driver detection found
     * underneath it. A ChatGPT dot runs Codex on its cloud computer, so a seat
     * it takes is the dot's, and Codex is the evidence of how — kept beside the
     * declaration rather than lent to it as a version or an entrypoint.
     */
    detectedDriver?: string;
}
type Environment = Record<string, string | undefined>;
/**
 * The nearest ancestor process that is a known driver, or null. A CLI run
 * from a Codex shell inside a Claude Code session has both drivers'
 * variables in its environment; the process tree says which one is actually
 * running it.
 */
export declare function nearestDriverAncestor(startPid?: number): string | null;
/** The name of the process that launched this one, or null when it cannot be read. */
export declare function parentProcessName(ppid?: number): string | null;
export declare function detectRuntime(env: Environment, options?: {
    parentProcess?: () => string | null;
    ancestorDriver?: () => string | null;
    hostname?: () => string | null;
}): DetectedRuntime;
export declare function isRuntimeKind(value: string): boolean;
/**
 * A runtime the harness declared — `--runtime`, or SHAREDNET_RUNTIME in the
 * environment it runs its agents in — names the seat in place of the driver
 * detected under it. Declaring what was detected changes nothing. Declaring
 * anything else is the harness's word, not something read off a driver, so it
 * is reported as declared, carries only the version the declaration gave, and
 * holds no session anchor: the anchor belongs to the detected driver, which is
 * why `--runtime` has always needed `--new` to name something else.
 */
export declare function declareRuntime(detected: DetectedRuntime, declared: {
    kind: string;
    version: string | null;
}): DetectedRuntime;
/** The diagnostic fields a detected driver contributes to an Instance's metadata. */
export declare function runtimeMetadataOf(runtime: DetectedRuntime): Record<string, string>;
export {};
