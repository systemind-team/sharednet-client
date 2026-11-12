import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const template = JSON.parse(await readFile(new URL("../docs/experiments/sharednet-9b-dynamic.template.json", import.meta.url), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

function unresolved(value, path, errors) {
  if (value === null || (typeof value === "string" && (!value.trim() || /^(TODO|TBD|REPLACE_ME|CHANGEME)$/i.test(value.trim())))) {
    errors.push(`${path}: unresolved value`);
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) unresolved(child, `${path}.${key}`, errors);
  }
}

export async function checkExperimentProtocol(manifestPath) {
  const bytes = await readFile(manifestPath);
  const manifest = JSON.parse(bytes.toString("utf8"));
  const errors = [];
  if (!object(manifest)) return { errors: ["Protocol must be a JSON object."], sha256: digest(bytes) };
  if (manifest.format !== template.format) errors.push(`format must be ${template.format}`);
  if (typeof manifest.protocol_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.protocol_id)) errors.push("protocol_id must be a versioned identifier");
  if (manifest.state !== "frozen") errors.push("state must be frozen; draft protocols cannot authorize formal runs");
  if (typeof manifest.frozen_at !== "string" || !Number.isFinite(Date.parse(manifest.frozen_at)) || new Date(manifest.frozen_at).toISOString() !== manifest.frozen_at) errors.push("frozen_at must be a canonical UTC timestamp, including milliseconds");
  if (!isDeepStrictEqual(manifest.design, template.design)) errors.push("design must match the four-seat, one-learner, dynamic A/B/C study");
  if (!Array.isArray(manifest.unresolved_decisions) || manifest.unresolved_decisions.length !== 0) errors.push("unresolved_decisions must be an empty array before freezing");
  unresolved(manifest, "manifest", errors);
  if (!object(manifest.artifacts)) return { errors: [...errors, "artifacts must be an object"], sha256: digest(bytes) };
  for (const key of Object.keys(template.artifacts)) {
    if (!Object.hasOwn(manifest.artifacts, key)) errors.push(`Missing required artifact: ${key}`);
  }
  const root = await realpath(dirname(resolve(manifestPath)));
  const documents = Object.create(null);
  for (const [key, entry] of Object.entries(manifest.artifacts)) {
    if (!object(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") {
      errors.push(`artifacts.${key}: path and sha256 are required strings`);
      continue;
    }
    if (isAbsolute(entry.path) || entry.path.includes("\\") || !entry.path.endsWith(".json") || entry.path.split("/").some(part => !part || part === "." || part === "..") || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      errors.push(`artifacts.${key}: use a bundle-relative JSON path and lowercase SHA-256`);
      continue;
    }
    try {
      const path = await realpath(resolve(root, entry.path));
      if (!within(root, path)) throw new Error("artifact escapes the protocol bundle");
      const content = await readFile(path);
      if (digest(content) !== entry.sha256) throw new Error("SHA-256 mismatch");
      const document = JSON.parse(content.toString("utf8"));
      if (!object(document) || Object.keys(document).length === 0) throw new Error("artifact must be a nonempty JSON object");
      unresolved(document, `artifacts.${key}`, errors);
      documents[key] = document;
    } catch (error) {
      errors.push(`artifacts.${key}: ${error.message}`);
    }
  }
  const approval = documents.approval;
  const approvedHashes = Object.fromEntries(Object.entries(manifest.artifacts).filter(([key]) => key !== "approval").map(([key, entry]) => [key, entry?.sha256]));
  if (!approval || approval.approved !== true || approval.protocol_id !== manifest.protocol_id || !Array.isArray(approval.reviewers) || approval.reviewers.length === 0 || !approval.reviewers.every(reviewer => typeof reviewer === "string" && reviewer.trim()) || approval.approved_at !== manifest.frozen_at || !isDeepStrictEqual(approval.artifact_sha256, approvedHashes)) {
    errors.push("approval must name reviewers and approve this protocol ID, timestamp and exact artifact inventory");
  }
  return { errors, sha256: digest(bytes) };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/check-experiment-protocol.mjs <protocol.json>");
    const result = await checkExperimentProtocol(resolve(process.argv[2]));
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log(`Frozen protocol bundle validated; sha256=${result.sha256}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
