# Durable Native Reply Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for implementation; independent storage work and whole-branch review run separately. Steps use checkbox syntax.

**Goal:** A completed driven native turn must retain its reply across failed POST/ACK and listener restart, without rerunning the completed model/tool turn.

**Architecture:** Save exact normalized reply bytes (including a null no-reply result), original input span, actor/Room/origin and stable idempotency key before POST. Persist a validated committed message receipt before strict cumulative ACK; remove only after confirmed ACK. Recover before reading/promoting cursor mirrors or checking the native harness. `serve --run`, open-chat handoffs, busy and left delivery retain their existing separate semantics.

**Tech Stack:** TypeScript, Node filesystem atomic rename/fsync, existing HTTP API, Vitest; no runtime dependencies.

**Spec:** User's build/ship instruction in original Room #1605; review Room #19/#23 recovery contract and #26/#29/#32 implementation split.

## Scope and choices

Retrying the whole turn can repeat tools; in-memory retry loses the reply on restart. A durable completed-result outbox is the selected fix for the reproduced POST/ACK defect. This does not claim exactly-once execution across a crash before result persistence; native execution ownership/unknown in-flight reconciliation belongs to the host executor. No owner credentials or raw harness transcripts enter the outbox.

## Review Focus

- Lost POST response must reuse identical bytes/key and await a real receipt.
- Failed ACK must retain committed receipt and never promote a cursor prematurely.
- Null output and failed/timed-out notices have the same durable completion barrier.
- Pending output recovers despite missing/broken/changed wake configuration.
- Origin/Room/member mismatch, unsafe storage and malformed state stop safely.

### Task 1: Durable outbox storage

**Files:** reply-outbox.ts, reply-outbox.test.ts, minimal exports in storage.ts.

- [x] Write failing tests for persistence/validation/security and run them red.
- [x] Implement owner-only atomic/fsynced storage and durable deletion.
- [x] Run storage tests green and commit storage files.

### Task 2: Driven serve integration

**Files:** guest.ts, guest.test.ts, docs/wake-plugins.md, scripts/export-manifest.json.

- [x] Write failing behavioral tests for rejected POST, committed-reply ACK failure and invalid receipt; run them red.
- [x] Persist completed results; flush exact POST/strict ACK before advancing cursor; recover pending delivery before harness checks and cursor initialization.
- [x] Add lost-response, empty-output, notice, restart and missing-wake coverage.
- [x] Run whole test suite, typecheck, export check and package smoke; independently review and create PR/pinned artifact for host integration.

## Review and verification record

Independent review found and reproduced authoritative ACK advancement losing its in-memory cursor and an installed recovery-only seat remaining stopped after wake-on. Both received failing regressions before their fixes. A disk-write fault test failed on raw ENOSPC before storage errors became terminal per-seat errors. The reviewer found no remaining blockers after inspecting these changes. Full guest/outbox tests:262 passed. An earlier whole suite with35storage cases plus9integration cases encountered the existing Muse join test's5s timeout and cleanup ENOTEMPTY under concurrent load (915 passed,1 failed,1 skipped); final whole suite reran with two workers:919 passed,1 existing opt-in skipped, plus16process tests passed. Typecheck and export audit passed. The timed-out unbounded run remains recorded; it is not a green gate.

Final candidate installed-package smoke passed, SHA-256 `3aa14a8cfdc0741f3eb1c61f9ce09f5cc07e613cd94be8f5f4d1f975f976d7bd`. Trusted-service exact-tarball smoke passed against the actual HTTP handler. Independent fault proof on that same package passed3/3: lost committed POST response, rejected POST and failed ACK; one stand-in turn and one stored reply per recovered case. Service fixture commit00bbcb51c6b01602afc4be2bf2b3c874503f1477; this is real loopback HTTP with a synthetic memory repository, not PostgreSQL, an actual native model or hosted Vercel. PR: sharednet-client#76. Node22/24/26 CI passed on the code commit; the scanner reported the fixed synthetic UUID fixture, now narrowly allowed by exact test path and exact literal line. The same checksum-pinned scanner then passed locally over complete history.

The subsequent Node22 CI run exposed a test-fixture race in wake-on recovery: the test rewrote a credential with truncating writeFile while the live listener read it. The test now uses production writeRoomCredential's atomic replacement, matching wake set behavior. Node24/26 and secrets were green; all three matrix jobs rerun on the corrected fixture. Runtime package bytes are unchanged.
