import type {EmailProvider, MailServers} from '@proxy/integrations';
import {z} from 'zod';
import {Do, type FetchError} from '@proxy/utils';
import type {Result} from 'ts-results-es';
import type {Connection} from '@/lib/types';
import {connectionSchema, customMcpSchema} from '@/client/schemas';
import {apiRequest, apiSend} from '@/client/request';
import {isUnauthenticatedError} from '@/client/me-client';

export function listConnections(): Promise<Result<{connections: Connection[]}, FetchError>> {
	return Do(async ($) => {
		const response = $(
			await apiRequest(
				'GET',
				'/api/connections',
				z.object({connections: z.array(connectionSchema)}),
			),
		);
		const connections = await Promise.all(response.connections.map(withCustomMcp));
		return {connections: connections.map((connection) => $(connection))};
	});
}

export function getConnection(connectionId: string): Promise<Result<Connection, FetchError>> {
	return Do(async ($) =>
		$(
			await withCustomMcp(
				$(await apiRequest('GET', `/api/connections/${connectionId}`, connectionSchema)),
			),
		),
	);
}

export function deleteConnection(connectionId: string) {
	return apiSend('DELETE', `/api/connections/${connectionId}`);
}

/** Turns default actions of a connection on or off; actions left out stay as they are. */
export function setConnectionDefaults(connectionId: string, actions: Record<string, boolean>) {
	return apiRequest('PUT', `/api/connections/${connectionId}/defaults`, connectionSchema, {
		actions,
	});
}

export type ConnectEmailInput = {
	provider: EmailProvider['id'];
	email: string;
	password: string;
	servers?: MailServers;
};

/** Signs in to the mailbox first: 422 is a wrong password, 502 a server out of reach. */
export function connectEmail(input: ConnectEmailInput) {
	return apiRequest('POST', '/api/connections/email', connectionSchema, input);
}

/** Signs in to the mailbox and saves nothing: the Test connection button. Answers 204, or the same errors as connecting. */
export function testEmail(input: ConnectEmailInput) {
	return apiSend('POST', '/api/connections/email/test', input);
}

function withCustomMcp(connection: Connection): Promise<Result<Connection, FetchError>> {
	return Do(async ($) => {
		if (connection.integrationId !== 'custom-mcp') {
			return connection;
		}
		const metadata = await apiRequest(
			'GET',
			`/api/connections/${connection.id}/custom-mcp`,
			customMcpSchema,
		);
		if (metadata.isErr() && !isUnauthenticatedError(metadata.error)) {
			// Metadata is optional for recovery: retain the row and its Disconnect action,
			// but discard any stale tools so unavailable permissions cannot be edited.
			return {...connection, customMcp: undefined, customMcpUnavailable: true};
		}
		return {...connection, customMcp: $(metadata)};
	});
}
export function connectCustomMcp(input: {account: string; url: string; bearerToken?: string}) {
	return apiRequest('POST', '/api/connections/custom-mcp', connectionSchema, input);
}
export function refreshCustomMcp(connectionId: string) {
	return apiRequest('POST', `/api/connections/${connectionId}/custom-mcp/refresh`, customMcpSchema);
}
