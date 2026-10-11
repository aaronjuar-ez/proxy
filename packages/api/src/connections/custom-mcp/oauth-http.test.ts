import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';
import {Socket} from 'node:net';
import {Ok} from 'ts-results-es';

const {request: actualRequest, createServer: createTlsServer} = await import('node:https');
let fixturePort: number | undefined;
let fixtureTrustCertificate = true;

type Reply = {status?: number; headers?: Record<string, string>; body?: string; holdOpen?: boolean; error?: boolean; aborted?: boolean};
let addresses = [{address: '93.184.216.34', family: 4}];
let replies: Reply[] = [];
let sent: {url: URL; options: RequestOptions; body?: string}[] = [];
let lookups = 0;
let rebind = false;
let destroyed = 0;
mock.module('node:dns/promises', () => ({
	lookup: async () => {
		lookups += 1;
		return rebind && lookups > 1 ? [{address: '127.0.0.1', family: 4}] : addresses;
	},
}));
mock.module('node:https', () => ({
	request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
		if (fixturePort) {
			const target = new URL(url);
			target.port = String(fixturePort);
			return actualRequest(target, {...options, ca: fixtureTrustCertificate ? fixtureCertificate : undefined}, callback);
		}
		const req = new EventEmitter();
		return Object.assign(req, {
			destroy: () => {
				destroyed += 1;
				return req;
			},
			end: (body?: string) => {
				sent.push({url, options, body});
				const reply = replies.shift();
				queueMicrotask(() => {
					if (!reply || reply.error) {
						req.emit('error', new Error('private-token-and-internal-host'));
						return;
					}
					const response = new IncomingMessage(new Socket());
					response.statusCode = reply.status ?? 200;
					response.headers = {'content-type': 'application/json', ...reply.headers};
					callback(response);
					if (reply.aborted) {
						response.emit('aborted');
						return;
					}
					if (reply.body) {
						response.push(Buffer.from(reply.body));
					}
					if (!reply.holdOpen) {
						response.push(null);
					}
				});
			},
		});
	},
}));
const originalEndpoint = await import('./endpoint');
const resolvePublicEndpoint = originalEndpoint.resolveEndpoint;
// The socket fixture alone substitutes a loopback address; production has no bypass.
mock.module('./endpoint', () => ({
	...originalEndpoint,
	resolveEndpoint: async (input: string, timeoutMs?: number) => {
		if (fixturePort) {
			return Ok({url: new URL(input), address: '127.0.0.1', family: 4});
		}
		return resolvePublicEndpoint(input, timeoutMs);
	},
}));
const {oauthHttpRequest, validateOAuthEndpoint} = await import('./oauth-http');

beforeEach(() => {
	addresses = [{address: '93.184.216.34', family: 4}];
	replies = [];
	sent = [];
	lookups = 0;
	rebind = false;
	destroyed = 0;
});

