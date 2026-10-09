# Task titles and before-say mentions implementation plan

> **For agentic workers:** Use superpowers:executing-plans for native execution of the user's explicit implementation request. Steps use checkbox syntax for tracking.

**Goal:** Add two independent, opt-in client mechanisms and compare broadcast, mentions-before-say, tasks, and both.

**Architecture:** Preserve broadcast by default; the @ arm uses existing targeted wake semantics plus the new before-say gate. Task claims/completions are versioned board messages projected in server sequence order. Before-say checking retrieves unread addressed messages and returns them instead of posting. A per-seat local task marker gates login-shell work in agent containers.

**Tech Stack:** Existing TypeScript CLI, Node built-ins, bash, Vitest, Docker. No service changes or runtime dependencies.

**Spec:** User's 2026-10-09 request in this conversation: three task commands, sequence-based competition, local bash gate, before-say mention injection, four experimental arms.

## Global constraints

- Preserve existing default CLI behavior; opt in with `goal run --mention-gate` and/or `--task-gate`. Mention mode retains the prior selective wake policy, with an explicit `--message-routing broadcast` override for gate-only ablation.
- Task identity is title with whitespace removed and case folded to lowercase. Empty titles are invalid. First valid claim permanently owns a title; only that owner can mark it done. Completed titles cannot be claimed again.
- Derive ownership from authenticated message sender, never a claimed actor in message content.
- Concurrent claims append then replay all ascending pages through their own committed sequence. Lowest sequence wins. Refuse malformed/incomplete pagination or a missing committed post. This relies on the service returning complete ordered pages, not integer-contiguous sequences.
- Mention watermark is max(runner-provided turn `through`, locally recorded read maximum), as requested. This is a sequence watermark, not a comprehension guarantee; partial/filtered reads can overstate coverage.
- Before-say refusals return addressed message contents, advance the local read watermark, and require an explicit retry. No automatic reply or replay of the rejected outgoing text. Apply to task claim/done too.
- Shell checks only local state. Keep sharednet-only commands usable without a held task; reject compound commands that could do work through this exception.
- No claim that bash gates all Codex tools: direct apply_patch and non-shell tools require trace auditing. These are cooperation controls, not a hostile-agent security sandbox.
- Preserve historical data. New matched controls use identical strict standalone DONE, visible build check, model and limits; historical baselines remain historical comparisons.

## Review focus

- Concurrent same-title claims must produce one winner, including stale prechecks and paginated histories.
- Another sender's done or a forged actor field must not release ownership.
- A read/mention-gate update cannot change the existing wait/ack cursor.
- Gate rejection must not publish outgoing text; retry should pass unless another addressed message arrived.
- Shell exception must not allow `sharednet ...; work`, substitutions, or redirections without a task; quoted message punctuation should remain usable.

## Tasks

- [x] 1. Test title projection and same-title competition, then implement `board-controls.ts`; test pagination completeness through the claimed sequence.
- [x] 2. Test before-say receipt refusal, watermarks and room/seat isolation; integrate task commands and read accounting into `guest.ts` without changing wait/ack.
- [x] 3. Execute a real bash guard under held/empty state and quoted/compound commands; wire optional flags, per-turn watermark and per-seat paths into `goal-run.ts`/`cli.ts`.
- [ ] 4. Run all repository tests, types, export checks and package smoke. Add docs and explicit export paths. Commit and prepare a reviewable PR.
- [x] 5. Run a no-model two-seat probe against a real service using the exact candidate: concurrent claim race, mid-turn @ followed by rejected say and successful retry, publish-to-receipt timing.
- [ ] 6. Freeze four-arm inputs, run two ProgramBench tasks with three agents and matched stop rules. Grade frozen submissions and audit exact receipts, crossed posts, tokens, time and non-shell edits made without a held task. Report exploratory limits and infrastructure failures separately.
