import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
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
const page = (items) => ({ items, next_cursor: null, has_more: false });

before(async () => {
  await exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "packages/cli/tsconfig.build.json"], { cwd: root });
});

async function fixture(t, options = {}) {
  const scratch = await mkdtemp(join(tmpdir(), "sharednet-wait-e2e-"));
  const messages = [];
  const pending = new Set();
  const requests = [];
  const children = new Set();
  const seatId = options.legacy ? "mem_Reader0001" : readerId;
  let setupRequests = 0;
  let stall = false;
  let disconnect = false;
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
      const id = body.name === "target" ? targetId : body.name === "other" ? otherId : seatId;
      answer(response, { room: { id: roomId }, membership: { member_id: id }, member_token: `sni_${id.padEnd(43, "X")}`, history: page(messages) });
    } else if (url.pathname === "/api/v1/instances/current" || url.pathname === "/api/v1/instances/current/heartbeat") {
      setupRequests += 1;
      // Deliberately hold identity/lease setup open to test the client deadline.
    } else if (request.method === "POST" && url.pathname.endsWith("/messages")) {
      const token = request.headers.authorization;
      const senderId = token.includes(targetId) ? targetId : token.includes(otherId) ? otherId : readerId;
      const message = { id: `msg_${String(messages.length + 1).padStart(10, "0")}`, sequence: messages.length + 1, content: body.content, sender: { member_id: senderId, kind: "instance", name: "same display name" } };
      messages.push(message);
      answer(response, { message });
      for (const waiter of pending) waiter.flush();
    } else if (url.pathname.endsWith("/wait")) {
      requests.push({ after: Number(url.searchParams.get("after")), timeout: Number(url.searchParams.get("timeout")) });
      if (disconnect) { request.socket.destroy(); return; }
      const after = requests.at(-1).after;
      const waiter = { flush() {
        const fresh = messages.filter((message) => message.sequence > after);
        if (!stall && fresh.length) { pending.delete(waiter); clearTimeout(timer); answer(response, page(fresh)); }
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
    requests,
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

test("an already waiting CLI returns the target's new message and its caller continues", { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  await f.say("target", "old target message");
  const consumed = await f.wait("--timeout", "0").done;
  assert.equal(JSON.parse(consumed.stdout).items[0].content, "old target message");
  const waiting = f.wait("--timeout", "5");
  let continued = false;
  const continuation = waiting.done.then((result) => { continued = true; return result; });
  await f.polls(2);
  assert.equal(continued, false);
  await f.say("other", "unrelated");
  await f.polls(3);
  await f.say("reader", "self");
  await f.polls(4);
  assert.equal(continued, false);
  await f.say("target", "new target message; $(touch SHOULD_NOT_EXIST)");
  const result = await continuation;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(continued, true);
  assert.deepEqual(JSON.parse(result.stdout).items.map(({ sequence, content }) => ({ sequence, content })), [{ sequence: 4, content: "new target message; $(touch SHOULD_NOT_EXIST)" }]);
  assert.equal(await f.cursor(), 4);
  assert.deepEqual(f.requests.map(({ after }) => after), [0, 1, 2, 3]);
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