describe('custom MCP OAuth HTTPS transport', () => {
	test('allows endpoint queries while rejecting unsafe URL forms before DNS', async () => {
		expect(validateOAuthEndpoint('https://oauth.example.com/token?tenant=one').isOk()).toBe(true);
		for (const url of [
			'http://oauth.example.com/token',
			'https://oauth.example.com:8443/token',
			'https://oauth.example.com/token#fragment',
			'https://user:password@oauth.example.com/token',
			'https://localhost/token',
			'https://host.internal/token',
			'https://127.0.0.1/token',
			'https://2130706433/token',
			'https://[::ffff:127.0.0.1]/token',
			'https://oauth.example.com/token\n',
		]) {
			expect((await oauthHttpRequest(url)).isErr()).toBe(true);
		}
		expect(lookups).toBe(0);
		expect(sent).toHaveLength(0);
	});
	test('pins DNS, retains hostname/query, disables pooling and requires verified TLS', async () => {
		replies = [{body: '{"ok":true}'}];
		const result = await oauthHttpRequest('https://oauth.example.com/token?tenant=one', {method: 'POST', contentType: 'application/x-www-form-urlencoded', body: 'code=secret'});
		expect(result.unwrap().body).toBe('{"ok":true}');
		const request = sent[0]!;
		expect(request.url.href).toBe('https://oauth.example.com/token?tenant=one');
		expect(request.options).toMatchObject({agent: false, rejectUnauthorized: true, minVersion: 'TLSv1.2', maxHeaderSize: 16384});
		expect(request.options.headers).toMatchObject({'content-type': 'application/x-www-form-urlencoded', 'content-length': 11});
		request.options.lookup!('oauth.example.com', {family: 0, hints: 0}, (error, address, family) => {
			expect(error).toBeNull();
			expect(address).toBe('93.184.216.34');
			expect(family).toBe(4);
		});
		expect(destroyed).toBe(1);
	});
	test('refuses mixed-public-private resolution before sending a code', async () => {
		addresses.push({address: '169.254.169.254', family: 4});
		expect((await oauthHttpRequest('https://oauth.example.com/token', {method: 'POST', body: 'code=secret'})).isErr()).toBe(true);
		expect(sent).toHaveLength(0);
	});
	test('revalidates DNS and rejects rebinding before sending credentials', async () => {
		rebind = true;
		replies = [{body: '{}'}];
		expect((await oauthHttpRequest('https://oauth.example.com/.well-known/oauth-authorization-server')).isOk()).toBe(true);
		expect((await oauthHttpRequest('https://oauth.example.com/token', {method: 'POST', body: 'refresh_token=secret'})).isErr()).toBe(true);
		expect(sent).toHaveLength(1);
	});
	test('does not follow redirects or retain provider failure details', async () => {
		for (const reply of [{status: 307, headers: {location: 'https://attacker.example.com'}, body: 'private-token-and-internal-host'}, {error: true}]) {
			replies = [reply];
			const result = await oauthHttpRequest('https://oauth.example.com/token', {method: 'POST', body: 'code=secret'});
			expect(result.isErr()).toBe(true);
			expect(JSON.stringify(result)).not.toContain('private-token-and-internal-host');
		}
		expect(sent).toHaveLength(2);
	});
	test('bounds request and response bytes, refuses compressed bodies and truncation', async () => {
		expect((await oauthHttpRequest('https://oauth.example.com/token', {method: 'POST', body: 'x'.repeat(256 * 1024 + 1)})).isErr()).toBe(true);
		expect(sent).toHaveLength(0);
		const invalidReplies: Reply[] = [
			{body: 'x'.repeat(256 * 1024 + 1)},
			{headers: {'content-length': `${256 * 1024 + 1}`}},
			{headers: {'content-encoding': 'gzip'}, body: 'compressed'},
			{aborted: true},
		];
		for (const reply of invalidReplies) {
			replies = [reply];
			expect((await oauthHttpRequest('https://oauth.example.com/token')).isErr()).toBe(true);
		}
	});
	test('stops unauthenticated SSE probes immediately at response headers', async () => {
		replies = [{status: 401, headers: {'www-authenticate': 'Bearer resource_metadata="https://oauth.example.com/meta"'}, holdOpen: true}];
		const response = (await oauthHttpRequest('https://oauth.example.com/mcp', {headersOnly: true})).unwrap();
		expect(response.status).toBe(401);
		expect(response.body).toBe('');
		expect(sent[0]!.options.headers).not.toHaveProperty('authorization');
		expect(destroyed).toBe(1);
	});
	test('has an absolute deadline even if a response remains open', async () => {
		replies = [{holdOpen: true}];
		const start = Date.now();
		expect((await oauthHttpRequest('https://oauth.example.com/token', {deadline: Date.now() + 25})).isErr()).toBe(true);
		expect(Date.now() - start).toBeLessThan(1000);
		expect(destroyed).toBe(1);
	});
	test('rejects authorization header injection before resolving DNS', async () => {
		expect((await oauthHttpRequest('https://oauth.example.com/token', {authorization: 'Basic secret\r\nInjected: yes'})).isErr()).toBe(true);
		expect(lookups).toBe(0);
		expect(sent).toHaveLength(0);
	});
});

