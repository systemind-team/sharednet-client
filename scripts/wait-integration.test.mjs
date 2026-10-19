// Real CLI processes against a loopback stand-in for the service: what a unit test with a scripted
// fetch cannot show, such as a caller that is actually blocked in `wait` and then continues, a
// socket that stalls or drops, and a process killed mid-wait. First written by Dots for this
// repository's PR 4; adapted to the server-side filter (SharedNet #140) and to a wake that hands
// over everything said since the cursor (SharedNet #178), to the seat's place kept by the service
// (#183), to mentions (#186), and to a seat that is woken by resuming its own session (#191).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = join(root, "packages/cli/bin/sharednet.js");
const roomId = "rom_LocalRoom1";
const readerId = "i_Reader0001";
const targetId = "i_Target0001";
const otherId = "i_Other00001";
const drivenId = "i_Driven0001";
const page = (items) => ({ items, next_cursor: null, has_more: false });

before(async () => {
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "packages/cli/tsconfig.build.json"], { cwd: root });
});

async function fixture(t, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "sharednet-wait-e2e-"));
  const messages = [];
  const pending = new Set();
  const requests = [];
  const reads = [];
  const children = new Set();
  const seatId = options.legacy ? "mem_Reader0001" : readerId;
  let setupRequests = 0;
  let stall = false;
  let disconnect = false;
  // Each seat's place, as the service keeps it: what it was handed, and what it has handled.
  const places = new Map();
  const placeOf = (request) => {
    const token = request.headers.authorization ?? "";
    if (!places.has(token)) places.set(token, { delivered_through: 0, acked_through: 0 });
    return places.get(token);
  };
  const seatIds = { reader: seatId, target: targetId, other: otherId, driven: drivenId };
  const answer = (response, body) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (url.pathname.endsWith("/join")) {
      const id = seatIds[body.name] ?? seatId;
      answer(response, { room: { id: roomId }, membership: { member_id: id }, member_token: `sni_${id.padEnd(43, "X")}`, history: page(messages) });
    } else if (url.pathname === "/api/v1/instances/current" || url.pathname === "/api/v1/instances/current/heartbeat") {
      setupRequests += 1;
      // Deliberately hold identity/lease setup open to test the client deadline.
    } else if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const token = request.headers.authorization;
      const senderId = [targetId, otherId, drivenId].find((id) => token.includes(id)) ?? readerId;
      // As the service does: the seats a line addresses by @name or @id, never the speaker.
      const mentions = Object.entries(seatIds)
        .filter(([name, id]) => id !== senderId && new RegExp(`@(?:${name}|${id})\\b`).test(body.content))
        .map(([, id]) => id);
      const message = { id: `msg_${String(messages.length + 1).padStart(10, "0")}`, sequence: messages.length + 1, content: body.content, mentions, sender: { member_id: senderId, kind: "instance", name: "same display name" } };
      messages.push(message);
      answer(response, { message });
      for (const waiter of pending) waiter.flush();
    } else if (request.method === "GET" && url.pathname.endsWith("/messages")) {
      // The read a filtered wake makes: everything after the cursor, unfiltered, oldest first.
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 50);
      reads.push({ after, limit, filtered: url.searchParams.has("sender_instance_id") || url.searchParams.has("q") });
      const rest = messages.filter((message) => message.sequence > after);
      answer(response, { items: rest.slice(0, limit), next_cursor: null, has_more: rest.length > limit });
    } else if (request.method === "GET" && url.pathname.endsWith("/subscription")) {
      answer(response, { subscription: { room_id: roomId, ...placeOf(request) } });
    } else if (request.method === "POST" && url.pathname.endsWith("/ack")) {
      const place = placeOf(request);
      place.acked_through = Math.min(Math.max(place.acked_through, Number(body.through) || 0), messages.length);
      place.delivered_through = Math.max(place.delivered_through, place.acked_through);
      answer(response, { subscription: { room_id: roomId, ...place } });
    } else if (url.pathname.endsWith("/wait")) {
      const sender = url.searchParams.get("sender_instance_id");
      const mentioned = url.searchParams.get("mentions");
      const place = placeOf(request);
      requests.push({ after: Number(url.searchParams.get("after")), timeout: Number(url.searchParams.get("timeout")), sender });
      if (disconnect) { request.socket.destroy(); return; }
      const after = requests.at(-1).after;
      const waiter = { flush() {
        // As the service does: a filtered wait answers only when a matching message is there.
        const fresh = messages.filter((message) => message.sequence > after && (sender === null || message.sender.member_id === sender) && (mentioned === null || message.mentions.includes(mentioned)));
        if (!stall && fresh.length) {
          pending.delete(waiter);
          clearTimeout(timer);
          place.delivered_through = Math.max(place.delivered_through, fresh.at(-1).sequence);
          answer(response, page(fresh));
        }
      } };
      const timer = setTimeout(() => {
        if (!stall) { pending.delete(waiter); answer(response, page([])); }
      }, requests.at(-1).timeout * 1000);
      pending.add(waiter);
      response.on("close", () => { clearTimeout(timer); pending.delete(waiter); });
      waiter.flush();
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const env = { PATH: process.env.PATH, HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_STATE_HOME: join(scratch, "state"), SHAREDNET_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const projects = {};
  for (const name of ["reader", "target", "other"]) {
    projects[name] = join(scratch, name);
    await mkdir(projects[name]);
    await exec(process.execPath, [cli, "join", roomId, "--token", `rit_${"T".repeat(43)}`, "--name", name, "--json"], { cwd: projects[name], env, timeout: 5000 });
  }
  if (options.session) {
    const { getStoragePaths, writeSession } = await import("../packages/cli/dist/storage.js");
    await writeSession(getStoragePaths(env), {
      schema_version: 1, base_url: env.SHAREDNET_BASE_URL, principal_id: "p_Local00001", agent_id: null,
      instance_id: readerId, local_instance_key: null, instance_token: `sni_${"S".repeat(43)}`,
      created_at: "2026-01-01T00:00:00.000Z", lease_expires_at: "2026-01-01T00:01:00.000Z", expires_at: null,
    });
  }
  t.after(async () => {
    for (const child of children) child.kill("SIGKILL");
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  });
  return {
    env,
    projects,
    messages,
    requests,
    reads,
    setupRequests: () => setupRequests,
    stall(value) { stall = value; },
    disconnect(value) { disconnect = value; },
    async polls(count) {
      const deadline = Date.now() + 5000;
      while (requests.length < count && Date.now() < deadline) await delay(10);
      assert.ok(requests.length >= count, "waiting CLI never issued its long-poll");
    },
    async say(name, content) {
      await exec(process.execPath, [cli, "say", content, "--json"], { cwd: projects[name], env, timeout: 5000 });
    },
    async cursor() {
      return JSON.parse(await readFile(join(projects.reader, ".sharednet/room.json"), "utf8")).seats[seatId].last_sequence;
    },
    wait(...args) {
      const child = spawn(process.execPath, [cli, "wait", "--from-instance", targetId, "--json", ...args], { cwd: projects.reader, env });
      children.add(child);
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const done = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
      });
      return { child, done };
    },
  };
}

