// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.ts";
import { cleanReportText, deliverReport, findRecords, launchArguments, launchCommandLine, parseReportScore, readRows, reportOutcome, reportRow, reportTarget } from "./goal-report.ts";

const ROOM = "rom_AbCdEfGhIj";
/** Visibly made up, in the shapes the real ones have. */
const FAKE_OWNER_KEY = "snk_owner-key-never-in-a-report";
const FAKE_MODEL_KEY = "sk-synthetic-model-key-0000";
const AT = "2026-11-27T12:00:00.000Z";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sharednet-goal-report-"));
  cleanup.push(directory);
  return directory;
}

const lines = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";

/** A finished two-seat run: 30 minutes, one check that failed and one that passed, three turns. */
async function writeRecord(directory: string, episode: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "episode.json"),
    JSON.stringify({
      schema_version: 1,
      room_id: ROOM,
      goal: { message_id: "msg_goal000001", sequence: 1, until: ["check bash check.sh", "after 30m", "budget 2M tokens"], started_at: "2026-11-27T10:00:00.000Z" },
      ended_by: { at: "2026-11-27T10:30:00.250Z", detail: "PASS: ./compile.sh built ./executable.", trigger: "check bash check.sh" },
      runner: { started_at: "2026-11-27T10:00:02.000Z", ended_at: "2026-11-27T10:30:01.000Z", workspace: "/home/ada/projects/widget/work" },
      totals: { messages: 12, checks: 2, snapshots: 5, tokens: 1500, cached_tokens: 90000 },
      image: "pb-widget@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      web_search: "off",
      isolated: false,
      turn_limit_s: 1800,
      turn_policy: "legacy",
      mention_gate: false,
      task_gate: false,
      message_routing: "mentions-only",
      harness: { mode: null, package_version: "0.1.17", client_commit: "0614e559b95d0d7f06f7f666c286d1f54f544b89" },
      agents: [
        { name: "codex-1", driver: "codex", model: "gpt-6-luna", turns: 2, failed_turns: 0, tokens: 1000, usage: { input: 700, cached: 60000, output: 300 } },
        { name: "codex-2", driver: "codex", model: "gpt-6-luna", turns: 1, failed_turns: 1, tokens: 500, usage: { input: 400, cached: 30000, output: 100 } },
      ],
      ...episode,
    }),
  );
  await writeFile(
    join(directory, "wakes.ndjson"),
    files["wakes.ndjson"] ??
      lines([
        { seat: "codex-1", turn: 1, started_at: "2026-11-27T10:00:03.000Z", ended_at: "2026-11-27T10:10:03.000Z", tokens: 400, cut_by_end: false },
        { seat: "codex-2", turn: 1, started_at: "2026-11-27T10:00:03.000Z", ended_at: "2026-11-27T10:20:03.000Z", tokens: 500, cut_by_end: false },
        // A resumed Codex session reports its running total here: summing the column would count the first turn twice.
        { seat: "codex-1", turn: 2, started_at: "2026-11-27T10:15:00.000Z", ended_at: "2026-11-27T10:30:00.000Z", tokens: 1000, cut_by_end: true },
      ]),
  );
  await writeFile(
    join(directory, "checks.ndjson"),
    files["checks.ndjson"] ??
      lines([
        { at: "2026-11-27T10:12:00.000Z", passed: false, exit_code: 1 },
        { at: "2026-11-27T10:30:00.000Z", passed: true, exit_code: 0 },
      ]),
  );
  for (const [name, content] of Object.entries(files)) {
    if (name !== "wakes.ndjson" && name !== "checks.ndjson") await writeFile(join(directory, name), content);
  }
}

