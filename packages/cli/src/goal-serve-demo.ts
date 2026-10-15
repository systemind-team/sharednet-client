import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ApiClient } from "./api-client.ts";
import { localError } from "./errors.ts";
import { goalWatch, startGoal, type GoalWatchDependencies, type GoalWatchOptions, type GoalWatchResult } from "./goal.ts";
import {
  TurnReader,
  containerName,
  loopbackPort,
  parseAgents,
  runContainers,
  type AgentSpec,
  type DockerRunner,
  type RunPlan,
} from "./goal-run.ts";
import { mentions } from "./triggers.ts";
import { validTurnLimit } from "./wake-driver.ts";

export type ServeKickoff = "first" | "all";
export type ServeDemoSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

export interface ServeDemoSignalHost {
  on(signal: ServeDemoSignal, listener: () => void): void;
  off(signal: ServeDemoSignal, listener: () => void): void;
  exit(code: number): void;
}

const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOMES = "/home/agents";
const CONTAINER_CLI = "/opt/sharednet";
const CONTAINER_CODEX_AUTH = "/run/codex/auth.json";
const DEFAULT_TURN_LIMIT_MS = 20 * 60_000;
// A production listener waits 30 seconds before its first retry after a transient
// startup failure. The barrier spans that retry and its follow-up probe.
const LISTENER_START_ATTEMPTS = 240;

const FORWARDER = `const net = require("node:net");
const port = Number(process.argv[1]);
net.createServer((socket) => {
  const upstream = net.connect(port, "host.docker.internal");
  socket.pipe(upstream).pipe(socket);
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}).listen(port, "127.0.0.1");`;
const FORWARDER_PROBE = `require("node:net").connect(Number(process.argv[1]), "127.0.0.1").on("connect", () => process.exit(0)).on("error", () => process.exit(1));`;

/** The first serve-backed demo is intentionally one fixed, inspectable topology. */
export function parseServeDemoAgents(raw: readonly string[]): AgentSpec[] {
  const agents = parseAgents(raw.length === 0 ? ["codex", "codex", "codex"] : raw);
  if (agents.length !== 3 || agents.some((agent) => agent.driver !== "codex")) {
    throw localError("invalid_arguments", "goal serve-demo runs exactly three Codex agents; give --agent codex three times, or omit --agent for the default.");
  }
  return agents;
}

/** Goal #1 must not itself trigger a seat; the selected kickoff is the experimental intervention. */
export function assertServeDemoGoalUnaddressed(content: string): void {
  const targets = [
    { memberId: "all", name: null },
    { memberId: "", name: "codex-1" },
    { memberId: "", name: "codex-2" },
    { memberId: "", name: "codex-3" },
  ];
  if (targets.some((target) => mentions(content, target))) {
    throw localError("invalid_arguments", "The serve-demo Goal addresses the demo team. Remove @all and @codex-1/2/3 so --kickoff is the only initial wake.");
  }
}

/** The only line the owner injects after all three real listeners report healthy. */
export function serveKickoff(
  mode: ServeKickoff,
  seats: ReadonlyArray<{ name: string; member_id: string }>,
  goalSequence: number,
): string {
  if (seats.length !== 3) throw localError("invalid_arguments", "A serve demo needs exactly three seats.");
  if (mode === "first") {
    return `@${seats[0]!.member_id} Start Goal #${goalSequence} now. Roster: ${seats.map((seat) => `${seat.name}=${seat.member_id}`).join(", ")}. You are the coordinator: delegate distinct work to ${seats[1]!.name} and ${seats[2]!.name} using their exact member identifiers, collect their replies, and synthesize the final result.`;
  }
  return `${seats.map((seat) => `@${seat.member_id}`).join(" ")} Start Goal #${goalSequence} now. Roster: ${seats.map((seat) => `${seat.name}=${seat.member_id}`).join(", ")}. ${seats[0]!.name} coordinates and synthesizes; ${seats[1]!.name} owns the primary solution and evidence; ${seats[2]!.name} owns independent critique and verification. Contributors report to the coordinator with its exact @member id.`;
}

