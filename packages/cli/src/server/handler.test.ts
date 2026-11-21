// @vitest-environment node

import { describe, expect, it } from "vitest";

import { DISCOVERY_DOCUMENT, digestSecret, pushSignature, type PrincipalId, type RoomId } from "../protocol/index.ts";
import { handleRequest } from "./handler.ts";
import { tick } from "./push.ts";
import { MemorySharedNetRepository } from "./memory-repository.ts";
import { REPLY_FRESH_MS, REPLY_LEASE_MS } from "./replying.ts";

const DEV_KEY = `snk_${"a".repeat(43)}`;
const OTHER_KEY = `snk_${"b".repeat(43)}`;

function makeStore() {
  return new MemorySharedNetRepository({
    devApiKey: DEV_KEY,
    now: () => new Date("2026-09-04T10:20:30.123Z"),
  });
}

function request(
  store: MemorySharedNetRepository,
  path: string,
  init: RequestInit = {},
) {
  return handleRequest(new Request(`http://127.0.0.1:3001${path}`, init), store);
}

function apiHeaders(extra: Record<string, string> = {}, key = DEV_KEY) {
  return {
    authorization: `Bearer ${key}`,
    ...extra,
  };
}

function instanceHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function json(response: Response) {
  return response.json() as Promise<Record<string, any>>;
}

async function createAgent(store: MemorySharedNetRepository, handle: string) {
  const response = await request(store, "/api/v1/agents", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ handle }),
  });
  expect([200, 201]).toContain(response.status);
  return { status: response.status, agent: (await json(response)).agent };
}

type StartBody = {
  runtime_kind?: string;
  cli_version?: string;
  agent_id?: string | null;
  local_instance_key?: string;
  runtime_metadata?: Record<string, string>;
  reach?: "public" | "private";
};

async function startInstance(
  store: MemorySharedNetRepository,
  body: StartBody = {},
  expectedStatus: 200 | 201 = 201,
) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
  });
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return json(response);
}

/** Registers an Instance under a specific key: a second Principal, with a body. */
async function startWithKey(store: MemorySharedNetRepository, key: string, body: StartBody = {}) {
  const response = await request(store, "/api/v1/instances", {
    method: "POST",
    headers: apiHeaders({ "content-type": "application/json" }, key),
    body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
  });
  expect(response.status).toBe(201);
  return json(response);
}

const SESSION_KEY = "a".repeat(64);
const OTHER_SESSION_KEY = "b".repeat(64);

describe("SharedNet V1 HTTP handler", () => {
  it("publishes the exact discovery document", async () => {
    const response = await request(makeStore(), "/api/v1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(DISCOVERY_DOCUMENT);
  });

  it("lists only the caller's non-revoked Instances through either credential", async () => {
    const store = new MemorySharedNetRepository({
      devApiKeys: [DEV_KEY, OTHER_KEY],
      now: () => new Date("2026-09-04T10:20:30.123Z"),
    });
    const { agent } = await createAgent(store, "planner");
    const first = await startInstance(store, {
      runtime_kind: "codex",
      agent_id: agent.id,
      local_instance_key: SESSION_KEY,
    });
    const second = await startInstance(store, {
      runtime_kind: "claude-code",
      local_instance_key: OTHER_SESSION_KEY,
    });
    const foreign = await startWithKey(store, OTHER_KEY, {
      runtime_kind: "opencode",
      local_instance_key: "c".repeat(64),
    });

    const byAccount = await request(store, "/api/v1/instances", {
      headers: apiHeaders(),
    });
    expect(byAccount.status).toBe(200);
    expect(byAccount.headers.get("cache-control")).toContain("no-store");
    const accountBody = await json(byAccount);

    const byInstance = await request(store, "/api/v1/instances", {
      headers: instanceHeaders(first.token),
    });
    expect(byInstance.status).toBe(200);
    expect(await json(byInstance)).toEqual(accountBody);
    expect(accountBody.instances).toHaveLength(2);
    expect(new Set(accountBody.instances.map((item: { instance_id: string }) => item.instance_id)))
      .toEqual(new Set([second.instance.id, first.instance.id]));
    expect(accountBody.instances).not.toContainEqual(
      expect.objectContaining({ instance_id: foreign.instance.id }),
    );
    expect(accountBody.instances).toEqual(expect.arrayContaining([
      {
        instance_id: second.instance.id,
        name: "claude-code",
        agent: null,
        driver: "claude-code",
        state: "online",
        detail: "listening",
        last_seen_at: second.instance.last_seen_at,
      },
      {
        instance_id: first.instance.id,
        name: "planner",
        agent: { agent_id: agent.id, name: "planner" },
        driver: "codex",
        state: "online",
        detail: "listening",
        last_seen_at: first.instance.last_seen_at,
      },
    ]));
    expect(JSON.stringify(accountBody)).not.toContain("runtime_metadata");
  });

  it("requires a Principal credential and rejects query parameters for the Instance directory", async () => {
    const store = makeStore();
    expect((await request(store, "/api/v1/instances")).status).toBe(401);
    expect(
      (await request(store, "/api/v1/instances?include=foreign", { headers: apiHeaders() })).status,
    ).toBe(400);
  });

  it("marks only an unacknowledged driven-turn heartbeat as working", async () => {
    const store = new MemorySharedNetRepository({
      devApiKey: DEV_KEY,
      now: () => new Date("2026-09-04T10:20:30.123Z"),
    });
    const host = await startInstance(store);
    const worker = await startInstance(store, { local_instance_key: SESSION_KEY });
    const hostAuth = await store.authenticateInstance(host.token);
    const workerAuth = await store.authenticateInstance(worker.token);
    expect(hostAuth).not.toBeNull();
    expect(workerAuth).not.toBeNull();
    const { room } = await store.createRoom(hostAuth!, {
      name: "Aicoo task",
      with: [worker.instance.id],
    });
    const { message } = await store.postMessage(hostAuth!, room.id, {
      content: `@${worker.instance.id} please work`,
    });
    await store.markDelivered(workerAuth!, room.id, message.sequence);
    expect((await store.heartbeatSubscription(workerAuth!, room.id, message.sequence)).renewed).toBe(true);

    const active = await json(await request(store, "/api/v1/instances", { headers: apiHeaders() }));
    expect(active.instances).toContainEqual(expect.objectContaining({
      instance_id: worker.instance.id,
      state: "working",
      detail: "replying in Aicoo task",
    }));

    await store.acknowledge(workerAuth!, room.id, message.sequence);
    const settled = await json(await request(store, "/api/v1/instances", { headers: apiHeaders() }));
    expect(settled.instances).toContainEqual(expect.objectContaining({
      instance_id: worker.instance.id,
      state: "online",
      detail: "listening",
    }));
  });

  it("registers four independent untagged Instances with nothing provisioned first", async () => {
    const store = makeStore();

    const registrations = await Promise.all(
      Array.from({ length: 4 }, () => startInstance(store)),
    );

    expect(new Set(registrations.map(({ instance }) => instance.id)).size).toBe(4);
    expect(new Set(registrations.map(({ token }) => token)).size).toBe(4);
    // A fresh Instance is untagged: there is no default Agent to be born into.
    expect(registrations.every(({ instance }) => instance.agent_id === null)).toBe(true);
    expect(
      registrations.every(({ instance }) => Object.keys(instance.runtime_metadata).length === 0),
    ).toBe(true);
    expect(registrations.every(({ token }) => /^sni_[A-Za-z0-9_-]{43}$/.test(token))).toBe(
      true,
    );

    for (const registration of registrations) {
      const current = await request(store, "/api/v1/instances/current", {
        headers: instanceHeaders(registration.token),
      });
      expect(current.status).toBe(200);
      const currentBody = await json(current);
      expect(currentBody.instance.id).toBe(registration.instance.id);
      expect(currentBody.agent).toBeNull();

      const heartbeat = await request(store, "/api/v1/instances/current/heartbeat", {
        method: "POST",
        headers: instanceHeaders(registration.token),
      });
      expect(heartbeat.status).toBe(200);
      expect((await json(heartbeat)).heartbeat_after_seconds).toBe(30);
    }

    const internals = store as any;
    const apiKeyRecord = [...internals.apiKeysByDigest.values()][0];
    expect(apiKeyRecord.digest).toBe(digestSecret(DEV_KEY));
    expect(apiKeyRecord).not.toHaveProperty("token");
    for (const record of internals.instances.values()) {
      expect(record).not.toHaveProperty("token");
      expect(record.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    const serialized = JSON.stringify([
      apiKeyRecord,
      ...internals.instances.values(),
    ]);
    expect(serialized).not.toContain(DEV_KEY);
    for (const registration of registrations) {
      expect(serialized).not.toContain(registration.token);
    }
  });

  it("returns the same Instance with a fresh token when one runtime session registers twice", async () => {
    const store = makeStore();

    const first = await startInstance(store, { local_instance_key: SESSION_KEY });
    const again = await startInstance(store, { local_instance_key: SESSION_KEY }, 200);
    const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });

    // One session, one live Instance — but every registration mints its own
    // token, so a recovered session never reuses a secret it may have lost.
    expect(again.instance.id).toBe(first.instance.id);
    expect(again.token).not.toBe(first.token);
    expect(other.instance.id).not.toBe(first.instance.id);

    const stale = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(first.token),
    });
    expect(stale.status).toBe(401);
    const live = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(again.token),
    });
    expect(live.status).toBe(200);
    expect((store as any).instances.size).toBe(2);
  });

  it("moves a re-registered Instance's tag when asked and leaves it alone otherwise", async () => {
    const store = makeStore();
    const { agent: reviewer } = await createAgent(store, "reviewer");

    const untagged = await startInstance(store, { local_instance_key: SESSION_KEY });
    expect(untagged.instance.agent_id).toBeNull();

    const tagged = await startInstance(
      store,
      {
        local_instance_key: SESSION_KEY,
        agent_id: reviewer.id,
        runtime_metadata: { hostname: "mbp" },
      },
      200,
    );
    expect(tagged.instance.id).toBe(untagged.instance.id);
    expect(tagged.instance.agent_id).toBe(reviewer.id);
    expect(tagged.instance.runtime_metadata).toEqual({ hostname: "mbp" });

    const untouched = await startInstance(store, { local_instance_key: SESSION_KEY }, 200);
    expect(untouched.instance.agent_id).toBe(reviewer.id);
    expect(untouched.instance.runtime_metadata).toEqual({ hostname: "mbp" });

    const cleared = await startInstance(
      store,
      { local_instance_key: SESSION_KEY, agent_id: null },
      200,
    );
    expect(cleared.instance.agent_id).toBeNull();

    const current = await request(store, "/api/v1/instances/current", {
      headers: instanceHeaders(cleared.token),
    });
    expect((await json(current)).agent).toBeNull();
  });

  it("refuses a tag that is not this Principal's and malformed session inputs", async () => {
    const store = makeStore();

    const foreign = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        runtime_kind: "codex",
        cli_version: "0.1.3",
        agent_id: "a_zzzzzzzzzz",
      }),
    });
    expect(foreign.status).toBe(404);
    expect((await json(foreign)).error.code).toBe("agent_not_found");

    for (const body of [
      { local_instance_key: "not-hex" },
      { local_instance_key: "a".repeat(63) },
      { agent_id: "reviewer" },
      { runtime_metadata: { "Bad Key": "x" } },
      { runtime_metadata: { hostname: 42 } },
      { runtime_metadata: { hostname: "line\nbreak" } },
      {
        runtime_metadata: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`k${index}`, "v"]),
        ),
      },
    ]) {
      const response = await request(store, "/api/v1/instances", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
      });
      expect(response.status, JSON.stringify(body)).toBe(422);
    }
  });

  it("creates a tag once per handle and lists and fetches it", async () => {
    const store = makeStore();

    const first = await createAgent(store, "reviewer");
    const second = await createAgent(store, "Reviewer ");
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.agent.id).toBe(first.agent.id);
    expect(first.agent.handle).toBe("reviewer");
    expect(first.agent).not.toHaveProperty("is_default");

    await createAgent(store, "builder");
    const listed = await request(store, "/api/v1/agents", { headers: apiHeaders() });
    expect(listed.status).toBe(200);
    expect((await json(listed)).items.map((agent: any) => agent.handle)).toEqual([
      "builder",
      "reviewer",
    ]);

    const fetched = await request(store, `/api/v1/agents/${first.agent.id}`, {
      headers: apiHeaders(),
    });
    expect(fetched.status).toBe(200);
    expect((await json(fetched)).agent.id).toBe(first.agent.id);

    const missing = await request(store, "/api/v1/agents/a_zzzzzzzzzz", {
      headers: apiHeaders(),
    });
    expect(missing.status).toBe(404);
    const malformed = await request(store, "/api/v1/agents/not-an-id", {
      headers: apiHeaders(),
    });
    expect(malformed.status).toBe(400);
    const wrongMethod = await request(store, `/api/v1/agents/${first.agent.id}`, {
      method: "DELETE",
      headers: apiHeaders(),
    });
    expect(wrongMethod.status).toBe(405);

    for (const handle of ["", "Default!", "1abc", "a".repeat(33)]) {
      const response = await request(store, "/api/v1/agents", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ handle }),
      });
      expect(response.status, handle).toBe(422);
    }
  });

  it("caps tags per Principal", async () => {
    const store = makeStore();
    for (let index = 0; index < 100; index += 1) {
      await createAgent(store, `tag-${index}`);
    }
    const response = await request(store, "/api/v1/agents", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ handle: "one-too-many" }),
    });
    expect(response.status).toBe(409);
    expect((await json(response)).error.code).toBe("agent_limit_reached");
    // An existing handle is still returned, not counted against the cap.
    expect((await createAgent(store, "tag-0")).status).toBe(200);
  });

  it("lets four Instances share one chatroom with provenance that follows regrouping", async () => {
    const store = makeStore();
    const { agent } = await createAgent(store, "reviewer");
    const registrations = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        startInstance(store, {
          local_instance_key: String.fromCharCode(99 + index).repeat(64),
        }),
      ),
    );

    const createKey = crypto.randomUUID();
    const createBody = JSON.stringify({ name: "four codex room", description: "E2E" });
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: createBody,
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const roomId = createdBody.room.id as string;
    expect(createdBody.membership.agent_id).toBeNull();
    expect(createdBody.room.creator_instance_id).toBe(registrations[0].instance.id);
    expect(createdBody.room.creator_agent_id).toBeNull();

    const replay = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: createBody,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(replay)).toEqual(createdBody);

    const conflict = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(registrations[0].token, {
        "content-type": "application/json",
        "idempotency-key": createKey,
      }),
      body: JSON.stringify({ name: "different room" }),
    });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");

    // Membership is per Instance, so a sibling Instance of the same Agent is
    // not a member until it joins for itself.
    const strangerPost = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(registrations[1].token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ content: "should not land" }),
    });
    expect(strangerPost.status).toBe(403);

    for (const registration of registrations.slice(1)) {
      const joined = await request(store, `/api/v1/rooms/${roomId}/join`, {
        method: "POST",
        headers: instanceHeaders(registration.token, {
          "idempotency-key": crypto.randomUUID(),
        }),
      });
      expect(joined.status).toBe(200);
      const membership = (await json(joined)).membership;
      expect(membership.agent_id).toBeNull();
      expect(membership.instance_id).toBe(registration.instance.id);
    }

    const posted = await Promise.all(
      registrations.map(({ token }, index) =>
        request(store, `/api/v1/rooms/${roomId}/messages`, {
          method: "POST",
          headers: instanceHeaders(token, {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID(),
          }),
          body: JSON.stringify({ content: `hello from ${index + 1}` }),
        }),
      ),
    );
    expect(posted.every((response) => response.status === 201)).toBe(true);

    const pageResponse = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      headers: instanceHeaders(registrations[3].token),
    });
    expect(pageResponse.status).toBe(200);
    const page = await json(pageResponse);
    expect(page.items.map((message: any) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(page.items.map((message: any) => message.sender_instance_id))).toEqual(
      new Set(registrations.map(({ instance }) => instance.id)),
    );
    expect(page.items.every((message: any) => message.sender_agent_id === null)).toBe(true);

    // Tag the first speaker after the fact. Nothing was written to the
    // messages, yet history now attributes that speaker's line to the tag,
    // because a message records who acted and derives the tag at read time.
    await startInstance(
      store,
      { local_instance_key: "c".repeat(64), agent_id: agent.id },
      200,
    );
    const regrouped = await json(
      await request(store, `/api/v1/rooms/${roomId}/messages`, {
        headers: instanceHeaders(registrations[3].token),
      }),
    );
    expect(regrouped.items.map((message: any) => message.sender_agent_id)).toEqual([
      agent.id,
      null,
      null,
      null,
    ]);
    const detail = await json(
      await request(store, `/api/v1/rooms/${roomId}`, {
        headers: instanceHeaders(registrations[3].token),
      }),
    );
    expect(detail.room.creator_agent_id).toBe(agent.id);
    expect(
      detail.memberships.find(
        (member: any) => member.instance_id === registrations[0].instance.id,
      ).agent_id,
    ).toBe(agent.id);
  });

  it("authenticates before parsing a protected request body", async () => {
    const store = makeStore();
    const response = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: {
        authorization: "Bearer definitely-not-a-token",
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: "{ broken",
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe("invalid_credentials");
  });

  it("executes concurrent replays only once", async () => {
    const store = makeStore();
    const registration = await startInstance(store);
    const key = crypto.randomUUID();
    const create = () =>
      request(store, "/api/v1/rooms", {
        method: "POST",
        headers: instanceHeaders(registration.token, {
          "content-type": "application/json",
          "idempotency-key": key,
        }),
        body: JSON.stringify({ name: "one room" }),
      });

    const responses = await Promise.all([create(), create()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(
      responses.filter((response) => response.headers.get("idempotency-replayed") === "true"),
    ).toHaveLength(1);
    expect((store as any).rooms).toHaveLength(1);
  });

  it("rejects idempotency on raw Instance token issuance", async () => {
    const store = makeStore();
    const response = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3" }),
    });

    expect(response.status).toBe(400);
    expect((await json(response)).error.code).toBe("idempotency_not_supported");
  });
});

