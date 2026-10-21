import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
const cwd = fileURLToPath(new URL("../experiments/planner-quorum-client/", import.meta.url));
for (const args of [["scripts/check.mjs"], ["--test", ...readdirSync(new URL("../experiments/planner-quorum-client/tests/", import.meta.url)).filter(name => name.endsWith(".test.js")).map(name => `tests/${name}`)]]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
