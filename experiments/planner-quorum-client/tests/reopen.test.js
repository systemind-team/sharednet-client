import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordination, coordinationOptions, parseReopenRequest } from "../dist/coordination.js";
import { goalWatch } from "../dist/goal.js";
import { CliError } from "../dist/errors.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, options = {}) {
    let clock = 0, sequence = 1;
    const records = [1, 2, 3].map(i => ({ name: `codex-${i}`, member_id: `id-${i}`, driver: "codex",
        model: i === 1 ? "astra" : "luna", tokens: 0, turns: 0 }));
    const turns = [], events = [], concurrency = new Map();
    const co = new Coordination({ records, goal: "Task", roomId: "test", now: () => new Date(clock),
        options: coordinationOptions({ completionPolicy: "all-agents-done", ...options }, ["check true"]),
        event: event => events.push(event),
        runTurn: (seat, prompt) => new Promise(resolve => {
            seat.turns++;
            concurrency.set(seat.name, (concurrency.get(seat.name) ?? 0) + 1);
            assert.equal(concurrency.get(seat.name), 1, "No two turns may overlap for one member");
            let ended = false;
            turns.push({ seat, prompt, finish(failed = false) {
                if (ended) return; ended = true;
                concurrency.set(seat.name, concurrency.get(seat.name) - 1); resolve(failed);
            } });
        }) });
    t.after(async () => { co.stopped = true; for (const turn of turns) turn.finish(); await co.drain(); });
    const message = (name, content) => ({ sequence: ++sequence, content,
        sender_instance_id: records.find(r => r.name === name)?.member_id ?? "outsider", sender: { name } });
    const say = (name, content) => { const post = message(name, content); co.observe(post); return post; };
    return { co, records, turns, events, message, say, now: () => new Date(clock),
        advance: (ms = 31000) => { clock += ms; },
        async tick() { co.tick(); await flush(); },
        async done() { await this.tick(); for (const turn of turns) { say(turn.seat.name, "DONE"); turn.finish(); } await flush(); } };
}