describe("GET /api/v1/rooms/{room_id}", () => {
  async function seededRoom() {
    const store = makeStore();
    const { token } = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ name: "Detail room" }),
    });
    expect(created.status).toBe(201);
    return { store, token, roomId: (await json(created)).room.id as string };
  }

  it("returns the Room and its memberships for a member Instance", async () => {
    const { store, token, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: instanceHeaders(token),
    });
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(body.room.id).toBe(roomId);
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].state).toBe("active");
  });

  it("rejects an account API key, which is the wrong credential class", async () => {
    const { store, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: apiHeaders(),
    });

    expect(response.status).toBe(401);
  });

  it("answers 404 for a Room id that does not exist", async () => {
    const { store, token } = await seededRoom();

    const response = await request(
      store,
      "/api/v1/rooms/rom_HandlerRm1",
      { headers: instanceHeaders(token) },
    );

    expect(response.status).toBe(404);
  });

  it("rejects a malformed Room id before any lookup", async () => {
    const { store, token } = await seededRoom();

    const response = await request(store, "/api/v1/rooms/not-a-room-id", {
      headers: instanceHeaders(token),
    });

    expect(response.status).toBe(400);
  });

  it("allows only GET", async () => {
    const { store, token, roomId } = await seededRoom();

    const response = await request(store, `/api/v1/rooms/${roomId}`, {
      method: "DELETE",
      headers: instanceHeaders(token),
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

describe("Rooms across Principals", () => {
  const now = () => new Date("2026-09-04T10:20:30.123Z");

  async function startAs(store: MemorySharedNetRepository, key: string, body: StartBody = {}) {
    const response = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: apiHeaders({ "content-type": "application/json" }, key),
      body: JSON.stringify({ runtime_kind: "codex", cli_version: "0.1.3", ...body }),
    });
    expect(response.status).toBe(201);
    return json(response);
  }

  it("lets an Instance of another Principal join by Room id, and read only once it has", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now });
    const owner = await startAs(store, DEV_KEY);
    const guest = await startAs(store, OTHER_KEY);
    expect(guest.instance.principal_id).not.toBe(owner.instance.principal_id);

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ name: "Shared by id" }),
    });
    expect(created.status).toBe(201);
    const roomId = (await json(created)).room.id as string;

    // Knowing the id is not yet membership: reading is refused until joined.
    const peek = await request(store, `/api/v1/rooms/${roomId}`, {
      headers: instanceHeaders(guest.token),
    });
    expect(peek.status).toBe(403);
    expect((await json(peek)).error.code).toBe("room_membership_required");

    const joined = await request(store, `/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "idempotency-key": crypto.randomUUID() }),
    });
    expect(joined.status).toBe(200);
    const membership = (await json(joined)).membership;
    expect(membership.instance_id).toBe(guest.instance.id);

    const posted = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(guest.token, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({ content: "hello from another Principal" }),
    });
    expect(posted.status).toBe(201);
    expect((await json(posted)).message.sender_principal_id).toBe(guest.instance.principal_id);

    // The owner sees the guest as a member with the guest's own Principal,
    // and reads the guest's message with truthful provenance.
    const detail = await json(
      await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(owner.token) }),
    );
    expect(detail.room.principal_id).toBe(owner.instance.principal_id);
    expect(detail.memberships.map((member: any) => member.instance_id).sort()).toEqual(
      [owner.instance.id, guest.instance.id].sort(),
    );
    const page = await json(
      await request(store, `/api/v1/rooms/${roomId}/messages`, {
        headers: instanceHeaders(owner.token),
      }),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0].sender_principal_id).toBe(guest.instance.principal_id);
    expect(page.items[0].sender_instance_id).toBe(guest.instance.id);
  });
});

});

describe("Room invites, guests, and wait", () => {
  const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

  async function openRoom(store: MemorySharedNetRepository) {
    const host = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, {
        "content-type": "application/json",
        "idempotency-key": UUID,
      }),
      body: JSON.stringify({ name: "Launch review" }),
    });
    expect(created.status).toBe(201);
    const { room } = await json(created);
    const principalId = host.instance.principal_id;
    return { host, room, principalId };
  }

  async function say(
    store: MemorySharedNetRepository,
    roomId: string,
    token: string,
    content: string,
    key?: string,
  ) {
    return request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(token, {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      }),
      body: JSON.stringify({ content }),
    });
  }

  it("admits a guest by invite token, hands back a member token and the history, and lets it speak", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    expect((await say(store, room.id, host.token, "Welcome", UUID)).status).toBe(201);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    expect(invite).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);

    const joined = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(joined.status).toBe(200);
    expect(joined.headers.get("cache-control")).toContain("no-store");
    const body = await json(joined);
    // Every member is an Instance of a Principal: the Agent that arrived with
    // only an invite gets an anonymous Principal of its own and an Instance token.
    expect(body.member_token).toMatch(/^sni_[A-Za-z0-9_-]{43}$/);
    expect(body.membership).toMatchObject({
      kind: "guest",
      name: "claude-code",
      invited_by_principal_id: principalId,
      admitted_by: "invite",
      presence: "online",
      state: "active",
    });
    expect(body.membership.member_id).toMatch(/^i_[A-Za-z0-9]{10}$/);
    expect(body.membership.instance_id).toBe(body.membership.member_id);
    expect(body.membership.principal_id).toMatch(/^p_[A-Za-z0-9]{10}$/);
    expect(body.membership.principal_id).not.toBe(principalId);
    expect(body.history.items.map((m: any) => m.content)).toEqual(["Welcome"]);
    expect(body.history.items[0].sender).toEqual({
      member_id: host.instance.id,
      kind: "instance",
      name: null,
    });

    // The guest speaks with plain curl: no Idempotency-Key required.
    const spoke = await say(store, room.id, body.member_token, "Hello from a guest");
    expect(spoke.status).toBe(201);
    const message = (await json(spoke)).message;
    expect(message).toMatchObject({
      sequence: 2,
      type: "message",
      sender_instance_id: body.membership.member_id,
      sender_principal_id: body.membership.principal_id,
      sender: { member_id: body.membership.member_id, kind: "guest", name: "claude-code" },
    });

    // The host reads it with the sender attributed to the guest by name.
    const page = await request(store, `/api/v1/rooms/${room.id}/messages?after=1`, {
      headers: instanceHeaders(host.token),
    });
    expect((await json(page)).items[0].sender.name).toBe("claude-code");

    // Both kinds of member appear in the Room, each with presence.
    const detail = await request(store, `/api/v1/rooms/${room.id}`, {
      headers: { authorization: `Bearer ${body.member_token}` },
    });
    expect(detail.status).toBe(200);
    const members = (await json(detail)).memberships;
    expect(members.map((m: any) => m.kind).sort()).toEqual(["guest", "instance"]);
    expect(members.every((m: any) => m.presence === "online")).toBe(true);

    // Nothing secret is stored raw.
    const serialized = JSON.stringify([...(store as any).instances.values(), ...(store as any).invites.values()]);
    expect(serialized).not.toContain(invite);
    expect(serialized).not.toContain(body.member_token);
  });

  it("honours an Idempotency-Key from a guest when one is sent", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "codex" });

    const first = await say(store, room.id, memberToken, "once", UUID);
    const again = await say(store, room.id, memberToken, "once", UUID);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect((await json(again)).message.id).toBe((await json(first)).message.id);
  });

  it("gives every join its own member: a name never recovers someone else's identity", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const one = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
    const two = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
    expect(two.membership.member_id).not.toBe(one.membership.member_id);
    expect(two.member_token).not.toBe(one.member_token);
  });

  it("rejects an invite that is unknown, for another Room, revoked, or expired", async () => {
    let clock = new Date("2026-09-05T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const join = (token: string, roomId = room.id) =>
      request(store, `/api/v1/rooms/${roomId}/join`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "guest" }),
      });

    expect((await join(`rit_${"z".repeat(43)}`)).status).toBe(401);

    const { token: forOther } = await store.createRoomInvite({ roomId: other.room.id, principalId });
    expect((await join(forOther)).status).toBe(401);

    const { invite, token } = await store.createRoomInvite({ roomId: room.id, principalId });
    await store.revokeRoomInvite({ inviteId: invite.id, principalId });
    const revoked = await join(token);
    expect(revoked.status).toBe(410);
    expect((await json(revoked)).error.code).toBe("invite_revoked");

    const { token: shortLived, invite: timed } = await store.createRoomInvite({
      roomId: room.id,
      principalId,
      expiresInSeconds: 60,
    });
    expect(timed.expires_at).toBe("2026-09-05T12:01:00.000Z");
    clock = new Date("2026-09-05T12:02:00Z");
    const expired = await join(shortLived);
    expect(expired.status).toBe(410);
    expect((await json(expired)).error.code).toBe("invite_expired");

    // A forever invite (the default) is unaffected by the clock.
    const { token: forever, invite: standing } = await store.createRoomInvite({ roomId: room.id, principalId });
    expect(standing.expires_at).toBeNull();
    clock = new Date("2027-09-05T12:00:00Z");
    expect((await join(forever)).status).toBe(200);
  });

  it("redeems a claim the signed-in Web minted: the key once, then the code is spent", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { principalId } = await openRoom(store);
    const { claim } = await store.createCliClaim({ principalId, label: "join Hackathon" });
    const redeem = (bearer: string) =>
      request(store, "/api/v1/cli/claims/redeem", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });

    const redeemed = await redeem(claim);
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get("cache-control")).toContain("no-store");
    const body = await json(redeemed);
    expect(body.state).toBe("approved");
    expect(body.principal.id).toBe(principalId);
    expect(body.api_key).toMatch(/^snk_/);

    // The key is the account's: it registers Instances of that Principal.
    const started = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${body.api_key}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
    });
    expect(started.status).toBe(201);
    expect((await json(started)).instance.principal_id).toBe(principalId);

    // Spent: a second redemption, an unknown code, and a token of another kind all fail.
    const again = await redeem(claim);
    expect(again.status).toBe(410);
    expect((await json(again)).error.code).toBe("login_consumed");
    expect((await redeem(`clp_${"n".repeat(43)}`)).status).toBe(404);
    expect((await redeem(`sni_${"x".repeat(43)}`)).status).toBe(401);
    expect((await request(store, "/api/v1/cli/claims/redeem", { method: "POST" })).status).toBe(401);
  });

  it("lets a claim expire on its own clock, so an unspent one is not a key forever", async () => {
    let clock = new Date("2026-09-05T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { principalId } = await openRoom(store);
    const redeem = (bearer: string) =>
      request(store, "/api/v1/cli/claims/redeem", { method: "POST", headers: { authorization: `Bearer ${bearer}` } });

    // The join page mints these already approved, with a seven-day life.
    const { claim: fresh } = await store.createCliClaim({ principalId, label: "join page" });
    const { claim: stale } = await store.createCliClaim({ principalId, label: "join page" });

    // Inside the window it still hands over the account's key.
    clock = new Date("2026-09-11T12:00:00Z");
    const inTime = await redeem(fresh);
    expect(inTime.status).toBe(200);
    expect((await json(inTime)).api_key).toMatch(/^snk_/);

    // Past it, the second one is gone — no key, and the error says why.
    clock = new Date("2026-09-13T12:00:00Z");
    const tooLate = await redeem(stale);
    expect(tooLate.status).toBe(410);
    const failed = await json(tooLate);
    expect(failed.error.code).toBe("login_expired");
    expect(failed.api_key).toBeUndefined();
  });

  it("restarts the redemption window when a login is approved at the edge of it", async () => {
    let tick = Date.parse("2026-09-06T10:00:00.000Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => new Date(tick) });
    const host = await startInstance(store);
    const started = await request(store, "/api/v1/cli/logins", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "laptop" }),
    });
    const login = await json(started);

    // The human takes almost the whole window to answer, then the CLI polls
    // once more. That poll must not land on a login that just expired.
    tick += 9 * 60_000 + 55_000;
    await store.approveCliLogin({ code: login.user_code, principalId: host.instance.principal_id });
    tick += 30_000;
    const redeemed = await request(store, `/api/v1/cli/logins/${login.login.id}/poll`, {
      method: "POST",
      headers: { authorization: `Bearer ${login.poll_token}` },
    });
    expect(redeemed.status).toBe(200);
    expect((await json(redeemed)).api_key).toMatch(/^snk_/);
  });

  it("mints an invite for the Room's owner and anyone seated in it through the API, and for nobody else", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY] });
    const { host, room, principalId } = await openRoom(store);
    const mint = (token: string) =>
      request(store, `/api/v1/rooms/${room.id}/invites`, { method: "POST", headers: instanceHeaders(token) });

    const minted = await mint(host.token);
    expect(minted.status).toBe(201);
    const body = await json(minted);
    expect(body.token).toMatch(/^rit_[A-Za-z0-9_-]{43}$/);
    expect(body.link).toBe(`http://127.0.0.1:3001/join/${body.token}`);
    expect(body.invite).toMatchObject({ room_id: room.id, expires_at: null, revoked_at: null, uses: 0 });
    // The token opens that Room, and only that Room.
    const described = await request(store, "/api/v1/invites/current", { headers: { authorization: `Bearer ${body.token}` } });
    expect((await json(described)).room.id).toBe(room.id);

    // A guest seated by that very invite owns nothing, and may still open a
    // door of its own (decision 2026-09-30): the invite is recorded as the guest's.
    const guest = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${body.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "claude-code" }),
    });
    expect(guest.status).toBe(200);
    const byGuest = await mint((await json(guest)).member_token);
    expect(byGuest.status).toBe(201);
    const guestInvite = (await json(byGuest)).invite;
    expect(guestInvite.room_id).toBe(room.id);
    expect(guestInvite.principal_id).not.toBe(principalId);

    // An Instance of another account, with no seat in the Room, is told it does not exist.
    const outsider = await startWithKey(store, OTHER_KEY);
    const refused = await mint(outsider.token);
    expect(refused.status).toBe(404);
    expect((await json(refused)).error.code).toBe("room_not_found");
    expect((await request(store, `/api/v1/rooms/${room.id}/invites`, { method: "POST" })).status).toBe(401);
    expect((await request(store, `/api/v1/rooms/${room.id}/invites`, { headers: instanceHeaders(host.token) })).status).toBe(405);
  });

  it("names the oldest CLI it registers, and refuses an older one with the command to run", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const index = await json(await request(store, "/api/v1"));
    expect(index.min_cli_version).toBe("0.1.3");
    const register = (cli_version: string) =>
      request(store, "/api/v1/instances", {
        method: "POST",
        headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ runtime_kind: "claude-code", cli_version }),
      });
    const old = await register("0.1.2");
    expect(old.status).toBe(426);
    const body = await json(old);
    expect(body.error.code).toBe("cli_upgrade_required");
    expect(body.error.message).toContain("npx -y sharednet@latest");
    expect((await register("0.1.3")).status).toBe(201);
    expect((await register("0.2.0")).status).toBe(201);
    // A version that is not a version (a script, an invite seat) is not judged.
    expect((await register("scenario")).status).toBe(201);
  });

  it("reads a Room's log as filter, order, window: grep, by sender, by tag, newest first, paged backward", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { host, room } = await openRoom(store);
    const other = await startInstance(store);
    await request(store, `/api/v1/rooms/${room.id}/join`, { method: "POST", headers: instanceHeaders(other.token, { "idempotency-key": "1f7f2c1e-4d6b-4b6e-8f1a-2b3c4d5e6f71" }) });
    const lines = ["deploy window opens at 14:00", "rollback takes 10 minutes", "Deploy moved to 13:55", "lunch?", "deploy is go"];
    for (const [i, line] of lines.entries()) {
      const author = i % 2 === 0 ? host.token : other.token;
      const posted = await say(store, room.id, author, line, `0f7f2c1e-4d6b-4b6e-8f1a-2b3c4d5e6f${String(80 + i)}`);
      expect(posted.status).toBe(201);
    }
    const read = async (query: string) => {
      const response = await request(store, `/api/v1/rooms/${room.id}/messages${query}`, { headers: instanceHeaders(host.token) });
      return { status: response.status, body: await json(response) };
    };
    // grep: case-insensitive substring, log order.
    const grep = await read("?q=deploy");
    expect(grep.body.items.map((m: any) => m.sequence)).toEqual([1, 3, 5]);
    // newest first, top k: [-2:].
    const last = await read("?order=desc&limit=2");
    expect(last.body.items.map((m: any) => m.sequence)).toEqual([5, 4]);
    expect(last.body.next_cursor).toBe("4");
    // and the page before it, continuing backward.
    const earlier = await read("?before=4&limit=2");
    expect(earlier.body.items.map((m: any) => m.sequence)).toEqual([3, 2]);
    expect(earlier.body.has_more).toBe(true);
    // by sender, and by tag (both untagged here).
    const byOther = await read(`?sender_instance_id=${other.instance.id}`);
    expect(byOther.body.items.map((m: any) => m.sequence)).toEqual([2, 4]);
    const untagged = await read("?sender_agent_id=default&q=deploy");
    expect(untagged.body.items.map((m: any) => m.sequence)).toEqual([1, 3, 5]);
    const tagged = await read("?sender_agent_id=a_AbCdEfGhIj");
    expect(tagged.body.items).toEqual([]);
    // The default read is unchanged: everything, oldest first, fifty at a time.
    const plain = await read("");
    expect(plain.body.items.map((m: any) => m.sequence)).toEqual([1, 2, 3, 4, 5]);
    // Contradictions and junk are refused, not guessed.
    expect((await read("?after=1&before=3")).status).toBe(400);
    expect((await read("?after=1&order=desc")).status).toBe(400);
    expect((await read("?order=sideways")).status).toBe(400);
    expect((await read("?q=")).status).toBe(400);
    expect((await read("?sender_instance_id=nope")).status).toBe(400);
    expect((await read("?rank=bm25")).status).toBe(400);
  });

  it("tells the join page what an invite opens, and only that", async () => {
    let clock = new Date("2026-09-07T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { room, principalId } = await openRoom(store);
    const { token, invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const describe = (bearer: string) => request(store, "/api/v1/invites/current", { headers: { authorization: `Bearer ${bearer}` } });

    const described = await describe(token);
    expect(described.status).toBe(200);
    expect(await json(described)).toEqual({
      room: { id: room.id, name: room.name, state: "open" },
      invite: { id: invite.id, expires_at: null, uses: 0 },
    });
    // No token, or a token of another kind, opens nothing.
    expect((await request(store, "/api/v1/invites/current")).status).toBe(401);
    expect((await describe(`sni_${"x".repeat(43)}`)).status).toBe(401);
    expect((await describe(`rit_${"z".repeat(43)}`)).status).toBe(401);
    await store.revokeRoomInvite({ inviteId: invite.id, principalId });
    const revoked = await describe(token);
    expect(revoked.status).toBe(410);
    expect((await json(revoked)).error.code).toBe("invite_revoked");
    const { token: brief } = await store.createRoomInvite({ roomId: room.id, principalId, expiresInSeconds: 60 });
    clock = new Date("2026-09-07T12:05:00Z");
    expect((await json(await describe(brief))).error.code).toBe("invite_expired");
  });

  it("keeps a guest inside its own Room only", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const foreign = await request(store, `/api/v1/rooms/${other.room.id}/messages`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(foreign.status).toBe(403);
    expect((await json(foreign)).error.code).toBe("room_membership_required");

    // It is an Instance, of an anonymous Principal that records who invited it.
    const self = await request(store, "/api/v1/instances/current", {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(self.status).toBe(200);
    const current = await json(self);
    expect(current.principal.invited_by_principal_id).toBe(principalId);
    expect(current.instance.display_name).toBe("guest");
    expect(current.instance.token_expires_at).toBeNull();
    expect(current.agent).toBeNull();
  });

  it("keeps an Instance registered with a key usable years later: Instances are permanent", async () => {
    let clock = new Date("2026-09-06T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const started = await request(store, "/api/v1/instances", {
      method: "POST",
      headers: { authorization: `Bearer ${DEV_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
    });
    expect(started.status).toBe(201);
    const { instance, token } = await json(started);
    expect(instance.token_expires_at).toBeNull();

    clock = new Date("2028-09-06T12:00:00Z");
    const beat = await request(store, "/api/v1/instances/current/heartbeat", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(beat.status).toBe(200);
    const current = await request(store, "/api/v1/instances/current", { headers: { authorization: `Bearer ${token}` } });
    expect(current.status).toBe(200);
    expect((await json(current)).instance.id).toBe(instance.id);
  });

  it("ends an Instance on DELETE: seat left, token spent", async () => {
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY });
    const { token, instance } = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Short-lived" }),
    });
    const { room } = await json(created);

    const ended = await request(store, "/api/v1/instances/current", { method: "DELETE", headers: instanceHeaders(token) });
    expect(ended.status).toBe(200);
    const endedBody = await json(ended);
    expect(endedBody.instance.id).toBe(instance.id);
    expect(endedBody.instance.status).toBe("ended");

    // The seat went with the session: its membership is left, and the spent
    // token no longer authenticates anywhere, not even to end again.
    const seats = (store as any).memberships as Map<string, { instance_id: string; state: string }>;
    expect([...seats.values()].find((seat) => seat.instance_id === instance.id)?.state).toBe("left");
    const posted = await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: "still here?" }),
    });
    expect(posted.status).toBe(401);
    const again = await request(store, "/api/v1/instances/current", { method: "DELETE", headers: instanceHeaders(token) });
    expect(again.status).toBe(401);
  });

  it("keeps an account seat online while it only reads: any authenticated request renews the lease", async () => {
    let clock = new Date("2026-09-06T12:00:00Z");
    const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => clock });
    const { token, instance } = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Quiet" }),
    });
    const { room } = await json(created);

    // An hour of nothing but polling the Room, no heartbeat from the CLI.
    clock = new Date("2026-09-06T13:00:00Z");
    const polled = await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=0`, { headers: instanceHeaders(token) });
    expect(polled.status).toBe(200);
    const seen = await json(await request(store, "/api/v1/instances/current", { headers: instanceHeaders(token) }));
    expect(seen.instance.id).toBe(instance.id);
    expect(seen.instance.status).toBe("online");
    // And it can still speak: posting requires an online Instance.
    const said = await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b" }),
      body: JSON.stringify({ content: "still here" }),
    });
    expect(said.status).toBe(201);
  });

  it("forms a group: a public Instance is seated at once and finds the Room in its list", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now: () => new Date("2026-09-06T12:00:00Z") });
    const host = await startInstance(store);
    const guest = await startWithKey(store, OTHER_KEY);
    expect(guest.instance.reach).toBe("public");

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Formed", with: [guest.instance.id, "i_NoSuchInst"] }),
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    // Refused says nothing about why: an unknown id reads like a private no.
    expect(body.admissions).toEqual([
      { instance_id: guest.instance.id, status: "member", decision_id: null },
      { instance_id: "i_NoSuchInst", status: "refused", decision_id: null },
    ]);

    // The guest is a member: the Room is in its list, it can read, and the seat says who added it.
    const list = await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) });
    expect(list.status).toBe(200);
    expect((await json(list)).items.map((room: any) => room.id)).toEqual([body.room.id]);
    const detail = await request(store, `/api/v1/rooms/${body.room.id}`, { headers: instanceHeaders(guest.token) });
    expect(detail.status).toBe(200);
    const seat = (await json(detail)).memberships.find((m: any) => m.member_id === guest.instance.id);
    expect(seat).toMatchObject({ admitted_by: "added", added_by_instance_id: host.instance.id, state: "active" });

    // Adding again is a no-op, and only an active member may add.
    const again = await request(store, `/api/v1/rooms/${body.room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [host.instance.id] }),
    });
    expect((await json(again)).admissions).toEqual([{ instance_id: host.instance.id, status: "member", decision_id: null }]);
    const outsider = await startWithKey(store, OTHER_KEY, { local_instance_key: OTHER_SESSION_KEY });
    const denied = await request(store, `/api/v1/rooms/${body.room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(outsider.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [outsider.instance.id] }),
    });
    expect(denied.status).toBe(403);
  });

  it("asks a private Instance first, and the Instance answers for itself through the API", async () => {
    const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now: () => new Date("2026-09-06T12:00:00Z") });
    const host = await startInstance(store);
    const guest = await startWithKey(store, OTHER_KEY);
    const patched = await request(store, "/api/v1/instances/current", {
      method: "PATCH",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ reach: "private" }),
    });
    expect(patched.status).toBe(200);
    expect((await json(patched)).instance.reach).toBe("private");

    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ name: "Asked", with: [guest.instance.id] }),
    });
    const { room, admissions } = await json(created);
    expect(admissions).toHaveLength(1);
    expect(admissions[0]).toMatchObject({ instance_id: guest.instance.id, status: "pending" });
    const decisionId = admissions[0].decision_id as string;
    expect(decisionId).toMatch(/^dec_/);

    // Not a member yet: no Room in the list, no reading.
    expect((await json(await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) }))).items).toEqual([]);
    expect((await request(store, `/api/v1/rooms/${room.id}`, { headers: instanceHeaders(guest.token) })).status).toBe(403);

    // The request is a Decision addressed to the guest, and only the guest sees it.
    const mine = await json(await request(store, "/api/v1/decisions?status=pending", { headers: instanceHeaders(guest.token) }));
    expect(mine.decisions).toHaveLength(1);
    expect(mine.decisions[0]).toMatchObject({
      id: decisionId,
      mode: "approval",
      status: "pending",
      room_id: room.id,
      requested_by_instance_id: host.instance.id,
      requested_for_instance_id: guest.instance.id,
      principal_id: guest.instance.principal_id,
    });
    expect((await json(await request(store, "/api/v1/decisions", { headers: instanceHeaders(host.token) }))).decisions).toEqual([]);
    const notYours = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(notYours.status).toBe(404);

    // Asking again while it is pending returns the same Decision.
    const askedAgain = await request(store, `/api/v1/rooms/${room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [guest.instance.id] }),
    });
    expect((await json(askedAgain)).admissions[0]).toEqual({ instance_id: guest.instance.id, status: "pending", decision_id: decisionId });

    // The guest approves with its own token: seated, and the Room appears.
    const approved = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(approved.status).toBe(200);
    const outcome = await json(approved);
    expect(outcome.decision.status).toBe("approved");
    expect(outcome.membership).toMatchObject({ room_id: room.id, admitted_by: "accepted", added_by_instance_id: host.instance.id });
    expect((await json(await request(store, "/api/v1/rooms", { headers: instanceHeaders(guest.token) }))).items.map((r: any) => r.id)).toEqual([room.id]);
    const twice = await request(store, `/api/v1/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "approved" }),
    });
    expect(twice.status).toBe(409);

    // A denial seats nobody and looks, to the asker, like any other refusal later on.
    const second = await startWithKey(store, OTHER_KEY, { local_instance_key: OTHER_SESSION_KEY, reach: "private" });
    const asked = await json(await request(store, `/api/v1/rooms/${room.id}/members`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json" }),
      body: JSON.stringify({ with: [second.instance.id] }),
    }));
    const deniedOutcome = await json(await request(store, `/api/v1/decisions/${asked.admissions[0].decision_id}/resolve`, {
      method: "POST",
      headers: instanceHeaders(second.token, { "content-type": "application/json" }),
      body: JSON.stringify({ resolution: "denied" }),
    }));
    expect(deniedOutcome.decision.status).toBe("denied");
    expect(deniedOutcome.membership).toBeNull();
    expect((await request(store, `/api/v1/rooms/${room.id}`, { headers: instanceHeaders(second.token) })).status).toBe(403);
  });

  it("records the driver an invite join declares, and refuses a malformed one", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });

    const declared = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "codex",
        runtime: { kind: "codex", version: "0.153.0", entrypoint: "exec", source: "detected" },
      }),
    });
    expect(declared.status).toBe(200);
    const seat = (await json(declared)).membership;
    expect(seat).toMatchObject({
      runtime_kind: "codex",
      runtime_version: "0.153.0",
      runtime_metadata: { runtime_source: "detected", driver_version: "0.153.0", entrypoint: "exec" },
    });

    const bare = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "curl" }),
    });
    expect((await json(bare)).membership).toMatchObject({
      runtime_kind: "custom",
      runtime_version: "invite",
      runtime_metadata: {},
    });

    const malformed = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", runtime: { kind: "Not A Handle" } }),
    });
    expect(malformed.status).toBe(422);
  });

  it("lets an Instance join with an invite as its own Principal, and refuses an invite for another Room", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const other = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const joiner = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });

    const wrongRoom = await request(store, `/api/v1/rooms/${other.room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, { "content-type": "application/json", "idempotency-key": UUID }),
      body: JSON.stringify({ invite }),
    });
    expect(wrongRoom.status).toBe(401);

    const joined = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, {
        "content-type": "application/json",
        "idempotency-key": "3f2504e0-4f89-41d3-9a0c-0305e82c3399",
      }),
      body: JSON.stringify({ invite }),
    });
    expect(joined.status).toBe(200);
    const body = await json(joined);
    expect(body.membership).toMatchObject({
      kind: "instance",
      member_id: joiner.instance.id,
      instance_id: joiner.instance.id,
      principal_id: joiner.instance.principal_id,
      admitted_by: "invite",
      name: null,
    });
    expect(body.membership.invite_id).toMatch(/^inv_[A-Za-z0-9]{10}$/);

    const bareBody = await request(store, `/api/v1/rooms/${room.id}/join`, {
      method: "POST",
      headers: instanceHeaders(joiner.token, {
        "content-type": "application/json",
        "idempotency-key": "3f2504e0-4f89-41d3-9a0c-0305e82c3398",
      }),
      body: JSON.stringify({ invite: "not-an-invite" }),
    });
    expect(bareBody.status).toBe(422);
  });

  it("takes the name an Instance gives itself at the door as its nickname, and refuses one that is not a name", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const joiner = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });
    const join = (body: unknown, key: string) =>
      request(store, `/api/v1/rooms/${room.id}/join`, {
        method: "POST",
        headers: instanceHeaders(joiner.token, { "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify(body),
      });

    const joined = await join({ invite, name: "  reviewer  " }, "3f2504e0-4f89-41d3-9a0c-0305e82c3381");
    expect(joined.status).toBe(200);
    expect((await json(joined)).membership).toMatchObject({ member_id: joiner.instance.id, name: "reviewer" });
    // Everyone in the Room reads it off the seat, not only the seat itself.
    const seen = await request(store, `/api/v1/rooms/${room.id}`, { headers: instanceHeaders(host.token) });
    const members = (await json(seen)).memberships as Array<{ member_id: string; name: string | null }>;
    expect(members.find((member) => member.member_id === joiner.instance.id)?.name).toBe("reviewer");

    for (const [name, key] of [["", "3f2504e0-4f89-41d3-9a0c-0305e82c3382"], ["a\u0007b", "3f2504e0-4f89-41d3-9a0c-0305e82c3383"], ["x".repeat(65), "3f2504e0-4f89-41d3-9a0c-0305e82c3384"], [42, "3f2504e0-4f89-41d3-9a0c-0305e82c3385"]] as const) {
      expect((await join({ invite, name }, key)).status).toBe(422);
    }
  });

  it("returns at once from wait when something was said after the cursor", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    await say(store, room.id, host.token, "first", UUID);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const response = await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=25`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const page = await json(response);
    expect(page.items.map((m: any) => m.content)).toEqual(["first"]);
    expect(page.next_cursor).toBe("1");
  });

  it("wakes only for what the wait asked for: a message that does not match leaves it asleep", async () => {
    // One message on a Room with thirty Agents must not start thirty of them. A wait carries the
    // same filters a read carries, and the ones it is not interested in do not return it.
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });
    await say(store, room.id, host.token, "an unrelated status line", UUID);

    const narrow = async (query: string) =>
      json(await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=0&${query}`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }));

    // Text it does not care about: nothing comes back, and the cursor is untouched.
    expect((await narrow("q=deploy")).items).toEqual([]);
    // A sender it does not care about either.
    expect((await narrow(`sender_instance_id=i_${"Z".repeat(10)}`)).items).toEqual([]);

    await say(store, room.id, host.token, "starting the deploy now", crypto.randomUUID());
    const woken = await narrow("q=deploy");
    expect(woken.items.map((m: any) => m.content)).toEqual(["starting the deploy now"]);

    // The filter narrows the wake, never the log: dropping it still shows everything slept through.
    const everything = await narrow("");
    expect(everything.items.map((m: any) => m.content)).toEqual([
      "an unrelated status line",
      "starting the deploy now",
    ]);
  });

  it("refuses a wait filter the read vocabulary does not have", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    // `before` and `order` page backwards; a wait only ever moves forward.
    for (const query of ["before=2", "order=desc", "nonsense=1"]) {
      const response = await request(store, `/api/v1/rooms/${room.id}/wait?after=0&timeout=0&${query}`, {
        headers: { authorization: `Bearer ${memberToken}` },
      });
      expect(response.status).toBe(400);
    }
  });

  it("blocks in wait until a message arrives, then answers with it", async () => {
    const store = makeStore();
    const { host, room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const waiting = handleRequest(
      new Request(`http://127.0.0.1:3001/api/v1/rooms/${room.id}/wait?after=0&timeout=5`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      store,
      { waitPollMs: 5 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await say(store, room.id, host.token, "you there?", UUID);

    const page = await json(await waiting);
    expect(page.items.map((m: any) => m.content)).toEqual(["you there?"]);
  });

  it("answers wait with an empty page at the timeout and refuses a timeout past the cap", async () => {
    const store = makeStore();
    const { room, principalId } = await openRoom(store);
    const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
    const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });

    const empty = await handleRequest(
      new Request(`http://127.0.0.1:3001/api/v1/rooms/${room.id}/wait?after=0&timeout=0`, {
        headers: { authorization: `Bearer ${memberToken}` },
      }),
      store,
      { waitPollMs: 5 },
    );
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({ items: [], next_cursor: null, has_more: false });

    const tooLong = await request(store, `/api/v1/rooms/${room.id}/wait?timeout=26`, {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(tooLong.status).toBe(400);
  });

  describe("a seat's subscription, kept by the service (wait PR 5)", () => {
    // Receiving is not doing: what the service handed a seat and what the seat finished handling
    // are two marks, kept here, so every door moves the same one and a crash between them loses
    // nothing.
    async function guestIn(store: MemorySharedNetRepository) {
      const { host, room, principalId } = await openRoom(store);
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
      const { member_token: memberToken } = await store.joinRoomWithInvite(invite, room.id, { name: "guest" });
      return { host, room, principalId, as: { authorization: `Bearer ${memberToken}` } };
    }
    const ack = (store: MemorySharedNetRepository, roomId: string, headers: Record<string, string>, body: unknown) =>
      request(store, `/api/v1/rooms/${roomId}/ack`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const heartbeat = (store: MemorySharedNetRepository, roomId: string, headers: Record<string, string>, body: unknown) =>
      request(store, `/api/v1/rooms/${roomId}/subscription/heartbeat`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const waitFrom = async (store: MemorySharedNetRepository, roomId: string, headers: Record<string, string>, query = "timeout=0") =>
      json(await request(store, `/api/v1/rooms/${roomId}/wait?${query}`, { headers }));

    it("starts at nothing, and a wait without `after` starts after what the seat has handled", async () => {
      const store = makeStore();
      const { host, room, as } = await guestIn(store);
      expect(await json(await request(store, `/api/v1/rooms/${room.id}/subscription`, { headers: as }))).toEqual({
        subscription: { room_id: room.id, delivered_through: 0, acked_through: 0 },
      });
      await say(store, room.id, host.token, "first", UUID);
      await say(store, room.id, host.token, "second", crypto.randomUUID());

      const handed = await waitFrom(store, room.id, as);
      expect(handed.items.map((m: any) => m.content)).toEqual(["first", "second"]);
      // Handed over, not yet handled.
      expect(handed.subscription).toEqual({ room_id: room.id, delivered_through: 2, acked_through: 0 });

      // A seat that died here is handed the same messages again.
      expect((await waitFrom(store, room.id, as)).items.map((m: any) => m.sequence)).toEqual([1, 2]);

      // Once it says it is done with the first, the next wait starts after it.
      const acked = await ack(store, room.id, as, { through: 1 });
      expect(acked.status).toBe(200);
      expect((await json(acked)).subscription).toEqual({ room_id: room.id, delivered_through: 2, acked_through: 1 });
      expect((await waitFrom(store, room.id, as)).items.map((m: any) => m.sequence)).toEqual([2]);
    });

    it("keeps only the requested unacknowledged Room span active", async () => {
      let clock = new Date("2026-09-06T12:00:00.000Z");
      const store = new MemorySharedNetRepository({ devApiKeys: [DEV_KEY, OTHER_KEY], now: () => clock });
      const host = await startWithKey(store, DEV_KEY);
      const guest = await startWithKey(store, OTHER_KEY);
      const open = async (name: string, key: string) => {
        const response = await request(store, "/api/v1/rooms", {
          method: "POST",
          headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": key }),
          body: JSON.stringify({ name, with: [guest.instance.id] }),
        });
        expect(response.status).toBe(201);
        return (await json(response)).room;
      };
      const roomA = await open("Room A", "3f2504e0-4f89-41d3-9a0c-0305e82c3311");
      const roomB = await open("Room B", "3f2504e0-4f89-41d3-9a0c-0305e82c3312");
      for (const room of [roomA, roomB]) {
        expect((await say(store, room.id, host.token, `@${guest.instance.id} work`, crypto.randomUUID())).status).toBe(201);
        const handed = await waitFrom(store, room.id, instanceHeaders(guest.token));
        expect(handed.subscription).toMatchObject({ delivered_through: 1, acked_through: 0 });
      }

      clock = new Date(clock.getTime() + 21 * 60_000);
      expect(await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 }))).toEqual({
        renewed: false,
        subscription: { room_id: roomB.id, delivered_through: 1, acked_through: 0 },
      });
      // A second handover supersedes the first. Its old turn cannot refresh the one subscription
      // timestamp and make the newer mention look like the work it is doing.
      expect((await say(store, roomB.id, host.token, `@${guest.instance.id} newer work`, crypto.randomUUID())).status).toBe(201);
      const newer = await waitFrom(store, roomB.id, instanceHeaders(guest.token));
      expect(newer.subscription).toMatchObject({ delivered_through: 2, acked_through: 0 });
      expect(await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 1 }))).toEqual({
        renewed: false,
        subscription: { room_id: roomB.id, delivered_through: 2, acked_through: 0 },
      });

      const pulsed = await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 });
      expect(pulsed.status).toBe(200);
      expect(await json(pulsed)).toEqual({
        renewed: true,
        subscription: { room_id: roomB.id, delivered_through: 2, acked_through: 0 },
      });

      const viewA = await store.getRoomForPrincipal(host.instance.principal_id, roomA.id);
      const viewB = await store.getRoomForPrincipal(host.instance.principal_id, roomB.id);
      expect(viewA.replying[guest.instance.id]).toBeUndefined();
      expect(viewB.replying[guest.instance.id]).toMatchObject({ sequence: 2 });

      // A stale lower-through handover must not erase the newer span's lease.
      expect((await waitFrom(store, roomB.id, instanceHeaders(guest.token), "after=0&limit=1&timeout=0")).subscription)
        .toMatchObject({ delivered_through: 2, acked_through: 0 });
      clock = new Date(clock.getTime() + Math.max(REPLY_LEASE_MS, REPLY_FRESH_MS) + 1);
      expect((await store.getRoomForPrincipal(host.instance.principal_id, roomB.id)).replying[guest.instance.id]).toBeUndefined();

      // A same-span handover does clear the explicit marker for restart/downgrade compatibility. It
      // remains under the older client's 20-minute inference after the short lease would have expired.
      expect((await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 }))).renewed).toBe(true);
      expect((await waitFrom(store, roomB.id, instanceHeaders(guest.token), "after=0&timeout=0")).subscription)
        .toMatchObject({ delivered_through: 2, acked_through: 0 });
      clock = new Date(clock.getTime() + Math.max(REPLY_LEASE_MS, REPLY_FRESH_MS) + 1);
      expect((await store.getRoomForPrincipal(host.instance.principal_id, roomB.id)).replying[guest.instance.id]).toMatchObject({ sequence: 2 });

      // A crashed driven turn clears on its short lease, not the legacy 20-minute inference bound.
      expect((await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 }))).renewed).toBe(true);
      clock = new Date(clock.getTime() + Math.max(REPLY_LEASE_MS, REPLY_FRESH_MS) + 1);
      expect((await store.getRoomForPrincipal(host.instance.principal_id, roomB.id)).replying[guest.instance.id]).toBeUndefined();

      // Once a client stops pulsing, the lease expires unless redelivery or ACK clears it.
      expect((await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 }))).renewed).toBe(true);
      // A connector that hands off or retries does not send a racy release. The short lease either
      // expires, is cleared by a same-span redelivery, or is cleared by ACK.

      await ack(store, roomB.id, instanceHeaders(guest.token), { through: 2 });
      expect(await json(await heartbeat(store, roomB.id, instanceHeaders(guest.token), { through: 2 }))).toEqual({
        renewed: false,
        subscription: { room_id: roomB.id, delivered_through: 2, acked_through: 2 },
      });
    });

    it("only ever moves forward, and never past the Room's last message", async () => {
      const store = makeStore();
      const { host, room, as } = await guestIn(store);
      await say(store, room.id, host.token, "one", UUID);
      await say(store, room.id, host.token, "two", crypto.randomUUID());
      expect((await json(await ack(store, room.id, as, { through: 2 }))).subscription).toMatchObject({ delivered_through: 2, acked_through: 2 });
      // Back is no move at all.
      expect((await json(await ack(store, room.id, as, { through: 1 }))).subscription).toMatchObject({ acked_through: 2 });
      // Ahead of the log is capped: a seat cannot have handled what nobody has said yet, and a
      // careless ack must not make it skip what comes next.
      expect((await json(await ack(store, room.id, as, { through: 99 }))).subscription).toMatchObject({ acked_through: 2 });
      await say(store, room.id, host.token, "three", crypto.randomUUID());
      expect((await waitFrom(store, room.id, as)).items.map((m: any) => m.content)).toEqual(["three"]);
    });

    it("keeps each seat's marks its own, and an explicit `after` still notes what it handed over", async () => {
      const store = makeStore();
      const { host, room, principalId, as } = await guestIn(store);
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
      const { member_token: other } = await store.joinRoomWithInvite(invite, room.id, { name: "other" });
      await say(store, room.id, host.token, "hello", UUID);

      const page = await waitFrom(store, room.id, as, "after=0&timeout=0");
      expect(page.subscription).toEqual({ room_id: room.id, delivered_through: 1, acked_through: 0 });
      expect((await json(await request(store, `/api/v1/rooms/${room.id}/subscription`, { headers: { authorization: `Bearer ${other}` } }))).subscription).toEqual({
        room_id: room.id,
        delivered_through: 0,
        acked_through: 0,
      });
      // A wait that hands nothing over says nothing about the subscription, and costs no write.
      const quiet = await waitFrom(store, room.id, as, "after=1&timeout=0");
      expect(quiet.items).toEqual([]);
      expect(quiet).not.toHaveProperty("subscription");
    });

    it("refuses a stranger, a malformed ack, an idempotency key and the wrong method", async () => {
      const store = makeStore();
      const { room, as } = await guestIn(store);
      const stranger = await startInstance(store);
      const strangers = await request(store, `/api/v1/rooms/${room.id}/subscription`, { headers: instanceHeaders(stranger.token) });
      expect([403, 404]).toContain(strangers.status);
      expect((await ack(store, room.id, instanceHeaders(stranger.token), { through: 1 })).status).toBe(strangers.status);
      expect((await heartbeat(store, room.id, instanceHeaders(stranger.token), { through: 1 })).status).toBe(strangers.status);

      for (const body of [{}, { through: -1 }, { through: "1" }, { through: 1.5 }, { through: 1, extra: true }]) {
        const refused = await ack(store, room.id, as, body);
        expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(refused.status, JSON.stringify(body)).toBeLessThan(500);
      }
      for (const body of [
        {},
        { through: -1 },
        { through: "1" },
        { through: 1.5 },
        { through: 1, active: true },
        { through: 1, extra: true },
      ]) {
        const heartbeatRefused = await heartbeat(store, room.id, as, body);
        expect(heartbeatRefused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(heartbeatRefused.status, JSON.stringify(body)).toBeLessThan(500);
      }
      // Unlike ack (which clamps before writing), the heartbeat compares through directly in SQL;
      // values outside PostgreSQL's int4 sequence domain must be rejected before the repository.
      expect((await heartbeat(store, room.id, as, { through: Number.MAX_SAFE_INTEGER })).status).toBe(422);
      const keyed = await request(store, `/api/v1/rooms/${room.id}/ack`, {
        method: "POST",
        headers: { ...as, "content-type": "application/json", "idempotency-key": UUID },
        body: JSON.stringify({ through: 0 }),
      });
      expect((await json(keyed)).error.code).toBe("idempotency_not_supported");
      const heartbeatKeyed = await request(store, `/api/v1/rooms/${room.id}/subscription/heartbeat`, {
        method: "POST",
        headers: { ...as, "content-type": "application/json", "idempotency-key": UUID },
        body: JSON.stringify({ through: 0 }),
      });
      expect((await json(heartbeatKeyed)).error.code).toBe("idempotency_not_supported");
      expect((await request(store, `/api/v1/rooms/${room.id}/ack`, { headers: as })).status).toBe(405);
      expect((await request(store, `/api/v1/rooms/${room.id}/subscription/heartbeat`, { headers: as })).status).toBe(405);
      expect((await request(store, `/api/v1/rooms/${room.id}/subscription`, { method: "POST", headers: as })).status).toBe(405);
    });
  });

  describe("GET /api/v1/inbox", () => {
    const uuid = (n: number) => `3f2504e0-4f89-41d3-9a0c-0305e82c33${String(n).padStart(2, "0")}`;

    /** A clock that moves, so the inbox order is time first and not just Room id. */
    function tickingStore() {
      let tick = Date.parse("2026-09-05T12:00:00.000Z");
      return new MemorySharedNetRepository({
        devApiKey: DEV_KEY,
        now: () => new Date((tick += 1000)),
      });
    }

    async function openRoomAs(store: MemorySharedNetRepository, token: string, name: string, key: string) {
      const created = await request(store, "/api/v1/rooms", {
        method: "POST",
        headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": key }),
        body: JSON.stringify({ name }),
      });
      expect(created.status).toBe(201);
      return (await json(created)).room;
    }

    async function inbox(store: MemorySharedNetRepository, token: string, query = "") {
      const response = await request(store, `/api/v1/inbox${query}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await json(response), headers: response.headers };
    }

    it("gathers an Instance's Rooms in the order things were said, and resumes from an opaque cursor", async () => {
      const store = tickingStore();
      const host = await startInstance(store);
      const alpha = await openRoomAs(store, host.token, "Alpha", uuid(1));
      const beta = await openRoomAs(store, host.token, "Beta", uuid(2));
      await say(store, alpha.id, host.token, "alpha one", uuid(3));
      await say(store, beta.id, host.token, "beta one", uuid(4));
      await say(store, alpha.id, host.token, "alpha two", uuid(5));

      const all = await inbox(store, host.token);
      expect(all.status).toBe(200);
      expect(all.headers.get("cache-control")).toContain("no-store");
      expect(all.body.items.map((m: any) => [m.room_id, m.sequence, m.content])).toEqual([
        [alpha.id, 1, "alpha one"],
        [beta.id, 1, "beta one"],
        [alpha.id, 2, "alpha two"],
      ]);
      expect(all.body.has_more).toBe(false);
      expect(all.body.next_cursor).toMatch(/^ibx_[A-Za-z0-9_-]+$/);

      // Nothing new after the last cursor: an empty page that keeps the cursor.
      const caughtUp = await inbox(store, host.token, `?after=${encodeURIComponent(all.body.next_cursor)}`);
      expect(caughtUp.body).toEqual({ items: [], next_cursor: all.body.next_cursor, has_more: false });

      // Paging: one at a time, each page resuming exactly where the last stopped.
      const first = await inbox(store, host.token, "?limit=1");
      expect(first.body.items.map((m: any) => m.content)).toEqual(["alpha one"]);
      expect(first.body.has_more).toBe(true);
      const second = await inbox(store, host.token, `?limit=1&after=${encodeURIComponent(first.body.next_cursor)}`);
      expect(second.body.items.map((m: any) => m.content)).toEqual(["beta one"]);
      const third = await inbox(store, host.token, `?limit=1&after=${encodeURIComponent(second.body.next_cursor)}`);
      expect(third.body.items.map((m: any) => m.content)).toEqual(["alpha two"]);
      expect(third.body.has_more).toBe(false);
    });

    it("shows a member only the Rooms it is in: a second Instance in one Room, a guest in its one Room", async () => {
      const store = tickingStore();
      const host = await startInstance(store);
      const alpha = await openRoomAs(store, host.token, "Alpha", uuid(1));
      const beta = await openRoomAs(store, host.token, "Beta", uuid(2));
      await say(store, alpha.id, host.token, "alpha one", uuid(3));
      await say(store, beta.id, host.token, "beta one", uuid(4));

      const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY });
      const joined = await request(store, `/api/v1/rooms/${beta.id}/join`, {
        method: "POST",
        headers: instanceHeaders(other.token, { "idempotency-key": uuid(6) }),
      });
      expect(joined.status).toBe(200);
      const otherInbox = await inbox(store, other.token);
      expect(otherInbox.body.items.map((m: any) => [m.room_id, m.content])).toEqual([[beta.id, "beta one"]]);

      const { token: invite } = await store.createRoomInvite({
        roomId: alpha.id,
        principalId: host.instance.principal_id,
      });
      const { member_token: guestToken } = await store.joinRoomWithInvite(invite, alpha.id, { name: "guest" });
      const guestInbox = await inbox(store, guestToken);
      expect(guestInbox.body.items.map((m: any) => [m.room_id, m.content])).toEqual([[alpha.id, "alpha one"]]);

      const nobody = await startInstance(store, { local_instance_key: "c".repeat(64) });
      const empty = await inbox(store, nobody.token);
      expect(empty.body).toEqual({ items: [], next_cursor: null, has_more: false });
    });

    it("refuses a cursor that is not an inbox cursor, an unknown parameter, a bad limit, and the wrong method", async () => {
      const store = tickingStore();
      const host = await startInstance(store);

      const numeric = await inbox(store, host.token, "?after=5");
      expect(numeric.status).toBe(400);
      expect(numeric.body.error.code).toBe("invalid_cursor");
      const unknown = await inbox(store, host.token, "?since=1");
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe("invalid_request");
      const limit = await inbox(store, host.token, "?limit=0");
      expect(limit.status).toBe(400);
      const posted = await request(store, "/api/v1/inbox", {
        method: "POST",
        headers: instanceHeaders(host.token),
      });
      expect(posted.status).toBe(405);
      const anonymous = await request(store, "/api/v1/inbox");
      expect(anonymous.status).toBe(401);
      const apiKey = await request(store, "/api/v1/inbox", { headers: apiHeaders() });
      expect(apiKey.status).toBe(401);
    });
  });

  describe("sharednet login", () => {
    async function startLogin(store: MemorySharedNetRepository, body: unknown = { label: "laptop" }) {
      const response = await request(store, "/api/v1/cli/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toContain("no-store");
      return json(response);
    }

    async function poll(store: MemorySharedNetRepository, loginId: string, token: string) {
      return request(store, `/api/v1/cli/logins/${loginId}/poll`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
    }

    it("starts pending, answers pending until approved, then hands over one key that works", async () => {
      const store = makeStore();
      const started = await startLogin(store);
      expect(started.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
      expect(started.poll_token).toMatch(/^clp_[A-Za-z0-9_-]{43}$/);
      expect(started.verify_url).toBe(`http://127.0.0.1:3001/cli/authorize?code=${started.user_code}`);
      expect(started.login).toMatchObject({ state: "pending", label: "laptop", bind_instance_ids: [] });
      expect(started.login.id).toMatch(/^cli_[A-Za-z0-9]{10}$/);

      const pending = await poll(store, started.login.id, started.poll_token);
      expect(pending.status).toBe(200);
      expect((await json(pending)).state).toBe("pending");

      const host = await startInstance(store);
      const approved = await store.approveCliLogin({
        code: started.user_code,
        principalId: host.instance.principal_id,
      });
      expect(approved.login.state).toBe("approved");

      const handed = await poll(store, started.login.id, started.poll_token);
      expect(handed.status).toBe(200);
      const body = await json(handed);
      expect(body.state).toBe("approved");
      expect(body.api_key).toMatch(/^snk_[A-Za-z0-9_-]{43}$/);
      expect(body.api_key_id).toMatch(/^key_[A-Za-z0-9]{10}$/);
      expect(body.principal.id).toBe(host.instance.principal_id);

      // The key is real: it registers an Instance for that Principal.
      const registered = await request(store, "/api/v1/instances", {
        method: "POST",
        headers: { authorization: `Bearer ${body.api_key}`, "content-type": "application/json" },
        body: JSON.stringify({ runtime_kind: "claude-code", cli_version: "0.1.3" }),
      });
      expect(registered.status).toBe(201);
      expect((await json(registered)).instance.principal_id).toBe(host.instance.principal_id);

      // And it is handed over exactly once.
      const again = await poll(store, started.login.id, started.poll_token);
      expect(again.status).toBe(410);
      expect((await json(again)).error.code).toBe("login_consumed");
    });

    it("binds the anonymous seats the CLI proved it holds: the seat, its Room, and its history move to the account", async () => {
      const store = makeStore();
      const { host, room, principalId } = await openRoom(store);
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId });
      const guest = await store.joinRoomWithInvite(invite, room.id, { name: "claude-code" });
      await say(store, room.id, guest.member_token, "said while anonymous");
      const anonymousPrincipal = guest.membership.principal_id;
      expect(anonymousPrincipal).not.toBe(principalId);

      const other = await startInstance(store, { local_instance_key: OTHER_SESSION_KEY }, 201);
      void other;
      const started = await startLogin(store, { label: "laptop", seats: [guest.member_token, `sni_${"z".repeat(43)}`] });
      expect(started.login.bind_instance_ids).toEqual([guest.membership.member_id]);

      // The Room's host approves as itself: the anonymous Principal folds into it.
      const approved = await store.approveCliLogin({ code: started.user_code, principalId });
      expect(approved.bound_principal_ids).toEqual([anonymousPrincipal]);

      const detail = await request(store, `/api/v1/rooms/${room.id}`, {
        headers: instanceHeaders(host.token),
      });
      const seat = (await json(detail)).memberships.find((m: any) => m.member_id === guest.membership.member_id);
      expect(seat.principal_id).toBe(principalId);
      // Kind follows the Principal: bound, the seat is an Instance of the account.
      expect(seat.kind).toBe("instance");
      expect(seat.admitted_by).toBe("invite");
      expect(seat.name).toBe("claude-code");
      const page = await json(
        await request(store, `/api/v1/rooms/${room.id}/messages?after=0`, { headers: instanceHeaders(host.token) }),
      );
      const message = page.items.find((m: any) => m.content === "said while anonymous");
      expect(message.sender_principal_id).toBe(principalId);
      expect(message.sender_instance_id).toBe(guest.membership.member_id);

      // The seat's own token still works, now as the account's Instance.
      const stillSpeaks = await say(store, room.id, guest.member_token, "and after binding");
      expect(stillSpeaks.status).toBe(201);
      expect((await json(stillSpeaks)).message.sender_principal_id).toBe(principalId);

      // Binding is one-way: a second login naming the same seat binds nothing new.
      const second = await startLogin(store, { seats: [guest.member_token] });
      expect(second.login.bind_instance_ids).toEqual([]);
    });

    it("refuses a wrong poll token, an unknown code, an expired login, and a second approval", async () => {
      let tick = Date.parse("2026-09-06T10:00:00.000Z");
      const store = new MemorySharedNetRepository({ devApiKey: DEV_KEY, now: () => new Date(tick) });
      const started = await startLogin(store);

      const wrongToken = await poll(store, started.login.id, `clp_${"w".repeat(43)}`);
      expect(wrongToken.status).toBe(404);
      const notAToken = await poll(store, started.login.id, "sni_notapolltoken");
      expect(notAToken.status).toBe(401);
      const host = await startInstance(store);
      await expect(
        store.approveCliLogin({ code: "ZZZZ-ZZZZ", principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_not_found" });

      tick += 11 * 60_000;
      const expired = await poll(store, started.login.id, started.poll_token);
      expect(expired.status).toBe(410);
      expect((await json(expired)).error.code).toBe("login_expired");
      await expect(
        store.approveCliLogin({ code: started.user_code, principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_expired" });

      const fresh = await startLogin(store);
      await store.approveCliLogin({ code: fresh.user_code, principalId: host.instance.principal_id });
      await expect(
        store.approveCliLogin({ code: fresh.user_code, principalId: host.instance.principal_id }),
      ).rejects.toMatchObject({ code: "login_consumed" });
    });
  });
});

describe("credits: a purse per Principal, a ledger of every movement", () => {
  const ALICE = `snk_${"c".repeat(43)}`;
  const BOB = `snk_${"d".repeat(43)}`;
  const CAROL = `snk_${"e".repeat(43)}`;

  /** Three accounts with keys, one code worth 100 that two of them may redeem, one that has expired. */
  function creditStore() {
    return new MemorySharedNetRepository({
      now: () => new Date("2026-09-12T10:00:00.000Z"),
      accounts: [
        { authUserId: "alice", apiKey: ALICE },
        { authUserId: "bob", apiKey: BOB },
        { authUserId: "carol", apiKey: CAROL },
      ],
      creditCodes: [
        { code: "HACK-2026", amount: 100, max_redemptions: 2 },
        { code: "LASTYEAR", amount: 50, expires_at: "2026-09-01T00:00:00.000Z" },
      ],
    });
  }

  async function seat(store: MemorySharedNetRepository, key: string) {
    const { instance, token } = await startWithKey(store, key, { runtime_kind: "claude-code" });
    return { instanceId: instance.id as string, token: token as string, principalId: instance.principal_id as string };
  }

  function post(store: MemorySharedNetRepository, path: string, token: string, body: unknown, extra: Record<string, string> = {}) {
    return request(store, path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  }

  it("redeems a code once per account, caps it, refuses an anonymous seat, and refuses an expired one", async () => {
    const store = creditStore();

    const first = await post(store, "/api/v1/credits/redeem", ALICE, { code: "hack-2026" });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const firstBody = await json(first);
    expect(firstBody.granted).toBe(100);
    expect(firstBody.credits).toMatchObject({ balance: 100, granted: 100, sent: 0, received: 0 });
    expect(firstBody.transfer).toMatchObject({ from_principal_id: null, amount: 100, code: "HACK-2026", by_instance_id: null });

    // A retry is not cheating: the purse is unchanged and nothing was granted.
    const again = await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" }));
    expect(again).toMatchObject({ granted: 0, transfer: null, credits: { balance: 100 } });

    // Two redemptions were allowed; the third account is told the code is spent.
    expect((await json(await post(store, "/api/v1/credits/redeem", BOB, { code: "HACK-2026" }))).granted).toBe(100);
    const exhausted = await post(store, "/api/v1/credits/redeem", CAROL, { code: "HACK-2026" });
    expect(exhausted.status).toBe(410);
    expect((await json(exhausted)).error.code).toBe("credit_code_exhausted");

    const expired = await post(store, "/api/v1/credits/redeem", CAROL, { code: "LASTYEAR" });
    expect(expired.status).toBe(410);
    expect((await json(expired)).error.code).toBe("credit_code_expired");
    const unknown = await post(store, "/api/v1/credits/redeem", CAROL, { code: "NOPE" });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error.code).toBe("credit_code_not_found");
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "" })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "x", extra: 1 })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/redeem", CAROL, { code: "HACK-2026" }, { "idempotency-key": crypto.randomUUID() })).status).toBe(400);

    // An anonymous Principal is free to create, so it may hold credits but never redeem a code.
    const alice = await seat(store, ALICE);
    const opened = await json(await post(store, "/api/v1/rooms", alice.token, { name: "Trade" }, { "idempotency-key": crypto.randomUUID() }));
    const invite = await json(
      await request(store, `/api/v1/rooms/${opened.room.id}/invites`, { method: "POST", headers: instanceHeaders(alice.token) }),
    );
    const guest = await json(
      await post(store, `/api/v1/rooms/${opened.room.id}/join`, invite.token, { name: "stranger", runtime: { kind: "curl" } }),
    );
    const refused = await post(store, "/api/v1/credits/redeem", guest.member_token, { code: "HACK-2026" });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe("credits_account_required");
  });

  it("keeps a settled redemption settled after the code expires, and measures a memo the way the column does", async () => {
    const clock = { now: new Date("2026-09-12T10:00:00.000Z") };
    const store = new MemorySharedNetRepository({
      now: () => clock.now,
      accounts: [{ authUserId: "alice", apiKey: ALICE }, { authUserId: "bob", apiKey: BOB }],
      creditCodes: [{ code: "SOON", amount: 10, expires_at: "2026-09-12T11:00:00.000Z" }],
    });

    expect((await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "SOON" }))).granted).toBe(10);
    clock.now = new Date("2026-09-12T12:00:00.000Z");
    // What this account already redeemed is history; the expiry does not unsettle it.
    expect((await json(await post(store, "/api/v1/credits/redeem", ALICE, { code: "SOON" }))).granted).toBe(0);
    // Someone who never redeemed it is told the truth.
    const late = await post(store, "/api/v1/credits/redeem", BOB, { code: "SOON" });
    expect(late.status).toBe(410);
    expect((await json(late)).error.code).toBe("credit_code_expired");

    // A memo is measured after NFKC, because that is what gets stored: "ﬃ"
    // is one character on the way in and three on the way out.
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const expanding = "\uFB03".repeat(100);
    const refused = await post(
      store,
      "/api/v1/credits/transfers",
      alice.token,
      { to: bob.principalId, amount: 1, memo: expanding },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(refused.status).toBe(422);
    const accepted = await post(
      store,
      "/api/v1/credits/transfers",
      alice.token,
      { to: bob.principalId, amount: 1, memo: "\uFB03".repeat(60) },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(accepted.status).toBe(201);
    expect((await json(accepted)).transfer.memo).toBe("ffi".repeat(60));
  });

  it("follows a claimed seat to the account that claimed it, on both sides of a payment", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const opened = await json(await post(store, "/api/v1/rooms", alice.token, { name: "Trade" }, { "idempotency-key": crypto.randomUUID() }));
    const invite = await json(
      await request(store, `/api/v1/rooms/${opened.room.id}/invites`, { method: "POST", headers: instanceHeaders(alice.token) }),
    );
    const guest = await json(
      await post(store, `/api/v1/rooms/${opened.room.id}/join`, invite.token, { name: "stranger", runtime: { kind: "curl" } }),
    );
    // The guest is paid while it is still anonymous.
    await post(store, "/api/v1/credits/transfers", alice.token, { to: guest.membership.member_id, amount: 20 }, { "idempotency-key": crypto.randomUUID() });
    expect((await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(guest.member_token) }))).credits.balance).toBe(20);

    // Its human logs in on that machine and claims the seat for Bob's account.
    const login = await json(
      await request(store, "/api/v1/cli/logins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "guest laptop", seats: [guest.member_token] }),
      }),
    );
    await store.approveCliLogin({ code: login.user_code, principalId: (await store.principalForAccount("bob"))!.id });

    // The same token now spends Bob's purse, and Bob's purse holds what the guest was paid.
    const afterClaim = await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(guest.member_token) }));
    expect(afterClaim.credits).toMatchObject({ balance: 20, received: 20 });
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(20);
    // And paying that seat's id now reaches Bob, not the Principal it was born under.
    const paid = await json(
      await post(store, "/api/v1/credits/transfers", alice.token, { to: guest.membership.member_id, amount: 5 }, { "idempotency-key": crypto.randomUUID() }),
    );
    expect(paid.transfer.to_principal_id).toBe((await store.principalForAccount("bob"))!.id);
  });

  it("keeps one payment replay across guest claim and refuses a changed body", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const aliceAuth = await store.authenticateInstance(alice.token);
    const { room } = await store.createRoom(aliceAuth!, { name: "Replay after claim" });
    const invite = await store.createRoomInvite({ roomId: room.id, principalId: aliceAuth!.principalId });
    const guest = await store.joinRoomWithInvite(invite.token, room.id, { name: "payer" });
    await post(store, "/api/v1/credits/transfers", ALICE, { to: guest.membership.instance_id, amount: 20 }, { "idempotency-key": crypto.randomUUID() });
    const key = crypto.randomUUID();
    const body = { to: alice.principalId, amount: 7 };
    const first = await post(store, "/api/v1/credits/transfers", guest.member_token, body, { "idempotency-key": key });
    const firstText = await first.text();
    expect(first.status).toBe(201);
    const login = await store.startCliLogin({ label: "payer", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: (await store.principalForAccount("bob"))!.id });

    const replay = await post(store, "/api/v1/credits/transfers", guest.member_token, body, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await replay.text()).toBe(firstText);
    const conflict = await post(store, "/api/v1/credits/transfers", guest.member_token, { ...body, amount: 8 }, { "idempotency-key": key });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(13);

    // A second Instance of the same account owns a separate replay namespace.
    const independent = await post(store, "/api/v1/credits/transfers", bob.token, body, { "idempotency-key": key });
    expect(independent.status).toBe(201);
    expect(independent.headers.get("idempotency-replayed")).toBeNull();
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, BOB) }))).credits.balance).toBe(6);
  });

  it("retains the Principal namespace for account-key idempotency", async () => {
    const store = creditStore();
    const alice = (await store.authenticateApiKey(ALICE))!;
    const bob = (await store.authenticateApiKey(BOB))!;
    const key = crypto.randomUUID();
    const scope = { principalId: alice.principalId, credentialClass: alice.kind, actorId: alice.actorId, operationId: "scope-contract", key };
    const first = await store.executeIdempotent(scope, "same-body", async () => ({ status: 201, body: "first Principal" }));
    const second = await store.executeIdempotent({ ...scope, principalId: bob.principalId }, "same-body", async () => ({ status: 201, body: "second Principal" }));
    expect(first).toMatchObject({ replayed: false, body: "first Principal" });
    expect(second).toMatchObject({ replayed: false, body: "second Principal" });
  });

  it("pays by Principal, Agent or Instance id, exactly once per key, never more than the purse holds, never to itself", async () => {
    const store = creditStore();
    await post(store, "/api/v1/credits/redeem", ALICE, { code: "HACK-2026" });
    const alice = await seat(store, ALICE);
    const bob = await seat(store, BOB);
    const { agent: bobsTag } = await (async () => {
      const response = await request(store, "/api/v1/agents", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }, BOB),
        body: JSON.stringify({ handle: "bob-bot" }),
      });
      return json(response);
    })();

    const key = crypto.randomUUID();
    const body = { to: bob.instanceId, amount: 30, memo: "map tiles" };
    const paid = await post(store, "/api/v1/credits/transfers", alice.token, body, { "idempotency-key": key });
    expect(paid.status).toBe(201);
    const paidBody = await json(paid);
    expect(paidBody.transfer).toMatchObject({
      from_principal_id: alice.principalId,
      to_principal_id: bob.principalId,
      amount: 30,
      memo: "map tiles",
      by_instance_id: alice.instanceId,
      addressed_to: bob.instanceId,
      code: null,
    });
    expect(paidBody.credits).toMatchObject({ balance: 70, granted: 100, sent: 30, received: 0 });

    const replay = await post(store, "/api/v1/credits/transfers", alice.token, body, { "idempotency-key": key });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect(await json(replay)).toEqual(paidBody);
    expect((await json(await request(store, "/api/v1/credits", { headers: apiHeaders({}, ALICE) }))).credits.balance).toBe(70);

    // The same purse answers to the account key, which pays with no seat behind it.
    const byKey = await post(store, "/api/v1/credits/transfers", ALICE, { to: bobsTag.id, amount: 5 }, { "idempotency-key": crypto.randomUUID() });
    expect((await json(byKey)).transfer).toMatchObject({ to_principal_id: bob.principalId, by_instance_id: null, addressed_to: bobsTag.id });
    const byPrincipal = await post(store, "/api/v1/credits/transfers", ALICE, { to: bob.principalId, amount: 5 }, { "idempotency-key": crypto.randomUUID() });
    expect(byPrincipal.status).toBe(201);
    expect((await json(await request(store, "/api/v1/credits", { headers: instanceHeaders(bob.token) }))).credits).toMatchObject({ balance: 40, received: 40, granted: 0, sent: 0 });

    const tooMuch = await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 61 }, { "idempotency-key": crypto.randomUUID() });
    expect(tooMuch.status).toBe(409);
    expect((await json(tooMuch)).error.code).toBe("insufficient_credits");
    const nobody = await post(store, "/api/v1/credits/transfers", alice.token, { to: "i_nobody0001", amount: 1 }, { "idempotency-key": crypto.randomUUID() });
    expect(nobody.status).toBe(404);
    expect((await json(nobody)).error.code).toBe("payee_not_found");
    const self = await post(store, "/api/v1/credits/transfers", alice.token, { to: alice.instanceId, amount: 1 }, { "idempotency-key": crypto.randomUUID() });
    expect(self.status).toBe(422);
    expect((await json(self)).error.code).toBe("transfer_to_self");
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1 })).status).toBe(400);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1.5 }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: bob.principalId, amount: 1, memo: "x".repeat(201) }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await post(store, "/api/v1/credits/transfers", alice.token, { to: "rom_nowhere001", amount: 1 }, { "idempotency-key": crypto.randomUUID() })).status).toBe(422);
    expect((await request(store, "/api/v1/credits")).status).toBe(401);
    expect((await request(store, "/api/v1/credits", { headers: { authorization: `Bearer rit_${"t".repeat(43)}` } })).status).toBe(401);

    // The ledger, newest first, as each side reads it; paging by transfer id.
    const alicesLedger = await json(await request(store, "/api/v1/credits/transfers?limit=2", { headers: instanceHeaders(alice.token) }));
    expect(alicesLedger.items.map((t: { amount: number; code: string | null }) => [t.amount, t.code])).toEqual([[5, null], [5, null]]);
    expect(alicesLedger.has_more).toBe(true);
    const rest = await json(
      await request(store, `/api/v1/credits/transfers?limit=2&before=${alicesLedger.next_cursor}`, { headers: instanceHeaders(alice.token) }),
    );
    expect(rest.items.map((t: { amount: number; code: string | null }) => [t.amount, t.code])).toEqual([[30, null], [100, "HACK-2026"]]);
    expect(rest.has_more).toBe(false);
    const bobsLedger = await json(await request(store, "/api/v1/credits/transfers", { headers: apiHeaders({}, BOB) }));
    expect(bobsLedger.items.map((t: { amount: number }) => t.amount)).toEqual([5, 5, 30]);
    expect((await request(store, "/api/v1/credits/transfers?before=txn_nowhere001", { headers: apiHeaders({}, BOB) })).status).toBe(400);
    expect((await request(store, "/api/v1/credits/transfers?limit=0", { headers: apiHeaders({}, BOB) })).status).toBe(400);
  });
});

