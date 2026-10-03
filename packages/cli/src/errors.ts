export type CliExitCode = 2 | 3 | 4 | 5;

export class CliError extends Error {
  readonly code: string;
  readonly exitCode: CliExitCode;
  readonly requestId?: string;

  constructor(
    code: string,
    message: string,
    exitCode: CliExitCode,
    requestId?: string,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.requestId = requestId;
  }
}

export function localError(code: string, message: string): CliError {
  return new CliError(code, message, 2);
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  return new CliError(
    "service_unavailable",
    "SharedNet could not complete the request.",
    5,
  );
}
