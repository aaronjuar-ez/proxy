import {Err, type Result} from 'ts-results-es';
import {z} from 'zod';
import {ApiErr, type ApiError, Do, parseSchema} from '@proxy/utils';
import {createConnection, refreshCustomMcpSnapshot} from '@proxy/db/connection';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {requireUserOrgId} from '../../utils/user-org';
import {encryptSecret} from '../../utils/secret-crypto';
import {toConnectionResponse, type ConnectionResponse} from '../connection-response';
import {discoverTools} from './client';
import {prepareCustomMcp, upstreamConfig} from './oauth-session';
import {CUSTOM_MCP, loadCustomMcp, publicMcp, toolActionId, type StoredMcp} from './store';

const createSchema = z
	.object({
		account: z.string().trim().min(1).max(200),
		url: z.string().url().max(2048),
		bearerToken: z
			.string()
			.min(1)
			.max(8192)
			.regex(/^[\x21-\x7e]+$/)
			.optional(),
	})
	.strict();

export function handleCreateCustomMcpRoute(request: AuthenticatedRequest): Promise<Result<ConnectionResponse, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const {account, ...config} = $(parseSchema(createSchema, request.body));
		const tools = $(await discoverTools(config));
		const credential = $(encryptSecret(JSON.stringify({version: 1, ...config, tools} satisfies StoredMcp)));
		return toConnectionResponse($(await createConnection({orgId, integrationId: CUSTOM_MCP, account, credential, defaults: []})));
	});
}
export function handleGetCustomMcpRoute(request: AuthenticatedRequest): Promise<Result<ReturnType<typeof publicMcp>, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		const {config} = $(await loadCustomMcp(orgId, request.params.connectionId ?? ''));
		return publicMcp(config);
	});
}
export function handleRefreshCustomMcpRoute(request: AuthenticatedRequest): Promise<Result<ReturnType<typeof publicMcp>, ApiError>> {
	return Do(async ($) => {
		const orgId = $(await requireUserOrgId(request));
		let prepared = $(await prepareCustomMcp(orgId, request.params.connectionId ?? ''));
		let discovery = await discoverTools(upstreamConfig(prepared.config));
		if (discovery.isErr() && discovery.error.kind === 'credentials_rejected' && prepared.config.oauth) {
			prepared = $(await prepareCustomMcp(orgId, prepared.connection.id, true));
			discovery = await discoverTools(upstreamConfig(prepared.config));
		}
		const {connection, config} = prepared;
		const tools = $(discovery);
		const next = {...config, tools};
		const credential = $(encryptSecret(JSON.stringify(next)));
		const updated = $(await refreshCustomMcpSnapshot({connectionId: connection.id, credential, previous: connection.credential!, actionIds: tools.map(toolActionId)}));
		if (!updated) return $(Err(ApiErr.conflict('The connection changed. Reload and try again.')));
		return publicMcp(next);
	});
}
