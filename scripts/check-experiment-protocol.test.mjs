import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkExperimentProtocol } from "./check-experiment-protocol.mjs";

const templateUrl = new URL("../docs/experiments/sharednet-9b-dynamic.template.json", import.meta.url);
const script = fileURLToPath(new URL("./check-experiment-protocol.mjs", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sharednet-protocol-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(templateUrl, "utf8"));
  manifest.state = "frozen";
  manifest.frozen_at = "2026-11-11T20:00:00.000Z";
  manifest.unresolved_decisions = [];
  const save = async () => writeFile(join(root, "protocol.json"), JSON.stringify(manifest, null, 2));
  const artifact = async (key, document) => {
    const content = JSON.stringify(document);
    const path = `${key}.json`;
    await writeFile(join(root, path), content);
    manifest.artifacts[key] = { path, sha256: digest(content) };
  };
  for (const key of Object.keys(manifest.artifacts).filter(key => key !== "approval")) {
    await artifact(key, { fixture: "Synthetic evidence; not a real experiment." });
  }
  const approve = async () => artifact("approval", {
    approved: true,
    protocol_id: manifest.protocol_id,
    approved_at: manifest.frozen_at,
    reviewers: ["synthetic-reviewer"],
    artifact_sha256: Object.fromEntries(Object.entries(manifest.artifacts).filter(([key]) => key !== "approval").map(([key, entry]) => [key, entry.sha256])),
  });
  await approve();
  await save();
  return { root, manifest, save, artifact, approve, path: join(root, "protocol.json") };
}

test("the checked-in draft cannot authorize an experimental freeze", async () => {
  const result = await checkExperimentProtocol(fileURLToPath(templateUrl));
  assert(result.errors.some(error => error.includes("state must be frozen")));
  assert(result.errors.some(error => error.includes("unresolved_decisions")));
  assert(result.errors.some(error => error.includes("unresolved value")));
});

test("a complete approved bundle validates read-only and the CLI returns its exact digest", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.path);
  const result = await checkExperimentProtocol(f.path);
  assert.deepEqual(result.errors, []);
  assert.equal(result.sha256, digest(before));
  assert.match(execFileSync(process.execPath, [script, f.path], { encoding: "utf8" }), new RegExp(result.sha256));
  assert.deepEqual(await readFile(f.path), before);
});

test("removing a required evidence category or changing the study design blocks freezing", async (t) => {
  const f = await fixture(t);
  delete f.manifest.artifacts.sft_recipe;
  f.manifest.design.team_size = 5;
  await f.save();
  const { errors } = await checkExperimentProtocol(f.path);
  assert(errors.some(error => error.includes("Missing required artifact: sft_recipe")));
  assert(errors.some(error => error.includes("design must match")));
});

test("the freeze gate rejects another provider, endpoint or enabled native subagents", async (t) => {
  const f = await fixture(t);
  const design = { ...f.manifest.design, model_provider: "OpenRouter", model_api_base_url: "https://openrouter.ai/api/v1", native_subagents_enabled: false };
  f.manifest.design = design;
  await f.save();
  assert.deepEqual((await checkExperimentProtocol(f.path)).errors, []);
  for (const [field, value] of [
    ["model_provider", "Other"],
    ["model_api_base_url", "https://example.invalid/api/v1"],
    ["native_subagents_enabled", true],
  ]) {
    f.manifest.design = { ...design, [field]: value };
    await f.save();
    assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("design must match")), field);
  }
});

test("changed bytes and stale approvals cannot silently reuse a freeze", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, "runner_build.json"), '{"changed":true}');
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("SHA-256 mismatch")));
  await f.artifact("runner_build", { changed: true });
  await f.save();
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("exact artifact inventory")));
  await f.approve();
  await f.save();
  assert.deepEqual((await checkExperimentProtocol(f.path)).errors, []);
});

test("hashing an unresolved or malformed JSON control document does not make it frozen", async (t) => {
  const f = await fixture(t);
  await f.artifact("launch_and_controls", { termination: null, budget: "TBD" });
  await f.approve();
  await f.save();
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("artifacts.launch_and_controls.termination: unresolved")));
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("artifacts.launch_and_controls.budget: unresolved")));
  await writeFile(join(f.root, "launch_and_controls.json"), "{");
  f.manifest.artifacts.launch_and_controls.sha256 = digest("{");
  await f.approve();
  await f.save();
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.startsWith("artifacts.launch_and_controls:")));
});

test("paths and symlinks cannot escape the protocol bundle", async (t) => {
  const f = await fixture(t);
  f.manifest.artifacts.runner_build.path = "../outside.json";
  await f.save();
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("bundle-relative JSON path")));
  const outside = await mkdtemp(join(tmpdir(), "sharednet-protocol-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.json"), '{"synthetic":true}');
  await symlink(join(outside, "outside.json"), join(f.root, "escape.json"));
  f.manifest.artifacts.runner_build.path = "escape.json";
  await f.save();
  assert((await checkExperimentProtocol(f.path)).errors.some(error => error.includes("escapes the protocol bundle")));
});

test("the CLI fails closed on draft and invalid input without writing a freeze", () => {
  const draft = spawnSync(process.execPath, [script, fileURLToPath(templateUrl)], { encoding: "utf8" });
  assert.equal(draft.status, 1);
  assert.match(draft.stderr, /draft protocols cannot authorize/);
  const missing = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Usage:/);
});
