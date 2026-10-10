import {describe, expect, it} from 'bun:test';
import {fileURLToPath} from 'node:url';

const helper = fileURLToPath(new URL('../../../../scripts/hash-owner-password.mjs', import.meta.url));

describe('owner password helper', () => {
	it('refuses noninteractive input rather than accepting secrets through pipes', async () => {
		const child = Bun.spawn([process.execPath, helper], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'});
		child.stdin.end();
		expect(await child.exited).toBe(1);
		expect(await new Response(child.stdout).text()).toBe('');
		expect(await new Response(child.stderr).text()).toContain('interactive terminal');
	});

	it('does not accept or echo password arguments', async () => {
		const child = Bun.spawn([process.execPath, helper, 'synthetic-test-value'], {stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'});
		expect(await child.exited).toBe(1);
		const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
		expect(output).not.toContain('synthetic-test-value');
		expect(output).not.toContain('$argon2');
	});
});
