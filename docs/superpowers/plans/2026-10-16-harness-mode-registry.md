# Frozen harness mode registry implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every supported research harness an immutable `mode@version`, record its resolved behavior and provenance, and reserve honest dependency-marked names for the unmerged serve-backed runtime.

**Architecture:** A zero-dependency TypeScript registry is the single executable specification. `goal run --harness-mode` resolves one of the six available research profiles and refuses conflicting low-level flags; the two runtime profiles remain discoverable but unavailable until PR #48 lands. Goal episode records carry the selected spec hash, resolved controls, code/model/image provenance, and hashes of the goal and opening prompts.

**Tech Stack:** TypeScript 7, Node.js crypto/child_process, Vitest, existing SharedNet goal runner.

**Spec:** Xisen's approved Room request #1155 and the locked names in #1159.

## Global constraints

- Preserve existing `goal run` behavior when `--harness-mode` is omitted.
- Freeze exactly `research/{baseline,mentions,tasks,both,routing-only,receipt-only}@1` and `runtime/{serve-first,serve-all}@1`.
- Never present runtime modes as runnable while `goal serve-demo` remains in unmerged PR #48.
- Add all new files to `scripts/export-manifest.json`; add no runtime dependency.
- Do not edit the root README.

## Review focus

- A misspelled or unversioned name must fail before filesystem, Docker, or network work.
- A named profile combined with low-level gate/routing flags must fail instead of silently drifting.
- Research modes must refuse compiled Rooms because their mechanisms are board-specific.
- Unmerged runtime modes must name their dependency and never fall back to the research runner.
- An installed package without `.git` must record null commits rather than fail the run.

---

### Task 1: Executable immutable registry

**Files:**
- Create: `packages/cli/src/harness-modes.ts`
- Test: `packages/cli/src/harness-modes.test.ts`

- [ ] Write failing registry tests for all eight names, the six exact research profiles, immutability, stable hashes, malformed names, and unavailable runtime modes.
- [ ] Run the focused test and confirm it fails because the module is absent.
- [ ] Implement the registry, canonical hashing, and goal-run resolver.
- [ ] Run the focused test and confirm it passes.

### Task 2: CLI resolution and episode provenance

**Files:**
- Modify: `packages/cli/src/cli.ts`
- Modify: `packages/cli/src/cli.test.ts`
- Modify: `packages/cli/src/goal-run.ts`
- Modify: `packages/cli/src/goal-run.test.ts`

- [ ] Write failing CLI tests for early validation, conflicts, compiled Rooms, and PR #48 availability errors.
- [ ] Write a failing episode test for selected mode, spec hash, resolved profile, commits, models, image, goal hash, and per-seat opening-prompt hashes.
- [ ] Implement minimal CLI mapping and episode metadata, preserving ad-hoc compatibility.
- [ ] Run focused tests and confirm they pass.

### Task 3: Catalog and export boundary

**Files:**
- Create: `docs/harness-modes.md`
- Modify: `docs/goal-mode.md`
- Modify: `scripts/export-manifest.json`

- [ ] Document every mode's delivery, wake, stop, exact profile, availability, and provenance from the executable registry.
- [ ] Add new files to the export manifest and link the catalog from goal-mode documentation.
- [ ] Run export audit, typecheck, full tests, package smoke, and diff checks.
- [ ] Commit, push, and open a pull request without merging or publishing.
