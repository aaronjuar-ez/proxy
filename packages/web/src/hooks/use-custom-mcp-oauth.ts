import {useEffect, useRef, useState} from 'react';
import {startCustomMcpOAuth, type StartCustomMcpOAuthInput} from '@/client/connections-client';
import {describeFetchError} from '@/lib/loader-utils';

export const CUSTOM_MCP_OAUTH_FAILED =
	'OAuth sign-in was not completed. Try again. Your provider may require administrator approval or a pre-registered public client ID.';

export function useCustomMcpOAuth() {
	const request = useRef<AbortController | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		// Back from the provider may restore this page without remounting it.
		const resume = () => {
			request.current?.abort();
			request.current = null;
			setPending(false);
		};
		window.addEventListener('pageshow', resume);
		return () => {
			request.current?.abort();
			window.removeEventListener('pageshow', resume);
		};
	}, []);

	async function start(input: StartCustomMcpOAuthInput) {
		if (request.current) {
			return;
		}
		const controller = new AbortController();
		request.current = controller;
		setPending(true);
		setError(null);
		const result = await startCustomMcpOAuth(input, controller.signal);
		if (controller.signal.aborted) {
			return;
		}
		if (result.isErr()) {
			request.current = null;
			setPending(false);
			setError(
				result.error.kind === 'http' && result.error.status === 401
					? describeFetchError(result.error)
					: CUSTOM_MCP_OAUTH_FAILED,
			);
			return;
		}
		window.location.assign(result.value.authorizationUrl);
	}

	return {start, pending, error};
}
