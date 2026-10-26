# Automatic Goal mode: trigger evaluation

Date: 2026-10-26. Change: [PR #66](https://github.com/systemind-team/sharednet-client/pull/66).

[Auditable evidence JSON](2026-10-26-goal-mode-trigger-eval.json) includes
455 compact scored decisions, expected/actual labels, snapshot/fixture hashes,
protocols, manual audits and separately excluded setup/development trials.

The Room skill now applies to requested execution teams and substantial
parallelizable work with a verifiable result, even when the request does not
name SharedNet. Its automatic Goal route preserves explicit solo/framework
instructions, sequential tasks, existing-Room operations and assigned-worker
boundaries. The default is four workers; requested headcounts take precedence.

## Frozen inputs

- Baseline source: `7c52c8ac5a593270066c030b42f89ae08c67e5eb`.
- Baseline SKILL.md SHA-256: `ba6c51109177b2c46c5850408249445e8f4d227ca2600dd39182660ed2475582`.
- Final SKILL.md SHA-256: `ec70e0a361b7422096fea2792e4ab2bb8bd823087168303b52b0e7616818ba22`.
- [Frozen discovery fixture](../../skills/sharednet-room/evals/goal-mode-triggers.json): 25 English/Chinese requests, five independent fresh-context repetitions each per condition. Original fixture SHA-256: `6ef9d975386a54b203073fc63dcfe548ee51b4b7524aab222957506c8de5041f`.
- Model: `gpt-6.1-sol`, low reasoning effort. Samples do not share a model conversation. The same model, prompts, competing catalog and scoring labels are used for baseline and final conditions.

The fixture includes explicit team requests, implicit multi-part builds,
implicit 5,000-contact research, existing Rooms, simple changes, solo work,
selected alternative frameworks, conceptual questions, ordinary parallel
commands, a physical living room, sequential reasoning and assigned workers.
Expectations were fixed before the candidate was evaluated.

## Prompted catalog selection

This is a controlled **simulation of catalog selection**, not a measurement
of native skill invocation. Each call sees only the skill name/description in
a fixed competing catalog, a quoted user request and a JSON decision schema.
No tools or real task execution are allowed. It measures whether the stated
trigger conditions select `sharednet-room`, separately from execution routing.

| Discovery result | Baseline | Final |
| --- | ---: | ---: |
| Positive requests selected | 30/60 (50%) | 60/60 (100%) |
| Negative requests incorrectly selected | 12/65 (18.5%) | 0/65 (0%) |
| Precision | 71.4% | 100% |
| Valid samples / infrastructure errors | 125 / 0 | 125 / 0 |

All 30 implicit large-task samples were missed by the baseline; the final
selected all 30. Ten were the English/Chinese 5,000-contact research requests.
Existing-Room operations are discovery positives but must not launch workers.

The negative fixture deliberately scores implicit selection by assigned
workers strictly. Nine baseline false positives were in that category, where
loading instructions that prevent recursion can be defensible. Excluding
those ten samples, baseline false positives were 3/55 (5.5%) and final false
positives were 0/55. Execution-routing results must be considered separately
from these discovery labels.

## Review-driven regression

Independent review found the first candidate's exclusion wording could
suppress explicit Room operations by solo agents. Fresh tests reproduced it:
only 1/5 solo-plus-explicit-Room requests selected the skill. The final wording
scopes those exclusions to implicit team selection, retaining explicit Room
operations in any role. It also distinguishes building software containing
agents from requesting agents to perform development.

All 15 final samples across the separate three-case regression fixture were
correct, including 5/5 solo-plus-Room and 5/5 assigned-worker-plus-Room cases.
These are regression tests added after review, not an untouched holdout set.

## Full-body execution routing

Ten targeted requests were each repeated five times with the complete frozen
skill and its linked references supplied. The evaluator distinguishes
`goal_run` (start workers), `room_create_goal` (a goal Room for agents that
already exist), `existing` Room operations and `none`. Merely creating a goal
Room cannot be scored as starting workers.

Baseline route decisions were correct in 27/50 samples (54%); the final was
correct in 50/50 (100%), with zero infrastructure errors in either condition.
Three baseline mismatches were prudent missing-invite blockers rather than
incorrect execution. Accepting that blocked-existing-Room family gives a
context-adjusted baseline of 30/50 (60%); the strict raw labels are retained.
These are prompted dry-run decisions, not actual CLI runs or native selection.

## Native installed-skill selection

The complete baseline/final skill directories were installed separately at
`.agents/skills/sharednet-room/` in clean container workspaces. The native
Codex CLI discovered them normally; no skill catalog or body was manually
injected into the user request. A plan-only evaluation instruction prohibited
task execution and external side effects. Containers had no Docker socket and
only the evaluation workspace plus normal driver authentication; credentials
were not inspected or exported.

Both conditions used the same container image, Codex CLI 0.162.1 and
`gpt-6.1-sol` at low effort. Host simulations used CLI 0.163.0. The native
cases were English/Chinese implicit 5,000-contact research, a typo fix and an
explicit solo task, repeated five times each per condition.

| Native observed behavior | Baseline | Final |
| --- | ---: | ---: |
| Research requests selecting and actually reading the skill | 0/10 | 10/10 |
| Negative requests incorrectly selecting the skill | 0/10 | 0/10 |
| Valid samples / read or infrastructure errors | 20 / 0 | 20 / 0 |

All 40 native traces were manually inspected. Every final positive made
successful local reads of both SKILL.md and references/goal-mode.md, for 20
completed reads total; baseline and negative samples made no tool calls. No
SharedNet command, production Room creation or worker launch occurred. A
self-reported selection without a successful read was not counted as native
skill invocation.

Discarded native setup trials are separately accounted for in the evidence:
31 host attempts (30 recorded, one interrupted, six failed instruction reads),
40 container starts missing stdin forwarding (zero model calls), and one
successful container-discovery smoke. None is added to the paired 40-sample
denominator. An explicit file-read capability smoke is also separate from
native discovery. Unsupported model-alias and global-skill-isolation pilots
are retained outside the scored catalog samples.

## Headcount and prerequisite pressure checks

Seven additional scenarios were each repeated five times. In the final
counterfactual-plan protocol, default headcount was four in 5/5 samples and
an explicit request for six workers was honored in 5/5. All 35 declined nested
teams; all ten connector-only/missing-harness samples explicitly reported a
blocker and preserved the task rather than claiming workers had started.

The initial pressure protocol conflicted with the evaluator's actual
read-only permissions: ten otherwise launchable cases correctly reported a
write blocker. That cohort's strict score was 25/35 and is retained separately.
The corrected protocol asked for hypothetical `intended_route` and
`planned_workers`, never actual execution. Its unmodified exact-field scorer
gave 22/35: three existing-worker replies used `existing` instead of `none`,
and all ten blocked replies retained four *planned future* workers instead
of the scorer's expected zero *started* workers. Manual inspection confirmed
the refusal to launch and zero actual startup claims. Raw labels and scores
are preserved; the behavioral invariants above are an explicit semantic
audit, not a retroactive change to the scoring labels.

## Reproduction and limits

The evaluator freezes the skill tree before each condition, records per-file
SHA-256 values, and keeps raw prompts, JSONL events, responses and errors.
Catalog calls use an isolated Codex CLI session with user config, plugins,
apps, hooks, global skills and execution tools disabled. Full-body routing
calls instead supply the frozen skill and its linked references; those are
also dry-run model decisions, not worker launches.

Use the frozen cases and labels, five fresh calls per case/condition, the same
model/effort and the same competing catalog. Count model/transport errors and
invalid outputs separately from decisions. Do not combine multiple cases in
one model conversation. Inspect flagged decisions and do not score a quoted
example or a model's claim to have loaded a skill as an actual file read.

These are task-specific samples on one model and harness. Repeated prompts
do not provide 125 distinct requests or prove a population-wide trigger rate.
They do not measure the quality of completed tasks, contact accuracy, costs
or end-to-end worker startup. No production Rooms or research teams were
created by these tests. Installation still permits model-dependent implicit
selection rather than enforcing a deterministic routing hook.

The CLI runtime and npm package version are unchanged. Shipping this change
means publishing the updated complete skill directory through the client
repository; already-installed copies must be updated. The hosted join-only
`/skill.md` remains a separate protocol entry point.
