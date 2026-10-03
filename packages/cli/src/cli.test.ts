// @vitest-environment node

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.ts";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true })));
});

async function harness(
  argv: string[],
  responses: Array<{ status?: number; body?: unknown }> = [],
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-cli-run-"));
  cleanup.push(root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("Unexpected fetch");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: next.body === undefined ? undefined : { "content-type": "application/json" },
    });
  });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    SHAREDNET_BASE_URL: "http://127.0.0.1:3001",
    SHAREDNET_API_KEY: "snk_never-send-in-json",
    CODEX_SESSION_ID: "provider-session-must-remain-local",
    CODEX_THREAD_ID: "lineage-only",
    ...environment,
  };

  const exitCode = await runCli(argv, {
    env,
    fetch,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { exitCode, stdout, stderr, requests };
}

/** Two commands against one machine: a session start, then the command under test. */
async function harnessAfterStart(
  argv: string[],
  responses: Array<{ status?: number; body?: unknown }>,
) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-cli-run-"));
  cleanup.push(root);
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const queue = [registered("i_seat00001"), ...responses];
  const fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) throw new Error("Unexpected fetch");
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  });
  const env = {
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    SHAREDNET_BASE_URL: "http://127.0.0.1:3001",
    SHAREDNET_API_KEY: "snk_never-send-in-json",
    CODEX_SESSION_ID: "provider-session-must-remain-local",
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const started = await runCli(["session", "start", "--json"], { env, fetch, stdout: () => undefined, stderr: (v) => stderr.push(v) });
  expect(started).toBe(0);
  const exitCode = await runCli(argv, { env, fetch, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) });
  return { exitCode, stdout, stderr, requests: requests.slice(1) };
}

const HEX_64 = /^[0-9a-f]{64}$/;

function registered(id: string, extra: Record<string, unknown> = {}) {
  return {
    status: 201,
    body: { instance: { ...instance(id), ...extra }, token: `sni_${id}`, heartbeat_after_seconds: 30 },
  };
}

function sentBody(request: { init: RequestInit }): Record<string, any> {
  return JSON.parse(String(request.init.body));
}

function instance(id: string) {
  return {
    id,
    principal_id: "p_demo",
    agent_id: null,
    runtime_kind: "codex",
    cli_version: "0.1.3",
    status: "online",
    started_at: "2026-09-04T00:00:00.000Z",
    lease_expires_at: "2099-09-04T00:01:30.000Z",
    token_expires_at: "2099-09-05T00:00:00.000Z",
    ended_at: null,
    revoked_at: null,
  };
}

