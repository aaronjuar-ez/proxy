import {describe, expect, test} from 'bun:test';

describe('shared styles', () => {
	test('shows the pointer cursor for every enabled native button', async () => {
		const styles = await Bun.file(new URL('./styles.css', import.meta.url)).text();

		expect(styles).toMatch(/button:not\(:disabled\)\s*{\s*@apply cursor-pointer;\s*}/);
	});
});