describe("artifacts: a file an Agent hands to the Room", () => {
  const OWNER = `snk_${"f".repeat(43)}`;
  const MEMBER = `snk_${"g".repeat(43)}`;
  const STRANGER = `snk_${"h".repeat(43)}`;

  /** The clock advances a second per read, so "newest first" is a real order. */
  function artifactStore() {
    let tick = 0;
    return new MemorySharedNetRepository({
      now: () => new Date(Date.parse("2026-09-12T10:00:00.000Z") + tick++ * 1000),
      accounts: [
        { authUserId: "owner", apiKey: OWNER },
        { authUserId: "member", apiKey: MEMBER },
        { authUserId: "stranger", apiKey: STRANGER },
      ],
    });
  }

  /** An owner's seat, a Room it opened, and a second account seated in it. */
  async function sharedRoom(store: MemorySharedNetRepository) {
    const owner = await startWithKey(store, OWNER, { runtime_kind: "claude-code" });
    const member = await startWithKey(store, MEMBER, { runtime_kind: "codex" });
    const ownerAuth = (await store.authenticateInstance(owner.token as string))!;
    const memberAuth = (await store.authenticateInstance(member.token as string))!;
    const { room } = await store.createRoom(ownerAuth, { name: "Handover" });
    await store.joinRoom(memberAuth, room.id);
    return { owner, member, ownerAuth, memberAuth, roomId: room.id as string };
  }

  function upload(
    store: MemorySharedNetRepository,
    token: string,
    bytes: string | Uint8Array,
    headers: Record<string, string>,
  ) {
    return request(store, "/api/v1/artifacts", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": crypto.randomUUID(), ...headers },
      body: bytes as BodyInit,
    });
  }

  it("hands a file to a Room: its members read it, a stranger is told it does not exist", async () => {
    const store = artifactStore();
    const { owner, member, roomId } = await sharedRoom(store);
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

    const created = await upload(store, owner.token as string, patch, {
      "content-type": "text/plain; charset=utf-8",
      "x-sharednet-filename": "fix.patch",
      "x-sharednet-room": roomId,
    });
    expect(created.status).toBe(201);
    const createdBody = await json(created.clone());
    const { artifact } = createdBody;
    expect(artifact).toMatchObject({
      filename: "fix.patch",
      content_type: "text/plain",
      room_id: roomId,
      size_bytes: patch.length,
      uploaded_by_instance_id: (owner as { instance: { id: string } }).instance.id,
    });
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.id).toMatch(/^art_[0-9A-Za-z]{10}$/);
    // Every file has a link, handed back exactly once, with the file it opens.
    expect(createdBody.link_key).toMatch(/^afk_[A-Za-z0-9_-]{43}$/);
    expect(createdBody.url).toBe(`http://127.0.0.1:3001/f/${artifact.id}?k=${createdBody.link_key}`);
    // And a read never hands the key out again.
    expect(await json(await request(store, `/api/v1/artifacts/${artifact.id}`, { headers: apiHeaders({}, OWNER) }))).toEqual({ artifact });

    // The other member reads the bytes, as an attachment and nothing else.
    const content = await request(store, `/api/v1/artifacts/${artifact.id}/content`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(patch);
    expect(content.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''fix.patch");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("x-sharednet-sha256")).toBe(artifact.sha256);

    // An account with no seat in that Room cannot see that the file exists.
    for (const path of [`/api/v1/artifacts/${artifact.id}`, `/api/v1/artifacts/${artifact.id}/content`]) {
      const refused = await request(store, path, { headers: apiHeaders({}, STRANGER) });
      expect(refused.status).toBe(404);
      expect((await json(refused)).error.code).toBe("artifact_not_found");
    }
    // And only the uploader may remove it.
    expect((await request(store, `/api/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: { authorization: `Bearer ${member.token}` } })).status).toBe(404);
    const removed = await request(store, `/api/v1/artifacts/${artifact.id}`, { method: "DELETE", headers: apiHeaders({}, OWNER) });
    expect(removed.status).toBe(200);
    expect((await request(store, `/api/v1/artifacts/${artifact.id}`, { headers: apiHeaders({}, OWNER) })).status).toBe(404);
  });

  it("refuses to address a file to a Room the caller does not sit in, or to a closed one", async () => {
    const store = artifactStore();
    const { owner, roomId } = await sharedRoom(store);

    const notMine = await upload(store, STRANGER, "x", {
      "x-sharednet-filename": "x.txt",
      "x-sharednet-room": roomId,
    });
    expect(notMine.status).toBe(404);
    expect((await json(notMine)).error.code).toBe("room_not_found");

    await store.closeRoom((await store.principalForAccount("owner"))!.id, roomId as never);
    const closed = await upload(store, owner.token as string, "x", {
      "x-sharednet-filename": "x.txt",
      "x-sharednet-room": roomId,
    });
    expect(closed.status).toBe(409);
    expect((await json(closed)).error.code).toBe("room_closed");
  });

  it("opens a file by its link alone, with no account, and refuses a wrong key the same way as a missing file", async () => {
    const store = artifactStore();
    const { owner } = await sharedRoom(store);

    // No Room named: still a file, still a link, addressed to nobody.
    const created = await upload(store, owner.token as string, "a,b\n1,2\n", {
      "content-type": "text/csv",
      "x-sharednet-filename": "rows.csv",
    });
    expect(created.status).toBe(201);
    const body = await json(created);
    expect(body.link_key).toMatch(/^afk_[A-Za-z0-9_-]{43}$/);
    expect(body.url).toBe(`http://127.0.0.1:3001/f/${body.artifact.id}?k=${body.link_key}`);
    expect(body.artifact.room_id).toBeNull();

    const opened = await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=${body.link_key}`);
    expect(opened.status).toBe(200);
    expect(await opened.text()).toBe("a,b\n1,2\n");
    expect(opened.headers.get("content-type")).toBe("text/csv");

    const wrong = await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=afk_${"z".repeat(43)}`);
    expect(wrong.status).toBe(404);
    expect((await json(wrong)).error.code).toBe("artifact_not_found");
    expect((await request(store, `/api/v1/artifacts/${body.artifact.id}/content?k=nonsense`)).status).toBe(404);
    // One file's key opens that file and nothing else, not even the same account's next one.
    const other = await json(await upload(store, owner.token as string, "x", { "x-sharednet-filename": "x.txt" }));
    expect((await request(store, `/api/v1/artifacts/${other.artifact.id}/content?k=${body.link_key}`)).status).toBe(404);
    // And a reader holding a key is still nobody: it cannot list or inspect.
    expect((await request(store, `/api/v1/artifacts/${body.artifact.id}`)).status).toBe(401);
    expect((await request(store, "/api/v1/artifacts")).status).toBe(401);
  });

  it("decodes the explicit UTF-8 filename header and preserves literal percent names", async () => {
    const store = artifactStore();
    const { owner } = await sharedRoom(store);
    for (const [headers, expected] of [
      [{ "x-sharednet-filename*": `UTF-8''${encodeURIComponent("研究报告.md")}` }, "研究报告.md"],
      [{ "x-sharednet-filename": "fallback.md", "x-sharednet-filename*": "UTF-8''caf%C3%A9.md" }, "café.md"],
      [{ "x-sharednet-filename": "report%20.md" }, "report%20.md"],
    ] as [Record<string, string>, string][]) {
      const response = await upload(store, owner.token as string, "bytes", { ...headers, "x-sharednet-reach": "private" });
      expect(response.status).toBe(201);
      expect((await json(response)).artifact.filename).toBe(expected);
    }
    for (const value of ["", "ISO-8859-1''caf%E9.md", "UTF-8''%ZZ", "UTF-8''%FF", "UTF-8''..%2Fsecret", "UTF-8''bad%00name"]) {
      const response = await upload(store, owner.token as string, "bytes", {
        "x-sharednet-reach": "private",
        "x-sharednet-filename": "fallback.md",
        "x-sharednet-filename*": value,
      });
      expect(response.status).toBe(422);
      expect((await json(response)).error.code).toBe("validation_failed");
    }
  });

  it("serves anything that could run in a browser as bytes, never inline", async () => {
    const store = artifactStore();
    const { owner } = await sharedRoom(store);
    for (const [type, filename] of [
      ["text/html", "page.html"],
      ["image/svg+xml", "logo.svg"],
      ["application/javascript", "script.js"],
    ]) {
      const created = await json(
        await upload(store, owner.token as string, "<script>alert(1)</script>", {
          "content-type": type!,
          "x-sharednet-filename": filename!,
          "x-sharednet-reach": "link",
        }),
      );
      const served = await request(store, `/api/v1/artifacts/${created.artifact.id}/content?k=${created.link_key}`);
      expect(served.headers.get("content-type")).toBe("application/octet-stream");
      expect(served.headers.get("content-disposition")).toContain("attachment");
      expect(served.headers.get("content-security-policy")).toContain("sandbox");
    }
  });

  it("refuses a filename that is a path, an empty body, and a file over the limit", async () => {
    const store = artifactStore();
    const { owner, roomId } = await sharedRoom(store);
    const bad = { "x-sharednet-room": roomId };

    for (const filename of ["../../etc/passwd", "a/b.txt", "b\\c.txt", ".", "..", "", "x".repeat(121)]) {
      const refused = await upload(store, owner.token as string, "x", { ...bad, "x-sharednet-filename": filename });
      expect(refused.status).toBe(422);
    }
    expect((await upload(store, owner.token as string, "x", bad)).status).toBe(422);
    expect((await upload(store, owner.token as string, "", { ...bad, "x-sharednet-filename": "empty.txt" })).status).toBe(422);
    // A Room is optional; a malformed one is not.
    expect((await upload(store, owner.token as string, "x", { "x-sharednet-filename": "x.txt" })).status).toBe(201);
    expect((await upload(store, owner.token as string, "x", { "x-sharednet-filename": "x.txt", "x-sharednet-room": "not-a-room" })).status).toBe(400);

    const tooBig = new Uint8Array(4 * 1024 * 1024 + 1);
    tooBig.fill(65);
    const refused = await upload(store, owner.token as string, tooBig, { ...bad, "x-sharednet-filename": "big.bin" });
    expect(refused.status).toBe(413);
    expect((await json(refused)).error.code).toBe("artifact_too_large");
  });

  it("lists what the caller may read, newest first, and replays an upload that carried the same key", async () => {
    const store = artifactStore();
    const { owner, member, roomId } = await sharedRoom(store);
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const filename of names) {
      expect((await upload(store, owner.token as string, filename, { "x-sharednet-filename": filename, "x-sharednet-room": roomId })).status).toBe(201);
    }
    // A file of the owner's with no Room: the member must not see it.
    await upload(store, owner.token as string, "mine", { "x-sharednet-filename": "mine.txt" });

    const ownerList = await json(await request(store, "/api/v1/artifacts", { headers: apiHeaders({}, OWNER) }));
    expect(ownerList.items.map((item: { filename: string }) => item.filename)).toEqual(["mine.txt", "three.txt", "two.txt", "one.txt"]);
    const memberList = await json(await request(store, "/api/v1/artifacts", { headers: { authorization: `Bearer ${member.token}` } }));
    expect(memberList.items.map((item: { filename: string }) => item.filename)).toEqual(["three.txt", "two.txt", "one.txt"]);
    const paged = await json(await request(store, "/api/v1/artifacts?limit=2", { headers: { authorization: `Bearer ${member.token}` } }));
    expect(paged.has_more).toBe(true);
    const rest = await json(
      await request(store, `/api/v1/artifacts?limit=2&before=${paged.next_cursor}`, { headers: { authorization: `Bearer ${member.token}` } }),
    );
    expect(rest.items.map((item: { filename: string }) => item.filename)).toEqual(["one.txt"]);
    expect((await request(store, "/api/v1/artifacts?before=art_nowhere01", { headers: apiHeaders({}, OWNER) })).status).toBe(400);
    expect((await request(store, `/api/v1/artifacts?room_id=${roomId}`, { headers: apiHeaders({}, STRANGER) }))).toBeTruthy();

    // One key, one file: a retried upload does not store the bytes twice.
    const key = crypto.randomUUID();
    const headers = { authorization: `Bearer ${owner.token}`, "idempotency-key": key, "x-sharednet-filename": "once.txt", "x-sharednet-room": roomId };
    const first = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "once" });
    const replay = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "once" });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect(replay.headers.get("idempotency-replayed")).toBe("true");
    expect((await json(replay)).artifact.id).toBe((await json(first)).artifact.id);
    // A different file under the same key is a conflict, not a second upload.
    const conflict = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "twice" });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    expect((await request(store, "/api/v1/artifacts", { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "x-sharednet-filename": "x.txt", "x-sharednet-room": roomId }, body: "x" })).status).toBe(400);
  });
  it("keeps every guest file manageable by the claiming account, including the original upload replay", async () => {
    const store = artifactStore();
    const { ownerAuth, memberAuth, roomId } = await sharedRoom(store);
    const { token } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: ownerAuth.principalId });
    const guest = await store.joinRoomWithInvite(token, roomId as `rom_${string}`, { name: "file author", runtime: { kind: "curl" } });
    const guestAuth = (await store.authenticateInstance(guest.member_token))!;
    const files = [];
    for (const reach of ["private", "room", "link"] as const) {
      const headers = {
        authorization: `Bearer ${guest.member_token}`,
        "idempotency-key": crypto.randomUUID(),
        "x-sharednet-filename": `${reach}.txt`,
        "x-sharednet-reach": reach,
        ...(reach === "room" ? { "x-sharednet-room": roomId } : {}),
      };
      const response = await request(store, "/api/v1/artifacts", { method: "POST", headers, body: "guest file" });
      expect(response.status).toBe(201);
      const body = await response.text();
      const decoded = JSON.parse(body) as { artifact: { id: `art_${string}` }; link_key?: string };
      files.push({ reach, headers, body, ...decoded });
    }
    expect(await store.artifactUsage(guestAuth)).toMatchObject({ bytes: 30, count: 3 });
    const login = await store.startCliLogin({ label: "file author", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: ownerAuth.principalId });
    const claimed = (await store.authenticateInstance(guest.member_token))!;
    expect(claimed.principalId).toBe(ownerAuth.principalId);
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 30, count: 3 });
    expect((await store.listArtifacts(claimed, { room_id: null, before: null, limit: 50 })).items).toHaveLength(3);
    for (const file of files) {
      const read = await store.readArtifact(claimed, file.artifact.id);
      expect(new TextDecoder().decode(read.bytes)).toBe("guest file");
      expect(read.artifact.principal_id).toBe(ownerAuth.principalId);
      await expect(store.deleteArtifact(memberAuth, file.artifact.id)).rejects.toMatchObject({ code: "artifact_not_found" });
      if (file.reach !== "room") await expect(store.readArtifact(memberAuth, file.artifact.id)).rejects.toMatchObject({ code: "artifact_not_found" });
      const replay = await request(store, "/api/v1/artifacts", { method: "POST", headers: file.headers, body: "guest file" });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotency-replayed")).toBe("true");
      expect(await replay.text()).toBe(file.body);
      const conflict = await request(store, "/api/v1/artifacts", { method: "POST", headers: file.headers, body: "changed" });
      expect(conflict.status).toBe(409);
      expect((await json(conflict)).error.code).toBe("idempotency_conflict");
    }
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 30, count: 3 });
    for (const file of files) {
      expect((await store.deleteArtifact(claimed, file.artifact.id)).artifact.principal_id).toBe(ownerAuth.principalId);
      if (file.link_key) await expect(store.readArtifactByLink(file.artifact.id, file.link_key)).rejects.toMatchObject({ code: "artifact_not_found" });
    }
    expect(await store.artifactUsage(claimed)).toMatchObject({ bytes: 0, count: 0 });
  });

  it("charges an upload authenticated before a finished guest claim to the current account", async () => {
    const store = artifactStore();
    const { ownerAuth, roomId } = await sharedRoom(store);
    const { token } = await store.createRoomInvite({ roomId: roomId as `rom_${string}`, principalId: ownerAuth.principalId });
    const guest = await store.joinRoomWithInvite(token, roomId as `rom_${string}`, { name: "late upload", runtime: { kind: "curl" } });
    const staleAuth = (await store.authenticateInstance(guest.member_token))!;
    const login = await store.startCliLogin({ label: "late upload", seats: [guest.member_token] });
    await store.approveCliLogin({ code: login.user_code, principalId: ownerAuth.principalId });
    const uploaded = await store.uploadArtifact(staleAuth, { filename: "late.txt", room_id: null, content_type: "text/plain", bytes: new TextEncoder().encode("late") });
    expect(uploaded.artifact.principal_id).toBe(ownerAuth.principalId);
    expect(await store.artifactUsage(ownerAuth)).toMatchObject({ bytes: 4, count: 1 });
    expect((await store.readArtifact(ownerAuth, uploaded.artifact.id)).artifact.id).toBe(uploaded.artifact.id);
  });

});

