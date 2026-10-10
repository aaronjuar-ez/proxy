import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';
import type {AgentRow} from '@proxy/db/agent';

const logAgentRequest = mock();
const discoverTools = mock();
const callUpstreamTool = mock();
const getAgent = mock();
const getConnectionWithCredential = mock();
mock.module('@proxy/db/audit', () => ({logAgentRequest}));
mock.module('@proxy/db/connection', () => ({getConnectionWithCredential}));
mock.module('@proxy/db/agent', () => ({getAgent}));
mock.module('../../utils/secret-crypto', () => ({decryptSecret: (value: string) => Ok(value)}));
mock.module('./client', () => ({discoverTools, callUpstreamTool}));
const {toolActionId} = await import('./store');
const {customActions, listCustomAgentTools, runCustomAgentTool} = await import('./agent-tools');
const tool = {
	name: 'edit_tasks',
	description: 'Edit selected tasks',
	inputSchema: {type: 'object', properties: {tasks: {type: 'array', items: {type: 'object', properties: {done: {type: 'boolean'}}}}}},
	outputSchema: {type: 'object'},
	annotations: {readOnlyHint: true},
};
const config = {version: 1, url: 'https://mcp.example.com/mcp', bearerToken: 'test-only-secret', tools: [tool]};
const connection = {id: 'custom-1', integrationId: 'custom-mcp', account: 'Test', createdAt: new Date(), defaults: [{actionId: toolActionId(tool)}], credential: JSON.stringify(config)};
const caller = {agent: {agentId: 'agent-1', orgId: 'org-1', providerId: 'claude', name: 'Claude'}, via: 'mcp' as const};
const agent = {id: 'agent-1', grants: [{connectionId: connection.id, actionId: toolActionId(tool), allowed: true}]} as AgentRow;
beforeEach(() => {
	mock.clearAllMocks();
	getAgent.mockResolvedValue(Ok(agent));
	getConnectionWithCredential.mockResolvedValue(Ok(connection));
	logAgentRequest.mockResolvedValue(Ok(undefined));
	discoverTools.mockResolvedValue(Ok([tool]));
	callUpstreamTool.mockResolvedValue(Ok({content: [{type: 'image', data: 'example', mimeType: 'image/png'}], structuredContent: {count: 1}, isError: false}));
});
describe('custom MCP authorization and audit', () => {
	test('defaults do not grant custom tools; agent needs its own exact grant', () => {
		expect(customActions({...agent, grants: []}, connection)).toEqual([]);
		expect(listCustomAgentTools({...agent, grants: []}, connection).unwrap()).toEqual([]);
	});
	test('preserves nested input/output schemas and treats read-only annotations as untrusted', () => {
		const listed = listCustomAgentTools(agent, connection).unwrap()[0]!;
		expect(listed.inputSchema).toEqual(tool.inputSchema);
		expect(listed.outputSchema).toEqual(tool.outputSchema);
		expect(listed.readOnly).toBe(false);
		expect(listed.risk).toBe('high');
	});
	test('denies before contacting upstream and records denial without arguments', async () => {
		const denied = await runCustomAgentTool(caller, {...agent, grants: []}, connection, tool.name, {secret: 'private'}, {});
		expect(denied.unwrapErr().kind).toBe('forbidden');
		expect(discoverTools).not.toHaveBeenCalled();
		expect(callUpstreamTool).not.toHaveBeenCalled();
		expect(logAgentRequest.mock.calls[0]![0]).toMatchObject({outcome: 'denied', recordTitle: null, query: null});
		expect(JSON.stringify(logAgentRequest.mock.calls)).not.toContain('private');
	});
	test('the trusted read endpoint refuses even an upstream readOnlyHint', async () => {
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {readOnly: true})).unwrapErr().kind).toBe('forbidden');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	test('audit failure prevents all remote work', async () => {
		logAgentRequest.mockResolvedValue(Err(ApiErr.dbError(new Error('down'))));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('db_error');
		expect(discoverTools).not.toHaveBeenCalled();
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	test('passes JSON values and preserves all upstream result content', async () => {
		const args = {tasks: [{done: true, priority: 3, due: null}], dryRun: false};
		const result = (await runCustomAgentTool(caller, agent, connection, tool.name, args, {readOnly: false})).unwrap();
		expect(callUpstreamTool).toHaveBeenCalledWith(config, tool.name, args, expect.any(Function));
		expect(result.upstream).toMatchObject({content: [{type: 'image'}], structuredContent: {count: 1}});
		expect(logAgentRequest.mock.calls[0]![0]).toMatchObject({outcome: 'allowed', action: tool.name});
	});
	test('changed or removed tools cannot execute with stale grants', async () => {
		discoverTools.mockResolvedValueOnce(Ok([{...tool, description: 'Now deletes everything'}]));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('conflict');
		discoverTools.mockResolvedValueOnce(Ok([]));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('conflict');
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	test('refreshing a changed definition requires a new explicit permission', () => {
		const changed = {...tool, inputSchema: {type: 'object', required: ['dangerous']}};
		const next = {...connection, credential: JSON.stringify({...config, tools: [changed]})};
		expect(listCustomAgentTools(agent, next).unwrap()).toEqual([]);
	});
	test('retains upstream tool error as a structured result', async () => {
		callUpstreamTool.mockResolvedValue(Ok({content: [{type: 'text', text: 'Invalid arguments'}], isError: true}));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrap().upstream.isError).toBe(true);
	});
	test('rejects non-object arguments without executing', async () => {
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, [], {})).isErr()).toBe(true);
		expect(callUpstreamTool).not.toHaveBeenCalled();
	});
	test('rechecks revoked agents and changed snapshots immediately before dispatch', async () => {
		callUpstreamTool.mockImplementation(async (_config, _name, _args, beforeCall) => beforeCall());
		getAgent.mockResolvedValueOnce(Ok({...agent, revokedAt: new Date()}));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('forbidden');
		getConnectionWithCredential.mockResolvedValueOnce(Ok({...connection, credential: 'changed'}));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('forbidden');
		getAgent.mockResolvedValueOnce(Ok({...agent, grants: []}));
		expect((await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr().kind).toBe('forbidden');
	});
	test('unknown call outcomes warn against blindly retrying mutations', async () => {
		callUpstreamTool.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('timeout'))));
		const error = (await runCustomAgentTool(caller, agent, connection, tool.name, {}, {})).unwrapErr();
		expect(error.kind).toBe('conflict');
		expect('message' in error && error.message).toContain('before retrying');
	});
	test('fingerprints ignore key order and change on schema metadata change', () => {
		expect(toolActionId({name: 'x', inputSchema: {type: 'object', properties: {}}})).toBe(toolActionId({inputSchema: {properties: {}, type: 'object'}, name: 'x'}));
		expect(toolActionId(tool)).not.toBe(toolActionId({...tool, outputSchema: {type: 'object', required: ['a']}}));
	});
});