describe("a record as one row", () => {
  it("derives time, tokens and the ending from the record, and never sums a wake's tokens", async () => {
    const root = await temporary();
    const directory = join(root, "runs", "widget-n2-r1");
    await writeRecord(directory);
    const row = (await reportRow(directory, { experiment: "widget-scaling", tags: ["pilot"], now: () => new Date(AT) }))!;
    expect(row).toMatchObject({ schema: 2, id: ROOM, room_id: ROOM, goal_seq: 1, title: "widget-n2-r1", family: "widget-scaling", tags: ["pilot"], extracted_at: AT });
    expect(row.metrics).toMatchObject({
      started_at: "2026-11-27T10:00:00Z",
      ended_at: "2026-11-27T10:30:00Z",
      duration_s: 1800.3,
      n_agents: 2,
      turns: 3,
      failed_turns: 1,
      wakes: 3,
      turns_cut_by_end: 1,
      tokens_fresh: 1500,
      tokens_cached: 90000,
      tokens_input: 1100,
      tokens_output: 400,
      tokens_per_agent: 750,
      tokens_per_min: 50,
      // 10 + 20 + 15 minutes of turns
      agent_busy_s: 2700,
      parallelism: 1.5,
      messages: 12,
      checks: 2,
      checks_passed: 1,
      first_pass_s: 1800,
      snapshots: 5,
    });
    expect(row.performance).toMatchObject({ outcome: "passed", ended_by: "check bash check.sh", detail: "PASS: ./compile.sh built ./executable.", metric_name: null, metric_value: null, scores: [] });
    expect(row.config).toMatchObject({
      command_source: "reconstructed",
      n_agents: 2,
      agent_mix: [{ driver: "codex", model: "gpt-6-luna", count: 2 }],
      models: ["gpt-6-luna"],
      until: ["check bash check.sh", "after 30m", "budget 2M tokens"],
      image: "pb-widget@sha256:0123456789ab…",
      message_routing: "mentions-only",
      package_version: "0.1.17",
      client_commit: "0614e559b9",
      turn_limit_s: 1800,
      resumed: false,
    });
    expect(row.config.command).toBe("sharednet goal run GOAL.md --agent codex:gpt-6-luna ×2 --image pb-widget@sha256:0123456789ab… --web-search off --message-routing mentions-only --turn-limit 30m --until 'check bash check.sh' --until 'after 30m' --until 'budget 2M tokens'");
    expect(row.per_agent).toEqual([
      { name: "codex-1", driver: "codex", model: "gpt-6-luna", turns: 2, failed_turns: 0, tokens: 1000, input: 700, cached: 60000, output: 300 },
      { name: "codex-2", driver: "codex", model: "gpt-6-luna", turns: 1, failed_turns: 1, tokens: 500, input: 400, cached: 30000, output: 100 },
    ]);
    // The runner's workspace is on the person's machine; only the record's last three folders are named.
    expect(row.trace).toEqual({ url: null, local_path: `${root.split("/").at(-1)}/runs/widget-n2-r1`, notes: null });
    expect(JSON.stringify(row)).not.toContain("/home/ada");
  });

  it("shows the command the run was launched with when the record or a launcher kept it", async () => {
    const root = await temporary();
    const own = join(root, "own");
    await writeRecord(own, { launch: { argv: ["goal", "run", "/home/ada/projects/widget/TASK.md", "--agent", "codex:gpt-6-luna", "--agent", "codex:gpt-6-luna", "--workspace", "/home/ada/projects/widget/work", "--model-api", "https://models.example/v1", "--until", "after: 30m"] } });
    const fromRecord = (await reportRow(own))!;
    expect(fromRecord.config).toMatchObject({ command_source: "recorded", command: "sharednet goal run …/widget/TASK.md --agent codex:gpt-6-luna ×2 --workspace …/widget/work --model-api https://models.example/v1 --until 'after: 30m'" });

    // A launcher's own file, with the interpreter and the script in front and a session id inside.
    const launched = join(root, "launched");
    await writeRecord(launched, {}, {
      "launch.json": JSON.stringify({ label: "widget-n2", seats: 2, minutes: 30, limits: "1.5 CPU a seat", args: ["--session", "i_AbCdEfGhIj", "goal", "run", "/home/ada/projects/widget/goal.txt", "--agent", "codex:gpt-6-luna", "--name", "ada/widget", "--until", "after 30m", "--json"] }),
    });
    const fromLauncher = (await reportRow(launched))!;
    expect(fromLauncher.config.command).toBe("sharednet goal run …/widget/goal.txt --agent codex:gpt-6-luna --until 'after 30m' --json");
    expect(fromLauncher.config.launcher).toEqual({ label: "widget-n2", seats: 2, minutes: 30, limits: "1.5 CPU a seat" });
    expect(JSON.stringify(fromLauncher)).not.toContain("i_AbCdEfGhIj");

    // One folder up, as a wrapper that keeps the record in a subfolder writes it.
    const wrapped = join(root, "cell", "record");
    await writeRecord(wrapped);
    await writeFile(join(root, "cell", "command.safe.json"), JSON.stringify({ argv: ["/opt/node/bin/node", "/opt/client/bin/sharednet.js", "goal", "run", "TASK.md", "--session", "<session-redacted>", "--agent", "codex:gpt-6-luna", "--until", "after: 3m"] }));
    expect((await reportRow(wrapped))!.config).toMatchObject({ command_source: "recorded", command: "sharednet goal run TASK.md --agent codex:gpt-6-luna --until 'after: 3m'" });

    // Settings without the arguments: the command is still rebuilt, and says where its extras came from.
    const settled = join(root, "settled");
    await writeRecord(settled, {}, { "launch-settings.json": JSON.stringify({ task: "Widget_001", arm: "baseline", effort: "medium", budget: "2M tokens", cli_commit: "acd90e43854a0b1081a7bce77cdb7f2d4f697241" }) });
    const fromSettings = (await reportRow(settled))!;
    expect(fromSettings.config).toMatchObject({ command_source: "launch settings", reasoning_effort: "medium", launcher: { task: "Widget_001", arm: "baseline", effort: "medium", budget: "2M tokens", cli_commit: "acd90e4385" } });
    expect(fromSettings.config.command).toContain(" --reasoning-effort medium --until ");
  });

  it("keeps Room content and keys out of a row", async () => {
    const root = await temporary();
    const directory = join(root, "said");
    await writeRecord(directory, {
      ended_by: { at: "2026-11-27T10:30:00.000Z", trigger: "said /DONE/", detail: "DONE. The customer list is in /home/ada/private/customers.csv and the plan is to undercut them by ten percent." },
      launch: { argv: ["goal", "run", "TASK.md", "--agent", "codex", "--model-api", "https://models.example/v1", "--until", `check curl -H 'authorization: Bearer ${FAKE_MODEL_KEY}' https://models.example/ok`] },
    });
    const row = (await reportRow(directory))!;
    expect(row.performance).toMatchObject({ outcome: "declared", ended_by: "said /DONE/", detail: null });
    expect(JSON.stringify(row)).not.toContain(FAKE_MODEL_KEY);
    expect(JSON.stringify(row)).not.toContain("customers");
    // A bare marker is not content.
    await writeRecord(directory, { ended_by: { at: "2026-11-27T10:30:00.000Z", trigger: "said /^DONE$/", detail: "DONE" } });
    expect((await reportRow(directory))!.performance.detail).toBe("DONE");
    expect(cleanReportText(`key ${FAKE_OWNER_KEY} in /Users/ada/Desktop/notes/run/out.txt`)).toBe("key ‹redacted› in …/run/out.txt");
    expect(cleanReportText("task-mention-gates stays whole")).toBe("task-mention-gates stays whole");
  });

  it("names how a run ended, takes a score given with it, and reads a watch-only record", async () => {
    expect(reportOutcome("check bash check.sh", null)).toBe("passed");
    expect(reportOutcome("said /^DONE$/", null)).toBe("declared");
    for (const trigger of ["budget 5M tokens", "after 45m", "at 2026-10-30T06:01:02+00:00", "idle 2h", "count 3"]) expect(reportOutcome(trigger, false)).toBe("stopped");
    expect(reportOutcome("owner", null)).toBe("closed");
    expect(reportOutcome(undefined, null)).toBe("unknown");
    expect(reportOutcome(undefined, true)).toBe("passed");

    const root = await temporary();
    const scored = join(root, "scored");
    await writeRecord(scored, {}, { "score.json": JSON.stringify({ benchmark: "programbench", pass_fraction: 0.25 }) });
    const row = (await reportRow(scored, { score: { name: "hidden tests passed", value: 0.22 } }))!;
    expect(row.performance.scores).toEqual([
      { name: "hidden tests passed", value: 0.22, source: "given with the report" },
      { name: "ProgramBench hidden tests passed", value: 0.25, scale: "fraction 0–1", source: "score.json" },
    ]);
    expect(row.performance).toMatchObject({ metric_name: "hidden tests passed", metric_value: 0.22 });
    expect(parseReportScore("hidden tests passed = 0.22")).toEqual({ name: "hidden tests passed", value: 0.22 });
    expect(() => parseReportScore("0.22")).toThrow(/a name and a number/);
    expect(() => parseReportScore("score=")).toThrow(/a name and a number/);

    // `goal watch` writes no agents: the people's own agents were not the runner's to measure.
    const watched = join(root, "watched");
    await mkdir(watched);
    await writeFile(join(watched, "episode.json"), JSON.stringify({ schema_version: 1, room_id: ROOM, goal: { sequence: 1, until: ["after 1h"], started_at: "2026-11-27T10:00:00.000Z" }, ended_by: { at: "2026-11-27T11:00:00.000Z", trigger: "after 1h", detail: null }, runner: {}, totals: { messages: 4, checks: 0, snapshots: 1 } }));
    const bare = (await reportRow(watched))!;
    expect(bare.metrics).toMatchObject({ duration_s: 3600, n_agents: 0, turns: null, tokens_fresh: null, tokens_cached: null, agent_busy_s: null, checks: 0, checks_passed: 0 });
    expect(bare.performance.outcome).toBe("stopped");
    expect(await reportRow(root)).toBeNull();
  });
});

