// @vitest-environment node

import { describe, expect, it } from "vitest";

import { detectRuntime, runtimeMetadataOf } from "./runtime-detection.ts";

const noParent = { parentProcess: () => null, ancestorDriver: () => null };

describe("driver detection", () => {
  it("recognises Claude Code from its own environment, with session, version, and entrypoint", () => {
    const detected = detectRuntime(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_SESSION_ID: "47d416d8-cff5-423d-bb11-0c96500f7830",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDE_AGENT_SDK_VERSION: "0.3.260",
      },
      noParent,
    );
    expect(detected).toEqual({
      kind: "claude-code",
      anchor: "47d416d8-cff5-423d-bb11-0c96500f7830",
      version: "0.3.260",
      entrypoint: "claude-desktop",
      source: "detected",
    });
    expect(runtimeMetadataOf(detected)).toEqual({
      runtime_source: "detected",
      driver_version: "0.3.260",
      entrypoint: "claude-desktop",
    });
  });

  it("still honours the older CLAUDE_SESSION_ID anchor", () => {
    expect(detectRuntime({ CLAUDE_SESSION_ID: "legacy" }, noParent)).toMatchObject({
      kind: "claude-code",
      anchor: "legacy",
    });
  });

  it("recognises Codex, treats the thread id as lineage only, and names exec as the entrypoint", () => {
    expect(
      detectRuntime(
        { CODEX_SESSION_ID: "session-a", CODEX_THREAD_ID: "thread", CODEX_CI: "1" },
        noParent,
      ),
    ).toEqual({ kind: "codex", anchor: "session-a", version: null, entrypoint: "exec", source: "detected" });
    expect(detectRuntime({ CODEX_THREAD_ID: "thread" }, noParent).kind).toBe("custom");
  });

  it("recognises the other documented drivers by their variable prefixes", () => {
    expect(detectRuntime({ OPENCODE_SESSION_ID: "s1" }, noParent)).toMatchObject({ kind: "opencode", anchor: "s1" });
    expect(detectRuntime({ OPENHANDS_CONVERSATION_ID: "c1" }, noParent)).toMatchObject({ kind: "openhands", anchor: "c1" });
    expect(detectRuntime({ GEMINI_CLI: "1" }, noParent)).toMatchObject({ kind: "gemini-cli", anchor: null });
    expect(detectRuntime({ CURSOR_TRACE_ID: "t1" }, noParent)).toMatchObject({ kind: "cursor", anchor: "t1" });
  });

  it("falls back to the parent process name, and to custom when nothing matches", () => {
    expect(detectRuntime({}, { parentProcess: () => "codex" })).toEqual({
      kind: "codex",
      anchor: null,
      version: null,
      entrypoint: null,
      source: "detected",
    });
    expect(detectRuntime({}, { parentProcess: () => "claude" }).kind).toBe("claude-code");
    expect(detectRuntime({}, { parentProcess: () => "zsh" })).toEqual({
      kind: "custom",
      anchor: null,
      version: null,
      entrypoint: null,
      source: "declared",
      unrecognisedParent: "zsh",
    });
    expect(runtimeMetadataOf(detectRuntime({}, noParent))).toEqual({ runtime_source: "declared" });
  });

  it("recognises Hermes from the markers it re-exports into every command", () => {
    expect(
      detectRuntime({ HERMES_AGENT: "true", HERMES_SESSION_ID: "s-hermes" }, noParent),
    ).toMatchObject({ kind: "hermes", anchor: "s-hermes" });

    // AI_AGENT is a cross-harness name, so only its Hermes value counts.
    expect(detectRuntime({ AI_AGENT: "hermes-agent" }, noParent)).toMatchObject({
      kind: "hermes",
      anchor: null,
    });
    expect(detectRuntime({ AI_AGENT: "some-other-harness" }, noParent).kind).toBe("custom");
  });

  it("recognises OpenClaw from its variable prefix and the session key it hands an MCP server", () => {
    expect(
      detectRuntime({ OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY: "k1" }, noParent),
    ).toMatchObject({ kind: "openclaw", anchor: "k1" });
    expect(detectRuntime({ OPENCLAW_STATE_DIR: "/tmp/state" }, noParent)).toMatchObject({
      kind: "openclaw",
      anchor: null,
    });
  });

  it("recognises both new drivers by process name too", () => {
    expect(detectRuntime({}, { parentProcess: () => "openclaw" }).kind).toBe("openclaw");
    expect(detectRuntime({}, { parentProcess: () => "hermes" }).kind).toBe("hermes");
    expect(detectRuntime({}, { parentProcess: () => "hermes-agent" }).kind).toBe("hermes");
  });

  it("reports the name of a driver it could not place, so the gap is a query", () => {
    // The whole point: an unrecognised driver names itself instead of
    // disappearing into `custom` and taking the evidence with it.
    const unknown = detectRuntime({}, { parentProcess: () => "some-new-agent" });
    expect(unknown.kind).toBe("custom");
    expect(runtimeMetadataOf(unknown)).toEqual({
      runtime_source: "declared",
      parent_process: "some-new-agent",
    });

    // Nothing to report when the name cannot be read at all.
    expect(runtimeMetadataOf(detectRuntime({}, noParent))).toEqual({ runtime_source: "declared" });
  });

  it("keeps a parent process name printable and bounded, like every other reported string", () => {
    const noisy = detectRuntime({}, { parentProcess: () => `a\u0007${"b".repeat(90)}` });
    expect(runtimeMetadataOf(noisy).parent_process).toHaveLength(64);
    expect(runtimeMetadataOf(noisy).parent_process).not.toContain("\u0007");
  });

  it("lets a driver with its own session id outrank inherited markers, and the process tree break ties", () => {
    // Codex spawned inside a Claude Code session inherits Claude's markers.
    const inherited = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CODEX_SESSION_ID: "s-codex" };
    expect(detectRuntime(inherited, noParent)).toMatchObject({ kind: "codex", anchor: "s-codex" });

    // Both expose a session id: whichever driver is nearest in the process tree wins.
    const both = { CLAUDE_CODE_SESSION_ID: "s-claude", CODEX_SESSION_ID: "s-codex" };
    expect(detectRuntime(both, { ...noParent, ancestorDriver: () => "claude-code" })).toMatchObject({
      kind: "claude-code",
      anchor: "s-claude",
    });
    expect(detectRuntime(both, { ...noParent, ancestorDriver: () => "codex" })).toMatchObject({
      kind: "codex",
      anchor: "s-codex",
    });
    // With no tree to consult, Codex's per-exec id is the safer guess.
    expect(detectRuntime(both, noParent).kind).toBe("codex");
  });

  it("keeps reported strings printable and bounded", () => {
    const detected = detectRuntime(
      { CLAUDECODE: "1", CLAUDE_AGENT_SDK_VERSION: `v\0${"9".repeat(80)}` },
      noParent,
    );
    expect(detected.version).toHaveLength(64);
    expect(detected.version).not.toContain("\0");
  });
});
