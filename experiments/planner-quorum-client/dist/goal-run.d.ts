import type { CoordinationOptions, CoordinationStatus, CoordinationSummary } from "./coordination.js";
import type { ApiClient } from "./api-client.ts";
import { type GoalWatchResult } from "./goal.ts";
/**
 * `goal run`: the goal Room, the Agents that work on it, and the runner that
 * ends it, in one command. Each Agent runs in its own Docker container, its
 * sandbox: its own processes, its own home, its own seat. The containers share
 * one thing, the workspace, mounted at /workspace in each. The checks run in
 * one more container, which has the workspace and nothing an Agent installed.
 * The owner's account key never enters any of them.
 * Each Agent works in turns. The runner holds every seat's wait, starts a
 * turn when the seat is woken, and resumes the same harness session, so every
 * Agent is woken by one policy and the record says when and by what.
 */
export type Driver = "codex" | "claude-code";
export interface AgentSpec {
    /** The seat's name in the Room: the driver and a number, `codex-1`. */
    name: string;
    driver: Driver;
    model: string | null;
}
/** `--agent codex`, `--agent codex:gpt-6-luna`, `--agent claude-code:claude-sonnet-5-5`; repeat it for more seats. */
export declare function parseAgents(raws: readonly string[]): AgentSpec[];
export interface DockerResult {
    code: number;
    stdout: string;
    stderr: string;
}
/**
 * Runs `docker <args>`. `env` is added to the Docker client's own environment, which is how a
 * secret reaches a container (`-e NAME` with no value) without appearing in any argument list.
 * With `onLine`, stdout is handed over line by line as it comes and not kept.
 */
export type DockerRunner = (args: readonly string[], options?: {
    input?: string;
    env?: Record<string, string>;
    onLine?: (line: string) => void;
    timeoutMs?: number;
}) => Promise<DockerResult>;
export declare function dockerRunner(baseEnv: Record<string, string | undefined>): DockerRunner;
/** The image the Agents run in when no --image is given; built on first use. */
export declare const DEFAULT_IMAGE = "sharednet-goal-agents:1";
export declare const AGENT_DOCKERFILE = "FROM node:22-bookworm\nRUN apt-get update && apt-get install -y --no-install-recommends python3-pytest ripgrep && rm -rf /var/lib/apt/lists/*\nRUN npm install -g @openai/codex @anthropic-ai/claude-code && npm cache clean --force\nRUN mkdir -p /home/agents /workspace && chown node:node /home/agents /workspace\nUSER node\nWORKDIR /workspace\n";
/** One container of a run: an Agent's, named for its seat, or with no seat, the checks'. */
export declare function containerName(roomId: string, seat?: string): string;
/** Every container one run starts, so that whatever stops the run can remove them all. */
export declare function runContainers(roomId: string, agents: readonly Pick<AgentSpec, "name">[]): string[];
/**
 * The port of a development service on this machine's loopback, the one plain-HTTP address the CLI
 * accepts. Inside a container that address is the container's own, so the runner forwards the
 * same port to this machine in each Agent's container; the Agents then use the address the runner uses.
 */
export declare function loopbackPort(baseUrl: string): number | null;
export interface RunPlan {
    image: string;
    agents: AgentSpec[];
    workspace: string;
    /** This CLI's own package on this machine, mounted into each Agent's container so the Agents run the same version. */
    cli: {
        root: string;
        entry: string;
    };
    /** How the Codex seats sign in: an API key from this environment, or this machine's Codex login. */
    codexAuth: {
        kind: "api-key";
    } | {
        kind: "login";
        file: string;
    } | null;
    /** The variable that signs the Claude Code seats in, passed through by name. */
    claudeAuth: "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | null;
}
/** The package root of the CLI that is running: the directory with its package.json. */
export declare function cliPackage(entry: string): {
    root: string;
    entry: string;
};
/**
 * Everything goal run needs before it creates anything: Docker, the image, and a way for each
 * driver to sign in. A run that would fail half-way is refused here instead.
 */
