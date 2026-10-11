import {afterEach, beforeEach, describe, expect, mock, setSystemTime, test} from 'bun:test';
import {Err, Ok, type Result} from 'ts-results-es';

import type {ConnectionRow} from '@proxy/db/connection';
import type {CustomMcpRefreshLease} from '@proxy/db/custom-mcp-oauth';
import {ApiErr, type ApiError} from '@proxy/utils';
import type {OAuthSettings, OAuthTokens} from './oauth-protocol';
import type {StoredMcp} from './store';

type Prepared = {connection: ConnectionRow & {credential: string | null}; config: StoredMcp};
const settings: OAuthSettings = {
	resource: 'https://example.com/mcp',
	issuer: 'https://auth.example.com',
	authorizationEndpoint: 'https://auth.example.com/authorize',
	tokenEndpoint: 'https://auth.example.com/token',
	clientId: 'client-1',
	tokenEndpointAuthMethod: 'none',
};
const now = 1_800_000_000_000;
const fresh: OAuthTokens = {accessToken: 'fresh-access', refreshToken: 'fresh-refresh', issuedAt: now, expiresAt: now + 3_600_000};
let current: Prepared;
const loadCustomMcp = mock(async (): Promise<Result<Prepared, ApiError>> => Ok(structuredClone(current)));
const acquireCustomMcpOAuthRefresh = mock(async (): Promise<Result<CustomMcpRefreshLease, ApiError>> => Ok('acquired'));
const completeCustomMcpOAuthRefresh = mock(async (data: {credential: string}): Promise<Result<boolean, ApiError>> => {
	current.connection.credential = data.credential;
	current.config = JSON.parse(data.credential.slice(4));
	return Ok(true);
});
const refreshOAuthTokens = mock(async (): Promise<Result<OAuthTokens, ApiError>> => Ok(fresh));
const encryptSecret = mock((plain: string): Result<string, ApiError> => Ok(`enc:${plain}`));
mock.module('./store', () => ({loadCustomMcp}));
mock.module('./oauth-protocol', () => ({refreshOAuthTokens}));
mock.module('@proxy/db/custom-mcp-oauth', () => ({acquireCustomMcpOAuthRefresh, completeCustomMcpOAuthRefresh}));
mock.module('../../utils/secret-crypto', () => ({encryptSecret}));
const {prepareCustomMcp, upstreamConfig} = await import('./oauth-session');

function setup(tokens: OAuthTokens = {accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000}): Prepared {
	const config: StoredMcp = {version: 1, url: settings.resource, oauth: {settings, tokens}, tools: []};
	return {connection: {id: 'c-1', integrationId: 'custom-mcp', account: 'Example', createdAt: new Date(), defaults: [], credential: `enc:${JSON.stringify(config)}`}, config};
}

beforeEach(() => {
	mock.clearAllMocks();
	setSystemTime(now);
	current = setup();
	loadCustomMcp.mockImplementation(async () => Ok(structuredClone(current)));
	acquireCustomMcpOAuthRefresh.mockImplementation(async () => Ok('acquired'));
	completeCustomMcpOAuthRefresh.mockImplementation(async (data) => {
		current.connection.credential = data.credential;
		current.config = JSON.parse(data.credential.slice(4));
		return Ok(true);
	});
	refreshOAuthTokens.mockImplementation(async () => Ok(fresh));
	encryptSecret.mockImplementation((plain) => Ok(`enc:${plain}`));
});

afterEach(() => {
	setSystemTime();
});