describe("where the rows go", () => {
  it("finds records under a folder without entering workspaces or agents' homes", async () => {
    const root = await temporary();
    await writeRecord(join(root, "runs", "a"));
    await writeRecord(join(root, "runs", "b", "record"));
    await writeRecord(join(root, "runs", "a", "agents", "codex-1", "home", "old-run"));
    await writeRecord(join(root, "runs", "c", "workspace", "runs", "inner"));
    expect(await findRecords(root)).toEqual([join(root, "runs", "a"), join(root, "runs", "b", "record")]);
    expect(await findRecords(join(root, "runs", "a"))).toEqual([join(root, "runs", "a")]);
    expect(await findRecords(join(root, "nothing-here"))).toEqual([]);
  });

  it("writes one file a run into a directory", async () => {
    const root = await temporary();
    await writeRecord(join(root, "one"));
    await writeRecord(join(root, "next"), { goal: { sequence: 41, until: ["after 1h"], started_at: "2026-11-27T11:00:00.000Z" } });
    const rows = [(await reportRow(join(root, "one")))!, (await reportRow(join(root, "next")))!];
    const delivery = await deliverReport(rows, "inbox", { fetch: (async () => { throw new Error("a directory needs no request"); }) as unknown as typeof globalThis.fetch, env: {}, cwd: root });
    expect(delivery).toEqual({ to: join(root, "inbox"), kind: "directory", delivered: 2 });
    // The next goal of the same Room is its own row and its own file.
    expect((await readdir(join(root, "inbox"))).sort()).toEqual([`${ROOM}.json`, `${ROOM}@41.json`]);
    expect(JSON.parse(await readFile(join(root, "inbox", `${ROOM}.json`), "utf8"))).toMatchObject({ id: ROOM, schema: 2 });
  });

  it("posts rows to a URL with the report's own token, and never the account's key", async () => {
    const root = await temporary();
    await writeRecord(join(root, "one"));
    const row = (await reportRow(join(root, "one")))!;
    const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const delivery = await deliverReport([row], "https://scaling.example/api/runs", { fetch, env: { SHAREDNET_REPORT_TOKEN: "report-token-synthetic", SHAREDNET_API_KEY: FAKE_OWNER_KEY }, cwd: root });
    expect(delivery).toEqual({ to: "https://scaling.example/api/runs", kind: "url", delivered: 1 });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers).toEqual({ "content-type": "application/json", authorization: "Bearer report-token-synthetic" });
    expect(requests[0]!.body).toMatchObject({ schema: 2, rows: [{ id: ROOM }] });
    expect(JSON.stringify(requests)).not.toContain(FAKE_OWNER_KEY);
    // Without a token nothing is invented, and a refusal says how far it got.
    await deliverReport([row], "http://127.0.0.1:8787/runs", { fetch, env: {}, cwd: root });
    expect(requests[1]!.headers).toEqual({ "content-type": "application/json" });
    const refusing = (async () => new Response("no", { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(deliverReport([row], "https://scaling.example/api/runs", { fetch: refusing, env: {}, cwd: root })).rejects.toMatchObject({ code: "report_not_delivered", message: "https://scaling.example answered 403; 0 of 1 rows were delivered." });
  });

  it("sends rows to the SharedNet service's catalogue by the account's own key, in batches, with the Room's address as the trace", async () => {
    const root = await temporary();
    const rows = [];
    for (let index = 0; index < 60; index += 1) {
      await writeRecord(join(root, `r${index}`), { room_id: `rom_${String(index).padStart(10, "0")}` });
      rows.push((await reportRow(join(root, `r${index}`)))!);
    }
    const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let keyReads = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return Response.json({ board: "user_team", saved: 1 });
    }) as typeof globalThis.fetch;
    const service = { baseUrl: "https://www.sharednet.ai", apiKey: async () => { keyReads += 1; return FAKE_OWNER_KEY; } };
    const delivery = await deliverReport(rows, "sharednet", { fetch, env: { SHAREDNET_REPORT_TOKEN: "report-token-synthetic" }, cwd: root, service });
    // The service says which catalogue took them; with none named, that is the one this account may add to.
    expect(delivery).toEqual({ to: "sharednet:user_team", kind: "sharednet", delivered: 60 });
    expect(requests.map((request) => [request.url, request.body.rows.length, request.body.board])).toEqual([["https://www.sharednet.ai/api/scaling/runs", 50, undefined], ["https://www.sharednet.ai/api/scaling/runs", 10, undefined]]);
    expect(requests[0]!.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${FAKE_OWNER_KEY}` });
    expect(JSON.stringify(requests)).not.toContain("report-token-synthetic");
    expect(keyReads).toBe(1);
    expect(requests[0]!.body.rows[0].trace).toMatchObject({ url: "https://www.sharednet.ai/chat?room=rom_0000000000", url_kind: "room" });
    // A named catalogue is asked for; a trace link somebody set is left alone.
    const one = { ...rows[0]!, trace: { ...rows[0]!.trace, url: "https://traces.example/1" } };
    await deliverReport([one], "sharednet:me", { fetch, env: {}, cwd: root, service });
    expect(requests.at(-1)!.body).toMatchObject({ board: "me", rows: [{ trace: { url: "https://traces.example/1" } }] });
    // A refusal carries what the service said, and how far the report got.
    const refusing = (async () => Response.json({ error: { code: "read_only", message: "This catalogue is shared with you to read. Ask its owner to let you add runs." } }, { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(deliverReport([one], "sharednet:user_other", { fetch: refusing, env: {}, cwd: root, service })).rejects.toMatchObject({ code: "report_not_delivered", exitCode: 3, message: "SharedNet answered 403; This catalogue is shared with you to read. Ask its owner to let you add runs. 0 of 1 rows were delivered." });
    expect(reportTarget("sharednet", "/tmp")).toEqual({ kind: "sharednet", board: null });
    expect(reportTarget("sharednet:me", "/tmp")).toEqual({ kind: "sharednet", board: "me" });
    expect(() => reportTarget("sharednet:../x y", "/tmp")).toThrow(/names a catalogue by its id/);
    // A folder called sharednet is still a folder when it is written as a path.
    expect(reportTarget("./sharednet", "/srv")).toEqual({ kind: "directory", path: "/srv/sharednet" });
  });

  it("reads rows that were already made, from a file or a folder of them, and refuses what is not one", async () => {
    const root = await temporary();
    await writeRecord(join(root, "one"));
    await writeRecord(join(root, "two"), { room_id: "rom_ZyXwVuTsRq" });
    const rows = [(await reportRow(join(root, "one")))!, (await reportRow(join(root, "two")))!];
    await deliverReport(rows, "inbox", { fetch: (async () => { throw new Error("no request"); }) as unknown as typeof globalThis.fetch, env: {}, cwd: root });
    expect((await readRows(join(root, "inbox"))).map((row) => row.id).sort()).toEqual([ROOM, "rom_ZyXwVuTsRq"].sort());
    await writeFile(join(root, "all.json"), JSON.stringify({ rows }));
    expect(await readRows(join(root, "all.json"))).toHaveLength(2);
    await writeFile(join(root, "array.json"), JSON.stringify(rows));
    expect(await readRows(join(root, "array.json"))).toHaveLength(2);
    await writeFile(join(root, "bad.json"), JSON.stringify([{ schema: 1, room_id: ROOM }]));
    await expect(readRows(join(root, "bad.json"))).rejects.toThrow(/not a row/);
    await expect(readRows(join(root, "missing.json"))).rejects.toThrow(/not a file or a directory/);
  });

  it("refuses a place that would send a report in the clear or carry a password", () => {
    expect(() => reportTarget("http://scaling.example/runs", "/tmp")).toThrow(/https, or http on this machine only/);
    expect(() => reportTarget("https://ada:secret@scaling.example/runs", "/tmp")).toThrow(/SHAREDNET_REPORT_TOKEN/);
    expect(reportTarget("http://localhost:8787/runs", "/tmp").kind).toBe("url");
    expect(reportTarget("inbox", "/srv/scaling")).toEqual({ kind: "directory", path: "/srv/scaling/inbox" });
  });

  it("keeps a launch's arguments as given, without what a URL should not carry", () => {
    expect(launchArguments(["goal", "run", "TASK.md", "--model-api", "https://ada:secret@models.example/v1?key=abc", "--until", "after: 1h"])).toEqual(["goal", "run", "TASK.md", "--model-api", "https://models.example/v1", "--until", "after: 1h"]);
    expect(launchCommandLine(["node", "/opt/client/bin/sharednet.js", "--session", "i_AbCdEfGhIj", "goal", "run", "TASK.md", "--agent", "codex", "--agent", "codex", "--agent", "claude-code:claude-sonnet-5-5"])).toBe("sharednet goal run TASK.md --agent codex ×2 --agent claude-code:claude-sonnet-5-5");
  });
});

describe("goal report on the command line", () => {
  async function cli(argv: string[], cwd: string, env: Record<string, string> = {}, fetch?: typeof globalThis.fetch) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let requests = 0;
    const exitCode = await runCli(argv, {
      cwd,
      env: { HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config"), XDG_STATE_HOME: join(cwd, "state"), ...env },
      fetch: fetch ?? ((async () => { requests += 1; throw new Error("nothing may be sent"); }) as unknown as typeof globalThis.fetch),
      now: () => new Date(AT),
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    });
    return { exitCode, stdout: stdout.join(""), stderr: stderr.join(""), requests };
  }

  it("prints rows without signing in, and searches a folder for records", async () => {
    const root = await temporary();
    await writeRecord(join(root, "runs", "a"));
    await writeRecord(join(root, "runs", "b"), { room_id: "rom_ZyXwVuTsRq" });
    const printed = await cli(["goal", "report", "runs", "--experiment", "widget-scaling", "--tag", "pilot, n2", "--json"], root);
    expect(printed.exitCode).toBe(0);
    expect(printed.requests).toBe(0);
    const payload = JSON.parse(printed.stdout);
    expect(payload.schema).toBe(2);
    expect(payload.rows.map((row: any) => [row.id, row.title, row.family, row.tags])).toEqual([
      [ROOM, "a", "widget-scaling", ["pilot", "n2"]],
      ["rom_ZyXwVuTsRq", "b", "widget-scaling", ["pilot", "n2"]],
    ]);
  });

  it("hands rows to --to, and says what it cannot do", async () => {
    const root = await temporary();
    await writeRecord(join(root, "runs", "a"));
    const delivered = await cli(["goal", "report", "runs/a", "--to", "inbox", "--score", "hidden tests passed=0.5", "--json"], root);
    expect(delivered.exitCode).toBe(0);
    expect(JSON.parse(delivered.stdout)).toEqual({ reported: 1, to: join(root, "inbox"), rooms: [ROOM] });
    expect(JSON.parse(await readFile(join(root, "inbox", `${ROOM}.json`), "utf8")).performance).toMatchObject({ metric_name: "hidden tests passed", metric_value: 0.5 });

    const nothing = await cli(["goal", "report", "inbox"], root);
    expect(nothing.exitCode).toBe(2);
    expect(nothing.stderr).toContain("holds no goal record");
    const clear = await cli(["goal", "report", "runs/a", "--to", "http://scaling.example/runs"], root);
    expect(clear.exitCode).toBe(2);
    expect(clear.stderr).toContain("not sent in the clear");
    await writeRecord(join(root, "runs", "b"), { room_id: "rom_ZyXwVuTsRq" });
    const two = await cli(["goal", "report", "runs", "--score", "x=1"], root);
    expect(two.stderr).toContain("--score belongs to one run");
  });

  it("reports to the service with --to sharednet by the key in the environment, and hands on rows with --rows", async () => {
    const root = await temporary();
    await writeRecord(join(root, "runs", "a"));
    const requests: Array<{ url: string; auth: string | undefined; rows: number }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), auth: (init?.headers as Record<string, string>).authorization, rows: JSON.parse(String(init?.body)).rows.length });
      return Response.json({ board: "user_ann", saved: 1 });
    }) as typeof globalThis.fetch;
    const env = { SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_API_KEY: FAKE_OWNER_KEY };
    const sent = await cli(["goal", "report", "runs/a", "--to", "sharednet", "--json"], root, env, fetch);
    expect(sent.exitCode).toBe(0);
    expect(JSON.parse(sent.stdout)).toEqual({ reported: 1, to: "sharednet:user_ann", rooms: [ROOM] });
    expect(requests).toEqual([{ url: "http://127.0.0.1:3001/api/scaling/runs", auth: `Bearer ${FAKE_OWNER_KEY}`, rows: 1 }]);
    expect(sent.stdout + sent.stderr).not.toContain(FAKE_OWNER_KEY);
    // A folder that collected rows elsewhere is handed on whole.
    await cli(["goal", "report", "runs/a", "--to", "inbox", "--json"], root);
    const handed = await cli(["goal", "report", "--rows", "inbox", "--to", "sharednet:me", "--json"], root, env, fetch);
    expect(JSON.parse(handed.stdout)).toMatchObject({ reported: 1, rooms: [ROOM] });
    expect((await cli(["goal", "report", "--rows", "inbox"], root)).stderr).toContain("say where with --to");
    // Without a key there is nothing to send with, and nothing is sent.
    const before = requests.length;
    const signedOut = await cli(["goal", "report", "runs/a", "--to", "sharednet", "--json"], root, { SHAREDNET_BASE_URL: "http://127.0.0.1:3001" }, fetch);
    expect(signedOut.exitCode).not.toBe(0);
    expect(requests.length).toBe(before);
  });

  it("refuses --report on goal run before anything is sent when the place cannot be used", async () => {
    const root = await temporary();
    await writeFile(join(root, "TASK.md"), "Build the widget.\n");
    const run = ["goal", "run", "TASK.md", "--agent", "codex", "--until", "after: 1h"];
    const clear = await cli([...run, "--report", "http://scaling.example/runs"], root, { SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_API_KEY: FAKE_OWNER_KEY });
    expect(clear.exitCode).toBe(2);
    expect(clear.stderr).toContain("not sent in the clear");
    expect(clear.requests).toBe(0);
    const everyRun = await cli(run, root, { SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_API_KEY: FAKE_OWNER_KEY, SHAREDNET_REPORT_TO: "https://ada:secret@scaling.example/runs" });
    expect(everyRun.exitCode).toBe(2);
    expect(everyRun.stderr).toContain("SHAREDNET_REPORT_TOKEN");
    const alone = await cli([...run, "--experiment", "widget-scaling"], root, { SHAREDNET_BASE_URL: "http://127.0.0.1:3001", SHAREDNET_API_KEY: FAKE_OWNER_KEY });
    expect(alone.stderr).toContain("it goes with --report");
    expect(alone.requests).toBe(0);
  });
});
