// @vitest-environment node

import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPendingReply, readPendingReply, writePendingReply, type PendingReply } from "./reply-outbox.ts";
import { getStoragePaths } from "./storage.ts";
import * as secureStorage from "./storage.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sharednet-reply-outbox-test-"));
  roots.push(root);
  const paths = getStoragePaths({ HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") });
  const reply: PendingReply = {
    schema_version: 1,
    created_at: "2026-11-10T03:00:00.000Z",
    base_url: "https://www.sharednet.ai",
    room_id: "rom_AbCdEfGhIj",
    member_id: "i_AbCdEfGhIj",
    from: 1,
    through: 3,
    content: "Synthetic reply: 已处理\nKeep these bytes.",
    idempotency_key: "a4a3ee44-bba2-4e5b-b9ed-596dfe048352",
  };
  const directory = join(paths.roomsDir, reply.room_id);
  const file = join(directory, `${reply.member_id}.reply-outbox.json`);
  return { root, paths, reply, directory, file };
}

describe("durable native reply outbox", () => {
  it("surfaces disk-write failures as a terminal seat error rather than retrying its native turn", async () => {
    const { paths, reply } = await fixture();
    vi.spyOn(secureStorage, "writeSecureJson").mockRejectedValueOnce(Object.assign(new Error("synthetic disk full"), { code: "ENOSPC" }));
    await expect(writePendingReply(paths, reply)).rejects.toMatchObject({ code: "reply_storage_failed", exitCode: 2 });
  });

  it("has no pending delivery before a turn and tolerates clearing an absent file", async () => {
    const { paths, reply } = await fixture();
    expect(await readPendingReply(paths, reply)).toBeNull();
    await clearPendingReply(paths, reply);
    expect(await readPendingReply(paths, reply)).toBeNull();
  });

  it("keeps exact reply bytes and its stable delivery key in owner-only storage", async () => {
    const { paths, reply, directory, file } = await fixture();
    await writePendingReply(paths, reply);
    expect(await readPendingReply(paths, reply)).toEqual(reply);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(reply);
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(paths.roomsDir)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["i_AbCdEfGhIj.reply-outbox.json"]);
  });

  it("persists a committed receipt without changing the pending reply and clears only that seat", async () => {
    const { paths, reply } = await fixture();
    const other = { ...reply, member_id: "i_ZyXwVuTsRq", content: null };
    await writePendingReply(paths, reply);
    await writePendingReply(paths, other);
    const committed = { ...reply, committed: { id: "msg_AbCdEfGhIj", sequence: 4 } };
    await writePendingReply(paths, committed);
    expect(await readPendingReply(paths, reply)).toEqual(committed);
    await clearPendingReply(paths, reply);
    expect(await readPendingReply(paths, reply)).toBeNull();
    expect(await readPendingReply(paths, other)).toEqual(other);
  });

  it("accepts the exact message byte limit, including multibyte content", async () => {
    const { paths, reply } = await fixture();
    const full = { ...reply, content: "é".repeat(16_384) };
    await writePendingReply(paths, full);
    expect((await readPendingReply(paths, reply))?.content).toBe(full.content);
    await expect(writePendingReply(paths, { ...full, content: `${full.content}x` })).rejects.toMatchObject({ code: "invalid_reply_outbox" });
    expect(await readPendingReply(paths, reply)).toEqual(full);
  });

  it.each([
    ["invalid JSON", "{"],
    ["non-object", "[]"],
    ["unsupported schema", { schema_version: 2 }],
    ["missing creation time", { created_at: undefined }],
    ["non-ISO creation time", { created_at: "1" }],
    ["invalid creation time", { created_at: "2026-13-10T03:00:00.000Z" }],
    ["negative cursor", { from: -1 }],
    ["fractional cursor", { through: 3.5 }],
    ["inverted range", { from: 4, through: 3 }],
    ["unsafe integer", { through: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing content", { content: undefined }],
    ["non-string content", { content: 3 }],
    ["empty content", { content: "" }],
    ["empty key", { idempotency_key: "" }],
    ["header control character", { idempotency_key: "key\nsecret" }],
    ["invalid origin", { base_url: "https://example.test/path" }],
    ["invalid Room ID", { room_id: "../escape" }],
    ["invalid member ID", { member_id: "../escape" }],
    ["malformed receipt", { committed: { id: "msg_AbCdEfGhIj", sequence: 0 } }],
    ["stale receipt", { committed: { id: "msg_AbCdEfGhIj", sequence: 3 } }],
    ["missing receipt id", { committed: { sequence: 4 } }],
    ["invalid receipt id", { committed: { id: "room_AbCdEfGhIj", sequence: 4 } }],
  ])("refuses %s rather than silently dropping pending work", async (_label, patch) => {
    const f = await fixture();
    await mkdir(f.directory, { recursive: true, mode: 0o700 });
    const raw = typeof patch === "string" ? patch : JSON.stringify({ ...f.reply, ...patch });
    await writeFile(f.file, raw, { mode: 0o600 });
    await expect(readPendingReply(f.paths, f.reply)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
    expect(await readFile(f.file, "utf8")).toBe(raw);
  });

  it.each([
    { base_url: "https://other.example.test" },
    { room_id: "rom_ZyXwVuTsRq" },
    { member_id: "i_ZyXwVuTsRq" },
  ])("binds pending state to the requested seat: %j", async (patch) => {
    const { paths, reply, file } = await fixture();
    await writePendingReply(paths, reply);
    await writeFile(file, JSON.stringify({ ...reply, ...patch }), { mode: 0o600 });
    await expect(readPendingReply(paths, reply)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
    await expect(clearPendingReply(paths, reply)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
  });

  it("uses the existing canonical origin rules", async () => {
    const { paths, reply } = await fixture();
    await writePendingReply(paths, reply);
    expect(await readPendingReply(paths, { ...reply, base_url: "https://sharednet.ai/" })).toEqual(reply);
  });

  it.each(["room_id", "member_id"] as const)("rejects traversal in a requested %s before touching files", async (field) => {
    const { paths, reply } = await fixture();
    const invalid = { ...reply, [field]: "../outside" };
    await expect(readPendingReply(paths, invalid)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
    await expect(writePendingReply(paths, invalid)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
    await expect(clearPendingReply(paths, invalid)).rejects.toMatchObject({ code: "invalid_reply_outbox" });
  });

  it("refuses symlink files without following or unlinking them", async () => {
    const { paths, reply, directory, file, root } = await fixture();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(root, "untouched.txt");
    await writeFile(target, "private synthetic bytes", { mode: 0o600 });
    await symlink(target, file);
    for (const act of [() => readPendingReply(paths, reply), () => writePendingReply(paths, reply), () => clearPendingReply(paths, reply)]) {
      await expect(act()).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    }
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("private synthetic bytes");
  });

  it("refuses a symlink Room directory even when its target is owner-only", async () => {
    const { paths, reply, directory, root } = await fixture();
    await mkdir(paths.roomsDir, { recursive: true, mode: 0o700 });
    const target = join(root, "other-room");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, directory);
    for (const act of [() => readPendingReply(paths, reply), () => writePendingReply(paths, reply), () => clearPendingReply(paths, reply)]) {
      await expect(act()).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    }
    expect(await readdir(target)).toEqual([]);
  });

  it("refuses permissive pending files and directories", async () => {
    const { paths, reply, file, directory } = await fixture();
    await writePendingReply(paths, reply);
    await chmod(file, 0o644);
    await expect(readPendingReply(paths, reply)).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    await expect(clearPendingReply(paths, reply)).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    await chmod(file, 0o600);
    await chmod(directory, 0o755);
    await expect(readPendingReply(paths, reply)).rejects.toMatchObject({ code: "unsafe_credential_storage" });
    await expect(writePendingReply(paths, reply)).rejects.toMatchObject({ code: "unsafe_credential_storage" });
  });
});