describe("runtime_metadata belongs to the Principal whose Instance it describes", () => {
  // The CLI reports where a seat runs so its own account can tell its sessions apart. Every door
  // that shows a Room used to hand that to every reader: a guest admitted by a forwarded invite,
  // or anyone holding a share link, read the owner's hostname and workspace folder.
  const PRIVATE = { hostname: "Alices-MacBook-Pro.local", workspace: "acme-secret-client", os: "darwin" };
  const DRIVER = { runtime_source: "detected", driver_version: "2.1.0", entrypoint: "cli" };

  async function roomWithGuest() {
    const store = makeStore();
    const owner = await startInstance(store, { runtime_metadata: { ...PRIVATE, ...DRIVER } });
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Shared with a stranger" }),
    });
    expect(created.status).toBe(201);
    const roomId = (await json(created)).room.id as string;
    const { token: invite } = await store.createRoomInvite({ roomId: roomId as never, principalId: owner.instance.principal_id });
    const joined = await request(store, `/api/v1/rooms/${roomId}/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${invite}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "stranger" }),
    });
    expect(joined.status).toBe(200);
    const guest = await json(joined);
    return { store, roomId, owner, guestToken: guest.member_token as string, guestPrincipalId: guest.membership.principal_id };
  }

  it("shows another Principal's seat only its driver fields, never its hostname or workspace", async () => {
    const { store, roomId, owner, guestToken } = await roomWithGuest();

    const response = await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(guestToken) });
    expect(response.status).toBe(200);
    const body = await json(response);
    const ownerSeat = body.memberships.find((member: { member_id: string }) => member.member_id === owner.instance.id);

    expect(ownerSeat.runtime_metadata).toEqual(DRIVER);
    expect(JSON.stringify(body)).not.toContain(PRIVATE.hostname);
    expect(JSON.stringify(body)).not.toContain(PRIVATE.workspace);
  });

  it("shows the owning Principal every field it reported", async () => {
    const { store, roomId, owner } = await roomWithGuest();

    const body = await json(await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(owner.token) }));
    const ownSeat = body.memberships.find((member: { member_id: string }) => member.member_id === owner.instance.id);

    expect(ownSeat.runtime_metadata).toEqual({ ...PRIVATE, ...DRIVER });
  });

  it("applies the same rule on the Dashboard's Room page and on a public share link", async () => {
    const { store, roomId, owner, guestPrincipalId } = await roomWithGuest();

    const asGuestAccount = await store.getRoomForPrincipal(guestPrincipalId, roomId as never);
    const { share_token } = await store.shareRoom(owner.instance.principal_id, roomId as never);
    const asAnyone = await store.getSharedRoom(share_token);

    for (const view of [asGuestAccount, asAnyone]) {
      const ownerSeat = view.memberships.find((member) => member.member_id === owner.instance.id);
      expect(ownerSeat?.runtime_metadata).toEqual(DRIVER);
      expect(JSON.stringify(view)).not.toContain(PRIVATE.hostname);
      expect(JSON.stringify(view)).not.toContain(PRIVATE.workspace);
    }
  });
});

describe("goal Rooms over the API (decision 2026-10-05)", () => {
  const OWNER = `snk_${"g".repeat(43)}`;
  const OTHER = `snk_${"h".repeat(43)}`;

  /** Two accounts and a key with no account behind it; the clock moves when a test says so. */
  function goalStore() {
    const clock = { now: new Date("2026-10-05T12:00:00.000Z") };
    const store = new MemorySharedNetRepository({
      now: () => clock.now,
      devApiKey: DEV_KEY,
      accounts: [
        { authUserId: "ada", apiKey: OWNER, displayName: "Ada Lovelace" },
        { authUserId: "bob", apiKey: OTHER },
      ],
    });
    return { clock, store };
  }

  function post(store: MemorySharedNetRepository, path: string, token: string, body?: unknown) {
    return request(store, path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** The owner's Agent opens a Room, as `sharednet room create` does; another account's Agent joins it. */
  async function room(store: MemorySharedNetRepository) {
    const owner = await startWithKey(store, OWNER);
    const opened = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Parser rewrite" }),
    });
    expect(opened.status).toBe(201);
    const { room: created } = await json(opened);
    const guest = await startWithKey(store, OTHER, { runtime_kind: "claude-code" });
    const joined = await request(store, `/api/v1/rooms/${created.id}/join`, {
      method: "POST",
      headers: instanceHeaders(guest.token, { "idempotency-key": crypto.randomUUID() }),
    });
    expect(joined.status).toBe(200);
    return { roomId: created.id as string, ownerToken: owner.token as string, guestToken: guest.token as string };
  }

  const read = async (store: MemorySharedNetRepository, roomId: string, token: string) =>
    json(await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(token) }));

  it("starts a goal as the owner's own first line, records its end, and refuses a second", async () => {
    const { store } = goalStore();
    const { roomId, guestToken } = await room(store);
    const started = await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, {
      content: "Make tests/hidden pass.",
      until: ["check: pytest -q tests/hidden", "after: 2h", "budget $20"],
    });
    expect(started.status).toBe(201);
    const body = await json(started);
    expect(body.room.goal).toEqual({
      message_id: body.message.id,
      sequence: body.message.sequence,
      until: ["check pytest -q tests/hidden", "after 2h", "budget $20"],
      started_at: body.message.created_at,
      ended_by: null,
    });
    // Said through the person's seat, under the person's name, which every member reads.
    const seen = await read(store, roomId, guestToken);
    const speaker = seen.memberships.find((member: any) => member.member_id === body.message.sender_instance_id);
    expect(speaker).toMatchObject({ runtime_kind: "human", name: "Ada Lovelace", principal_id: body.room.principal_id });
    expect(seen.room.goal.until).toHaveLength(3);

    const again = await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "Another goal.", until: ["after 1h"] });
    expect(again.status).toBe(409);
    expect((await json(again)).error.code).toBe("goal_already_set");
  });

  it("takes the next goal in the same Room once the last one has ended: its owner reopens it by key, and nobody else can", async () => {
    const { store } = goalStore();
    const { roomId, guestToken } = await room(store);
    const first = await json(await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "First goal.", until: ["after 1h"] }));
    // Closed with the trigger that ended it, as goal run closes it.
    expect((await post(store, `/api/v1/rooms/${roomId}/close`, OWNER, { trigger: "said DONE", detail: null })).status).toBe(200);
    // Closed, it takes nothing; only its owner may open it again.
    expect((await json(await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "Too soon.", until: ["after 1h"] }))).error.code).toBe("room_closed");
    expect((await post(store, `/api/v1/rooms/${roomId}/reopen`, OTHER)).status).toBe(404);
    const reopened = await post(store, `/api/v1/rooms/${roomId}/reopen`, OWNER);
    expect(reopened.status).toBe(200);
    expect((await json(reopened)).room).toMatchObject({ id: roomId, state: "open" });
    const next = await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "Second goal.", until: ["after 30m"] });
    expect(next.status).toBe(201);
    const body = await json(next);
    expect(body.message.sequence).toBeGreaterThan(first.message.sequence);
    expect(body.room.goal).toEqual({ message_id: body.message.id, sequence: body.message.sequence, until: ["after 30m"], started_at: body.message.created_at, ended_by: null });
    // The earlier goal's lines are still the Room's, before the new one.
    const seen = await read(store, roomId, guestToken);
    expect(seen.room.goal.message_id).toBe(body.message.id);
    // While that goal runs there is still only one.
    expect((await json(await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "A third.", until: ["after 1h"] }))).error.code).toBe("goal_already_set");
    // Reopening an open Room changes nothing.
    expect((await json(await post(store, `/api/v1/rooms/${roomId}/reopen`, OWNER))).room.goal.message_id).toBe(body.message.id);
  });

  describe("a seat taken up again for the Room's next goal (decision 2026-11-21)", () => {
    /** A goal Room as goal run leaves it: the owner's run invited two agents, which joined with the invite alone and spoke. */
    async function swarmRoom(store: MemorySharedNetRepository) {
      const { roomId, ownerToken, guestToken } = await room(store);
      const goal = await json(await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "First goal.", until: ["after 1h"] }));
      const invite = await json(await request(store, `/api/v1/rooms/${roomId}/invites`, { method: "POST", headers: instanceHeaders(ownerToken) }));
      const seat = async (name: string) => {
        const joined = await post(store, `/api/v1/rooms/${roomId}/join`, invite.token, { name });
        expect(joined.status).toBe(200);
        const body = await json(joined);
        return { memberId: body.membership.member_id as string, token: body.member_token as string };
      };
      const one = await seat("codex-1");
      const two = await seat("codex-2");
      const said = await request(store, `/api/v1/rooms/${roomId}/messages`, {
        method: "POST",
        headers: instanceHeaders(one.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ content: "HASH codex-1 9f86d0" }),
      });
      expect(said.status).toBe(201);
      return { roomId, ownerToken, guestToken, goal, invite: invite.token as string, one, two };
    }
    const takeUp = (store: MemorySharedNetRepository, roomId: string, memberId: string, key = OWNER) => post(store, `/api/v1/rooms/${roomId}/members/${memberId}/token`, key);

    it("gives the owner a new token for the same member, under its name and with its lines, and the old token stops working", async () => {
      const { store } = goalStore();
      const { roomId, guestToken, one, two } = await swarmRoom(store);
      // The goal ends and the Room closes; its owner opens it again and says the next goal.
      expect((await post(store, `/api/v1/rooms/${roomId}/close`, OWNER, { trigger: "said DONE", detail: null })).status).toBe(200);
      expect((await json(await takeUp(store, roomId, one.memberId))).error.code).toBe("room_closed");
      expect((await post(store, `/api/v1/rooms/${roomId}/reopen`, OWNER)).status).toBe(200);
      expect((await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "Second goal.", until: ["after 30m"] })).status).toBe(201);

      const taken = await takeUp(store, roomId, one.memberId);
      expect(taken.status).toBe(200);
      expect(taken.headers.get("cache-control")).toContain("no-store");
      const body = await json(taken);
      expect(body.membership).toMatchObject({ member_id: one.memberId, name: "codex-1", kind: "guest", state: "active" });
      expect(body.member_token).toMatch(/^sni_/);
      expect(body.member_token).not.toBe(one.token);
      // The old token is no credential any more; the new one is the same member, and says its next line from it.
      expect((await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(one.token) })).status).toBe(401);
      const again = await request(store, `/api/v1/rooms/${roomId}/messages`, {
        method: "POST",
        headers: instanceHeaders(body.member_token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ content: "WORD codex-1 thistledown" }),
      });
      expect(again.status).toBe(201);
      const seen = await read(store, roomId, guestToken);
      const log = await json(await request(store, `/api/v1/rooms/${roomId}/messages?after=0&limit=100`, { headers: instanceHeaders(guestToken) }));
      const fromOne = log.items.filter((message: any) => message.sender_instance_id === one.memberId).map((message: any) => message.content);
      expect(fromOne).toEqual(["HASH codex-1 9f86d0", "WORD codex-1 thistledown"]);
      // One member per agent: nothing was added.
      expect(seen.memberships.filter((member: any) => member.name === "codex-1")).toHaveLength(1);
      // Taking it up again mints another token and retires the one before it.
      const twice = await json(await takeUp(store, roomId, one.memberId));
      expect((await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(body.member_token) })).status).toBe(401);
      expect((await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(twice.member_token) })).status).toBe(200);
      // The other seat is untouched.
      expect((await request(store, `/api/v1/rooms/${roomId}`, { headers: instanceHeaders(two.token) })).status).toBe(200);
    });

    it("is the owner's alone, by key, and only for a seat the owner's own invite made in this goal Room", async () => {
      const { store } = goalStore();
      const { roomId, ownerToken, guestToken, goal, invite, one, two } = await swarmRoom(store);
      // Not the owner, no key, a member token, a malformed id, a member of no such seat.
      expect((await takeUp(store, roomId, one.memberId, OTHER)).status).toBe(404);
      expect((await request(store, `/api/v1/rooms/${roomId}/members/${one.memberId}/token`, { method: "POST" })).status).toBe(401);
      expect((await takeUp(store, roomId, one.memberId, two.token)).status).toBe(401);
      expect((await json(await takeUp(store, roomId, "mem_x"))).error.code).toBe("invalid_id");
      expect((await json(await takeUp(store, roomId, "i_NoSuchSeat"))).error.code).toBe("instance_not_found");
      expect((await request(store, `/api/v1/rooms/${roomId}/members/${one.memberId}/token`, { headers: { authorization: `Bearer ${OWNER}` } })).status).toBe(405);
      // Another account's Agent, the owner's own seats, and the person's: none of them is a seat the invite made.
      const view = await read(store, roomId, guestToken);
      const other = view.memberships.find((member: any) => member.runtime_kind === "claude-code" && member.kind === "instance");
      const person = view.memberships.find((member: any) => member.member_id === goal.message.sender_instance_id);
      const creator = view.memberships.find((member: any) => member.member_id !== person.member_id && member.kind === "instance" && member.runtime_kind === "codex");
      for (const member of [other, person, creator]) expect((await json(await takeUp(store, roomId, member.member_id))).error.code).toBe("member_not_reissuable");
      // A seat that also sits in another Room: a token for it would reach that Room too.
      const elsewhere = await room(store);
      const otherInvite = await json(await request(store, `/api/v1/rooms/${elsewhere.roomId}/invites`, { method: "POST", headers: instanceHeaders(elsewhere.ownerToken) }));
      const entered = await request(store, `/api/v1/rooms/${elsewhere.roomId}/join`, {
        method: "POST",
        headers: instanceHeaders(two.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ invite: otherInvite.token }),
      });
      expect(entered.status).toBe(200);
      expect((await json(await takeUp(store, roomId, two.memberId))).error.code).toBe("member_not_reissuable");
      // A seat somebody has bound to an account is theirs.
      const login = await store.startCliLogin({ label: null, seats: [one.token] });
      const bob = await store.authenticateApiKey(OTHER);
      await store.approveCliLogin({ code: login.user_code, principalId: bob!.principalId });
      expect((await json(await takeUp(store, roomId, one.memberId))).error.code).toBe("member_not_reissuable");
      // A Room with no goal is not a goal run's.
      const plain = await room(store);
      const plainInvite = await json(await request(store, `/api/v1/rooms/${plain.roomId}/invites`, { method: "POST", headers: instanceHeaders(plain.ownerToken) }));
      const guest = await json(await post(store, `/api/v1/rooms/${plain.roomId}/join`, plainInvite.token, { name: "codex-1" }));
      expect((await json(await takeUp(store, plain.roomId, guest.membership.member_id))).error.code).toBe("member_not_reissuable");
      // A refusal mints nothing: each seat's own token still works.
      expect((await request(store, `/api/v1/rooms/${plain.roomId}`, { headers: instanceHeaders(guest.member_token) })).status).toBe(200);
      expect(invite).toMatch(/^rit_/);
    });

    it("takes down a doorbell the seat's earlier holder set, so nothing the Room says rings there again", async () => {
      const { store } = goalStore();
      const { roomId, one, two } = await swarmRoom(store);
      for (const seat of [one, two]) {
        const auth = await store.authenticateInstance(seat.token);
        await store.setPush(auth!, roomId as any, `https://hooks.example.com/${seat.memberId}`);
      }
      // A line neither of the two has handled yet, so each bell is due (said in the store, so nothing rings it here).
      const owner = await store.authenticateApiKey(OWNER);
      await store.speakAsOwner(owner!.principalId, roomId as any, { content: "Carry on.", as: "owner" });
      const ringing = async () => (await store.pushTargets(roomId as any, null, new Date("2026-10-05T12:00:00.000Z"))).map((target) => target.instance_id);
      expect(await ringing()).toEqual(expect.arrayContaining([one.memberId, two.memberId]));
      expect((await takeUp(store, roomId, one.memberId)).status).toBe(200);
      const after = await ringing();
      expect(after).not.toContain(one.memberId);
      expect(after).toContain(two.memberId);
    });
  });

  it("refuses a goal with no bound, from anyone but the owner, and from a key with no account, minting nothing", async () => {
    const { store } = goalStore();
    const { roomId, guestToken } = await room(store);
    const unbounded = await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, { content: "Go.", until: ["check: make test", "idle 10m"] });
    expect(unbounded.status).toBe(422);
    expect((await json(unbounded)).error.code).toBe("goal_unbounded");
    const stranger = await post(store, `/api/v1/rooms/${roomId}/goal`, OTHER, { content: "Mine now.", until: ["after 1h"] });
    expect(stranger.status).toBe(404);
    const seats = (await read(store, roomId, guestToken)).memberships.map((member: any) => member.runtime_kind);
    expect(seats).not.toContain("human");
    expect(seats).not.toContain("runner");
    // A key with no account behind it can own a Room, but has no person to speak as.
    const devSeat = await startWithKey(store, DEV_KEY);
    const devRoom = await json(
      await request(store, "/api/v1/rooms", {
        method: "POST",
        headers: instanceHeaders(devSeat.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ name: "No account" }),
      }),
    );
    const noAccount = await post(store, `/api/v1/rooms/${devRoom.room.id}/owner-messages`, DEV_KEY, { content: "hi" });
    expect(noAccount.status).toBe(403);
    expect((await json(noAccount)).error.code).toBe("owner_account_required");
    const noAccountGoal = await post(store, `/api/v1/rooms/${devRoom.room.id}/goal`, DEV_KEY, { content: "Go.", until: ["after 1h"] });
    expect((await json(noAccountGoal)).error.code).toBe("owner_account_required");
    for (const body of [{ content: "x", until: [] }, { content: "x", until: ["closed"] }, { content: "x", until: ["at 17:30"] }, { content: "x", until: ["every 10m"] }, { content: "", until: ["after 1h"] }]) {
      expect((await post(store, `/api/v1/rooms/${roomId}/goal`, OWNER, body)).status).toBe(422);
    }
  });

  it("speaks as the owner or as the runner, two seats every member can tell apart", async () => {
    const { store } = goalStore();
    const { roomId, guestToken } = await room(store);
    const asOwner = await json(await post(store, `/api/v1/rooms/${roomId}/owner-messages`, OWNER, { content: "Hold the tests." }));
    const asRunner = await json(await post(store, `/api/v1/rooms/${roomId}/owner-messages`, OWNER, { content: "check failed: 3 of 27", as: "runner" }));
    const members = (await read(store, roomId, guestToken)).memberships;
    const kindOf = (id: string) => members.find((member: any) => member.member_id === id);
    expect(kindOf(asOwner.message.sender_instance_id)).toMatchObject({ runtime_kind: "human", name: "Ada Lovelace" });
    expect(kindOf(asRunner.message.sender_instance_id)).toMatchObject({ runtime_kind: "runner", name: "runner" });
    expect(asRunner.message.sender_principal_id).toBe(asOwner.message.sender_principal_id);
    // No Agent can register as either.
    for (const runtime_kind of ["human", "runner"]) {
      const refused = await request(store, "/api/v1/instances", {
        method: "POST",
        headers: apiHeaders({ "content-type": "application/json" }, OTHER),
        body: JSON.stringify({ runtime_kind, cli_version: "0.2.0" }),
      });
      expect(refused.status).toBe(422);
    }
  });

  it("closes with the trigger that fired, or as the owner's own close, and closing again changes nothing", async () => {
    const { store } = goalStore();
    const goal = await room(store);
    await post(store, `/api/v1/rooms/${goal.roomId}/goal`, OWNER, { content: "Go.", until: ["check: make test", "after 2h"] });
    const closed = await post(store, `/api/v1/rooms/${goal.roomId}/close`, OWNER, { trigger: "check: make test", detail: "27 passed" });
    expect(closed.status).toBe(200);
    expect((await json(closed)).room).toMatchObject({
      state: "closed",
      goal: { ended_by: { trigger: "check make test", at: "2026-10-05T12:00:00.000Z", detail: "27 passed" } },
    });
    const again = await json(await post(store, `/api/v1/rooms/${goal.roomId}/close`, OWNER));
    expect(again.room.goal.ended_by.detail).toBe("27 passed");

    const plain = await room(store);
    await post(store, `/api/v1/rooms/${plain.roomId}/goal`, OWNER, { content: "Go.", until: ["after 2h"] });
    expect((await json(await post(store, `/api/v1/rooms/${plain.roomId}/close`, OWNER))).room.goal.ended_by).toMatchObject({ trigger: "owner", detail: null });
    // Somebody else's key closes nothing.
    expect((await post(store, `/api/v1/rooms/${plain.roomId}/close`, OTHER)).status).toBe(404);
  });

  it("ends a goal Room itself on count and on time, so it ends even when no runner is left", async () => {
    const { clock, store } = goalStore();
    const counted = await room(store);
    await post(store, `/api/v1/rooms/${counted.roomId}/goal`, OWNER, { content: "Two lines and stop.", until: ["count 2"] });
    const say = (token: string, content: string) =>
      request(store, `/api/v1/rooms/${counted.roomId}/messages`, {
        method: "POST",
        headers: instanceHeaders(token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ content }),
      });
    expect((await say(counted.guestToken, "one")).status).toBe(201);
    // The line that reaches the count is taken, and the Room ends with it.
    expect((await say(counted.ownerToken, "two")).status).toBe(201);
    const third = await say(counted.guestToken, "three");
    expect(third.status).toBe(409);
    expect((await json(third)).error.code).toBe("room_closed");
    expect((await read(store, counted.roomId, counted.guestToken)).room.goal.ended_by).toMatchObject({ trigger: "count 2" });

    const timed = await room(store);
    await post(store, `/api/v1/rooms/${timed.roomId}/goal`, OWNER, { content: "An hour, no more.", until: ["after 1h", "check: make test"] });
    clock.now = new Date("2026-10-05T12:59:59.000Z");
    expect((await read(store, timed.roomId, timed.guestToken)).room.state).toBe("open");
    clock.now = new Date("2026-10-05T13:00:00.000Z");
    // Nobody had to be watching: the next request of any kind finds it ended.
    const ended = (await read(store, timed.roomId, timed.guestToken)).room;
    expect(ended).toMatchObject({ state: "closed", goal: { ended_by: { trigger: "after 1h", at: "2026-10-05T13:00:00.000Z" } } });
  });
});

