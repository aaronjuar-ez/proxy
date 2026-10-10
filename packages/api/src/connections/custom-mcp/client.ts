import {request} from 'node:https';
import type {ClientRequest} from 'node:http';
import {StringDecoder} from 'node:string_decoder';
import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';
import {z} from 'zod';

import {resolveEndpoint} from './endpoint';

export type UpstreamConfig = {url: string; bearerToken?: string};
export type UpstreamTool = {name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; annotations?: Record<string, unknown>};
export type UpstreamResult = {content: Record<string, unknown>[]; structuredContent?: Record<string, unknown>; isError?: boolean; [key: string]: unknown};

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const PROTOCOL = '2025-03-26';
const supportedVersions = new Set([PROTOCOL, '2025-06-18', '2025-11-25']);
const objectSchema = z.record(z.string(), z.unknown());
const toolSchema = z.object({
	name: z.string().min(1).max(128),
	title: z.string().max(1024).optional(),
	description: z.string().max(32000).optional(),
	inputSchema: objectSchema.refine((schema) => schema.type === 'object'),
	outputSchema: objectSchema.optional(),
	annotations: objectSchema.optional(),
});
const resultSchema = z
	.object({content: z.array(objectSchema.refine((block) => typeof block.type === 'string')), structuredContent: objectSchema.optional(), isError: z.boolean().optional()})
	.passthrough();
const rpcSchema = z.object({jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]).optional(), result: z.unknown().optional(), error: z.unknown().optional()});
type Session = {id?: string; version?: string; deadline: number};
type RpcResponse = {result: unknown; sessionId?: string};

function failure(): ApiError {
	// Never propagate provider bodies, DNS/socket errors or authentication headers to logs or callers.
	return ApiErr.providerUnreachable(new Error('The MCP server returned an invalid response or could not be reached.'));
}

// Limit nesting before downstream schema hashing or JSON serialization can recurse through provider data.
function hasSafeDepth(value: unknown): boolean {
	const pending = [{value, depth: 0}];
	while (pending.length) {
		const item = pending.pop()!;
		if (item.depth > 64) {
			return false;
		}
		if (typeof item.value !== 'object' || item.value === null) {
			continue;
		}
		for (const child of Object.values(item.value)) {
			pending.push({value: child, depth: item.depth + 1});
		}
	}
	return true;
}

function parseRpc(text: string, id: number): Result<unknown, ApiError> | undefined {
	const decoded = Result.wrap((): unknown => JSON.parse(text));
	if (decoded.isErr()) {
		return Err(failure());
	}
	const parsed = rpcSchema.safeParse(decoded.value);
	if (!parsed.success) {
		return Err(failure());
	}
	if (parsed.data.id !== id) {
		return undefined;
	}
	if (parsed.data.error !== undefined || parsed.data.result === undefined || !hasSafeDepth(parsed.data.result)) {
		return Err(failure());
	}
	return Ok(parsed.data.result);
}

