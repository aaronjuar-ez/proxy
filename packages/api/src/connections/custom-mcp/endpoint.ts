import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {ApiErr, type ApiError, Do} from '@proxy/utils';
import {Err, Ok, Result} from 'ts-results-es';

/** Conservative public-unicast policy. Transition, documentation and special-use ranges are refused. */
export function isPublicAddress(address: string): boolean {
	// Azure WireServer uses a public-looking virtual address inside Azure networks.
	if (address === '168.63.129.16') {
		return false;
	}
	if (isIP(address) === 4) {
		const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
			(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
			(a === 203 && b === 0 && c === 113)
		);
	}
	if (isIP(address) !== 6) {
		return false;
	}
	const [first = 0, second = 0] = address
		.toLowerCase()
		.split(':')
		.slice(0, 2)
		.map((part) => Number.parseInt(part || '0', 16));
	return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

/** Reject credentials, query-string secrets, local names and numeric-IP URL tricks before resolving DNS. */
export function validateEndpoint(input: string): Result<URL, ApiError> {
	const parsed = Result.wrap(() => new URL(input));
	if (parsed.isErr()) {
		return Err(ApiErr.validationError('Enter a valid HTTPS MCP endpoint.'));
	}
	const url = parsed.value;
	const hostname = url.hostname.toLowerCase();
	if (
		input.length > 2048 ||
		url.protocol !== 'https:' ||
		(url.port !== '' && url.port !== '443') ||
		url.username ||
		url.password ||
		url.hash ||
		url.search ||
		!hostname.includes('.') ||
		hostname.endsWith('.') ||
		isIP(hostname.replace(/^\[|\]$/g, '')) ||
		['localhost', 'local', 'internal', 'test', 'invalid', 'onion'].some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))
	) {
		return Err(ApiErr.validationError('Use a public HTTPS MCP endpoint on port 443 without credentials, query parameters or fragments.'));
	}
	return Ok(url);
}

export function resolveEndpoint(input: string, timeoutMs = 5000): Promise<Result<{url: URL; address: string; family: number}, ApiError>> {
	return Do(async ($) => {
		const url = $(validateEndpoint(input));
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const resolved = await Result.wrapAsync(() =>
			Promise.race([
				lookup(url.hostname, {all: true, verbatim: true}),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs);
				}),
			]),
		);
		clearTimeout(timeout);
		if (resolved.isErr()) {
			return $(Err(ApiErr.providerUnreachable(new Error('MCP endpoint DNS lookup failed.'))));
		}
		const addresses = resolved.value;
		const first = addresses[0];
		if (!first || addresses.some(({address}) => !isPublicAddress(address))) {
			return $(Err(ApiErr.validationError('MCP endpoints must resolve exclusively to public internet addresses.')));
		}
		return {url, address: first.address, family: first.family};
	});
}
