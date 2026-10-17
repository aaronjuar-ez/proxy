import type {Result} from 'ts-results-es';
import type {z} from 'zod';

import type {ApiError} from '@proxy/utils';

import {callWithToken, type TokenRefresher} from '../token-session';
import {callMcpTool} from './mcp-client';
import {isExpiring, mcpCredentialSchema, refreshMcpTokens, type McpServer} from './mcp-oauth';

type StoredConnection = {id: string; credential: string | null};

// The tokens, and whatever else the credential holds beside them, as a custom server's address and
// endpoints, kept as it is when the tokens are replaced.
const storedCredentialSchema = mcpCredentialSchema.loose();

type StoredCredential = z.infer<typeof storedCredentialSchema>;

function mcpRefresher(server: McpServer): TokenRefresher<StoredCredential> {
	return {
		name: server.name,
		schema: storedCredentialSchema,
		isExpiring,
		refresh: async (credential) => (await refreshMcpTokens(server, credential)).map((tokens) => ({...credential, ...tokens})),
	};
}

/**
 * Runs `use` with a connection's access token: refreshed first when it is running out, and once
 * more when the server turns it down anyway. A connection the server won't refresh any more is
 * `credentials_rejected`, and has to be signed in again.
 */
export function withMcpToken<T>(server: McpServer, connection: StoredConnection, use: (accessToken: string) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return callWithToken(mcpRefresher(server), connection, (credential) => use(credential.accessToken));
}

/** Calls one of a server's tools with a connection's token, refreshed as `withMcpToken` does. */
export function callMcpToolFor(server: McpServer, connection: StoredConnection, name: string, args: Record<string, unknown>): Promise<Result<string, ApiError>> {
	return withMcpToken(server, connection, (accessToken) => callMcpTool(server, accessToken, name, args));
}