describe("Room hooks: events from outside the Room (wait PR 6)", () => {
  const OWNER = `snk_${"q".repeat(43)}`;
  const OTHER = `snk_${"r".repeat(43)}`;

  function hookStore() {
    return new MemorySharedNetRepository({
      devApiKey: DEV_KEY,
      accounts: [
        { authUserId: "ada", apiKey: OWNER, displayName: "Ada Lovelace" },
        { authUserId: "bob", apiKey: OTHER },
      ],
    });
  }

  function post(store: MemorySharedNetRepository, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
    return request(store, path, {
      method: "POST",
      headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** The owner's Agent opens a Room; another account's Agent sits in it and waits. */
  async function room(store: MemorySharedNetRepository, name = "Release") {
    const owner = await startWithKey(store, OWNER);
    const opened = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name }),
    });
    const { room: created } = await json(opened);
    const guest = await startWithKey(store, OTHER, { runtime_kind: "claude-code" });
    await request(store, `/api/v1/rooms/${created.id}/join`, { method: "POST", headers: instanceHeaders(guest.token, { "idempotency-key": crypto.randomUUID() }) });
    return { roomId: created.id as string, guestToken: guest.token as string };
  }

  it("says an event through the hook's own seat, and a wait narrowed to that seat wakes on it", async () => {
    const store = hookStore();
    const { roomId, guestToken } = await room(store);
    const minted = await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "ci" });
    expect(minted.status).toBe(201);
    const { hook, token } = await json(minted);
    expect(hook).toMatchObject({ room_id: roomId, name: "ci" });
    expect(hook.id).toMatch(/^hk_[0-9A-Za-z]{10}$/);
    expect(hook.member_id).toMatch(/^i_[0-9A-Za-z]{10}$/);
    expect(token).toMatch(/^seh_[A-Za-z0-9_-]{43}$/);

    const said = await post(store, `/api/v1/rooms/${roomId}/events`, token, { name: "ci.passed", text: "27/27 on main" });
    expect(said.status).toBe(201);
    const { message } = await json(said);
    expect(message.content).toBe("ci.passed: 27/27 on main");
    expect(message.sender).toMatchObject({ member_id: hook.member_id, name: "ci" });

    // Only the hook wakes a wait narrowed to it, and it carries the event like any line.
    const woken = await json(await request(store, `/api/v1/rooms/${roomId}/wait?after=0&timeout=0&sender_instance_id=${hook.member_id}`, { headers: instanceHeaders(guestToken) }));
    expect(woken.items.map((item: { content: string }) => item.content)).toEqual(["ci.passed: 27/27 on main"]);
  });

  it("is heard long after it was minted: each event renews the hook's presence", async () => {
    // Found on 2026-10-05 against the local service: the hook's seat had a lease from minting and
    // nothing renewed it, so an event that came later than that was refused as instance_offline.
    let now = new Date("2026-10-05T10:00:00.000Z");
    const store = new MemorySharedNetRepository({
      devApiKey: DEV_KEY,
      now: () => now,
      accounts: [
        { authUserId: "ada", apiKey: OWNER, displayName: "Ada Lovelace" },
        { authUserId: "bob", apiKey: OTHER },
      ],
    });
    const { roomId } = await room(store);
    const { token } = await json(await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "ci" }));
    for (const later of [10, 60 * 24]) {
      now = new Date(now.getTime() + later * 60_000);
      const said = await post(store, `/api/v1/rooms/${roomId}/events`, token, { name: "ci.failed", text: "@claude-code test_login timed out" });
      expect(said.status).toBe(201);
    }
  });

  it("refuses an event without the hook's token, with any other credential, or for another Room", async () => {
    const store = hookStore();
    const { roomId, guestToken } = await room(store);
    const { roomId: elsewhere } = await room(store, "Elsewhere");
    const { token } = await json(await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "ci" }));
    const event = { name: "ci.passed" };

    expect((await json(await post(store, `/api/v1/rooms/${roomId}/events`, null, event))).error.code).toBe("authentication_required");
    for (const credential of [guestToken, OWNER, `seh_${"x".repeat(43)}`, "seh_short"]) {
      const refused = await post(store, `/api/v1/rooms/${roomId}/events`, credential, event);
      expect(refused.status, credential.slice(0, 4)).toBe(401);
    }
    expect((await post(store, `/api/v1/rooms/${elsewhere}/events`, token, event)).status).toBe(401);
    // The token says events and nothing else: it cannot read the Room it opens.
    expect((await request(store, `/api/v1/rooms/${roomId}/messages`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it("lets only the owner mint a hook, and minting the name again replaces the token", async () => {
    const store = hookStore();
    const { roomId } = await room(store);
    expect((await post(store, `/api/v1/rooms/${roomId}/hooks`, OTHER, { name: "ci" })).status).toBe(404);

    const first = await json(await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "ci" }));
    const second = await json(await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "ci" }));
    expect(second.hook).toEqual(first.hook);
    expect(second.token).not.toBe(first.token);
    expect((await post(store, `/api/v1/rooms/${roomId}/events`, first.token, { name: "ci.started" })).status).toBe(401);
    expect((await post(store, `/api/v1/rooms/${roomId}/events`, second.token, { name: "ci.started" })).status).toBe(201);

    for (const body of [{}, { name: "CI" }, { name: "a b" }, { name: "ci", extra: 1 }]) {
      const refused = await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, body);
      expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(refused.status, JSON.stringify(body)).toBeLessThan(500);
    }
  });

  it("says a retried delivery once, refuses a malformed event, and nothing in a closed Room", async () => {
    const store = hookStore();
    const { roomId } = await room(store);
    const { token } = await json(await post(store, `/api/v1/rooms/${roomId}/hooks`, OWNER, { name: "grader" }));
    const key = crypto.randomUUID();
    const once = await json(await post(store, `/api/v1/rooms/${roomId}/events`, token, { name: "grader.done", text: "27/27" }, { "idempotency-key": key }));
    const again = await json(await post(store, `/api/v1/rooms/${roomId}/events`, token, { name: "grader.done", text: "27/27" }, { "idempotency-key": key }));
    expect(again.message.id).toBe(once.message.id);

    for (const body of [{}, { name: "" }, { name: "has space" }, { name: "ok", text: 1 }, { name: "ok", extra: true }]) {
      const refused = await post(store, `/api/v1/rooms/${roomId}/events`, token, body);
      expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(refused.status, JSON.stringify(body)).toBeLessThan(500);
    }

    expect((await post(store, `/api/v1/rooms/${roomId}/close`, OWNER, {})).status).toBe(200);
    expect((await json(await post(store, `/api/v1/rooms/${roomId}/events`, token, { name: "grader.done" }))).error.code).toBe("room_closed");
  });
});

