import { spawnSync } from "node:child_process";
import { basename } from "node:path";

/**
 * Which coding-agent driver is running this CLI, read off the driver's own
 * environment. Everything here is diagnostic: it names the seat on the Web and
 * picks its icon, and the session anchor feeds the local Instance key. Nothing
 * is trusted for authorization.
 *
 * Markers verified on 2026-09-06 on macOS:
 *   Claude Code   CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT
 *                 (claude-desktop | cli), CLAUDE_AGENT_SDK_VERSION
 *   Codex CLI     CODEX_SESSION_ID, CODEX_THREAD_ID (lineage, not a session),
 *                 CODEX_CI=1 under `codex exec`; parent process is `codex`
 * The OpenCode, OpenHands, Gemini CLI and Cursor markers below are taken from
 * their documentation and not yet verified on a machine; the parent-process
 * fallback covers a driver whose variables differ.
 */

export type RuntimeSource = "detected" | "declared";

export interface DetectedRuntime {
  /** A handle such as `claude-code`; `custom` when nothing was recognised. */
  kind: string;
  /** The driver's exact session id, kept on this machine and only ever HMACed. */
  anchor: string | null;
  version: string | null;
  entrypoint: string | null;
  source: RuntimeSource;
  /**
   * The parent process name when nothing matched at all. Detection can only
   * recognise drivers someone wrote down, so the unrecognised ones used to
   * vanish into `custom` and take the evidence with them. Reporting the name
   * turns "which drivers are we missing?" from a guess into a query over
   * `runtime_metadata`. Absent whenever detection succeeded.
   */
  unrecognisedParent?: string | null;
}

type Environment = Record<string, string | undefined>;

const RUNTIME_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

function nonEmpty(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const printable = value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 64);
  return printable.length > 0 ? printable : null;
}

function hasPrefix(env: Environment, prefix: string): boolean {
  return Object.keys(env).some((key) => key.startsWith(prefix) && nonEmpty(env[key]) !== null);
}

const PARENT_PROCESS_KINDS: Record<string, string> = {
  claude: "claude-code",
  codex: "codex",
  opencode: "opencode",
  openhands: "openhands",
  gemini: "gemini-cli",
  cursor: "cursor",
  // `openclaw` is the bin name in openclaw/openclaw's package.json; Hermes
  // installs both `hermes` and `hermes-agent` as console scripts.
  openclaw: "openclaw",
  hermes: "hermes",
  "hermes-agent": "hermes",
};

function processEntry(pid: number): { ppid: number; name: string } | null {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) return null;
  const result = spawnSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 2000,
  });
  if (result.status !== 0) return null;
  const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(result.stdout);
  if (!match) return null;
  return { ppid: Number(match[1]), name: basename(match[2]!) };
}

/**
 * The nearest ancestor process that is a known driver, or null. A CLI run
 * from a Codex shell inside a Claude Code session has both drivers'
 * variables in its environment; the process tree says which one is actually
 * running it.
 */
export function nearestDriverAncestor(startPid: number = process.ppid): string | null {
  let pid = startPid;
  for (let hop = 0; hop < 12; hop += 1) {
    const entry = processEntry(pid);
    if (!entry) return null;
    const kind = PARENT_PROCESS_KINDS[entry.name.toLowerCase()];
    if (kind) return kind;
    if (entry.ppid <= 1 || entry.ppid === pid) return null;
    pid = entry.ppid;
  }
  return null;
}

/** The name of the process that launched this one, or null when it cannot be read. */
export function parentProcessName(ppid: number = process.ppid): string | null {
  return processEntry(ppid)?.name ?? null;
}

/**
 * Detect the driver. Every driver whose variables are present is a candidate;
 * one that exposes its own session id outranks one that only leaves markers,
 * because markers are inherited by everything a driver spawns while a session
 * id is set per process. When two drivers both expose a session id, the
 * process tree decides; when it cannot, the first in DRIVER_ORDER wins.
 */
const DRIVER_ORDER = [
  "codex",
  "claude-code",
  "opencode",
  "openhands",
  "gemini-cli",
  "cursor",
  "hermes",
  "openclaw",
] as const;

