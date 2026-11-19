# Harness module slots

`goal run` has a fixed core and four module slots. The core is what every run needs: one
container per Agent with a private home, the shared `/workspace`, the checks container, the
network (`--isolate`, `--network`), the sign-ins, the turn loop and the run record. The slots are
where research on multi-agent coordination changes the harness, one area each. Every slot has a
default, and the defaults are the behaviour `goal run` had before the slots existed: a run that
sets no module option runs exactly as before. A run that sets them records which it used under
`modules` in `episode.json`.

| Slot | Area | Options | Default | Source |
| --- | --- | --- | --- | --- |
| State | systems: who does what, what is accepted | `--task-judge off\|lexical`, `--activity-view` | off, off | `src/modules/state.ts` |
| Topology | network science: who can reach whom | `--topology all\|islands:<K>` | all | `src/modules/topology.ts` |
| Protocol | organisation theory: what a message must contain | `--message-schema free\|sbar` | free | `src/modules/protocol.ts` |
| Information | what the team does not know yet | `--probe <command>`, `--probe-every <duration>` | none | `src/modules/information.ts` |

`src/modules/index.ts` holds the slots together: their defaults, what the run record says about
them, and the environment a seat's own `sharednet` needs for the modules that act inside its
container. The options are for board Rooms and cannot be combined with a frozen
`--harness-mode` yet.

## State

Title tasks (`sharednet task claim|done|list`, `--task-gate`) are already state rather than chat:
claims and completions are acts on the board, projected into tasks, and the first claim of a title
wins. Two pieces build on them.

- `--task-judge lexical`: a claim whose title is close to a task another seat holds is refused,
  with that task and its owner named, before anything is posted. The claimant takes other work,
  coordinates with the owner, or claims again with `--distinct "<how yours differs>"`, which the
  seat's control log records. Closeness is the share of the shorter title's content words that
  the other has too, from 0.6 on. The judge is a hook: another judge can replace the lexical one.
- `--activity-view`: every wake ends with who is in a turn, who is idle and who holds which task,
  from the runner's own record of turns and from the task acts, not from what anyone said.

Not yet in this slot: leases that expire, fencing tokens checked where results are accepted,
an integration gate that keeps a regression corpus.

## Topology

Routing (`--message-routing`) decides whom a message wakes. The topology decides, before that,
whom it can reach at all.

- `--topology islands:<K>`: the Agents are dealt round-robin into K islands. A message reaches
  the sender's own island and crosses to the others only when it names someone there with
  `@name` or starts with `[share]`. Lines from the runner reach everyone, and the Room's history
  stays whole: `sharednet read` still shows every message. This is the island model of
  evolutionary search, with `[share]` as migration.

Not yet in this slot: neighbourhood or small-world graphs, delayed diffusion, adding or retiring
Agents during a run.

## Protocol

- `--message-schema sbar`: a message that names a teammate with `@name` (other than `@all`) is a
  handoff and must carry the four SBAR parts, `S:` situation, `B:` background, `A:` assessment,
  `R:` recommendation. `sharednet say` refuses one without them, before anything is posted, and
  shows the template. Free text and `@all` stay free. Every wake then lists what has been asked of
  the woken Agent: the `R:` part of each handoff to it.

Compiled Rooms already have a typed work protocol (`src/protocol/`); this slot is for board Rooms.

## Information

- `--probe <command> --probe-every 5m`: the runner runs a command on a fixed clock in the checks
  container, on the shared workspace, with no model behind it, and posts what it prints as a
  `[probe]` line to `@all`. Empty output posts nothing; each run is logged in `probe.ndjson`. A
  probe is a source of information, not a judge: a differential tester against a reference, a
  coverage count, a measure of how alike the Agents' lines of work are.

## Rules for adding to a slot

1. The default stays the behaviour before the change; new behaviour is opt-in.
2. One interface per slot, one default implementation, tests for both.
3. An experiment changes one slot at a time and records it in `episode.json`.
4. Protocol definitions belong to the research repository; this repository implements them.