test("REOPEN grammar requires an exact standalone mention, verb, ID and nonempty instruction", () => {
    assert.deepEqual(parseReopenRequest("@codex-2 REOPEN verify-1: Check the plot"),
        { recipient: "codex-2", request_id: "verify-1", instruction: "Check the plot" });
    assert.equal(parseReopenRequest("@claude-code-2 REOPEN v2: Check\nthe figure").recipient, "claude-code-2");
    for (const value of ["Please @codex-2 REOPEN x: fix", "> @codex-2 REOPEN x: fix", "@codex-2 please verify",
        "@codex-2 reopen x: fix", "@codex-2 REOPEN : fix", "@codex-2 REOPEN x:  ", "DONE", "codex-2 REOPEN x: fix"])
        assert.equal(parseReopenRequest(value), null, value);
});
test("an explicit request revokes idle DONE, wakes only its recipient, requires a new DONE", async t => {
    const f = fixture(t); await f.done(); assert.equal(f.co.ready, true);
    const request = f.say("codex-1", "@codex-2 REOPEN verify-1: Verify the figure");
    assert.equal(f.co.ready, false); assert.equal(f.co.states[1].done, false);
    await f.tick(); assert.equal(f.turns.length, 4); assert.equal(f.turns[3].seat.name, "codex-2");
    assert.match(f.turns[3].prompt, /Outstanding explicit requests/);
    assert.match(f.turns[3].prompt, /verify-1: Verify the figure/);
    f.turns[3].finish(); await flush(); assert.equal(f.co.ready, false);
    f.say("codex-2", "DONE"); assert.equal(f.co.ready, true);
    for (const type of ["request_queued", "done_revoked", "agent_reawakened", "request_completed"]) {
        const event = f.events.find(e => e.type === type);
        assert.equal(event.sender, "codex-1"); assert.equal(event.recipient, "codex-2");
        assert.equal(event.sequence, request.sequence);
    }
});
test("broadcast, casual mention, self request, outsider and DONE do not wake completed members", async t => {
    const f = fixture(t); await f.done();
    for (const [sender, content] of [["codex-1", "Everyone please review"], ["codex-1", "codex-2 should verify"],
        ["codex-1", "@codex-2 please verify"], ["codex-2", "@codex-2 REOPEN self: verify"],
        ["outsider", "@codex-2 REOPEN x: verify"], ["codex-1", "DONE"]]) f.say(sender, content);
    await f.tick(); assert.equal(f.turns.length, 3); assert.equal(f.co.ready, true);
});
test("sequence replay and repeated sender/request ID are idempotent, even after completion", async t => {
    const f = fixture(t); await f.done();
    const post = f.say("codex-1", "@codex-2 REOPEN fix-1: Fix plot");
    f.co.observe(post); f.say("codex-1", "@codex-2 REOPEN fix-1: Fix plot");
    await f.tick(); assert.equal(f.turns.length, 4);
    f.say("codex-2", "DONE"); f.turns[3].finish(); await flush();
    f.say("codex-1", "@codex-3 REOPEN fix-1: Reusing ID with changed target is also ignored");
    await f.tick(); assert.equal(f.turns.length, 4); assert.equal(f.co.ready, true);
    assert.equal(f.co.summary().accepted_reopen_requests, 1);
});
test("request during previous DONE turn queues; old turn's later DONE cannot discharge it", async t => {
    const f = fixture(t); await f.tick();
    for (const turn of f.turns) f.say(turn.seat.name, "DONE");
    f.turns[0].finish(); f.turns[2].finish(); await flush();
    f.say("codex-1", "@codex-2 REOPEN later: Do more verification");
    f.say("codex-2", "DONE"); await f.tick();
    assert.equal(f.turns.length, 3); assert.equal(f.co.states[1].done, false);
    assert.ok(f.events.some(e => e.type === "done_deferred"));
    f.turns[1].finish(); await flush(); await f.tick();
    assert.equal(f.turns.length, 4); assert.match(f.turns[3].prompt, /Do more verification/);
    f.say("codex-2", "DONE"); f.turns[3].finish(); await flush(); assert.equal(f.co.ready, true);
});
test("multiple requests batch without loss, and same ID from distinct senders is distinct", async t => {
    const f = fixture(t); await f.done();
    f.say("codex-1", "@codex-2 REOPEN fix: Fix plot");
    f.say("codex-3", "@codex-2 REOPEN fix: Verify caption");
    await f.tick(); assert.equal(f.turns.length, 4);
    assert.match(f.turns[3].prompt, /Fix plot/); assert.match(f.turns[3].prompt, /Verify caption/);
    f.say("codex-1", "@codex-2 REOPEN fix-next: Verify units");
    f.say("codex-2", "DONE"); f.turns[3].finish(); await flush();
    assert.equal(f.co.ready, false); await f.tick(); assert.equal(f.turns.length, 5);
    assert.match(f.turns[4].prompt, /Verify units/);
    f.say("codex-2", "DONE"); f.turns[4].finish(); await flush();
    assert.equal(f.co.ready, true); assert.equal(f.events.filter(e => e.type === "request_completed").length, 3);
});
test("failed reopened turn retains outstanding requests for retry", async t => {
    const f = fixture(t); await f.done(); f.say("codex-1", "@codex-2 REOPEN fix: Fix plot");
    await f.tick(); f.say("codex-2", "DONE"); f.turns[3].finish(true); await flush();
    assert.equal(f.co.ready, false); assert.equal(f.co.states[1].requests.length, 1);
    f.advance(); await f.tick(); assert.match(f.turns[4].prompt, /Fix plot/);
    f.say("codex-2", "DONE"); f.turns[4].finish(); await flush(); assert.equal(f.co.ready, true);
});
test("exited recipients do not revive and exited senders cannot issue requests", async t => {
    const f = fixture(t); await f.tick();
    f.say("codex-1", "DONE"); f.say("codex-3", "DONE"); f.turns[0].finish(); f.turns[2].finish();
    f.turns[1].finish(true); await flush();
    for (let i = 0; i < 2; i++) { f.advance(); await f.tick(); f.turns.at(-1).finish(true); await flush(); }
    const target = f.co.states[1]; assert.equal(target.active, false); const attempts = target.attempts;
    f.say("codex-1", "@codex-2 REOPEN revive: Come back");
    f.say("codex-2", "@codex-1 REOPEN bad: Do something"); await f.tick();
    assert.equal(target.active, false); assert.equal(target.attempts, attempts);
    assert.equal(f.co.exits.length, 1); assert.equal(f.co.summary().accepted_reopen_requests, 0);
    assert.ok(f.events.some(e => e.reason === "recipient_not_active"));
    assert.ok(f.events.some(e => e.reason === "sender_not_active"));
});
test("request while planner is working waits for PLAN_READY and worker release", async t => {
    const f = fixture(t, { startupMode: "planner-first" }); await f.tick();
    const planner = f.co.planner, recipient = f.records.find(r => r.name !== planner).name;
    f.say(planner, `@${recipient} REOPEN pre: Verify after startup`);
    await f.tick(); assert.equal(f.turns.length, 1);
    f.say(planner, "Plan: split the task across all three members"); f.say(planner, "PLAN_READY");
    f.turns[0].finish(); await flush(); await f.tick();
    const recipientTurn = f.turns.find(turn => turn.seat.name === recipient);
    assert.match(recipientTurn.prompt, /Verify after startup/);
});
test("old quorum revision cannot approve after a request, even when later ready again", async t => {
    const f = fixture(t); await f.done(); const revision = f.co.revision;
    f.say("codex-1", "@codex-2 REOPEN r: Check again");
    assert.throws(() => f.co.approveCompletion(revision));
    await f.tick(); f.say("codex-2", "DONE"); f.turns.at(-1).finish(); await flush();
    assert.equal(f.co.ready, true); assert.throws(() => f.co.approveCompletion(revision));
    f.co.approveCompletion(f.co.revision);
});
test("REOPEN interpretation is disabled outside all-agents-done", async t => {
    const f = fixture(t, { completionPolicy: "any-agent" }); await f.done();
    f.say("codex-1", "@codex-2 REOPEN r: Check again");
    assert.equal(f.co.states[1].done, true); assert.equal(f.co.summary().accepted_reopen_requests, 0);
});