function candidates(env: Environment): DetectedRuntime[] {
  const found: DetectedRuntime[] = [];
  const claudeAnchor = nonEmpty(env.CLAUDE_CODE_SESSION_ID) ?? nonEmpty(env.CLAUDE_SESSION_ID);
  if (claudeAnchor !== null || nonEmpty(env.CLAUDECODE) !== null) {
    found.push({
      kind: "claude-code",
      anchor: claudeAnchor,
      version: clean(nonEmpty(env.CLAUDE_AGENT_SDK_VERSION)),
      entrypoint: clean(nonEmpty(env.CLAUDE_CODE_ENTRYPOINT)),
      source: "detected",
    });
  }
  // CODEX_THREAD_ID is deliberately not an anchor: it is lineage, not the
  // executing session, and would collapse concurrent child sessions.
  const codexAnchor = nonEmpty(env.CODEX_SESSION_ID);
  if (codexAnchor !== null) {
    found.push({
      kind: "codex",
      anchor: codexAnchor,
      version: clean(nonEmpty(env.CODEX_VERSION)),
      entrypoint: nonEmpty(env.CODEX_CI) !== null ? "exec" : null,
      source: "detected",
    });
  }
  if (hasPrefix(env, "OPENCODE")) {
    found.push({
      kind: "opencode",
      anchor: nonEmpty(env.OPENCODE_SESSION_ID),
      version: clean(nonEmpty(env.OPENCODE_VERSION)),
      entrypoint: null,
      source: "detected",
    });
  }
  if (hasPrefix(env, "OPENHANDS")) {
    found.push({
      kind: "openhands",
      anchor: nonEmpty(env.OPENHANDS_SESSION_ID) ?? nonEmpty(env.OPENHANDS_CONVERSATION_ID),
      version: clean(nonEmpty(env.OPENHANDS_VERSION)),
      entrypoint: null,
      source: "detected",
    });
  }
  if (nonEmpty(env.GEMINI_CLI) !== null || hasPrefix(env, "GEMINI_CLI_")) {
    found.push({
      kind: "gemini-cli",
      anchor: nonEmpty(env.GEMINI_CLI_SESSION_ID),
      version: clean(nonEmpty(env.GEMINI_CLI_VERSION)),
      entrypoint: null,
      source: "detected",
    });
  }
  if (nonEmpty(env.CURSOR_AGENT) !== null || nonEmpty(env.CURSOR_TRACE_ID) !== null) {
    found.push({
      kind: "cursor",
      anchor: nonEmpty(env.CURSOR_TRACE_ID),
      version: null,
      entrypoint: null,
      source: "detected",
    });
  }
  // Hermes re-exports two attribution markers into the environment of every
  // shell command it runs, alongside a per-command session id — see
  // `tools/environments/base_session_env.py` in NousResearch/hermes-agent,
  // which calls them exactly that. `AI_AGENT` is a cross-harness name, so only
  // its Hermes value counts; presence alone would claim other harnesses.
  const hermesAnchor = nonEmpty(env.HERMES_SESSION_ID);
  if (
    hermesAnchor !== null ||
    nonEmpty(env.HERMES_AGENT) !== null ||
    nonEmpty(env.AI_AGENT) === "hermes-agent"
  ) {
    found.push({
      kind: "hermes",
      anchor: hermesAnchor,
      version: clean(nonEmpty(env.HERMES_VERSION)),
      entrypoint: null,
      source: "detected",
    });
  }
  // OpenClaw publishes no attribution marker. Its per-session variable is the
  // key it hands an MCP server it spawns, and its operator-facing OPENCLAW_*
  // variables are inherited by anything it runs — the same weak-marker shape
  // as OPENCODE and OPENHANDS above, and the process tree breaks the tie.
  if (hasPrefix(env, "OPENCLAW")) {
    found.push({
      kind: "openclaw",
      anchor: nonEmpty(env.OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY),
      version: clean(nonEmpty(env.OPENCLAW_VERSION)),
      entrypoint: null,
      source: "detected",
    });
  }
  return found.sort((a, b) => DRIVER_ORDER.indexOf(a.kind as never) - DRIVER_ORDER.indexOf(b.kind as never));
}

export function detectRuntime(
  env: Environment,
  options: { parentProcess?: () => string | null; ancestorDriver?: () => string | null } = {},
): DetectedRuntime {
  const found = candidates(env);
  const withSession = found.filter((candidate) => candidate.anchor !== null);
  if (withSession.length === 1) return withSession[0]!;
  if (withSession.length > 1) {
    const byTree = (options.ancestorDriver ?? nearestDriverAncestor)();
    return withSession.find((candidate) => candidate.kind === byTree) ?? withSession[0]!;
  }
  if (found.length > 0) {
    const byTree = (options.ancestorDriver ?? nearestDriverAncestor)();
    return found.find((candidate) => candidate.kind === byTree) ?? found[0]!;
  }

  const parent = (options.parentProcess ?? parentProcessName)();
  const byParent = parent ? PARENT_PROCESS_KINDS[parent.toLowerCase()] : undefined;
  if (byParent) {
    return { kind: byParent, anchor: null, version: null, entrypoint: null, source: "detected" };
  }
  return {
    kind: "custom",
    anchor: null,
    version: null,
    entrypoint: null,
    source: "declared",
    unrecognisedParent: clean(parent),
  };
}

export function isRuntimeKind(value: string): boolean {
  return RUNTIME_KIND_PATTERN.test(value);
}

/** The diagnostic fields a detected driver contributes to an Instance's metadata. */
export function runtimeMetadataOf(runtime: DetectedRuntime): Record<string, string> {
  const metadata: Record<string, string> = { runtime_source: runtime.source };
  if (runtime.version) metadata.driver_version = runtime.version;
  if (runtime.entrypoint) metadata.entrypoint = runtime.entrypoint;
  if (runtime.unrecognisedParent) metadata.parent_process = runtime.unrecognisedParent;
  return metadata;
}
