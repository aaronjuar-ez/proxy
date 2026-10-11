import {request} from 'node:https';
import type {ClientRequest, IncomingHttpHeaders} from 'node:http';
import {StringDecoder} from 'node:string_decoder';
import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';

import {resolveEndpoint, validateEndpoint} from './endpoint';

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 10_000;

export type OAuthHttpResponse = {status: number; headers: IncomingHttpHeaders; body: string};
type RequestOptions = {
	method?: 'GET' | 'POST';
	body?: string;
	contentType?: 'application/json' | 'application/x-www-form-urlencoded';
	authorization?: string;
	headersOnly?: boolean;
	deadline?: number;
};

function failure(): ApiError {
	// Provider bodies, URLs, socket errors and tokens must never reach callers or logs.
	return ApiErr.providerUnreachable(new Error('The OAuth server returned an invalid response or could not be reached.'));
}

/** OAuth endpoints can contain a query. The same public HTTPS/443 policy still applies. */
export function validateOAuthEndpoint(input: string): Result<URL, ApiError> {
	return Do<URL, ApiError>(($): URL => {
		const url = $(Result.wrap(() => new URL(input)).mapErr(() => ApiErr.validationError('The OAuth server advertised an invalid HTTPS endpoint.')));
		if (input.length > 2048 || /[\u0000-\u0020\u007f]/.test(input)) {
			return $(Err(ApiErr.validationError('The OAuth server advertised an invalid HTTPS endpoint.')));
		}
		const withoutQuery = new URL(url);
		withoutQuery.search = '';
		$(validateEndpoint(withoutQuery.href));
		return url;
	});
}

/** DNS is revalidated for each request and pinned for its socket; HTTPS never follows redirects. */
export function oauthHttpRequest(input: string, options: RequestOptions = {}): Promise<Result<OAuthHttpResponse, ApiError>> {
	return Do(async ($) => {
		const deadline = Math.min(options.deadline ?? Infinity, Date.now() + TIMEOUT_MS);
		const url = $(validateOAuthEndpoint(input));
		if (options.authorization !== undefined && (options.authorization.length > 65536 || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(options.authorization))) {
			return $(Err(ApiErr.validationError('Invalid OAuth client authentication.')));
		}
		const withoutQuery = new URL(url);
		withoutQuery.search = '';
		if (Date.now() >= deadline || Buffer.byteLength(options.body ?? '') > MAX_BYTES) {
			return $(Err(failure()));
		}
		const target = $(await resolveEndpoint(withoutQuery.href, Math.max(1, Math.min(5000, deadline - Date.now()))));
		if (Date.now() >= deadline) {
			return $(Err(failure()));
		}
		return $(
			await new Promise<Result<OAuthHttpResponse, ApiError>>((resolve) => {
				let done = false;
				let req: ClientRequest | undefined;
				const finish = (result: Result<OAuthHttpResponse, ApiError>) => {
					if (done) {
						return;
					}
					done = true;
					clearTimeout(timer);
					resolve(result);
					req?.destroy();
				};
				const timer = setTimeout(() => finish(Err(failure())), Math.max(1, deadline - Date.now()));
				const created = Result.wrap(() =>
					request(
						url,
						{
							method: options.method ?? 'GET',
							agent: false,
							rejectUnauthorized: true,
							minVersion: 'TLSv1.2',
							family: target.family,
							lookup: (_hostname, _lookupOptions, callback) => callback(null, target.address, target.family),
							maxHeaderSize: 16 * 1024,
							headers: {
								accept: options.headersOnly ? 'application/json, text/event-stream' : 'application/json',
								'accept-encoding': 'identity',
								...(options.authorization ? {authorization: options.authorization} : {}),
								...(options.body === undefined ? {} : {'content-type': options.contentType ?? 'application/json', 'content-length': Buffer.byteLength(options.body)}),
							},
						},
						(response) => {
							response.on('error', () => finish(Err(failure())));
							response.on('aborted', () => finish(Err(failure())));
							const status = response.statusCode ?? 0;
							// Even metadata redirects are refused; a token/code is never sent to a Location target.
							if (status >= 300 && status < 400) {
								finish(Err(failure()));
								return;
							}
							if (options.headersOnly) {
								finish(Ok({status, headers: response.headers, body: ''}));
								return;
							}
							const encoding = response.headers['content-encoding'];
							const declaredLength = response.headers['content-length'];
							if ((encoding && encoding !== 'identity') || (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BYTES))) {
								finish(Err(failure()));
								return;
							}
							let bytes = 0;
							let body = '';
							const decoder = new StringDecoder('utf8');
							response.on('data', (chunk: Buffer) => {
								bytes += chunk.length;
								if (bytes > MAX_BYTES) {
									finish(Err(failure()));
									return;
								}
								body += decoder.write(chunk);
							});
							response.on('end', () => finish(Ok({status, headers: response.headers, body: body + decoder.end()})));
						},
					),
				);
				if (created.isErr()) {
					finish(Err(failure()));
					return;
				}
				req = created.value;
				req.on('error', () => finish(Err(failure())));
				const ended = Result.wrap(() => req!.end(options.body));
				if (ended.isErr()) {
					finish(Err(failure()));
				}
			}),
		);
	});
}
