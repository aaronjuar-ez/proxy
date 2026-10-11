# Custom remote MCP connections

Connect a remote MCP tool server once, then explicitly grant individual tools to each agent. Existing built-in Email, Granola, Notion and Linear integrations are unchanged.

## Supported connections

- Public HTTPS Streamable HTTP endpoints on port 443; JSON or POST SSE responses.
- No authentication, a manually supplied bearer token, or OAuth authorization-code sign-in with PKCE S256. Bearer tokens, OAuth tokens and dynamically registered client secrets are encrypted with the existing `ENCRYPTION_KEY`.
- MCP initialization, protocol negotiation, `tools/list` pagination, `tools/call`, and best-effort session termination. Each operation uses a short-lived session, so no sticky routing or shared in-memory sessions are required.
- Nested JSON input schemas, output schemas, JSON arguments (objects, arrays, numbers, booleans, null), and full upstream results including content blocks, structured content, metadata, and `isError`.
- OAuth protected-resource and authorization-server metadata discovery, automatic client registration where supported, and an optional pre-registered public client ID. Provider or administrator approval may still be required. OAuth access tokens are refreshed when a refresh token is available; manually entered bearer tokens are not refreshed.
- No stdio, local servers, private networks, arbitrary auth headers, URL query credentials, manually entered OAuth client secrets, resource/prompt forwarding, sampling, elicitation, tasks, legacy HTTP+SSE, or SSE resumption. Servers requiring those features need a later adapter. OAuth compatibility depends on the provider exposing supported metadata, PKCE and registration methods.

The protocol implementation deliberately has no automatic retry for a tool call. After a timeout or connection failure, a remote action may have happened; check its outcome before manually retrying.

## Setup and use

1. Open Connections → Add connection → Custom MCP (also available in onboarding).
2. Enter a label and the server's public HTTPS MCP URL, then choose No authentication, Bearer token or OAuth. Confirm the server is trustworthy: a bearer token is sent to that hostname for discovery. With OAuth, continue to the provider to approve access. Never put tokens in URL paths or query strings.
   - Leave Public client ID blank for automatic registration. If your provider does not offer it, use Find callback URL, register a public client with that exact issuer-specific callback, and enter its client ID. Do not guess the callback from the app's origin; it includes a server-generated issuer identifier. A provider that does not accept public clients needs supported automatic registration.
   - OAuth sign-in returns to the connection page, or to the welcome flow when started during onboarding. Denial or an expired sign-in attempt offers a new attempt; no connection is created until sign-in and tool discovery succeed.
3. Review the discovered tool descriptions and input/output schemas. A connection starts with no access for any agent.
4. Open an agent's permissions and enable exactly the tools it needs. Custom tools never inherit connection defaults, including for agents created later.
5. An MCP agent uses the existing `list_connections`, `list_tools`, and `run` interface. All custom tools use `run`, even if the upstream advertises `readOnlyHint: true`. The trusted `read` interface refuses custom tools.
6. Browser agents can open the connection's tools page and submit a JSON argument object. Results are rendered as text, without rendering upstream HTML or fetching referenced resources.

If custom metadata cannot be read, the dashboard keeps that connection visible and disconnectable, with permission editing unavailable until recovery. An owner can refresh the tool snapshot from the connection page. Grants are fingerprints of the entire discovered definition: changed schema, description, title or annotations require explicit new approval; unchanged definitions retain their grants. Removed or changed fingerprints are permanently discarded, so reverting a definition later does not restore an old approval. The proxy also compares fresh discovery against the approved snapshot before each execution. A remote server can change behavior without changing its definition, so this check is not a substitute for trusting the server operator.

## OAuth reconnect and recovery

The connection page offers Reconnect OAuth, including an optional replacement public client ID. Leave it blank for a fresh automatic registration where advertised, or reuse of the existing registration when the provider has no registration endpoint. Reconnect whenever authorization is revoked, refresh cannot recover it, or the provider requires approval again. Successful reconnect removes **all** prior agent grants, even when tool definitions are unchanged: the new authorization may represent a different account. Review the tools and grant access again on each agent's page. A failed reconnect leaves the existing connection and its grants unchanged.

Back from the provider allows another attempt. Leaving the page aborts pending browser requests and ignores late responses; repeated clicks do not create parallel starts from the same form. Finish one OAuth sign-in at a time in a browser, because starting a new attempt replaces its browser state cookie. Access tokens, refresh tokens and client secrets are never returned to the dashboard or agent clients.

## API

All human endpoints use the existing authenticated, organization-scoped, same-origin/CSRF-protected API:

