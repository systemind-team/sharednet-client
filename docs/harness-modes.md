# Frozen harness modes

Harness modes give experiments stable names for the coordination treatment they
ran. The executable registry in
`packages/cli/src/harness-modes.ts` is the source of truth. A published
`name@version` is immutable: changing delivery, wake policy, stop semantics, or
the core flags requires a new version instead of editing `@1`.

Use an available research mode with `goal run`:

```bash
sharednet goal run TASK.md \
  --harness-mode research/both@1 \
  --agent codex --agent codex --agent codex \
  --until "check: python3 check.py" --until "said: DONE" --until "after: 60m"
```

`--harness-mode` fixes the Room, receipt gate, task gate, and message-routing
controls. It cannot be combined with `--mention-gate`, `--task-gate`, or
`--message-routing`. All research modes use a board Room. Other run settings,
including agents, models, image, web search, end conditions, and turn limit,
remain explicit inputs and are recorded in `episode.json`.

## Research modes available in this build

All six modes use the current `goal run` runner-owned turn loop. The goal wakes
all seats initially. After that, the routing column decides which seats a Room
message wakes. Every mode stops at the first configured `--until` condition; a
`said` claim runs the configured check before the Room closes.

| Canonical mode | Before-post receipt gate | Task claim/done gate | Message routing | Spec SHA-256 |
| --- | --- | --- | --- | --- |
| `research/baseline@1` | off | off | broadcast | `1308f26bd0a3971ed849cd54137c7682f698886f04f1b146c28d544994e7ef6e` |
| `research/mentions@1` | on | off | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `c9c829694d5d4c4b32d78472d527e8c2d974ae7f302ee2f7382edae6ccd13fa2` |
| `research/tasks@1` | off | on | broadcast, except suppressed task-control events | `a8f948230e2b31317976ca54650664f3266f475cfbe75d666e3b943ba387f946` |
| `research/both@1` | on | on | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `0d980fc6078cb33f8e47865b27b863ac1d9244b995ed131a0226c434ff6ef0b5` |
| `research/routing-only@1` | off | off | direct mentions; broadcast for no mention, `@all`, or unknown-only mentions | `b309cec7c4ac84dc0131316d37cca11ad0aca30c2f3ca8b1fa153ddc63443c30` |
| `research/receipt-only@1` | on | off | broadcast | `e3bfe45c699a7840cf46f328b189c41ce2f9175f9f814abb74416ac2e081361e` |

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
The spec hash covers the complete canonical registry entry, including this code
provenance.

## Reserved runtime modes

The runtime family describes the serve-backed runner developed in PR #48. Its
three agents each own a production `sharednet serve` listener and persistent
Codex thread; the runner provisions the Room and containers, observes the run,
checks the result, and exports evidence.

| Canonical mode | Initial kickoff after listeners are healthy | Later wakes | Availability | Spec SHA-256 |
| --- | --- | --- | --- | --- |
| `runtime/serve-first@1` | direct mention to the coordinator only | direct Room mentions | unavailable; depends on unmerged PR #48 | `948fb48a7b96829e2b7ba88426d968f8ddfc25de0e4dcdfb07386e1fefa09cc6` |
| `runtime/serve-all@1` | direct mention to all three agents | direct Room mentions | unavailable; depends on unmerged PR #48 | `5d58dbd0b2aaa183199e3f2bc7254129cac39cd0c054e41b0ccc9d465905bbf2` |

These two names are dependency-only reservations in the current default-branch
build. Passing either name to `goal run --harness-mode` fails before creating a
Room or starting Docker. They must not be reported as executed modes until the
`goal serve-demo` implementation is merged and explicitly wired to the
registry. The frozen dependency points to reviewed PR head
`e77597df9e2fae3d83c8c518c1c815eb7a3ede5d`; a changed implementation requires
re-verification and may require a new mode version.

The reserved runtime stop profile observes configured `said`, `check`, `idle`,
`after`, `at`, `message`, and `mention` conditions. Count and live token-budget
conditions are not available in that implementation.

## Episode provenance

Every `goal run` writes a `harness` object in `episode.json`. Named runs record:

- the canonical mode and spec SHA-256;
- the fully resolved core profile plus `web_search`, `turn_limit_s`, and every
  `until` condition;
- the CLI package version, SHA-256 of its `package.json`, and SHA-256 of the
  executable entry file;
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
CLI/runner checkout when available; they do not claim to identify the SharedNet
server revision. The image field is the exact image reference supplied to
Docker, which may be a mutable tag unless the caller uses a digest.

Legacy runs that use the low-level flags without `--harness-mode` remain
supported. Their record contains the resolved ad hoc profile, with `mode` and
`spec_sha256` set to `null`; such runs should not be reported as one of the
frozen treatments.
