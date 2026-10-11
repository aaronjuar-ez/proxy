import {useEffect, useRef, useState} from 'react';
import {
	discoverCustomMcpOAuth,
	type DiscoverCustomMcpOAuthInput,
} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {describeFetchError} from '@/lib/loader-utils';

type Registration = {
	issuer: string;
	redirectUri: string;
	registrationSupported: boolean;
	publicClientSupported: boolean;
};

// Key this component by its server URL/connection ID to discard discovery when that changes.
export function CustomMcpOAuthRegistration({
	target,
	disabled,
}: {
	target: DiscoverCustomMcpOAuthInput;
	disabled: boolean;
}) {
	const request = useRef<AbortController | null>(null);
	const [pending, setPending] = useState(false);
	const [registration, setRegistration] = useState<Registration | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => () => request.current?.abort(), []);
	return (
		<div className="grid gap-2">
			<Button
				type="button"
				variant="outline"
				className="justify-self-start"
				disabled={disabled || pending || ('url' in target && !target.url.startsWith('https://'))}
				onClick={async () => {
					if (request.current) {
						return;
					}
					const controller = new AbortController();
					request.current = controller;
					setPending(true);
					setError(null);
					setRegistration(null);
					const result = await discoverCustomMcpOAuth(target, controller.signal);
					if (controller.signal.aborted) {
						return;
					}
					request.current = null;
					setPending(false);
					if (result.isErr()) {
						setError(
							result.error.kind === 'http' && result.error.status === 401
								? describeFetchError(result.error)
								: 'Could not discover the callback URL. Check the server URL and its OAuth support, then try again.',
						);
						return;
					}
					setRegistration(result.value);
				}}
			>
				{pending ? 'Finding callback URL…' : 'Find callback URL'}
			</Button>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{registration && (
				<div className="grid gap-2 text-sm">
					<p className="break-all text-muted-foreground">Provider: {registration.issuer}</p>
					<Label htmlFor="mcp-oauth-callback">Callback URL</Label>
					<Input id="mcp-oauth-callback" value={registration.redirectUri} readOnly />
					<p className="text-muted-foreground">
						Register this exact callback URL with the provider when setting up a public client.
					</p>
					{!registration.registrationSupported && (
						<p className="text-muted-foreground">
							Automatic registration is not advertised by this provider.
						</p>
					)}
					{!registration.publicClientSupported && (
						<p className="text-muted-foreground">
							This provider does not support manually entered public clients. Use automatic
							registration if available.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
