import {beforeEach, expect, mock, spyOn, test} from 'bun:test';
import {Err, Ok} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';

const reserveOwnerLoginAttempt = mock();
const getOrCreatePasswordOwner = mock();
const isPasswordOwner = mock();
const createSession = mock();
const getAuthenticatedSessionDatabase = mock();
mock.module('@proxy/db/owner-auth', () => ({reserveOwnerLoginAttempt, getOrCreatePasswordOwner, isPasswordOwner}));
mock.module('@proxy/db/auth', () => ({createSession, getAuthenticatedSessionDatabase}));
const env = {AUTH_MODE: 'single-owner-password', OWNER_USERNAME: 'owner', OWNER_PASSWORD_HASH: 'test-hash', APP_URL: 'https://proxy.example', NODE_ENV: 'production'};
mock.module('../utils/env', () => ({env}));
const verify = spyOn(Bun.password, 'verify');
const {handlePasswordLoginRoute} = await import('./password');
const {ownerSessionPrefix} = await import('./owner-password-config');
const {authenticateApiRequest} = await import('../utils/auth');

function response() {
	const res = {status: mock(() => res), json: mock(() => res), setHeader: mock(), cookie: mock()};
	return res;
}
const request = {body: {username: 'owner', password: 'test-only-password'}};
beforeEach(() => {
	mock.clearAllMocks();
	env.AUTH_MODE = 'single-owner-password';
	env.OWNER_USERNAME = 'owner';
	env.OWNER_PASSWORD_HASH = 'test-hash';
	reserveOwnerLoginAttempt.mockResolvedValue(Ok({allowed: true, retryAfter: 0}));
	getOrCreatePasswordOwner.mockResolvedValue(Ok('owner-id'));
	isPasswordOwner.mockResolvedValue(Ok(true));
	createSession.mockResolvedValue(Ok(undefined));
	verify.mockResolvedValue(true);
});
test('valid password creates owner then issues secure credential-bound session', async () => {
	const res = response();
	await handlePasswordLoginRoute(request as never, res as never);
	expect(getOrCreatePasswordOwner).toHaveBeenCalledTimes(1);
	expect(res.json).toHaveBeenCalledWith({ok: true});
	expect(createSession.mock.calls[0]![0]).toMatchObject({userId: 'owner-id'});
	expect(createSession.mock.calls[0]![0].sessionToken).toStartWith(ownerSessionPrefix());
	expect(res.cookie.mock.calls[0]![2]).toMatchObject({secure: true, httpOnly: true, sameSite: 'lax', path: '/'});
});
test('rate limited before Argon2 or provisioning', async () => {
	reserveOwnerLoginAttempt.mockResolvedValue(Ok({allowed: false, retryAfter: 45}));
	const res = response();
	await handlePasswordLoginRoute(request as never, res as never);
	expect(res.status).toHaveBeenCalledWith(429);
	expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '45');
	expect(verify).not.toHaveBeenCalled();
	expect(getOrCreatePasswordOwner).not.toHaveBeenCalled();
});
test('rate storage errors fail closed before Argon2', async () => {
	reserveOwnerLoginAttempt.mockResolvedValue(Err(ApiErr.dbError(new Error('offline'))));
	const res = response();
	await handlePasswordLoginRoute(request as never, res as never);
	expect(res.status).toHaveBeenCalledWith(503);
	expect(verify).not.toHaveBeenCalled();
});
test('wrong username and password share generic failure without provisioning', async () => {
	for (const username of ['other', 'owner']) {
		verify.mockResolvedValue(username !== 'owner');
		const res = response();
		await handlePasswordLoginRoute({body: {...request.body, username}} as never, res as never);
		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.json).toHaveBeenCalledWith({error: 'InvalidCredentials'});
	}
	expect(verify).toHaveBeenCalledTimes(2);
	expect(getOrCreatePasswordOwner).not.toHaveBeenCalled();
	expect(createSession).not.toHaveBeenCalled();
});
test('oversized and malformed credentials rejected without verification', async () => {
	for (const body of [null, {}, {username: 'owner', password: 'x'.repeat(1025)}]) {
		const res = response();
		await handlePasswordLoginRoute({body} as never, res as never);
		expect(res.status).toHaveBeenCalledWith(401);
	}
	expect(verify).not.toHaveBeenCalled();
});
test('standard mode does not expose password login', async () => {
	env.AUTH_MODE = 'standard';
	const res = response();
	await handlePasswordLoginRoute(request as never, res as never);
	expect(res.status).toHaveBeenCalledWith(404);
	expect(reserveOwnerLoginAttempt).not.toHaveBeenCalled();
});
test('owner session gate rejects old, non-owner and rotated sessions', async () => {
	getAuthenticatedSessionDatabase.mockResolvedValue(Ok({userId: 'owner-id', user: {email: 'owner@owner.invalid', name: 'Owner'}}));
	const token = ownerSessionPrefix() + 'token';
	const headers = {cookie: `proxy.session-token=${token}`};
	expect((await authenticateApiRequest(headers)).isOk()).toBe(true);
	isPasswordOwner.mockResolvedValue(Ok(false));
	expect((await authenticateApiRequest(headers)).isErr()).toBe(true);
	isPasswordOwner.mockResolvedValue(Ok(true));
	env.OWNER_PASSWORD_HASH = 'rotated-hash';
	expect((await authenticateApiRequest(headers)).isErr()).toBe(true);
	expect((await authenticateApiRequest({cookie: 'proxy.session-token=legacy-session'})).isErr()).toBe(true);
});
test('disabling owner mode does not revive its sessions', async () => {
	const token = ownerSessionPrefix() + 'token';
	env.AUTH_MODE = 'standard';
	expect((await authenticateApiRequest({cookie: `proxy.session-token=${token}`})).isErr()).toBe(true);
});
