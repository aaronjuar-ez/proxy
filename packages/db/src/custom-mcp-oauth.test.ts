import {beforeEach, describe, expect, mock, test} from 'bun:test';

type Attempt = {stateHash: string; userId: string; orgId: string; payload: string; expiresAt: Date};
type Binding = {stateHash: string; userId: string; orgId: string};
const attempts = new Map<string, Attempt>();
const create = mock(async ({data}: {data: Attempt}) => {
	if (attempts.has(data.stateHash)) {
		throw new Error('duplicate state hash');
	}
	attempts.set(data.stateHash, {...data});
	return data;
});
const findAttempt = mock(async ({where}: {where: Binding & {expiresAt: {gt: Date}}}) => {
	const value = attempts.get(where.stateHash);
	if (
		!value ||
		value.userId !== where.userId ||
		value.orgId !== where.orgId ||
		value.expiresAt <= where.expiresAt.gt
	) {
		return null;
	}
	return {...value};
});
const deleteAttempts = mock(
	async ({
		where,
	}: {
		where: Partial<Binding> & {expiresAt: {equals?: Date; gt?: Date; lte?: Date}};
	}) => {
		let count = 0;
		for (const [hash, value] of attempts) {
			if (where.stateHash && where.stateHash !== hash) continue;
			if (where.userId && where.userId !== value.userId) continue;
			if (where.orgId && where.orgId !== value.orgId) continue;
			if (where.expiresAt.equals && where.expiresAt.equals.getTime() !== value.expiresAt.getTime())
				continue;
			if (where.expiresAt.gt && value.expiresAt <= where.expiresAt.gt) continue;
			if (where.expiresAt.lte && value.expiresAt > where.expiresAt.lte) continue;
			attempts.delete(hash);
			count++;
		}
		return {count};
	},
);
type Connection = {
	id: string;
	orgId: string;
	integrationId: string;
	credential: string;
	customMcpRefreshLeaseId: string | null;
	customMcpRefreshLeaseExpiresAt: Date | null;
};
let connection: Connection | null;
const updateConnection = mock(
	async ({
		where,
		data,
	}: {
		where: {
			id: string;
			orgId: string;
			integrationId: string;
			credential: string;
			customMcpRefreshLeaseId: string | null;
		};
		data: Partial<Connection>;
	}) => {
		if (
			!connection ||
			connection.id !== where.id ||
			connection.orgId !== where.orgId ||
			connection.integrationId !== where.integrationId ||
			connection.credential !== where.credential ||
			connection.customMcpRefreshLeaseId !== where.customMcpRefreshLeaseId
		) {
			return {count: 0};
		}
		connection = {...connection, ...data};
		return {count: 1};
	},
);
const findConnection = mock(
	async ({where}: {where: {id: string; orgId: string; integrationId: string}}) => {
		if (
			!connection ||
			connection.id !== where.id ||
			connection.orgId !== where.orgId ||
			connection.integrationId !== where.integrationId
		) {
			return null;
		}
		return {...connection};
	},
);
mock.module('./index', () => ({
	db: {
		customMcpOAuthAttempt: {create, findFirst: findAttempt, deleteMany: deleteAttempts},
		connection: {updateMany: updateConnection, findFirst: findConnection},
	},
}));
const {
	createCustomMcpOAuthAttempt,
	consumeCustomMcpOAuthAttempt,
	acquireCustomMcpOAuthRefresh,
	completeCustomMcpOAuthRefresh,
} = await import('./custom-mcp-oauth');
const binding = {stateHash: 'sha256-state', userId: 'user-1', orgId: 'org-1'};
const lease = {
	orgId: 'org-1',
	connectionId: 'connection-1',
	previous: 'encrypted-old',
	leaseId: 'lease-1',
	expiresAt: new Date(Date.now() + 60_000),
};

beforeEach(() => {
	mock.clearAllMocks();
	attempts.clear();
	connection = {
		id: 'connection-1',
		orgId: 'org-1',
		integrationId: 'custom-mcp',
		credential: 'encrypted-old',
		customMcpRefreshLeaseId: null,
		customMcpRefreshLeaseExpiresAt: null,
	};
});

