# Client foundation implementation plan

> **For agentic workers:** Execute inline using superpowers:executing-plans.

**Goal:** Deliver an independently buildable CLI and Skill workspace through a PR, with preserved client tests and verified installable artifacts.

**Architecture:** One client monorepo. Import an explicit file allowlist from a pinned service snapshot without private git history. Retain real-service tests in the service repository and verify this exact tarball against them before reporting acceptance.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Node 22.18+/24/26, GitHub Actions.

**Spec:** `docs/roadmap.md`; this is the foundation milestone, not the MCP or source-cutover milestone.

## Global constraints

- Keep package name `sharednet`, version 0.1.8 and current runtime behavior; no release is authorized.
- No private history, server code, account state or credentials in the export.
- No merge, publication, visibility change, cron or automatic release workflow.
- All pure client tests run; real-server tests stay in the private source and must not be replaced with mocks.
- CLI has no external runtime dependencies; packages and tests must work without a sibling checkout.

## Review focus

- A tarball missing compiled files must fail clean-install smoke.
- A workspace/private import must fail the export boundary check.
- Mixed-file extraction must preserve every pure client test.
- Skill example flags must remain accepted by the CLI parser without reaching a live service.
- Commands run in smoke must use disposable user/project directories, never host credentials.

## Task 1: Import the client workspace and preserve tests

Files: `packages/cli/**`, `skills/sharednet-room/**`, workspace/TypeScript/Vitest configuration, `scripts/export-manifest.json`.

Consumes: reviewed CLI and Skill files at source commit `142ae999ddaf372a78fcb26a065b1dba675170fc`.
Produces: `pnpm test`, `pnpm typecheck`, `pnpm build`; compiled `packages/cli/dist`.

- [ ] Copy test files first; classify individual real-handler cases in guest/login and keep their names in the manifest.
- [ ] Import exactly the corresponding CLI implementation and Skill, with file hashes for provenance. Exclude the four-session server e2e file and only the three real-handler cases, not whole mixed files.
- [ ] Configure a private root workspace with only `packages/cli` initially; do not add placeholder MCP/core/contract packages.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`. Expected: all client cases pass; no private import resolution.
- [ ] Commit the independently buildable snapshot with a why body and agent trailer.

## Task 2: Enforce export and package boundaries

Files: `scripts/check-export.mjs`, its Node tests, `scripts/package-smoke.mjs`, `.gitleaks.toml`.

Consumes: Task 1 CLI source and package manifest.
Produces: `pnpm check:export`, `pnpm test:package`, candidate tarball and SHA-256 under ignored `artifacts/`.

- [ ] Write boundary tests with a valid miniature export, a private import, an unlisted sensitive path and a missing manifest entry. Run them before adding the checker; expected RED for missing enforcement.
- [ ] Implement explicit tree/file checks, import boundaries and non-printing secret checks. Run tests; expected GREEN.
- [ ] Pack then install into an empty temporary consumer with install scripts disabled. Verify files, package name/version, dependency absence, ESM import and executable usage error using isolated HOME/XDG/cwd. Keep the artifact and hash for service verification.
- [ ] Add Skill command contract tests with temporary state and a fetch sentinel. Expected: supported examples pass parsing and unknown flags are rejected; no live requests.
- [ ] Run `pnpm check:export`, `pnpm test:package`, full test suite and Gitleaks. Expected: no private files, package defects or credential findings.

## Task 3: CI, contributor documentation and real-service evidence

Files: `.github/workflows/ci.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `.claude-plugin/plugin.json`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/TESTING.md`, `docs/roadmap.md`, `docs/verification.md`.

Consumes: Task 2 verification commands and artifact.
Produces: PR checks on supported Node lines, a reviewable release boundary and documented current limitations.

- [ ] Wire credential-free public PR CI to frozen install, typecheck, tests, build, boundary/secret scan and installed-package smoke. No privileged fork workflow or publishing.
- [ ] Document CLI and Skill install paths, package version, canonical-source transition, and the missing MCP/source-cutover milestones honestly.
- [ ] Run the service's existing `cli-package-smoke.mjs --package <absolute tarball>` against this artifact. Expected: real HTTP handler, filtering/cursors and binary artifact round-trip pass. Record exact source and artifact hashes.
- [ ] Run a fresh-context branch review, fix important findings and rerun affected checks. Document any unverified PostgreSQL/MCP/release gates.
- [ ] Push an empty bootstrap base and the feature branch, open a draft PR against that base, attach it to the task and report CI status. The base contains no product files or private history.
