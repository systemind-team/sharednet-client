export class CliError extends Error {
    code;
    exitCode;
    requestId;
    constructor(code, message, exitCode, requestId) {
        super(message);
        this.name = "CliError";
        this.code = code;
        this.exitCode = exitCode;
        this.requestId = requestId;
    }
}
export function localError(code, message) {
    return new CliError(code, message, 2);
}
export function asCliError(error) {
    if (error instanceof CliError)
        return error;
    return new CliError("service_unavailable", "SharedNet could not complete the request.", 5);
}
