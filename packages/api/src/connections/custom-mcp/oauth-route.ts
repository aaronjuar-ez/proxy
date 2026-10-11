import {createHash, randomBytes} from 'node:crypto';
import type {Response} from 'express';
import {Err, Result} from 'ts-results-es';
import {z} from 'zod';
import {ApiErr, type ApiError, Do, parseCookieHeader, parseSchema, requirePresent} from '@proxy/utils';
import {createConnection, refreshCustomMcpSnapshot} from '@proxy/db/connection';
import {createCustomMcpOAuthAttempt, consumeCustomMcpOAuthAttempt} from '@proxy/db/custom-mcp-oauth';
import {queryParam, timingSafeEqualString, useSecureCookies} from '../../auth/session';
import type {AuthenticatedRequest} from '../../server/middleware/require-auth';
import {sendApiError} from '../../server/response';
import {env} from '../../utils/env';
import {decryptSecret, encryptSecret} from '../../utils/secret-crypto';
import {requireUserOrgId} from '../../utils/user-org';
import {makePkce} from '../mcp/mcp-oauth';
import {discoverTools} from './client';
import {validateEndpoint} from './endpoint';
import {createOAuthAuthorizationUrl, discoverOAuth, exchangeOAuthCode, oauthSettingsSchema, registerOAuthClient} from './oauth-protocol';
import {CUSTOM_MCP, loadCustomMcp, type StoredMcp} from './store';

const basePath = '/api/connections/custom-mcp/oauth';
const cookieName = 'proxy.custom-mcp-oauth-state';
const durationMs = 10 * 60 * 1000;
const clientIdSchema = z
	.string()
	.trim()
	.min(1)
	.max(2048)
	.regex(/^[\x21-\x7e]+$/)
	.optional();
const returnToSchema = z.literal('welcome').optional();
const startSchema = z.union([
	z.object({account: z.string().trim().min(1).max(200), url: z.string().url().max(2048), clientId: clientIdSchema, returnTo: returnToSchema}).strict(),
	z.object({connectionId: z.string().min(1).max(200), clientId: clientIdSchema, returnTo: returnToSchema}).strict(),
]);
const payloadSchema = z.object({
	account: z.string(),
	url: z.string(),
	settings: oauthSettingsSchema,
	verifier: z.string(),
	expiresAt: z.number(),
	connectionId: z.string().optional(),
	previousHash: z.string().optional(),
	returnTo: returnToSchema,
});
type Payload = z.infer<typeof payloadSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const redirectUriFor = (appUrl: string, issuer: string) => `${appUrl}${basePath}/callback/${hash(issuer)}`;
const cookieOptions = () => ({httpOnly: true, sameSite: 'lax' as const, secure: useSecureCookies(), path: basePath});

/** A POST with the browser-origin guard: remote registration never starts on a cross-site navigation. */
export async function handleStartCustomMcpOAuth(request: AuthenticatedRequest, response: Response): Promise<void> {
	response.setHeader('Cache-Control', 'no-store');
	const started = await Do<{authorizationUrl: string; state: string}, ApiError>(async ($) => {
		const appUrl = $(requirePresent(env.APP_URL, ApiErr.validationError('Configure APP_URL before connecting OAuth.')));
		const orgId = $(await requireUserOrgId(request));
		const input = $(parseSchema(startSchema, request.body));
		const existing = 'connectionId' in input ? $(await loadCustomMcp(orgId, input.connectionId)) : undefined;
		const url = $(validateEndpoint(existing ? existing.config.url : 'url' in input ? input.url : '')).toString();
		const account = existing ? existing.connection.account : 'account' in input ? input.account : '';
		const metadata = $(await discoverOAuth(url));
		const redirectUri = redirectUriFor(appUrl, metadata.issuer);
		const previousSettings = existing?.config.oauth?.settings;
		if (input.clientId && metadata.tokenEndpointAuthMethod !== 'none') {
			return $(Err(ApiErr.validationError('This provider requires automatic confidential-client registration.')));
		}
		const registration = input.clientId
			? {clientId: input.clientId, tokenEndpointAuthMethod: 'none' as const}
			: !metadata.registrationEndpoint && previousSettings?.issuer === metadata.issuer
				? {clientId: previousSettings.clientId, clientSecret: previousSettings.clientSecret, tokenEndpointAuthMethod: previousSettings.tokenEndpointAuthMethod}
				: $(await registerOAuthClient(metadata, redirectUri));
		const settings = {...metadata, ...registration};
		const state = randomBytes(32).toString('base64url');
		const {verifier, challenge} = makePkce();
		const authorizationUrl = $(createOAuthAuthorizationUrl(settings, {redirectUri, state, codeChallenge: challenge}));
		const expiresAt = Date.now() + durationMs;
		const payload: Payload = {
			account,
			url,
			settings,
			verifier,
			expiresAt,
			returnTo: input.returnTo,
			...(existing ? {connectionId: existing.connection.id, previousHash: hash(existing.connection.credential!)} : {}),
		};
		const encrypted = $(encryptSecret(JSON.stringify(payload)));
		$(await createCustomMcpOAuthAttempt({stateHash: hash(state), userId: request.user.userId, orgId, payload: encrypted, expiresAt: new Date(expiresAt)}));
		return {authorizationUrl, state};
	});
	if (started.isErr()) {
		sendApiError(response, started.error);
		return;
	}
	response.cookie(cookieName, started.value.state, {...cookieOptions(), maxAge: durationMs});
	response.json({authorizationUrl: started.value.authorizationUrl});
}

