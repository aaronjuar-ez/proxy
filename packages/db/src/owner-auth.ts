import {randomUUID} from 'node:crypto';

import type {Result} from 'ts-results-es';
import {type ApiError, wrapDb} from '@proxy/utils';

import {db} from '.';

const OWNER_KEY = 'single-owner-password:user-id';
const RATE_KEY = 'single-owner-password:login-rate';
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

/** Only called after password verification. Never adopts a preexisting user by email. */
export async function getOrCreatePasswordOwner(): Promise<Result<string, ApiError>> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			// The upsert takes a database row lock, serializing initialization across instances.
			const rows = await tx.$queryRaw<Array<{value: string}>>`
			INSERT INTO "InstanceMeta" ("key", "value") VALUES (${OWNER_KEY}, '')
			ON CONFLICT ("key") DO UPDATE SET "value" = "InstanceMeta"."value"
			RETURNING "value"`;
			const existingId = rows[0]!.value;
			if (existingId) {
				// Fail closed if the owner was deleted, rather than silently claiming another user.
				const owner = await tx.user.findUniqueOrThrow({
					where: {id: existingId},
					select: {id: true},
				});
				return owner.id;
			}
			const identity = randomUUID();
			const user = await tx.user.create({
				data: {email: `${identity}@owner.invalid`, name: 'Owner'},
				select: {id: true},
			});
			const org = await tx.organization.create({
				data: {name: 'Owner', slug: `owner-${identity}`},
				select: {id: true},
			});
			await tx.orgMember.create({data: {orgId: org.id, userId: user.id}});
			await tx.connection.create({data: {orgId: org.id, integrationId: 'info', account: 'Owner'}});
			await tx.instanceMeta.update({where: {key: OWNER_KEY}, data: {value: user.id}});
			return user.id;
		}),
	);
}

/** Read-only: a dashboard session can never initialize or claim the owner. */
export async function isPasswordOwner(userId: string): Promise<Result<boolean, ApiError>> {
	return (
		await wrapDb(() => db.instanceMeta.findUnique({where: {key: OWNER_KEY}, select: {value: true}}))
	).map((row) => row?.value === userId);
}

/** Global fixed window: bounded storage and cost even with distributed, spoofed-IP attacks. */
export async function reserveOwnerLoginAttempt(): Promise<
	Result<{allowed: boolean; retryAfter: number}, ApiError>
> {
	return wrapDb(() =>
		db.$transaction(async (tx) => {
			const rows = await tx.$queryRaw<Array<{value: string}>>`
			INSERT INTO "InstanceMeta" ("key", "value") VALUES (${RATE_KEY}, '0:0')
			ON CONFLICT ("key") DO UPDATE SET "value" = "InstanceMeta"."value"
			RETURNING "value"`;
			const times = await tx.$queryRaw<
				Array<{now: number}>
			>`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "now"`;
			const now = times[0]!.now;
			const stored = rows[0]!.value.split(':').map(Number);
			let start = stored[0] ?? 0;
			let count = stored[1] ?? 0;
			if (!Number.isFinite(start) || start < 0 || !Number.isSafeInteger(count) || count < 0) {
				// Corrupt state must not remove the rate limit.
				return {allowed: false, retryAfter: 60};
			}
			if (now - start >= WINDOW_MS) {
				start = now;
				count = 0;
			}
			if (count >= MAX_ATTEMPTS) {
				return {
					allowed: false,
					retryAfter: Math.max(1, Math.ceil((start + WINDOW_MS - now) / 1000)),
				};
			}
			await tx.instanceMeta.update({
				where: {key: RATE_KEY},
				data: {value: `${start}:${count + 1}`},
			});
			return {allowed: true, retryAfter: 0};
		}),
	);
}
