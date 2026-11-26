import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { localError } from "./errors.ts";
import { createSharedNetDevServer } from "./server/dev-server.ts";
import { MemorySharedNetRepository } from "./server/memory-repository.ts";
import { getStoragePaths, localServerEnvFile, writeLocalServerEnv } from "./storage.ts";

type Environment = Record<string, string | undefined>;

export interface LocalServerOptions {
  /** 127.0.0.1 keeps the server to this machine; 0.0.0.0 also lets `goal run` containers reach it. */
  host: "127.0.0.1" | "0.0.0.0";
  /** 0 picks a free port. */
  port: number;
  json: boolean;
}

export interface LocalServerDependencies {
  env: Environment;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  /** Stops the server when aborted; without it, SIGINT or SIGTERM does. */
  signal?: AbortSignal;
}

export const DEFAULT_LOCAL_PORT = 3001;

export function parseLocalHost(value: string | undefined): LocalServerOptions["host"] {
  if (value === undefined || value === "127.0.0.1") return "127.0.0.1";
  if (value === "0.0.0.0") return "0.0.0.0";
  // The CLI speaks plain HTTP only to 127.0.0.1, so any other address would serve no SharedNet client.
  throw localError("invalid_option", "--host is 127.0.0.1 (this machine) or 0.0.0.0 (also containers and the network).");
}

export function parseLocalPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_LOCAL_PORT;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port > 65_535) {
    throw localError("invalid_option", "--port is an integer from 0 to 65535 (0 picks a free port).");
  }
  return port;
}

function stopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal) {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
      return;
    }
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
}

/**
 * `sharednet local`: the SharedNet API on this machine, held in memory, for one account whose key
 * is made fresh on every start. The key goes to an owner-only env file, never to the terminal.
 */
export async function runLocalServer(
  options: LocalServerOptions,
  dependencies: LocalServerDependencies,
): Promise<{ stopped: true; base_url: string }> {
  const apiKey = `snk_${randomBytes(32).toString("base64url")}`;
  // The key belongs to an account, as a key issued by the Dashboard does: speaking as a Room's
  // owner (a goal, a runner line, closing the Room) needs one.
  const store = new MemorySharedNetRepository({ accounts: [{ authUserId: "local", apiKey }] });
  const server = createSharedNetDevServer(store);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw localError("local_port_in_use", `Port ${options.port} is in use. Choose another with --port, or 0 for a free one.`);
    }
    throw error;
  });

  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const envFile = localServerEnvFile(getStoragePaths(dependencies.env), port);
  try {
    await writeLocalServerEnv(
      envFile,
      `# SharedNet local server (pid ${process.pid}); removed when it stops.\n` +
        `export SHAREDNET_BASE_URL=${baseUrl}\n` +
        `export SHAREDNET_API_KEY=${apiKey}\n`,
    );
  } catch (error) {
    server.close();
    throw error;
  }

  if (options.json) {
    dependencies.stdout(`${JSON.stringify({ base_url: baseUrl, env_file: envFile, storage: "memory", host: options.host })}\n`);
  } else {
    dependencies.stderr(
      `SharedNet local server on ${baseUrl}, in memory: its Rooms end when this process stops.\n` +
        `Address and key: ${envFile} (owner-only).\n\n` +
        `In another shell:\n` +
        `  source ${envFile}\n` +
        `  sharednet session start --new\n` +
        `  sharednet room create --name 'My team'\n` +
        `  sharednet room invite <rom_…>\n\n` +
        `Give each agent the join command that \`room invite\` prints; it already names this server.\n` +
        `Ctrl-C stops the server.\n`,
    );
  }

  await stopped(dependencies.signal);
  await unlink(envFile).catch(() => undefined);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // A `wait` holds its request open; end those too instead of waiting them out.
    server.closeAllConnections();
  });
  return { stopped: true, base_url: baseUrl };
}