function readPayload(request: AuthenticatedRequest): Promise<Result<Payload, ApiError>> {
	return Do(async ($) => {
		const state = queryParam(request, 'state') ?? '';
		const cookie = parseCookieHeader(request.headers.cookie ?? '').get(cookieName) ?? '';
		if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !timingSafeEqualString(state, cookie)) {
			return $(Err(ApiErr.validationError('OAuth state does not match. Start again.')));
		}
		const orgId = $(await requireUserOrgId(request));
		// Atomic consumption rejects simultaneous callbacks and replay across server instances.
		const encrypted = $(
			requirePresent($(await consumeCustomMcpOAuthAttempt({stateHash: hash(state), userId: request.user.userId, orgId})), ApiErr.validationError('OAuth sign-in expired or was already used.')),
		);
		const json = $(decryptSecret(encrypted));
		const parsed = $(Result.wrap(() => JSON.parse(json)).mapErr(() => ApiErr.validationError('Invalid OAuth sign-in.')));
		const payload = $(parseSchema(payloadSchema, parsed));
		if (payload.expiresAt <= Date.now()) {
			return $(Err(ApiErr.validationError('OAuth sign-in expired.')));
		}
		return payload;
	});
}

function finishConnect(request: AuthenticatedRequest, payload: Payload, appUrl: string): Promise<Result<string, ApiError>> {
	return Do(async ($) => {
		if (request.params.issuerKey !== hash(payload.settings.issuer)) {
			return $(Err(ApiErr.validationError('OAuth callback issuer does not match.')));
		}
		const issuer = queryParam(request, 'iss');
		if ((issuer !== null && issuer !== payload.settings.issuer) || (payload.settings.authorizationResponseIssParameterSupported && issuer === null)) {
			return $(Err(ApiErr.validationError('OAuth issuer does not match.')));
		}
		const code = queryParam(request, 'code');
		if (queryParam(request, 'error') || !code || code.length > 8192) {
			return $(Err(ApiErr.validationError('OAuth sign-in did not finish.')));
		}
		const orgId = $(await requireUserOrgId(request));
		const existing = payload.connectionId ? $(await loadCustomMcp(orgId, payload.connectionId)) : undefined;
		if (existing && (!payload.previousHash || hash(existing.connection.credential!) !== payload.previousHash)) {
			return $(Err(ApiErr.conflict('The connection changed. Start sign-in again.')));
		}
		const tokens = $(await exchangeOAuthCode(payload.settings, {code, codeVerifier: payload.verifier, redirectUri: redirectUriFor(appUrl, payload.settings.issuer)}));
		const tools = $(await discoverTools({url: payload.url, bearerToken: tokens.accessToken}));
		const config: StoredMcp = {version: 1, url: payload.url, oauth: {settings: payload.settings, tokens}, tools};
		const credential = $(encryptSecret(JSON.stringify(config)));
		if (existing) {
			// A reconnect can represent a different account. Revoke every old grant, even for unchanged tools.
			const updated = $(await refreshCustomMcpSnapshot({connectionId: existing.connection.id, previous: existing.connection.credential!, credential, actionIds: [], reconnectOAuth: true}));
			if (!updated) {
				return $(Err(ApiErr.conflict('The connection changed. Start sign-in again.')));
			}
			return existing.connection.id;
		}
		return $(await createConnection({orgId, integrationId: CUSTOM_MCP, account: payload.account, credential, defaults: []})).id;
	});
}

export async function handleCustomMcpOAuthCallback(request: AuthenticatedRequest, response: Response): Promise<void> {
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('Referrer-Policy', 'no-referrer');
	response.clearCookie(cookieName, cookieOptions());
	const appUrl = env.APP_URL;
	if (!appUrl) {
		response.status(500).json({error: 'app_url_not_configured'});
		return;
	}
	const payload = await readPayload(request);
	const returnTo = payload.isOk() && payload.value.returnTo === 'welcome' ? '/welcome/connections' : '/connections';
	const result = payload.isOk() ? await finishConnect(request, payload.value, appUrl) : Err(payload.error);
	if (result.isErr()) {
		const target =
			payload.isOk() && payload.value.connectionId ? `${returnTo}/${encodeURIComponent(payload.value.connectionId)}` : `${returnTo}${returnTo === '/connections' ? '/new' : ''}/custom-mcp`;
		response.redirect(`${appUrl}${target}?oauth=failed`);
		return;
	}
	response.redirect(`${appUrl}${returnTo}/${encodeURIComponent(result.value)}?${payload.isOk() && payload.value.connectionId ? 'oauth=connected' : 'added'}`);
}

/** Read-only discovery gives owners the exact issuer-bound callback for client registration. */
export function handleDiscoverCustomMcpOAuth(
	request: AuthenticatedRequest,
): Promise<Result<{issuer: string; redirectUri: string; registrationSupported: boolean; publicClientSupported: boolean}, ApiError>> {
	return Do(async ($) => {
		const appUrl = $(requirePresent(env.APP_URL, ApiErr.validationError('Configure APP_URL before connecting OAuth.')));
		const orgId = $(await requireUserOrgId(request));
		const input = $(parseSchema(z.union([z.object({url: z.string().url().max(2048)}).strict(), z.object({connectionId: z.string().min(1).max(200)}).strict()]), request.body));
		const url = 'connectionId' in input ? $(await loadCustomMcp(orgId, input.connectionId)).config.url : input.url;
		const metadata = $(await discoverOAuth($(validateEndpoint(url)).toString()));
		return {
			issuer: metadata.issuer,
			redirectUri: redirectUriFor(appUrl, metadata.issuer),
			registrationSupported: Boolean(metadata.registrationEndpoint),
			publicClientSupported: metadata.tokenEndpointAuthMethod === 'none',
		};
	});
}
