/// <reference types="bun" />
import {afterAll, afterEach, expect, mock, spyOn, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {ConnectCustomMcpForm} from '@/components/connect-custom-mcp-form';
import {CustomMcpTools} from '@/components/custom-mcp-tools';
import {HumanSide} from '@/components/human-side';
import {customMcpSchema} from '@/client/schemas';
import {getConnection} from '@/client/connections-client';
import {agentErrorMessage} from '@/lib/agent-errors';
import {AddCustomMcpPage} from '@/pages/add-custom-mcp-page';
import {ConnectionPage} from '@/pages/connection-page';
import {WelcomePage} from '@/pages/welcome-page';
import type {Connection} from '@/lib/types';

const connected: Connection = {
	id: 'custom-1',
	integrationId: 'custom-mcp',
	account: 'Example server',
	defaults: [],
	customMcp: {
		url: 'https://example.com/mcp',
		authType: 'oauth',
		oauth: {issuer: 'https://provider.example', clientId: 'public-client'},
		tools: [{name: 'search', actionId: 'tool-v1', inputSchema: {type: 'object'}}],
	},
};
const authorizationUrl = 'https://provider.example/authorize?state=opaque';
const originalFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch');
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
	cleanup();
	fetchSpy.mockReset();
	window.location.href = 'http://localhost/';
});
function respond(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
	fetchSpy.mockImplementation(Object.assign(handler, {preconnect: originalFetch.preconnect}));
}
async function chooseAuth(name: string) {
	fireEvent.click(screen.getByRole('combobox', {name: 'Authentication'}));
	const option = await screen.findByRole('option', {name});
	fireEvent.pointerDown(option);
	fireEvent.click(option);
	await waitFor(() =>
		expect(
			screen.getByRole('combobox', {name: 'Authentication'}).getAttribute('aria-expanded'),
		).toBe('false'),
	);
}
function fillServer() {
	fireEvent.change(screen.getByLabelText('Connection name'), {target: {value: ' Example server '}});
	fireEvent.change(screen.getByLabelText('HTTPS MCP server URL'), {
		target: {value: 'https://example.com/mcp'},
	});
}
function form() {
	return screen.getByLabelText('Connection name').closest('form')!;
}
function renderTools(connection = connected, oauthFailed = false) {
	const router = createMemoryRouter(
		[
			{
				path: '/connection',
				element: <CustomMcpTools connection={connection} oauthFailed={oauthFailed} />,
			},
			{path: '/away', element: <p>Another page</p>},
		],
		{initialEntries: ['/connection']},
	);
	render(<RouterProvider router={router} />);
	return router;
}
function renderPage(path: string) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({
					user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
					onboarded: true,
				}),
				element: <HumanSide />,
				children: [
					{path: '/connections/new/custom-mcp', element: <AddCustomMcpPage />},
					{
						path: '/connections/:id',
						loader: () => ({
							connection: connected,
							connections: [connected],
							agents: [],
							entries: [],
						}),
						element: <ConnectionPage />,
					},
				],
			},
			{
				path: '/welcome/connections/custom-mcp',
				loader: () => ({agents: [], connections: []}),
				element: <WelcomePage step="custom-mcp" />,
			},
		],
		{initialEntries: [path]},
	);
	render(
		<ThemeProvider>
			<TooltipProvider>
				<RouterProvider router={router} />
			</TooltipProvider>
		</ThemeProvider>,
	);
	return router;
}

test('public metadata retains OAuth configuration while stripping all credential fields', async () => {
	const metadata = {
		...connected.customMcp!,
		bearerToken: 'never-show',
		oauth: {
			...connected.customMcp!.oauth!,
			accessToken: 'never-show',
			refreshToken: 'never-show',
			tokens: {accessToken: 'never-show'},
		},
	};
	expect(customMcpSchema.parse(metadata)).toEqual(connected.customMcp!);
	respond(async (url) => Response.json(String(url).endsWith('/custom-mcp') ? metadata : connected));
	expect((await getConnection(connected.id)).unwrap().customMcp).toEqual(connected.customMcp!);
});

test('no-auth and bearer-token connections keep the existing endpoint and clear entered tokens', async () => {
	const onConnected = mock();
	const bodies: string[] = [];
	respond(async (url, init) => {
		expect(String(url)).toBe('/api/connections/custom-mcp');
		bodies.push(String(init?.body));
		return Response.json(connected);
	});
	render(<ConnectCustomMcpForm onConnected={onConnected} />);
	fillServer();
	fireEvent.submit(form());
	await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
	expect(JSON.parse(bodies[0]!)).toEqual({
		account: 'Example server',
		url: 'https://example.com/mcp',
	});
	await chooseAuth('Bearer token');
	const token = screen.getByLabelText('Bearer token');
	fireEvent.change(token, {target: {value: 'test-bearer'}});
	fireEvent.submit(form());
	expect(token).toHaveProperty('value', '');
	await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(2));
	expect(JSON.parse(bodies[1]!)).toEqual({
		account: 'Example server',
		url: 'https://example.com/mcp',
		bearerToken: 'test-bearer',
	});
});

