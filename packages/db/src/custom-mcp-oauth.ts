import type {Result} from 'ts-results-es';

import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

/** State is already hashed and payload already encrypted; no plaintext secrets reach this module. */
export async function createCustomMcpOAuthAttempt(data: {
	stateHash: string;
	userId: string;
	orgId: string;
	payload: string;
	expiresAt: Date;
}): Promise<Result<void, ApiError>> {
	return wrapDb(async () => {
		await db.customMcpOAuthAttempt.deleteMany({where: {expiresAt: {lte: new Date()}}});
		await db.customMcpOAuthAttempt.create({data});
	});
}

/** A valid handshake can be consumed only once, and only by the browser's user and organization. */
export async function consumeCustomMcpOAuthAttempt(binding: {
	stateHash: string;
	userId: string;
	orgId: string;
}): Promise<Result<string | null, ApiError>> {
	return wrapDb(async () => {
		const attempt = await db.customMcpOAuthAttempt.findFirst({
			where: {...binding, expiresAt: {gt: new Date()}},
			select: {payload: true, expiresAt: true},
		});
		if (!attempt) {
			return null;
		}
		// The read is deliberately not the gate: simultaneous callbacks may both reach it.
		const {count} = await db.customMcpOAuthAttempt.deleteMany({
			where: {...binding, expiresAt: {equals: attempt.expiresAt, gt: new Date()}},
		});
		if (count === 0) {
			return null;
		}
		return attempt.payload;
	});
}

export type CustomMcpRefreshLease = 'acquired' | 'changed' | 'busy' | 'abandoned' | 'missing';

/**
 * CAS the encrypted credential and take one durable lease before any token request is sent.
 * Expiry bounds the busy response; it never makes the same rotating refresh token reusable.
 */
export async function acquireCustomMcpOAuthRefresh(data: {
	orgId: string;
	connectionId: string;
	previous: string;
	leaseId: string;
	expiresAt: Date;
}): Promise<Result<CustomMcpRefreshLease, ApiError>> {
	return wrapDb(async () => {
		const binding = {id: data.connectionId, orgId: data.orgId, integrationId: 'custom-mcp'};
		const {count} = await db.connection.updateMany({
			where: {...binding, credential: data.previous, customMcpRefreshLeaseId: null},
			data: {customMcpRefreshLeaseId: data.leaseId, customMcpRefreshLeaseExpiresAt: data.expiresAt},
		});
		if (count > 0) {
			return 'acquired';
		}
		const current = await db.connection.findFirst({
			where: binding,
			select: {
				credential: true,
				customMcpRefreshLeaseId: true,
				customMcpRefreshLeaseExpiresAt: true,
			},
		});
		if (!current) {
			return 'missing';
		}
		if (current.credential !== data.previous) {
			return 'changed';
		}
		if (
			current.customMcpRefreshLeaseId &&
			(!current.customMcpRefreshLeaseExpiresAt ||
				current.customMcpRefreshLeaseExpiresAt <= new Date())
		) {
			return 'abandoned';
		}
		return 'busy';
	});
}

/** Only the lease holder may atomically persist its tokens and unlock the next refresh. */
export async function completeCustomMcpOAuthRefresh(data: {
	orgId: string;
	connectionId: string;
	previous: string;
	leaseId: string;
	credential: string;
}): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() =>
			db.connection.updateMany({
				where: {
					id: data.connectionId,
					orgId: data.orgId,
					integrationId: 'custom-mcp',
					credential: data.previous,
					customMcpRefreshLeaseId: data.leaseId,
				},
				data: {
					credential: data.credential,
					customMcpRefreshLeaseId: null,
					customMcpRefreshLeaseExpiresAt: null,
				},
			}),
		)
	).map(({count}) => count > 0);
}
