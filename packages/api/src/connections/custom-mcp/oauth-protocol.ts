import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {resolveEndpoint, validateEndpoint} from './endpoint';
import {oauthHttpRequest, validateOAuthEndpoint, type OAuthHttpResponse} from './oauth-http';

const endpointSchema = z
	.string()
	.max(2048)
	.refine((value) => validateOAuthEndpoint(value).isOk());
const resourceSchema = z
	.string()
	.max(2048)
	.refine((value) => validateEndpoint(value).isOk());
const identifierSchema = z
	.string()
	.min(1)
	.max(2048)
	.regex(/^[\x21-\x7e]+$/);
const tokenSchema = z
	.string()
	.min(1)
	.max(16384)
	.regex(/^[\x21-\x7e]+$/);
const clientSecretSchema = z
	.string()
	.min(1)
	.max(16384)
	.regex(/^[\x20-\x7e]+$/);
const clientAuthMethodSchema = z.enum(['none', 'client_secret_post', 'client_secret_basic']);
const scopeTokenSchema = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const scopeSchema = z
	.string()
	.min(1)
	.max(4096)
	.regex(/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/);

const metadataSchema = z.object({
	resource: resourceSchema,
	issuer: resourceSchema,
	authorizationEndpoint: endpointSchema,
	tokenEndpoint: endpointSchema,
	registrationEndpoint: endpointSchema.optional(),
	scope: scopeSchema.optional(),
	tokenEndpointAuthMethod: clientAuthMethodSchema.default('none'),
	grantTypesSupported: z.array(z.string()).max(100).optional(),
	authorizationResponseIssParameterSupported: z.boolean().optional(),
});
export const oauthSettingsSchema = metadataSchema
	.extend({clientId: identifierSchema, clientSecret: clientSecretSchema.optional()})
	.refine((settings) => (settings.tokenEndpointAuthMethod === 'none' ? settings.clientSecret === undefined : settings.clientSecret !== undefined), {
		message: 'OAuth client authentication does not match the registered client.',
	});
export const oauthTokensSchema = z.object({
	accessToken: tokenSchema,
	refreshToken: tokenSchema.optional(),
	issuedAt: z.number().finite().nonnegative().optional(),
	expiresAt: z.number().finite().nonnegative().optional(),
});
export type OAuthSettings = z.infer<typeof oauthSettingsSchema>;
export type OAuthTokens = z.infer<typeof oauthTokensSchema>;
export type OAuthMetadata = z.infer<typeof metadataSchema>;
export type OAuthClientRegistration = Pick<OAuthSettings, 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'>;

const protectedResourceSchema = z.object({
	resource: resourceSchema,
	authorization_servers: z.array(resourceSchema).min(1).max(10),
	scopes_supported: z.array(scopeTokenSchema).max(100).optional(),
	bearer_methods_supported: z.array(z.string()).max(10).optional(),
});
const authorizationServerSchema = z.object({
	issuer: resourceSchema,
	authorization_endpoint: endpointSchema,
	token_endpoint: endpointSchema,
	registration_endpoint: endpointSchema.optional(),
	response_types_supported: z.array(z.string()).max(100),
	grant_types_supported: z.array(z.string()).max(100).optional(),
	code_challenge_methods_supported: z.array(z.string()).max(100),
	token_endpoint_auth_methods_supported: z.array(z.string()).max(100).optional(),
	authorization_response_iss_parameter_supported: z.boolean().optional(),
});

function invalidMetadata(): ApiError {
	return ApiErr.validationError('The MCP server did not provide valid OAuth metadata with public HTTPS endpoints and PKCE S256 support.');
}

function invalidResponse(): ApiError {
	return ApiErr.providerUnreachable(new Error('The OAuth server returned an invalid response or could not be reached.'));
}

function parseJson<T extends z.ZodType>(response: OAuthHttpResponse, schema: T): Result<z.output<T>, ApiError> {
	return Do<z.output<T>, ApiError>(($): z.output<T> => {
		if (response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
			return $(Err(invalidResponse()));
		}
		const value = $(Result.wrap((): unknown => JSON.parse(response.body)).mapErr(invalidResponse));
		const parsed = schema.safeParse(value);
		if (!parsed.success) {
			return $(Err(invalidResponse()));
		}
		return parsed.data;
	});
}

