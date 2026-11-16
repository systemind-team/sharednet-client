import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { resolveBaseUrl, sameOrigin } from "./api-client.ts";
import { CliError, localError } from "./errors.ts";
import { MAX_MESSAGE_BYTES } from "./protocol/index.ts";
import {
  ensureSecureDirectory,
  readSecureFile,
  writeSecureJson,
  type StoragePaths,
  type StoredRoomCredential,
} from "./storage.ts";

/** A finished native turn waiting for message commit and then cursor ACK. No credential is stored here. */
export interface PendingReply {
  schema_version: 1;
  created_at: string;
  base_url: string;
  room_id: string;
  member_id: string;
  from: number;
  through: number;
  content: string | null;
  idempotency_key: string;
  committed?: { id: string; sequence: number };
}

type Seat = Pick<StoredRoomCredential, "base_url" | "room_id" | "member_id">;

function invalidOutbox(): never {
  throw localError("invalid_reply_outbox", "The pending reply file is not valid for this SharedNet seat; it has been left in place.");
}

function validateSeat(seat: Seat): void {
  if (
    typeof seat.room_id !== "string" || !/^rom_[A-Za-z0-9]+$/.test(seat.room_id) ||
    typeof seat.member_id !== "string" || !/^(?:i|mem)_[A-Za-z0-9]+$/.test(seat.member_id) ||
    typeof seat.base_url !== "string"
  ) invalidOutbox();
  try {
    resolveBaseUrl(seat.base_url);
  } catch {
    invalidOutbox();
  }
}

function outboxPath(paths: StoragePaths, seat: Seat): string {
  validateSeat(seat);
  return join(paths.roomsDir, seat.room_id, `${seat.member_id}.reply-outbox.json`);
}

/** Check every directory we own before following a path to a reply body. */
async function secureParents(paths: StoragePaths, seat: Seat, create: boolean): Promise<boolean> {
  for (const path of [paths.configDir, paths.roomsDir, join(paths.roomsDir, seat.room_id)]) {
    if (create) {
      await ensureSecureDirectory(path);
      continue;
    }
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (
      process.platform === "win32" || info.isSymbolicLink() || !info.isDirectory() ||
      info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0
    ) {
      throw localError("unsafe_credential_storage", "SharedNet local credential storage is not owner-only.");
    }
  }
  return true;
}

function parsePendingReply(value: unknown, seat: Seat): PendingReply {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalidOutbox();
  const reply = value as Record<string, unknown>;
  validateSeat(reply as unknown as Seat);
  if (
    reply.schema_version !== 1 ||
    typeof reply.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reply.created_at) ||
    !Number.isFinite(Date.parse(reply.created_at)) ||
    !sameOrigin(reply.base_url as string, seat.base_url) ||
    reply.room_id !== seat.room_id || reply.member_id !== seat.member_id ||
    !Number.isSafeInteger(reply.from) || (reply.from as number) < 0 ||
    !Number.isSafeInteger(reply.through) || (reply.through as number) < (reply.from as number) ||
    (reply.content !== null && (
      typeof reply.content !== "string" || reply.content.trim() === "" ||
      Buffer.byteLength(reply.content, "utf8") > MAX_MESSAGE_BYTES
    )) ||
    typeof reply.idempotency_key !== "string" || !/^[\x21-\x7e]+$/.test(reply.idempotency_key)
  ) invalidOutbox();
  const committed = reply.committed;
  if (committed !== undefined) {
    if (!committed || typeof committed !== "object" || Array.isArray(committed)) invalidOutbox();
    const receipt = committed as Record<string, unknown>;
    if (
      typeof receipt.id !== "string" || !/^msg_[A-Za-z0-9]+$/.test(receipt.id) ||
      !Number.isSafeInteger(receipt.sequence) || (receipt.sequence as number) <= (reply.through as number)
    ) invalidOutbox();
  }
  return {
    schema_version: 1,
    created_at: reply.created_at as string,
    base_url: reply.base_url as string,
    room_id: reply.room_id as string,
    member_id: reply.member_id as string,
    from: reply.from as number,
    through: reply.through as number,
    content: reply.content as string | null,
    idempotency_key: reply.idempotency_key as string,
    ...(committed === undefined ? {} : { committed: committed as PendingReply["committed"] }),
  };
}

/** Disk failures are terminal for this seat, not a reason to repeat native work or release
 * the listener's machine lock while other seats still run. Keep filesystem paths out of logs. */
async function withOutboxStorage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw localError("reply_storage_failed", "The native reply could not be stored or recovered safely; inspect its session and pending reply before restarting this seat.");
  }
}

export async function readPendingReply(paths: StoragePaths, seat: Seat): Promise<PendingReply | null> {
  return withOutboxStorage(async () => {
    const path = outboxPath(paths, seat);
    if (!(await secureParents(paths, seat, false))) return null;
    const raw = await readSecureFile(path);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      invalidOutbox();
    }
    return parsePendingReply(value, seat);
  });
}

export async function writePendingReply(paths: StoragePaths, reply: PendingReply): Promise<void> {
  return withOutboxStorage(async () => {
    const path = outboxPath(paths, reply);
    const checked = parsePendingReply(reply, reply);
    await secureParents(paths, reply, true);
    // Atomic file replacement synchronizes both the file and its parent directory.
    await writeSecureJson(path, checked);
  });
}

export async function clearPendingReply(paths: StoragePaths, seat: Seat): Promise<void> {
  return withOutboxStorage(async () => {
    const path = outboxPath(paths, seat);
    if (await readPendingReply(paths, seat) === null) return;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const directory = await open(dirname(path), constants.O_RDONLY | noFollow);
    try {
      await unlink(path);
      await directory.sync();
    } finally {
      await directory.close();
    }
  });
}