test('real TLS socket honors the pinned address and fails certificate verification before transmitting a token', async () => {
	const requests: {url?: string; host?: string; method?: string; authorization?: string; body: string}[] = [];
	const server = createTlsServer({key: fixtureKey, cert: fixtureCertificate}, (request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});
		request.on('end', () => {
			requests.push({url: request.url, host: request.headers.host, method: request.method, authorization: request.headers.authorization, body});
			response.writeHead(200, {'content-type': 'application/json'});
			response.end(JSON.stringify({access_token: 'socket-token', token_type: 'Bearer'}));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (!address || typeof address !== 'object') {
		throw new Error('Test TLS server did not listen');
	}
	fixturePort = address.port;
	try {
		const response = await oauthHttpRequest('https://mcp.example.com/token?tenant=one', {
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: 'grant_type=refresh_token&refresh_token=socket-refresh',
			authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
		});
		expect(JSON.parse(response.unwrap().body).access_token).toBe('socket-token');
		expect(requests).toEqual([
			{
				url: '/token?tenant=one',
				host: `mcp.example.com:${fixturePort}`,
				method: 'POST',
				authorization: `Basic ${Buffer.from('client:secret').toString('base64')}`,
				body: 'grant_type=refresh_token&refresh_token=socket-refresh',
			},
		]);
		fixtureTrustCertificate = false;
		const rejected = await oauthHttpRequest('https://mcp.example.com/token', {method: 'POST', body: 'refresh_token=must-not-arrive'});
		expect(rejected.unwrapErr().kind).toBe('provider_unreachable');
		expect(requests).toHaveLength(1);
	} finally {
		fixturePort = undefined;
		fixtureTrustCertificate = true;
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

// Public test-only self-signed fixture, trusted only by the socket test transport wrapper.
const fixtureCertificate = `-----BEGIN CERTIFICATE-----
MIIDMTCCAhmgAwIBAgIUXBvmXrypHGLu+5m28zTPvoYQ9IUwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPbWNwLmV4YW1wbGUuY29tMB4XDTI2MTAxMDE5Mzg1M1oX
DTM2MTAwNzE5Mzg1M1owGjEYMBYGA1UEAwwPbWNwLmV4YW1wbGUuY29tMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmSFTAtAM7OjTSa9iRqlwU1eVUbfU
orjnqzLKSJ8axAid4E5EaVZG1CCgKmnifDwgCkGKnxPOEXH1Dd2XJ10+8zzXovhF
i7CKJ7fyaRRNnx6rbWMuvpkjMymiA3AYH6qvx5MNmu7GvuwhPhuriJlJSV+6ukMo
7ri75wZBGKaVM9f3UkJOi4VfwMQl4e5NLFzeXm0CNLQzYHOZsQMy1f5Y2yletXao
OXk8hILJ6DXmz0JphGT1IsVR2yo1jtDeQcUCWvyMlbicV8MNgI4/CblrBiQJ/8z0
Ensy+Lubv8jeGOwjMH0EKJpYUA9mpkaQmb7YI6GJgMdyiDqkWuTXg0kqwwIDAQAB
o28wbTAdBgNVHQ4EFgQUOl3mrtllirT/8uu+LikQwUuKeH8wHwYDVR0jBBgwFoAU
Ol3mrtllirT/8uu+LikQwUuKeH8wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzAR
gg9tY3AuZXhhbXBsZS5jb20wDQYJKoZIhvcNAQELBQADggEBABOwXk7M3flvqsEX
8WDr4spjAyia5V4Siye64qs/4ErXaFXdf1LP9C0buKNyD5rD6Z/nQT0KcF2psZIy
LAnh7nH8cAVhtWtlVILe/dMBQ+iUkshJ0JUtozbFF7hZtbHbCpHZYS5M1cH8B97m
lMU/ImJc2TPhNX/WzpU4B51JQfca1ghZ6DKsC4vMKRqF7smJL3twSmSd2gJgznRi
91WB7VRGJvUVaABctiybyiusPKoRADf94ndY+BS1vJTeIfaBB2yjMKCg+U0vYuMC
nYvW2O1p2DllKOhRH0CKNBX0kywAeJhXorOXqD0wZK4L8gPT1NnknjqKJD8BcKyb
sybVVuE=
-----END CERTIFICATE-----
`;
const fixtureKey = `-----BEGIN PRIVATE KEY-----
MIIEugIBADANBgkqhkiG9w0BAQEFAASCBKQwggSgAgEAAoIBAQCZIVMC0Azs6NNJ
r2JGqXBTV5VRt9SiuOerMspInxrECJ3gTkRpVkbUIKAqaeJ8PCAKQYqfE84RcfUN
3ZcnXT7zPNei+EWLsIont/JpFE2fHqttYy6+mSMzKaIDcBgfqq/Hkw2a7sa+7CE+
G6uImUlJX7q6QyjuuLvnBkEYppUz1/dSQk6LhV/AxCXh7k0sXN5ebQI0tDNgc5mx
AzLV/ljbKV61dqg5eTyEgsnoNebPQmmEZPUixVHbKjWO0N5BxQJa/IyVuJxXww2A
jj8JuWsGJAn/zPQSezL4u5u/yN4Y7CMwfQQomlhQD2amRpCZvtgjoYmAx3KIOqRa
5NeDSSrDAgMBAAECgf9d6RH/p5hFsoPhrK2YqFE6y3vHofXF1aA+XeewoeLIVoB8
D4PlFgRaE6gmWsmLZ1Q+9fMNnBfEmx6uYjdQ7N6uTaHxUFFWWe5gbW89AjaYXzbC
3xDL0x7DQcUaVqR0xzkGLCkr20QH0siQTmfkXh2T4iGiGY4A2UpjZHKHq6HVKKpm
+iRGtU6pR3+Yum9gXJhWMzZ8sTWsKnaSfKFM/1KDbmCcKg6ccQMyG5G4ZNxHySW3
5C/qztVGgnIKr59MkmidCqt1Y0fEvo+WkDhXIAL1LT+7X5N2xgzLPpNLuqohRBdv
ZLfRYZLLjo0EIe0FfUwQ4H4bih2rT/GOBzTu+GECgYEAz3evTs/AXj3B4JcWkema
Bq9MU8rWTAjPqdpogLqy8lMZ30Iv1GkIpjO3AQTrmydutHubqty2uu0aueqVgOYf
69ywYT8dD/8kqAncxH2AYy7TfBVjtwfQNMDJpzK9D/9xq9d9SsGOzQjgfDueSehc
VrxjEW4NxTr3gQg/UK8dlXECgYEAvPOdhqhyhp3Frdn2qSdfbI7Zq6mdLNy8LJi5
WMV7TT10xX9wInKvKaimqi/8tix69W9zBhoKGt7Tm1qkROxzBEE7ZtqXFQ8z3zbl
+EJIwzjXjhCHt5mWlpEliA1dZfj665sPx7usVS6DJC7XqEa4aAoEfP15uGAhhwEp
/exXGXMCgYB27JVaKO6NVvtOwWzXoT+Ae3XWRlxG43oeVCs5N0wiag5XkvoV2Uty
8gwCEo73tkfYP07BR5mbVxTN47FlXQSJUEzuwZ3oMIoTpOue2o4AzLO/2gb5wQnR
Y310UTpc9EF1jqWsd31i/KapsAcROJfNxFlJgXt1RlLf7RlWJ7tekQKBgC3LrcZR
VVCjNKIqTco5rLsW9FLSzTFuXn1AlsuZMYVK+95SQM9YlHO4WIyvDMTqivKpjGtS
LFjO4OKqWV4LIOVLGiaXnD6SbLQRDjPZfOE0Cap4/yvUodbkXwBWnOh2K/qmnnB+
YApVN5uxbrtuSIuOwf+5P6McSYP7GD5e5c1ZAoGAPKTvKTM8d4MDpfuKCoDhKX0w
90DJOG6cz96yaphvajMq5roIS22QYc+t7U+vuOrZUQvUqzkrLcnjKDoCvCYKmmjZ
OM+JpEjor5K8nY21Jnvd1Lz8E8cyfXqpGE5g0hxbZJAoSn4dMxwWfzvFXVT5gP+u
BCvhmdodPlIVMX9h1VM=
-----END PRIVATE KEY-----
`;