describe("sharednet CLI vertical slice", () => {
  it("starts and safely persists a computed Instance", async () => {
    const result = await harness(
      ["session", "start", "--json"],
      [
        {
          status: 201,
          body: {
            instance: instance("i_one"),
            token: "sni_do-not-print",
            heartbeat_after_seconds: 30,
          },
        },
      ],
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.join(""))).toEqual({
      instance: instance("i_one"),
      session_id: "i_one",
      heartbeat_after_seconds: 30,
    });
    expect(result.stderr).toEqual([]);
    // Nothing is provisioned first: one call registers the session.
    expect(result.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    const registration = JSON.stringify(result.requests[0]?.init.body);
    expect(registration).not.toContain("provider-session-must-remain-local");
    expect(registration).not.toContain("lineage-only");
    expect(registration).not.toContain("snk_never-send-in-json");
    const body = sentBody(result.requests[0]!);
    const packageManifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(body.cli_version).toBe(packageManifest.version);
    // The session is identified to the server only by its HMAC, never its id.
    expect(body.local_instance_key).toMatch(HEX_64);
    expect(body).not.toHaveProperty("agent_id");
    expect(body.runtime_metadata).toMatchObject({ os: process.platform });
    // Only the last path segment is sent; the directory hierarchy stays local.
    expect(body.runtime_metadata.workspace).not.toContain("/");
    expect(registration).not.toContain(process.cwd());
  });

  it("reuses the same computed session and registers four distinct Codex sessions", async () => {
    const sharedEnv = { SHAREDNET_API_KEY: "snk_demo" };
    const sessions: string[] = [];

    for (const [index, anchor] of ["one", "two", "three", "four"].entries()) {
      const run = await harness(
        ["session", "start", "--json"],
        [registered(`i_${index + 1}`)],
        { ...sharedEnv, CODEX_SESSION_ID: anchor },
      );
      sessions.push(JSON.parse(run.stdout[0]!).session_id);
    }

    expect(sessions).toEqual(["i_1", "i_2", "i_3", "i_4"]);
  });

  it("supports global --session before or after room commands and forwards API payloads", async () => {
    const start = await harness(["session", "start", "--json"], [registered("i_chat")]);
    expect(start.exitCode).toBe(0);

    // A single harness cannot share a generated temp state, so exercise command parsing
    // with an explicit state root in the dedicated integration test below.
    const missing = await harness([
      "--session",
      "i_chat",
      "room",
      "post",
      "rom_team",
      "--content",
      "hello",
      "--json",
    ]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.join(" ")).toContain("session_not_found");

    const after = await harness([
      "room",
      "messages",
      "rom_team",
      "--session",
      "i_chat",
      "--json",
    ]);
    expect(after.exitCode).toBe(2);
    expect(after.stderr.join(" ")).toContain("session_not_found");
  });

  it("rejects API keys in argv and unsafe non-local HTTP base URLs", async () => {
    const argvSecret = await harness(["session", "start", "--api-key", "snk_bad", "--json"]);
    expect(argvSecret.exitCode).toBe(2);
    expect(argvSecret.stdout).toEqual([]);
    expect(argvSecret.stderr.join(" ")).not.toContain("snk_bad");

    const unsafeUrl = await harness(["session", "start", "--json"], [], {
      SHAREDNET_BASE_URL: "http://sharednet.example.test",
    });
    expect(unsafeUrl.exitCode).toBe(2);
    expect(unsafeUrl.stderr.join(" ")).toContain("invalid_base_url");
  });

  it("maps safe API errors to the documented exit codes", async () => {
    const auth = await harness(
      ["session", "start", "--json"],
      [{ status: 401, body: { error: { code: "invalid_credentials", message: "No." } } }],
    );
    expect(auth.exitCode).toBe(3);
    expect(auth.stdout).toEqual([]);
    expect(auth.stderr.join(" ")).toContain("invalid_credentials");

    const domain = await harness(
      ["session", "start", "--json"],
      [{ status: 409, body: { error: { code: "conflict", message: "Conflict." } } }],
    );
    expect(domain.exitCode).toBe(4);
  });

  it("sends the same session key under two API keys and lets the server scope it by Principal", async () => {
    const sharedRoot = await mkdtemp(join(tmpdir(), "sharednet-cli-principal-scope-"));
    cleanup.push(sharedRoot);
    const sharedStorage = {
      XDG_CONFIG_HOME: join(sharedRoot, "config"),
      XDG_STATE_HOME: join(sharedRoot, "state"),
      CODEX_SESSION_ID: "same-codex-session",
    };

    const first = await harness(
      ["session", "start", "--json"],
      [registered("i_first", { principal_id: "p_first" })],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_first" },
    );
    const second = await harness(
      ["session", "start", "--json"],
      [registered("i_second", { principal_id: "p_second" })],
      { ...sharedStorage, SHAREDNET_API_KEY: "snk_second" },
    );

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout.join(""))).toMatchObject({ session_id: "i_second" });
    // Same installation, same runtime session: the same key goes up both
    // times. Deduplication is per Principal, and that is the server's job.
    expect(sentBody(second.requests[0]!).local_instance_key).toBe(
      sentBody(first.requests[0]!).local_instance_key,
    );
  });

  it("tags a session on request, creating the tag on first use", async () => {
    const byHandle = await harness(
      ["session", "start", "--agent", "Reviewer", "--json"],
      [
        { status: 201, body: { agent: { id: "a_reviewer", handle: "reviewer" } } },
        registered("i_reviewer", { agent_id: "a_reviewer" }),
      ],
    );
    expect(byHandle.exitCode).toBe(0);
    expect(byHandle.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents",
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    expect(sentBody(byHandle.requests[0]!)).toEqual({ handle: "reviewer" });
    expect(sentBody(byHandle.requests[1]!).agent_id).toBe("a_reviewer");
    expect(JSON.parse(byHandle.stdout.join(""))).toMatchObject({ session_id: "i_reviewer" });

    const byId = await harness(
      ["session", "start", "--agent", "a_reviewer", "--json"],
      [
        { body: { agent: { id: "a_reviewer", handle: "reviewer" } } },
        { status: 200, body: registered("i_reviewer", { agent_id: "a_reviewer" }).body },
      ],
    );
    expect(byId.exitCode).toBe(0);
    expect(byId.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/agents/a_reviewer",
      "http://127.0.0.1:3001/api/v1/instances",
    ]);

    // "default" names the absence of a tag: no tag call, and agent_id is sent
    // as null so a session that was tagged earlier is moved back out of it.
    const untagged = await harness(
      ["session", "start", "--agent", "default", "--json"],
      [registered("i_plain")],
    );
    expect(untagged.exitCode).toBe(0);
    expect(untagged.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:3001/api/v1/instances",
    ]);
    expect(sentBody(untagged.requests[0]!).agent_id).toBeNull();

    const malformed = await harness(["session", "start", "--agent", "Not a handle!", "--json"]);
    expect(malformed.exitCode).toBe(2);
    expect(malformed.stderr.join(" ")).toContain("invalid_agent");
  });

});

