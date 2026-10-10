import {createHash} from 'node:crypto';
import {Err, Result, type Result as ResultType} from 'ts-results-es';
import {z} from 'zod';

import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getConnectionWithCredential, type ConnectionRow} from '@proxy/db/connection';
import {decryptSecret} from '../../utils/secret-crypto';
import type {UpstreamTool} from './client';

export const CUSTOM_MCP = 'custom-mcp';
const jsonObject = z.record(z.string(), z.unknown());
export const upstreamToolSchema = z.object({
	name: z.string().min(1).max(128),
	title: z.string().max(1024).optional(),
	description: z.string().max(32000).optional(),
	inputSchema: jsonObject,
	outputSchema: jsonObject.optional(),
	annotations: jsonObject.optional(),
});
export const storedSchema = z.object({version: z.literal(1), url: z.string().url(), bearerToken: z.string().optional(), tools: z.array(upstreamToolSchema).max(500)});
export type StoredMcp = z.infer<typeof storedSchema>;

// Stable across object key order, but any metadata/schema change requires a fresh human grant.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value !== null && typeof value === 'object')
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(',')}}`;
	return JSON.stringify(value) ?? 'null';
}
export function toolActionId(tool: UpstreamTool): string {
	return `mcp:${createHash('sha256').update(canonical(tool)).digest('hex')}`;
}
export function readStoredMcp(credential: string | null): ResultType<StoredMcp, ApiError> {
	return Do<StoredMcp, ApiError>(($) => {
		const encrypted = $(requirePresent(credential, ApiErr.validationError('Reconnect this MCP server')));
		const json = $(decryptSecret(encrypted));
		const value = $(Result.wrap(() => JSON.parse(json)).mapErr(() => ApiErr.validationError('Reconnect this MCP server')));
		return $(parseSchema(storedSchema, value));
	});
}
export function loadCustomMcp(orgId: string, connectionId: string): Promise<ResultType<{connection: ConnectionRow & {credential: string | null}; config: StoredMcp}, ApiError>> {
	return Do(async ($) => {
		const connection = $(requirePresent($(await getConnectionWithCredential(orgId, connectionId)), ApiErr.notFound('connection', connectionId)));
		if (connection.integrationId !== CUSTOM_MCP) return $(Err(ApiErr.notFound('connection', connectionId)));
		return {connection, config: $(readStoredMcp(connection.credential))};
	});
}
export function publicMcp(config: StoredMcp) {
	return {url: config.url, tools: config.tools.map((tool) => ({...tool, actionId: toolActionId(tool)}))};
}
