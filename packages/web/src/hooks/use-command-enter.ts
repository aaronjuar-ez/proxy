import {useEffect, useRef} from 'react';

function isCommandEnter(event: KeyboardEvent): boolean {
	return (
		event.key === 'Enter' &&
		(event.metaKey || event.ctrlKey) &&
		!event.altKey &&
		!event.repeat &&
		!event.isComposing &&
		!event.defaultPrevented
	);
}

export function useCommandEnter(action: () => void, enabled = true) {
	useEffect(() => {
		if (!enabled) {
			return;
		}

		const run = (event: KeyboardEvent) => {
			if (!isCommandEnter(event)) {
				return;
			}

			event.preventDefault();
			action();
		};
		window.addEventListener('keydown', run);
		return () => window.removeEventListener('keydown', run);
	}, [action, enabled]);
}

export function useCommandEnterSubmit(enabled = true) {
	const form = useRef<HTMLFormElement>(null);
	useCommandEnter(() => form.current?.requestSubmit(), enabled);
	return form;
}