function post(
	config: UpstreamConfig,
	session: Session,
	method: string,
	params: Record<string, unknown>,
	id?: number,
	httpMethod: 'POST' | 'DELETE' = 'POST',
	beforeCall?: () => Promise<Result<void, ApiError>>,
): Promise<Result<RpcResponse, ApiError>> {
	return Do(async ($) => {
		if (config.bearerToken !== undefined && (!config.bearerToken || config.bearerToken.length > 16384 || !/^[\x21-\x7e]+$/.test(config.bearerToken))) {
			return $(Err(ApiErr.validationError('Enter a valid bearer token.')));
		}
		const remaining = session.deadline - Date.now();
		if (remaining <= 0) {
			return $(Err(failure()));
		}
		const target = $(await resolveEndpoint(config.url, Math.min(5000, remaining)));
		if (Date.now() >= session.deadline) {
			return $(Err(failure()));
		}
		const encoded = $(Result.wrap(() => JSON.stringify({jsonrpc: '2.0', ...(id === undefined ? {} : {id}), method, params})).mapErr(() => ApiErr.validationError('Invalid MCP arguments.')));
		if (Buffer.byteLength(encoded) > MAX_BYTES) {
			return $(Err(ApiErr.validationError('MCP request is too large.')));
		}
		if (beforeCall) {
			$(await beforeCall());
		}
		if (Date.now() >= session.deadline) {
			return $(Err(failure()));
		}
		return $(
			await new Promise<Result<RpcResponse, ApiError>>((resolve) => {
				let done = false;
				let req: ClientRequest | undefined;
				const finish = (result: Result<RpcResponse, ApiError>) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					resolve(result);
					req?.destroy();
				};
				const timer = setTimeout(() => finish(Err(failure())), Math.max(1, session.deadline - Date.now()));
				const created = Result.wrap(() =>
					request(
						target.url,
						{
							method: httpMethod,
							agent: false,
							rejectUnauthorized: true,
							family: target.family,
							// The only address the socket can connect to is the one we just vetted. TLS SNI/Host retain the hostname.
							lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
							headers: {
								'content-type': 'application/json',
								accept: 'application/json, text/event-stream',
								'content-length': httpMethod === 'DELETE' ? 0 : Buffer.byteLength(encoded),
								...(config.bearerToken ? {authorization: `Bearer ${config.bearerToken}`} : {}),
								...(session.id ? {'mcp-session-id': session.id} : {}),
								...(session.version ? {'mcp-protocol-version': session.version} : {}),
							},
						},
						(response) => {
							const status = response.statusCode ?? 0;
							if (status === 401 || status === 403) {
								finish(Err(ApiErr.credentialsRejected()));
								return;
							}
							// node:https never follows redirects; in particular, credentials never go to a Location URL.
							if (httpMethod === 'DELETE') {
								finish(Ok({result: {}}));
								return;
							}
							if (status < 200 || status >= 300) {
								finish(Err(failure()));
								return;
							}
							const rawSession = response.headers['mcp-session-id'];
							if (rawSession !== undefined && (typeof rawSession !== 'string' || rawSession.length > 1024 || !/^[\x21-\x7e]+$/.test(rawSession))) {
								finish(Err(failure()));
								return;
							}
							if (id === undefined) {
								finish(status === 202 || status === 204 ? Ok({result: {}}) : Err(failure()));
								return;
							}
							const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
							if (contentType !== 'application/json' && contentType !== 'text/event-stream') {
								finish(Err(failure()));
								return;
							}
							let bytes = 0;
							let body = '';
							const decoder = new StringDecoder('utf8');
							const complete = (result: Result<unknown, ApiError>) => finish(result.map((value) => ({result: value, sessionId: rawSession})));
							response.on('data', (chunk: Buffer) => {
								bytes += chunk.length;
								if (bytes > MAX_BYTES) {
									finish(Err(failure()));
									return;
								}
								body += decoder.write(chunk);
								if (contentType !== 'text/event-stream') {
									return;
								}
								// Consume complete SSE events, including multiline data. Ignore notifications and progress events.
								let match = /\r?\n\r?\n/.exec(body);
								while (match) {
									const event = body.slice(0, match.index);
									body = body.slice(match.index + match[0].length);
									const data = event
										.split(/\r?\n/)
										.filter((line) => line.startsWith('data:'))
										.map((line) => line.slice(5).replace(/^ /, ''))
										.join('\n');
									if (data) {
										const result = parseRpc(data, id);
										if (result) {
											complete(result);
											return;
										}
									}
									match = /\r?\n\r?\n/.exec(body);
								}
							});
							response.on('end', () => complete(contentType === 'application/json' ? (parseRpc(body + decoder.end(), id) ?? Err(failure())) : Err(failure())));
							response.on('error', () => finish(Err(failure())));
							response.on('aborted', () => finish(Err(failure())));
						},
					),
				);
				if (created.isErr()) {
					finish(Err(failure()));
					return;
				}
				req = created.value;
				req.on('error', () => finish(Err(failure())));
				req.end(httpMethod === 'DELETE' ? undefined : encoded);
			}),
		);
	});
}