for (const variant of ["passing", "failing", "outage", "deadline", "budget"]) {
    test(`watcher drains requests arriving DURING final checks (${variant})`, async t => {
        const f = fixture(t); await f.done();
        const out = await mkdtemp(join(tmpdir(), "sharednet-reopen-check-"));
        t.after(() => rm(out, { recursive: true, force: true }));
        const inbox = []; let checks = 0, calls = 0, used = 0, failPoll = false;
        f.co.runTurn = async seat => { calls++; inbox.push(f.message(seat.name, "DONE")); return false; };
        const until = ["check report", "after 1m", "budget 1k tokens"];
        const client = { async request(method, path, token, body) {
            if (path.endsWith("/close")) {
                if (variant === "deadline") assert.equal(body.trigger, "after 1m");
                else if (variant === "budget") assert.equal(body.trigger, "budget 1k tokens");
                else { assert.equal(checks, 2); assert.equal(calls, 1); assert.equal(f.co.ready, true); }
                return {};
            }
            if (path.includes("/wait?")) {
                if (failPoll) { failPoll = false; throw new CliError("service_unavailable", "offline outage simulation", 5); }
                await flush(); f.advance(1000);
                return { items: inbox.length ? [inbox.shift()] : [] }; // Exercise pagination.
            }
            return { room: { goal: { sequence: 1, started_at: new Date(0).toISOString(), until } } };
        } };
        const result = await goalWatch(client, "member", "owner", { roomId: "room", out, workspace: out,
            checkEveryMs: 60000, quietChecks: true }, { now: f.now, coordination: f.co, snapshot: null,
            sleep: async () => {}, spend: () => used,
            check: async () => {
                checks++;
                if (checks === 1) {
                    await flush(); // This post is only visible through the next API read.
                    inbox.push(f.message("codex-1", "@codex-2 REOPEN race-1: Recheck before closing"));
                    inbox.push(f.message("codex-3", "@codex-2 REOPEN race-2: Also check units"));
                    if (variant === "outage") failPoll = true;
                    if (variant === "deadline") f.advance(61000);
                    if (variant === "budget") used = 1000;
                }
                return { exitCode: variant === "failing" && checks === 1 ? 1 : 0, output: "result" };
            } });
        if (["deadline", "budget"].includes(variant)) {
            assert.equal(calls, 0); assert.equal(Boolean(f.co.completionApproved), false);
        } else {
            assert.equal(result.ended_by.trigger, "check report");
            assert.equal(f.co.summary().accepted_reopen_requests, 2);
            assert.ok(f.events.some(e => e.type === "final_check_invalidated"));
            assert.equal(f.events.filter(e => e.type === "final_check_failed").length, 0);
            const roomLog = await readFile(join(out, "room.ndjson"), "utf8");
            assert.match(roomLog, /race-1/); assert.match(roomLog, /race-2/);
        }
    });
}
