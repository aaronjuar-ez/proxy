import {createHash} from 'node:crypto';
import {beforeEach, expect, mock, test} from 'bun:test';
import {Ok, Err} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';
import type {Response} from 'express';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
const createConnection = mock();
const getConnectionWithCredential = mock();
const refreshCustomMcpSnapshot = mock();
const createCustomMcpOAuthAttempt = mock();
const consumeCustomMcpOAuthAttempt = mock();
const getUserOrgId = mock();
const discoverTools = mock();
const discoverOAuth = mock();
const registerOAuthClient = mock();
const exchangeOAuthCode = mock();
mock.module('@proxy/db/connection', () => ({createConnection, getConnectionWithCredential, refreshCustomMcpSnapshot}));
mock.module('@proxy/db/custom-mcp-oauth', () => ({createCustomMcpOAuthAttempt, consumeCustomMcpOAuthAttempt}));
mock.module('@proxy/db/organization', () => ({getUserOrgId}));
mock.module('../../utils/env', () => ({env: {APP_URL: 'https://proxy.example.com'}}));
mock.module('../../utils/secret-crypto', () => ({encryptSecret: (value: string) => Ok(`encrypted:${value}`), decryptSecret: (value: string) => Ok(value.replace(/^encrypted:/, ''))}));
mock.module('./client', () => ({discoverTools}));
const protocol = await import('./oauth-protocol');
mock.module('./oauth-protocol', () => ({...protocol, discoverOAuth, registerOAuthClient, exchangeOAuthCode}));
const {handleStartCustomMcpOAuth, handleCustomMcpOAuthCallback, handleDiscoverCustomMcpOAuth} = await import('./oauth-route');
const metadata = {
	resource: 'https://mcp.example.com/mcp',
	issuer: 'https://auth.example.com',
	authorizationEndpoint: 'https://auth.example.com/authorize',
	tokenEndpoint: 'https://auth.example.com/token',
	registrationEndpoint: 'https://auth.example.com/register',
	scope: 'mcp',
	tokenEndpointAuthMethod: 'none' as const,
};
const tools = [{name: 'search', inputSchema: {type: 'object'}}];
function request(body?: object, query: Record<string, string> = {}, cookie = '') {
	return Object.assign({} as AuthenticatedRequest, {
		user: {userId: 'u1', email: 'owner@example.com'},
		params: {issuerKey: createHash('sha256').update(metadata.issuer).digest('hex')},
		body,
		query,
		headers: {cookie},
	});
}
function response() {
	const res = {setHeader: mock(), cookie: mock(), clearCookie: mock(), json: mock(), redirect: mock(), status: mock()};
	res.status.mockImplementation(() => res);
	return res;
}
beforeEach(() => {
	mock.clearAllMocks();
	getUserOrgId.mockResolvedValue(Ok('org1'));
	discoverOAuth.mockResolvedValue(Ok(metadata));
	registerOAuthClient.mockResolvedValue(Ok({clientId: 'client-1', tokenEndpointAuthMethod: 'none'}));
	exchangeOAuthCode.mockResolvedValue(Ok({accessToken: 'secret-access', refreshToken: 'secret-refresh', expiresAt: Date.now() + 3600000}));
	discoverTools.mockResolvedValue(Ok(tools));
	createConnection.mockResolvedValue(Ok({id: 'c1'}));
	createCustomMcpOAuthAttempt.mockResolvedValue(Ok(undefined));
	refreshCustomMcpSnapshot.mockResolvedValue(Ok(true));
	consumeCustomMcpOAuthAttempt.mockImplementation(() => Ok(createCustomMcpOAuthAttempt.mock.calls[0]![0].payload));
});
async function start(body: object = {account: 'Example', url: metadata.resource}) {
	const res = response();
	await handleStartCustomMcpOAuth(request(body), res as never as Response);
	return res;
}
async function callback(started: ReturnType<typeof response>, query: Record<string, string> = {}) {
	const state = started.cookie.mock.calls[0]![1] as string;
	const res = response();
	await handleCustomMcpOAuthCallback(request(undefined, {state, code: 'code-1', ...query}, `proxy.custom-mcp-oauth-state=${state}`), res as never as Response);
	return res;
}
test('start creates encrypted expiring user/org-bound state and PKCE without credentials in response', async () => {
	const res = await start();
	const value = res.json.mock.calls[0]![0];
	const authorization = new URL(value.authorizationUrl);
	expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
	expect(authorization.searchParams.get('resource')).toBe(metadata.resource);
	expect(authorization.searchParams.get('code_challenge')).toHaveLength(43);
	const saved = createCustomMcpOAuthAttempt.mock.calls[0]![0];
	expect(saved).toMatchObject({userId: 'u1', orgId: 'org1'});
	expect(saved.stateHash).toHaveLength(64);
	expect(saved.payload).toStartWith('encrypted:');
	expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());
	expect(res.cookie.mock.calls[0]![2]).toMatchObject({httpOnly: true, secure: true, sameSite: 'lax'});
	expect(JSON.stringify(value)).not.toContain('verifier');
});
test('a pre-registered public client bypasses DCR', async () => {
	const res = await start({account: 'Example', url: metadata.resource, clientId: 'approved-client'});
	expect(registerOAuthClient).not.toHaveBeenCalled();
	expect(new URL(res.json.mock.calls[0]![0].authorizationUrl).searchParams.get('client_id')).toBe('approved-client');
});
test('callback exchanges code with verifier, encrypts tokens, creates default-deny connection', async () => {
	const res = await callback(await start());
	expect(exchangeOAuthCode.mock.calls[0]![1]).toMatchObject({
		code: 'code-1',
		redirectUri: `https://proxy.example.com/api/connections/custom-mcp/oauth/callback/${createHash('sha256').update(metadata.issuer).digest('hex')}`,
	});
	expect(exchangeOAuthCode.mock.calls[0]![1].codeVerifier).toHaveLength(43);
	expect(createConnection.mock.calls[0]![0]).toMatchObject({orgId: 'org1', defaults: []});
	expect(createConnection.mock.calls[0]![0].credential).toStartWith('encrypted:');
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/connections/c1?added');
	expect(JSON.stringify(res.redirect.mock.calls)).not.toContain('secret');
});
test('wrong browser state does not consume a valid attempt or exchange code', async () => {
	await start();
	const res = response();
	await handleCustomMcpOAuthCallback(request(undefined, {state: 'a'.repeat(43), code: 'code'}, 'proxy.custom-mcp-oauth-state=other'), res as never as Response);
	expect(consumeCustomMcpOAuthAttempt).not.toHaveBeenCalled();
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/connections/new/custom-mcp?oauth=failed');
});
test('consumed, expired, or wrong-owner attempt is never exchanged', async () => {
	const begun = await start();
	consumeCustomMcpOAuthAttempt.mockResolvedValue(Ok(null));
	await callback(begun);
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
});
test('issuer mismatch and provider cancellation fail without token request', async () => {
	const begun = await start();
	await callback(begun, {iss: 'https://evil.example.com'});
	await callback(begun, {error: 'access_denied'});
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
});
test('iss is required when authorization server advertises support', async () => {
	discoverOAuth.mockResolvedValue(Ok({...metadata, authorizationResponseIssParameterSupported: true}));
	await callback(await start());
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
});
test('reconnect discards every earlier tool grant even if definitions match', async () => {
	const config = {version: 1, url: metadata.resource, tools, oauth: {settings: {...metadata, clientId: 'client-1'}, tokens: {accessToken: 'old'}}};
	const row = {id: 'c1', account: 'Example', integrationId: 'custom-mcp', credential: `encrypted:${JSON.stringify(config)}`};
	getConnectionWithCredential.mockResolvedValue(Ok(row));
	const res = await callback(await start({connectionId: 'c1'}));
	expect(refreshCustomMcpSnapshot.mock.calls[0]![0]).toMatchObject({connectionId: 'c1', previous: row.credential, actionIds: [], reconnectOAuth: true});
	expect(createConnection).not.toHaveBeenCalled();
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/connections/c1?oauth=connected');
});
test('changed or deleted connection cannot be silently replaced by an old callback', async () => {
	getConnectionWithCredential.mockResolvedValue(
		Ok({id: 'c1', account: 'Example', integrationId: 'custom-mcp', credential: `encrypted:${JSON.stringify({version: 1, url: metadata.resource, tools})}`}),
	);
	const begun = await start({connectionId: 'c1'});
	getConnectionWithCredential.mockResolvedValue(Ok(null));
	await callback(begun);
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
	expect(createConnection).not.toHaveBeenCalled();
});
test('welcome flow preserves its return destination', async () => {
	const res = await callback(await start({account: 'Example', url: metadata.resource, returnTo: 'welcome'}));
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/welcome/connections/c1?added');
});
test('provider failure never stores a partial connection or exposes its error body', async () => {
	exchangeOAuthCode.mockResolvedValue(Err(ApiErr.credentialsRejected()));
	const res = await callback(await start());
	expect(createConnection).not.toHaveBeenCalled();
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/connections/new/custom-mcp?oauth=failed');
});
test('invalid URL and extra auth fields fail before any network operation', async () => {
	await start({account: 'Example', url: 'https://localhost/mcp'});
	await start({account: 'Example', url: metadata.resource, clientSecret: 'no'});
	expect(discoverOAuth).not.toHaveBeenCalled();
});