function initialize(config: UpstreamConfig): Promise<Result<Session, ApiError>> {
	return Do(async ($) => {
		const deadline = Date.now() + TIMEOUT_MS;
		const response = $(await post(config, {deadline}, 'initialize', {protocolVersion: PROTOCOL, capabilities: {}, clientInfo: {name: 'personal-agent-proxy', version: '1.0.0'}}, 1));
		const parsed = z.object({protocolVersion: z.string(), capabilities: z.object({tools: objectSchema.optional()})}).safeParse(response.result);
		if (!parsed.success || !supportedVersions.has(parsed.data.protocolVersion) || !parsed.data.capabilities.tools) {
			if (response.sessionId) {
				await post(config, {id: response.sessionId, version: PROTOCOL, deadline: Date.now() + 2000}, '', {}, undefined, 'DELETE');
			}
			return $(Err(failure()));
		}
		const session = {id: response.sessionId, version: parsed.data.protocolVersion, deadline};
		const notified = await post(config, session, 'notifications/initialized', {});
		if (notified.isErr()) {
			if (session.id) {
				await post(config, {...session, deadline: Date.now() + 2000}, '', {}, undefined, 'DELETE');
			}
			return $(notified);
		}
		return session;
	});
}

function withSession<T>(config: UpstreamConfig, operation: (session: Session) => Promise<Result<T, ApiError>>): Promise<Result<T, ApiError>> {
	return Do(async ($) => {
		const session = $(await initialize(config));
		const result = await operation(session);
		if (session.id) {
			// Best effort, bounded cleanup; never retry a tools/call whose outcome may be unknown.
			await post(config, {...session, deadline: Date.now() + 2000}, '', {}, undefined, 'DELETE');
		}
		return $(result);
	});
}

export function discoverTools(config: UpstreamConfig): Promise<Result<UpstreamTool[], ApiError>> {
	return withSession(config, (session) =>
		Do(async ($) => {
			const tools: UpstreamTool[] = [];
			let toolBytes = 0;
			const cursors = new Set<string>();
			const names = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; page < 20; page += 1) {
				const response = $(await post(config, session, 'tools/list', cursor ? {cursor} : {}, page + 2));
				const parsed = z.object({tools: z.array(toolSchema).max(500), nextCursor: z.string().min(1).max(4096).optional()}).safeParse(response.result);
				if (!parsed.success || tools.length + parsed.data.tools.length > 500) {
					return $(Err(failure()));
				}
				toolBytes += Buffer.byteLength(JSON.stringify(parsed.data.tools));
				if (toolBytes > MAX_BYTES) {
					return $(Err(failure()));
				}
				for (const tool of parsed.data.tools) {
					if (names.has(tool.name)) {
						return $(Err(failure()));
					}
					names.add(tool.name);
					tools.push(tool);
				}
				cursor = parsed.data.nextCursor;
				if (!cursor) {
					return tools;
				}
				if (cursors.has(cursor)) {
					return $(Err(failure()));
				}
				cursors.add(cursor);
			}
			return $(Err(failure()));
		}),
	);
}

export function callUpstreamTool(config: UpstreamConfig, name: string, args: Record<string, unknown>, beforeCall?: () => Promise<Result<void, ApiError>>): Promise<Result<UpstreamResult, ApiError>> {
	return withSession(config, (session) =>
		Do(async ($) => {
			const response = $(await post(config, session, 'tools/call', {name, arguments: args}, 2, 'POST', beforeCall));
			const parsed = resultSchema.safeParse(response.result);
			if (!parsed.success) {
				return $(Err(failure()));
			}
			return parsed.data;
		}),
	);
}
