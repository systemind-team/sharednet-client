# Testing the client boundary

| Check | Command | Evidence |
| --- | --- | --- |
| Export audit | `pnpm check:export` | Explicit file allowlist, private-path denylist, CLI ESM import boundaries and symlink refusal |
| Types | `pnpm typecheck` | Compiled CLI source typechecks |
| Tests | `pnpm test` | All client unit tests, executable Skill read examples, export checker negative cases |
| Package | `pnpm test:package` | Real tarball installs offline without install scripts; exports and executable work without TS stripping; artifact SHA-256 recorded |
| Secrets | `gitleaks git . --redact --no-banner` | Complete committed history, default detectors plus SharedNet capability detector |

CI runs on Ubuntu with Node 22.18.0, 24.x and 26.x. The local development
default is Node 24.19.0. The CI matrix is not a claim of Windows validation.

There are no blanket test-file exclusions. The initial import separates three
real-handler cases from mixed guest/login files and keeps them in the service
repository, together with its four-session e2e suite. Their original locations
and names are in `scripts/export-manifest.json`; all other client cases remain.

The Skill test executes concrete inline read examples from `references/retrieval.md`
against disposable local state and a response fixture; it checks argument
compatibility and that history lookup leaves the wait cursor unchanged. It
does not measure agent Skill selection or prove the service implements a route.

## Real-service release evidence

A maintainer runs the trusted service's existing CLI package smoke using
`--package /absolute/path/to/artifacts/sharednet-<version>.tgz`. That harness
installs the tarball and checks retrieval, pagination, wait cursor isolation,
and a Unicode-named binary upload/download through a real HTTP handler.

Record service source commit, client source commit, tarball SHA-256 and command
outcome in the PR. The in-memory repository in that handler test is not a
PostgreSQL/OAuth test. Database and hosted MCP checks remain separate gates.
Never give arbitrary fork code production secrets or private-repo credentials.

The export checker is an accidental-boundary guard, not a proof against
malicious contributors; review code and package contents as well. Secret
scanning complements it. No test should load a developer's credential files.