test.each([false, true])(
	'OAuth starts a same-origin POST with only the selected auth fields; registered client: %s',
	async (registered) => {
		const onConnected = mock();
		respond(async (url, init) => {
			expect(String(url)).toBe('/api/connections/custom-mcp/oauth/start');
			expect(init?.method).toBe('POST');
			expect(init?.headers).toEqual({'Content-Type': 'application/json'});
			expect(JSON.parse(String(init?.body))).toEqual({
				account: 'Example server',
				url: 'https://example.com/mcp',
				returnTo: 'welcome',
				...(registered ? {clientId: 'public-client'} : {}),
			});
			return Response.json({authorizationUrl});
		});
		render(<ConnectCustomMcpForm onConnected={onConnected} returnTo="welcome" />);
		fillServer();
		await chooseAuth('Bearer token');
		fireEvent.change(screen.getByLabelText('Bearer token'), {target: {value: 'old-bearer'}});
		await chooseAuth('OAuth');
		expect(screen.queryByLabelText('Bearer token')).toBeNull();
		expect(screen.queryByLabelText(/client secret/i)).toBeNull();
		expect(screen.getByText(/approval may be required/)).toBeTruthy();
		if (registered) {
			fireEvent.change(screen.getByLabelText('Public client ID (optional)'), {
				target: {value: ' public-client '},
			});
		}
		fireEvent.submit(form());
		await waitFor(() => expect(window.location.href).toBe(authorizationUrl));
		expect(onConnected).not.toHaveBeenCalled();
		expect(screen.getByRole('button', {name: 'Opening sign-in…'})).toHaveProperty('disabled', true);
	},
);

test('OAuth duplicate submissions are blocked and unmount cancels without a late redirect', async () => {
	let resolveResponse: (response: Response) => void = () => {};
	let signal: AbortSignal | null | undefined;
	respond(async (_url, init) => {
		signal = init?.signal;
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
	});
	const view = render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.submit(form());
	fireEvent.submit(form());
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	view.unmount();
	expect(signal?.aborted).toBe(true);
	await act(async () => {
		resolveResponse(Response.json({authorizationUrl}));
	});
	expect(window.location.href).toBe('http://localhost/');
});

test('Back from provider restores retry controls and ignores the older attempt', async () => {
	let resolveFirst: (response: Response) => void = () => {};
	let attempts = 0;
	respond(async () => {
		attempts += 1;
		if (attempts === 1) {
			return new Promise<Response>((resolve) => {
				resolveFirst = resolve;
			});
		}
		return Response.json({authorizationUrl});
	});
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.submit(form());
	act(() => {
		window.dispatchEvent(new Event('pageshow'));
	});
	expect(screen.getByRole('button', {name: 'Continue with OAuth'})).toHaveProperty(
		'disabled',
		false,
	);
	await act(async () => {
		resolveFirst(Response.json({authorizationUrl: 'https://older.example/authorize'}));
	});
	expect(window.location.href).toBe('http://localhost/');
	fireEvent.submit(form());
	await waitFor(() => expect(window.location.href).toBe(authorizationUrl));
	expect(attempts).toBe(2);
});

test.each(['network', 'provider', 'malformed', 'unsafe'])(
	'OAuth %s failure remains retryable and never exposes provider details',
	async (failure) => {
		respond(async () => {
			if (failure === 'network') {
				throw new Error('secret-in-network-error');
			}
			if (failure === 'provider') {
				return Response.json({error: 'secret-in-response'}, {status: 502});
			}
			return Response.json(
				failure === 'malformed'
					? {token: 'secret-in-response'}
					: {authorizationUrl: 'javascript:alert(1)'},
			);
		});
		render(<ConnectCustomMcpForm onConnected={mock()} />);
		fillServer();
		await chooseAuth('OAuth');
		for (let attempt = 0; attempt < 2; attempt += 1) {
			fireEvent.submit(form());
			expect((await screen.findByRole('alert')).textContent).toContain(
				'pre-registered public client ID',
			);
			expect(screen.getByRole('button', {name: 'Continue with OAuth'})).toHaveProperty(
				'disabled',
				false,
			);
		}
		expect(document.body.textContent).not.toContain('secret-in-');
		expect(window.location.href).toBe('http://localhost/');
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	},
);

