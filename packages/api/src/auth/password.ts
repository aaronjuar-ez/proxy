import type {Request, Response} from 'express';
import {Result} from 'ts-results-es';
import {z} from 'zod';

import {getOrCreatePasswordOwner, reserveOwnerLoginAttempt} from '@proxy/db/owner-auth';

import {env} from '../utils/env';
import {ownerSessionPrefix} from './owner-password-config';
import {establishSession, timingSafeEqualString} from './session';

const credentialsSchema = z.object({
	username: z.string().min(1).max(64),
	password: z
		.string()
		.min(15)
		.max(1024)
		.refine((value) => Array.from(value).length >= 15 && Buffer.byteLength(value, 'utf8') <= 1024),
});

/** POST /auth/password: CSRF-protected dashboard sign-in, separate from all agent credentials. */
export async function handlePasswordLoginRoute(req: Request, res: Response): Promise<void> {
	res.setHeader('Cache-Control', 'no-store');
	if (env.AUTH_MODE !== 'single-owner-password') {
		res.status(404).json({error: 'not_found'});
		return;
	}
	if (!env.OWNER_USERNAME || !env.OWNER_PASSWORD_HASH || !env.APP_URL) {
		res.status(503).json({error: 'PasswordSignin'});
		return;
	}
	// Reserve before parsing or checking the supplied username, and before expensive Argon2.
	const reservation = await reserveOwnerLoginAttempt();
	if (reservation.isErr()) {
		res.status(503).json({error: 'PasswordSignin'});
		return;
	}
	if (!reservation.value.allowed) {
		res.setHeader('Retry-After', String(reservation.value.retryAfter));
		res.status(429).json({error: 'TooManyAttempts'});
		return;
	}
	const parsed = credentialsSchema.safeParse(req.body);
	if (!parsed.success) {
		res.status(401).json({error: 'InvalidCredentials'});
		return;
	}
	// Verify even for a wrong username, avoiding a username enumeration timing oracle.
	const verified = await Result.wrapAsync(() => Bun.password.verify(parsed.data.password, env.OWNER_PASSWORD_HASH!));
	if (verified.isErr()) {
		res.status(503).json({error: 'PasswordSignin'});
		return;
	}
	if (!verified.value || !timingSafeEqualString(parsed.data.username, env.OWNER_USERNAME)) {
		res.status(401).json({error: 'InvalidCredentials'});
		return;
	}
	const owner = await getOrCreatePasswordOwner();
	if (owner.isErr()) {
		res.status(503).json({error: 'PasswordSignin'});
		return;
	}
	const session = await establishSession(res, owner.value, ownerSessionPrefix());
	if (session.isErr()) {
		res.status(503).json({error: 'PasswordSignin'});
		return;
	}
	res.json({ok: true});
}
