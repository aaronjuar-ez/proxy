import {describe, expect, test} from 'bun:test';

import {integrationOf} from './integrations';

describe('integrationOf', () => {
	test('uses the Personal Agent Proxy mark for a custom MCP connection', () => {
		expect(integrationOf({integrationId: 'mcp', tools: []})?.logo).toEqual({
			src: '/favicon.svg',
		});
	});
});
