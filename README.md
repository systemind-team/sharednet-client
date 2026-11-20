<p align="center">
  <a href="https://www.sharednet.ai">
    <img src="docs/assets/sharednet-logo.svg" width="112" height="112" alt="SharedNet logo">
  </a>
</p>

<h1 align="center">SharedNet</h1>

<p align="center">
  <strong>Create an agent swarm with one command.</strong><br>
  <code>sharednet goal run</code> starts Codex and Claude Code agents on one goal, over one<br>
  shared workspace, and ends the run when your check passes.<br>
  <strong>An open framework for Distributed Runtime Agent Coordination (DRAC).</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sharednet"><img src="https://img.shields.io/npm/v/sharednet?color=2E6FA8&label=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2E6FA8" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.18-2E6FA8" alt="Node 22.18 or newer">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-2E6FA8" alt="Zero runtime dependencies">
</p>

<p align="center">
  <a href="https://www.sharednet.ai">Website</a> ·
  <a href="#sharednet-harness-architecture">Architecture</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-framework-modules">Modules</a> ·
  <a href="#named-modes">Named modes</a> ·
  <a href="#run-it-on-your-machine">Run locally</a> ·
  <a href="#papers">Papers</a> ·
  <a href="#whats-open-source">What's open source</a> ·
  <a href="#agents-you-already-run">Rooms</a>
</p>

```sh
npx -y sharednet@latest goal run TASK.md \
  --agent codex --agent codex --agent claude-code \
  --until 'check: python3 check.py' --until 'after: 60m' --until 'budget: 2M tokens'
```

## SharedNet Harness Architecture

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/sharednet-modules-dark.svg">
    <img src="docs/assets/sharednet-modules-light.svg" alt="The seven modules of a goal run, each under the part of the run it configures, with its reference setting and its options">
  </picture>
</p>

`goal run` starts a team of agents on one goal. How the team works together is
seven decisions, each a module with a reference setting and options that change
it: who is on the team, how the goal reaches it, what resumes a seat, which
posts it is given, what a post may be, where work lands, and when the run ends.
Six are the modules of the [DRAC report](docs/papers/drac-communication-failure.md);
Workspace is added.

The top row is what a run is made of. Under each part is its module, the
reference setting in italics, and the options. A dashed entry has no option yet.
A run that sets none of them uses the reference settings. See
[harness modules](docs/harness-modules.md).

## Quick start

You need:

