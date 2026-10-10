import {beforeEach, expect, mock, test} from 'bun:test';

let values = new Map<string, string>();
let now = 120_000;
let nextId = 0;
const users = new Set<string>();
const raw = mock(async (strings: TemplateStringsArray, key?: string, initial?: string) => {
	if (strings.join('').includes('clock_timestamp')) {
		return [{now}];
	}
	expect(strings.join('')).toContain('ON CONFLICT ("key") DO UPDATE');
	const value = values.get(key!) ?? initial ?? (key?.endsWith('user-id') ? '' : '0:0');
	values.set(key!, value);
	return [{value}];
});
const createUser = mock(async () => {
	const id = `owner-${++nextId}`;
	users.add(id);
	return {id};
});
const tx = {
	$queryRaw: raw,
	user: {
		create: createUser,
		findUniqueOrThrow: mock(async ({where}: {where: {id: string}}) => {
			if (!users.has(where.id)) {
				throw new Error('Missing owner');
			}
			return {id: where.id};
		}),
	},
	organization: {create: mock(async () => ({id: 'org'}))},
	orgMember: {create: mock(async () => ({}))},
	connection: {create: mock(async () => ({}))},
	instanceMeta: {
		update: mock(async ({where, data}: {where: {key: string}; data: {value: string}}) => {
			values.set(where.key, data.value);
		}),
	},
};
// Model the transaction's row lock: concurrent callers must see the last committed value.
let queue = Promise.resolve();
function transaction<T>(operation: (client: typeof tx) => Promise<T>): Promise<T> {
	const result = queue.then(() => operation(tx));
	queue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}
const findUnique = mock(async ({where}: {where: {key: string}}) => {
	const value = values.get(where.key);
	return value === undefined ? null : {value};
});
mock.module('./index', () => ({db: {$transaction: transaction, instanceMeta: {findUnique}}}));
const {getOrCreatePasswordOwner, isPasswordOwner, reserveOwnerLoginAttempt} =
	await import('./owner-auth');
beforeEach(() => {
	mock.clearAllMocks();
	values = new Map();
	users.clear();
	now = 120_000;
});
test('parallel reservations cannot exceed five in the fixed window', async () => {
	const results = await Promise.all(Array.from({length: 20}, () => reserveOwnerLoginAttempt()));
	expect(results.filter((result) => result.unwrap().allowed)).toHaveLength(5);
	expect(results[5]!.unwrap().retryAfter).toBe(60);
	now += 30_000;
	expect((await reserveOwnerLoginAttempt()).unwrap()).toEqual({allowed: false, retryAfter: 30});
	now += 30_000;
	expect((await reserveOwnerLoginAttempt()).unwrap().allowed).toBe(true);
});
test('concurrent verified login initializes one dedicated workspace without email lookup', async () => {
	const results = await Promise.all(Array.from({length: 8}, () => getOrCreatePasswordOwner()));
	expect(new Set(results.map((result) => result.unwrap())).size).toBe(1);
	expect(createUser).toHaveBeenCalledTimes(1);
	expect(tx.organization.create).toHaveBeenCalledTimes(1);
	expect(tx.orgMember.create).toHaveBeenCalledTimes(1);
	expect(tx.connection.create).toHaveBeenCalledTimes(1);
	expect((await isPasswordOwner(results[0]!.unwrap())).unwrap()).toBe(true);
	expect((await isPasswordOwner('preexisting-user')).unwrap()).toBe(false);
});
test('session owner lookup cannot initialize or claim an owner', async () => {
	expect((await isPasswordOwner('preexisting-user')).unwrap()).toBe(false);
	expect(createUser).not.toHaveBeenCalled();
	expect(values.size).toBe(0);
});
test('deleted owner fails closed rather than recreating identity', async () => {
	values.set('single-owner-password:user-id', 'deleted-owner');
	expect((await getOrCreatePasswordOwner()).isErr()).toBe(true);
	expect(createUser).not.toHaveBeenCalled();
});
test('corrupt rate limit state fails closed', async () => {
	values.set('single-owner-password:login-rate', 'bad:state');
	expect((await reserveOwnerLoginAttempt()).unwrap().allowed).toBe(false);
});
