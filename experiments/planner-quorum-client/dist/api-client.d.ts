import { CliError } from "./errors.ts";
type Fetch = typeof globalThis.fetch;
/** Where SharedNet lives. The apex domain only redirects here. */
export declare const DEFAULT_BASE_URL = "https://www.sharednet.ai";
/**
 * One name per SharedNet. `sharednet.ai` and `www.sharednet.ai` are the same
 * service (the apex answers every request with a redirect to www), and a
 * credential written under one must match an invite that names the other,
 * or a machine that logged in would still join as nobody.
 */
export declare function canonicalOrigin(origin: string): string;
export declare function sameOrigin(left: string, right: string): boolean;
export declare function resolveBaseUrl(value: string | undefined): string;
export declare class ApiClient {
    readonly baseUrl: string;
    readonly fetch: Fetch;
    constructor(baseUrl: string, fetchImplementation?: Fetch);
    /**
     * Fetches bytes rather than JSON: an artifact's content. The digest the
     * server states travels beside them so the caller can check what it wrote.
     */
    requestBytes(path: string, credential: string): Promise<{
        bytes: Uint8Array;
        filename: string | null;
        sha256: string | null;
    }>;
    request<T>(method: string, path: string, credential: string, body?: unknown, requestHeaders?: Record<string, string>): Promise<T>;
}
export declare function transportError(error: unknown): CliError;
export {};