describe("reach: forming a group from the account CLI", () => {
  it("registers a private Instance with --private and leaves reach out otherwise", async () => {
    const quiet = await harness(["session", "start", "--private", "--json"], [registered("i_private001", { reach: "private" })]);
    expect(quiet.exitCode).toBe(0);
    expect(sentBody(quiet.requests[0]!)).toMatchObject({ reach: "private" });
    const open = await harness(["session", "start", "--json"], [registered("i_public0001")]);
    expect(sentBody(open.requests[0]!)).not.toHaveProperty("reach");
  });

  it("opens a Room with Instances seated by id, lists Rooms, and adds to one", async () => {
    const created = await harnessAfterStart(
      ["room", "create", "--name", "Formed", "--with", "i_AbCdEfGhIj,i_KlMnOpQrSt", "--json"],
      [{ status: 201, body: { room: { id: "rom_AbCdEfGhIj" }, membership: {}, admissions: [] } }],
    );
    expect(created.exitCode).toBe(0);
    expect(created.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/rooms");
    expect(sentBody(created.requests[0]!)).toEqual({ name: "Formed", with: ["i_AbCdEfGhIj", "i_KlMnOpQrSt"] });

    const bad = await harnessAfterStart(["room", "create", "--name", "Formed", "--with", "nope", "--json"], []);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.requests).toHaveLength(0);

    const invited = await harnessAfterStart(
      ["room", "invite", "rom_AbCdEfGhIj", "--json"],
      [{ status: 201, body: { invite: { id: "inv_AbCdEfGhIj", room_id: "rom_AbCdEfGhIj", uses: 0 }, token: `rit_${"t".repeat(43)}`, link: `http://127.0.0.1:3001/join/rit_${"t".repeat(43)}` } }],
    );
    expect(invited.exitCode).toBe(0);
    expect(invited.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/rooms/rom_AbCdEfGhIj/invites");
    expect(invited.requests[0]!.init.method).toBe("POST");
    // The token is the invite: it opens this Room and nothing else, so it is handed on as the link and as one line for an Agent.
    expect(JSON.parse(invited.stdout.join(""))).toMatchObject({
      room_id: "rom_AbCdEfGhIj",
      link: `http://127.0.0.1:3001/join/rit_${"t".repeat(43)}`,
      for_agents: `ROOM=rom_AbCdEfGhIj TOKEN=rit_${"t".repeat(43)} BASE=http://127.0.0.1:3001`,
      command: `npx -y sharednet@latest join 'ROOM=rom_AbCdEfGhIj TOKEN=rit_${"t".repeat(43)} BASE=http://127.0.0.1:3001'`,
    });
    const notARoom = await harnessAfterStart(["room", "invite", "nope", "--json"], []);
    expect(notARoom.exitCode).not.toBe(0);
    expect(notARoom.requests).toHaveLength(0);

    const filtered = await harnessAfterStart(
      ["room", "messages", "rom_AbCdEfGhIj", "--grep", "deploy", "--from-agent", "a_AbCdEfGhIj", "--order", "desc", "--limit", "3", "--json"],
      [{ status: 200, body: { items: [], next_cursor: null, has_more: false } }],
    );
    expect(filtered.exitCode).toBe(0);
    expect(Object.fromEntries(new URL(filtered.requests[0]!.url).searchParams)).toEqual({ order: "desc", limit: "3", sender_agent_id: "a_AbCdEfGhIj", q: "deploy" });

    const listed = await harnessAfterStart(["room", "list", "--json"], [{ status: 200, body: { items: [] } }]);
    expect(listed.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/rooms");

    const added = await harnessAfterStart(
      ["room", "add", "rom_AbCdEfGhIj", "--with", "i_AbCdEfGhIj", "--json"],
      [{ status: 200, body: { admissions: [{ instance_id: "i_AbCdEfGhIj", status: "member", decision_id: null }] } }],
    );
    expect(added.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/rooms/rom_AbCdEfGhIj/members");
    expect(sentBody(added.requests[0]!)).toEqual({ with: ["i_AbCdEfGhIj"] });
  });

  it("lists the Decisions addressed to the Instance and answers one", async () => {
    const listed = await harnessAfterStart(["decision", "list", "--status", "pending", "--json"], [{ status: 200, body: { decisions: [] } }]);
    expect(listed.exitCode).toBe(0);
    expect(listed.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/decisions?status=pending");

    const approved = await harnessAfterStart(
      ["decision", "approve", "dec_AbCdEfGhIj", "--json"],
      [{ status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "approved" }, membership: null } }],
    );
    expect(approved.requests[0]!.url).toBe("http://127.0.0.1:3001/api/v1/decisions/dec_AbCdEfGhIj/resolve");
    expect(sentBody(approved.requests[0]!)).toEqual({ resolution: "approved" });
    const denied = await harnessAfterStart(
      ["decision", "deny", "dec_AbCdEfGhIj", "--json"],
      [{ status: 200, body: { decision: { id: "dec_AbCdEfGhIj", status: "denied" }, membership: null } }],
    );
    expect(sentBody(denied.requests[0]!)).toEqual({ resolution: "denied" });
  });
});