// Split only outside quoted strings, then keep parameters with their authentication scheme.
// In particular a Basic challenge cannot supply a Bearer resource_metadata or scope.
function bearerChallenge(header: string | string[] | undefined): Result<{metadataUrl?: string; scope?: string}, ApiError> {
	if (!header) {
		return Ok({});
	}
	const raw = Array.isArray(header) ? header.join(',') : header;
	if (raw.length > 16384) {
		return Err(invalidMetadata());
	}
	const parts: string[] = [];
	let quoted = false;
	let escaped = false;
	let start = 0;
	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === '\\' && quoted) {
			escaped = true;
			continue;
		}
		if (char === '"') {
			quoted = !quoted;
		}
		if (char === ',' && !quoted) {
			parts.push(raw.slice(start, index).trim());
			start = index + 1;
		}
	}
	if (quoted || escaped) {
		return Err(invalidMetadata());
	}
	parts.push(raw.slice(start).trim());
	let bearer = false;
	const parameters = new Map<string, string>();
	for (let part of parts) {
		const isParameter = /^[!#$%&'*+.^_`|~\da-z-]+\s*=/i.test(part);
		const scheme = isParameter ? null : /^([!#$%&'*+.^_`|~\da-z-]+)(?:\s+(.*))?$/i.exec(part);
		if (scheme) {
			bearer = scheme[1]!.toLowerCase() === 'bearer';
			part = scheme[2] ?? '';
		}
		if (!bearer || !part) {
			continue;
		}
		const parameter = /^([!#$%&'*+.^_`|~\da-z-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`|~\da-z-]+))$/i.exec(part);
		if (!parameter) {
			return Err(invalidMetadata());
		}
		const name = parameter[1]!.toLowerCase();
		if (name !== 'resource_metadata' && name !== 'scope') {
			continue;
		}
		if (parameters.has(name)) {
			return Err(invalidMetadata());
		}
		parameters.set(name, parameter[2]?.replace(/\\(.)/g, '$1') ?? parameter[3]!);
	}
	const scope = parameters.get('scope');
	if (scope !== undefined && !scopeSchema.safeParse(scope).success) {
		return Err(invalidMetadata());
	}
	const metadataUrl = parameters.get('resource_metadata');
	if (metadataUrl !== undefined && validateOAuthEndpoint(metadataUrl).isErr()) {
		return Err(invalidMetadata());
	}
	return Ok({metadataUrl, scope});
}

async function discoverDocument<T extends z.ZodType>(urls: string[], schema: T, deadline: number): Promise<Result<z.output<T>, ApiError>> {
	for (const url of urls) {
		const response = await oauthHttpRequest(url, {deadline});
		if (response.isErr()) {
			return response;
		}
		if (response.value.status === 404 || response.value.status === 405) {
			continue;
		}
		if (response.value.status !== 200) {
			return Err(invalidMetadata());
		}
		// A successful but invalid document is not permission to try a less-specific authority.
		return parseJson(response.value, schema);
	}
	return Err(invalidMetadata());
}

/** RFC 9728 resource discovery, RFC 8414 discovery and the MCP OIDC fallback order. */
export function discoverOAuth(input: string): Promise<Result<OAuthMetadata, ApiError>> {
	return Do(async ($) => {
		const resource = $(validateEndpoint(input));
		const deadline = Date.now() + 30_000;
		// This request intentionally has no bearer token and stops at headers (SSE may never end).
		const probe = $(await oauthHttpRequest(input, {headersOnly: true, deadline}));
		const challenge = $(bearerChallenge(probe.status === 401 ? probe.headers['www-authenticate'] : undefined));
		const resourcePath = resource.pathname === '/' ? '' : resource.pathname;
		const resourceUrls = challenge.metadataUrl
			? [challenge.metadataUrl]
			: [...new Set([`${resource.origin}/.well-known/oauth-protected-resource${resourcePath}`, `${resource.origin}/.well-known/oauth-protected-resource`])];
		const protectedResource = $(await discoverDocument(resourceUrls, protectedResourceSchema, deadline));
		// RFC 9728 requires string equality, not origin/path-prefix or URL-normalized equality.
		if (protectedResource.resource !== input || (protectedResource.bearer_methods_supported && !protectedResource.bearer_methods_supported.includes('header'))) {
			return $(Err(invalidMetadata()));
		}
		// Select one advertised authorization server deterministically; never mix its endpoints with another issuer.
		const issuer = protectedResource.authorization_servers[0]!;
		const issuerUrl = $(validateEndpoint(issuer));
		const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/$/, '');
		const serverUrls = [
			`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`,
			`${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`,
			...(issuerPath ? [`${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`] : []),
		];
		const server = $(await discoverDocument(serverUrls, authorizationServerSchema, deadline));
		if (
			server.issuer !== issuer ||
			!server.code_challenge_methods_supported.includes('S256') ||
			!server.response_types_supported.includes('code') ||
			(server.grant_types_supported && !server.grant_types_supported.includes('authorization_code'))
		) {
			return $(Err(invalidMetadata()));
		}
		// RFC 8414 defaults an omitted methods list to client_secret_basic.
		const authMethods = server.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
		const tokenEndpointAuthMethod = (['none', 'client_secret_post', 'client_secret_basic'] as const).find((method) => authMethods.includes(method));
		if (!tokenEndpointAuthMethod) {
			return $(Err(ApiErr.validationError('The OAuth server does not support a compatible client authentication method.')));
		}
		// Validate public DNS even for the authorization endpoint which the browser, rather than this process, visits.
		for (const endpoint of [server.authorization_endpoint, server.token_endpoint, ...(server.registration_endpoint ? [server.registration_endpoint] : [])]) {
			const url = $(validateOAuthEndpoint(endpoint));
			url.search = '';
			if (Date.now() >= deadline) {
				return $(Err(invalidResponse()));
			}
			$(await resolveEndpoint(url.href, Math.max(1, Math.min(5000, deadline - Date.now()))));
		}
		const scope = challenge.scope ?? (protectedResource.scopes_supported?.join(' ') || undefined);
		const metadata = metadataSchema.safeParse({
			resource: input,
			issuer,
			authorizationEndpoint: server.authorization_endpoint,
			tokenEndpoint: server.token_endpoint,
			registrationEndpoint: server.registration_endpoint,
			scope,
			tokenEndpointAuthMethod,
			grantTypesSupported: server.grant_types_supported,
			authorizationResponseIssParameterSupported: server.authorization_response_iss_parameter_supported,
		});
		if (!metadata.success) {
			return $(Err(invalidMetadata()));
		}
		return metadata.data;
	});
}

function validateRedirectUri(input: string): Result<string, ApiError> {
	return Do<string, ApiError>(($): string => {
		const url = $(Result.wrap(() => new URL(input)).mapErr(() => ApiErr.validationError('The OAuth callback URL is invalid.')));
		if (input.length > 2048 || url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
			return $(Err(ApiErr.validationError('The OAuth callback must use HTTPS (or HTTP on localhost).')));
		}
		return input;
	});
}

/** Credentials are returned only to the caller's encrypted settings; never put them in an authorization URL. */
export function registerOAuthClient(metadata: OAuthMetadata, redirectUri: string): Promise<Result<OAuthClientRegistration, ApiError>> {
	return Do(async ($) => {
		if (!metadataSchema.safeParse(metadata).success) {
			return $(Err(invalidMetadata()));
		}
		if (!metadata.registrationEndpoint) {
			return $(Err(ApiErr.validationError('This OAuth server does not support automatic client registration. Use a pre-registered public client ID if supported.')));
		}
		$(validateRedirectUri(redirectUri));
		const response = $(
			await oauthHttpRequest(metadata.registrationEndpoint, {
				method: 'POST',
				body: JSON.stringify({
					client_name: 'Personal Agent Proxy',
					redirect_uris: [redirectUri],
					grant_types: ['authorization_code', ...(!metadata.grantTypesSupported || metadata.grantTypesSupported.includes('refresh_token') ? ['refresh_token'] : [])],
					response_types: ['code'],
					token_endpoint_auth_method: metadata.tokenEndpointAuthMethod,
					...(metadata.scope ? {scope: metadata.scope} : {}),
				}),
			}),
		);
		if (response.status !== 201 && response.status !== 200) {
			return $(Err(ApiErr.validationError('The OAuth server could not register a client. Use a pre-registered public client ID if supported.')));
		}
		const registered = $(
			parseJson(
				response,
				z.object({
					client_id: identifierSchema,
					token_endpoint_auth_method: z.literal(metadata.tokenEndpointAuthMethod),
					client_secret: metadata.tokenEndpointAuthMethod === 'none' ? z.never().optional() : clientSecretSchema,
					redirect_uris: z.array(z.literal(redirectUri)).length(1),
					grant_types: z.array(z.string()).optional(),
					response_types: z.array(z.string()).optional(),
				}),
			),
		);
		if ((registered.grant_types && !registered.grant_types.includes('authorization_code')) || (registered.response_types && !registered.response_types.includes('code'))) {
			return $(Err(invalidResponse()));
		}
		return {clientId: registered.client_id, clientSecret: registered.client_secret, tokenEndpointAuthMethod: registered.token_endpoint_auth_method};
	});
}

export function createOAuthAuthorizationUrl(settings: OAuthSettings, args: {redirectUri: string; state: string; codeChallenge: string}): Result<string, ApiError> {
	return Do<string, ApiError>(($): string => {
		if (!oauthSettingsSchema.safeParse(settings).success || !/^[A-Za-z0-9_-]{43}$/.test(args.codeChallenge) || !identifierSchema.safeParse(args.state).success) {
			return $(Err(ApiErr.validationError('The OAuth authorization request is invalid.')));
		}
		$(validateRedirectUri(args.redirectUri));
		const url = $(validateOAuthEndpoint(settings.authorizationEndpoint));
		const params = {
			response_type: 'code',
			client_id: settings.clientId,
			redirect_uri: args.redirectUri,
			state: args.state,
			code_challenge: args.codeChallenge,
			code_challenge_method: 'S256',
			resource: settings.resource,
		};
		for (const [name, value] of Object.entries(params)) {
			url.searchParams.set(name, value);
		}
		url.searchParams.delete('scope');
		// Do not let a metadata query inject a request object overriding these bound parameters.
		url.searchParams.delete('request');
		url.searchParams.delete('request_uri');
		url.searchParams.delete('client_secret');
		url.searchParams.delete('client_assertion');
		url.searchParams.delete('client_assertion_type');
		if (settings.scope) {
			url.searchParams.set('scope', settings.scope);
		}
		return url.href;
	});
}

function tokenRequest(settings: OAuthSettings, parameters: Record<string, string>, previousRefreshToken?: string): Promise<Result<OAuthTokens, ApiError>> {
	return Do(async ($) => {
		if (!oauthSettingsSchema.safeParse(settings).success) {
			return $(Err(invalidMetadata()));
		}
		const endpoint = $(validateOAuthEndpoint(settings.tokenEndpoint));
		if (['grant_type', 'client_id', 'client_secret', 'code', 'code_verifier', 'redirect_uri', 'refresh_token', 'resource'].some((name) => endpoint.searchParams.has(name))) {
			return $(Err(invalidMetadata()));
		}
		const form = new URLSearchParams({...parameters, client_id: settings.clientId, resource: settings.resource});
		if (settings.tokenEndpointAuthMethod === 'client_secret_post') {
			form.set('client_secret', settings.clientSecret!);
		}
		// RFC 6749 section 2.3.1 applies form encoding separately to each Basic credential.
		const formEncode = (value: string) => new URLSearchParams({v: value}).toString().slice(2);
		const authorization =
			settings.tokenEndpointAuthMethod === 'client_secret_basic' ? `Basic ${Buffer.from(`${formEncode(settings.clientId)}:${formEncode(settings.clientSecret!)}`).toString('base64')}` : undefined;
		// Include request time in the lifetime rather than extending expiry by network latency.
		const issuedAt = Date.now();
		const response = $(
			await oauthHttpRequest(settings.tokenEndpoint, {
				method: 'POST',
				contentType: 'application/x-www-form-urlencoded',
				body: form.toString(),
				authorization,
			}),
		);
		if (response.status !== 200) {
			const error = parseJson(response, z.object({error: z.string().max(128)}));
			if (response.status === 401 || (error.isOk() && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(error.value.error))) {
				return $(Err(ApiErr.credentialsRejected()));
			}
			return $(Err(invalidResponse()));
		}
		const token = $(
			parseJson(
				response,
				z.object({
					access_token: tokenSchema,
					token_type: z.string().refine((value) => value.toLowerCase() === 'bearer'),
					refresh_token: tokenSchema.optional(),
					expires_in: z
						.number()
						.finite()
						.nonnegative()
						.max(10 * 365 * 24 * 60 * 60)
						.optional(),
				}),
			),
		);
		return {
			accessToken: token.access_token,
			refreshToken: token.refresh_token ?? previousRefreshToken,
			issuedAt,
			expiresAt: token.expires_in === undefined ? undefined : issuedAt + token.expires_in * 1000,
		};
	});
}

export function exchangeOAuthCode(settings: OAuthSettings, args: {code: string; codeVerifier: string; redirectUri: string}): Promise<Result<OAuthTokens, ApiError>> {
	return Do(async ($) => {
		if (
			!/^[A-Za-z0-9._~-]{43,128}$/.test(args.codeVerifier) ||
			!z
				.string()
				.min(1)
				.max(4096)
				.regex(/^[\x21-\x7e]+$/)
				.safeParse(args.code).success
		) {
			return $(Err(ApiErr.validationError('The OAuth authorization code or PKCE verifier is invalid.')));
		}
		$(validateRedirectUri(args.redirectUri));
		return $(await tokenRequest(settings, {grant_type: 'authorization_code', code: args.code, code_verifier: args.codeVerifier, redirect_uri: args.redirectUri}));
	});
}

export function refreshOAuthTokens(settings: OAuthSettings, tokens: OAuthTokens): Promise<Result<OAuthTokens, ApiError>> {
	if (!oauthTokensSchema.safeParse(tokens).success || !tokens.refreshToken) {
		return Promise.resolve(Err(ApiErr.credentialsRejected()));
	}
	return tokenRequest(settings, {grant_type: 'refresh_token', refresh_token: tokens.refreshToken}, tokens.refreshToken);
}
