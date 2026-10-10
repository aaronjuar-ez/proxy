/// <reference types="bun" />
import {afterEach, describe, expect, mock, test} from 'bun:test';
import {cleanup, fireEvent, render, screen} from '@testing-library/react';
import {TooltipProvider} from '@proxy/ui/components/tooltip';
import {AuditList} from '@/components/audit-list';
import {ConnectionAccess} from '@/components/connection-access';
import {ConnectCustomMcpForm} from '@/components/connect-custom-mcp-form';
import {actionsFor, defaultActions, integrationOf} from '@/lib/access';
import type {AgentLogin, AuditEntry, Connection} from '@/lib/types';

afterEach(cleanup);

const connection: Connection = {
	id: 'custom-1',
	integrationId: 'custom-mcp',
	account: 'Example server',
	defaults: ['tool-v1'],
	customMcp: {
		url: 'https://example.com/mcp',
		tools: [
			{
				name: 'search',
				description: 'Search documents',
				actionId: 'tool-v2',
				inputSchema: {type: 'object'},
				annotations: {readOnlyHint: true},
			},
		],
	},
};
const agent: AgentLogin = {
	id: 'agent-1',
	providerId: 'claude',
	name: 'Agent',
	username: 'agent',
	createdAt: '',
	lastActiveAt: null,
	revokedAt: null,
	grants: [],
};

describe('custom MCP permissions', () => {
	test('ignores defaults and upstream read-only hints', () => {
		expect(defaultActions(connection)).toEqual([]);
		expect(actionsFor(agent, connection)).toEqual([]);
		expect(integrationOf(connection)?.actions[0]?.risk).toBe('high');
	});
	test('only an explicit grant for the current schema permits a tool', () => {
		expect(
			actionsFor(
				{...agent, grants: [{connectionId: connection.id, actionId: 'tool-v1', allowed: true}]},
				connection,
			),
		).toEqual([]);
		expect(
			actionsFor(
				{...agent, grants: [{connectionId: connection.id, actionId: 'tool-v2', allowed: true}]},
				connection,
			),
		).toEqual(['tool-v2']);
	});
	test('offers explicit toggles without make-default controls', () => {
		const onChange = mock();
		render(
			<TooltipProvider>
				<ConnectionAccess
					explicitOnly
					actions={integrationOf(connection)?.actions ?? []}
					defaults={['tool-v2']}
					own={{}}
					onChange={onChange}
					onMakeDefault={mock()}
				/>
			</TooltipProvider>,
		);
		expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
		fireEvent.click(screen.getByRole('checkbox'));
		expect(onChange).toHaveBeenCalledWith({'tool-v2': true});
		expect(
			screen.queryByRole('button', {name: 'Make this the default for every agent'}),
		).toBeNull();
	});
	test('revoking access restores the denied state', () => {
		const onChange = mock();
		render(
			<TooltipProvider>
				<ConnectionAccess
					explicitOnly
					actions={integrationOf(connection)?.actions ?? []}
					defaults={[]}
					own={{'tool-v2': true}}
					onChange={onChange}
					onMakeDefault={mock()}
				/>
			</TooltipProvider>,
		);
		fireEvent.click(screen.getByRole('checkbox'));
		expect(onChange).toHaveBeenCalledWith({'tool-v2': null});
		expect(
			screen.queryByRole('button', {name: 'Make this the default for every agent'}),
		).toBeNull();
	});
});

test('custom connection form masks credentials and explains the destination and grant policy', () => {
	render(<ConnectCustomMcpForm onConnected={mock()} />);
	expect(screen.getByLabelText('Bearer token (optional)').getAttribute('type')).toBe('password');
	expect(screen.getByLabelText('HTTPS MCP server URL').getAttribute('pattern')).toBe('https://.*');
	expect(screen.getByText(/Connecting sends this token to the server URL above/)).toBeTruthy();
	expect(
		screen.getByText(/every tool is blocked until you grant it to an individual agent/),
	).toBeTruthy();
});

const toolEntry: AuditEntry = {
	id: 'entry-1',
	at: '2026-10-10T19:00:00.000Z',
	agentId: agent.id,
	connectionId: connection.id,
	collectionId: 'tools',
	action: 'search',
	recordTitle: null,
	query: null,
	outcome: 'allowed',
	via: 'mcp',
};
test('custom audit rows retain connection names and show authorized attempts, not success', () => {
	render(
		<AuditList
			entries={[toolEntry, {...toolEntry, id: 'entry-2', outcome: 'denied'}]}
			agents={[agent]}
			connections={[connection]}
		/>,
	);
	expect(screen.getAllByText('Example server')).toHaveLength(2);
	expect(screen.queryByText('Disconnected')).toBeNull();
	expect(screen.getByText('Authorized tool call: search')).toBeTruthy();
	expect(screen.getByText('Denied tool call: search')).toBeTruthy();
});
test('disconnected custom audit rows keep the tool name and authorization outcome', () => {
	render(<AuditList entries={[toolEntry]} agents={[agent]} connections={[]} />);
	expect(screen.getByText('Disconnected')).toBeTruthy();
	expect(screen.getByText('Authorized tool call: search')).toBeTruthy();
});
