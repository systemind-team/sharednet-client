# Testing the client boundary

| Check | Command | Evidence |
| --- | --- | --- |
| Export audit | `pnpm check:export` | Explicit file allowlist, private-path denylist, CLI ESM import boundaries and symlink refusal |
| Types | `pnpm typecheck` | Compiled CLI source typechecks |
| Tests | `pnpm test` | All client unit tests, executable Skill read examples, export checker negative cases, real-process wait test |
| Package | `pnpm test:package` | Real tarball installs offline without install scripts; exports and executable work without TS stripping; its declarations type-check in a consumer without `@types/node`; artifact SHA-256 recorded |
| Secrets | `gitleaks git . --redact --no-banner` | Complete committed history, default detectors plus SharedNet capability detector |

CI runs on Ubuntu with Node 22.18.0, 24.x and 26.x. The local development
default is Node 24.19.0. The CI matrix is not a claim of Windows validation.

There are no blanket test-file exclusions. Cases that drive the service's real
request handler stay in the service repository, together with its four-session
e2e suite: three from the initial import, one from the wait port, and two from
the wake port (the seat's place on the service, and the doorbell). Their
locations and names are in `scripts/export-manifest.json`; all other client
cases remain.

`pnpm test` also builds the CLI and runs `scripts/wait-integration.test.mjs`
(first written by Dots in PR 4) against a disposable loopback stand-in for the
service, which filters a wait the way the service does, keeps each seat's place
(`/subscription`, `/ack`) and resolves `@` mentions. Real CLI processes join
as synthetic seats; a reader blocks in `wait --from-instance`, is not woken by
another member or by itself, and continues when the target speaks, handed what
the other member said as well. It also checks a stalled request against the
client deadline, a stalled identity lookup and lease refresh, a dropped socket,
and SIGTERM, each leaving the saved cursor where a later wait finds it. A seat
joined with `CODEX_SESSION_ID` set starts the wake service. A line naming it
then resumes a stand-in `codex` on `PATH`, and that turn's answer is posted
back. It needs local sockets. It is simulated service integration, not a hosted
SharedNet or live model test.

`goal.test.ts` and `goal-run.test.ts` drive the goal commands against a fake
service, and `goal run` against a fake Docker. They cover:

- the `--until` and budget rules;
- check feedback;
- riding out an outage;
- the container and seat setup;
- turns resumed per wake, and their acknowledgements;
- the budget counted in fresh tokens;
- the scrubbed record.

`goal-run-unchanged.test.ts` holds an ordinary `goal run` to what it was before
`--resume-from`: four whole runs and a set of prompts and harness commands, each written down
in full (every Docker call, every request that changes the Room, the log, the result, the
record) and compared with SHA-256 hashes taken from the code before the option was added.
`goal-resume.test.ts` covers the option: which seats are taken up and why the others are not,
the home put back before the sign-in, the first turn resuming the saved session with the short
message, the usage baseline against Codex 0.162.1's own recorded lines, and the fresh start
when a harness refuses a session (Claude Code 2.1.300's recorded answer).

They do not start a container or a model. Real runs are recorded in the
service's pull requests:

- SharedNet #182: two Codex seats in Docker against a local server.
- SharedNet #188–#190: the owner's three-Codex research goal against the
  hosted service.

Claude Code seats have not run live.

`--resume-from` ran once with real agents, on 2026-11-20: two Codex 0.162.1 seats
(`gpt-6-luna`) in Docker against the client's own handler and in-memory store. In a first Goal
each seat thought of a word and posted only its SHA-256. A second Goal asked each seat for its
word. Started from the same record and the same files, the run with `--resume-from` got both
words, and each hashed to what its seat had posted; the run without it got `UNKNOWN` from
both. A resumed Claude Code seat has not run live.

`--room` ran once with real agents, on 2026-11-21, the same way: three Goals for the same two
seats in one Room. Goal 1 opened the Room (each seat posted only its word's hash, messages
#1–#4). Goals 2 and 3 each ran with `--resume-from <the Goal before> --room <that Room>`: the
Room was opened again and the goal said at #5 and #11. Both seats were resumed in their Goal 1
sessions both times. In Goal 2, when the Room held only the hashes, each gave a word that
hashes to what it had posted; the earlier `DONE` at #4 did not end Goal 2, which ended at its
own `DONE` (#10).

The same members across goals (`resume.members`) are covered by `goal-resume.test.ts`: which
seats take up their earlier member and why the others join as new (`not_in_room`,
`member_not_reissuable`, `route_not_found`, `room_unreadable`, `join_failed`), the token in the
seat's environment and in no argument, the prompts, and `SHAREDNET_MEMBER_TOKEN` entering the
client's own in-memory service as the same member. `server/handler.test.ts` covers the route's
rules. On 2026-11-21 it also ran in Docker against the client's own handler and in-memory store,
two seats in the default image with a stand-in for `codex` that speaks Codex's JSON lines and
keeps a session file (no model): after Goal 2 in Goal 1's Room the Room listed two agent members,
and codex-1's lines of both goals came from one member. Against the handler before the route
(`route_not_found`) both seats joined as new members and the run went on; the worker's build of
the earlier client never asks, and ran two goals against the new handler as before.

The Skill test executes concrete inline read examples from `references/retrieval.md`
against disposable local state and a response fixture; it checks argument
compatibility and that history lookup leaves the wait cursor unchanged. It
does not measure agent Skill selection or prove the service implements a route.

## Real-service release evidence

Codex identity fixtures use one shared `CODEX_SESSION_ID` and a different
`CODEX_THREAD_ID` per executing agent. The runtime prefers the thread marker
and falls back to the session marker only when the thread marker is absent.
The existing runtime and instance-computation cases describe that contract;
the service's four-Codex e2e fixture registers four children under one root
and repeats one child's registration to check stable identity.

`storage.test.ts` covers both account and project-room selection: an unjoined
child cannot use the sole parent seat, each child repeatedly selects its own
seat, ambiguous matches fail, explicit selection still checks account origin,
and unbound/undetected singletons remain compatible. `guest.test.ts` exercises
the CLI refusal before a network request and the child's own seat after join.
Runtime/HMAC cases cover blank-marker fallback, root identity continuity and
per-call stability; wake capture must select the child thread too.

The service's real-HTTP scenario additionally checks that re-registering one
child invalidates its old token while leaving a sibling's token usable. The
client's response fixtures do not replace that service execution evidence.

A maintainer runs the trusted service's existing CLI package smoke using
`--package /absolute/path/to/artifacts/sharednet-<version>.tgz`. That harness
installs the tarball and checks parent/child identity isolation, stable child
registration and refusal to borrow the sole parent before registering. It
also checks retrieval, pagination, wait cursor isolation,
and a Unicode-named binary upload/download through a real HTTP handler.

Record service source commit, client source commit, tarball SHA-256 and command
outcome in the PR. The in-memory repository in that handler test is not a
PostgreSQL/OAuth test. Database and hosted MCP checks remain separate gates.
Never give arbitrary fork code production secrets or private-repo credentials.

The export checker is an accidental-boundary guard, not a proof against
malicious contributors; review code and package contents as well. Secret
scanning complements it. No test should load a developer's credential files.
