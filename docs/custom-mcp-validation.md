# Validation record

Validated locally against fork base `1b182de09e4acefb1e7ca526e8ed0d136d8b90b3`, using Bun 1.4.3.

## Passed

- `bun run typecheck`: all packages.
- `bun run test`: 423 tests, zero failures (API 331, web 18, integrations 26, database 16, utils 32).
- `bun run build`: web, docs, and website production builds.
- `bun run lint`: passes with one existing fast-refresh warning in unchanged `packages/web/src/pages/agent/agent-collection-page.tsx`.
- `git diff --check`: clean.

New coverage includes:

- HTTPS, URL and IP-address restrictions, Azure platform-IP protection, mixed DNS responses, rebinding, pinned lookup, TLS verification and redirects.
- JSON/SSE protocol lifecycle, pagination, nested schemas, full result/error preservation, session headers and cleanup, malformed responses, schema nesting/size bounds.
- A real localhost TLS socket fixture under Bun, with test-only network-target and certificate-trust substitution. Production endpoint guards have no localhost or test bypass.
- Deny-by-default grants, rejecting upstream read-only hints, audit failure preventing remote work, unlogged arguments/secrets, changed definitions, live authorization rechecks and unknown-outcome warnings.
- Atomic snapshot/grant transaction behavior, A → B → A not resurrecting a grant, and rejecting delayed stale grant writes.
- Creation/metadata organization scope, encrypted credential boundary, compare-and-swap refreshes, per-agent grant routes, UI permission rendering and audit labels.

## Not validated here

- No deployed Vercel or Azure instance, paid resource, Neon database, or real credential-backed upstream MCP server was created.
- Full signed-in end-to-end browser operation was not exercised against a live database; web behavior was checked with component tests and production compilation.
- Database race regression tests exercise the transaction interface with a stateful mock, not concurrent sessions against a real PostgreSQL instance. The implementation serializes snapshot refresh and custom grant changes on the same connection row using a conditional update inside a transaction. Run a concurrent PostgreSQL smoke test before production rollout.
- The existing built-in OAuth token-refresh race across multiple application instances remains unchanged; see the hosting guide.
- The Docker image itself and platform-specific deployment settings were not built or deployed in this environment.

Before production, run an authorized smoke test with a disposable MCP server and database: connect, grant one tool, execute, revoke during a slow discovery, refresh changed schemas, and confirm that stale/reverted approvals never restore access. Check login delivery, external HTTPS, migrations, instance concurrency, request deadlines, secret retention and database backups.