test('issuer-specific callback path rejects cross-issuer code mix-up before exchange', async () => {
	const begun = await start();
	const state = begun.cookie.mock.calls[0]![1] as string;
	const req = request(undefined, {state, code: 'honest-code'}, `proxy.custom-mcp-oauth-state=${state}`);
	req.params.issuerKey = 'other-issuer';
	await handleCustomMcpOAuthCallback(req, response() as never as Response);
	expect(exchangeOAuthCode).not.toHaveBeenCalled();
});
test('confidential DCR secret stays encrypted and is never returned with authorization URL', async () => {
	discoverOAuth.mockResolvedValue(Ok({...metadata, tokenEndpointAuthMethod: 'client_secret_post'}));
	registerOAuthClient.mockResolvedValue(Ok({clientId: 'confidential-client', clientSecret: 'registration-secret', tokenEndpointAuthMethod: 'client_secret_post'}));
	const begun = await start();
	expect(JSON.stringify(begun.json.mock.calls)).not.toContain('registration-secret');
	const res = await callback(begun);
	expect(createConnection.mock.calls[0]![0].credential).toContain('registration-secret');
	expect(createConnection.mock.calls[0]![0].credential).toStartWith('encrypted:');
	expect(res.redirect).toHaveBeenCalledWith('https://proxy.example.com/connections/c1?added');
});
test('manual public ID is rejected for a provider requiring confidential client authentication', async () => {
	discoverOAuth.mockResolvedValue(Ok({...metadata, tokenEndpointAuthMethod: 'client_secret_post'}));
	const res = await start({account: 'Example', url: metadata.resource, clientId: 'public-client'});
	expect(res.status).toHaveBeenCalledWith(400);
	expect(registerOAuthClient).not.toHaveBeenCalled();
	expect(createCustomMcpOAuthAttempt).not.toHaveBeenCalled();
});

test('read-only discovery returns exact issuer callback without registering or storing a handshake', async () => {
	const result = (await handleDiscoverCustomMcpOAuth(request({url: metadata.resource}))).unwrap();
	expect(result).toEqual({
		issuer: metadata.issuer,
		redirectUri: `https://proxy.example.com/api/connections/custom-mcp/oauth/callback/${createHash('sha256').update(metadata.issuer).digest('hex')}`,
		registrationSupported: true,
		publicClientSupported: true,
	});
	expect(registerOAuthClient).not.toHaveBeenCalled();
	expect(createCustomMcpOAuthAttempt).not.toHaveBeenCalled();
});
