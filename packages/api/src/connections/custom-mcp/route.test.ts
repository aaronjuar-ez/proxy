import {beforeEach, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';
const createConnection = mock();
const getConnectionWithCredential = mock();
const refreshCustomMcpSnapshot = mock();
const discoverTools = mock();
const getUserOrgId = mock();
mock.module('@proxy/db/connection', () => ({createConnection, getConnectionWithCredential, refreshCustomMcpSnapshot}));
mock.module('@proxy/db/organization', () => ({getUserOrgId}));
mock.module('../../utils/secret-crypto', () => ({encryptSecret: (value: string) => Ok(`encrypted:${value}`), decryptSecret: (value: string) => Ok(value.replace(/^encrypted:/, ''))}));
mock.module('./client', () => ({discoverTools}));
const {handleCreateCustomMcpRoute, handleGetCustomMcpRoute, handleRefreshCustomMcpRoute} = await import('./route');
const tool = {name: 'search', inputSchema: {type: 'object'}};
const config = {version: 1, url: 'https://mcp.example.com/mcp', bearerToken: 'test-only-token', tools: [tool]};
const row = {id: 'c1', integrationId: 'custom-mcp', account: 'Example', defaults: [], createdAt: new Date(), credential: `encrypted:${JSON.stringify(config)}`};
function request(body?: unknown) {
	return {user: {userId: 'user-1'}, params: {connectionId: 'c1'}, body} as never;
}
beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org1'));
	discoverTools.mockResolvedValue(Ok([tool]));
	createConnection.mockResolvedValue(Ok(row));
	getConnectionWithCredential.mockResolvedValue(Ok(row));
	refreshCustomMcpSnapshot.mockResolvedValue(Ok(true));
});
test('creates encrypted credential without defaults or credential in response', async () => {
	const result = (await handleCreateCustomMcpRoute(request({account: 'Example', url: config.url, bearerToken: config.bearerToken}))).unwrap();
	expect(createConnection.mock.calls[0]![0]).toMatchObject({orgId: 'org1', integrationId: 'custom-mcp', defaults: []});
	expect(createConnection.mock.calls[0]![0].credential).toStartWith('encrypted:');
	expect(JSON.stringify(result)).not.toContain(config.bearerToken);
	expect(JSON.stringify(result)).not.toContain('credential');
});
test('metadata never returns bearer token and includes exact action fingerprint', async () => {
	const result = (await handleGetCustomMcpRoute(request())).unwrap();
	expect(result.url).toBe(config.url);
	expect(result.tools[0]!.actionId).toStartWith('mcp:');
	expect(JSON.stringify(result)).not.toContain(config.bearerToken);
	expect(getConnectionWithCredential).toHaveBeenCalledWith('org1', 'c1');
});
test('cannot read or refresh another organization connection', async () => {
	getConnectionWithCredential.mockResolvedValue(Ok(null));
	expect((await handleGetCustomMcpRoute(request())).unwrapErr().kind).toBe('not_found');
	expect((await handleRefreshCustomMcpRoute(request())).unwrapErr().kind).toBe('not_found');
	expect(discoverTools).not.toHaveBeenCalled();
});
test('refresh saves only over the credential originally loaded', async () => {
	expect((await handleRefreshCustomMcpRoute(request())).isOk()).toBe(true);
	expect(refreshCustomMcpSnapshot.mock.calls[0]![0]).toMatchObject({connectionId: 'c1', previous: row.credential});
	refreshCustomMcpSnapshot.mockResolvedValue(Ok(false));
	expect((await handleRefreshCustomMcpRoute(request())).unwrapErr().kind).toBe('conflict');
});
test('refuses token header injection and unknown creation settings before remote request', async () => {
	expect((await handleCreateCustomMcpRoute(request({account: 'Example', url: config.url, bearerToken: 'a\r\nb'}))).isErr()).toBe(true);
	expect((await handleCreateCustomMcpRoute(request({account: 'Example', url: config.url, defaults: ['all']}))).isErr()).toBe(true);
	expect(discoverTools).not.toHaveBeenCalled();
});
