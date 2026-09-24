#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.ts";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  return runCli(argv);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = await main();
}