describe('prepareCustomMcp', () => {
	test('bearer or unauthenticated connections never take an OAuth lease', async () => {
		current.config = {version: 1, url: settings.resource, bearerToken: 'manual', tools: []};
		expect((await prepareCustomMcp('o-1', 'c-1', true)).unwrap().config.bearerToken).toBe('manual');
		expect(acquireCustomMcpOAuthRefresh).not.toHaveBeenCalled();
		expect(upstreamConfig(current.config)).toEqual({url: settings.resource, bearerToken: 'manual'});
	});

	test('fresh tokens including tokens without a stated expiry are passed through', async () => {
		for (const tokens of [fresh, {accessToken: 'no-expiry', refreshToken: 'refresh'}]) {
			current = setup(tokens);
			expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(tokens);
		}
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
		expect(upstreamConfig(current.config)).toEqual({url: settings.resource, bearerToken: 'no-expiry'});
	});

	test('30-second tokens remain usable across repeated requests until their final three seconds', async () => {
		const tokens = {...fresh, expiresAt: now + 30_000};
		current = setup(tokens);
		for (const elapsed of [0, 10_000, 26_999]) {
			setSystemTime(now + elapsed);
			expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(tokens);
		}
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
		expect(acquireCustomMcpOAuthRefresh).not.toHaveBeenCalled();
		setSystemTime(now + 27_000);
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(fresh);
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(1);
	});

	test('a refreshed 30-second token retains its issuance time and is reused on later requests', async () => {
		const tokens = {...fresh, expiresAt: now + 30_000};
		refreshOAuthTokens.mockResolvedValue(Ok(tokens));
		for (const elapsed of [0, 1000, 2000]) {
			setSystemTime(now + elapsed);
			expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(tokens);
		}
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(1);
		expect(completeCustomMcpOAuthRefresh).toHaveBeenCalledTimes(1);
		expect(JSON.parse(current.connection.credential!.slice(4)).oauth.tokens.issuedAt).toBe(now);
	});

	test('long-lived tokens retain the 60-second maximum expiry margin', async () => {
		current = setup(fresh);
		setSystemTime(fresh.expiresAt! - 60_001);
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(fresh);
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
		setSystemTime(fresh.expiresAt! - 60_000);
		expect((await prepareCustomMcp('o-1', 'c-1')).isOk()).toBe(true);
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(1);
	});

	test('legacy tokens without an issuance time retain their 60-second expiry margin', async () => {
		current = setup({accessToken: 'legacy-access', refreshToken: 'legacy-refresh', expiresAt: now + 60_001});
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens.accessToken).toBe('legacy-access');
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
		setSystemTime(now + 1);
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(fresh);
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(1);
	});

	test('tokens with issuance times refresh at or after expiry, including zero lifetime', async () => {
		for (const tokens of [
			{...fresh, issuedAt: now - 30_000, expiresAt: now},
			{...fresh, issuedAt: now - 31_000, expiresAt: now - 1000},
			{...fresh, expiresAt: now},
		]) {
			current = setup(tokens);
			expect((await prepareCustomMcp('o-1', 'c-1')).unwrap().config.oauth?.tokens).toEqual(fresh);
		}
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(3);
	});

	test('expiring tokens are encrypted, CAS persisted under the lease and reread', async () => {
		const previous = current.connection.credential;
		const tokens = current.config.oauth!.tokens;
		const result = (await prepareCustomMcp('o-1', 'c-1')).unwrap();
		expect(refreshOAuthTokens).toHaveBeenCalledWith(settings, tokens);
		expect(acquireCustomMcpOAuthRefresh).toHaveBeenCalledWith({orgId: 'o-1', connectionId: 'c-1', previous, leaseId: expect.any(String), expiresAt: expect.any(Date)});
		expect(completeCustomMcpOAuthRefresh).toHaveBeenCalledWith({orgId: 'o-1', connectionId: 'c-1', previous, leaseId: expect.any(String), credential: current.connection.credential});
		expect(result.config.oauth?.tokens).toEqual(fresh);
		expect(result.connection.credential).toBe(current.connection.credential);
		expect(loadCustomMcp).toHaveBeenCalledTimes(2);
	});

	test('force refresh handles a rejected token even without an expiry', async () => {
		current = setup({accessToken: 'old-access', refreshToken: 'old-refresh'});
		expect((await prepareCustomMcp('o-1', 'c-1', true)).unwrap().config.oauth?.tokens).toEqual(fresh);
		expect(refreshOAuthTokens).toHaveBeenCalledTimes(1);
	});

	test('missing refresh token fails without contacting the token endpoint', async () => {
		current = setup({accessToken: 'old', expiresAt: Date.now() - 1000});
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('credentials_rejected');
		expect(acquireCustomMcpOAuthRefresh).not.toHaveBeenCalled();
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
	});

	test('a lease on another instance gives a bounded conflict without reusing its token', async () => {
		acquireCustomMcpOAuthRefresh.mockResolvedValue(Ok('busy'));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('conflict');
		expect(acquireCustomMcpOAuthRefresh).toHaveBeenCalledTimes(1);
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
	});

	test('an abandoned lease requires reconnect and never reuses the possibly spent token', async () => {
		acquireCustomMcpOAuthRefresh.mockResolvedValue(Ok('abandoned'));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('credentials_rejected');
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
	});

	test('another instance’s fresh token ends even a forced refresh', async () => {
		acquireCustomMcpOAuthRefresh.mockImplementation(async () => {
			current = setup(fresh);
			return Ok('changed');
		});
		expect((await prepareCustomMcp('o-1', 'c-1', true)).unwrap().config.oauth?.tokens).toEqual(fresh);
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
	});

	test('repeated snapshot conflicts are bounded', async () => {
		acquireCustomMcpOAuthRefresh.mockResolvedValue(Ok('changed'));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('conflict');
		expect(acquireCustomMcpOAuthRefresh).toHaveBeenCalledTimes(3);
		expect(refreshOAuthTokens).not.toHaveBeenCalled();
	});

	test('CAS loser tokens are never returned or used', async () => {
		completeCustomMcpOAuthRefresh.mockResolvedValue(Ok(false));
		const result = await prepareCustomMcp('o-1', 'c-1');
		expect(result.unwrapErr().kind).toBe('conflict');
		expect(current.config.oauth?.tokens.accessToken).toBe('old-access');
	});

	test('uncertain provider failure leaves the durable lease closed', async () => {
		refreshOAuthTokens.mockResolvedValue(Err(ApiErr.providerUnreachable(new Error('timeout'))));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('provider_unreachable');
		expect(completeCustomMcpOAuthRefresh).not.toHaveBeenCalled();
	});

	test('encryption or persistence failures never expose refreshed tokens', async () => {
		encryptSecret.mockReturnValue(Err(ApiErr.internalError(new Error('encryption failed'))));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('internal_error');
		expect(completeCustomMcpOAuthRefresh).not.toHaveBeenCalled();
		encryptSecret.mockImplementation((plain) => Ok(`enc:${plain}`));
		completeCustomMcpOAuthRefresh.mockResolvedValue(Err(ApiErr.dbError(new Error('unavailable'))));
		expect((await prepareCustomMcp('o-1', 'c-1')).unwrapErr().kind).toBe('db_error');
		expect(current.config.oauth?.tokens.accessToken).toBe('old-access');
	});
});
