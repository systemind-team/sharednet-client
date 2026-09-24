import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../packages/cli/src/cli.ts";
import { getStoragePaths, writeProjectRoomState, writeRoomCredential } from "../packages/cli/src/storage.ts";

const document = await readFile(new URL("../skills/sharednet-room/references/retrieval.md", import.meta.url), "utf8");
const commands = [...document.matchAll(/`sharednet read ([^`]+)`/g)]
  .map((match) => match[1]!)
  .filter((command) => !command.includes("--last K"));
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

it.each(commands)("the Skill's read example runs without consuming the wait cursor: %s", async (command) => {
  const cwd = await mkdtemp(join(tmpdir(), "sharednet-skill-"));
  scratch.push(cwd);
  const env = { HOME: cwd, XDG_CONFIG_HOME: join(cwd, "config"), XDG_STATE_HOME: join(cwd, "state") };
  const state = { schema_version: 1 as const, base_url: "https://service.example", room_id: "rom_AbCdEfGhIj", member_id: "i_AbCdEfGhIj", last_sequence: 7 };
  await writeProjectRoomState(cwd, state);
  await writeRoomCredential(getStoragePaths(env), {
    schema_version: 1, base_url: state.base_url, room_id: state.room_id, member_id: state.member_id,
    member_token: `sni_${"T".repeat(43)}`, name: "fixture", joined_at: "2026-09-25T00:00:00.000Z",
  });
  const before = await readFile(join(cwd, ".sharednet/room.json"), "utf8");
  const words = command.replaceAll("i_…", state.member_id).match(/'[^']*'|"[^"]*"|\S+/g)!;
  const argv = words.map((word) => /^["']/.test(word) ? word.slice(1, -1) : word);
  const stderr: string[] = [];
  const exit = await runCli(["read", ...argv, "--as", state.member_id], {
    cwd, env, stdout: () => {}, stderr: (text) => stderr.push(text),
    fetch: async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(state.base_url);
      expect(url.pathname).toBe(`/api/v1/rooms/${state.room_id}/messages`);
      return new Response(JSON.stringify({ items: [], next_cursor: null, has_more: false }), { headers: { "content-type": "application/json" } });
    },
  });
  expect(exit, stderr.join("")).toBe(0);
  expect(await readFile(join(cwd, ".sharednet/room.json"), "utf8")).toBe(before);
});