export declare function prepareRun(input: {
    agents: AgentSpec[];
    image: string | null;
    workspace: string;
    env: Record<string, string | undefined>;
    home: string;
    entry: string;
}, docker: DockerRunner, log: (line: string) => void, pause?: (ms: number) => Promise<void>): Promise<RunPlan>;
export interface WakeShape {
    wake_id: string | null;
    fired: string[];
    messages: Array<{
        sequence: number;
        content: string;
        sender?: {
            member_id?: string;
            name?: string | null;
        };
    }>;
    events: Array<Record<string, unknown>>;
    from: number;
    through: number;
}
/** What one Agent is told first: who it is, the goal, how the Room ends, and how to speak. */
export declare function openingPrompt(input: {
    seat: AgentSpec;
    seats: AgentSpec[];
    roomId: string;
    goal: string;
    goalSequence: number;
    until: string[];
}): string;
/** What a woken Agent is told: everything said since its last turn. */
export declare function wakePrompt(wake: WakeShape): string;
/** One turn: a fresh harness run, or the same session resumed, with nothing asked of a person. */
/** Whether the Agents may search the web: on by default, off for a benchmark that forbids it. */
export type WebSearch = "live" | "off";
export declare function turnCommand(seat: AgentSpec, prompt: string, sessionId: string | null, webSearch?: WebSearch, turnLimitSeconds?: number): string[];
/** Tokens as a harness reports them: read fresh, read again from the cache, and written. */
export interface Usage {
    input: number;
    cached: number;
    output: number;
}
/**
 * What a budget is judged on: tokens read fresh plus tokens written. The cached context a harness
 * reads again on every model call is most of the raw count (93% in the first real run) at a tenth
 * of the price, so it is recorded and not counted.
 */
export declare function freshTokens(usage: Usage | null): number;
/** A Codex session file's own running total: exact, and it includes a turn that the end of the goal cut. */
export declare function codexSessionUsage(rollout: string): Usage | null;
export interface TurnReading {
    sessionId: string | null;
    /**
     * Codex: the session's running total as of this turn, since a resumed `codex exec` reports the
     * whole session's usage. Claude Code: this run's own usage.
     */
    usage: Usage | null;
    failed: boolean;
}
/** Reads a harness's JSON stream for what the runner needs: the session to resume, and the spend. */
export declare class TurnReader {
    readonly reading: TurnReading;
    private readonly driver;
    constructor(driver: Driver);
    line(text: string): void;
}
export interface SeatRecord {
    last_failure?: { exit_code: number; rate_limit_observed: boolean; harness_failed: boolean; turn: number } | null;
    name: string;
    driver: Driver;
    model: string | null;
    member_id: string | null;
    session_id: string | null;
    turns: number;
    failed_turns: number;
    /** Fresh tokens: what a budget counts. */
    tokens: number;
    usage: Usage;
}
export interface GoalRunInput {
    coordination?: CoordinationOptions;
    plan: RunPlan;
    roomId: string;
    inviteToken: string;
    goal: string;
    goalSequence: number;
    until: string[];
    baseUrl: string;
    out: string;
    checkEveryMs: number;
    quietChecks: boolean;
    /** `off` takes web search away from every Agent; the default is `live`. */
    webSearch?: WebSearch;
    /** The longest one turn may run; the default is 20 minutes. An experiment may set it to the run's own limit. */
    turnLimitMs?: number;
}
export interface GoalRunDependencies {
    docker: DockerRunner;
    now: () => Date;
    sleep?: (ms: number) => Promise<void>;
    stderr?: (line: string) => void;
}
export interface GoalRunResult extends GoalWatchResult {
    status?: CoordinationStatus;
    coordination?: CoordinationSummary;
    agents: SeatRecord[];
    tokens: number;
}
/** Creates nothing outside its containers and the record; the Room and its goal already exist. */
export declare function runGoal(client: ApiClient, memberToken: string, apiKey: string, input: GoalRunInput, dependencies: GoalRunDependencies): Promise<GoalRunResult>;
/** A record is made to be handed on: the seat's token and the harness's sign-in leave it. */
export declare function scrubHome(home: string): Promise<void>;