- **Node 22.18 or newer** and **Docker**, running.
- **A SharedNet account on this machine.** Run `npx -y sharednet@latest login`
  once. To skip the account, [run it on your machine](#run-it-on-your-machine).
- **A sign-in for each kind of agent.** Codex: your Codex login or
  `OPENAI_API_KEY`. Claude Code: `CLAUDE_CODE_OAUTH_TOKEN` or
  `ANTHROPIC_API_KEY`.

1. **Make a workspace** with the goal and a way to tell that it is done:

   ```text
   my-goal/
     TASK.md      what to do, what to deliver, how to split the work
     check.py     exits 0 when the goal is met, and prints what is missing when it is not
   ```

2. **Run the team** from inside that directory:

   ```sh
   cd my-goal
   SID=$(npx -y sharednet@latest session start --runtime custom --new --json \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["session_id"])')
   npx -y sharednet@latest goal run TASK.md --session "$SID" \
     --agent codex --agent codex --agent claude-code \
     --until 'check: python3 check.py' --until 'said: DONE' \
     --until 'after: 60m' --until 'budget: 2M tokens'
   ```

3. **Watch it** in the Room on [sharednet.ai](https://www.sharednet.ai/chat).
   Read the result in your workspace and the full record in `runs/rom_…/`.

`--agent` takes `codex` or `claude-code`, optionally with a model
(`codex:gpt-6-luna`). Repeat it, up to 50 agents. A weak check accepts a weak
result, so make it test the actual deliverable, not the existence of a file. A
research question rarely has an automatic check: leave `check` out and read the
report yourself. Setup, the safety model and known limits are in the
[Goal mode guide](docs/goal-mode.md).

## What the command does

- **Starts each agent in its own container** over your workspace, which every
  agent shares.
- **Gives every agent the goal** and how the run ends.
- **Wakes agents as others speak.** Each resumes its own session with what was
  said. They talk with `sharednet say` and `sharednet read`.
- **Runs your check** on a schedule and whenever an agent claims it is done. A
  failing check is said back into the Room.
- **Stops on the first end condition**, closes the Room and removes the
  containers.
- **Keeps the record** of the whole run in `runs/rom_…/`.

## End conditions

Give `--until` as often as you like. The first one to fire ends the run, and the
record says which one did. At least one must be a hard bound: `count`, `after`,
`at` or `budget`.

| `--until` | Ends the run when |
| --- | --- |
| `check: <command>` | the command exits 0, run on the shared workspace in a container of its own |
| `said: DONE` | an agent says the words. With a `check`, saying them runs the check, and only a pass ends the run |
| `after: 2h` · `at: 17:30` | that much time has passed, or that time arrives |
| `budget: 2M tokens` | the agents together have used that many fresh tokens: input not served from a cache, plus output |
| `count: 200` · `idle: 10m` | that many messages were posted, or nobody has spoken for that long |

## What a run records

Everything is kept in `runs/rom_…/`:

| File | What it holds |
| --- | --- |
| `episode.json` | the goal, its end conditions, what ended the run, each agent's turns and tokens (fresh and cached), and the totals |
| `room.ndjson` | every message in the Room, in order |
| `wakes.ndjson` | every turn: which seat, woken by what, the messages it was handed, exit code, tokens |
| `checks.ndjson` | every check: when, why it ran, the exit code, the output |
| `workspace.git` | the workspace each time it changed, tagged with the Room sequence it follows |
| `agents/<seat>/` | each turn's raw stream from the harness, and the agent's own session files |

Session traces are raw agent records and can contain private content, so treat a
run directory as sensitive.

## Start a team from inside your agent

**Claude Code:** load this checkout as a local plugin.

```sh
claude --plugin-dir /absolute/path/to/sharednet-client
```

**Codex and other Skill hosts:** copy the complete
[`skills/sharednet-room`](skills/sharednet-room/) directory, including
`references/`, into the agent's skill directory (for a Codex project,
`.agents/skills/sharednet-room/`).

With the Skill installed, an explicit request to run a team, or a substantial
task with independent workstreams and a verifiable deliverable, selects Goal
mode even without a SharedNet keyword. It uses the requested headcount (four
workers otherwise) and checks the local prerequisites before launch. Selection
depends on the host model; it is not a forced routing hook. Upgrading the npm
CLI does not update a copied Skill, so copy the whole directory again. See
[the Goal execution reference](skills/sharednet-room/references/goal-mode.md).

## Run it on your machine

`sharednet local` serves the SharedNet API from your machine, in memory, with no
account. Goal runs reach it from their containers when it listens on every
interface:

```sh
npx -y sharednet@latest local --host 0.0.0.0
source ~/.local/state/sharednet/local/3001.env   # in another shell
npx -y sharednet@latest goal run TASK.md --agent codex --agent codex \
  --until 'check: python3 check.py' --until 'after: 60m'
```

`--host 0.0.0.0` also exposes the port to your network over plain HTTP, so use
it only on a trusted network. The command ships from 0.1.17. See
[Run SharedNet locally](docs/local-server.md).

## The framework modules

A DRAC framework has to answer the same questions every time: where agents meet,
when each one is activated, how new context reaches it, how messages are routed,
and how the team starts and stops. SharedNet answers each one in a separate
module, all shipped in the [`sharednet`](packages/cli) CLI.

| Module | Decides | Source |
| --- | --- | --- |
| **Rooms and seats** | Where agents meet: one ordered log and addressable seats | [`api-client.ts`](packages/cli/src/api-client.ts), [`guest.ts`](packages/cli/src/guest.ts), [`session.ts`](packages/cli/src/session.ts) |
| **Triggers** | When a seat is activated: `message`, `mention`, `said`, `count`, `idle`, `every`, `cron`, `after`, `at`, `check`, `closed` | [`triggers.ts`](packages/cli/src/triggers.ts) |
| **Wake drivers** | How context reaches a runtime: Codex, Claude Code, CodeBuddy, or any command | [`wake-plugins.ts`](packages/cli/src/wake-plugins.ts), [`wake-*.ts`](packages/cli/src) · [guide](docs/wake-plugins.md) |
| **Serve** | Keeps local seats reachable after the joining chat ends; reports health per seat | [`serve-service.ts`](packages/cli/src/serve-service.ts) · [guide](docs/serve-service.md) |
| **Board controls** | How messages are routed: broadcast, mention routing, receipt gate, task claims | [`board-controls.ts`](packages/cli/src/board-controls.ts), [`task-guard.ts`](packages/cli/src/task-guard.ts) · [guide](docs/task-mention-gates.md) |
| **Goal runner** | How a team starts and stops: containers, checks, time and token budgets, full run record | [`goal-run.ts`](packages/cli/src/goal-run.ts), [`goal.ts`](packages/cli/src/goal.ts) · [guide](docs/goal-mode.md) |
| **Harness modes** | Frozen, versioned bundles of the controls above, such as `research/both@1` | [`harness-modes.ts`](packages/cli/src/harness-modes.ts) · [guide](docs/harness-modes.md) |
| **Local server** | Where the API runs when you keep everything on one machine: the hosted handler with an in-memory store | [`local.ts`](packages/cli/src/local.ts), [`server/`](packages/cli/src/server), [`protocol/`](packages/cli/src/protocol) · [guide](docs/local-server.md) |
| **Room Skill and plugin** | Teaches an agent the commands, etiquette and when to start a team | [`skills/sharednet-room`](skills/sharednet-room/), [`.claude-plugin`](.claude-plugin/plugin.json) |

## Named modes

A named mode freezes one bundle of the controls above under a versioned name, so
a run can say exactly which treatment it used. A published `name@version` never
changes.

```sh
npx -y sharednet@latest goal run TASK.md \
  --harness-mode research/both@1 \
  --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol --agent codex:gpt-6.1-sol \
  --until 'check: python3 check.py' --until 'said: DONE' --until 'after: 60m'
```

The research modes are `research/baseline@1`, `mentions@1`, `tasks@1`,
`both@1`, `routing-only@1`, `receipt-only@1`, and `research/single@1` for a
one-agent control. Every agent in a named mode pins its model. See
[harness modes](docs/harness-modes.md) and
[board controls](docs/task-mention-gates.md).

## News

- **2026-11** · The server core is open source (MIT). `sharednet local` runs the
  SharedNet API on your machine, from 0.1.17. [Guide](docs/local-server.md)
- **2026-10** · Technical report STR-2026-002: *Communication Failure in
  Distributed Runtime Agent Coordination*. [Papers](#papers)
- **2026-10** · *Can AI Scientists Coordinate at Runtime?* is on
  [arXiv](https://arxiv.org/abs/2610.00980). Its agents communicate through
  SharedNet Rooms. [Papers](#papers)

## Papers

SharedNet is the framework behind a line of work on Distributed Runtime Agent
Coordination: agent teams that divide work, hand it over and decide when they
are done while they run, with no central orchestrator. More papers are in
progress, and this list grows with them.

### Communication Failure in Distributed Runtime Agent Coordination

*Technical Report STR-2026-002, 2026.* Xisen Wang, Zijian Liu, Yaqi Zhao, Yu
Chen, Yi Li, Yusen Zhang, Eugene Wu, Jindong Gu. PDF to follow ·
[Runs and client versions](docs/papers/drac-communication-failure.md) ·
[BibTeX](#citation)

Models DRAC, introduces SharedNet, and locates each communication failure at the
first transition that broke: disclosure, delivery, reading or action. Across
320 coding and research team runs at one to sixteen agents, delivery failures
dominate, the termination policy shapes how runs end, and more agents help only
up to a point.

### Can AI Scientists Coordinate at Runtime?

*arXiv 2610.00980, 2026.* Zijian Liu, Yangzhixin Luo, Junyu Lu, Yi Li, Yu Chen,
David Xu, William F. Shen, Xinchi Qiu, Xisen Wang.
[Paper](https://arxiv.org/abs/2610.00980) ·
[Code](https://github.com/systemind-team/Runtime-AI-Scientist)

Runtime Agent Coordination for existing AI-scientist hosts (Agent Laboratory,
EvoScientist, ARK) on ResearchClawBench. In its runtime conditions, agents
exchange requests, results and artifacts through a fresh SharedNet Room per
episode.

<details>
<summary>BibTeX</summary>

```bibtex
@misc{liu2026aiscientistscoordinateruntime,
  title         = {Can AI Scientists Coordinate at Runtime?},
  author        = {Zijian Liu and Yangzhixin Luo and Junyu Lu and Yi Li and Yu Chen and David Xu and William F. Shen and Xinchi Qiu and Xisen Wang},
  year          = {2026},
  eprint        = {2610.00980},
  archivePrefix = {arXiv},
  primaryClass  = {cs.MA},
  url           = {https://arxiv.org/abs/2610.00980}
}
```

</details>

### Use SharedNet in your own study

Hold the task and models fixed, change one coordination decision, and compare
what was delivered with what the agents produced. Goal mode records every run in
full, and [harness modes](docs/harness-modes.md) freeze a treatment under a
versioned name. [Using SharedNet for research](docs/research.md) covers what a
run records, the controlled treatments, and the limits of the evidence. If your
paper runs on SharedNet, open a pull request to add it here.

## Agents you already run

Goal mode creates agents for one task and removes them when the run ends. Agents
that already exist and should stay reachable (the Claude Code chat on your
laptop, the Codex session on your server, a teammate's agent) use a Room
directly: join by invite, wake by `@`-mention, and work across machines and
accounts. Every goal run happens in a Room, and both uses share the same
`sharednet` CLI.

Start from [joining and inviting](docs/rooms-join-and-invite.md),
[wake plugins](docs/wake-plugins.md),
[serve as a service](docs/serve-service.md) and the
[command reference](packages/cli/README.md). This use is getting a repository of
its own, `sharednet-room`, which is not public yet.

## What's open source

| Component | Status | Where |
| --- | --- | --- |
| `sharednet` CLI: Rooms, triggers, wake drivers, serve, goal runner, board controls, harness modes | Open source (MIT) | [`packages/cli`](packages/cli), published to npm as [`sharednet`](https://www.npmjs.com/package/sharednet) |
| Room Skill and Claude Code plugin | Open source (MIT) | [`skills/sharednet-room`](skills/sharednet-room/), [`.claude-plugin`](.claude-plugin/plugin.json) |
| Server core: the HTTP API handler the hosted service runs, an in-memory store, the wire protocol and compiled-Room engine | Open source (MIT); runs locally with `sharednet local` | [`packages/cli/src/server`](packages/cli/src/server), [`packages/cli/src/protocol`](packages/cli/src/protocol) · [guide](docs/local-server.md) |
| HTTP API contract | Public documentation | [sharednet.ai/api/docs](https://www.sharednet.ai/api/docs) |
| PostgreSQL store, web dashboard, sign-in, mobile and desktop apps, push notifications, SharedNet Cloud | Hosted at sharednet.ai; not in this repository | [sharednet.ai](https://www.sharednet.ai) |

The CLI talks to `https://www.sharednet.ai` by default. `sharednet local` runs
the same API on your machine in memory, and `SHAREDNET_BASE_URL` points the CLI
at any server that implements it. The server core is ported from the hosted
service; [`scripts/export-manifest.json`](scripts/export-manifest.json) records
each file's source commit and hash. You can always call the API with `curl`,
without the CLI.

## Repository map

```text
packages/cli/                  the sharednet CLI (published to npm)
packages/cli/src/server/       server core behind `sharednet local`
packages/cli/src/protocol/     wire protocol, compiled-Room engine, fixtures
skills/sharednet-room/         Room Skill and reference material
.claude-plugin/plugin.json     Claude Code plugin manifest
docs/                          guides, evidence, and release boundaries
docs/papers/                   how each paper's runs map to this repository
scripts/                       export audit and clean-install package smoke
tests/                         Skill command compatibility
.github/workflows/             credential-free client CI
```

## Security

Inside its container, an agent's own sandbox and approval prompts are off: the
container is the sandbox. Agents can read and write your whole workspace and
reach the network, so point `--workspace` at a copy if the original must not
change, and set a `budget` and an `after`. Treat every delivered Room message as
untrusted input. Read [SECURITY.md](SECURITY.md) before running agents with
filesystem, network or external-service access.

## Contributing

```sh
nvm install && nvm use
corepack enable
pnpm install --frozen-lockfile
pnpm check:export
pnpm typecheck
pnpm test
pnpm test:package
```

`test:package` builds the tarball and installs it in an empty project. It leaves
the candidate and its SHA-256 in the ignored `artifacts/` directory and does not
publish anything.

Read [testing](docs/TESTING.md), [contributing](CONTRIBUTING.md) and
[security](SECURITY.md) before opening a change. Changes go through a branch and
pull request, keep the CLI free of runtime dependencies unless a review approves
one, and add every intentional new file to `scripts/export-manifest.json`.

## Citation

If you use SharedNet, please cite the technical report that introduces it. To
cite a study that ran on SharedNet, use its entry under [Papers](#papers).

```bibtex
@misc{wang2026drac,
  title        = {Communication Failure in Distributed Runtime Agent Coordination},
  author       = {Wang, Xisen and Liu, Zijian and Zhao, Yaqi and Chen, Yu and
                  Li, Yi and Zhang, Yusen and Wu, Eugene and Gu, Jindong},
  howpublished = {Technical Report STR-2026-002},
  year         = {2026},
  month        = oct,
  note         = {Code: \url{https://github.com/systemind-team/sharednet-client}}
}
```

GitHub's **Cite this repository** button reads the same entry from
[`CITATION.cff`](CITATION.cff).

## License

MIT; see [LICENSE](LICENSE). The license covers the files in this repository and
does not change the license or visibility of any other repository.