export interface ServeDemoSeat extends AgentSpec {
  member_id: string;
  session_id: string;
}

export interface ServeGoalDemoInput {
  plan: RunPlan;
  roomId: string;
  inviteToken: string;
  goal: string;
  until: string[];
  baseUrl: string;
  out: string;
  checkEveryMs: number;
  quietChecks: boolean;
  kickoff: ServeKickoff;
  turnLimitMs?: number;
}

type WatchGoal = (
  client: ApiClient,
  memberToken: string,
  apiKey: string,
  options: GoalWatchOptions,
  dependencies: GoalWatchDependencies,
) => Promise<GoalWatchResult>;

export interface ServeGoalDemoDependencies {
  docker: DockerRunner;
  now: () => Date;
  /** Numeric owner of the bind-mounted workspace; injectable for deterministic tests. */
  uid?: number;
  gid?: number;
  sleep?: (ms: number) => Promise<void>;
  stderr?: (line: string) => void;
  watch?: WatchGoal;
  /** Only the real CLI supplies process signals; tests can provide an inert host. */
  signalHost?: ServeDemoSignalHost;
}

export interface ServeGoalDemoResult extends GoalWatchResult {
  mode: "real-serve";
  kickoff: ServeKickoff;
  agents: ServeDemoSeat[];
}

export function serveSessionPrompt(seat: Pick<AgentSpec, "name">, seats: ReadonlyArray<Pick<AgentSpec, "name">>, until: readonly string[], kickoff: ServeKickoff): string {
  const leader = seats[0]!;
  const others = seats.filter((candidate) => candidate.name !== seat.name);
  const claims = until.filter((trigger) => trigger.startsWith("said ")).map((trigger) => `"${trigger.slice(5)}"`);
  const common = [
    `You are ${seat.name}, one of three persistent agents in a SharedNet serve-first Goal demo.`,
    `The team is ${seats.map((candidate) => candidate.name).join(", ")}.`,
    "A real sharednet serve listener will resume this thread only when this seat is directly mentioned. Do not run sharednet wait or watch; the listener owns delivery and acknowledgement.",
    `The Room ends when the first of these happens: ${until.join("; ")}.`,
    `The coordinator alone makes any completion claim${claims.length > 0 ? ` by saying ${claims.join(" or ")} in the Room only after the team has finished` : " after the team has finished"}. Contributors report results to the coordinator instead.`,
    "During a Goal turn, use sharednet say with exact @member ids for assignments, questions, and progress. Your final model response is posted to the Room automatically by serve, so do not post the same response yourself.",
    "This bootstrap turn creates the persistent thread only. Do no Goal work now and reply exactly READY.",
  ];
  if (kickoff === "first" && seat.name === leader.name) {
    common.splice(3, 0, `You are coordinator. The first Goal kickoff supplies the exact member-id roster; delegate distinct work to ${others.map((candidate) => candidate.name).join(" and ")} with those ids, then synthesize after they mention you with results.`);
  } else if (kickoff === "first") {
    common.splice(3, 0, `You are a contributor. Wait for the coordinator's direct assignment, complete it independently, then begin your final response with the coordinator's exact member id from the kickoff roster.`);
  } else if (seat.name === leader.name) {
    common.splice(3, 0, "You are coordinator. Coordinate the simultaneous start, reconcile both contributors' work, and synthesize the final result.");
  } else if (seat.name === seats[1]!.name) {
    common.splice(3, 0, "You own the primary solution and evidence. Start on the Goal immediately, then report to the coordinator's exact member id from the kickoff roster.");
  } else {
    common.splice(3, 0, "You own independent critique and verification. Start on the Goal immediately, then report to the coordinator's exact member id from the kickoff roster.");
  }
  return common.join("\n");
}

function durationArgument(milliseconds: number): string {
  return `${milliseconds / 1000}s`;
}