test("a blocked CLI wakes only for the target, and hands over what others said before it", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.say("target", "old target message");
  const consumed = await f.wait("--timeout", "0").done;
  assert.equal(JSON.parse(consumed.stdout).items[0].content, "old target message");
  const waiting = f.wait("--timeout", "5");
  let continued = false;
  const continuation = waiting.done.then((result) => { continued = true; return result; });
  await f.polls(2);
  // Someone else speaking, and the reader itself, do not wake a wait narrowed to the target.
  await f.say("other", "unrelated");
  await f.say("reader", "self");
  await delay(300);
  assert.equal(continued, false);
  assert.equal(f.requests.length, 2);
  await f.say("target", "new target message; $(touch SHOULD_NOT_EXIST)");
  const result = await continuation;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(continued, true);
  // The target woke it; what the other member said came along, because the cursor moved past it.
  // The reader's own words never come back.
  assert.deepEqual(JSON.parse(result.stdout).items.map(({ sequence, content }) => ({ sequence, content })), [
    { sequence: 2, content: "unrelated" },
    { sequence: 4, content: "new target message; $(touch SHOULD_NOT_EXIST)" },
  ]);
  assert.equal(await f.cursor(), 4);
  assert.deepEqual(f.requests.map(({ after, sender }) => ({ after, sender })), [{ after: 0, sender: targetId }, { after: 1, sender: targetId }]);
  assert.deepEqual(f.reads.map(({ after, filtered }) => ({ after, filtered })), [{ after: 0, filtered: false }, { after: 1, filtered: false }]);
});

