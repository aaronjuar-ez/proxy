import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {Ok} from 'ts-results-es';
import type {OAuthHttpResponse} from './oauth-http';

let blockedHost: string | undefined;
mock.module('node:dns/promises', () => ({lookup: async (hostname: string) => [{address: hostname === blockedHost ? '127.0.0.1' : '93.184.216.34', family: 4}]}));
const http = await import('./oauth-http');
let replies: OAuthHttpResponse[] = [];
let sent: {url: string; options: Parameters<typeof http.oauthHttpRequest>[1]}[] = [];
mock.module('./oauth-http', () => ({
	...http,
	oauthHttpRequest: async (url: string, options?: Parameters<typeof http.oauthHttpRequest>[1]) => {
		sent.push({url, options});
		const validation = http.validateOAuthEndpoint(url);
		if (validation.isErr()) {
			return validation;
		}
		return Ok(replies.shift() ?? {status: 404, headers: {}, body: ''});
	},
}));
const {discoverOAuth, registerOAuthClient, createOAuthAuthorizationUrl, exchangeOAuthCode, refreshOAuthTokens, oauthSettingsSchema, oauthTokensSchema} = await import('./oauth-protocol');
const resource = 'https://mcp.example.com/server/mcp';
const issuer = 'https://oauth.example.com/tenant';
const redirectUri = 'https://proxy.example.com/api/connections/custom-mcp/oauth/callback';
const verifier = 'v'.repeat(43);
const settings = {
	resource,
	issuer,
	authorizationEndpoint: 'https://oauth.example.com/authorize',
	tokenEndpoint: 'https://oauth.example.com/token',
	registrationEndpoint: 'https://oauth.example.com/register',
	scope: 'read write',
	clientId: 'public-client',
	tokenEndpointAuthMethod: 'none' as const,
};
const resourceMetadata = {resource, authorization_servers: [issuer], scopes_supported: ['read', 'write']};
const serverMetadata = {
	issuer,
	authorization_endpoint: settings.authorizationEndpoint,
	token_endpoint: settings.tokenEndpoint,
	registration_endpoint: settings.registrationEndpoint,
	response_types_supported: ['code'],
	grant_types_supported: ['authorization_code', 'refresh_token'],
	code_challenge_methods_supported: ['S256'],
	token_endpoint_auth_methods_supported: ['none'],
};
const json = (value: object, status = 200): OAuthHttpResponse => ({status, headers: {'content-type': 'application/json'}, body: JSON.stringify(value)});
const unauthorized = (challenge?: string): OAuthHttpResponse => ({status: 401, headers: challenge ? {'www-authenticate': challenge} : {}, body: ''});
const tokenResponse = {access_token: 'access-secret', refresh_token: 'refresh-secret', token_type: 'Bearer', expires_in: 3600};
const registeredClient = {client_id: 'new-public-client', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none'};

beforeEach(() => {
	blockedHost = undefined;
	replies = [];
	sent = [];
});

describe('custom MCP OAuth discovery', () => {
	test('uses Bearer challenge metadata and scope, preserving quoted commas in other schemes', async () => {
		replies = [unauthorized('Basic realm="unrelated, scope=admin", Bearer resource_metadata="https://mcp.example.com/metadata?version=1", scope="read"'), json(resourceMetadata), json(serverMetadata)];
		const result = (await discoverOAuth(resource)).unwrap();
		expect(result).toMatchObject({resource, issuer, scope: 'read', tokenEndpoint: settings.tokenEndpoint});
		expect(sent.map(({url}) => url)).toEqual([resource, 'https://mcp.example.com/metadata?version=1', 'https://oauth.example.com/.well-known/oauth-authorization-server/tenant']);
		expect(sent[0]!.options).toMatchObject({headersOnly: true});
	});
	test('accepts optional whitespace around challenge parameter equals signs', async () => {
		replies = [unauthorized('Bearer resource_metadata = "https://mcp.example.com/metadata", scope = "read"'), json(resourceMetadata), json(serverMetadata)];
		expect((await discoverOAuth(resource)).unwrap().scope).toBe('read');
		expect(sent[1]!.url).toBe('https://mcp.example.com/metadata');
	});
	test('tries path and root protected metadata, then all OIDC issuer paths in order', async () => {
		replies = [json({}, 405), json({}, 404), json(resourceMetadata), json({}, 404), json({}, 404), json(serverMetadata)];
		expect((await discoverOAuth(resource)).unwrap().scope).toBe('read write');
		expect(sent.map(({url}) => url)).toEqual([
			resource,
			'https://mcp.example.com/.well-known/oauth-protected-resource/server/mcp',
			'https://mcp.example.com/.well-known/oauth-protected-resource',
			'https://oauth.example.com/.well-known/oauth-authorization-server/tenant',
			'https://oauth.example.com/.well-known/openid-configuration/tenant',
			'https://oauth.example.com/tenant/.well-known/openid-configuration',
		]);
	});
	test('deduplicates root discovery locations and omits scope when resource does not advertise it', async () => {
		const root = 'https://mcp.example.com/';
		replies = [unauthorized(), json({resource: root, authorization_servers: ['https://oauth.example.com']}), json({}, 404), json({...serverMetadata, issuer: 'https://oauth.example.com'})];
		expect((await discoverOAuth(root)).unwrap().scope).toBeUndefined();
		expect(sent.map(({url}) => url)).toEqual([
			root,
			'https://mcp.example.com/.well-known/oauth-protected-resource',
			'https://oauth.example.com/.well-known/oauth-authorization-server',
			'https://oauth.example.com/.well-known/openid-configuration',
		]);
	});
	test('rejects resource mismatch before following an attacker issuer, including trailing slash differences', async () => {
		for (const wrongResource of ['https://mcp.example.com', `${resource}/`, `${resource.toUpperCase()}`]) {
			sent = [];
			replies = [unauthorized(), json({...resourceMetadata, resource: wrongResource})];
			expect((await discoverOAuth(resource)).isErr()).toBe(true);
			expect(sent).toHaveLength(2);
		}
	});
	test('rejects issuer mismatch, no S256, unsupported grants and unsupported client authentication', async () => {
		for (const override of [
			{issuer: `${issuer}/`},
			{code_challenge_methods_supported: ['plain']},
			{code_challenge_methods_supported: undefined},
			{response_types_supported: ['token']},
			{grant_types_supported: ['client_credentials']},
			{token_endpoint_auth_methods_supported: ['private_key_jwt']},
		]) {
			sent = [];
			replies = [unauthorized(), json(resourceMetadata), json({...serverMetadata, ...override})];
			expect((await discoverOAuth(resource)).isErr()).toBe(true);
			expect(sent).toHaveLength(3);
		}
	});
	test('rejects unsafe advertised URLs and private DNS even on the browser authorization endpoint', async () => {
		for (const endpoint of ['http://oauth.example.com/authorize', 'https://127.0.0.1/authorize', 'https://oauth.example.com/authorize#fragment']) {
			replies = [unauthorized(), json(resourceMetadata), json({...serverMetadata, authorization_endpoint: endpoint})];
			expect((await discoverOAuth(resource)).isErr()).toBe(true);
		}
		blockedHost = 'oauth.example.com';
		replies = [unauthorized(), json(resourceMetadata), json(serverMetadata)];
		expect((await discoverOAuth(resource)).isErr()).toBe(true);
	});
	test('accepts cross-origin endpoints and passes optional issuer-response binding to the callback', async () => {
		replies = [unauthorized(), json(resourceMetadata), json({...serverMetadata, token_endpoint: 'https://tokens.example.com/token'})];
		expect((await discoverOAuth(resource)).unwrap().tokenEndpoint).toBe('https://tokens.example.com/token');
		replies = [unauthorized(), json(resourceMetadata), json({...serverMetadata, token_endpoint: 'https://tokens.example.com/token', authorization_response_iss_parameter_supported: true})];
		expect((await discoverOAuth(resource)).unwrap().authorizationResponseIssParameterSupported).toBe(true);
	});
	test('prefers public clients then POST secrets, and follows RFC8414 Basic authentication default', async () => {
		for (const [methods, selected] of [
			[['none', 'client_secret_basic', 'client_secret_post'], 'none'],
			[['client_secret_basic', 'client_secret_post'], 'client_secret_post'],
			[['client_secret_basic'], 'client_secret_basic'],
			[undefined, 'client_secret_basic'],
		] as const) {
			replies = [unauthorized(), json(resourceMetadata), json({...serverMetadata, token_endpoint_auth_methods_supported: methods})];
			expect((await discoverOAuth(resource)).unwrap().tokenEndpointAuthMethod).toBe(selected);
		}
	});
	test('never falls back after receiving a malformed successful document or invalid challenge', async () => {
		for (const challenge of [
			'Bearer resource_metadata=""',
			'Bearer resource_metadata="https://localhost/metadata"',
			'Bearer resource_metadata="https://mcp.example.com/meta", resource_metadata="https://mcp.example.com/other"',
			'Bearer scope="read\\"',
		]) {
			replies = [unauthorized(challenge)];
			expect((await discoverOAuth(resource)).isErr()).toBe(true);
		}
		sent = [];
		replies = [unauthorized(), json({authorization_servers: [issuer]}), json(resourceMetadata)];
		expect((await discoverOAuth(resource)).isErr()).toBe(true);
		expect(sent).toHaveLength(2);
	});
});

describe('custom MCP OAuth client', () => {
	test('registers a public PKCE client with exact redirect, grants and scope', async () => {
		replies = [json(registeredClient, 201)];
		expect((await registerOAuthClient(settings, redirectUri)).unwrap()).toEqual({clientId: 'new-public-client', clientSecret: undefined, tokenEndpointAuthMethod: 'none'});
		expect(JSON.parse(sent[0]!.options!.body!)).toEqual({
			client_name: 'Personal Agent Proxy',
			redirect_uris: [redirectUri],
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
			scope: 'read write',
		});
	});
	test('requires confidential DCR method and secret and only requests advertised grants', async () => {
		const metadata = {...settings, tokenEndpointAuthMethod: 'client_secret_post' as const, grantTypesSupported: ['authorization_code']};
		replies = [json({...registeredClient, token_endpoint_auth_method: 'client_secret_post', client_secret: 'client-secret'}, 201)];
		expect((await registerOAuthClient(metadata, redirectUri)).unwrap()).toEqual({clientId: 'new-public-client', clientSecret: 'client-secret', tokenEndpointAuthMethod: 'client_secret_post'});
		expect(JSON.parse(sent[0]!.options!.body!)).toMatchObject({token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code']});
		for (const returned of [
			registeredClient,
			{...registeredClient, token_endpoint_auth_method: 'client_secret_post'},
			{...registeredClient, token_endpoint_auth_method: 'client_secret_basic', client_secret: 'wrong-method-secret'},
		]) {
			replies = [json(returned, 201)];
			const result = await registerOAuthClient(metadata, redirectUri);
			expect(result.isErr()).toBe(true);
			expect(JSON.stringify(result)).not.toContain('wrong-method-secret');
		}
	});
	test('requires pre-registration when DCR is absent and rejects changed client authentication or redirect', async () => {
		expect((await registerOAuthClient({...settings, registrationEndpoint: undefined}, redirectUri)).unwrapErr().kind).toBe('validation_error');
		expect(sent).toHaveLength(0);
		for (const override of [
			{client_secret: 'never-log-this'},
			{token_endpoint_auth_method: 'client_secret_post'},
			{token_endpoint_auth_method: undefined},
			{redirect_uris: ['https://attacker.example.com/callback']},
		]) {
			replies = [json({...registeredClient, ...override}, 201)];
			const result = await registerOAuthClient(settings, redirectUri);
			expect(result.isErr()).toBe(true);
			expect(JSON.stringify(result)).not.toContain('never-log-this');
		}
	});
	test('builds resource-bound S256 authorization with pre-registered IDs and overwrites unsafe parameters', () => {
		const result = createOAuthAuthorizationUrl(
			{...settings, authorizationEndpoint: `${settings.authorizationEndpoint}?client_id=attacker&scope=admin&resource=evil&request_uri=https://evil.example.com&request=jwt&tenant=one`},
			{redirectUri, state: 'random-state', codeChallenge: 'c'.repeat(43)},
		);
		const url = new URL(result.unwrap());
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_id: settings.clientId,
			scope: settings.scope,
			resource,
			tenant: 'one',
			response_type: 'code',
			redirect_uri: redirectUri,
			state: 'random-state',
			code_challenge: 'c'.repeat(43),
			code_challenge_method: 'S256',
		});
		expect(sent).toHaveLength(0);
	});
	test('never puts a confidential client secret in an authorization URL', () => {
		const confidential = {...settings, tokenEndpointAuthMethod: 'client_secret_post' as const, clientSecret: 'client-secret'};
		const url = createOAuthAuthorizationUrl(
			{...confidential, authorizationEndpoint: `${settings.authorizationEndpoint}?client_secret=metadata-secret&client_assertion=assertion&client_assertion_type=jwt`},
			{redirectUri, state: 'random-state', codeChallenge: 'c'.repeat(43)},
		).unwrap();
		expect(url).not.toContain('secret');
		expect(url).not.toContain('assertion');
	});
	test('rejects unsafe callbacks and invalid PKCE', async () => {
		for (const callback of ['http://proxy.example.com/callback', 'https://user:pass@proxy.example.com/callback', `${redirectUri}#fragment`]) {
			expect(createOAuthAuthorizationUrl(settings, {redirectUri: callback, state: 'state', codeChallenge: 'c'.repeat(43)}).isErr()).toBe(true);
			expect((await registerOAuthClient(settings, callback)).isErr()).toBe(true);
		}
		expect((await exchangeOAuthCode(settings, {code: 'code', codeVerifier: 'plain', redirectUri})).isErr()).toBe(true);
		expect(createOAuthAuthorizationUrl(settings, {redirectUri: 'http://localhost:4000/callback', state: 'state', codeChallenge: 'c'.repeat(43)}).isOk()).toBe(true);
		expect(sent).toHaveLength(0);
	});
	test('exchanges with resource and PKCE in form body, and stores millisecond expiry', async () => {
		replies = [json(tokenResponse)];
		const before = Date.now();
		const tokens = (await exchangeOAuthCode(settings, {code: 'code-secret', codeVerifier: verifier, redirectUri})).unwrap();
		expect(tokens).toMatchObject({accessToken: 'access-secret', refreshToken: 'refresh-secret'});
		expect(tokens.expiresAt!).toBeGreaterThanOrEqual(before + 3600_000);
		expect(tokens.expiresAt!).toBeLessThanOrEqual(Date.now() + 3600_000);
		expect(sent[0]!.options!.contentType).toBe('application/x-www-form-urlencoded');
		expect(Object.fromEntries(new URLSearchParams(sent[0]!.options!.body))).toEqual({
			grant_type: 'authorization_code',
			code: 'code-secret',
			code_verifier: verifier,
			redirect_uri: redirectUri,
			client_id: settings.clientId,
			resource,
		});
	});
	test('sends POST client secrets only in token and refresh bodies', async () => {
		const confidential = {...settings, tokenEndpointAuthMethod: 'client_secret_post' as const, clientSecret: 'client-secret'};
		replies = [json(tokenResponse), json(tokenResponse)];
		expect((await exchangeOAuthCode(confidential, {code: 'code', codeVerifier: verifier, redirectUri})).isOk()).toBe(true);
		expect((await refreshOAuthTokens(confidential, {accessToken: 'access', refreshToken: 'refresh'})).isOk()).toBe(true);
		for (const request of sent) {
			expect(request.url).toBe(settings.tokenEndpoint);
			expect(request.url).not.toContain('client-secret');
			expect(request.options!.authorization).toBeUndefined();
			expect(new URLSearchParams(request.options!.body).get('client_secret')).toBe('client-secret');
		}
	});
	test('uses individually form-encoded Basic credentials, never in the body or URL', async () => {
		const confidential = {...settings, tokenEndpointAuthMethod: 'client_secret_basic' as const, clientId: 'client:id', clientSecret: 'space and:colon'};
		replies = [json(tokenResponse)];
		expect((await exchangeOAuthCode(confidential, {code: 'code', codeVerifier: verifier, redirectUri})).isOk()).toBe(true);
		const request = sent[0]!;
		expect(Buffer.from(request.options!.authorization!.slice(6), 'base64').toString()).toBe('client%3Aid:space+and%3Acolon');
		expect(request.options!.body).not.toContain('client_secret');
		expect(request.url).not.toContain('colon');
	});
	test('rejects ambiguous token endpoint query credentials before network access', async () => {
		for (const param of ['client_secret', 'client_id', 'resource', 'code', 'code_verifier', 'grant_type', 'refresh_token']) {
			expect((await exchangeOAuthCode({...settings, tokenEndpoint: `${settings.tokenEndpoint}?${param}=injected`}, {code: 'code', codeVerifier: verifier, redirectUri})).isErr()).toBe(true);
		}
		expect(sent).toHaveLength(0);
	});
	test('rotates refresh tokens, preserves omitted refresh tokens, and never preserves stale expiry', async () => {
		const current = {accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 123};
		replies = [json(tokenResponse)];
		expect((await refreshOAuthTokens(settings, current)).unwrap().refreshToken).toBe('refresh-secret');
		expect(Object.fromEntries(new URLSearchParams(sent[0]!.options!.body))).toEqual({grant_type: 'refresh_token', refresh_token: 'old-refresh', client_id: settings.clientId, resource});
		replies = [json({access_token: 'new-access', token_type: 'bearer'})];
		expect((await refreshOAuthTokens(settings, current)).unwrap()).toEqual({accessToken: 'new-access', refreshToken: 'old-refresh', expiresAt: undefined});
	});
	test('rejects invalid grants without provider details and refuses unsafe tokens', async () => {
		replies = [json({error: 'invalid_grant', error_description: 'never-log-this'}, 400)];
		const rejected = await refreshOAuthTokens(settings, {accessToken: 'access', refreshToken: 'refresh'});
		expect(rejected.unwrapErr().kind).toBe('credentials_rejected');
		expect(JSON.stringify(rejected)).not.toContain('never-log-this');
		for (const override of [{token_type: 'DPoP'}, {access_token: 'injected\r\nheader'}, {expires_in: -1}, {expires_in: '3600'}, {access_token: ''}]) {
			replies = [json({...tokenResponse, ...override})];
			expect((await exchangeOAuthCode(settings, {code: 'code', codeVerifier: verifier, redirectUri})).isErr()).toBe(true);
		}
		expect((await refreshOAuthTokens(settings, {accessToken: 'access'})).unwrapErr().kind).toBe('credentials_rejected');
	});
	test('persisted schemas reject unsafe endpoints, tokens and expiry', () => {
		expect(oauthSettingsSchema.safeParse(settings).success).toBe(true);
		expect(oauthSettingsSchema.safeParse({...settings, tokenEndpoint: 'https://localhost/token'}).success).toBe(false);
		expect(oauthSettingsSchema.safeParse({...settings, clientSecret: 'secret'}).success).toBe(false);
		expect(oauthSettingsSchema.safeParse({...settings, tokenEndpointAuthMethod: 'client_secret_post'}).success).toBe(false);
		expect(oauthSettingsSchema.safeParse({...settings, tokenEndpointAuthMethod: undefined}).success).toBe(true);
		expect(oauthTokensSchema.safeParse({accessToken: 'access', expiresAt: Infinity}).success).toBe(false);
		expect(oauthTokensSchema.safeParse({accessToken: 'access\n'}).success).toBe(false);
	});
});
