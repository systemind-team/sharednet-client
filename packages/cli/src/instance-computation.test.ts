// @vitest-environment node

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeLocalInstanceKey,
  detectRuntimeSession,
} from "./instance-computation.ts";

describe("Instance Computation", () => {
  it("uses CODEX_SESSION_ID as the exact anchor and treats the thread id as lineage only", () => {
    const first = detectRuntimeSession({
      CODEX_SESSION_ID: "session-a",
      CODEX_THREAD_ID: "shared-thread",
    });
    const second = detectRuntimeSession({
      CODEX_SESSION_ID: "session-b",
      CODEX_THREAD_ID: "shared-thread",
    });

    expect(first).toEqual({ runtimeKind: "codex", anchor: "session-a" });
    expect(second).toEqual({ runtimeKind: "codex", anchor: "session-b" });
  });

  it("does not fall back to CODEX_THREAD_ID", () => {
    expect(
      detectRuntimeSession({ CODEX_THREAD_ID: "lineage-is-not-an-instance" }),
    ).toBeNull();
  });

  it("computes the specified HMAC without exposing the anchor", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    const expected = createHmac("sha256", Buffer.alloc(32, 7))
      .update("codex\0provider-session-raw")
      .digest("hex");

    const key = computeLocalInstanceKey(
      secret,
      "codex",
      "provider-session-raw",
    );

    expect(key).toBe(expected);
    expect(key).not.toContain("provider-session-raw");
  });

  it("gives four local Codex sessions four stable identities", () => {
    const secret = Buffer.alloc(32, 11).toString("base64url");
    const keys = ["a", "b", "c", "d"].map((anchor) =>
      computeLocalInstanceKey(secret, "codex", anchor),
    );

    expect(new Set(keys)).toHaveLength(4);
    expect(computeLocalInstanceKey(secret, "codex", "a")).toBe(keys[0]);
  });
});
