import type {IncomingHttpHeaders} from 'node:http';

import {isPasswordOwner} from '@proxy/db/owner-auth';
import {env} from './env';
import {ownerSessionPrefix} from '../auth/owner-password-config';

import {getAuthenticatedSessionDatabase} from '@proxy/db/auth';
import {ApiErr, type ApiError, type Experiment, getSessionTokenFromHeader} from '@proxy/utils';
import {Err, Ok, type Result} from 'ts-results-es';

export type AuthenticatedApiRequest = {
	userId: string;
	email: string;
	name?: string;
	/** The experiments on for the user's organization; ask with `hasExperiment(request.user, …)`. */
	experiments: Experiment[];
};

/** Authenticates a user from the session cookie. */
export async function authenticateApiRequest(headers: IncomingHttpHeaders): Promise<Result<AuthenticatedApiRequest, ApiError>> {
	const sessionToken = getSessionTokenFromHeader(headers.cookie);
	if (!sessionToken) {
		return Err(ApiErr.unauthenticated());
	}

	if (env.AUTH_MODE !== 'single-owner-password' && sessionToken.startsWith('owner.')) {
		return Err(ApiErr.unauthenticated());
	}

	const sessionResult = await getAuthenticatedSessionDatabase(sessionToken);
	if (sessionResult.isErr()) {
		return sessionResult;
	}

	if (!sessionResult.value) {
		return Err(ApiErr.unauthenticated());
	}

	if (env.AUTH_MODE === 'single-owner-password') {
		if (!env.OWNER_USERNAME || !env.OWNER_PASSWORD_HASH || !sessionToken.startsWith(ownerSessionPrefix())) {
			return Err(ApiErr.unauthenticated());
		}
		const owner = await isPasswordOwner(sessionResult.value.userId);
		if (owner.isErr()) {
			return owner;
		}
		if (!owner.value) {
			return Err(ApiErr.unauthenticated());
		}
	}

	return Ok({
		userId: sessionResult.value.userId,
		email: sessionResult.value.user.email,
		name: sessionResult.value.user.name ?? undefined,
		experiments: sessionResult.value.experiments,
	});
}
