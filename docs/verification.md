# Foundation verification — 2026-09-25

The imported runtime baseline is commit `1bbe9af` of this repository; later
foundation commits tighten verification/documentation without changing the
CLI runtime. The PR head identifies the final check implementation.

- Source snapshot: `142ae999ddaf372a78fcb26a065b1dba675170fc`.
- All unchanged imported files match their source bytes. Individual source
  paths, hashes and transformations are in `scripts/export-manifest.json`.
- 84 retained client tests, 5 executable Skill read examples and 8 export
  checker tests pass locally on Node 24.19.0. Typecheck and build pass.
- Installed CLI artifact: `sharednet-0.1.8.tgz`.
- Artifact SHA-256: `37a18c3b7e4d04d588cce372f1fd4923d04947af5cf9c12807e53407c4aa1c40`.
- The artifact installs offline into an empty consumer with install scripts
  disabled. Bare `import 'sharednet'` and the npm-installed executable work
  with TypeScript stripping disabled. Broken exports and bin-map mutations
  were each shown to fail the corrected package gate.
- The service snapshot's `scripts/cli-package-smoke.mjs --package <tarball>`
  passes for this artifact: real HTTP handler, retrieval filters/pagination,
  independent wait cursor, Unicode filename and exact binary byte round-trip.
- Gitleaks 8.30.1 reports no findings in the allowlisted source tree, package
  contents and committed client history. This is evidence, not a guarantee
  against every possible disclosure.
- `claude plugin validate <checkout>` passes on Claude Code 2.1.270.
- Independent review confirmed that all pure client tests were retained and
  runtime code was unchanged. Its public-entry-point smoke finding was
  reproduced and fixed with negative mutations and a passing valid artifact.

The GitHub Actions matrix is reported on the PR separately. Local HTTP
integration uses the service's in-memory repository; PostgreSQL/OAuth, MCP
extraction, canonical-source cutover and a published registry release are
**not** verified or delivered by this foundation milestone.
