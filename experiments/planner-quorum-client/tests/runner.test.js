import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGoal } from "../dist/goal-run.js";
import { goalWatch } from "../dist/goal.js";
import { runCli } from "../dist/cli.js";

async function simulation(t, { failSeat = null, failFirstCheck = false, bound = "after 5m", legacy = false, stuckWorkers = false, work = undefined } = {}) {
    const root = await mkdtemp(join(tmpdir(), "sharednet-quorum-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = join(root, "workspace"), out = join(root, "out");
    await mkdir(workspace);
    let clock = Date.parse("2026-10-21T00:00:00Z"), sequence = 1, polls = 0, checkCount = 0;
    const start = new Date(clock).toISOString();
    const agents = [0, 1, 2].map(i => ({ name: `codex-${i + 1}`, driver: "codex", model: i ? "luna" : "astra" }));
    const queued = [], commands = [], turns = [], events = [];
    const stuck = new Map(), held = new Set();
    const until = work?.fixedWorkMs ? ["check check-report", "after 60s"] : ["said /^DONE$/", "check check-report", bound];
    let closed = null;
    const say = (name, content) => queued.push({ sequence: ++sequence, content, sender_instance_id: `id-${name}`, sender: { name } });
    const room = () => ({ room: { state: closed ? "closed" : "open", goal: {
        sequence: 1, started_at: start, until, ended_by: closed } }, memberships: [] });
    const client = { async request(method, path, token, body) {
        if (path.includes("/wait?")) {
            await new Promise(resolve => setTimeout(resolve, 5)); clock += work?.fixedWorkMs ? 10000 : 1000;
            if (++polls > 400) throw new Error("test runaway");
            return { items: queued.splice(0) };
        }
        if (path.endsWith("/close")) { closed = { ...body, at: new Date(clock).toISOString() }; return room(); }
        if (path.endsWith("/owner-messages")) { events.push(body); return {}; }
        return room();
    } };
    const docker = async (args, options = {}) => {
        commands.push(args);
        if (args[0] === "stop") {
            const seat = args.at(-1).replace("sharednet-goal-rom_test-", "");
            stuck.get(seat)?.({ code: 137, stdout: "", stderr: "recovery stop" });
            stuck.delete(seat);
            return {code:0,stdout:"",stderr:""};
        }
        if (args[0] === "inspect") return {code:0,stdout:"false",stderr:""};
        if (args.includes("join")) {
            const name = args[args.indexOf("--name") + 1];
            return { code: 0, stdout: JSON.stringify({ member_id: `id-${name}` }), stderr: "" };
        }
        if (args[0] === "cp") return { code: 1, stdout: "", stderr: "fake home unavailable" };
        if (args.includes("check-report")) {
            checkCount++;
            // Scheduled checks must not run before the initial planning turn in quorum mode.
            if (!legacy) assert.ok(turns.length >= agents.length + 1);
            return { code: failFirstCheck && checkCount === 1 ? 1 : 0, stdout: "checked", stderr: "" };
        }
        if (args.includes("codex")) {
            const seat = args.find(value => value.startsWith("SHAREDNET_SEAT="))?.split("=")[1].slice(3);
            const prompt = args.at(-1); turns.push({ seat, prompt });
            if (seat === failSeat) {
                options.onLine(JSON.stringify({ type: "turn.failed", error: { message: "429 rate limit" } }));
                return { code: 1, stdout: "", stderr: "HTTP 429" };
            }
            if (stuckWorkers && !prompt.includes("You were randomly selected as planner") && !held.has(seat)) {
                held.add(seat);
                return await new Promise(resolve => stuck.set(seat, resolve));
            }
            if (prompt.includes("You were randomly selected as planner")) {
                say(seat, "Plan: assign each active agent a portion of the task; redistribute any exited member's work.");
                say(seat, "PLAN_READY");
            } else say(seat, "DONE");
            options.onLine(JSON.stringify({ type: "thread.started", thread_id: `session-${seat}` }));
            options.onLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } }));
            return { code: 0, stdout: "", stderr: "" };
        }
        if (args.includes("wait")) {
            if (work?.fixedWorkMs) {
                await new Promise(resolve => setTimeout(resolve, 5));
                return { code: 0, stdout: JSON.stringify({ fired: ["after"], messages: [], from: 1, through: sequence }), stderr: "" };
            }
            return { code: 0, stdout: JSON.stringify({ fired: ["closed"] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
    };
    const result = await runGoal(client, "dummy-member", "dummy-owner", {
        plan: { agents, image: "fake-image", workspace, cli: { root, entry: "bin/sharednet.js" }, codexAuth: { kind: "api-key" } },
        roomId: "rom_test", inviteToken: "dummy-invite", goal: "Solve Math_001", goalSequence: 1,
        work, until, baseUrl: "https://example.invalid", out, checkEveryMs: 60_000, quietChecks: true,
        ...(legacy ? {} : { coordination: { startupMode: "planner-first", completionPolicy: "all-agents-done", plannerSeed: "integration" } }),
    }, { docker, now: () => new Date(clock), sleep: async () => {} });
    return { result, turns, events, commands, checkCount, episode: JSON.parse(await readFile(join(out, "episode.json"))),
        coordination: legacy ? null : JSON.parse(await readFile(join(out, "coordination.json"))),
        journal: legacy ? [] : (await readFile(join(out, "coordination.ndjson"), "utf8")).trim().split("\n").map(JSON.parse) };
}
test("full runner with fake Docker: planner, quorum, final check, records and cleanup", async t => {
    const f = await simulation(t);
    assert.equal(f.result.status, "completed"); assert.equal(f.checkCount, 1);
    assert.equal(f.turns.length, 4); assert.equal(f.episode.status, "completed");
    assert.equal(f.coordination.participating_count, 3);
    assert.ok(f.journal.some(e => e.type === "work_released"));
    assert.deepEqual(f.commands.at(-1).slice(0, 2), ["rm", "--force"]);
});
test("full runner: repeated 429, redistribution and degraded provenance", async t => {
    const f = await simulation(t, { failSeat: "codex-2" });
    assert.equal(f.result.status, "completed_degraded", JSON.stringify({turns:f.turns.map(t=>t.seat),journal:f.journal}));
    assert.equal(f.coordination.configured_count, 3); assert.equal(f.coordination.remaining_count, 2);
    assert.equal(f.coordination.exits[0].last_failure.rate_limit_observed, true);
    assert.equal(f.turns.filter(turn => turn.seat === "codex-2").length, 3);
    assert.ok(f.journal.some(e => e.type === "planner_selected" && e.reason === "redistribute_after_exit"));
});
test("full runner: failing check reopens all members even with quiet-checks", async t => {
    const f = await simulation(t, { failFirstCheck: true });
    assert.equal(f.result.status, "completed", JSON.stringify({turns:f.turns.map(t=>t.seat),journal:f.journal})); assert.equal(f.checkCount, 2);
    assert.equal(f.turns.length, 7);
    assert.match(f.turns.at(-1).prompt, /Runner feedback/);
    assert.equal(f.events.length, 0);
});
test("full runner: bound cannot become success", async t => {
    const f = await simulation(t, { bound: "after 1s" });
    assert.equal(f.result.status, "timeout"); assert.equal(f.turns.length, 0);
});
test("full runner without flags retains scheduled-check completion and no extra schema", async t => {
    const f = await simulation(t, { legacy: true });
    assert.equal(f.result.ended_by.trigger, "check check-report");
    assert.equal(f.episode.coordination, undefined); assert.equal(f.episode.status, undefined);
});
test("CLI rejects invalid quorum trigger before network/auth/Docker", async t => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-cli-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, "goal.md"), "goal");
    let errors = "";
    const code = await runCli(["goal", "run", "goal.md", "--agent", "codex", "--until", "after 5m", "--until", "message",
        "--completion-policy", "all-agents-done"], { cwd: root, env: {},
        stderr: value => { errors += value; }, stdout: () => {},
        fetch: () => { throw new Error("Unexpected network call"); }, docker: () => { throw new Error("Unexpected Docker call"); } });
    assert.notEqual(code, 0); assert.match(errors, /requires an --until check/);
});
test("legacy watcher exact DONE rejects substrings and checks on real claim", async t => {
    const root = await mkdtemp(join(tmpdir(), "sharednet-watch-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let clock = 0, count = 0, polls = 0;
    const client = { async request(method, path, token, body) {
        if (path.endsWith("/close")) return {};
        if (path.includes("/wait?")) { polls++; clock += 1000; return { items: [{ sequence: polls + 1,
            content: polls === 1 ? "not DONE yet" : "DONE", sender_instance_id: "agent" }] }; }
        return { room: { goal: { started_at: new Date(0).toISOString(), sequence: 1,
            until: ["said /^DONE$/", "check true", "after 1m"] } } };
    } };
    const result = await goalWatch(client, "member", "owner", { roomId: "room", out: root, workspace: root,
        checkEveryMs: 60000, quietChecks: true }, { now: () => new Date(clock), snapshot: null,
        check: async () => ({ exitCode: ++count === 1 ? 1 : 0, output: "" }) });
    assert.equal(polls, 2); assert.equal(count, 2); assert.equal(result.ended_by.trigger, "check true");
});
test("quorum watcher requires ALL checks; wall bound wins if final check overruns", async t => {
    for (const overrun of [false, true]) {
        const root = await mkdtemp(join(tmpdir(), "sharednet-checks-test-"));
        t.after(() => rm(root, { recursive: true, force: true }));
        let clock = 0, count = 0, failures = 0, approved = false;
        const coordination = { allDoneMode: true, ready: true, phase: "work", observe() {}, tick() {},
            checkFailed() { failures++; }, approveCompletion() { approved = true; } };
        const client = { async request(method, path) {
            if (path.endsWith("/close")) return {};
            if (path.includes("/wait?")) { clock += 1000; return { items: [] }; }
            return { room: { goal: { started_at: new Date(0).toISOString(), sequence: 1,
                until: ["check one", "check two", "after 1m"] } } };
        } };
        const result = await goalWatch(client, "member", "owner", { roomId: "room", out: root, workspace: root,
            checkEveryMs: 60000, quietChecks: true }, { now: () => new Date(clock), snapshot: null, coordination,
            check: async () => { count++; if (overrun) clock += 61000;
                return { exitCode: count === 2 && !overrun ? 1 : 0, output: "" }; } });
        assert.equal(result.ended_by.trigger, overrun ? "after 1m" : "check one");
        assert.equal(approved, !overrun);
        assert.equal(failures, overrun ? 0 : 1);
        assert.equal(count, overrun ? 2 : 4);
    }
});

 test("full runner cancels stuck old turns, restarts their containers and finishes degraded", async t => {
    const f = await simulation(t, {failSeat:"codex-2",stuckWorkers:true});
    assert.equal(f.result.status,"completed_degraded");
    assert.equal(f.coordination.exits.length,1);
    assert.ok(f.journal.some(e=>e.type==="recovery_turn_cancel_confirmed"));
    assert.ok(f.commands.some(a=>a[0]==="stop"));
    assert.ok(f.commands.some(a=>a[0]==="inspect"));
    assert.ok(f.commands.some(a=>a[0]==="start"));
    for(const a of f.result.agents.filter(a=>a.name!=="codex-2")) assert.equal(a.failed_turns,0);
 });

test("fixed window: simultaneous starts, DONE/check do not finish, timer resumes seats, deadline stops", async t => {
    const f = await simulation(t, { legacy: true, work: { fixedWorkMs: 60000, researchEffort: "standard" } });
    assert.equal(f.result.ended_by.trigger, "after 60s");
    assert.ok(f.turns.length > 3);
    for (const seat of ["codex-1", "codex-2", "codex-3"]) assert.ok(f.turns.filter(t => t.seat === seat).length > 1);
    assert.equal(f.episode.coordination, undefined);
    assert.equal(f.episode.work_policy.fixedWorkMs, 60000);
    assert.ok(f.events.some(e => e.content.includes("DONE does not end")));
    assert.ok(f.commands.some(c => c.includes("after 10s")));
    assert.ok(f.turns.every(t => !t.prompt.includes("randomly selected as planner")));
});
test("prompt only keeps early completion and does not install timer wakes", async t => {
    const f = await simulation(t, { legacy: true, work: { researchEffort: "persistent" } });
    assert.equal(f.result.ended_by.trigger, "check check-report");
    assert.ok(f.turns[0].prompt.includes("strongest scientifically justified"));
    assert.ok(!f.commands.some(c => c.includes("after 10s")));
});