- `POST /api/connections/custom-mcp` with `{account, url, bearerToken?}` creates a no-auth or bearer connection after successful discovery.
- `POST /api/connections/custom-mcp/oauth/discover` with `{url}` or `{connectionId}` returns `{issuer, redirectUri, registrationSupported, publicClientSupported}`. This performs read-only discovery so the exact callback URL can be registered with the provider.
- `POST /api/connections/custom-mcp/oauth/start` with `{account, url, clientId?, returnTo?: "welcome"}`, or `{connectionId, clientId?}` for reconnect, returns `{authorizationUrl}`. The browser navigates to that URL; the authenticated, issuer-bound callback completes code exchange and tool discovery. New connections return to `/connections/:id?added`, reconnects to `/connections/:id?oauth=connected`, and failures to the new form or the existing connection with `?oauth=failed`. Onboarding uses the corresponding `/welcome/connections` routes.
- `GET /api/connections/:connectionId/custom-mcp` returns `{url, tools, authType, oauth?}`; tools include `actionId`, `authType` is `none`, `bearer` or `oauth`, and the optional public OAuth metadata is `{issuer, clientId}`. Tokens and client secrets are never returned.
- `POST /api/connections/:connectionId/custom-mcp/refresh` refreshes definitions with a compare-and-swap credential update.
- `PUT /api/agents/:agentId/grants/:connectionId` with `{actions: {[actionId]: true | false | null}}` changes explicit permissions. Granting unknown/stale action IDs is rejected; `false` or `null` can still remove obsolete grants. `null` removes the explicit setting, which denies access.
- Existing agent tool routes list allowed schemas and accept `{params: <JSON object>}`. The result is `{upstream: <MCP CallToolResult>}`. The MCP wrapper also propagates an upstream `isError` to its outer result. Upstream content blocks are preserved inside the JSON result, not forwarded as top-level MCP image/resource blocks; this first version does not provide native image rendering.

The proxy validates that arguments are bounded JSON objects; the upstream server remains responsible for detailed validation against its JSON Schema. Schemas are preserved rather than converted into the built-in string-only record forms.

## Security and operational limits

- Every server-side upstream request resolves DNS, rejects special-use/private addresses and mixed public/private answers, and pins the socket to a vetted address while keeping hostname TLS verification. IP-literal URLs, local/special-use hostnames, redirects, embedded URL credentials, non-HTTPS endpoints and nonstandard ports are refused. MCP server URLs cannot contain query strings; OAuth metadata endpoints may advertise query parameters. Azure's platform virtual IP is also refused. OAuth discovery, registration, token exchange and refresh use the same network restrictions.
- Tool calls are denied unless the current agent has the exact grant. Agent revocation, the grant and the encrypted snapshot are rechecked immediately before network dispatch, after session setup. Existing organization scoping and revocation checks apply. New custom connections have no defaults.
- Authorization is audited **before** remote discovery/execution. An unavailable audit database prevents execution. For custom tools, `allowed` means an authorized attempt, not confirmed remote success. Arguments, outputs, URLs and tokens are excluded from audit records and transport error messages.
- Requests/responses are size bounded; each discovery or call has a 30-second deadline, with up to 2 seconds for cleanup. One agent run performs both discovery and the call. Allow enough hosting request duration for both operations.
- Discovery is limited to 500 tools, 20 pages and bounded schema nesting/total bytes. Unsupported or oversized discovery fails closed.
- Connection configuration and provider credentials stay encrypted in the existing connection credentials. Apply migration `v013_custom_mcp_oauth` before deploying this version: it adds durable one-use OAuth attempts and per-connection refresh lease columns. Keep `ENCRYPTION_KEY` stable and backed up, and configure `APP_URL` to the browser-facing app origin.
- OAuth attempts expire after 10 minutes and are bound to the signed-in user, organization, browser state cookie, PKCE verifier and issuer-specific callback. State is consumed atomically in the database to prevent replay across server instances. Provider response bodies and token material are not included in public error messages.
- Refresh uses a database-backed lease and a compare-and-swap credential update, protecting rotating refresh tokens across replicas. If a refresh is already running, retry shortly. An abandoned or uncertain refresh requires reconnect rather than reuse of a possibly consumed refresh token. A reconnect or deletion cannot be overwritten by an older refresh. No mutating tool call is automatically retried after an authorization error.
- Use egress/network restrictions as defense in depth. Do not grant untrusted users access to an instance with unrestricted internal-network privileges.

See [Docker and Neon hosting](custom-mcp-hosting.md) for deployment research and the separate built-in integration OAuth caveats. Custom MCP OAuth uses the durable refresh and state protections described above. No hosted server or real credential-backed MCP connection was provisioned as part of this change.

Protocol references: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