describe('durable custom MCP OAuth attempts', () => {
	test('stores only the supplied hash, binding and encrypted payload', async () => {
		const data = {...binding, payload: 'encrypted-pkce', expiresAt: new Date(Date.now() + 60_000)};
		expect((await createCustomMcpOAuthAttempt(data)).isOk()).toBe(true);
		expect(create).toHaveBeenCalledWith({data});
		expect((await consumeCustomMcpOAuthAttempt(binding)).unwrap()).toBe('encrypted-pkce');
		expect((await consumeCustomMcpOAuthAttempt(binding)).unwrap()).toBeNull();
	});

	test('simultaneous callbacks consume one payload even when both read it first', async () => {
		await createCustomMcpOAuthAttempt({
			...binding,
			payload: 'encrypted-pkce',
			expiresAt: new Date(Date.now() + 60_000),
		});
		const results = await Promise.all([
			consumeCustomMcpOAuthAttempt(binding),
			consumeCustomMcpOAuthAttempt(binding),
		]);
		expect(results.map((result) => result.unwrap()).sort()).toEqual(['encrypted-pkce', null]);
		expect(deleteAttempts).toHaveBeenCalledTimes(3);
	});

	test('wrong user, organization or state cannot consume the intended owner’s attempt', async () => {
		await createCustomMcpOAuthAttempt({
			...binding,
			payload: 'encrypted-pkce',
			expiresAt: new Date(Date.now() + 60_000),
		});
		for (const other of [
			{...binding, userId: 'other'},
			{...binding, orgId: 'other'},
			{...binding, stateHash: 'other'},
		]) {
			expect((await consumeCustomMcpOAuthAttempt(other)).unwrap()).toBeNull();
		}
		expect((await consumeCustomMcpOAuthAttempt(binding)).unwrap()).toBe('encrypted-pkce');
	});

	test('expired attempts are unavailable and pruned without deleting live ones', async () => {
		await createCustomMcpOAuthAttempt({
			...binding,
			payload: 'expired',
			expiresAt: new Date(Date.now() - 1000),
		});
		await createCustomMcpOAuthAttempt({
			...binding,
			stateHash: 'live',
			payload: 'live',
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect((await consumeCustomMcpOAuthAttempt(binding)).unwrap()).toBeNull();
		expect(attempts.has(binding.stateHash)).toBe(false);
		expect(deleteAttempts).toHaveBeenCalledWith({where: {expiresAt: {lte: expect.any(Date)}}});
		expect(attempts.has('live')).toBe(true);
	});
});

describe('cross-instance custom MCP OAuth refresh lease', () => {
	test('only one simultaneous worker acquires a credential’s refresh lease', async () => {
		const results = await Promise.all([
			acquireCustomMcpOAuthRefresh(lease),
			acquireCustomMcpOAuthRefresh({...lease, leaseId: 'lease-2'}),
		]);
		expect(results.map((result) => result.unwrap()).sort()).toEqual(['acquired', 'busy']);
		expect(connection?.customMcpRefreshLeaseId).toBe('lease-1');
	});

	test('never recycles an expired lease and its possibly spent refresh token', async () => {
		await acquireCustomMcpOAuthRefresh({...lease, expiresAt: new Date(Date.now() - 1000)});
		expect((await acquireCustomMcpOAuthRefresh({...lease, leaseId: 'lease-2'})).unwrap()).toBe(
			'abandoned',
		);
		expect(connection?.customMcpRefreshLeaseId).toBe('lease-1');
	});

	test('organization, integration and missing connection checks gate acquisition', async () => {
		expect((await acquireCustomMcpOAuthRefresh({...lease, orgId: 'other'})).unwrap()).toBe(
			'missing',
		);
		connection!.integrationId = 'granola';
		expect((await acquireCustomMcpOAuthRefresh(lease)).unwrap()).toBe('missing');
		connection = null;
		expect((await acquireCustomMcpOAuthRefresh(lease)).unwrap()).toBe('missing');
	});

	test('detects changed credentials before sending any refresh request', async () => {
		connection!.credential = 'encrypted-new';
		expect((await acquireCustomMcpOAuthRefresh(lease)).unwrap()).toBe('changed');
	});

	test('completion requires matching owner and credential, persists then unlocks', async () => {
		await acquireCustomMcpOAuthRefresh(lease);
		expect(
			(
				await completeCustomMcpOAuthRefresh({...lease, leaseId: 'other', credential: 'loser'})
			).unwrap(),
		).toBe(false);
		expect(
			(
				await completeCustomMcpOAuthRefresh({...lease, previous: 'stale', credential: 'loser'})
			).unwrap(),
		).toBe(false);
		expect(connection?.credential).toBe('encrypted-old');
		expect(
			(await completeCustomMcpOAuthRefresh({...lease, credential: 'encrypted-new'})).unwrap(),
		).toBe(true);
		expect(connection?.credential).toBe('encrypted-new');
		expect(connection?.customMcpRefreshLeaseId).toBeNull();
		expect(connection?.customMcpRefreshLeaseExpiresAt).toBeNull();
	});

	test('fresh reconnect fences out the earlier refresh even after lease replacement', async () => {
		await acquireCustomMcpOAuthRefresh(lease);
		connection!.credential = 'encrypted-reconnect';
		connection!.customMcpRefreshLeaseId = null;
		connection!.customMcpRefreshLeaseExpiresAt = null;
		expect((await completeCustomMcpOAuthRefresh({...lease, credential: 'loser'})).unwrap()).toBe(
			false,
		);
		expect(connection?.credential).toBe('encrypted-reconnect');
	});
});