test("client deadline cancels a stalled server request", { timeout: 10000 }, async (t) => {
  const f = await fixture(t);
  f.stall(true);
  const waiting = f.wait("--timeout", "1");
  await f.polls(1);
  const result = await waiting.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items, []);
  assert.equal(await f.cursor(), 0);
});

test("deadline also bounds a stalled legacy-seat identity lookup", { timeout: 7000 }, async (t) => {
  const f = await fixture(t, { legacy: true });
  const waiting = f.wait("--timeout", "1");
  const result = await Promise.race([waiting.done, delay(3000).then(() => ({ code: "still blocked" }))]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).items, []);
  assert.equal(f.setupRequests(), 1);
  assert.equal(await f.cursor(), 0);
});

test("deadline also bounds stalled account lease refresh with an explicit failure", { timeout: 7000 }, async (t) => {
  const f = await fixture(t, { session: true });
  const waiting = f.wait("--timeout", "1");
  const result = await Promise.race([waiting.done, delay(3000).then(() => ({ code: "still blocked" }))]);
  assert.equal(result.code, 5, result.stderr);
  assert.equal(JSON.parse(result.stderr).error.code, "service_unavailable");
  assert.equal(f.setupRequests(), 1);
  assert.equal(await f.cursor(), 0);
});

test("disconnect and process cancellation preserve restart recovery", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  f.disconnect(true);
  const failed = await f.wait("--timeout", "2").done;
  assert.equal(failed.code, 5);
  assert.equal(await f.cursor(), 0);
  f.disconnect(false);
  const cancelled = f.wait();
  await f.polls(2);
  cancelled.child.kill("SIGTERM");
  assert.equal((await cancelled.done).signal, "SIGTERM");
  assert.equal(await f.cursor(), 0);
  await f.say("target", "arrived while caller was disconnected");
  const resumed = await f.wait("--timeout", "2").done;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).items[0].content, "arrived while caller was disconnected");
  assert.equal(await f.cursor(), 1);
});

