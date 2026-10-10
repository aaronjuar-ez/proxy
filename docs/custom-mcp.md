# Custom remote MCP connections

Connect a remote MCP tool server once, then explicitly grant individual tools to each agent. Existing built-in Email, Granola, Notion and Linear integrations are unchanged.

## Supported first version

- Public HTTPS Streamable HTTP endpoints on port 443; JSON or POST SSE responses.
- No authentication, or a manually supplied bearer token, encrypted with the existing `ENCRYPTION_KEY`.
- MCP initialization, protocol negotiation, `tools/list` pagination, `tools/call`, and best-effort session termination. Each operation uses a short-lived session, so no sticky routing or shared in-memory sessions are required.
- Nested JSON input schemas, output schemas, JSON arguments (objects, arrays, numbers, booleans, null), and full upstream results including content blocks, structured content, metadata, and `isError`.
- No stdio, local servers, private networks, arbitrary auth headers, URL query credentials, generic OAuth, resource/prompt forwarding, sampling, elicitation, tasks, legacy HTTP+SSE, or SSE resumption. Servers requiring those features need a later adapter. Credentials are not automatically refreshed.

The protocol implementation deliberately has no automatic retry for a tool call. After a timeout or connection failure, a remote action may have happened; check its outcome before manually retrying.

## Setup and use

1. Open Connections → Add connection → Custom MCP (also available in onboarding).
2. Enter a label, the server's public HTTPS MCP URL, and optionally a bearer token. Confirm the server is trustworthy: connecting transmits the token to that hostname for discovery. Do not put tokens in URL paths or query strings.
3. Review the discovered tool descriptions and input/output schemas. A connection starts with no access for any agent.
4. Open an agent's permissions and enable exactly the tools it needs. Custom tools never inherit connection defaults, including for agents created later.
5. An MCP agent uses the existing `list_connections`, `list_tools`, and `run` interface. All custom tools use `run`, even if the upstream advertises `readOnlyHint: true`. The trusted `read` interface refuses custom tools.
6. Browser agents can open the connection's tools page and submit a JSON argument object. Results are rendered as text, without rendering upstream HTML or fetching referenced resources.

An owner can refresh the tool snapshot from the connection page. Grants are fingerprints of the entire discovered definition: changed schema, description, title or annotations require explicit new approval; unchanged definitions retain their grants. Removed or changed fingerprints are permanently discarded, so reverting a definition later does not restore an old approval. The proxy also compares fresh discovery against the approved snapshot before each execution. A remote server can change behavior without changing its definition, so this check is not a substitute for trusting the server operator.

## API

All human endpoints use the existing authenticated, organization-scoped, same-origin/CSRF-protected API:

- `POST /api/connections/custom-mcp` with `{account, url, bearerToken?}` creates a connection after successful discovery.
- `GET /api/connections/:connectionId/custom-mcp` returns `{url, tools}`; tools include `actionId`. The token is never returned.
- `POST /api/connections/:connectionId/custom-mcp/refresh` refreshes definitions with a compare-and-swap credential update.
- `PUT /api/agents/:agentId/grants/:connectionId` with `{actions: {[actionId]: true | false | null}}` changes explicit permissions. Granting unknown/stale action IDs is rejected; `false` or `null` can still remove obsolete grants. `null` removes the explicit setting, which denies access.
- Existing agent tool routes list allowed schemas and accept `{params: <JSON object>}`. The result is `{upstream: <MCP CallToolResult>}`. The MCP wrapper also propagates an upstream `isError` to its outer result. Upstream content blocks are preserved inside the JSON result, not forwarded as top-level MCP image/resource blocks; this first version does not provide native image rendering.

The proxy validates that arguments are bounded JSON objects; the upstream server remains responsible for detailed validation against its JSON Schema. Schemas are preserved rather than converted into the built-in string-only record forms.

## Security and operational limits

- Every request resolves DNS, rejects special-use/private addresses and mixed public/private answers, and pins the socket to a vetted address while keeping hostname TLS verification. IP-literal URLs, local/special-use hostnames, redirects, query strings, embedded URL credentials, non-HTTPS endpoints and nonstandard ports are refused. Azure's platform virtual IP is also refused.
- Tool calls are denied unless the current agent has the exact grant. Agent revocation, the grant and the encrypted snapshot are rechecked immediately before network dispatch, after session setup. Existing organization scoping and revocation checks apply. New custom connections have no defaults.
- Authorization is audited **before** remote discovery/execution. An unavailable audit database prevents execution. For custom tools, `allowed` means an authorized attempt, not confirmed remote success. Arguments, outputs, URLs and tokens are excluded from audit records and transport error messages.
- Requests/responses are size bounded; each discovery or call has a 30-second deadline, with up to 2 seconds for cleanup. One agent run performs both discovery and the call. Allow enough hosting request duration for both operations.
- Discovery is limited to 500 tools, 20 pages and bounded schema nesting/total bytes. Unsupported or oversized discovery fails closed.
- Store data stays in existing encrypted connection credentials and grant/audit tables; no database migration is required. Keep `ENCRYPTION_KEY` stable and backed up.
- Use egress/network restrictions as defense in depth. Do not grant untrusted users access to an instance with unrestricted internal-network privileges.

See [Docker and Neon hosting](custom-mcp-hosting.md) for deployment research and existing multi-replica OAuth caveats. No hosted server or real credential-backed MCP connection was provisioned as part of this change.

Protocol references: [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).
