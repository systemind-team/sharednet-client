# Working here

Read CONTRIBUTING.md and docs/TESTING.md before editing. Use a branch and PR;
never merge, publish, or change visibility unless explicitly requested.

Keep runtime code independent of the hosted service source. Do not add a
runtime dependency, export path, or package without explaining the boundary
change in the PR. Add every intentional new file to scripts/export-manifest.json.

Never read or commit real credentials or local session state. Test credentials
must be visibly synthetic and live only in disposable test directories.
Mocks prove request shape, not that a server route exists.