test("a seat joined from inside a Codex session is resumed when addressed, and its answer is posted", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  // A stand-in for Codex: it answers with what it was resumed with, so the test sees both.
  const harness = join(f.projects.reader, "..", "harness-bin");
  await mkdir(harness);
  await writeFile(
    join(harness, "codex"),
    `#!${process.execPath}
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk)).on("end", () => {
  const resumed = args[0] === "exec" && args[1] === "resume" && args.at(-1) === "-";
  const lines = prompt.split("\\n").filter((line) => line.startsWith("#")).join(" | ");
  const said = resumed ? "resumed " + args.at(-2) + ": " + lines : "not a resume: " + args.join(" ");
  for (const event of [{ type: "item.completed", item: { type: "agent_message", text: said } }, { type: "turn.completed", usage: {} }]) console.log(JSON.stringify(event));
});
`,
    { mode: 0o755 },
  );
  // A real Codex keeps the thread's rollout under CODEX_HOME (here HOME/.codex); serve's start check
  // looks for it before it drives the seat.
  const rollouts = join(f.env.HOME, ".codex", "sessions", "2026", "10", "13");
  await mkdir(rollouts, { recursive: true });
  await writeFile(join(rollouts, "rollout-2026-10-13T00-00-00-thread-0001.jsonl"), "{}\n");
  const project = join(f.projects.reader, "..", "driven");
  await mkdir(project);
  const env = { ...f.env, PATH: `${harness}:${f.env.PATH}`, CODEX_SESSION_ID: "thread-0001" };
  const joined = JSON.parse(
    (await exec(process.execPath, [cli, "join", roomId, "--token", `rit_${"T".repeat(43)}`, "--name", "driven", "--json"], { cwd: project, env, timeout: 5000 })).stdout,
  );
  try {
    // The join remembered the session and started the wake service, which now sits on the seat.
    assert.equal(joined.wake.service, "started", JSON.stringify(joined.wake));
    assert.equal(joined.wake.session, "thread-0001");
    await f.say("other", "the build is green");
    await f.say("target", "@driven what is left?");
    let answer;
    for (let attempt = 0; attempt < 200 && !answer; attempt += 1) {
      await delay(100);
      answer = f.messages.find((message) => message.sender.member_id === drivenId);
    }
    assert.ok(answer, "the addressed seat's session was never resumed");
    // The same thread, resumed with everything said since the join, and its last words posted for it.
    assert.match(answer.content, /^resumed thread-0001: /);
    assert.match(answer.content, /#\d+ same display name: the build is green \| #\d+ same display name: @driven what is left\?$/);
  } finally {
    await exec(process.execPath, [cli, "serve", "--stop", "--json"], { cwd: project, env, timeout: 5000 }).catch(() => undefined);
    try { process.kill(joined.wake.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("serve discovers a server-added Room and wakes the same Instance there", { timeout: 30000 }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "sharednet-cross-room-e2e-"));
  const roomA = "rom_LocalRoomA";
  const roomB = "rom_ServerRoom";
  const roomC = "rom_Foreign001";
  const instanceId = "i_CrossRoom1";
  const memberToken = `sni_${"S".repeat(43)}`;
  const staleSeatToken = `sni_${"J".repeat(43)}`;
  const rooms = new Set([roomA]);
  const messages = new Map([[roomA, []], [roomB, []], [roomC, []]]);
  const places = new Map([
    [roomA, { delivered_through: 0, acked_through: 0 }],
    [roomB, { delivered_through: 0, acked_through: 0 }],
    [roomC, { delivered_through: 0, acked_through: 0 }],
  ]);
  const waits = [];
  const waitStarts = [];
  const pushRegistrations = new Map();
  const children = new Set();

  const roomFrom = (pathname) => /^\/api\/v1\/rooms\/(rom_[A-Za-z0-9]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const answer = (response, body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const flush = () => {
    for (const waiter of [...waits]) waiter.flush();
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const room = roomFrom(url.pathname);
    if (request.method === "POST" && url.pathname === `/api/v1/rooms/${roomA}/join`) {
      answer(response, {
        room: { id: roomA, name: "Local", state: "open", type: "board" },
        membership: { member_id: instanceId, kind: "instance", name: "Logistics Manager", state: "active" },
        member_token: staleSeatToken,
        history: page([]),
      });
    } else if (request.headers.authorization !== `Bearer ${memberToken}`) {
      answer(response, { error: { code: "invalid_credentials" } }, 401);
    } else if (request.method === "GET" && url.pathname === "/api/v1/rooms") {
      answer(response, { items: [...rooms].map((id) => ({ id, principal_id: id === roomC ? "p_Foreign001" : "p_CrossRoom1", name: id === roomA ? "Local" : "From aicoo", state: "open", type: "board" })) });
    } else if (request.method === "GET" && room && url.pathname === `/api/v1/rooms/${room}`) {
      answer(response, { room: { id: room, name: room === roomA ? "Local" : "From aicoo", state: "open", type: "board" }, memberships: [] });
    } else if (request.method === "PUT" && room && url.pathname.endsWith("/subscription")) {
      const secret = `secret-for-${room}`;
      if (body.push_url === null) pushRegistrations.delete(room);
      else pushRegistrations.set(room, { url: body.push_url, secret });
      answer(response, { subscription: { room_id: room, ...places.get(room) }, ...(body.push_url === null ? {} : { push: { secret } }) });
    } else if (request.method === "GET" && room && url.pathname.endsWith("/subscription")) {
      answer(response, { subscription: { room_id: room, ...places.get(room) } });
    } else if (request.method === "POST" && room && url.pathname.endsWith("/ack")) {
      const place = places.get(room);
      place.acked_through = Math.max(place.acked_through, Number(body.through) || 0);
      place.delivered_through = Math.max(place.delivered_through, place.acked_through);
      answer(response, { subscription: { room_id: room, ...place } });
    } else if (request.method === "POST" && room && url.pathname.endsWith("/subscription/heartbeat")) {
      answer(response, { renewed: true, subscription: { room_id: room, ...places.get(room) } });
    } else if (request.method === "GET" && room && url.pathname.endsWith("/messages")) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const items = messages.get(room).filter((message) => message.sequence > after);
      answer(response, page(items));
    } else if (request.method === "POST" && room && url.pathname.endsWith("/messages")) {
      const list = messages.get(room);
      const message = {
        id: `msg_${String(list.length + 1).padStart(10, "0")}`,
        room_id: room,
        sequence: list.length + 1,
        content: body.content,
        mentions: [],
        sender: { member_id: instanceId, kind: "instance", name: "Logistics Manager" },
        created_at: new Date().toISOString(),
      };
      list.push(message);
      answer(response, { message }, 201);
      flush();
    } else if (request.method === "GET" && room && url.pathname.endsWith("/wait")) {
      const after = Number(url.searchParams.get("after") ?? 0);
      waitStarts.push({ room, after });
      const mentioned = url.searchParams.get("mentions");
      const place = places.get(room);
      const waiter = {
        room,
        flush() {
          const fresh = messages.get(room).filter((message) => message.sequence > after && (mentioned === null || message.mentions.includes(mentioned)));
          if (fresh.length === 0) return;
          const index = waits.indexOf(waiter);
          if (index >= 0) waits.splice(index, 1);
          place.delivered_through = Math.max(place.delivered_through, fresh.at(-1).sequence);
          answer(response, page(fresh));
        },
      };
      if (Number(url.searchParams.get("timeout") ?? 0) === 0) {
        waits.push(waiter);
        waiter.flush();
        const index = waits.indexOf(waiter);
        if (index >= 0) {
          waits.splice(index, 1);
          answer(response, page([]));
        }
        return;
      }
      waits.push(waiter);
      response.on("close", () => {
        const index = waits.indexOf(waiter);
        if (index >= 0) waits.splice(index, 1);
      });
      waiter.flush();
    } else if (url.pathname === "/api/v1/instances/current" || url.pathname === "/api/v1/instances/current/heartbeat") {
      answer(response, { instance: { id: instanceId } });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const project = join(scratch, "project");
  const marker = join(scratch, "wake.ndjson");
  const adapter = join(scratch, "wake-adapter");
  await mkdir(project);
  await writeFile(adapter, `#!${process.execPath}\nlet input="";process.stdin.on("data",c=>input+=c).on("end",()=>{require("fs").appendFileSync(${JSON.stringify(marker)},input);console.log("cross-room reply nonce-42")});\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_STATE_HOME: join(scratch, "state"),
    SHAREDNET_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const waitUntil = async (predicate, message, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    assert.fail(message);
  };
  const stopServe = async (child, context) => {
    assert.equal(child.exitCode, null, `${context} exited before it was stopped`);
    const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
    child.kill("SIGTERM");
    const result = await closed;
    assert.ok(result.code === 0 || result.signal === "SIGTERM", `${context} did not stop cleanly: ${JSON.stringify(result)}`);
    children.delete(child);
  };
  try {
    await exec(process.execPath, [cli, "join", roomA, "--token", `rit_${"T".repeat(43)}`, "--name", "Logistics Manager", "--json"], { cwd: project, env, timeout: 5000 });
    const { getStoragePaths, writeSession } = await import("../packages/cli/dist/storage.js");
    await writeSession(getStoragePaths(env), {
      schema_version: 1,
      base_url: env.SHAREDNET_BASE_URL,
      principal_id: "p_CrossRoom1",
      agent_id: null,
      instance_id: instanceId,
      local_instance_key: null,
      instance_token: memberToken,
      created_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expires_at: null,
    });
    await exec(process.execPath, [cli, "wake", "set", "command", "--command", adapter, "--json"], { cwd: project, env, timeout: 5000 });
    let serving = spawn(process.execPath, [cli, "serve", "--json"], { cwd: project, env });
    children.add(serving);
    let stderr = "";
    serving.stderr.on("data", (chunk) => (stderr += chunk));
    await waitUntil(() => waits.some((waiter) => waiter.room === roomA), `serve never listened in Room A: ${stderr}`);

    rooms.add(roomB);
    rooms.add(roomC);
    messages.get(roomB).push({
      id: "msg_0000000001", room_id: roomB, sequence: 1, content: "unmentioned control", mentions: [],
      sender: { member_id: "i_AicooHost01", kind: "instance", name: "aicoo" }, created_at: new Date().toISOString(),
    });
    await waitUntil(() => waits.some((waiter) => waiter.room === roomB), `serve never discovered the server-added Room B: ${stderr}`);
    assert.equal(waits.some((waiter) => waiter.room === roomC), false, "a cross-Principal Room inherited local wake authority");
    await assert.rejects(readFile(join(env.XDG_CONFIG_HOME, "sharednet", "rooms", roomC, `${instanceId}.json`), "utf8"));
    await assert.rejects(readFile(marker, "utf8"));

    messages.get(roomB).push({
      id: "msg_0000000002", room_id: roomB, sequence: 2, content: `@${instanceId} nonce-42`, mentions: [instanceId],
      sender: { member_id: "i_AicooHost01", kind: "instance", name: "aicoo" }, created_at: new Date().toISOString(),
    });
    flush();
    await waitUntil(() => messages.get(roomB).some((message) => message.content === "cross-room reply nonce-42"), `serve did not answer in Room B: ${stderr}`);

    const wakes = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].room_id, roomB);
    assert.equal(wakes[0].member_id, instanceId);
    assert.equal(wakes[0].trigger, "mention");
    assert.deepEqual(wakes[0].messages.map((message) => message.content), ["unmentioned control", `@${instanceId} nonce-42`]);
    assert.equal(wakes[0].messages.at(-1).content, `@${instanceId} nonce-42`);
    assert.equal(messages.get(roomA).some((message) => message.content === "cross-room reply nonce-42"), false);
    await waitUntil(() => places.get(roomB).acked_through === 2, `serve replied but did not acknowledge Room B: ${stderr}`);
    const persisted = JSON.parse(await readFile(join(env.XDG_CONFIG_HOME, "sharednet", "rooms", roomB, `${instanceId}.json`), "utf8"));
    assert.equal(persisted.member_token, memberToken);
    assert.deepEqual(persisted.wake, { driver: "command", cwd: project, command: adapter });
    await stopServe(serving, "first serve");

    // Persistence, rather than rediscovery, carries Room B across a restart.
    rooms.delete(roomB);
    const beforeRestart = waitStarts.filter((entry) => entry.room === roomB).length;
    serving = spawn(process.execPath, [cli, "serve", "--json"], { cwd: project, env });
    children.add(serving);
    serving.stderr.on("data", (chunk) => (stderr += chunk));
    await waitUntil(
      () => waitStarts.filter((entry) => entry.room === roomB).length > beforeRestart,
      `serve did not resume Room B after restart: ${stderr}`,
    );
    assert.equal(waitStarts.filter((entry) => entry.room === roomB).at(-1).after, 2);
    await delay(250);
    assert.equal((await readFile(marker, "utf8")).trim().split("\n").length, 1);
    assert.equal(messages.get(roomB).filter((message) => message.content === "cross-room reply nonce-42").length, 1);
    await stopServe(serving, "restarted serve");

    // A requested remote Room is reconciled before the initial local-only filter decides there is
    // nothing to serve. Remove the discovered credential to recreate a fresh machine state.
    rooms.add(roomB);
    await rm(join(env.XDG_CONFIG_HOME, "sharednet", "rooms", roomB), { recursive: true, force: true });
    const beforeFilteredStart = waitStarts.filter((entry) => entry.room === roomB).length;
    serving = spawn(process.execPath, [cli, "serve", "--rooms", roomB, "--json"], { cwd: project, env });
    children.add(serving);
    serving.stderr.on("data", (chunk) => (stderr += chunk));
    await waitUntil(
      () => waitStarts.filter((entry) => entry.room === roomB).length > beforeFilteredStart,
      `serve --rooms did not reconcile the remotely added Room before filtering: ${stderr}`,
    );
    assert.equal(serving.exitCode, null, stderr);
    await stopServe(serving, "filtered serve");

    // Push subscriptions are per (Room, Instance), even when one Instance owns both seats. Ringing
    // either Room's distinct secret must wake that Room; registering B must not overwrite A.
    const portProbe = createServer();
    await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
    const pushPort = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    await writeFile(marker, "");
    serving = spawn(
      process.execPath,
      [cli, "serve", "--push", `http://127.0.0.1:${pushPort}`, "--listen", String(pushPort), "--json"],
      { cwd: project, env },
    );
    children.add(serving);
    serving.stderr.on("data", (chunk) => (stderr += chunk));
    await waitUntil(() => pushRegistrations.has(roomA) && pushRegistrations.has(roomB), `serve did not register both Room doorbells: ${stderr}`);
    messages.get(roomA).push({
      id: "msg_0000000001", room_id: roomA, sequence: 1, content: `@${instanceId} push-a`, mentions: [instanceId],
      sender: { member_id: "i_AicooHost1", kind: "instance", name: "aicoo" }, created_at: new Date().toISOString(),
    });
    messages.get(roomB).push({
      id: "msg_0000000004", room_id: roomB, sequence: 4, content: `@${instanceId} push-b`, mentions: [instanceId],
      sender: { member_id: "i_AicooHost1", kind: "instance", name: "aicoo" }, created_at: new Date().toISOString(),
    });
    const ring = async (room) => {
      const { url, secret } = pushRegistrations.get(room);
      const body = JSON.stringify({ room_id: room });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
      return fetch(url, { method: "POST", headers: { "x-sharednet-timestamp": timestamp, "x-sharednet-signature": signature }, body });
    };
    assert.equal((await ring(roomA)).status, 204);
    assert.equal((await ring(roomB)).status, 204);
    await waitUntil(() => readFile(marker, "utf8").then((raw) => raw.trim().split("\n").filter(Boolean).length >= 2), `both pushed Rooms were not delivered: ${stderr}`);
    const pushed = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(new Set(pushed.map((wake) => wake.room_id)), new Set([roomA, roomB]));
    await stopServe(serving, "push serve");
  } finally {
    for (const child of children) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("serve --run hears a brief posted in a server-added Room before discovery, and not an old Room's history", { timeout: 30000 }, async () => {
  // aicoo's order: `room_create {with:[agent]}`, then the brief at #1 at once, before any serve has
  // looked at /rooms. A `--run` connector holds no wake binding to inherit, so it must neither skip
  // the brief as history nor replay a long-admitted Room that nobody has addressed.
  const scratch = await mkdtemp(join(tmpdir(), "sharednet-run-discovery-e2e-"));
  const roomA = "rom_RunLocalA1";
  const roomB = "rom_RunBrief01";
  const roomOld = "rom_RunOldLog1";
  const instanceId = "i_RunDisc0001";
  const memberToken = `sni_${"R".repeat(43)}`;
  const aicoo = { member_id: "i_AicooHost01", kind: "instance", name: "aicoo" };
  const line = (room, sequence, content, mentions = []) => ({
    id: `msg_${String(sequence).padStart(10, "0")}`, room_id: room, sequence, content, mentions, sender: aicoo, created_at: new Date().toISOString(),
  });
  const messages = new Map([
    [roomA, []],
    [roomB, [line(roomB, 1, `@${instanceId} tell me your thoughts here`, [instanceId])]],
    [roomOld, Array.from({ length: 30 }, (_, index) => line(roomOld, index + 1, `old line ${index + 1}`))],
  ]);
  const places = new Map([...messages.keys()].map((room) => [room, { delivered_through: 0, acked_through: 0 }]));
  const waitStarts = [];
  const children = new Set();
  const roomFrom = (pathname) => /^\/api\/v1\/rooms\/(rom_[A-Za-z0-9]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const answer = (response, body, status = 200) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const room = roomFrom(url.pathname);
    if (request.method === "POST" && url.pathname === `/api/v1/rooms/${roomA}/join`) {
      answer(response, {
        room: { id: roomA, name: "Local", state: "open", type: "board" },
        membership: { member_id: instanceId, kind: "instance", name: "Runner", state: "active" },
        member_token: memberToken,
        history: page([]),
      });
    } else if (request.headers.authorization !== `Bearer ${memberToken}`) {
      answer(response, { error: { code: "invalid_credentials" } }, 401);
    } else if (request.method === "GET" && url.pathname === "/api/v1/rooms") {
      answer(response, { items: [...messages.keys()].map((id) => ({ id, principal_id: "p_RunDisc0001", name: id, state: "open", type: "board" })) });
    } else if (request.method === "GET" && room && url.pathname === `/api/v1/rooms/${room}`) {
      answer(response, { room: { id: room, name: room, state: "open", type: "board" }, memberships: [] });
    } else if (room && url.pathname.endsWith("/subscription")) {
      answer(response, { subscription: { room_id: room, ...places.get(room) } });
    } else if (request.method === "POST" && room && url.pathname.endsWith("/ack")) {
      const place = places.get(room);
      place.acked_through = Math.max(place.acked_through, Number(body.through) || 0);
      place.delivered_through = Math.max(place.delivered_through, place.acked_through);
      answer(response, { subscription: { room_id: room, ...place } });
    } else if (request.method === "POST" && room && url.pathname.endsWith("/subscription/heartbeat")) {
      answer(response, { renewed: true, subscription: { room_id: room, ...places.get(room) } });
    } else if (request.method === "GET" && room && url.pathname.endsWith("/messages")) {
      const list = messages.get(room);
      if (url.searchParams.get("order") === "desc") answer(response, page(list.slice(-1)));
      else answer(response, page(list.filter((message) => message.sequence > Number(url.searchParams.get("after") ?? 0))));
    } else if (request.method === "POST" && room && url.pathname.endsWith("/messages")) {
      const list = messages.get(room);
      const message = { ...line(room, list.length + 1, body.content), sender: { member_id: instanceId, kind: "instance", name: "Runner" } };
      list.push(message);
      answer(response, { message }, 201);
    } else if (request.method === "GET" && room && url.pathname.endsWith("/wait")) {
      const after = Number(url.searchParams.get("after") ?? 0);
      const mentioned = url.searchParams.get("mentions");
      waitStarts.push({ room, after, mentioned });
      const list = messages.get(room).filter((message) => message.sequence > after);
      // The service's mention filter wakes on an addressed line and hands over everything since.
      const fresh = mentioned === null || list.some((message) => message.mentions.includes(mentioned)) ? list : [];
      if (fresh.length > 0) places.get(room).delivered_through = fresh.at(-1).sequence;
      // Hold an empty long-poll briefly, as the service would until its timeout.
      if (fresh.length === 0 && Number(url.searchParams.get("timeout") ?? 0) > 0) await delay(200);
      answer(response, page(fresh));
    } else if (url.pathname === "/api/v1/instances/current" || url.pathname === "/api/v1/instances/current/heartbeat") {
      answer(response, { instance: { id: instanceId } });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const project = join(scratch, "project");
  const marker = join(scratch, "runs.ndjson");
  const adapter = join(scratch, "run-adapter");
  await mkdir(project);
  await writeFile(adapter, `#!${process.execPath}\nlet input="";process.stdin.on("data",c=>input+=c).on("end",()=>{require("fs").appendFileSync(${JSON.stringify(marker)},JSON.stringify(JSON.parse(input))+"\\n");console.log("run reply")});\n`, { mode: 0o755 });
  const env = {
    PATH: process.env.PATH,
    HOME: scratch,
    XDG_CONFIG_HOME: join(scratch, "config"),
    XDG_STATE_HOME: join(scratch, "state"),
    SHAREDNET_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  };
  const waitUntil = async (predicate, message, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await delay(25);
    }
    assert.fail(message);
  };
  try {
    await exec(process.execPath, [cli, "join", roomA, "--token", `rit_${"T".repeat(43)}`, "--name", "Runner", "--no-wake", "--json"], { cwd: project, env, timeout: 5000 });
    const { getStoragePaths, writeSession } = await import("../packages/cli/dist/storage.js");
    await writeSession(getStoragePaths(env), {
      schema_version: 1,
      base_url: env.SHAREDNET_BASE_URL,
      principal_id: "p_RunDisc0001",
      agent_id: null,
      instance_id: instanceId,
      local_instance_key: null,
      instance_token: memberToken,
      created_at: new Date().toISOString(),
      lease_expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      expires_at: null,
    });
    // Both Rooms, and the brief at #1, exist before serve starts: discovery is necessarily later.
    const serving = spawn(process.execPath, [cli, "serve", "--run", adapter, "--reply", "--json"], { cwd: project, env });
    children.add(serving);
    let stderr = "";
    serving.stderr.on("data", (chunk) => (stderr += chunk));
    await waitUntil(() => messages.get(roomB).some((message) => message.content === "run reply"), `the brief posted before discovery was never handed to --run: ${stderr}`);
    await waitUntil(() => waitStarts.some((entry) => entry.room === roomOld), `serve never listened in the old Room: ${stderr}`);
    await delay(300);

    const runs = (await readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].room_id, roomB);
    assert.deepEqual(runs[0].messages.map((message) => message.sequence), [1]);
    assert.equal(waitStarts.find((entry) => entry.room === roomB).after, 0, "the brief's Room did not start at its admission place");
    // The old Room is listened to for addresses only; its 30 lines are neither handed over nor answered.
    assert.ok(waitStarts.filter((entry) => entry.room === roomOld).every((entry) => entry.mentioned === instanceId));
    assert.equal(messages.get(roomOld).length, 30);
    await waitUntil(() => places.get(roomB).acked_through >= 1, `serve answered but did not acknowledge the brief: ${stderr}`);
  } finally {
    for (const child of children) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGKILL");
      await closed;
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(scratch, { recursive: true, force: true });
  }
});
