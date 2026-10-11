import {useEffect, useRef, useState} from 'react';
import {connectCustomMcp} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@proxy/ui/components/select';
import {useCustomMcpOAuth} from '@/hooks/use-custom-mcp-oauth';
import {CustomMcpOAuthRegistration} from '@/components/custom-mcp-oauth-registration';
import {describeFetchError} from '@/lib/loader-utils';
import type {Connection} from '@/lib/types';

type AuthType = 'none' | 'bearer' | 'oauth';
const AUTH_ITEMS = [
	{value: 'none', label: 'No authentication'},
	{value: 'bearer', label: 'Bearer token'},
	{value: 'oauth', label: 'OAuth'},
];

export function ConnectCustomMcpForm({
	onConnected,
	returnTo,
	initialError,
}: {
	onConnected: (connection: Connection) => void;
	returnTo?: 'welcome';
	initialError?: string;
}) {
	const [account, setAccount] = useState('');
	const [url, setUrl] = useState('');
	const [authType, setAuthType] = useState<AuthType>(initialError ? 'oauth' : 'none');
	const [bearerToken, setBearerToken] = useState('');
	const [clientId, setClientId] = useState('');
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempted, setAttempted] = useState(false);
	const request = useRef<AbortController | null>(null);
	const oauth = useCustomMcpOAuth();
	const pending = connecting || oauth.pending;
	const visibleError =
		error ?? (authType === 'oauth' ? oauth.error : null) ?? (!attempted ? initialError : null);
	useEffect(() => () => request.current?.abort(), []);

	return (
		<form
			className="grid gap-4"
			aria-busy={pending}
			onSubmit={async (event) => {
				event.preventDefault();
				if (
					request.current ||
					pending ||
					!account.trim() ||
					!url.trim() ||
					(authType === 'bearer' && !bearerToken)
				) {
					return;
				}
				setAttempted(true);
				setError(null);
				if (authType === 'oauth') {
					await oauth.start({
						account: account.trim(),
						url: url.trim(),
						...(clientId.trim() ? {clientId: clientId.trim()} : {}),
						...(returnTo ? {returnTo} : {}),
					});
					return;
				}
				const controller = new AbortController();
				request.current = controller;
				setConnecting(true);
				const response = connectCustomMcp(
					{
						account: account.trim(),
						url: url.trim(),
						...(authType === 'bearer' ? {bearerToken} : {}),
					},
					controller.signal,
				);
				setBearerToken('');
				const result = await response;
				if (controller.signal.aborted) {
					return;
				}
				request.current = null;
				setConnecting(false);
				if (result.isErr()) {
					setError(describeFetchError(result.error));
					return;
				}
				onConnected(result.value);
			}}
		>
			<div className="grid gap-2">
				<Label htmlFor="mcp-account">Connection name</Label>
				<Input
					id="mcp-account"
					value={account}
					onChange={(event) => setAccount(event.target.value)}
					required
					maxLength={200}
					disabled={pending}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="mcp-url">HTTPS MCP server URL</Label>
				<Input
					id="mcp-url"
					maxLength={2048}
					type="url"
					placeholder="https://example.com/mcp"
					pattern="https://.*"
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					required
					disabled={pending}
				/>
			</div>
			<div className="grid gap-2">
				<Label htmlFor="mcp-auth">Authentication</Label>
				<Select
					value={authType}
					items={AUTH_ITEMS}
					disabled={pending}
					onValueChange={(value) => {
						if (value !== 'none' && value !== 'bearer' && value !== 'oauth') {
							return;
						}
						setAuthType(value);
						setBearerToken('');
						setError(null);
					}}
				>
					<SelectTrigger id="mcp-auth" className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent alignItemWithTrigger={false}>
						{AUTH_ITEMS.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{authType === 'bearer' && (
				<div className="grid gap-2">
					<Label htmlFor="mcp-token">Bearer token</Label>
					<Input
						id="mcp-token"
						type="password"
						autoComplete="new-password"
						value={bearerToken}
						onChange={(event) => setBearerToken(event.target.value)}
						required
						disabled={pending}
					/>
					<p className="text-sm text-muted-foreground">
						Connecting sends this token to the server URL above.
					</p>
				</div>
			)}
			{authType === 'oauth' && (
				<div className="grid gap-2">
					<Label htmlFor="mcp-client-id">Public client ID (optional)</Label>
					<Input
						id="mcp-client-id"
						maxLength={2048}
						autoComplete="off"
						value={clientId}
						onChange={(event) => setClientId(event.target.value)}
						disabled={pending}
					/>
					<p className="text-sm text-muted-foreground">
						You’ll continue to the server’s provider to approve access. Provider or administrator
						approval may be required. Leave this blank for automatic registration where supported,
						or enter a pre-registered public client ID. Do not enter a client secret here.
					</p>
					<CustomMcpOAuthRegistration
						key={url.trim()}
						target={{url: url.trim()}}
						disabled={pending}
					/>
				</div>
			)}
			<p className="text-sm text-muted-foreground">
				Use a public HTTPS hostname on port 443 with no query string or URL credentials. Never put
				tokens in the URL. Only connect servers you trust. Tools can change data or contact others;
				every tool is blocked until you grant it to an individual agent.
			</p>
			{visibleError && (
				<p role="alert" className="text-sm text-destructive">
					{visibleError}
				</p>
			)}
			<Button type="submit" className="justify-self-start" disabled={pending}>
				{pending
					? authType === 'oauth'
						? 'Opening sign-in…'
						: 'Connecting…'
					: authType === 'oauth'
						? 'Continue with OAuth'
						: 'Connect and discover tools'}
			</Button>
		</form>
	);
}
