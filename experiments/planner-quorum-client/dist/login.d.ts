import { type StoragePaths } from "./storage.ts";
/**
 * `sharednet login`: a device-style approval. The CLI starts a login, shows a
 * code and a URL, the human approves it in the Web, and the CLI polls until
 * it is handed an API key minted at that moment. Any anonymous seats this
 * machine holds are sent as proof of possession so the approval binds their
 * Principals to the account. Decision 2026-09-06 §3.
 */
type Environment = Record<string, string | undefined>;
export interface LoginDependencies {
    env: Environment;
    fetch: typeof globalThis.fetch;
    stdout: (value: string) => void;
    stderr: (value: string) => void;
    now: () => Date;
    sleep?: (ms: number) => Promise<void>;
    /** Opens a URL in the human's browser; the default shells out. */
    openBrowser?: (url: string) => Promise<boolean>;
}
/** The key stays in the credential file, owner-only; the terminal sees only ids. */
export declare function storeAccountCredential(paths: StoragePaths, baseUrl: string, result: {
    principal: {
        id: string;
    };
    api_key_id: string;
    api_key: string;
}, now: Date): Promise<void>;
export declare function login(args: string[], dependencies: LoginDependencies): Promise<unknown>;
export {};