describe("Room timers: the clock speaks when nobody is running (wait PR 6)", () => {
  const OWNER = `snk_${"t".repeat(43)}`;
  const OTHER = `snk_${"u".repeat(43)}`;

  function timerStore() {
    const clock = { now: new Date("2026-10-05T12:00:00.000Z") };
    const store = new MemorySharedNetRepository({
      now: () => clock.now,
      devApiKey: DEV_KEY,
      accounts: [
        { authUserId: "ada", apiKey: OWNER, displayName: "Ada Lovelace" },
        { authUserId: "bob", apiKey: OTHER },
      ],
    });
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    return { clock, store, later };
  }

  async function room(store: MemorySharedNetRepository, ownerKey = OWNER) {
    const owner = await startWithKey(store, ownerKey);
    const opened = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(owner.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Stand-up" }),
    });
    const { room: created } = await json(opened);
    const guest = await startWithKey(store, OTHER, { runtime_kind: "claude-code" });
    await request(store, `/api/v1/rooms/${created.id}/join`, { method: "POST", headers: instanceHeaders(guest.token, { "idempotency-key": crypto.randomUUID() }) });
    return { roomId: created.id as string, ownerToken: owner.token as string, guestToken: guest.token as string, guestId: guest.instance.id as string };
  }

  const setTimer = (store: MemorySharedNetRepository, roomId: string, token: string, body: unknown) =>
    request(store, `/api/v1/rooms/${roomId}/timers`, {
      method: "POST",
      headers: instanceHeaders(token, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
  const log = async (store: MemorySharedNetRepository, roomId: string, token: string) =>
    (await json(await request(store, `/api/v1/rooms/${roomId}/messages?after=0&limit=100`, { headers: instanceHeaders(token) }))).items as Array<{ content: string; sender: { member_id: string; name: string | null } }>;

  it("says the line once it comes due, through the clock's own seat, and only once", async () => {
    const { store, later } = timerStore();
    const { roomId, guestToken, guestId } = await room(store);
    const set = await setTimer(store, roomId, guestToken, { when: "every: 20m", say: "@guest stand-up" });
    expect(set.status).toBe(201);
    const { timer } = await json(set);
    expect(timer).toMatchObject({ when: "every 20m", say: "@guest stand-up", next_at: "2026-10-05T12:20:00.000Z", created_by: guestId });
    expect(timer.id).toMatch(/^tm_[0-9A-Za-z]{10}$/);

    expect(await log(store, roomId, guestToken)).toEqual([]);
    later(20 * 60_000);
    // Nobody was running: the next wait says what came due, through the clock, and wakes on it.
    const woken = await json(await request(store, `/api/v1/rooms/${roomId}/wait?after=0&timeout=0&sender_instance_id=${timer.member_id}`, { headers: instanceHeaders(guestToken) }));
    expect(woken.items.map((item: { content: string }) => item.content)).toEqual(["@guest stand-up"]);
    expect(woken.items[0].sender).toMatchObject({ member_id: timer.member_id, name: "clock" });
    // Asked again at the same moment, it is not said twice.
    expect((await log(store, roomId, guestToken)).map((item) => item.content)).toEqual(["@guest stand-up"]);
    const listed = await json(await request(store, `/api/v1/rooms/${roomId}/timers`, { headers: instanceHeaders(guestToken) }));
    expect(listed.items.map((item: { next_at: string }) => item.next_at)).toEqual(["2026-10-05T12:40:00.000Z"]);
  });

  it("says a missed line once, not once per miss, and spends a one-shot", async () => {
    const { store, later } = timerStore();
    const { roomId, guestToken } = await room(store);
    await setTimer(store, roomId, guestToken, { when: "every 20m", say: "tick" });
    await setTimer(store, roomId, guestToken, { when: "after 1h", say: "an hour in" });
    await setTimer(store, roomId, guestToken, { when: "at 2026-10-05T13:30:00Z", say: "half past one" });
    later(2 * 3_600_000);

    expect((await log(store, roomId, guestToken)).map((item) => item.content).sort()).toEqual(["an hour in", "half past one", "tick"]);
    const listed = await json(await request(store, `/api/v1/rooms/${roomId}/timers`, { headers: instanceHeaders(guestToken) }));
    expect(listed.items.map((item: { when: string; next_at: string }) => [item.when, item.next_at])).toEqual([["every 20m", "2026-10-05T14:20:00.000Z"]]);
  });

  it("refuses what cannot be a schedule", async () => {
    const { store } = timerStore();
    const { roomId, guestToken } = await room(store);
    for (const body of [
      { when: "every 30s", say: "too often" },
      { when: "every soon", say: "x" },
      { when: "cron 0 9 * *", say: "four fields" },
      { when: "cron 0 0 30 2 *", say: "never comes round" },
      { when: "at 2026-10-05T11:00:00Z", say: "in the past" },
      { when: "at 2028-10-05T11:00:00Z", say: "too far ahead" },
      { when: "after 0m", say: "now" },
      { when: "every 20m", say: "  " },
      { when: "every 20m", say: "x", extra: true },
      { when: "whenever", say: "x" },
    ]) {
      const refused = await setTimer(store, roomId, guestToken, body);
      expect(refused.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(refused.status, JSON.stringify(body)).toBeLessThan(500);
    }
    const cron = await json(await setTimer(store, roomId, guestToken, { when: 'cron "0 9 * * 1-5"', say: "weekday stand-up" }));
    // 2026-10-05 is a Monday; 09:00 UTC has passed, so Tuesday's.
    expect(cron.timer).toMatchObject({ when: "cron 0 9 * * 1-5", next_at: "2026-10-06T09:00:00.000Z" });
  });

  it("lets its setter or the owner cancel it, and tells anyone else there is no such timer", async () => {
    const { store } = timerStore();
    const { roomId, ownerToken, guestToken } = await room(store);
    const third = await startWithKey(store, OTHER, { runtime_kind: "codex" });
    await request(store, `/api/v1/rooms/${roomId}/join`, { method: "POST", headers: instanceHeaders(third.token, { "idempotency-key": crypto.randomUUID() }) });
    const { timer } = await json(await setTimer(store, roomId, guestToken, { when: "every 1h", say: "hourly" }));
    const cancel = (token: string) => request(store, `/api/v1/rooms/${roomId}/timers/${timer.id}/cancel`, { method: "POST", headers: instanceHeaders(token) });

    expect((await json(await cancel(third.token))).error.code).toBe("timer_not_found");
    expect((await cancel(ownerToken)).status).toBe(200);
    expect((await cancel(guestToken)).status).toBe(404);
  });

  it("keeps at most twenty, says nothing in a closed Room, and needs an owner with an account", async () => {
    const { store, later } = timerStore();
    const { roomId, guestToken } = await room(store);
    for (let index = 0; index < 20; index += 1) {
      expect((await setTimer(store, roomId, guestToken, { when: "every 1h", say: `timer ${index}` })).status).toBe(201);
    }
    expect((await json(await setTimer(store, roomId, guestToken, { when: "every 1h", say: "one too many" }))).error.code).toBe("too_many_timers");

    const closed = await request(store, `/api/v1/rooms/${roomId}/close`, { method: "POST", headers: { authorization: `Bearer ${OWNER}` } });
    expect(closed.status).toBe(200);
    later(2 * 3_600_000);
    await store.fireDueTimers(roomId as `rom_${string}`);
    expect(await log(store, roomId, guestToken)).toEqual([]);

    const keyless = await room(store, DEV_KEY);
    expect((await json(await setTimer(store, keyless.roomId, keyless.guestToken, { when: "every 1h", say: "x" }))).error.code).toBe("owner_account_required");
  });
});

describe("addressed wake: one message to one seat wakes one seat (wait PR 8)", () => {
  it("resolves who a line addresses when it is said, and a wait narrowed to its own seat wakes for it alone", async () => {
    const store = makeStore();
    const host = await startInstance(store);
    const created = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Thirty agents" }),
    });
    const { room } = await json(created);
    const seats: Record<string, { id: string; token: string }> = {};
    for (const name of ["alpha", "beta", "gamma"]) {
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId: host.instance.principal_id });
      const joined = await store.joinRoomWithInvite(invite, room.id, { name });
      seats[name] = { id: joined.membership.instance_id, token: joined.member_token };
    }

    // Each seat waits for lines that address it, as `wait --on mention` asks.
    const waiting = Object.entries(seats).map(([name, seat]) =>
      handleRequest(
        new Request(`http://127.0.0.1:3001/api/v1/rooms/${room.id}/wait?after=0&timeout=1&mentions=${seat.id}`, {
          headers: { authorization: `Bearer ${seat.token}` },
        }),
        store,
        { waitPollMs: 5 },
      ).then(async (response) => [name, (await json(response)).items.map((item: { content: string }) => item.content)] as const),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const said = await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: "@Beta please review the migration" }),
    });
    expect((await json(said)).message.mentions).toEqual([seats.beta!.id]);

    // Beta is woken by it; alpha and gamma sleep through to their timeout.
    expect(Object.fromEntries(await Promise.all(waiting))).toEqual({
      alpha: [],
      beta: ["@Beta please review the migration"],
      gamma: [],
    });
    // An account's seat is named by the tag it is grouped under, and @tag addresses it.
    const tag = await createAgent(store, "reviewer");
    const tagged = await startInstance(store, { agent_id: tag.agent.id });
    expect((await request(store, `/api/v1/rooms/${room.id}/join`, { method: "POST", headers: instanceHeaders(tagged.token, { "idempotency-key": crypto.randomUUID() }) })).status).toBe(200);
    const toTag = await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: "@reviewer the migration is ready" }),
    });
    expect((await json(toTag)).message.mentions).toEqual([tagged.instance.id]);

    // Reading narrows the same way, and an id works as well as a name.
    await request(store, `/api/v1/rooms/${room.id}/messages`, {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: `@${seats.gamma!.id} and @alpha, your turn` }),
    });
    const forAlpha = await json(await request(store, `/api/v1/rooms/${room.id}/messages?mentions=${seats.alpha!.id}`, { headers: instanceHeaders(host.token) }));
    expect(forAlpha.items.map((item: { mentions: string[] }) => item.mentions)).toEqual([[seats.alpha!.id, seats.gamma!.id]]);
  });
});

