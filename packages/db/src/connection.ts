import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

export type ConnectionRow = {
	id: string;
	integrationId: string;
	account: string;
	createdAt: Date;
	// A custom MCP server's tools as JSON, the server's own list; null for every other integration.
	tools: string | null;
	// What the person called the connection, where they named it; null for every other integration.
	name: string | null;
	// The actions agents get by default, one per row.
	defaults: Array<{actionId: string}>;
};

// Never the credential: only `getConnectionWithCredential`, `listConnectionsWithCredential` and
// `getConnectionCredential` read it.
const connectionSelect = {
	id: true,
	integrationId: true,
	account: true,
	createdAt: true,
	tools: true,
	name: true,
	defaults: {select: {actionId: true}},
} as const;

export async function listConnections(orgId: string): Promise<Result<ConnectionRow[], ApiError>> {
	return wrapDb(() =>
		db.connection.findMany({
			where: {orgId},
			select: connectionSelect,
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/**
 * The organization's connections with their encrypted credentials, for what a sign-in covered,
 * which the api reads from them.
 */
export async function listConnectionsWithCredential(
	orgId: string,
): Promise<Result<Array<ConnectionRow & {credential: string | null}>, ApiError>> {
	return wrapDb(() =>
		db.connection.findMany({
			where: {orgId},
			select: {...connectionSelect, credential: true},
			orderBy: {createdAt: 'asc'},
		}),
	);
}

/** `Ok(null)` means no such connection in the organization. */
export async function getConnection(
	orgId: string,
	connectionId: string,
): Promise<Result<ConnectionRow | null, ApiError>> {
	return wrapDb(() =>
		db.connection.findFirst({where: {id: connectionId, orgId}, select: connectionSelect}),
	);
}

/** The connection with its encrypted credential, for the code that talks to the provider. */
export async function getConnectionWithCredential(
	orgId: string,
	connectionId: string,
): Promise<Result<(ConnectionRow & {credential: string | null}) | null, ApiError>> {
	return wrapDb(() =>
		db.connection.findFirst({
			where: {id: connectionId, orgId},
			select: {...connectionSelect, credential: true},
		}),
	);
}

/** A connection's encrypted credential as it is now, `null` once the connection is gone. */
export async function getConnectionCredential(
	connectionId: string,
): Promise<Result<string | null, ApiError>> {
	const row = await wrapDb(() =>
		db.connection.findUnique({where: {id: connectionId}, select: {credential: true}}),
	);
	return row.map((found) => found?.credential ?? null);
}

/**
 * `credential` is already encrypted; this package never sees it in the clear. `defaults` are the
 * actions agents get from the start, none when left out; `tools` a custom MCP server's, as JSON,
 * and `name` what the person called it.
 */
export async function createConnection(data: {
	orgId: string;
	integrationId: string;
	account: string;
	providerAccountId?: string | null;
	credential: string;
	defaults?: string[];
	tools?: string;
	name?: string;
}): Promise<Result<ConnectionRow, ApiError>> {
	const {defaults = [], ...connection} = data;
	return wrapDb(() =>
		db.connection.create({
			data: {...connection, defaults: {create: defaults.map((actionId) => ({actionId}))}},
			select: connectionSelect,
		}),
	);
}

/**
 * The organization's connection of an integration for an account, signed in to again: by the
 * provider's own id for the account where it gives one, else by its address, which is also how a
 * connection made before ids were kept is found.
 */
export async function findAccountConnection(data: {
	orgId: string;
	integrationId: string;
	account: string;
	providerAccountId: string | null;
}): Promise<Result<ConnectionRow | null, ApiError>> {
	const {orgId, integrationId, account, providerAccountId} = data;
	return wrapDb(async () => {
		const byId =
			providerAccountId === null
				? null
				: await db.connection.findFirst({
						where: {orgId, integrationId, providerAccountId},
						select: connectionSelect,
					});
		return (
			byId ??
			db.connection.findFirst({
				where: {orgId, integrationId, account, providerAccountId: null},
				select: connectionSelect,
			})
		);
	});
}

/**
 * Gives a connection signed in to again its new credential, and the account as the provider names
 * it now, such as an address changed since.
 */
export async function renewConnection(data: {
	connectionId: string;
	account: string;
	providerAccountId: string | null;
	credential: string;
}): Promise<Result<void, ApiError>> {
	const {connectionId, ...renewed} = data;
	const updated = await wrapDb(() =>
		db.connection.update({where: {id: connectionId}, data: renewed, select: {id: true}}),
	);
	return updated.map(() => undefined);
}

/**
 * Replaces a connection's encrypted credential, as when Granola hands out new tokens. With
 * `previous`, only while the credential is still that one, so two servers refreshing at once
 * don't overwrite each other: `Ok(false)` when it had already changed.
 */
export async function updateConnectionCredential(data: {
	connectionId: string;
	credential: string;
	previous?: string;
}): Promise<Result<boolean, ApiError>> {
	const {connectionId, credential, previous} = data;
	const where =
		previous === undefined ? {id: connectionId} : {id: connectionId, credential: previous};
	return (await wrapDb(() => db.connection.updateMany({where, data: {credential}}))).map(
		({count}) => count > 0,
	);
}

/**
 * Replaces a custom MCP server's tools, as JSON, once the server lists them again, and drops the
 * defaults and agents' settings for actions no longer among `actions`, the tools' names: a setting
 * kept for a tool the server no longer lists would apply to whatever it later lists by that name.
 */
export async function updateConnectionTools(data: {
	connectionId: string;
	tools: string;
	actions: string[];
}): Promise<Result<void, ApiError>> {
	const {connectionId, tools, actions} = data;
	return wrapDb(async () => {
		await db.$transaction([
			db.connection.update({where: {id: connectionId}, data: {tools}}),
			db.connectionDefault.deleteMany({where: {connectionId, actionId: {notIn: actions}}}),
			db.agentGrant.deleteMany({where: {connectionId, actionId: {notIn: actions}}}),
		]);
	});
}

/** Renames a connection; null is no name of its own, so it shows as its integration again. */
export async function updateConnectionName(data: {
	connectionId: string;
	name: string | null;
}): Promise<Result<void, ApiError>> {
	const {connectionId, name} = data;
	return wrapDb(async () => {
		await db.connection.update({where: {id: connectionId}, data: {name}});
	});
}

/**
 * How many connections, in every organization, are for the same account as this one, itself
 * included: those with the provider's id for it, or with its address, as one connected before ids
 * were kept is known by. Zero once the connection is gone.
 */
export async function countSameAccountConnections(
	connectionId: string,
): Promise<Result<number, ApiError>> {
	return wrapDb(async () => {
		const connection = await db.connection.findUnique({
			where: {id: connectionId},
			select: {integrationId: true, account: true, providerAccountId: true},
		});
		if (!connection) {
			return 0;
		}
		const {integrationId, account, providerAccountId} = connection;
		const same = providerAccountId === null ? [{account}] : [{providerAccountId}, {account}];
		return db.connection.count({where: {integrationId, OR: same}});
	});
}

/** `Ok(false)` means no such connection in the organization. Its defaults go with it. */
export async function deleteConnection(
	orgId: string,
	connectionId: string,
): Promise<Result<boolean, ApiError>> {
	return (await wrapDb(() => db.connection.deleteMany({where: {id: connectionId, orgId}}))).map(
		({count}) => count > 0,
	);
}

/**
 * Turns default actions of a connection on or off; actions left out stay as they are. The caller
 * has checked that the connection belongs to the organization and the actions to its integration.
 */
export async function setConnectionDefaults(data: {
	connectionId: string;
	actions: Record<string, boolean>;
}): Promise<Result<void, ApiError>> {
	const {connectionId, actions} = data;
	const on = Object.keys(actions).filter((actionId) => actions[actionId]);
	const off = Object.keys(actions).filter((actionId) => !actions[actionId]);
	return wrapDb(async () => {
		await db.$transaction([
			db.connectionDefault.deleteMany({where: {connectionId, actionId: {in: off}}}),
			...on.map((actionId) =>
				db.connectionDefault.upsert({
					where: {connectionId_actionId: {connectionId, actionId}},
					create: {connectionId, actionId},
					update: {},
				}),
			),
		]);
	});
}
