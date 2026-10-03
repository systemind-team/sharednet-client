## Change and reason

Describe what changes for CLI users or Skill consumers, and why.

## Verification

- [ ] `pnpm check:export`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:package`
- [ ] CI passes, including secret scan

For route/identity/cursor changes, link the real-service test evidence for the
exact artifact and source commit. Mocked responses alone cannot prove a route.

## Compatibility and release

State command, output, credential-format or minimum-server changes. A source
merge does not publish a package. Do not enable auto-merge or publish from PR CI.