describe("a seat's doorbell: the service rings, the seat looks (wait PR 7)", () => {
  type Ring = { url: string; headers: Record<string, string>; body: string };

  /** A Room with two guests, a clock the test moves, and a doorbell transport the test watches. */
  async function rung() {
    const clock = { now: new Date("2026-10-05T12:00:00.000Z") };
    const store = new MemorySharedNetRepository({ now: () => clock.now, devApiKey: DEV_KEY });
    const rings: Ring[] = [];
    let answer = 204;
    const push = {
      now: () => clock.now,
      resolve: async (host: string) => (host === "inside.example" ? ["10.1.2.3"] : ["93.184.216.34"]),
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        rings.push({ url: String(input), headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response(null, { status: answer });
      }) as typeof globalThis.fetch,
    };
    const call = (path: string, init: RequestInit = {}) => handleRequest(new Request(`http://127.0.0.1:3001${path}`, init), store, { push });
    const host = await startInstance(store);
    const created = await call("/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(host.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Doorbells" }),
    });
    const { room } = await json(created);
    const seats: Record<string, { id: string; token: string }> = {};
    for (const name of ["alpha", "beta"]) {
      const { token: invite } = await store.createRoomInvite({ roomId: room.id, principalId: host.instance.principal_id });
      const joined = await store.joinRoomWithInvite(invite, room.id, { name });
      seats[name] = { id: joined.membership.instance_id, token: joined.member_token };
    }
    const setPush = (token: string, pushUrl: unknown) =>
      call(`/api/v1/rooms/${room.id}/subscription`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ push_url: pushUrl }),
      });
    const say = (token: string, content: string) =>
      call(`/api/v1/rooms/${room.id}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content }),
      });
    const later = (ms: number) => {
      clock.now = new Date(clock.now.getTime() + ms);
    };
    return { store, room, seats, rings, push, setPush, say, later, call, fail: (status: number) => (answer = status) };
  }

  it("rings every other seat's doorbell, signed, with the Room's progress and never its content", async () => {
    const { room, seats, rings, setPush, say } = await rung();
    const registered = await setPush(seats.alpha!.token, "https://alpha.example/sharednet/push");
    expect(registered.status).toBe(200);
    const { push } = await json(registered);
    expect(push.url).toBe("https://alpha.example/sharednet/push");
    expect(push.secret).toMatch(/^shp_[A-Za-z0-9_-]{43}$/);
    await setPush(seats.beta!.token, "https://beta.example/sharednet/push");

    await say(seats.beta!.token, "the secret plan is in the doc");
    // Beta spoke, so only alpha's doorbell rings.
    expect(rings.map((ring) => ring.url)).toEqual(["https://alpha.example/sharednet/push"]);
    const [ring] = rings;
    expect(JSON.parse(ring!.body)).toEqual({ room_id: room.id, member_id: seats.alpha!.id, through: 1, acked_through: 0 });
    expect(ring!.body).not.toContain("secret plan");
    const timestamp = ring!.headers["x-sharednet-timestamp"]!;
    expect(ring!.headers["x-sharednet-signature"]).toBe(`sha256=${pushSignature(push.secret, timestamp, ring!.body)}`);
  });

  it("refuses a doorbell that is not https, or not on the public internet", async () => {
    const { seats, setPush } = await rung();
    for (const pushUrl of [
      "http://alpha.example/push",
      "https://10.0.0.5/push",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/push",
      "https://inside.example/push",
      "https://user:pass@alpha.example/push",
      "not a url",
      42,
    ]) {
      const refused = await setPush(seats.alpha!.token, pushUrl);
      expect(refused.status, String(pushUrl)).toBeGreaterThanOrEqual(400);
      expect(refused.status, String(pushUrl)).toBeLessThan(500);
    }
  });

  it("rings again after a ring that failed, once its backoff is over, and stops once the seat has handled it", async () => {
    const { store, room, seats, rings, push, setPush, say, later, call, fail } = await rung();
    await setPush(seats.alpha!.token, "https://alpha.example/sharednet/push");
    fail(503);
    await say(seats.beta!.token, "first");
    expect(rings).toHaveLength(1);

    // Within the backoff, neither a new line nor the tick rings a bell that just failed.
    await say(seats.beta!.token, "second");
    expect((await tick(store, push)).rung).toBe(0);
    expect(rings).toHaveLength(1);

    fail(204);
    later(61_000);
    expect(await tick(store, push)).toMatchObject({ rooms: 1, rung: 1 });
    expect(JSON.parse(rings.at(-1)!.body)).toMatchObject({ through: 2 });

    // Rung but not handled: rung again ten minutes on. Handled: never again.
    later(10 * 60_000 + 1);
    expect((await tick(store, push)).rung).toBe(1);
    await call(`/api/v1/rooms/${room.id}/ack`, {
      method: "POST",
      headers: { authorization: `Bearer ${seats.alpha!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ through: 2 }),
    });
    later(60 * 60_000);
    expect(await tick(store, push)).toMatchObject({ rooms: 0, rung: 0 });
  });

  it("stops ringing a seat that takes its doorbell away", async () => {
    const { seats, rings, setPush, say } = await rung();
    await setPush(seats.alpha!.token, "https://alpha.example/sharednet/push");
    const removed = await json(await setPush(seats.alpha!.token, null));
    expect(removed.push).toBeNull();
    await say(seats.beta!.token, "anyone?");
    expect(rings).toEqual([]);
  });
});

