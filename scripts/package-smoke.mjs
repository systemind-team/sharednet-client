import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts");
const scratch = await mkdtemp(join(tmpdir(), "sharednet-install-"));
// Construct an environment rather than inheriting credentials/session selectors.
const env = {
  PATH: process.env.PATH,
  HOME: scratch,
  XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_STATE_HOME: join(scratch, "state"),
  NPM_CONFIG_USERCONFIG: join(scratch, "empty-npmrc"),
  NPM_CONFIG_CACHE: join(scratch, "npm-cache"),
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_FUND: "false",
};

try {
  await mkdir(artifacts, { recursive: true });
  await writeFile(env.NPM_CONFIG_USERCONFIG, "");
  const packed = await exec("npm", ["pack", "--json", "--pack-destination", artifacts], {
    cwd: join(root, "packages/cli"), env, timeout: 120_000,
  });
  const [pack] = JSON.parse(packed.stdout);
  assert.equal(pack.name, "sharednet");
  const files = pack.files.map(({ path }) => path);
  for (const path of ["bin/sharednet.js", "dist/main.js", "dist/cli.js", "dist/cli.d.ts", "LICENSE", "package.json"]) {
    assert(files.includes(path), `Missing packaged entry: ${path}`);
  }
  assert(files.every((path) => /^(?:bin\/sharednet\.js|dist\/[\w-]+\.(?:js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(path)), "Unexpected tarball contents");
  const tarball = join(artifacts, pack.filename);
  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await exec("npm", ["install", "--offline", "--ignore-scripts", "--no-package-lock", "--no-save", tarball], { cwd: consumer, env, timeout: 60_000 });
  const installed = join(consumer, "node_modules/sharednet");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.deepEqual(manifest.dependencies ?? {}, {}, "The CLI must remain free of external runtime dependencies");
  assert.equal(manifest.version, pack.version);
  await exec(process.execPath, ["--no-experimental-strip-types", "--input-type=module", "-e",
    `import { runCli } from ${JSON.stringify(pathToFileURL(join(installed, "dist/cli.js")).href)}; if(typeof runCli !== 'function') process.exit(1);`],
  { cwd: consumer, env, timeout: 10_000 });
  let failure;
  try {
    await exec(process.execPath, ["--no-experimental-strip-types", join(installed, "bin/sharednet.js"), "--json"], { cwd: consumer, env, timeout: 10_000 });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 2, "Installed executable must return its usage exit code");
  assert.equal(failure.stdout, "");
  assert.equal(JSON.parse(failure.stderr).error.code, "unknown_command");
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(join(artifacts, "cli-smoke.json"), JSON.stringify({ name: pack.name, version: pack.version, tarball: pack.filename, sha256, files }, null, 2) + "\n");
  console.log(`Installed-package smoke passed: ${pack.filename}; sha256=${sha256}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
