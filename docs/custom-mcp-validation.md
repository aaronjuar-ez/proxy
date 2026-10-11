# Validation record

Validated locally against fork base `1b182de09e4acefb1e7ca526e8ed0d136d8b90b3`, using Bun 1.4.3.

## Passed

- `bun run typecheck`: all packages.
- `bun run test`: 473 tests, zero failures (API 354, web 40, integrations 26, database 21, utils 32).
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
- Unavailable custom metadata cannot block connection/agent/activity/onboarding pages; broken connections stay visible and disconnectable.
- Pre-dispatch initialization and transport failures remain ordinary unreachable errors; only uncertain post-dispatch outcomes warn that a tool may have executed.

- Optional single-owner password mode: real Bun Argon2 verification, bounded hash/config validation, origin guards, generic failures, global attempt budget, dedicated-owner initialization, credential/session isolation, and disabled alternate login routes.
- Password form gating, repeated/interrupted submissions, abort/timeout behavior, safe redirects and no credential persistence.
- Local hidden-input hash helper checked in a synthetic pseudo-terminal: valid, short and mismatched inputs, no password echo; automated tests reject noninteractive/argument input.
- GitHub CI and both Docker image jobs passed at `fb84724` before the owner-password addition; current head checks must also pass before deployment.

## Not validated here

- No deployed Vercel or Azure instance, paid resource, Neon database, or real credential-backed upstream MCP server was created.
- Full signed-in end-to-end browser operation was not exercised against a live database; web behavior was checked with component tests and production compilation.
- Database race regression tests exercise the transaction interface with a stateful mock, not concurrent sessions against a real PostgreSQL instance. The implementation serializes snapshot refresh and custom grant changes on the same connection row using a conditional update inside a transaction. Run a concurrent PostgreSQL smoke test before production rollout.
- The existing built-in OAuth token-refresh race across multiple application instances remains unchanged; see the hosting guide.
- Docker is not installed in the local workspace. Image builds are validated by GitHub Actions; actual Vercel runtime deployment remains unverified.

Before production, run an authorized smoke test with a disposable MCP server and database: connect, grant one tool, execute, revoke during a slow discovery, refresh changed schemas, and confirm that stale/reverted approvals never restore access. Check login delivery, external HTTPS, migrations, instance concurrency, request deadlines, secret retention and database backups.

## OAuth support validation (2026-10-11)

Implemented on top of merged custom-MCP main commit `67b3cbf`.

- Aggregate `bun run typecheck`: all packages pass.
- Aggregate `bun run test`: 574 tests pass (419 API, 33 DB, 64 web, 26 integrations, 32 utilities).
- `bun run lint`: passes; existing Fast Refresh warning in `agent-collection-page.tsx` remains.
- `bun run build`: web, docs and website production builds pass; existing web bundle-size warning remains.
- All 14 migrations apply in an in-memory PGlite database. Concurrent refresh lease acquisitions and single-use callback consumption each have only one winner.
- OAuth tests cover protected-resource/authorization metadata binding and discovery fallback, confidential/public client registration, PKCE/resource parameters, issuer-specific callbacks, state expiry/replay/owner/browser binding, callback cancellation, token/secret redaction, refresh rotation/concurrency/lost responses, reconnect fencing and grant removal.
- Transport tests cover public DNS validation and socket pinning, real TLS socket behavior, redirect refusal, response-size/time limits, and no automatic mutating-tool replay.
- UI tests cover auth modes, callback lookup, optional public client IDs, onboarding, reconnect warnings, provider errors, duplicate clicks, interrupted navigation and browser Back.
- Independent security review found and resolved a shared-callback issuer mix-up risk; each issuer now has its own exact registered callback URI, consistent with RFC 9700 section 4.4.2.2.

Read-only Vercel metadata inspection confirmed the canonical resource `https://mcp.vercel.com/`, issuer `https://vercel.com`, PKCE S256, and confidential-client authentication. The implementation supports dynamic registration using advertised `client_secret_post` or `client_secret_basic` as well as public clients. No real registration, provider approval, account grant or production deployment was performed. Provider approval can still prevent a particular connection, and a complete real-account Vercel authorization remains unverified. Direct DNS-based live transport testing is limited by this execution environment; public metadata was inspected without credentials.

Before deployment, apply migration `v013_custom_mcp_oauth`. On Vercel, `Dockerfile.vercel` deliberately starts the application without migrations: run `prisma migrate deploy` once as a release step against Neon’s direct connection, supplied securely as `DATABASE_URL`, before deploying or promoting the OAuth version. The standard `Dockerfile` instead runs `docker-entrypoint.sh`, which applies migrations at startup. Keep `ENCRYPTION_KEY` unchanged. Reconnecting an OAuth connection intentionally clears all existing custom-tool grants, which must be reviewed again. An uncertain token refresh requires reconnect rather than replaying a potentially consumed refresh token.
