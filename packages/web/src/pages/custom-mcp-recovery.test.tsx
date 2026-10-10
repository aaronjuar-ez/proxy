/// <reference types="bun" />
import {afterAll, afterEach, expect, spyOn, test} from 'bun:test';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {ThemeProvider} from '@proxy/ui/components/theme-provider';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {HumanSide} from '@/components/human-side';
import {getConnection, listConnections} from '@/client/connections-client';
import {actionsFor} from '@/lib/access';
import type {AgentLogin, Connection} from '@/lib/types';
import {
	activityLoader,
	agentLoader,
	connectionLoader,
	connectionsLoader,
	welcomeLoader,
} from '@/loaders';
import {ConnectionPage} from '@/pages/connection-page';
import {ConnectionsPage} from '@/pages/connections-page';
import {AgentPage} from '@/pages/agent-page';

const broken: Connection = {
	id: 'broken',
	integrationId: 'custom-mcp',
	account: 'Broken server',
	defaults: ['tool-v1'],
};
const healthy: Connection = {
	id: 'healthy',
	integrationId: 'custom-mcp',
	account: 'Healthy server',
	defaults: [],
};
const email: Connection = {
	id: 'email',
	integrationId: 'email',
	account: 'person@example.com',
	defaults: ['read'],
};
const metadata = {
	url: 'https://example.com/mcp',
	tools: [{name: 'search', actionId: 'tool-v1', inputSchema: {type: 'object'}}],
};
const agent: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Agent',
	username: 'agent',
	createdAt: '2026-10-10T00:00:00.000Z',
	lastActiveAt: null,
	revokedAt: null,
	grants: [broken, healthy].map((connection) => ({
		connectionId: connection.id,
		actionId: 'tool-v1',
		allowed: true,
	})),
};
const me = {
	user: {id: 'user-1', email: 'person@example.com', name: null, image: null},
	onboarded: false,
};
const originalFetch = globalThis.fetch;
const fetchSpy = spyOn(globalThis, 'fetch');
afterAll(() => fetchSpy.mockRestore());
afterEach(() => {
	cleanup();
	fetchSpy.mockReset();
});

function mockApi(
	failure: () => Response = () => Response.json({error: 'Credential unavailable'}, {status: 500}),
) {
	const deletes: string[] = [];
	fetchSpy.mockImplementation(
		Object.assign(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				if (init?.method === 'DELETE') {
					deletes.push(path);
					return new Response(null, {status: 204});
				}
				if (path === '/api/connections/broken/custom-mcp') {
					return failure();
				}
				if (path === '/api/connections/healthy/custom-mcp') {
					return Response.json(metadata);
				}
				if (path === '/api/connections') {
					return Response.json({connections: [broken, healthy, email]});
				}
				if (path === '/api/connections/broken') {
					return Response.json({...broken, customMcp: metadata});
				}
				if (path === '/api/connections/missing') {
					return Response.json({}, {status: 404});
				}
				if (path === '/api/agents') {
					return Response.json({agents: [agent]});
				}
				if (path === '/api/agents/agent-1') {
					return Response.json(agent);
				}
				if (path === '/api/agents/agent-1/mcp-clients') {
					return Response.json({clients: []});
				}
				if (path.startsWith('/api/activity')) {
					return Response.json({entries: []});
				}
				if (path === '/api/me') {
					return Response.json(me);
				}
				throw new Error(`Unexpected request: ${path}`);
			},
			{preconnect: originalFetch.preconnect},
		),
	);
	return deletes;
}

