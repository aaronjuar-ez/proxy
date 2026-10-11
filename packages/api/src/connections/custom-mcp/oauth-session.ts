import {randomUUID} from 'node:crypto';
import {Err, type Result} from 'ts-results-es';

import type {ConnectionRow} from '@proxy/db/connection';
import {acquireCustomMcpOAuthRefresh, completeCustomMcpOAuthRefresh} from '@proxy/db/custom-mcp-oauth';
import {ApiErr, type ApiError} from '@proxy/utils';

import {encryptSecret} from '../../utils/secret-crypto';
import type {UpstreamConfig} from './client';
import {refreshOAuthTokens} from './oauth-protocol';
import {loadCustomMcp, type StoredMcp} from './store';

type PreparedCustomMcp = {
	connection: ConnectionRow & {credential: string | null};
	config: StoredMcp;
};

const EXPIRY_SKEW_MS = 60_000;
// This is a deadline to report an abandoned refresh, never permission to reuse its token.
const REFRESH_LEASE_MS = 60_000;

function expiring(config: StoredMcp): boolean {
	const tokens = config.oauth?.tokens;
	if (tokens?.expiresAt === undefined) {
		return false;
	}
	// Older records have no issuance time. Once refreshed they use the proportional margin too.
	const margin = tokens.issuedAt === undefined ? EXPIRY_SKEW_MS : Math.min(EXPIRY_SKEW_MS, Math.max(0, tokens.expiresAt - tokens.issuedAt) * 0.1);
	return tokens.expiresAt <= Date.now() + margin;
}

export function upstreamConfig(config: StoredMcp): UpstreamConfig {
	return {url: config.url, bearerToken: config.oauth?.tokens.accessToken ?? config.bearerToken};
}

/** Always read current credentials; refresh at most once, under a cross-instance durable lease. */
export async function prepareCustomMcp(orgId: string, connectionId: string, forceRefresh = false): Promise<Result<PreparedCustomMcp, ApiError>> {
	let loaded = await loadCustomMcp(orgId, connectionId);
	// Snapshot edits can win before a lease is acquired. Re-read, but never spin without a bound.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (loaded.isErr()) {
			return loaded;
		}
		const {connection, config} = loaded.value;
		if (!config.oauth || (!forceRefresh && !expiring(config))) {
			return loaded;
		}
		if (!config.oauth.tokens.refreshToken) {
			return Err(ApiErr.credentialsRejected());
		}
		if (!connection.credential) {
			return Err(ApiErr.credentialsRejected());
		}
		const previous = connection.credential;
		const leaseId = randomUUID();
		const acquired = await acquireCustomMcpOAuthRefresh({
			orgId,
			connectionId,
			previous,
			leaseId,
			expiresAt: new Date(Date.now() + REFRESH_LEASE_MS),
		});
		if (acquired.isErr()) {
			return acquired;
		}
		if (acquired.value === 'missing') {
			return Err(ApiErr.notFound('connection', connectionId));
		}
		if (acquired.value === 'abandoned') {
			return Err(ApiErr.credentialsRejected());
		}
		if (acquired.value === 'busy') {
			return Err(ApiErr.conflict('This MCP connection is refreshing its sign-in. Try again shortly.'));
		}
		if (acquired.value === 'changed') {
			loaded = await loadCustomMcp(orgId, connectionId);
			if (loaded.isOk() && loaded.value.config.oauth?.tokens.accessToken !== config.oauth.tokens.accessToken) {
				// Another server refreshed or the user reconnected. Do not refresh a new token
				// merely because a request made with its predecessor was rejected.
				forceRefresh = false;
			}
			continue;
		}

		// On any error from here, leave the lease in place. The provider may have rotated
		// before the response was lost; reusing the old refresh token can revoke the family.
		const tokens = await refreshOAuthTokens(config.oauth.settings, config.oauth.tokens);
		if (tokens.isErr()) {
			return tokens;
		}
		const next: StoredMcp = {...config, oauth: {...config.oauth, tokens: tokens.value}};
		const encrypted = encryptSecret(JSON.stringify(next));
		if (encrypted.isErr()) {
			return encrypted;
		}
		const saved = await completeCustomMcpOAuthRefresh({orgId, connectionId, previous, leaseId, credential: encrypted.value});
		if (saved.isErr()) {
			return saved;
		}
		if (!saved.value) {
			// Reconnect or deletion may have superseded us. Never use unpersisted loser tokens.
			return Err(ApiErr.conflict('This MCP connection changed while refreshing. Try again.'));
		}
		return loadCustomMcp(orgId, connectionId);
	}
	return Err(ApiErr.conflict('This MCP connection changed while refreshing. Try again.'));
}
