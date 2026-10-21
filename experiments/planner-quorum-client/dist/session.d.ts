import { ApiClient } from "./api-client.ts";
import { type DetectedRuntime } from "./runtime-detection.ts";
import { type StoragePaths, type StoredSession } from "./storage.ts";
/**
 * Acting as an account: the stored credential, registering this session as an
 * Instance, keeping its lease alive. Shared by `session start`, the Room
 * commands, and `join` when a credential is present.
 */
type Environment = Record<string, string | undefined>;
export declare const CLI_VERSION: string;
export interface AgentShape {
    id: string;
    principal_id?: string;
    handle?: string;
}
export interface InstanceShape {
    id: string;
    principal_id: string;
    agent_id: string | null;
    started_at: string;
    lease_expires_at: string;
    token_expires_at?: string;
    expires_at?: string;
    [key: string]: unknown;
}
export interface InstanceStartPayload {
    instance: InstanceShape;
    token: string;
    heartbeat_after_seconds: number;
}
export interface CurrentInstancePayload {
    principal: unknown;
    agent: AgentShape | null;
    instance: InstanceShape;
}
export declare function resolveApiKey(env: Environment, paths: StoragePaths, baseUrl: string): Promise<string>;
/**
 * Resolves `--agent` to a tag. An `a_` id is fetched; anything else is a
 * handle and is created on first use, the way `git tag` behaves — the server's
 * POST is idempotent by handle, so one call covers both "exists" and "new".
 * `default` names the absence of a tag and resolves to nothing.
 */
export declare function resolveTag(client: ApiClient, apiKey: string, requested: string): Promise<AgentShape | null>;
/**
 * Where this session runs, for humans telling untagged sessions apart. It is
 * shown, never trusted: the server records it as diagnostics and nothing reads
 * it for authorization or grouping.
 *
 * Only the workspace's last path segment and the OS are sent. The full path is a
 * map of this machine — home directory, user name, client folders — and none of
 * that is needed to tell "the one in the sharednet folder" from the others. The
 * hostname is not sent either: a Mac is named after its owner by default, so it
 * names the person behind a seat, which is exactly what the path rule avoids.
 */
export declare function runtimeMetadata(env: Environment): Record<string, string>;
export declare function validateRuntime(value: string, from?: string): string;
/**
 * The runtime a harness declares for the seats it runs: `--runtime`, else
 * SHAREDNET_RUNTIME, which a hosted product sets once in the environment its
 * agents' commands run in. A handle with an optional `@version`, the shape of
 * the AI_AGENT convention (`dot`, `dot@2.1`). Null when nothing was declared.
 */
export declare function declaredRuntime(flag: string | undefined, env: Environment): {
    kind: string;
    version: string | null;
} | null;
/** What this CLI reports as its runtime: the harness's declaration, else the driver detected. */
export declare function resolveRuntime(env: Environment, flag?: string): DetectedRuntime;
export declare function storedSessionFromStart(baseUrl: string, localInstanceKey: string | null, payload: InstanceStartPayload): StoredSession;
export declare function selectSession(paths: StoragePaths, baseUrl: string, explicitId: string | undefined, env: Environment): Promise<StoredSession>;
export declare function refreshIfNeeded(client: ApiClient, paths: StoragePaths, session: StoredSession, now: Date): Promise<StoredSession>;
export interface RegisterInstanceOptions {
    /** `--runtime`: overrides the detected driver's name, never its session. SHAREDNET_RUNTIME when absent. */
    runtimeOverride?: string;
    /** `--new`: a fresh Instance even though the session was detected. */
    forceNew: boolean;
    /** `--agent`: a tag id or handle to group the Instance under. */
    agent?: string;
    /** Without a detected session and without `forceNew`, refuse (session start) or register fresh (join). */
    freshWhenUndetected: boolean;
    /** Sent as given; omitted, the server applies the Principal's default (public). */
    reach?: "public" | "private";
}
/**
 * Registers this session as an Instance of the account behind the stored
 * credential. A same-session re-registration comes back with the existing
 * Instance and a fresh token; a new session comes back created.
 */
export declare function registerInstance(env: Environment, fetchImplementation: typeof globalThis.fetch, paths: StoragePaths, baseUrl: string, options: RegisterInstanceOptions): Promise<{
    session: StoredSession;
    payload: InstanceStartPayload;
}>;
/** True when this machine can act as an account: a key in the environment or a stored credential for this origin. */
export declare function hasAccountCredential(env: Environment, paths: StoragePaths, baseUrl: string): Promise<boolean>;
export {};