test('expired browser sessions ask to sign in again without redirecting to a provider', async () => {
	respond(async () => Response.json({}, {status: 401}));
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.submit(form());
	expect((await screen.findByRole('alert')).textContent).toContain(
		'Reload the page to sign in again',
	);
	expect(window.location.href).toBe('http://localhost/');
});

test('reconnect uses the existing connection ID, warns about grant removal and is not duplicated', async () => {
	let resolveResponse: (response: Response) => void = () => {};
	respond(async (url, init) => {
		expect(String(url)).toBe('/api/connections/custom-mcp/oauth/start');
		expect(JSON.parse(String(init?.body))).toEqual({connectionId: connected.id});
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
	});
	renderTools();
	expect(screen.getByText(/Reconnecting removes all agent grants/)).toBeTruthy();
	expect(screen.queryByText('public-client')).toBeNull();
	const reconnectForm = screen.getByRole('button', {name: 'Reconnect OAuth'}).closest('form')!;
	fireEvent.submit(reconnectForm);
	fireEvent.submit(reconnectForm);
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	expect(screen.getByRole('button', {name: 'Refresh tools'})).toHaveProperty('disabled', true);
	await act(async () => {
		resolveResponse(Response.json({authorizationUrl}));
	});
	expect(window.location.href).toBe(authorizationUrl);
});

test('reconnect accepts a replacement public client, handles denial and retries', async () => {
	respond(async (_url, init) => {
		expect(JSON.parse(String(init?.body))).toEqual({
			connectionId: connected.id,
			clientId: 'replacement-client',
		});
		return Response.json({error: 'internal-provider-message'}, {status: 400});
	});
	renderTools();
	fireEvent.click(screen.getByText('Use a different public client ID'));
	fireEvent.change(screen.getByLabelText('Public client ID (optional)'), {
		target: {value: 'replacement-client'},
	});
	fireEvent.click(screen.getByRole('button', {name: 'Reconnect OAuth'}));
	await screen.findByRole('alert');
	expect(screen.getByRole('button', {name: 'Reconnect OAuth'})).toHaveProperty('disabled', false);
	expect(document.body.textContent).not.toContain('internal-provider-message');
});

test('leaving reconnect aborts it and late responses cannot replace a newer page', async () => {
	let resolveResponse: (response: Response) => void = () => {};
	let signal: AbortSignal | null | undefined;
	respond(async (_url, init) => {
		signal = init?.signal;
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
	});
	const router = renderTools();
	fireEvent.click(screen.getByRole('button', {name: 'Reconnect OAuth'}));
	await act(async () => {
		await router.navigate('/away');
	});
	expect(signal?.aborted).toBe(true);
	await act(async () => {
		resolveResponse(Response.json({authorizationUrl}));
	});
	expect(screen.getByText('Another page')).toBeTruthy();
	expect(window.location.href).toBe('http://localhost/');
});

test('rejected OAuth refresh asks the owner to reconnect and leaves controls available', async () => {
	respond(async (url) => {
		expect(String(url)).toBe(`/api/connections/${connected.id}/custom-mcp/refresh`);
		return Response.json({error: 'credentials_rejected'}, {status: 422});
	});
	renderTools();
	fireEvent.click(screen.getByRole('button', {name: 'Refresh tools'}));
	expect((await screen.findByRole('alert')).textContent).toContain('Reconnect OAuth to continue');
	expect(screen.getByRole('button', {name: 'Reconnect OAuth'})).toHaveProperty('disabled', false);
	expect(agentErrorMessage({kind: 'http', url: '', status: 422, body: {}})).toContain('reconnect');
});

test('non-OAuth connections do not offer OAuth reconnect or expose credentials', () => {
	renderTools({
		...connected,
		customMcp: {...connected.customMcp!, authType: 'bearer', oauth: undefined},
	});
	expect(screen.queryByRole('button', {name: 'Reconnect OAuth'})).toBeNull();
	expect(screen.getByRole('button', {name: 'Refresh tools'})).toBeTruthy();
});

test.each([
	'/connections/new/custom-mcp?oauth=failed',
	'/welcome/connections/custom-mcp?oauth=failed',
])('callback failure at %s explains retry without raw provider data', async (path) => {
	renderPage(path);
	expect((await screen.findByRole('alert')).textContent).toContain(
		'OAuth sign-in was not completed',
	);
	expect(screen.getByRole('button', {name: 'Continue with OAuth'})).toBeTruthy();
});

test('successful reconnect callback says permissions must be granted again', async () => {
	renderPage('/connections/custom-1?oauth=connected');
	expect((await screen.findByRole('status')).textContent).toContain('All tools are blocked');
	expect(screen.getByText(/Tools are blocked by default/)).toBeTruthy();
});

