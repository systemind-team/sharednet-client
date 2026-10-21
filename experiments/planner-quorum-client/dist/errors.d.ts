export type CliExitCode = 2 | 3 | 4 | 5;
export declare class CliError extends Error {
    readonly code: string;
    readonly exitCode: CliExitCode;
    readonly requestId?: string;
    constructor(code: string, message: string, exitCode: CliExitCode, requestId?: string);
}
export declare function localError(code: string, message: string): CliError;
export declare function asCliError(error: unknown): CliError;
