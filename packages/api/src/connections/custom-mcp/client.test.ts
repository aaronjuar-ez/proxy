import {beforeEach, describe, expect, mock, test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {IncomingMessage} from 'node:http';
import type {RequestOptions} from 'node:https';
import {Socket} from 'node:net';
import {Err, Ok} from 'ts-results-es';
import {ApiErr} from '@proxy/utils';

const {request: actualRequest, createServer: createTlsServer} = await import('node:https');
let fixturePort: number | undefined;
let fixtureTrustCertificate = true;

type Reply = {status?: number; body?: string; headers?: Record<string, string>; holdOpen?: boolean; fail?: 'before-send' | 'after-send'};
let addresses = [{address: '93.184.216.34', family: 4}];
let replies: Reply[] = [];
let dnsLookups = 0;
let rebind = false;
let sent: {url: URL; options: RequestOptions; body: string}[] = [];
mock.module('node:dns/promises', () => ({
	lookup: async () => {
		dnsLookups += 1;
		return rebind && dnsLookups > 1 ? [{address: '127.0.0.1', family: 4}] : addresses;
	},
}));
mock.module('node:https', () => ({
	request: (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
		if (fixturePort) {
			return actualRequest(url, {...options, ca: fixtureTrustCertificate ? fixtureCertificate : undefined}, callback);
		}
		const req = new EventEmitter();
		return Object.assign(req, {
			destroy: () => req,
			end: (body = '') => {
				sent.push({url, options, body});
				const reply = replies.shift();
				if (!reply) {
					queueMicrotask(() => req.emit('error', new Error('private-secret')));
					return;
				}
				queueMicrotask(() => {
					if (reply.fail === 'before-send') {
						req.emit('error', new Error('TLS failed'));
						return;
					}
					const tlsSocket = Object.assign(new EventEmitter(), {authorized: true});
					req.emit('socket', tlsSocket);
					tlsSocket.emit('secureConnect');
					req.emit('finish');
					if (reply.fail === 'after-send') {
						req.emit('error', new Error('Connection lost'));
						return;
					}
					const response = new IncomingMessage(new Socket());
					response.statusCode = reply.status ?? 200;
					response.headers = {'content-type': 'application/json', ...reply.headers};
					callback(response);
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
// Only this test substitutes the already-validated network target; production has no bypass.
mock.module('./endpoint', () => ({
	...originalEndpoint,
	resolveEndpoint: async (input: string, timeoutMs?: number) => {
		if (fixturePort) {
			return Ok({url: new URL(`https://mcp.example.com:${fixturePort}/mcp`), address: '127.0.0.1', family: 4});
		}
		return resolvePublicEndpoint(input, timeoutMs);
	},
}));
const {discoverTools, callUpstreamTool} = await import('./client');
const {isPublicAddress, validateEndpoint} = await import('./endpoint');
const config = {url: 'https://mcp.example.com/mcp', bearerToken: 'private-secret'};
const rpc = (id: number, result: Record<string, unknown>) => JSON.stringify({jsonrpc: '2.0', id, result});
const initialized = () => [{body: rpc(1, {protocolVersion: '2025-03-26', capabilities: {tools: {}}}), headers: {'mcp-session-id': 'session-123'}}, {status: 202}];
beforeEach(() => {
	addresses = [{address: '93.184.216.34', family: 4}];
	replies = [];
	sent = [];
	dnsLookups = 0;
	rebind = false;
});

describe('custom MCP endpoint security', () => {
	test('rejects local, non-HTTPS, credential-bearing and ambiguous endpoints', () => {
		for (const url of [
			'http://example.com/mcp',
			'https://localhost/mcp',
			'https://example.com:8443/mcp',
			'https://example.com:80/mcp',
			'https://a.internal/mcp',
			'https://user:password@example.com/mcp',
			'https://example.com/mcp?token=secret',
			'https://example.com/#fragment',
			'https://127.0.0.1',
			'https://2130706433',
			'https://[::1]',
			'file:///etc/passwd',
		]) {
			expect(validateEndpoint(url).isErr()).toBe(true);
		}
		expect(validateEndpoint(config.url).isOk()).toBe(true);
	});
	test('blocks special IPv4 and IPv6 ranges', () => {
		for (const address of [
			'127.0.0.1',
			'10.0.0.1',
			'169.254.169.254',
			'168.63.129.16',
			'100.100.100.200',
			'172.16.0.1',
			'192.168.1.1',
			'192.0.0.1',
			'192.0.2.1',
			'198.18.0.1',
			'198.51.100.1',
			'203.0.113.1',
			'224.0.0.1',
			'255.255.255.255',
			'::1',
			'::ffff:127.0.0.1',
			'fc00::1',
			'fe80::1',
			'2001:db8::1',
			'2002:7f00:1::',
			'64:ff9b::7f00:1',
			'2001::1',
		]) {
			expect(isPublicAddress(address)).toBe(false);
		}
		expect(isPublicAddress('8.8.8.8')).toBe(true);
		expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
	});
	test('rejects mixed public/private DNS without issuing HTTPS requests', async () => {
		addresses.push({address: '127.0.0.1', family: 4});
		expect((await discoverTools(config)).isErr()).toBe(true);
		expect(sent).toHaveLength(0);
	});
	test('blocks platform metadata IPs regardless of path', async () => {
		addresses = [{address: '168.63.129.16', family: 4}];
		expect((await discoverTools({...config, url: 'https://mcp.example.com/machine/?comp=goalstate'})).isErr()).toBe(true);
		expect((await discoverTools({...config, url: 'https://mcp.example.com/metadata/identity/oauth2/token'})).isErr()).toBe(true);
		expect(sent).toHaveLength(0);
	});
	test('revalidates DNS between requests and stops a rebinding server', async () => {
		rebind = true;
		replies = initialized();
		expect((await discoverTools(config)).isErr()).toBe(true);
		expect(sent).toHaveLength(1);
	});
	test('does not follow redirects or expose provider error details', async () => {
		replies = [{status: 302, headers: {location: 'https://other.example.com'}, body: 'private-secret'}];
		const result = await discoverTools(config);
		expect(result.isErr()).toBe(true);
		expect(JSON.stringify(result)).not.toContain('private-secret');
		expect(sent).toHaveLength(1);
	});
	test('pins socket lookup and requires TLS verification', async () => {
		replies = [...initialized(), {body: rpc(2, {tools: []})}];
		expect((await discoverTools(config)).isOk()).toBe(true);
		const options = sent[0]!.options;
		expect(options.rejectUnauthorized).toBe(true);
		expect(options.agent).toBe(false);
		options.lookup!('mcp.example.com', {family: 0, hints: 0}, (error, address, family) => {
			expect(error).toBeNull();
			expect(address).toBe('93.184.216.34');
			expect(family).toBe(4);
		});
	});
	test('rejects header injection before network access', async () => {
		expect((await discoverTools({...config, bearerToken: 'secret\r\nX-Evil: yes'})).isErr()).toBe(true);
		expect(sent).toHaveLength(0);
	});
});

describe('custom MCP protocol', () => {
	test('initializes, forwards session, and discovers all pages', async () => {
		replies = [
			...initialized(),
			{body: rpc(2, {tools: [{name: 'first', inputSchema: {type: 'object'}}], nextCursor: 'next'})},
			{body: rpc(3, {tools: [{name: 'second', inputSchema: {type: 'object'}}]})},
		];
		const result = await discoverTools(config);
		expect(result.isOk() && result.value.map((tool) => tool.name)).toEqual(['first', 'second']);
		expect(sent.filter(({body}) => body).map(({body}) => JSON.parse(body).method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
		expect(sent[2]!.options.headers).toMatchObject({'mcp-session-id': 'session-123', authorization: 'Bearer private-secret'});
		expect(JSON.parse(sent[3]!.body).params.cursor).toBe('next');
		expect(sent.at(-1)!.options.method).toBe('DELETE');
		expect(sent.at(-1)!.options.headers).toMatchObject({'mcp-session-id': 'session-123'});
	});
	test('checks authorization after initialize and cleans up without dispatch when revoked', async () => {
		replies = [...initialized(), {status: 204}];
		const result = await callUpstreamTool(config, 'execute', {}, async () => {
			expect(dnsLookups).toBe(3);
			expect(sent.filter(({body}) => body).map(({body}) => JSON.parse(body).method)).toEqual(['initialize', 'notifications/initialized']);
			return Err(ApiErr.forbidden());
		});
		expect(result.isErr() && result.error.kind).toBe('forbidden');
		expect(sent.map(({options}) => options.method)).toEqual(['POST', 'POST', 'DELETE']);
	});
	test('cleans up allocated sessions on unsupported initialization', async () => {
		for (const result of [
			{protocolVersion: 'unsupported', capabilities: {tools: {}}},
			{protocolVersion: '2025-03-26', capabilities: {}},
		]) {
			sent = [];
			replies = [{body: rpc(1, result), headers: {'mcp-session-id': 'unused-session'}}, {status: 204}];
			expect((await discoverTools(config)).isErr()).toBe(true);
			expect(sent.map(({options}) => options.method)).toEqual(['POST', 'DELETE']);
		}
	});
	test('initialization and pre-send failures never claim possible tool execution', async () => {
		replies = [{fail: 'before-send'}];
		expect((await callUpstreamTool(config, 'execute', {})).unwrapErr().kind).toBe('provider_unreachable');
		expect(sent.filter(({body}) => body).map(({body}) => JSON.parse(body).method)).toEqual(['initialize']);
		replies = [...initialized(), {fail: 'before-send'}];
		expect((await callUpstreamTool(config, 'execute', {})).unwrapErr().kind).toBe('provider_unreachable');
	});
	test('a lost response after dispatch warns against repeating the action', async () => {
		replies = [...initialized(), {fail: 'after-send'}];
		const error = (await callUpstreamTool(config, 'execute', {})).unwrapErr();
		expect(error.kind).toBe('conflict');
		expect('message' in error && error.message).toContain('before retrying');
	});
	test('an invalid result after dispatch also has an unknown outcome', async () => {
		replies = [...initialized(), {body: rpc(2, {unexpected: true})}];
		expect((await callUpstreamTool(config, 'execute', {})).unwrapErr().kind).toBe('conflict');
	});
	test('preserves structured, image, resource, metadata and tool errors', async () => {
		const toolResult = {
			content: [
				{type: 'image', data: 'abc', mimeType: 'image/png'},
				{type: 'resource', resource: {uri: 'custom://item', text: 'value'}},
			],
			structuredContent: {value: 42},
			isError: true,
			_meta: {trace: 'x'},
		};
		replies = [...initialized(), {body: rpc(2, toolResult)}];
		const result = await callUpstreamTool(config, 'execute', {query: 'hello'});
		expect(result.isOk() && result.value).toEqual(toolResult);
		expect(JSON.parse(sent[2]!.body).params).toEqual({name: 'execute', arguments: {query: 'hello'}});
	});
	test('supports multiline SSE and ignores notification events without waiting for stream end', async () => {
		replies = [
			...initialized(),
			{
				headers: {'content-type': 'text/event-stream'},
				holdOpen: true,
				body: 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\ndata: {"jsonrpc":"2.0", "id":2,\r\ndata: "result":{"content":[{"type":"text","text":"done"}]}}\r\n\r\n',
			},
		];
		const result = await callUpstreamTool(config, 'execute', {});
		expect(result.isOk() && result.value.content).toEqual([{type: 'text', text: 'done'}]);
	});
	test('rejects deeply nested provider schemas before hashing and caps aggregate discovery bytes', async () => {
		let nested: Record<string, unknown> = {};
		for (let level = 0; level < 70; level += 1) {
			nested = {child: nested};
		}
		replies = [...initialized(), {body: rpc(2, {tools: [{name: 'deep', inputSchema: {type: 'object', nested}}]})}];
		expect((await discoverTools(config)).isErr()).toBe(true);
		const padding = 'x'.repeat(1100000);
		replies = [
			...initialized(),
			{body: rpc(2, {tools: [{name: 'first', inputSchema: {type: 'object', padding}}], nextCursor: 'next'})},
			{body: rpc(3, {tools: [{name: 'second', inputSchema: {type: 'object', padding}}]})},
		];
		expect((await discoverTools(config)).isErr()).toBe(true);
	});
	test('stops repeated pagination cursors and duplicate tool names', async () => {
		replies = [...initialized(), {body: rpc(2, {tools: [], nextCursor: 'loop'})}, {body: rpc(3, {tools: [], nextCursor: 'loop'})}];
		expect((await discoverTools(config)).isErr()).toBe(true);
		replies = [
			...initialized(),
			{
				body: rpc(2, {
					tools: [
						{name: 'same', inputSchema: {type: 'object'}},
						{name: 'same', inputSchema: {type: 'object'}},
					],
				}),
			},
		];
		expect((await discoverTools(config)).isErr()).toBe(true);
	});
	test('classifies rejected credentials and refuses malformed RPC, mismatched ids and oversized responses', async () => {
		replies = [{status: 401}];
		const rejected = await discoverTools(config);
		expect(rejected.isErr() && rejected.error.kind).toBe('credentials_rejected');
		for (const body of ['not-json', rpc(99, {}), ' '.repeat(2 * 1024 * 1024 + 1), JSON.stringify({jsonrpc: '2.0', id: 1, error: {message: 'private-secret'}})]) {
			replies = [{body}];
			const result = await discoverTools(config);
			expect(result.isErr()).toBe(true);
			expect(JSON.stringify(result)).not.toContain('private-secret');
		}
	});
});

test('real TLS socket honors the pinned lookup and parses JSON initialization plus streamed SSE tools', async () => {
	const methods: string[] = [];
	const server = createTlsServer({key: fixtureKey, cert: fixtureCertificate}, (request, response) => {
		let body = '';
		request.on('data', (chunk: Buffer) => {
			body += chunk.toString('utf8');
		});
		request.on('end', () => {
			if (request.method === 'DELETE') {
				methods.push('DELETE');
				response.writeHead(204);
				response.end();
				return;
			}
			const message = JSON.parse(body) as {id?: number; method: string};
			methods.push(message.method);
			if (message.method === 'initialize') {
				response.writeHead(200, {'content-type': 'application/json', 'mcp-session-id': 'socket-session'});
				response.end(rpc(1, {protocolVersion: '2025-03-26', capabilities: {tools: {}}}));
				return;
			}
			expect(request.headers['mcp-session-id']).toBe('socket-session');
			if (message.method === 'notifications/initialized') {
				response.writeHead(202);
				response.end();
				return;
			}
			response.writeHead(200, {'content-type': 'text/event-stream'});
			response.write('data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n');
			setTimeout(() => response.end(`data: ${rpc(message.id!, {tools: [{name: 'socket_tool', inputSchema: {type: 'object'}}]})}\n\n`), 5);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (typeof address !== 'object' || !address) {
		throw new Error('Test TLS server did not listen');
	}
	fixturePort = address.port;
	try {
		const result = await discoverTools(config);
		expect(result.isOk() && result.value.map((tool) => tool.name)).toEqual(['socket_tool']);
		expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
		const rejected = await callUpstreamTool(config, 'execute', {}, async () => {
			fixtureTrustCertificate = false;
			return Ok(undefined);
		});
		expect(rejected.unwrapErr().kind).toBe('provider_unreachable');
		expect(methods).not.toContain('tools/call');
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