test('failed reconnect callback keeps the existing connection reconnectable', async () => {
	renderPage('/connections/custom-1?oauth=failed');
	expect((await screen.findByRole('alert')).textContent).toContain(
		'OAuth sign-in was not completed',
	);
	expect(screen.getByRole('button', {name: 'Reconnect OAuth'})).toBeTruthy();
});

const registration = {
	issuer: 'https://provider.example',
	redirectUri: 'https://app.example/api/connections/custom-mcp/oauth/callback/issuer-specific-key',
	registrationSupported: false,
	publicClientSupported: true,
};

test('callback discovery shows the exact issuer-bound URL without starting sign-in', async () => {
	respond(async (url, init) => {
		expect(String(url)).toBe('/api/connections/custom-mcp/oauth/discover');
		expect(init?.method).toBe('POST');
		expect(JSON.parse(String(init?.body))).toEqual({url: 'https://example.com/mcp'});
		return Response.json(registration);
	});
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.click(screen.getByRole('button', {name: 'Find callback URL'}));
	expect(await screen.findByLabelText('Callback URL')).toHaveProperty(
		'value',
		registration.redirectUri,
	);
	expect(screen.getByText(/Automatic registration is not advertised/)).toBeTruthy();
	expect(window.location.href).toBe('http://localhost/');
	fireEvent.change(screen.getByLabelText('HTTPS MCP server URL'), {
		target: {value: 'https://another.example/mcp'},
	});
	expect(screen.queryByLabelText('Callback URL')).toBeNull();
});

test('callback discovery blocks repeated clicks and ignores responses after the server changes', async () => {
	let resolveResponse: (response: Response) => void = () => {};
	let signal: AbortSignal | null | undefined;
	respond(async (_url, init) => {
		signal = init?.signal;
		return new Promise<Response>((resolve) => {
			resolveResponse = resolve;
		});
	});
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.click(screen.getByRole('button', {name: 'Find callback URL'}));
	fireEvent.click(screen.getByRole('button', {name: 'Finding callback URL…'}));
	expect(fetchSpy).toHaveBeenCalledTimes(1);
	fireEvent.change(screen.getByLabelText('HTTPS MCP server URL'), {
		target: {value: 'https://another.example/mcp'},
	});
	expect(signal?.aborted).toBe(true);
	await act(async () => {
		resolveResponse(Response.json(registration));
	});
	expect(screen.queryByLabelText('Callback URL')).toBeNull();
	expect(screen.getByRole('button', {name: 'Find callback URL'})).toHaveProperty('disabled', false);
});

test('reconnect callback discovery uses a connection ID and explains public-client limitations', async () => {
	respond(async (url, init) => {
		expect(String(url)).toBe('/api/connections/custom-mcp/oauth/discover');
		expect(JSON.parse(String(init?.body))).toEqual({connectionId: connected.id});
		return Response.json({
			...registration,
			registrationSupported: true,
			publicClientSupported: false,
		});
	});
	renderTools();
	fireEvent.click(screen.getByText('Use a different public client ID'));
	fireEvent.click(screen.getByRole('button', {name: 'Find callback URL'}));
	expect(await screen.findByLabelText('Callback URL')).toHaveProperty('readOnly', true);
	expect(screen.getByText(/does not support manually entered public clients/)).toBeTruthy();
});

test('callback discovery error stays retryable without exposing server details', async () => {
	respond(async () => Response.json({error: 'private-provider-details'}, {status: 502}));
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	fillServer();
	await chooseAuth('OAuth');
	fireEvent.click(screen.getByRole('button', {name: 'Find callback URL'}));
	expect((await screen.findByRole('alert')).textContent).toContain(
		'Could not discover the callback URL',
	);
	expect(screen.getByRole('button', {name: 'Find callback URL'})).toHaveProperty('disabled', false);
	expect(document.body.textContent).not.toContain('private-provider-details');
});

test.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173'])(
	'callback discovery accepts a local development callback on %s',
	async (origin) => {
		const redirectUri = `${origin}/api/connections/custom-mcp/oauth/callback/issuer-specific-key`;
		respond(async () => Response.json({...registration, redirectUri}));
		render(<ConnectCustomMcpForm onConnected={mock()} />);
		fillServer();
		await chooseAuth('OAuth');
		fireEvent.click(screen.getByRole('button', {name: 'Find callback URL'}));
		expect(await screen.findByLabelText('Callback URL')).toHaveProperty('value', redirectUri);
		expect(screen.queryByRole('alert')).toBeNull();
	},
);