function renderPage(path: string) {
	const router = createMemoryRouter(
		[
			{
				id: 'human',
				loader: () => ({...me, onboarded: true}),
				element: <HumanSide />,
				children: [
					{path: '/connections/:id', loader: connectionLoader, element: <ConnectionPage />},
					{path: '/connections', loader: connectionsLoader, element: <ConnectionsPage />},
					{path: '/agents/:id', loader: agentLoader, element: <AgentPage />},
				],
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
}

test('metadata failure is isolated to its connection; healthy custom and built-in permissions survive', async () => {
	mockApi();
	const result = (await listConnections()).unwrap();
	expect(result.connections).toHaveLength(3);
	expect(result.connections[0]).toEqual({
		...broken,
		customMcp: undefined,
		customMcpUnavailable: true,
	});
	expect(result.connections[1]).toEqual({...healthy, customMcp: metadata});
	expect(result.connections[2]).toEqual(email);
	expect(actionsFor(agent, result.connections[0]!)).toEqual([]);
	expect(actionsFor(agent, result.connections[1]!)).toEqual(['tool-v1']);
	expect(actionsFor(agent, result.connections[2]!)).toEqual(['read']);
	const detail = (await getConnection('broken')).unwrap();
	expect(detail.customMcp).toBeUndefined();
	expect(detail.customMcpUnavailable).toBe(true);
});

test('list, agent, activity and onboarding loaders remain available with failed metadata', async () => {
	mockApi();
	const results = await Promise.all([
		connectionsLoader(),
		agentLoader({params: {id: agent.id}}),
		activityLoader({request: new Request('https://app.example.com/activity')}),
		welcomeLoader(),
	]);
	for (const result of results) {
		expect(result.connections).toHaveLength(3);
		expect(result.connections[0]?.customMcpUnavailable).toBe(true);
	}
});

test('malformed metadata is unavailable but missing base connections and expired sessions still fail', async () => {
	mockApi(() => Response.json({tools: 'invalid'}));
	expect((await getConnection('broken')).unwrap().customMcpUnavailable).toBe(true);
	expect((await getConnection('missing')).isErr()).toBe(true);
	mockApi(() => Response.json({}, {status: 401}));
	expect((await listConnections()).isErr()).toBe(true);
	expect((await getConnection('broken')).isErr()).toBe(true);
});

test('failed detail explains unavailable permissions, permits retry and can disconnect', async () => {
	const deletes = mockApi();
	renderPage('/connections/broken');
	expect(await screen.findByRole('alert')).toHaveProperty(
		'textContent',
		expect.stringContaining('Existing grants are unchanged'),
	);
	expect(screen.getByRole('button', {name: 'Retry loading tools'})).toBeTruthy();
	expect(screen.queryByText('No agent can reach this connection.')).toBeNull();
	fireEvent.click(screen.getByRole('button', {name: 'Disconnect'}));
	const dialog = await screen.findByRole('dialog');
	fireEvent.click(within(dialog).getByRole('button', {name: 'Disconnect'}));
	await screen.findByRole('button', {name: 'Add connection'});
	expect(deletes).toEqual(['/api/connections/broken']);
});

test('retry recovers metadata without reconnecting or altering grants', async () => {
	let recovered = false;
	mockApi(() => (recovered ? Response.json(metadata) : Response.json({}, {status: 500})));
	renderPage('/connections/broken');
	const retry = await screen.findByRole('button', {name: 'Retry loading tools'});
	recovered = true;
	fireEvent.click(retry);
	expect(await screen.findByRole('button', {name: 'Refresh tools'})).toBeTruthy();
	expect(screen.queryByRole('alert')).toBeNull();
	expect(screen.getByText('Input schema')).toBeTruthy();
});

test('agent keeps unavailable connection visible and never presents grants as editable', async () => {
	mockApi();
	renderPage('/agents/agent-1');
	const unavailable = await screen.findByRole('button', {
		name: /Broken server.*Permissions unavailable/,
	});
	fireEvent.click(unavailable);
	expect(screen.getByRole('alert').textContent).toContain(
		'Permissions cannot be viewed or changed',
	);
	expect(screen.getByRole('link', {name: 'Manage connection'}).getAttribute('href')).toBe(
		'/connections/broken',
	);
	expect(screen.getAllByRole('checkbox')).toHaveLength(1); // Only the Changed only filter.
	expect(screen.getByRole('button', {name: /Healthy server.*1 tools allowed/})).toBeTruthy();
});

test('connection list keeps the broken row linked and distinguishes unavailable from zero access', async () => {
	mockApi();
	renderPage('/connections');
	const account = await screen.findByText('Broken server');
	const row = account.closest('a');
	expect(row?.getAttribute('href')).toBe('/connections/broken');
	expect(row?.textContent).toContain('Unavailable');
	expect(screen.getByText('Healthy server')).toBeTruthy();
	expect(screen.getAllByText('person@example.com').length).toBeGreaterThan(0);
});

test('network errors isolate metadata and base list errors still propagate', async () => {
	mockApi(() => {
		throw new Error('Network unavailable');
	});
	expect((await listConnections()).unwrap().connections[0]?.customMcpUnavailable).toBe(true);
	fetchSpy.mockImplementation(
		Object.assign(async () => Response.json({}, {status: 500}), {
			preconnect: originalFetch.preconnect,
		}),
	);
	expect((await listConnections()).isErr()).toBe(true);
});