/**
 * A separate Goal runner whose data plane is production `sharednet serve`.
 * It provisions and observes; it never waits or acknowledges on an agent's behalf.
 */
export async function runServeGoalDemo(
  client: ApiClient,
  memberToken: string,
  apiKey: string,
  input: ServeGoalDemoInput,
  dependencies: ServeGoalDemoDependencies,
): Promise<ServeGoalDemoResult> {
  const { docker, plan } = { docker: dependencies.docker, plan: input.plan };
  if (plan.agents.length !== 3 || plan.agents.some((agent) => agent.driver !== "codex")) {
    throw localError("invalid_arguments", "goal serve-demo runs exactly three Codex agents.");
  }
  if (!validTurnLimit(input.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS)) {
    throw localError("invalid_arguments", "The turn limit must be between 1m and 24h.");
  }
  const log = dependencies.stderr ?? (() => undefined);
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const watch = dependencies.watch ?? goalWatch;
  const uid = dependencies.uid ?? (typeof process.getuid === "function" ? process.getuid() : null);
  const gid = dependencies.gid ?? (typeof process.getgid === "function" ? process.getgid() : null);
  const agentUser = Number.isInteger(uid) && Number.isInteger(gid) ? `${uid}:${gid}` : "node";
  const turnLimitMs = input.turnLimitMs ?? DEFAULT_TURN_LIMIT_MS;
  const checks = containerName(input.roomId);
  const containers = runContainers(input.roomId, plan.agents);
  const createdContainers = new Set<string>();
  const runningContainers = new Set<string>();
  const pendingStarts = new Set<Promise<unknown>>();
  const records: Array<AgentSpec & { member_id: string | null; session_id: string | null }> = plan.agents.map((agent) => ({ ...agent, member_id: null, session_id: null }));
  await mkdir(input.out, { recursive: true });

  let interrupted: ServeDemoSignal | null = null;
  const interruptedError = () => localError("goal_interrupted", `goal serve-demo was interrupted by ${interrupted ?? "a signal"}.`);
  const startManagedContainer = async (name: string, createArgs: readonly string[]) => {
    if (interrupted) throw interruptedError();
    // `docker run` may create a stopped container and still return nonzero. Split create
    // from start so this invocation owns an exact set that cleanup may safely remove,
    // while a pre-existing same-name container is never mistaken for ours.
    const pending = (async () => {
      const created = await docker(["create", "--name", name, ...createArgs]);
      if (created.code !== 0) return created;
      createdContainers.add(name);
      if (interrupted) throw interruptedError();
      const started = await docker(["start", name]);
      if (started.code === 0) runningContainers.add(name);
      return started;
    })();
    pendingStarts.add(pending);
    let result: Awaited<ReturnType<DockerRunner>>;
    try {
      result = await pending;
    } finally {
      pendingStarts.delete(pending);
    }
    if (interrupted) throw interruptedError();
    return result;
  };

  const startContainer = (seat: AgentSpec) => {
    const name = containerName(input.roomId, seat.name);
    return startManagedContainer(name, [
      "--add-host", "host.docker.internal:host-gateway",
      "--volume", `${plan.workspace}:${CONTAINER_WORKSPACE}`,
      "--volume", `${plan.cli.root}:${CONTAINER_CLI}:ro`,
      ...(plan.codexAuth?.kind === "login" ? ["--volume", `${plan.codexAuth.file}:${CONTAINER_CODEX_AUTH}:ro`] : []),
      plan.image, "sleep", "infinity",
    ]);
  };

  let stopPromise: Promise<void> | null = null;
  const stopContainers = () => {
    stopPromise ??= (async () => {
      await Promise.allSettled([...pendingStarts]);
      const targets = containers.filter((name) => runningContainers.has(name));
      if (targets.length === 0) return;
      const stopped = await docker(["stop", "--time", "5", ...targets]);
      if (stopped.code !== 0) {
        throw localError("container_stop_failed", `The Goal containers could not be stopped: ${stopped.stderr.trim().slice(-400) || `docker exited ${stopped.code}`}`);
      }
      for (const target of targets) runningContainers.delete(target);
    })();
    return stopPromise;
  };

  let removePromise: Promise<void> | null = null;
  const removeContainers = () => {
    removePromise ??= (async () => {
      await Promise.allSettled([...pendingStarts]);
      const targets = containers.filter((name) => createdContainers.has(name));
      if (targets.length === 0) return;
      const removed = await docker(["rm", "--force", ...targets]);
      if (removed.code !== 0) {
        const listed = await docker(["ps", "--all", "--format", "{{.Names}}"]).catch(() => null);
        const names = new Set((listed?.code === 0 ? listed.stdout : "").split("\n").map((name) => name.trim()).filter(Boolean));
        const remaining = listed?.code === 0 ? targets.filter((name) => names.has(name)) : targets;
        if (remaining.length > 0) {
          const detail = removed.stderr.trim().slice(-400) || `docker exited ${removed.code}`;
          throw localError(
            "container_remove_failed",
            `The Goal containers could not be removed: ${detail}. Still present: ${remaining.join(", ")}. Remove them with docker rm --force ${remaining.join(" ")}`,
          );
        }
      }
      for (const target of targets) {
        createdContainers.delete(target);
        runningContainers.delete(target);
      }
    })();
    return removePromise;
  };

  const cleanupContainers = async () => {
    const failures: Error[] = [];
    await stopContainers().catch((error: unknown) => failures.push(error instanceof Error ? error : new Error("docker stop failed")));
    await removeContainers().catch((error: unknown) => failures.push(error instanceof Error ? error : new Error("docker rm failed")));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw localError("container_cleanup_failed", failures.map((failure) => failure.message).join("; "));
  };

  const signalExitCodes: Record<ServeDemoSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const signalListeners = new Map<ServeDemoSignal, () => void>();
  const detachSignals = () => {
    if (!dependencies.signalHost) return;
    for (const [signal, listener] of signalListeners) dependencies.signalHost.off(signal, listener);
    signalListeners.clear();
  };
  if (dependencies.signalHost) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const listener = () => {
        if (interrupted) return;
        interrupted = signal;
        void cleanupContainers().then(
          () => {
            detachSignals();
            log(`goal: ${signal} stopped and removed the Goal containers; ${input.roomId} is still open\n`);
            dependencies.signalHost!.exit(signalExitCodes[signal]);
          },
          (error: unknown) => {
            detachSignals();
            log(`goal: cleanup after ${signal} failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
            dependencies.signalHost!.exit(2);
          },
        );
      };
      signalListeners.set(signal, listener);
      dependencies.signalHost.on(signal, listener);
    }
  }

  const execSeat = (
    seat: typeof records[number],
    command: readonly string[],
    options: { env?: Record<string, string>; input?: string; detach?: boolean } = {},
  ) => {
    const home = `${CONTAINER_HOMES}/${seat.name}`;
    const environment = options.env ?? {};
    return docker([
      "exec",
      ...(options.detach ? ["--detach"] : []),
      "--user", agentUser,
      "--workdir", CONTAINER_WORKSPACE,
      "-e", `HOME=${home}`,
      "-e", `CODEX_HOME=${home}/.codex`,
      "-e", `SHAREDNET_BASE_URL=${input.baseUrl}`,
      ...(seat.member_id ? ["-e", `SHAREDNET_SEAT=${seat.member_id}`] : []),
      ...(plan.codexAuth?.kind === "api-key" ? ["-e", "OPENAI_API_KEY"] : []),
      ...Object.keys(environment).flatMap((name) => ["-e", name]),
      containerName(input.roomId, seat.name),
      ...command,
    ], { env: environment, ...(options.input === undefined ? {} : { input: options.input }) });
  };

  const closeFailedStart = async (reason: string) => {
    await client.request("POST", `/rooms/${encodeURIComponent(input.roomId)}/close`, apiKey, { detail: `goal serve-demo could not start: ${reason}`.slice(0, 2_000) }).catch(() => undefined);
  };

  let runFailure: unknown = null;
  try {
    try {
      const checker = await startManagedContainer(checks, ["--volume", `${plan.workspace}:${CONTAINER_WORKSPACE}`, plan.image, "sleep", "infinity"]);
      if (checker.code !== 0) throw localError("container_failed", `The checks' container did not start: ${checker.stderr.trim()}`);
      const port = loopbackPort(input.baseUrl);
      const entry = `${CONTAINER_CLI}/${plan.cli.entry}`;
      const wrapper = `#!/bin/sh\nexec node ${entry.endsWith(".ts") ? "--experimental-strip-types --no-warnings " : ""}${entry} "$@"\n`;

      // Prepare all homes before creating the persistent threads.
      for (const seat of records) {
        const container = containerName(input.roomId, seat.name);
        const started = await startContainer(seat);
        if (started.code !== 0) throw localError("container_failed", `${seat.name}'s container did not start: ${started.stderr.trim()}`);
        if (port !== null) {
          await docker(["exec", "--detach", "--user", agentUser, container, "node", "-e", FORWARDER, String(port)]);
          let listening = false;
          for (let attempt = 0; attempt < 20 && !listening; attempt += 1) {
            listening = (await docker(["exec", "--user", agentUser, container, "node", "-e", FORWARDER_PROBE, String(port)])).code === 0;
            if (!listening) await sleep(250);
          }
          if (!listening) throw localError("container_failed", `${seat.name}'s container could not reach this machine's port ${port}.`);
        }
        const installed = await docker(["exec", "--user", "root", "--interactive", container, "sh", "-c", "cat > /usr/local/bin/sharednet && chmod 755 /usr/local/bin/sharednet"], { input: wrapper });
        if (installed.code !== 0) throw localError("container_failed", `The sharednet command could not be put in ${seat.name}'s container: ${installed.stderr.trim()}`);
        const home = `${CONTAINER_HOMES}/${seat.name}`;
        const prepared = plan.codexAuth?.kind === "login"
          ? await docker([
              "exec", "--user", "root", container, "sh", "-c",
              `mkdir -p '${home}/.codex' && cp ${CONTAINER_CODEX_AUTH} '${home}/.codex/auth.json' && chown -R ${agentUser} '${home}' && chmod 600 '${home}/.codex/auth.json'`,
            ])
          : await docker(["exec", "--user", "root", container, "sh", "-c", `mkdir -p '${home}/.codex' && chown -R ${agentUser} '${home}'`]);
        if (prepared.code !== 0) throw localError("container_failed", `${seat.name}'s Codex home could not be made: ${prepared.stderr.trim()}`);
        // `sharednet serve` resumes this thread in a new Codex process. Persist an
        // explicitly selected model in the seat's Codex home so those later turns
        // do not silently fall back to the machine or image default.
        const config = `${seat.model ? `model = "${seat.model}"\n` : ""}approval_policy = "never"\nsandbox_mode = "danger-full-access"\n`;
        const configured = await docker(["exec", "--user", agentUser, "--interactive", container, "sh", "-c", `cat > '${home}/.codex/config.toml'`], { input: config });
        if (configured.code !== 0) throw localError("container_failed", `${seat.name}'s Codex policy could not be written: ${configured.stderr.trim()}`);
      }

      // The bootstrap creates only persistent threads. It neither starts Goal work nor posts to the Room.
      for (const seat of records) {
        const reader = new TurnReader("codex");
        const command = [
          "timeout", "120", "codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
          ...(seat.model ? ["-m", seat.model] : []),
          serveSessionPrompt(seat, records, input.until, input.kickoff),
        ];
        const bootstrapped = await execSeat(seat, command);
        for (const line of bootstrapped.stdout.split("\n")) reader.line(line);
        seat.session_id = reader.reading.sessionId;
        if (bootstrapped.code !== 0 || reader.reading.failed || !seat.session_id) {
          throw localError("agent_bootstrap_failed", `${seat.name}'s persistent Codex thread could not be created: ${bootstrapped.stderr.trim().slice(-400)}`);
        }
      }

      // Join with the real thread id, bind that same thread, and start one production listener.
      // All seats join while the Room is still empty, so Goal #1 remains pending for the first mention.
      for (const seat of records) {
        const joined = await execSeat(seat, ["sharednet", "join", input.roomId, "--name", seat.name, "--no-wake", "--json"], {
          env: { SHAREDNET_INVITE_TOKEN: input.inviteToken, CODEX_SESSION_ID: seat.session_id! },
        });
        try {
          seat.member_id = (JSON.parse(joined.stdout) as { member_id?: string }).member_id ?? null;
        } catch {
          seat.member_id = null;
        }
        if (joined.code !== 0 || !seat.member_id) throw localError("join_failed", `${seat.name} could not join the Room: ${(joined.stdout + joined.stderr).trim().slice(0, 400)}`);
        const wake = await execSeat(seat, ["sharednet", "wake", "set", "codex", "--resume", seat.session_id!, "--command", "codex", "--as", seat.member_id!, "--json"]);
        if (wake.code !== 0) throw localError("wake_setup_failed", `${seat.name}'s Codex wake could not be set: ${(wake.stdout + wake.stderr).trim().slice(-400)}`);
        const limit = await execSeat(seat, ["sharednet", "wake", "limit", durationArgument(turnLimitMs), "--as", seat.member_id!, "--json"]);
        if (limit.code !== 0) throw localError("wake_setup_failed", `${seat.name}'s turn limit could not be set: ${(limit.stdout + limit.stderr).trim().slice(-400)}`);
        const startedServe = await execSeat(seat, ["sh", "-c", "exec sharednet serve --rooms \"$1\" >>\"$HOME/serve.log\" 2>&1", "sh", input.roomId], { detach: true });
        if (startedServe.code !== 0) throw localError("serve_failed", `${seat.name}'s listener could not be started: ${startedServe.stderr.trim().slice(-400)}`);
      }

      // Health is a start barrier: no Goal line is posted while any listener is absent or retrying.
      for (const seat of records) {
        let healthy = false;
        let last = "";
        for (let attempt = 0; attempt < LISTENER_START_ATTEMPTS && !healthy; attempt += 1) {
          const status = await execSeat(seat, ["sharednet", "serve", "--status", "--json"]);
          last = (status.stdout + status.stderr).trim();
          if (status.code === 0) {
            try {
              const parsed = JSON.parse(status.stdout) as { running?: boolean; wake_protocol?: string; seats?: Array<{ room_id?: string; member_id?: string; state?: string }> };
              healthy = parsed.running === true && parsed.wake_protocol === "wake-plugins-v1" && (parsed.seats ?? []).some((candidate) => candidate.room_id === input.roomId && candidate.member_id === seat.member_id && candidate.state === "listening");
            } catch {
              healthy = false;
            }
          }
          if (!healthy) await sleep(250);
        }
        if (!healthy) throw localError("serve_not_listening", `${seat.name}'s real listener did not reach listening: ${last.slice(-400)}`);
      }
      log(`goal: three real serve listeners are ready in ${input.roomId}\n`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "error";
      await closeFailedStart(reason);
      throw error;
    }

    let started: Awaited<ReturnType<typeof startGoal>>;
    const seats = records as ServeDemoSeat[];
    let kickoff = "";
    let kickoffSequence = 0;
    try {
      started = await startGoal(client, apiKey, input.roomId, input.goal, input.until);
      const sequence = (started.message as { sequence?: number } | undefined)?.sequence ?? 1;
      kickoff = serveKickoff(input.kickoff, seats, sequence);
      const kicked = await client.request<{ message?: { sequence?: number } }>("POST", `/rooms/${encodeURIComponent(input.roomId)}/owner-messages`, apiKey, { content: kickoff, as: "runner" });
      kickoffSequence = kicked.message?.sequence ?? 0;
      if (!Number.isSafeInteger(kickoffSequence) || kickoffSequence <= sequence) {
        throw localError("invalid_server_response", "The kickoff was posted but its sequence did not come back.");
      }
    } catch (error) {
      await closeFailedStart(error instanceof Error ? error.message : "the Goal or kickoff was refused");
      throw error;
    }
    const goalSequence = (started.message as { sequence?: number } | undefined)?.sequence ?? 1;
    log(`goal: ${input.kickoff === "first" ? "seeded the coordinator" : "seeded all three agents"}; serve owns every later wake\n`);

    let watched: GoalWatchResult;
    try {
      watched = await watch(
        client,
        memberToken,
        apiKey,
        { roomId: input.roomId, workspace: plan.workspace, out: input.out, checkEveryMs: input.checkEveryMs, quietChecks: input.quietChecks, feedbackMention: seats[0]!.member_id, ignoreThrough: kickoffSequence },
        {
          now: dependencies.now,
          ...(dependencies.sleep ? { sleep: dependencies.sleep } : {}),
          stderr: log,
          check: async (command) => {
            const result = await docker(["exec", "--user", agentUser, "--workdir", CONTAINER_WORKSPACE, checks, "sh", "-c", command]);
            return { exitCode: result.code, output: `${result.stdout}${result.stderr}` };
          },
        },
      );
      if (interrupted) throw interruptedError();
    } catch (error) {
      await client.request("POST", `/rooms/${encodeURIComponent(input.roomId)}/close`, apiKey, {
        trigger: "runner_error",
        detail: `goal serve-demo stopped: ${error instanceof Error ? error.message : "watcher failed"}`.slice(0, 2_000),
      }).catch(() => undefined);
      throw error;
    }

    await stopContainers();
    for (const seat of seats) {
      const target = join(input.out, "agents", seat.name, "home");
      await rm(target, { recursive: true, force: true });
      await mkdir(join(target, ".codex"), { recursive: true });
      // Copy only evidence paths, never credential files. The raw session trace can still contain
      // sensitive content or a secret that an agent itself read and surfaced.
      const sessions = await docker(["cp", `${containerName(input.roomId, seat.name)}:${CONTAINER_HOMES}/${seat.name}/.codex/sessions`, join(target, ".codex", "sessions")]);
      if (sessions.code !== 0) log(`goal: ${seat.name}'s Codex trace could not be copied out: ${sessions.stderr.trim()}\n`);
      const serveLog = await docker(["cp", `${containerName(input.roomId, seat.name)}:${CONTAINER_HOMES}/${seat.name}/serve.log`, join(target, "serve.log")]);
      if (serveLog.code !== 0) log(`goal: ${seat.name}'s serve log could not be copied out: ${serveLog.stderr.trim()}\n`);
    }
    const result: ServeGoalDemoResult = { ...watched, mode: "real-serve", kickoff: input.kickoff, agents: seats };
    await writeFile(join(input.out, "serve-demo.json"), `${JSON.stringify({ mode: result.mode, kickoff: result.kickoff, image: plan.image, turn_limit_ms: turnLimitMs, goal_sequence: goalSequence, kickoff_message: kickoff, agents: seats }, null, 2)}\n`);
    return result;
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    try {
      await cleanupContainers();
    } catch (cleanupError) {
      if (runFailure && cleanupError !== runFailure) {
        const original = runFailure instanceof Error ? runFailure.message : "the Goal run failed";
        const cleanup = cleanupError instanceof Error ? cleanupError.message : "container cleanup failed";
        throw localError("container_cleanup_failed", `${original}; cleanup also failed: ${cleanup}`.slice(0, 2_000));
      }
      throw cleanupError;
    } finally {
      detachSignals();
    }
  }
}
