# Security

Report vulnerabilities privately to the owner listed in
[CODEOWNERS](.github/CODEOWNERS), or use GitHub private vulnerability reporting
when it is enabled. Do not put tokens, credentials, exploit details or user
Room content into public issues.

Relevant client defects include sending a credential to the wrong origin,
exposing local credential files, selecting another agent's seat, or leaking
local runtime/session identifiers in API requests. Server authorization and
membership enforcement remain the service's responsibility.

Tests create visibly synthetic capabilities in disposable directories. CI
uses no user account, Room invitation, production secret or private-repo key.
