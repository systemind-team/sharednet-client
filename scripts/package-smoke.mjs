import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert(files.every((path) => /^(?:bin\/sharednet\.js|dist\/(?:server\/|protocol\/|modules\/)?[\w-]+\.(?:js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(path)), "Unexpected tarball contents");
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
    "import { runCli } from 'sharednet'; if(typeof runCli !== 'function') process.exit(1);"],
  { cwd: consumer, env, timeout: 10_000 });
  // The published declarations must type-check for a TypeScript consumer without Node's typings:
  // nothing public may name @types/node-only types such as NodeJS.Platform.
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022", lib: ["ES2022", "DOM"], types: [], noEmit: true, skipLibCheck: false },
    files: ["consumer.ts"],
  }) + "\n");
  await writeFile(join(consumer, "consumer.ts"), 'import { runCli, type CliDependencies } from "sharednet";\nconst dependencies: CliDependencies = {};\nvoid runCli(["rooms"], dependencies);\n');
  await assert.doesNotReject(
    exec(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(consumer, "tsconfig.json")], { cwd: consumer, env, timeout: 120_000 }),
    (error) => { throw new Error(`The packaged declarations do not type-check without @types/node:\n${error.stdout}${error.stderr}`); },
  );
  let failure;
  try {
    await exec(join(consumer, "node_modules/.bin/sharednet"), ["--json"], {
      cwd: consumer, env: { ...env, NODE_OPTIONS: "--no-experimental-strip-types" }, timeout: 10_000,
    });
  } catch (error) { failure = error; }
  assert.equal(failure?.code, 2, "Installed executable must return its usage exit code");
  assert.equal(failure.stdout, "");
  assert.equal(JSON.parse(failure.stderr).error.code, "unknown_command");
  // The packed server answers: `sharednet local` starts, serves the API, and stops on SIGTERM.
  const local = spawn(join(consumer, "node_modules/.bin/sharednet"), ["local", "--port", "0", "--json"], {
    cwd: consumer, env: { ...env, NODE_OPTIONS: "--no-experimental-strip-types" }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((resolve) => local.once("exit", (code) => resolve(code)));
  const announced = await new Promise((resolve, reject) => {
    let out = "";
    local.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("\n")) resolve(JSON.parse(out.slice(0, out.indexOf("\n"))));
    });
    exited.then((code) => reject(new Error(`sharednet local exited ${code} before it was ready`)));
    setTimeout(() => reject(new Error("sharednet local did not start within 10 s")), 10_000);
  });
  const discovery = await fetch(`${announced.base_url}/api/v1`);
  assert.equal(discovery.status, 200, "The local server must answer the API discovery route");
  local.kill("SIGTERM");
  assert.equal(await exited, 0, "sharednet local must stop cleanly on SIGTERM");
  await assert.rejects(readFile(announced.env_file), { code: "ENOENT" }, "sharednet local must remove its key file when it stops");
  const sha256 = createHash("sha256").update(await readFile(tarball)).digest("hex");
  await writeFile(join(artifacts, "cli-smoke.json"), JSON.stringify({ name: pack.name, version: pack.version, tarball: pack.filename, sha256, files }, null, 2) + "\n");
  console.log(`Installed-package smoke passed: ${pack.filename}; sha256=${sha256}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
