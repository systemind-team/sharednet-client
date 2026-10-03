import assert from "node:assert/strict";
import test from "node:test";
import { auditFiles } from "./check-export.mjs";

const entry = "packages/cli/src/main.ts";
const helper = "packages/cli/src/helper.ts";
test("accepts a complete export with local and Node imports", () => {
  assert.deepEqual(auditFiles([
    { path: entry, content: 'import { x } from "./helper.ts"; import "node:fs";' },
    { path: helper, content: "export const x = 1;" },
  ], [entry, helper]), []);
});
test("rejects an unlisted file even when its name looks harmless", () => {
  assert.match(auditFiles([{ path: "notes.md", content: "internal" }], [entry]).join("\n"), /unlisted/);
});
test("rejects a private path even if someone adds it to the allowlist", () => {
  assert.match(auditFiles([{ path: "packages/server/src/db.ts", content: "" }], ["packages/server/src/db.ts"]).join("\n"), /forbidden/);
});
test("rejects missing allowlisted files", () => {
  assert.match(auditFiles([], [entry]).join("\n"), /missing/);
});
test("rejects private, unresolved and external runtime imports", () => {
  for (const specifier of ["../../server/src/repository.ts", "./missing.ts", "@/server", "some-sdk", "/private/client.ts"]) {
    const issues = auditFiles([{ path: entry, content: `import x from ${JSON.stringify(specifier)};` }], [entry]);
    assert.match(issues.join("\n"), /import/, specifier);
  }
});
test("checks dynamic imports and re-exports too", () => {
  for (const content of ['await import("./missing.ts")', 'export * from "./missing.ts"']) {
    assert.match(auditFiles([{ path: entry, content }], [entry]).join("\n"), /import/);
  }
});
test("allows test dependencies only in tests, never the shipped CLI", () => {
  const path = "packages/cli/src/main.test.ts";
  assert.deepEqual(auditFiles([{ path, content: 'import { it } from "vitest";' }], [path]), []);
  assert.match(auditFiles([{ path: entry, content: 'import "vitest";' }], [entry]).join("\n"), /import/);
});
test("rejects symlinks without following them", () => {
  assert.match(auditFiles([{ path: entry, content: "", symlink: true }], [entry]).join("\n"), /symlink/);
});
