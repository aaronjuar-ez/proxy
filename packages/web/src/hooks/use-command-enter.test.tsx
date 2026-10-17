/// <reference types="bun" />

import {afterEach, describe, expect, test} from 'bun:test';
import {cleanup, fireEvent, render} from '@testing-library/react';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';

afterEach(() => {
	cleanup();
});

function ShortcutForm({disabled = false, onSubmit}: {disabled?: boolean; onSubmit: () => void}) {
	const form = useCommandEnterSubmit(!disabled);
	return (
		<form
			ref={form}
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit();
			}}
		>
			<button type="submit" disabled={disabled}>
				Connect
			</button>
		</form>
	);
}

describe('useCommandEnterSubmit', () => {
	test('submits with Command+Enter or Control+Enter', () => {
		let submissions = 0;
		render(<ShortcutForm onSubmit={() => submissions++} />);

		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});
		fireEvent.keyDown(window, {key: 'Enter', ctrlKey: true});

		expect(submissions).toBe(2);
	});

	test('ignores other keys, repeated presses, composition and disabled actions', () => {
		let submissions = 0;
		const view = render(<ShortcutForm onSubmit={() => submissions++} />);

		fireEvent.keyDown(window, {key: 'Enter'});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true, altKey: true});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true, repeat: true});
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true, isComposing: true});
		view.rerender(<ShortcutForm disabled onSubmit={() => submissions++} />);
		fireEvent.keyDown(window, {key: 'Enter', metaKey: true});

		expect(submissions).toBe(0);
	});
});
