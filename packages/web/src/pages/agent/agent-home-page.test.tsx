/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, render, screen} from '@testing-library/react';
import {createMemoryRouter, RouterProvider} from 'react-router';
import {AgentSide} from '@/components/agent-side';
import {AgentHomePage} from '@/pages/agent/agent-home-page';

afterEach(() => {
	cleanup();
});

describe('AgentHomePage', () => {
	test('directs a login without access to the Connections page', async () => {
		const router = createMemoryRouter(
			[
				{
					id: 'agent',
					loader: () => ({
						agent: {id: 'agent-1', providerId: 'claude', name: 'Claude'},
						connections: [],
					}),
					element: <AgentSide />,
					children: [{path: '/agent', element: <AgentHomePage />}],
				},
			],
			{initialEntries: ['/agent']},
		);

		render(<RouterProvider router={router} />);

		expect(
			await screen.findByText(
				'No connections are available to this login yet. Ask the person who set it up to add a service on the Connections page, or give this login access to one already connected.',
			),
		).toBeDefined();
	});
});
