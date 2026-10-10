import {Err, Ok, type Result} from 'ts-results-es';
import {z} from 'zod';
import {ApiErr, type ApiError, Do, parseSchema, requirePresent} from '@proxy/utils';
import {getAgent, type AgentRow} from '@proxy/db/agent';
import {getConnectionWithCredential, type ConnectionRow} from '@proxy/db/connection';
import {logAgentRequest} from '@proxy/db/audit';
import type {AgentCaller} from '../../agent-side/tools';
import {callUpstreamTool, discoverTools, type UpstreamTool, type UpstreamResult} from './client';
import {readStoredMcp, toolActionId} from './store';

export type UpstreamAgentTool = {
	name: string;
	title: string;
	description: string;
	collectionId: 'tools';
	kind: 'upstream';
	operation: string;
	action: string;
	readOnly: false;
	risk: 'high';
	reachesOthers: true;
	inputSchema: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
};
export function describeUpstreamTool(tool: UpstreamTool): UpstreamAgentTool {
	return {
		name: tool.name,
		title: tool.title ?? tool.name,
		description: tool.description ?? '',
		collectionId: 'tools',
		kind: 'upstream',
		operation: tool.name,
		action: toolActionId(tool),
		readOnly: false,
		risk: 'high',
		reachesOthers: true,
		inputSchema: tool.inputSchema,
		...(tool.outputSchema ? {outputSchema: tool.outputSchema} : {}),
	};
}
export function customActions(agent: AgentRow, connection: ConnectionRow): string[] {
	// Deliberately ignore connection defaults. A new agent never inherits custom tool access.
	return agent.grants.filter((grant) => grant.connectionId === connection.id && grant.allowed && grant.actionId.startsWith('mcp:')).map((grant) => grant.actionId);
}
export function listCustomAgentTools(agent: AgentRow, connection: ConnectionRow & {credential: string | null}): Result<UpstreamAgentTool[], ApiError> {
	return readStoredMcp(connection.credential).map((config) => config.tools.filter((tool) => customActions(agent, connection).includes(toolActionId(tool))).map(describeUpstreamTool));
}

export function runCustomAgentTool(
	caller: AgentCaller,
	agent: AgentRow,
	connection: ConnectionRow & {credential: string | null},
	name: string,
	params: unknown,
	options: {readOnly?: boolean},
): Promise<Result<{upstream: UpstreamResult}, ApiError>> {
	return Do(async ($) => {
		const config = $(readStoredMcp(connection.credential));
		const tool = $(
			requirePresent(
				config.tools.find((tool) => tool.name === name),
				ApiErr.notFound('tool', name),
			),
		);
		const allowed = customActions(agent, connection).includes(toolActionId(tool)) && options.readOnly !== true;
		// Log authorization before a remote side effect, and fail closed if the audit store is down.
		// Never log arguments, results, endpoint URLs, tokens, or provider error messages.
		$(
			await logAgentRequest({
				orgId: caller.agent.orgId,
				agentId: caller.agent.agentId,
				connectionId: connection.id,
				collectionId: 'tools',
				action: name,
				recordTitle: null,
				query: null,
				outcome: allowed ? 'allowed' : 'denied',
				via: caller.via,
			}),
		);
		if (!allowed) return $(Err(ApiErr.forbidden()));
		if (!boundedJson(params ?? {})) return $(Err(ApiErr.validationError('Tool arguments are too deeply nested.')));
		const args = $(parseSchema(z.record(z.string(), z.json()), params ?? {}));
		// A changed definition is never silently executed under an earlier grant. The owner must
		// refresh the snapshot and explicitly grant its new fingerprint. Server annotations are hints,
		// never an authority to route a custom tool through the trusted read-only endpoint.
		const liveTools = $(await discoverTools(config));
		const live = liveTools.find((candidate) => candidate.name === name);
		if (!live || toolActionId(live) !== toolActionId(tool)) return $(Err(ApiErr.conflict('This MCP tool changed. Ask the connection owner to refresh its tools and review access.')));
		const beforeCall = async (): Promise<Result<void, ApiError>> =>
			Do(async ($) => {
				const currentAgent = $(await getAgent(caller.agent.orgId, caller.agent.agentId));
				const currentConnection = $(await getConnectionWithCredential(caller.agent.orgId, connection.id));
				if (
					!currentAgent ||
					currentAgent.revokedAt ||
					!currentConnection ||
					currentConnection.credential !== connection.credential ||
					!customActions(currentAgent, currentConnection).includes(toolActionId(tool))
				) {
					$(
						await logAgentRequest({
							orgId: caller.agent.orgId,
							agentId: caller.agent.agentId,
							connectionId: connection.id,
							collectionId: 'tools',
							action: name,
							recordTitle: null,
							query: null,
							outcome: 'denied',
							via: caller.via,
						}),
					);
					return $(Err(ApiErr.forbidden()));
				}
				return $(Ok(undefined));
			});
		const upstream = $(await callUpstreamTool(config, name, args, beforeCall));
		return {upstream};
	});
}

// Validate structural limits before the recursive JSON validator sees untrusted arguments.
function boundedJson(value: unknown): boolean {
	const queue: Array<{value: unknown; depth: number}> = [{value, depth: 0}];
	let visited = 0;
	while (queue.length) {
		const item = queue.pop()!;
		if (++visited > 100000 || item.depth > 64) return false;
		if (item.value && typeof item.value === 'object') {
			for (const child of Object.values(item.value)) queue.push({value: child, depth: item.depth + 1});
		}
	}
	return true;
}
