import { CliError, asCliError, localError } from "./errors.ts";

type Fetch = typeof globalThis.fetch;

interface ApiErrorEnvelope {
  error?: {
    code?: unknown;
    message?: unknown;
    request_id?: unknown;
  };
}

/** Where SharedNet lives. The apex domain only redirects here. */
export const DEFAULT_BASE_URL = "https://www.sharednet.ai";

/**
 * One name per SharedNet. `sharednet.ai` and `www.sharednet.ai` are the same
 * service (the apex answers every request with a redirect to www), and a
 * credential written under one must match an invite that names the other,
 * or a machine that logged in would still join as nobody.
 */
export function canonicalOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    if (url.hostname === "sharednet.ai") url.hostname = "www.sharednet.ai";
    return url.origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

export function sameOrigin(left: string, right: string): boolean {
  return canonicalOrigin(left) === canonicalOrigin(right);
}

export function resolveBaseUrl(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw localError("invalid_base_url", "SHAREDNET_BASE_URL is not a valid URL.");
  }
  const localHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localHttp) {
    throw localError(
      "invalid_base_url",
      "SharedNet requires HTTPS except for 127.0.0.1 development servers.",
    );
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw localError("invalid_base_url", "SHAREDNET_BASE_URL must be an origin.");
  }
  return canonicalOrigin(url.origin);
}

function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : "api_error";
}

export class ApiClient {
  readonly baseUrl: string;
  readonly fetch: Fetch;

  constructor(baseUrl: string, fetchImplementation: Fetch = globalThis.fetch) {
    this.baseUrl = resolveBaseUrl(baseUrl);
    this.fetch = fetchImplementation;
  }

  /**
   * Fetches bytes rather than JSON: an artifact's content. The digest the
   * server states travels beside them so the caller can check what it wrote.
   */
  async requestBytes(
    path: string,
    credential: string,
  ): Promise<{ bytes: Uint8Array; filename: string | null; sha256: string | null }> {
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        method: "GET",
        headers: credential ? { authorization: `Bearer ${credential}` } : {},
      });
    } catch {
      throw new CliError("service_unavailable", "The SharedNet service could not be reached.", 5);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let code = "request_failed";
      let message = "SharedNet refused the request.";
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
        code = parsed.error?.code ?? code;
        message = parsed.error?.message ?? message;
      } catch {
        /* A body that is not our error envelope tells us nothing more. */
      }
      throw new CliError(code, message, response.status >= 500 ? 5 : 4);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const named = /filename\*=UTF-8''([^;]+)/.exec(disposition);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      filename: named ? decodeURIComponent(named[1]!) : null,
      sha256: response.headers.get("x-sharednet-sha256"),
    };
  }

  async request<T>(
    method: string,
    path: string,
    credential: string,
    body?: unknown,
    requestHeaders: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    // Bytes go up as they are; anything else is JSON.
    const raw = body instanceof Uint8Array;
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          // A public route is called with an empty credential and no header.
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          ...(body === undefined || raw ? {} : { "content-type": "application/json" }),
          ...requestHeaders,
        },
        ...(body === undefined ? {} : { body: raw ? (body as unknown as BodyInit) : JSON.stringify(body) }),
      });
    } catch {
      throw new CliError(
        "service_unavailable",
        "The SharedNet service could not be reached.",
        5,
      );
    }

    if (response.ok) {
      if (response.status === 204) return undefined as T;
      try {
        return (await response.json()) as T;
      } catch {
        throw new CliError(
          "invalid_server_response",
          "The SharedNet service returned an invalid response.",
          5,
        );
      }
    }

    let envelope: ApiErrorEnvelope = {};
    try {
      envelope = (await response.json()) as ApiErrorEnvelope;
    } catch {
      // Status and a bounded local message are enough; never echo arbitrary bodies.
    }
    const code = safeErrorCode(envelope.error?.code);
    const requestId =
      typeof envelope.error?.request_id === "string" &&
      /^req_[A-Za-z0-9_-]+$/.test(envelope.error.request_id)
        ? envelope.error.request_id
        : undefined;
    if (response.status === 401) {
      throw new CliError(code, "SharedNet authentication failed.", 3, requestId);
    }
    if (code === "cli_upgrade_required") {
      const message = typeof envelope.error?.message === "string" && envelope.error.message.length < 400 ? envelope.error.message : "This SharedNet CLI is too old.";
      throw new CliError(code, message, 4, requestId);
    }
    if (response.status >= 400 && response.status < 500) {
      throw new CliError(code, "SharedNet rejected the request.", 4, requestId);
    }
    throw new CliError(code, "The SharedNet service is unavailable.", 5, requestId);
  }
}

export function transportError(error: unknown): CliError {
  return asCliError(error);
}
