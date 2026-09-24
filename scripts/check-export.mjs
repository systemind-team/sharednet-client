import { readdir, readFile } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";

await init();

const forbidden = /(^|\/)(?:\.env[^/]*|\.sharednet|credentials\.json|\.DS_Store)(?:\/|$)|^packages\/(?:server|db)\//;

/** Pure boundary check: report paths and import locations, never file contents. */
export function auditFiles(files, allowedFiles) {
  const allowed = new Set(allowedFiles);
  const present = new Set(files.map((file) => file.path));
  const issues = [];
  for (const path of allowed) if (!present.has(path)) issues.push(`missing: ${path}`);
  for (const file of files) {
    if (!allowed.has(file.path)) issues.push(`unlisted: ${file.path}`);
    if (forbidden.test(file.path)) issues.push(`forbidden: ${file.path}`);
    if (file.symlink) { issues.push(`symlink: ${file.path}`); continue; }
    if (!file.path.startsWith("packages/cli/") || !/\.(?:ts|js)$/.test(file.path)) continue;
    const isTest = file.path.endsWith(".test.ts");
    for (const imported of parse(file.content, file.path)[0]) {
      if (imported.type === "import-meta") continue;
      const name = imported.specifier;
      if (typeof name !== "string") { issues.push(`computed import: ${file.path}`); continue; }
      if (name.startsWith("node:")) continue;
      if (isTest && name === "vitest") continue;
      const target = posix.normalize(posix.join(posix.dirname(file.path), name));
      // The bin imports generated output, which packaging checks separately.
      if (file.path === "packages/cli/bin/sharednet.js" && name === "../dist/main.js") continue;
      if (name.startsWith(".") && target.startsWith("packages/cli/") && present.has(target)) continue;
      issues.push(`forbidden or unresolved import: ${file.path}`);
    }
  }
  return issues;
}

async function collect(root, prefix = "") {
  const files = [];
  for (const item of await readdir(resolve(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.name === "node_modules" || [".git", ".superpowers", "artifacts", "packages/cli/dist"].includes(path)) continue;
    if (item.isSymbolicLink()) files.push({ path, content: "", symlink: true });
    else if (item.isDirectory()) files.push(...await collect(root, path));
    else files.push({ path, content: await readFile(resolve(root, path), "utf8") });
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(await readFile(resolve(root, "scripts/export-manifest.json"), "utf8"));
  const files = await collect(root);
  const issues = auditFiles(files, [...Object.keys(manifest.files), ...manifest.repositoryFiles]);
  if (issues.length) {
    console.error(issues.join("\n"));
    process.exitCode = 1;
  } else console.log(`Export boundary passed (${files.length} allowlisted files).`);
}
