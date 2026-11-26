// @vitest-environment node

import { createServer } from "node:net";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "./cli.ts";
import { parseLocalHost, parseLocalPort } from "./local.ts";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sandbox(): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), "sharednet-local-"));
  cleanup.push(root);
  return { HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), SHAREDNET_WAKE: "off" };
}

/** Starts `sharednet local` and resolves once it has said where it is. */
async function startLocal(env: Record<string, string>, args: string[] = []) {
  const controller = new AbortController();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let announced!: (value: { base_url: string; env_file: string; storage: string; host: string }) => void;
  const ready = new Promise<{ base_url: string; env_file: string; storage: string; host: string }>((resolve) => { announced = resolve; });
  const exit = runCli(["local", "--port", "0", "--json", ...args], {
    env,
    signal: controller.signal,
    stdout: (value) => {
      stdout.push(value);
      if (stdout.length === 1) announced(JSON.parse(value));
    },
    stderr: (value) => stderr.push(value),
  });
  const failedEarly = exit.then((code) => { throw new Error(`local exited ${code}: ${stderr.join("")}`); });
  return { info: await Promise.race([ready, failedEarly]), stop: () => controller.abort(), exit, stdout, stderr };
}

async function cli(argv: string[], env: Record<string, string>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli([...argv, "--json"], { env, stdout: (v) => stdout.push(v), stderr: (v) => stderr.push(v) });
  if (code !== 0) throw new Error(`sharednet ${argv.join(" ")} exited ${code}: ${stderr.join("")}`);
  return JSON.parse(stdout.join("")) as Record<string, any>;
}

describe("sharednet local", () => {
  it("serves the API in memory, hands its key over in an owner-only file, and removes the file on stop", async () => {
    const env = await sandbox();
    const local = await startLocal(env);
    expect(local.info).toMatchObject({ storage: "memory", host: "127.0.0.1" });
    expect(local.info.base_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(local.info.env_file).toBe(join(env.XDG_STATE_HOME!, "sharednet", "local", `${new URL(local.info.base_url).port}.env`));

    const file = await readFile(local.info.env_file, "utf8");
    expect((await stat(local.info.env_file)).mode & 0o777).toBe(0o600);
    const key = /^export SHAREDNET_API_KEY=(snk_[A-Za-z0-9_-]{43})$/m.exec(file)?.[1];
    expect(key).toBeDefined();
    expect(file).toContain(`export SHAREDNET_BASE_URL=${local.info.base_url}\n`);
    // The key reaches the file only, never the terminal.
    expect([...local.stdout, ...local.stderr].join("")).not.toContain(key);

    const owner = { ...env, SHAREDNET_BASE_URL: local.info.base_url, SHAREDNET_API_KEY: key! };
    const session = await cli(["session", "start", "--new"], owner);
    const { room } = await cli(["room", "create", "--name", "Local team", "--session", session.session_id], owner);
    expect(room.id).toMatch(/^rom_/);
    await cli(["room", "post", room.id, "--content", "hello from a local SharedNet", "--session", session.session_id], owner);
    const messages = await cli(["room", "messages", room.id, "--session", session.session_id], owner);
    expect(messages.items.map((message: { content: string }) => message.content)).toEqual(["hello from a local SharedNet"]);

    // An invite names this server, so an agent needs nothing but the join line.
    const invite = await cli(["room", "invite", room.id, "--session", session.session_id], owner);
    expect(invite.for_agents).toContain(`BASE=${local.info.base_url}`);

    local.stop();
    expect(await local.exit).toBe(0);
    expect(JSON.parse(local.stdout.at(-1)!)).toEqual({ stopped: true, base_url: local.info.base_url });
    await expect(stat(local.info.env_file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("holds a goal: the local key speaks as the Room's owner, so goal start sets the goal", async () => {
    const env = await sandbox();
    const local = await startLocal(env);
    const key = /^export SHAREDNET_API_KEY=(snk_[A-Za-z0-9_-]{43})$/m.exec(await readFile(local.info.env_file, "utf8"))![1]!;
    const owner = { ...env, SHAREDNET_BASE_URL: local.info.base_url, SHAREDNET_API_KEY: key };
    const goalFile = join(env.HOME!, "TASK.md");
    await writeFile(goalFile, "Say DONE.\n");
    const session = await cli(["session", "start", "--new"], owner);

    const started = await cli(["goal", "start", goalFile, "--until", "said: /^DONE$/", "--until", "after: 30m", "--session", session.session_id], owner);
    expect(started.room.goal).toMatchObject({ until: ["said /^DONE$/", "after 30m"], ended_by: null });
    expect(started.message.content).toBe("Say DONE.\n");

    local.stop();
    expect(await local.exit).toBe(0);
  });

  it("refuses a port that is already taken", async () => {
    const env = await sandbox();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    try {
      const port = (blocker.address() as { port: number }).port;
      const stderr: string[] = [];
      const code = await runCli(["local", "--port", String(port), "--json"], { env, stdout: () => undefined, stderr: (v) => stderr.push(v) });
      expect(code).not.toBe(0);
      expect(JSON.parse(stderr.join("")).error.code).toBe("local_port_in_use");
    } finally {
      blocker.close();
    }
  });

  it("takes only 127.0.0.1 or 0.0.0.0 and a port from 0 to 65535", () => {
    expect(parseLocalHost(undefined)).toBe("127.0.0.1");
    expect(parseLocalHost("0.0.0.0")).toBe("0.0.0.0");
    expect(() => parseLocalHost("192.168.1.2")).toThrow(/--host/);
    expect(parseLocalPort(undefined)).toBe(3001);
    expect(parseLocalPort("0")).toBe(0);
    for (const bad of ["-1", "65536", "3e3", "port"]) expect(() => parseLocalPort(bad)).toThrow(/--port/);
  });

  it("rejects options it does not take", async () => {
    const env = await sandbox();
    for (const argv of [["local", "--name", "x"], ["local", "extra"], ["local", "--session", "i_AbCdEfGhIj"]]) {
      const stderr: string[] = [];
      expect(await runCli([...argv, "--json"], { env, stdout: () => undefined, stderr: (v) => stderr.push(v) })).not.toBe(0);
      expect(JSON.parse(stderr.join("")).error.code).toMatch(/^invalid_|unknown_option/);
    }
  });
});
