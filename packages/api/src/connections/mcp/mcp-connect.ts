import type {Result} from 'ts-results-es';
import {z} from 'zod';

import {Do, type ApiError} from '@proxy/utils';
import type {IntegrationId} from '@proxy/integrations';

import {signInRoutes, type Connected, type SignInRequest} from '../connect-flow';
import {exchangeMcpCode, mcpAuthorizeUrl, registerMcpClient, type McpServer, type McpSignIn} from './mcp-oauth';

/**
 * Connecting an integration by signing in to its MCP server, as Granola, Notion and Linear are, and
 * a custom server by its address, through the sign-in flow every OAuth integration shares
 * (`connect-flow.ts`): the start registers Personal Agent Proxy with the server, keeping the client
 * it registered for the callback, and sends the browser to the server's sign-in.
 */

/**
 * Registers with the server for this sign-in, and its sign-in page, keeping the client for the
 * callback beside `kept`.
 */
export function startMcpSignIn<K extends object>(server: McpServer, {redirectUri, state, challenge}: SignInRequest, kept: K): Promise<Result<{url: string; kept: K & {clientId: string}}, ApiError>> {
	return Do(async ($) => {
		const clientId = $(await registerMcpClient(server, redirectUri));
		return {url: mcpAuthorizeUrl(server, {clientId, redirectUri, state, challenge}), kept: {...kept, clientId}};
	});
}

/** The routes for a server known in advance, as Granola's is: the start, a top-level navigation, and the callback. */
export function mcpConnectRoutes<C>(args: {
	integrationId: IntegrationId;
	server: McpServer;
	// The connection a finished sign-in makes: two sign-ins to the same account are the same one.
	connection: (signIn: McpSignIn, server: McpServer) => Promise<Result<Connected<C>, ApiError>>;
}) {
	const {server} = args;
	return signInRoutes({
		integrationId: args.integrationId,
		name: server.name,
		keptSchema: z.object({clientId: z.string()}),
		start: (request) => startMcpSignIn(server, request, {}),
		finish: ({redirectUri, code, verifier, kept}) =>
			Do(async ($) => {
				const signIn = $(await exchangeMcpCode(server, {clientId: kept.clientId, redirectUri, code, verifier}));
				return $(await args.connection(signIn, server));
			}),
	});
}
