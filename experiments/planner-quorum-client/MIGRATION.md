# Experimental client deployment

Version: 0.1.12-work-window.1 (includes planner-quorum.3), based on the independently deployed 0.1.12 JavaScript client.

Keep the default CLI unchanged. Install this client in a separate directory and invoke its bin/sharednet.js explicitly with Node >=22.18. Create fresh run IDs when changing versions. Update queue entry/package paths, exact-version guard and the affected frozen-file hashes together. Preserve existing run provenance; do not resume a partial attempt under a different version.

Run `npm run check` and `npm test` inside this directory. The 47 offline tests cover runner integration with simulated Docker/room APIs, REOPEN ordering and deduplication, final-check races, member exit and bounded recovery cancellation. These are not live service contract tests.

The deployed runtime passed the same 40 tests on Linux and in a network-disabled experiment container. Real Earth_001 runs exercised explicit reopen and recovery cancellation, including degraded completion following provider 429 failures. Those observations do not establish a scoring benefit or compatibility with every service version.

Forced cancellation stops and restarts only the affected seat container; it can interrupt writes, so inspect and revalidate artifacts. Docker stop/inspection/start failures prevent further scheduling. Run time and token bounds are not reset. A client-side post-check room drain is not a server-side atomic completion transaction.

Work-window controls are documented in WORK-WINDOW.md. They remain off by default and reject enabled coordination modes. The 40-test deployment statement above refers to the earlier planner/quorum.3 snapshot; validate all 47 tests for this artifact.
