# Automatic Goal Mode Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** An installed SharedNet Room skill selects Goal mode for explicit multi-agent execution requests and substantial parallelizable work, without requiring the user to name SharedNet.

**Architecture:** Expand the existing skill's discovery description and add a conditional execution router with a focused Goal reference. Reuse the released CLI; no server, runtime, dependency or npm-version changes are needed.

**Tech Stack:** Markdown skill, YAML interface metadata, JSON evaluation scenarios, existing CLI/CI checks, fresh-context model evaluations.

**Spec:** The user-approved proposal in this conversation: explicit team requests select Goal mode with the requested headcount; large tasks qualify only when independent workstreams and a concrete deliverable justify parallel work; default four workers; simple tasks, explicit solo work and explicitly selected alternative execution systems retain their requested path. User subsequently authorized modification, shipping and trigger-rate tests.

## Global Constraints

- Preserve existing Room joining, retrieval, identity and authority instructions.
- Installation enables implicit selection; selection is model-dependent, not a guaranteed harness hook.
- Goal execution requires local Node, Docker, account and driver authentication; MCP Room tools alone do not start model workers.
- State task, acceptance criteria, headcount and finite runtime before starting; require actual startup evidence before reporting a working team.
- A source merge updates the distributable skill, not already installed copies or the join-only `/skill.md` endpoint.
- Keep runtime code unchanged and explicitly list every new repository path in the export manifest.

## Review Focus

- Large numerical tasks without a SharedNet keyword must be discoverable.
- Conceptual team questions, trivial edits and explicit solo/alternative-framework tasks must not spawn workers.
- Existing Room collaborators and nested Goal workers must not start duplicate teams.
- Read-only, missing-Docker and connector-only environments must not claim workers started.
- Trigger-test errors and prompted dry-run decisions must not be presented as native end-to-end trigger success.

### Task 1: Freeze the baseline and demonstrate the missing route

- [x] Freeze the unchanged skill, bilingual cases, expected labels and evaluation settings.
- [x] Run fresh-context baseline samples before editing the skill; preserve raw responses and observed misses.

### Task 2: Add the conditional Goal execution route

- [x] Update `skills/sharednet-room/SKILL.md` discovery and routing.
- [x] Add `skills/sharednet-room/references/goal-mode.md` with prerequisites, one real CLI example, startup evidence and bounded execution.
- [x] Update interface metadata and route the existing account reference to the new focused reference.
- [x] Add evaluation scenarios and export-manifest entries; preserve source import hashes.

### Task 3: Measure, review and ship

- [ ] Run the same frozen cases/settings against the candidate, including at least five fresh repetitions for key trigger conditions; report false positives and errors separately.
- [ ] Inspect routing pressure samples and all disputed/flagged decisions; document the test's actual scope.
- [ ] Run skill validation, export audit, types, tests, package smoke and secret scan/CI.
- [x] Obtain independent whole-change review and address material findings.
- [ ] Commit, push, open a PR, require green CI, merge and verify the default-branch skill bytes.
