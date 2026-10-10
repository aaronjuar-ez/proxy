import {useState} from 'react';
import {connectCustomMcp} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {describeFetchError} from '@/lib/loader-utils';
import type {Connection} from '@/lib/types';

export function ConnectCustomMcpForm({
	onConnected,
}: {
	onConnected: (connection: Connection) => void;
}) {
	const [account, setAccount] = useState('');
	const [url, setUrl] = useState('');
	const [bearerToken, setBearerToken] = useState('');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<form
			className="grid gap-4"
			onSubmit={async (event) => {
				event.preventDefault();
				if (pending) {
					return;
				}
				setPending(true);
				setError(null);
				const result = await connectCustomMcp({
					account: account.trim(),
					url: url.trim(),
					...(bearerToken ? {bearerToken} : {}),
				});
				setPending(false);
				if (result.isErr()) {
					setError(describeFetchError(result.error));
					return;
				}
				setBearerToken('');
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
				<Label htmlFor="mcp-token">Bearer token (optional)</Label>
				<Input
					id="mcp-token"
					type="password"
					autoComplete="new-password"
					value={bearerToken}
					onChange={(event) => setBearerToken(event.target.value)}
					disabled={pending}
				/>
			</div>
			<p className="text-sm text-muted-foreground">
				Use a public HTTPS hostname on port 443 with no query string or URL credentials. Put
				authentication only in the bearer token field. Connecting sends this token to the server URL
				above. Only connect servers you trust. Tools can change data or contact others; every tool
				is blocked until you grant it to an individual agent.
			</p>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			<Button type="submit" className="justify-self-start" disabled={pending}>
				{pending ? 'Connecting…' : 'Connect and discover tools'}
			</Button>
		</form>
	);
}
