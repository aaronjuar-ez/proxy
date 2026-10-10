# Docker hosting with Neon: Vercel first, Azure fallback

Checked against official documentation on 2026-10-10. This is a deployment plan, not a record of a successful cloud deployment. No cloud resources or secrets were created while preparing it.

## Recommended shape

Run the existing application as **one container, one HTTPS origin, and one Neon Postgres database**. The root `Dockerfile` already builds the Vite/React UI and serves it from the Bun/Express API. It listens on port 4000. Managed hosting replaces Compose's Caddy container; Neon replaces its Postgres container. No application persistent volume is required.

Vercel now supports OCI images through its **Container Runtime beta**, using a root `Dockerfile.vercel` or `Containerfile.vercel`. It does not deploy a Compose file directly. Try this route if accepting a beta is appropriate; use Azure Container Apps (ACA) if image compatibility, runtime limits, or the beta are unsuitable. Keep the UI and API together rather than adding a Vercel-to-ACA proxy layer.

Sources: [Vercel Container Runtime](https://vercel.com/docs/functions/runtimes/container), [Docker Compose on Vercel](https://vercel.com/i/can-you-run-docker-compose-on-vercel).

## Application behavior relevant to hosting

- Public `/mcp` is stateless Streamable HTTP: POST JSON-RPC, JSON responses, no persistent inbound SSE session. GET/DELETE return 405 by design.
- Custom MCP upstream sessions are short-lived, initialized per operation, and closed afterward. Each discovery/call has a 30-second budget plus up to two seconds for cleanup. An agent run can perform two such operations, so allow roughly 64 seconds plus normal application/database overhead.
- Custom connections and tool snapshots are encrypted in the existing database. This feature needs no additional environment variable or database migration.
- Custom remote endpoints must be public HTTPS on port 443. Loopback, private networks, cloud metadata addresses (including Azure's `168.63.129.16`) and unsafe redirects are denied. Hosting on ACA does not make private/internal MCP endpoints supported.
- Existing provider OAuth refresh synchronization is process-local. Two replicas can redeem the same rotating refresh token concurrently before the database's conditional credential update. This can invalidate a connection. Distributed refresh coordination remains a prerequisite to treating all existing OAuth integrations as safely horizontally scalable. Custom bearer/no-auth connections do not add this refresh mechanism.

## Runtime configuration

Set these on the hosting platform, never in a committed file or Docker build argument:

| Variable                | Value                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`          | Neon pooled Postgres connection URL, stored as a secret               |
| `APP_URL`               | Stable canonical HTTPS origin, e.g. `https://proxy.example.com`       |
| `AUTH_SECRET`           | Strong random secret, kept stable between replicas/redeploys          |
| `ENCRYPTION_KEY`        | Exactly 32 random bytes encoded as base64, kept stable and backed up  |
| `NODE_ENV`              | `production`                                                          |
| `PORT`                  | `4000`                                                                |
| `ALLOWED_SIGNUP_EMAILS` | Owner addresses/domains, comma-separated; unset permits public signup |
| `TELEMETRY_ENABLED`     | Optional; `false` disables the anonymous heartbeat                    |

For a sole owner who prefers username/password, use [single-owner dashboard login](owner-password-login.md). It needs no email provider or Google setup; agent OAuth/bearer access stays separate. The email allowlist below applies only to the default standard mode.

In standard mode, use Google sign-in with `GOOGLE_CLIENT_ID` and secret `GOOGLE_CLIENT_SECRET`, and register `<APP_URL>/auth/google/callback`. Alternatively configure secret `RESEND_KEY` and `EMAIL_FROM` on a verified sender domain for magic links. Without Resend, the application writes magic links to logs; treat log access as sensitive and do not use this as the default shared-production login flow. Omit unused optional settings; this application treats empty environment values as unset.

**Do not regenerate `ENCRYPTION_KEY` when redeploying or moving hosts.** Changing or losing it makes stored encrypted credentials unreadable. Restore the matching key with database backups. Preview environments need separate secrets and a separate Neon branch/database, not access to live credentials.

## Neon setup and release migrations

Choose a Neon region close to the application region. Obtain both pooled and direct URLs from Neon Console; keep the supplied TLS settings, including `sslmode=require`. Do not copy the local development URL's `sslmode=disable`. Percent-encode special characters in passwords. The existing Prisma 6 standard Postgres client can connect to Neon; this does not require upgrading Prisma or switching to a serverless adapter.

Use the pooled URL for application traffic. The existing code supplies `connection_limit=5` and `pool_timeout=20` unless the URL overrides them. Start there and measure concurrency and connection consumption.

Run schema migrations once per release with a **direct** connection, before promoting the application. The repository schema currently reads only `DATABASE_URL`; merely setting `DIRECT_URL` or `DATABASE_URL_UNPOOLED` will not change where its CLI connects. Inject the direct URL as `DATABASE_URL` in the migration process only:

```sh
# DATABASE_URL is injected by the release runner as the direct Neon URL.
bun --bun packages/db/node_modules/.bin/prisma migrate deploy \
  --schema packages/db/prisma/schema.prisma
```

Then start application instances with the pooled URL. Supply migration credentials securely through the runner's secret store. Do not put credentials in shell history, image layers, build logs, or frontend variables. Give the runtime and migration roles only the privileges they need.

The existing `docker-entrypoint.sh` applies migrations on every start. For a release-job design, override it or add a deliberately reviewed startup option; otherwise a deployment still migrates on cold starts despite running a separate migration job. Do not run production migrations during every preview build. Prisma migrations may work with some pooled configurations, but the direct release connection avoids relying on that compatibility.

Sources: [Neon's current Prisma guide](https://github.com/neondatabase/website/blob/main/content/docs/guides/prisma.md), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling), [Neon compute and scale-to-zero](https://neon.com/docs/manage/endpoints/). A sleeping database adds wake-up latency; disabling scale-to-zero trades cost for responsiveness.

## Vercel deployment recipe

The repository includes `Dockerfile.vercel`, and the image workflow validates it without publishing an extra image. A successful CI image build is not a completed Vercel deployment; account setup, secrets and database migration still need verification.

1. Use the included root `Dockerfile.vercel`. It preserves the built UI, production dependencies, Prisma client and API sources, and starts `bun packages/api/src/index.ts` directly without running migrations on cold starts.
2. Use the repository root as Vercel's build context and the Container preset/runtime. Set `PORT=4000` explicitly in project settings; Vercel otherwise defaults to port 80.
3. Add the runtime settings above to production, and independent preview settings. Set `APP_URL` to the actual stable origin for each environment. Select a region close to Neon.
4. Run the release migration using the direct URL, then deploy a preview with the pooled URL. Verify the image build and runtime before planning production promotion.
5. Check the current image-size, payload and execution limits for the actual project. General Functions documentation specifies a 300-second default duration and a 4.5 MB request/response limit; this API separately caps JSON request bodies at 1 MB. The large-function extension lists Node/Bun/Python, so do not assume its 5 GB limit covers this OCI image. Image eligibility needs a real build check.
6. Verify login, OAuth discovery, custom MCP discovery/call, cold start and restart persistence before promoting.

Container Runtime is beta on all plans. It automatically scales down idle containers; never rely on local disk or background timers for durable work. Static outbound IPs and Secure Compute are currently unsupported for container images. This matters if an upstream provider requires IP allowlisting. Existing provider refresh races need attention before relying on automatic multi-instance concurrency.

Sources: [Container Runtime](https://vercel.com/docs/functions/runtimes/container), [Function limits](https://vercel.com/docs/functions/limitations). For email integrations, [Vercel blocks outbound SMTP port 25](https://vercel.com/kb/guide/serverless-functions-and-smtp); use a provider's supported secure submission port.

## Azure Container Apps fallback recipe

1. Build the existing Dockerfile and push a versioned image to an authorized registry. Use an immutable digest for the deployed revision.
2. Configure a Linux container app with external HTTPS ingress and **target port 4000**. ACA handles TLS; no Caddy container is needed.
3. Inject the settings above using ACA secrets/secret references. Keep the direct database URL scoped to a release job. Use the same migration/startup separation described above. With the image unchanged, its startup entrypoint still migrates using whichever `DATABASE_URL` it receives.
4. For an initial small installation, start with approximately **0.5 vCPU / 1 GiB**, and **min replicas 1 / max replicas 1**. Measure and adjust resources. A warm single replica reduces cold starts and refresh concurrency, but is not high availability; rolling revision overlap can still produce concurrent refreshes.
5. Configure explicit startup, readiness and liveness HTTP probes on `/health`, port 4000. Allow startup time for database wake-up and initialization. The current endpoint verifies that the HTTP process answers, not continued database readiness. Configure ACA probes explicitly rather than relying on Docker's `HEALTHCHECK`.
6. Enable bounded log retention and operational alerts, add the stable production domain, and verify the checklist below. No filesystem volume is needed for application data.

ACA's documented default HTTP ingress request timeout is **240 seconds**. This exceeds the bounded custom MCP operation path but is not unlimited streaming. Premium ingress exposes additional idle-timeout controls and incurs additional infrastructure cost; it is unnecessary for the initial design.

Sources: [ACA ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress), [health probes](https://learn.microsoft.com/en-us/azure/container-apps/health-probes), [scaling](https://learn.microsoft.com/en-us/azure/container-apps/scale-app), [secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets), [storage lifetime](https://learn.microsoft.com/en-us/azure/container-apps/storage-mounts), [premium ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-environment-configuration).

## Stable URLs and release checks

Keep UI, cookies, OAuth and MCP on one origin. The public production origin must route `/mcp`, `/oauth/*`, `/.well-known/*`, `/auth/*`, `/agent-auth/*` and `/api/*` correctly. Platform login challenges must not intercept MCP clients or OAuth discovery; configure reachability intentionally while preserving the application's own authentication. Existing integration callbacks live under `/api/connections/<integration>/callback` and depend on `APP_URL`. Changing origins can require reconnecting providers or updating registered callbacks.

Before production promotion, verify:

- `/health`, UI assets and browser login on the canonical HTTPS domain
- OAuth metadata, registration, PKCE authorization, access-token refresh and revocation
- Custom server discovery, permitted tool calls, denied grants and audit entries
- Rejection of private addresses, unsafe redirects and untrusted endpoint URLs
- Slow/unreachable upstream handling and requests approaching the operation budget
- Persisted connections after process restart with the same encryption key
- Concurrent requests and rotating provider token refresh across instances/revisions
- Backup/restore readiness, migration failure handling and application rollback compatibility

A frontend-only Vercel plus ACA split adds deployment and routing complexity without helping this already unified app. External Vercel rewrites also have a documented **120-second proxy timeout**. Prefer one platform for the application. [Vercel limits](https://vercel.com/docs/limits)

Vercel's usage-based runtime plus Neon is the preferred first trial; ACA with a warm replica adds baseline compute and registry/logging administration but offers explicit replica control and avoids Vercel's container beta. Exact cost depends on traffic, region, plan, retained logs and database activity; no monthly price estimate has been validated here.
