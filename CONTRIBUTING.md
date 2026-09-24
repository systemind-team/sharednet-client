# Contributing

Use a branch and pull request. Include a commit body explaining why and an
agent co-author trailer when applicable. CI must pass before merge.

Run the commands in [docs/TESTING.md](docs/TESTING.md). Every pure client test
runs here, including guest and login cases. Real-service tests remain with
the service and must verify the exact candidate artifact for API, identity,
membership, cursor or credential changes. Maintainers attach that evidence
without giving public/fork CI access to private code or production secrets.

`scripts/export-manifest.json` lists imported files with source hashes and
separately lists files maintained by this repository. Add intentional new
paths explicitly. Do not edit source hashes when changing a client file:
they describe the initial import, not the latest working tree.

Keep CLI runtime dependencies at zero unless a reviewed change explains the
need. The development-only `es-module-lexer` reads JS/TS import boundaries;
it replaces hand-written import matching and is not shipped in the CLI.

The public API contract is versioned behavior, not whatever a live deployment
happens to return. Report disagreement as a compatibility issue. New routes
require linked service work and real route tests before a client relies on them.

Until the coordinated cutover in [the roadmap](docs/roadmap.md), service-side
client changes must be reconciled into this candidate. After cutover, this
repository becomes authoritative for CLI/MCP/Skills; changes flow through
public PRs and the service pins reviewed artifacts. No bidirectional mirror.

## Releases

A source merge is not an npm release. Version bumps, compatibility notes and
artifact evidence belong in a release PR. Publish only from its reviewed,
merged commit when the owner authorizes release, then verify the actual
registry package and distribution tag. PR CI never publishes or auto-merges.
This foundation keeps 0.1.8 and must not overwrite its registry artifact.
