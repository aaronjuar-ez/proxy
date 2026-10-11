import {beforeEach, expect, mock, test} from 'bun:test';

let credential = 'snapshot-A';
let refreshLease: string | null = null;
let grants = new Map<string, boolean>();
const updateMany = mock(
	async ({
		where,
		data,
	}: {
		where: {credential: string; customMcpRefreshLeaseId?: null};
		data: {credential: string; customMcpRefreshLeaseId?: null};
	}) => {
		if (where.credential !== credential) return {count: 0};
		if (where.customMcpRefreshLeaseId === null && refreshLease !== null) return {count: 0};
		if (data.customMcpRefreshLeaseId === null) refreshLease = null;
		credential = data.credential;
		return {count: 1};
	},
);
const deleteMany = mock(async ({where}: {where: {actionId: string | {notIn: string[]}}}) => {
	if (typeof where.actionId === 'string') grants.delete(where.actionId);
	else for (const key of grants.keys()) if (!where.actionId.notIn.includes(key)) grants.delete(key);
	return {count: 1};
});
const upsert = mock(async ({create}: {create: {actionId: string; allowed: boolean}}) => {
	grants.set(create.actionId, create.allowed);
});
const tx = {connection: {updateMany}, agentGrant: {deleteMany, upsert}};
const transaction = mock(async (operation: (client: typeof tx) => Promise<unknown>) =>
	operation(tx),
);
mock.module('./index', () => ({db: {$transaction: transaction}}));
const {refreshCustomMcpSnapshot, setCustomMcpGrants} = await import('./connection');
beforeEach(() => {
	mock.clearAllMocks();
	credential = 'snapshot-A';
	refreshLease = null;
	grants = new Map([['mcp:A', true]]);
});
test('A to B to A never resurrects an old approval', async () => {
	expect(
		(
			await refreshCustomMcpSnapshot({
				connectionId: 'c1',
				previous: 'snapshot-A',
				credential: 'snapshot-B',
				actionIds: ['mcp:B'],
			})
		).unwrap(),
	).toBe(true);
	expect(grants.size).toBe(0);
	expect(
		(
			await refreshCustomMcpSnapshot({
				connectionId: 'c1',
				previous: 'snapshot-B',
				credential: 'snapshot-A2',
				actionIds: ['mcp:A'],
			})
		).unwrap(),
	).toBe(true);
	expect(grants.size).toBe(0);
	expect(transaction).toHaveBeenCalledTimes(2);
});
test('a delayed old grant cannot be written after snapshot refresh', async () => {
	await refreshCustomMcpSnapshot({
		connectionId: 'c1',
		previous: 'snapshot-A',
		credential: 'snapshot-B',
		actionIds: ['mcp:B'],
	});
	expect(
		(
			await setCustomMcpGrants({
				agentId: 'a1',
				connectionId: 'c1',
				previous: 'snapshot-A',
				actions: {'mcp:A': true},
			})
		).unwrap(),
	).toBe(false);
	expect(upsert).not.toHaveBeenCalled();
	expect(grants.size).toBe(0);
});
test('a stale refresh leaves both current snapshot and grants untouched', async () => {
	expect(
		(
			await refreshCustomMcpSnapshot({
				connectionId: 'c1',
				previous: 'old',
				credential: 'snapshot-B',
				actionIds: ['mcp:B'],
			})
		).unwrap(),
	).toBe(false);
	expect(credential).toBe('snapshot-A');
	expect(grants.get('mcp:A')).toBe(true);
	expect(deleteMany).not.toHaveBeenCalled();
});
test('null or false removes grants and current explicit grant uses the same row lock', async () => {
	expect(
		(
			await setCustomMcpGrants({
				agentId: 'a1',
				connectionId: 'c1',
				previous: credential,
				actions: {'mcp:A': null, 'mcp:B': true, 'mcp:stale': false},
			})
		).unwrap(),
	).toBe(true);
	expect(grants.has('mcp:A')).toBe(false);
	expect(grants.get('mcp:B')).toBe(true);
	expect(updateMany.mock.calls[0]![0]).toMatchObject({
		where: {credential: 'snapshot-A'},
		data: {credential: 'snapshot-A'},
	});
});

test('normal tool snapshots cannot race a token rotation lease', async () => {
	refreshLease = 'refresh-in-progress';
	expect(
		(
			await refreshCustomMcpSnapshot({
				connectionId: 'c1',
				previous: credential,
				credential: 'snapshot-B',
				actionIds: ['mcp:B'],
			})
		).unwrap(),
	).toBe(false);
	expect(credential).toBe('snapshot-A');
	expect(refreshLease).toBe('refresh-in-progress');
	expect(grants.get('mcp:A')).toBe(true);
});

test('fresh authenticated OAuth reconnect can atomically supersede a stuck lease', async () => {
	refreshLease = 'abandoned-refresh';
	expect(
		(
			await refreshCustomMcpSnapshot({
				connectionId: 'c1',
				previous: credential,
				credential: 'reconnected',
				actionIds: ['mcp:B'],
				reconnectOAuth: true,
			})
		).unwrap(),
	).toBe(true);
	expect(credential).toBe('reconnected');
	expect(refreshLease).toBeNull();
	expect(grants.size).toBe(0);
	expect(updateMany.mock.calls[0]![0]).toMatchObject({
		data: {customMcpRefreshLeaseId: null, customMcpRefreshLeaseExpiresAt: null},
	});
});
