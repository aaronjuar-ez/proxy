import {describe, expect, test} from 'bun:test';

import {INTEGRATIONS} from './catalog';

describe('catalog', () => {
	test('lists high-risk actions last in every group of every integration, as every page shows them in this order', () => {
		for (const integration of INTEGRATIONS) {
			const groups = [...new Set(integration.actions.map((action) => action.group))];
			for (const group of groups) {
				const actions = integration.actions.filter((action) => action.group === group);
				const firstHigh = actions.findIndex((action) => action.risk === 'high');
				if (firstHigh === -1) {
					continue;
				}
				const after = actions.slice(firstHigh).map((action) => action.risk);
				expect(
					after,
					`${integration.id} has a lower-risk action after a high-risk one in ${group ?? 'its actions'}`,
				).toEqual(after.map(() => 'high'));
			}
		}
	});
});