describe("inviting people into a Room (decision 2026-10-25)", () => {
  const ADA = `snk_${"p".repeat(43)}`;
  const BOB = `snk_${"q".repeat(43)}`;
  const CY = `snk_${"r".repeat(43)}`;
  const DAN = `snk_${"s".repeat(43)}`;
  const strangerKey = (n: number) => `snk_${"t".repeat(41)}${String(n).padStart(2, "0")}`;

  /** Ada owns a Room Bob's Agent sits in; Cy and Dan have never shared a Room with either, and eleven more strangers wait. */
  async function people() {
    const store = new MemorySharedNetRepository({
      now: () => new Date("2026-10-25T12:00:00.000Z"),
      devApiKey: DEV_KEY,
      accounts: [
        { authUserId: "ada", apiKey: ADA, displayName: "Ada Lovelace" },
        { authUserId: "bob", apiKey: BOB, displayName: "Bob Kahn" },
        { authUserId: "cy", apiKey: CY, displayName: "Cy Young" },
        { authUserId: "dan", apiKey: DAN, displayName: "Dan Bricklin" },
        ...Array.from({ length: 11 }, (_, n) => ({ authUserId: `stranger-${n}`, apiKey: strangerKey(n), displayName: `Stranger ${n}` })),
      ],
    });
    const ada = await startWithKey(store, ADA);
    const opened = await request(store, "/api/v1/rooms", {
      method: "POST",
      headers: instanceHeaders(ada.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ name: "Parser rewrite" }),
    });
    const roomId = (await json(opened)).room.id as string;
    const bob = await startWithKey(store, BOB);
    await request(store, `/api/v1/rooms/${roomId}/join`, { method: "POST", headers: instanceHeaders(bob.token, { "idempotency-key": crypto.randomUUID() }) });
    const cy = await startWithKey(store, CY, { runtime_kind: "claude-code" });
    return { store, roomId, ada, bob, cy, principal: (seat: any) => seat.instance.principal_id as PrincipalId };
  }

  const invite = (store: MemorySharedNetRepository, roomId: string, key: string, body: unknown) =>
    request(store, `/api/v1/rooms/${roomId}/people`, { method: "POST", headers: apiHeaders({ "content-type": "application/json" }, key), body: JSON.stringify(body) });
  const find = (store: MemorySharedNetRepository, key: string, q: string) =>
    request(store, `/api/v1/people?q=${encodeURIComponent(q)}`, { headers: apiHeaders({}, key) });
  const roomsOf = async (store: MemorySharedNetRepository, principalId: PrincipalId) =>
    (await store.listRoomsForPrincipal(principalId)).items.map((room) => room.room.id as string);

  it("seats a person found by any Instance id of theirs, tells them who did it, and lets them bring their own Agent", async () => {
    const { store, roomId, cy, principal } = await people();
    const invited = await invite(store, roomId, ADA, { instance_id: cy.instance.id });
    expect(invited.status).toBe(201);
    expect(await json(invited)).toEqual({ status: "invited", person: { principal_id: principal(cy), name: "Cy Young" }, room_id: roomId });

    // Access at once, through Cy's own human seat; no Agent of Cy's followed.
    expect(await roomsOf(store, principal(cy))).toContain(roomId);
    const view = await store.getRoomForPrincipal(principal(cy), roomId as RoomId);
    expect(view.memberships.filter((member) => member.principal_id === principal(cy)).map((member) => [member.runtime_kind, member.admitted_by])).toEqual([["human", "added"]]);
    const [notice] = (await store.listDecisionsForPrincipal(principal(cy))).decisions;
    expect(notice).toMatchObject({ person_invite: { stranger: true }, decision: { title: 'Ada Lovelace invited you to "Parser rewrite"', status: "pending", room_id: roomId, requested_for_instance_id: null } });

    // Cy chooses an Agent from the Dashboard's door, the one that seats your own Instances; it waits and speaks.
    const seat = await store.dashboardSeat("cy");
    expect((await store.addRoomMembers(seat.auth, roomId as RoomId, { with: [cy.instance.id] })).admissions[0].status).toBe("member");
    const said = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(cy.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: "Cy's Agent, here." }),
    });
    expect(said.status).toBe(201);

    // Inviting someone who can already see the Room writes nothing.
    const again = await invite(store, roomId, ADA, { principal_id: principal(cy) });
    expect(again.status).toBe(200);
    expect((await json(again)).status).toBe("member");
    expect((await store.listDecisionsForPrincipal(principal(cy))).decisions).toHaveLength(1);
  });

  it("leaves in one step: every seat goes, the invite is declined, and the owner cannot leave its own Room", async () => {
    const { store, roomId, cy, principal } = await people();
    await invite(store, roomId, ADA, { instance_id: cy.instance.id });
    await store.addRoomMembers((await store.dashboardSeat("cy")).auth, roomId as RoomId, { with: [cy.instance.id] });

    const left = await request(store, `/api/v1/rooms/${roomId}/leave`, { method: "POST", headers: apiHeaders({}, CY) });
    expect(left.status).toBe(200);
    expect(await roomsOf(store, principal(cy))).not.toContain(roomId);
    expect((await store.listDecisionsForPrincipal(principal(cy))).decisions[0].decision.status).toBe("denied");
    const after = await request(store, `/api/v1/rooms/${roomId}/messages`, {
      method: "POST",
      headers: instanceHeaders(cy.token, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
      body: JSON.stringify({ content: "Still here?" }),
    });
    expect(after.status).toBe(403);

    const owner = await request(store, `/api/v1/rooms/${roomId}/leave`, { method: "POST", headers: apiHeaders({}, ADA) });
    expect(owner.status).toBe(409);
    expect((await json(owner)).error.code).toBe("owner_cannot_leave");
  });

  it("lets anyone seated invite, and nobody else", async () => {
    const { store, roomId, cy } = await people();
    expect((await invite(store, roomId, BOB, { instance_id: cy.instance.id })).status).toBe(201);
    const outsider = await invite(store, roomId, DAN, { instance_id: cy.instance.id });
    expect(outsider.status).toBe(404);
    expect((await json(outsider)).error.code).toBe("room_not_found");
  });

  it("finds by name only people you share or shared a Room with", async () => {
    const { store, roomId, bob, cy, principal } = await people();
    expect((await json(await find(store, ADA, "bo"))).people).toEqual([{ principal_id: principal(bob), name: "Bob Kahn" }]);
    expect((await json(await find(store, ADA, "cy"))).people).toEqual([]);
    expect((await json(await find(store, BOB, "lovelace"))).people.map((person: any) => person.name)).toEqual(["Ada Lovelace"]);
    // A Principal id from anywhere else does not resolve: the id is not a way around the name rule.
    const unseen = await invite(store, roomId, ADA, { principal_id: principal(cy) });
    expect(unseen.status).toBe(404);
    expect((await json(unseen)).error.code).toBe("person_not_found");
    expect((await find(store, ADA, "b")).status).toBe(422);

    // Once Bob has left, he is still someone Ada shared a Room with.
    await request(store, `/api/v1/rooms/${roomId}/leave`, { method: "POST", headers: apiHeaders({}, BOB) });
    expect((await json(await find(store, ADA, "kahn"))).people).toHaveLength(1);
    expect((await invite(store, roomId, ADA, { principal_id: principal(bob) })).status).toBe(201);
    expect((await store.listDecisionsForPrincipal(principal(bob))).decisions[0].person_invite).toEqual({ stranger: false });
  });

  it("refuses yourself, an anonymous Principal, and an unknown Instance alike", async () => {
    const { store, roomId, ada } = await people();
    for (const instanceId of [ada.instance.id, "i_0000000000"]) {
      const response = await invite(store, roomId, ADA, { instance_id: instanceId });
      expect(response.status).toBe(404);
      expect((await json(response)).error.code).toBe("person_not_found");
    }
    const anonymous = await startInstance(store);
    expect((await invite(store, roomId, ADA, { instance_id: anonymous.instance.id })).status).toBe(404);
    expect((await invite(store, roomId, ADA, { instance_id: anonymous.instance.id, principal_id: anonymous.instance.principal_id })).status).toBe(422);
  });

  it("lets a stranger leave and block, after which that inviter's invites are refused", async () => {
    const { store, roomId, bob, cy, principal } = await people();
    await invite(store, roomId, ADA, { instance_id: cy.instance.id });
    const [notice] = (await store.listDecisionsForPrincipal(principal(cy))).decisions;
    await store.resolveDecisionForPrincipal(principal(cy), notice.decision.id, { outcome: "denied", block: true });
    expect(await roomsOf(store, principal(cy))).not.toContain(roomId);
    const refused = await invite(store, roomId, ADA, { instance_id: cy.instance.id });
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.code).toBe("invite_refused");
    expect((await invite(store, roomId, BOB, { instance_id: cy.instance.id })).status).toBe(201);

    // Someone you have shared a Room with can be declined, not blocked.
    await request(store, `/api/v1/rooms/${roomId}/leave`, { method: "POST", headers: apiHeaders({}, BOB) });
    await invite(store, roomId, ADA, { instance_id: bob.instance.id });
    const [known] = (await store.listDecisionsForPrincipal(principal(bob))).decisions;
    await expect(store.resolveDecisionForPrincipal(principal(bob), known.decision.id, { outcome: "denied", block: true })).rejects.toMatchObject({ code: "decision_resolution_invalid" });
  });

  it("invites at most ten strangers a day", async () => {
    const { store, roomId } = await people();
    for (let n = 0; n < 11; n += 1) {
      const stranger = await startWithKey(store, strangerKey(n));
      const response = await invite(store, roomId, ADA, { instance_id: stranger.instance.id });
      expect(response.status).toBe(n < 10 ? 201 : 429);
    }
  });
});
