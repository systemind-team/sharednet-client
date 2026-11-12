// @vitest-environment node

import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  computeLocalInstanceKey,
  detectRuntimeSession,
} from "./instance-computation.ts";

describe("Instance Computation", () => {
  it("uses distinct executing threads under the same root session as exact anchors", () => {
    const first = detectRuntimeSession({
      CODEX_SESSION_ID: "shared-root",
      CODEX_THREAD_ID: "thread-a",
    });
    const second = detectRuntimeSession({
      CODEX_SESSION_ID: "shared-root",
      CODEX_THREAD_ID: "thread-b",
    });

    expect(first).toEqual({ runtimeKind: "codex", anchor: "thread-a" });
    expect(second).toEqual({ runtimeKind: "codex", anchor: "thread-b" });
  });

  it("recognises a Codex thread without a root session marker", () => {
    expect(
      detectRuntimeSession({ CODEX_THREAD_ID: "executing-thread" }),
    ).toEqual({ runtimeKind: "codex", anchor: "executing-thread" });
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

  it("keeps a root's existing HMAC and gives its children distinct stable HMACs", () => {
    const secret = Buffer.alloc(32, 17).toString("base64url");
    const key = (thread: string, call: string) => {
      const detected = detectRuntimeSession({ CODEX_SESSION_ID: "root", CODEX_THREAD_ID: thread, CODEX_TOOL_CALL_ID: call });
      expect(detected).not.toBeNull();
      return computeLocalInstanceKey(secret, detected!.runtimeKind, detected!.anchor);
    };
    expect(key("root", "call-a")).toBe(computeLocalInstanceKey(secret, "codex", "root"));
    expect(new Set([key("root", "call-a"), key("child-a", "call-b"), key("child-b", "call-c")]).size).toBe(3);
    expect(key("child-a", "call-d")).toBe(key("child-a", "call-b"));
  });
});
