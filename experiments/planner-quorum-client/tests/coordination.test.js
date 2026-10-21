import test from "node:test";
import assert from "node:assert/strict";
import { Coordination, coordinationOptions, randomPicker } from "../dist/coordination.js";

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(startupMode = "planner-first", count = 3) {
    const records = Array.from({ length: count }, (_, i) => ({ name: `agent-${i}`, member_id: `id-${i}`,
        driver: "codex", model: i ? "luna" : "astra", tokens: 0, turns: 0 }));
    let clock = 0, seq = 1;
    const turns = [], events = [];
    const controller = new Coordination({ records,
        options: coordinationOptions({ startupMode, completionPolicy: "all-agents-done", plannerSeed: "test" }, ["check true"]),
        goal: "Solve math", roomId: "test-room", now: () => new Date(clock), event: event => events.push(event),
        runTurn: (seat, prompt) => new Promise(resolve => {
            seat.turns++;
            turns.push({ seat, prompt, finish: resolve });
        }) });
    const say = (name, content) => controller.observe({ sequence: ++seq, content,
        sender_instance_id: records.find(s => s.name === name)?.member_id ?? "outsider" });
    const tick = async () => { clock += 31_000; controller.tick(); await flush(); };
    return { controller, records, turns, events, say, tick };
}
test("defaults preserve legacy policy; invalid flags and bypass triggers rejected", () => {
    assert.equal(coordinationOptions().enabled, false);
    assert.throws(() => coordinationOptions({ startupMode: "wrong" }));
    assert.throws(() => coordinationOptions({ plannerSeed: "x" }));
    assert.throws(() => coordinationOptions({ completionPolicy: "all-agents-done" }, ["after 1m"]));
    for (const trigger of ["message", "mention", "count 5", "idle 1m", "said DONE"])
        assert.throws(() => coordinationOptions({ completionPolicy: "all-agents-done" }, ["check true", trigger]));
    assert.equal(coordinationOptions({ startupMode: "planner-first" }).enabled, true);
});
test("selection reproducible, covers entire roster, never fixed to first member", () => {
    const names = ["a", "b", "c", "d"];
    assert.deepEqual(randomPicker("same")(names), randomPicker("same")(names));
    const picked = new Set(Array.from({ length: 100 }, (_, i) => randomPicker(String(i))(names).name));
    assert.deepEqual(picked, new Set(names));
});
test("only random planner starts; plan + PLAN_READY + successful turn release everyone", async () => {
    const f = fixture(); await f.tick();
    assert.equal(f.turns.length, 1);
    const planner = f.controller.planner;
    assert.equal(f.turns[0].seat.name, planner);
    for (const seat of f.records) assert.ok(f.turns[0].prompt.includes(seat.name));
    f.say("outsider", "PLAN_READY"); await f.tick(); assert.equal(f.turns.length, 1);
    f.say(planner, "PLAN_READY"); assert.equal(f.controller.planReady, false);
    f.say(planner, "Assign agent-0 analysis, agent-1 computation, agent-2 verification.");
    f.say(planner, "PLAN_READY"); await f.tick(); assert.equal(f.turns.length, 1);
    f.turns[0].finish(false); await flush(); await f.tick();
    assert.equal(f.turns.length, 4);
    assert.equal(f.controller.phase, "work");
    for (const turn of f.turns.slice(1)) turn.finish(false);
    await f.controller.drain();
});
test("exact member DONE required; final barrier waits for every turn to exit", async () => {
    const f = fixture("simultaneous"); await f.tick();
    f.say("outsider", "DONE"); f.say("agent-0", "almost DONE");
    assert.equal(f.controller.states.some(s => s.done), false);
    for (const seat of f.records) f.say(seat.name, "DONE");
    assert.equal(f.controller.ready, false);
    f.turns[0].finish(false); f.turns[1].finish(false); await flush();
    assert.equal(f.controller.ready, false);
    f.turns[2].finish(false); await flush();
    assert.equal(f.controller.ready, true);
    await f.tick(); assert.equal(f.turns.length, 3);
    f.controller.approveCompletion();
    f.controller.finish({ trigger: "check true" });
    assert.equal(f.controller.summary().status, "completed");
});
test("one failed turn is retried; three failures remove member and require fresh redistribution", async () => {
    const f = fixture("simultaneous", 2); await f.tick();
    f.say("agent-1", "DONE"); f.turns[1].finish(false);
    f.turns[0].finish(true); await flush();
    assert.equal(f.controller.exits.length, 0);
    for (let i = 0; i < 2; i++) { await f.tick(); f.turns.at(-1).finish(true); await flush(); }
    assert.equal(f.controller.exits.length, 1);
    assert.equal(f.controller.live.length, 1);
    assert.equal(f.controller.ready, false);
    assert.equal(f.controller.planner, "agent-1");
    assert.equal(f.controller.live[0].done, false);
    await f.tick();
    assert.match(f.turns.at(-1).prompt, /redistribute/);
    f.say("agent-0", "DONE"); assert.equal(f.controller.ready, false);
    f.say("agent-1", "I take over agent-0's unfinished analysis and keep my verification work.");
    f.say("agent-1", "PLAN_READY"); f.turns.at(-1).finish(false); await flush(); await f.tick();
    f.say("agent-1", "DONE"); f.turns.at(-1).finish(false); await flush();
    assert.equal(f.controller.ready, true);
    f.controller.approveCompletion();
    f.controller.finish({ trigger: "check true" });
    const result = f.controller.summary();
    assert.equal(result.status, "completed_degraded");
    assert.equal(result.configured_count, 2); assert.equal(result.participating_count, 1);
    assert.deepEqual(result.participating_models, { "codex/luna": 1 });
});
test("failed planner's late PLAN_READY cannot release workers", async () => {
    const f = fixture(); await f.tick(); const planner = f.controller.planner;
    f.turns[0].finish(true); await flush();
    f.say(planner, "Plan for everybody"); f.say(planner, "PLAN_READY");
    assert.equal(f.controller.planReady, false);
    await f.tick(); assert.equal(f.turns.length, 2);
    f.turns[1].finish(false); await flush();
});
test("planner failure replaces planner randomly from surviving roster", async () => {
    const f = fixture(); const old = f.controller.planner;
    for (let i = 0; i < 3; i++) { await f.tick(); f.turns.at(-1).finish(true); await flush(); }
    assert.notEqual(f.controller.planner, old);
    assert.equal(f.controller.selections.length, 2);
    assert.ok(!f.controller.selections[1].candidates.includes(old));
});
test("all failed agents yield failure, not empty-quorum success", async () => {
    const f = fixture("simultaneous", 1);
    for (let i = 0; i < 3; i++) { await f.tick(); f.turns.at(-1).finish(true); await flush(); }
    assert.equal(f.controller.phase, "failed"); assert.equal(f.controller.ready, false);
    f.controller.finish({ trigger: "owner" }); assert.equal(f.controller.status, "failed");
});
test("failed final check invalidates DONE for everyone and delivers feedback despite quiet checks", async () => {
    const f = fixture("simultaneous", 2); await f.tick();
    for (const turn of f.turns) { f.say(turn.seat.name, "DONE"); turn.finish(false); }
    await flush(); assert.equal(f.controller.ready, true);
    f.controller.checkFailed("report missing"); await f.tick();
    assert.equal(f.turns.length, 4);
    assert.equal(f.controller.ready, false);
    assert.match(f.turns.at(-1).prompt, /report missing/);
    for (const turn of f.turns.slice(2)) turn.finish(false);
    await f.controller.drain();
});
test("timeout and budget never count as degraded completion", () => {
    for (const [trigger, status] of [["after 45m", "timeout"], ["budget 5M tokens", "budget_exhausted"], ["owner", "stopped"]]) {
        const f = fixture(); f.controller.exits.push({ name: "agent-0" });
        f.controller.finish({ trigger }); assert.equal(f.controller.status, status);
    }
});
test("recovery waits for in-flight workers and ignores their old-round DONE", async () => {
    const f = fixture("simultaneous", 2); f.controller.recoveryGraceMs = 120_000; await f.tick();
    const oldWorker = f.turns[1];
    f.turns[0].finish(true); await flush();
    for (let i = 0; i < 2; i++) { await f.tick(); f.turns.at(-1).finish(true); await flush(); }
    assert.equal(f.controller.phase, "planning");
    const before = f.turns.length;
    f.say("agent-1", "DONE"); await f.tick();
    assert.equal(f.turns.length, before);
    assert.equal(f.controller.live[0].done, false);
    oldWorker.finish(false); await flush(); await f.tick();
    assert.equal(f.turns.length, before + 1);
    assert.match(f.turns.at(-1).prompt, /randomly selected as planner/);
    f.turns.at(-1).finish(false); await f.controller.drain();
});
