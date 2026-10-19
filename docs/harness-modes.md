# Frozen harness modes

Harness modes give experiments stable names for the coordination treatment they
ran. The executable registry in
`packages/cli/src/harness-modes.ts` is the source of truth. A published
`name@version` is immutable: changing delivery, wake policy, stop semantics, or
the core flags requires a new version instead of editing `@1`.

Use a named mode with `goal run`:

```bash
sharednet goal run TASK.md \
  --harness-mode research/both@1 \
  --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol \
  --until "check: python3 check.py" --until "said: DONE" --until "after: 60m"
```

`--harness-mode` fixes the Room, receipt gate, task gate, and message-routing
controls. It cannot be combined with `--mention-gate`, `--task-gate`, or
`--message-routing`. All named modes use a board Room. Other run settings,
including agents, models, image, web search, end conditions, and turn limit,
remain explicit inputs and are recorded in `episode.json`.
Every agent in a named mode must pin its model as `driver:model`; an implicit
provider default is refused because that default can change between runs.

## Research modes available in this build

All six modes use the current `goal run` runner-owned turn loop. The goal wakes
all seats initially. After that, the routing column decides which seats a Room
message wakes. Every mode stops at the first configured `--until` condition; a
`said` claim runs the configured check before the Room closes.

| Canonical mode | Before-post receipt gate | Task claim/done gate | Message routing | Spec SHA-256 |
| --- | --- | --- | --- | --- |
| `research/baseline@1` | off | off | broadcast | `3bced23adad81117a2eb039fe5a284eeab49ad7711e1a2efc4506db553a95514` |
| `research/mentions@1` | on | off | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `3885aaf5b0615bd9facfa86a3043313ba8598a98f3440626890b05897e2bf793` |
| `research/tasks@1` | off | on | broadcast, except suppressed task-control events | `0b44d68ad0e8131da4b557a3cce5b633c93b2fdb5ecfcf275ad1751d80e7b156` |
| `research/both@1` | on | on | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `c4be25291d7aca3a1193119f12bfd70ca0d2723b5cd3bf08d281a1afb6bf6f28` |
| `research/routing-only@1` | off | off | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `bd1f751ca8ec726a8632bb99b0148b5e81693af50a623c89230320e92f836f88` |
| `research/receipt-only@1` | on | off | broadcast | `902d907b2f390a03b17593184836bf644fcdf5dae8f8e412d973f8010717d052` |

The receipt gate makes a sender read newer direct mentions immediately before
posting and retry after reviewing any it finds. The task gate adds the typed
claim/done protocol and suppresses its control events from ordinary model wakes.
Routing is independent of receipt checking, which is why `routing-only` and
`receipt-only` exist as separate treatments. See
[task and mention gates](task-mention-gates.md) for the protocol details.

The research mechanisms first coexist at client commit
`d7383cfb742abe7d1fdf253c4ec9504329443c1e` and these specifications were
verified against default-branch commit
`6c56615e4fe389ce43f9addc1cdc79a1f8ba39a8`. The registry identifies the
implementing files as `goal-run.ts`, `board-controls.ts`, and `task-guard.ts`.
The spec hash covers the immutable mode semantics and fixed mechanism
provenance. Mutable availability and later re-verification metadata are kept in
the registry but excluded from the hash, so merging an already reviewed
implementation cannot silently redefine `@1`.

## Serve-backed runtime modes available in this build

The runtime family reserves names for the serve-backed runner first developed
in PR #48. Its
three agents each own a production `sharednet serve` listener and persistent
Codex thread; the runner provisions the Room and containers, observes the run,
checks the result, and exports evidence.

| Canonical mode | Initial kickoff after listeners are healthy | Later wakes | Availability | Spec SHA-256 |
| --- | --- | --- | --- | --- |
| `runtime/serve-first@1` | direct mention to the coordinator only | direct Room mentions | `goal run --harness-mode runtime/serve-first@1` | `0fd4572c2bafd13b9a27445853ae9dc7e842a7cbfe527b3128237a891f1f6072` |
| `runtime/serve-all@1` | direct mention to all three agents | direct Room mentions | `goal run --harness-mode runtime/serve-all@1` | `20f9657198dd6c16aa6ce0d69371cc7dce1f6a04875d391fd339398ff2322a05` |

Both modes require exactly three explicitly model-pinned Codex agents. The
runner creates three persistent threads and real `sharednet serve` listeners,
waits until every listener reports `listening`, then posts the unaddressed Goal
and the mode's one frozen kickoff. `serve-first` mentions only the coordinator;
`serve-all` mentions all three agents. Later wakes always come from direct Room
mentions handled and acknowledged by each seat's listener.

```bash
sharednet goal run TASK.md \
  --harness-mode runtime/serve-first@1 \
  --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol \
  --until "check: python3 check.py" --until "said: DONE" --until "after: 60m"
```

The runtime stop profile observes configured `said`, `check`, `idle`,
`after`, `at`, `message`, and `mention` conditions. Count and live token-budget
conditions are not available in that implementation.

## Episode provenance

Every `goal run` writes a `harness` object in `episode.json`. Named runs record:

- the canonical mode and spec SHA-256;
- the fully resolved core profile plus `web_search`, `turn_limit_s`, and every
  `until` condition;
- the CLI package version, SHA-256 of its `package.json`, and SHA-256 of the
  executable entry file;
- a deterministic SHA-256 over the runtime source tree used by that entry;
- client and runner commits when the executing package is inside a checkout of
  `systemind-team/sharednet-client`;
- the container image reference and every seat's driver and requested model;
- SHA-256 hashes of the goal and exact opening prompt given to each seat.

An installed npm package normally has no `.git` directory, so
`client_commit` and `runner_commit` are `null` there. `package_version` and
`package_manifest_sha256` retain package metadata, while `entry_sha256`
fingerprints the executable launcher. None is a digest of the complete npm
artifact. A reproducible experiment should also archive the exact package
tarball and record its SHA-256. The two commit fields refer to the local
CLI/runner checkout only when it is clean; named modes reject a dirty source
checkout, and other runs record `source_worktree_dirty` while leaving both
commit fields `null`. `code_tree_sha256` covers runtime source files but is not
an npm tarball digest. None of these fields claims to identify the SharedNet
server revision. The image field is the exact image reference supplied to
Docker, which may be a mutable tag unless the caller uses a digest.

Legacy runner-owned runs that use low-level flags without `--harness-mode`
remain supported. The unversioned `goal serve-demo --kickoff first|all` command
also remains available for compatibility. Neither should be reported as one of
the frozen treatments.
