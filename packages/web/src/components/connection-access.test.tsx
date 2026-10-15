/// <reference types="bun" />

import {afterEach, describe, expect, mock, test} from 'bun:test';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react';
import {ConnectionAccess} from '@/components/connection-access';
import {findIntegration, type Action} from '@proxy/integrations';

afterEach(() => {
	cleanup();
});

const action: Action = {
	id: 'read',
	label: 'Read',
	description: 'Read records',
	risk: 'low',
};

function deferred() {
	let resolve = () => {};
	let reject = () => {};
	const promise = new Promise<void>((done, fail) => {
		resolve = () => done();
		reject = () => fail(new Error('Save failed'));
	});
	return {promise, reject, resolve};
}

describe('ConnectionAccess', () => {
	test('shows a change immediately while it is saved and keeps the refreshed value', async () => {
		const save = deferred();
		const changes: Array<Record<string, boolean | null>> = [];
		const view = render(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				onChange={(next) => {
					changes.push(next);
					return save.promise;
				}}
			/>,
		);
		const checkbox = screen.getByRole('checkbox', {name: /^Read/});

		fireEvent.click(checkbox);

		expect(checkbox.getAttribute('aria-checked')).toBe('false');
		await act(async () => Promise.resolve());
		expect(changes).toEqual([{read: false}]);

		view.rerender(
			<ConnectionAccess actions={[action]} defaults={[]} onChange={() => Promise.resolve()} />,
		);
		await act(async () => save.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('false');
	});

	test('returns to the stored value when a save does not change it', async () => {
		const save = deferred();
		render(
			<ConnectionAccess actions={[action]} defaults={['read']} onChange={() => save.promise} />,
		);
		const checkbox = screen.getByRole('checkbox', {name: /^Read/});

		fireEvent.click(checkbox);
		expect(checkbox.getAttribute('aria-checked')).toBe('false');

		await act(async () => save.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('true');
	});

	test('saves repeated changes to one action in click order', async () => {
		const firstSave = deferred();
		const secondSave = deferred();
		const changes: Array<Record<string, boolean | null>> = [];
		const view = render(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				onChange={(next) => {
					changes.push(next);
					return changes.length === 1 ? firstSave.promise : secondSave.promise;
				}}
			/>,
		);
		const checkbox = screen.getByRole('checkbox', {name: /^Read/});

		fireEvent.click(checkbox);
		await act(async () => Promise.resolve());
		fireEvent.click(checkbox);
		await act(async () => Promise.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('true');
		expect(changes).toEqual([{read: false}]);

		await act(async () => firstSave.resolve());
		expect(changes).toEqual([{read: false}, {read: true}]);

		view.rerender(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				onChange={() => Promise.resolve()}
			/>,
		);
		await act(async () => secondSave.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('true');
	});

	test('saves the latest repeated change after an earlier save fails', async () => {
		const firstSave = deferred();
		const changes: Array<Record<string, boolean | null>> = [];
		render(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				onChange={(next) => {
					changes.push(next);
					return changes.length === 1 ? firstSave.promise : Promise.resolve();
				}}
			/>,
		);
		const checkbox = screen.getByRole('checkbox', {name: /^Read/});

		fireEvent.click(checkbox);
		await act(async () => Promise.resolve());
		fireEvent.click(checkbox);
		await act(async () => Promise.resolve());

		await act(async () => firstSave.reject());

		expect(changes).toEqual([{read: false}, {read: true}]);
		expect(checkbox.getAttribute('aria-checked')).toBe('true');
	});

	test('preserves order between making a value the default and changing its checkbox', async () => {
		const makeDefault = deferred();
		const checkboxSave = deferred();
		const changes: Array<Record<string, boolean | null>> = [];
		const view = render(
			<ConnectionAccess
				actions={[action]}
				defaults={[]}
				own={{read: true}}
				onChange={(next) => {
					changes.push(next);
					return checkboxSave.promise;
				}}
				onMakeDefault={() => makeDefault.promise}
			/>,
		);
		const checkbox = screen.getByRole('checkbox', {name: /^Read/});

		fireEvent.click(screen.getByRole('button', {name: 'Make this the default for every agent'}));
		await act(async () => Promise.resolve());
		fireEvent.click(checkbox);
		await act(async () => Promise.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('false');
		expect(changes).toEqual([]);

		view.rerender(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				own={{}}
				onChange={(next) => {
					changes.push(next);
					return Promise.resolve();
				}}
				onMakeDefault={() => Promise.resolve()}
			/>,
		);
		await act(async () => makeDefault.resolve());

		expect(changes).toEqual([{read: false}]);
		expect(checkbox.getAttribute('aria-checked')).toBe('false');

		view.rerender(
			<ConnectionAccess
				actions={[action]}
				defaults={['read']}
				own={{read: false}}
				onChange={() => Promise.resolve()}
				onMakeDefault={() => Promise.resolve()}
			/>,
		);
		await act(async () => checkboxSave.resolve());

		expect(checkbox.getAttribute('aria-checked')).toBe('false');
	});

	test('queues a reset behind an unfinished checkbox save', async () => {
		const checkboxSave = deferred();
		const changes: Array<Record<string, boolean | null>> = [];
		render(
			<ConnectionAccess
				actions={[action]}
				defaults={[]}
				own={{read: true}}
				onChange={(next) => {
					changes.push(next);
					return changes.length === 1 ? checkboxSave.promise : Promise.resolve();
				}}
			/>,
		);

		fireEvent.click(screen.getByRole('checkbox', {name: /^Read/}));
		await act(async () => Promise.resolve());
		fireEvent.click(screen.getByRole('button', {name: 'Reset to default'}));
		await act(async () => Promise.resolve());

		expect(changes).toEqual([{read: null}]);

		await act(async () => checkboxSave.resolve());

		expect(changes).toEqual([{read: null}, {read: null}]);
	});
});

const actions = findIntegration('email')?.actions ?? [];

describe('ConnectionAccess with what the sign-in covered', () => {
	test("an action the sign-in didn't cover is off and disabled, saying how to allow it, whatever is ticked", () => {
		render(
			<ConnectionAccess
				actions={actions}
				defaults={['read', 'archive']}
				unavailable={['read']}
				onChange={mock()}
			/>,
		);

		const read = screen.getByRole('checkbox', {name: /^Read/});
		expect(read.getAttribute('aria-checked')).toBe('false');
		expect(read.hasAttribute('data-disabled')).toBe(true);
		expect(screen.getByText(/Not allowed at sign-in\. Sign in again to allow it\./)).toBeTruthy();

		const archive = screen.getByRole('checkbox', {name: /^Archive/});
		expect(archive.hasAttribute('data-disabled')).toBe(false);
	});

	test("an agent's own setting for an action the sign-in didn't cover can be reset, not made the default", () => {
		const onMakeDefault = mock();
		render(
			<ConnectionAccess
				actions={actions}
				defaults={[]}
				own={{read: true, archive: true}}
				unavailable={['read']}
				onChange={mock()}
				onMakeDefault={onMakeDefault}
			/>,
		);

		expect(
			screen.getAllByRole('button', {name: 'Make this the default for every agent'}),
		).toHaveLength(1);
		expect(screen.getAllByRole('button', {name: 'Reset to default'})).toHaveLength(2);
	});

	test('every action can be set when the sign-in covered them all', () => {
		render(<ConnectionAccess actions={actions} defaults={['read']} onChange={mock()} />);

		const read = screen.getByRole('checkbox', {name: /^Read/});
		expect(read.getAttribute('aria-checked')).toBe('true');
		expect(read.hasAttribute('data-disabled')).toBe(false);
		expect(screen.queryByText(/Not allowed at sign-in/)).toBeNull();
	});
});
