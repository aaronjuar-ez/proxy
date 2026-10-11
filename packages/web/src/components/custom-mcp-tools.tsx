import {useEffect, useRef, useState} from 'react';
import {useRevalidator} from 'react-router';
import {refreshCustomMcp} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Badge} from '@proxy/ui/components/badge';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {CUSTOM_MCP_OAUTH_FAILED, useCustomMcpOAuth} from '@/hooks/use-custom-mcp-oauth';
import {CustomMcpOAuthRegistration} from '@/components/custom-mcp-oauth-registration';
import {describeFetchError} from '@/lib/loader-utils';
import type {Connection} from '@/lib/types';

export function CustomMcpTools({
	connection,
	oauthFailed = false,
}: {
	connection: Connection;
	oauthFailed?: boolean;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const revalidator = useRevalidator();
	const request = useRef<AbortController | null>(null);
	const [clientId, setClientId] = useState('');
	const [oauthAttempted, setOauthAttempted] = useState(false);
	const oauth = useCustomMcpOAuth();
	const usesOAuth = connection.customMcp?.authType === 'oauth';
	const oauthError =
		oauth.error ?? (!oauthAttempted && oauthFailed ? CUSTOM_MCP_OAUTH_FAILED : null);
	useEffect(() => () => request.current?.abort(), []);
	if (connection.customMcpUnavailable) {
		return (
			<div className="grid gap-4 text-sm">
				<CustomMcpUnavailable />
				<Button
					variant="outline"
					className="justify-self-start"
					disabled={revalidator.state === 'loading'}
					onClick={() => void revalidator.revalidate()}
				>
					Retry loading tools
				</Button>
			</div>
		);
	}
	return (
		<div className="grid gap-4 text-sm">
			<p className="break-all text-muted-foreground">{connection.customMcp?.url}</p>
			<p className="text-muted-foreground">
				Tools are blocked by default. Open an agent’s page to grant individual tools. Server
				descriptions and read-only claims are untrusted; every tool is treated as high risk.
			</p>
			{usesOAuth && (
				<form
					className="grid gap-3 rounded-lg border p-3"
					aria-busy={oauth.pending}
					onSubmit={async (event) => {
						event.preventDefault();
						if (pending) {
							return;
						}
						setOauthAttempted(true);
						await oauth.start({
							connectionId: connection.id,
							...(clientId.trim() ? {clientId: clientId.trim()} : {}),
						});
					}}
				>
					<p className="font-medium">OAuth authentication</p>
					<p className="text-muted-foreground">
						If authorization expires or is revoked, reconnect with your provider. Provider or
						administrator approval may be required. Reconnecting removes all agent grants; review
						and grant tools again afterward.
					</p>
					<details>
						<summary className="cursor-pointer text-muted-foreground">
							Use a different public client ID
						</summary>
						<div className="mt-3 grid gap-2">
							<Label htmlFor="mcp-reconnect-client-id">Public client ID (optional)</Label>
							<Input
								id="mcp-reconnect-client-id"
								maxLength={2048}
								autoComplete="off"
								value={clientId}
								onChange={(event) => setClientId(event.target.value)}
								disabled={pending || oauth.pending}
							/>
							<p className="text-muted-foreground">
								Leave blank for automatic registration where available; otherwise the current
								registration is reused. Do not enter a client secret here.
							</p>
							<CustomMcpOAuthRegistration
								key={connection.id}
								target={{connectionId: connection.id}}
								disabled={pending || oauth.pending}
							/>
						</div>
					</details>
					<Button
						type="submit"
						variant="outline"
						className="justify-self-start"
						disabled={pending || oauth.pending}
					>
						{oauth.pending ? 'Opening sign-in…' : 'Reconnect OAuth'}
					</Button>
					{oauthError && (
						<p role="alert" className="text-destructive">
							{oauthError}
						</p>
					)}
				</form>
			)}
			<p className="text-muted-foreground">
				Refreshing discovers added or changed tools. Changed tools lose their previous grants and
				must be approved again.
			</p>
			<Button
				variant="outline"
				className="justify-self-start"
				disabled={pending || oauth.pending}
				onClick={async () => {
					if (request.current || oauth.pending) {
						return;
					}
					const controller = new AbortController();
					request.current = controller;
					setPending(true);
					setError(null);
					const result = await refreshCustomMcp(connection.id, controller.signal);
					if (controller.signal.aborted) {
						return;
					}
					if (result.isErr()) {
						request.current = null;
						setError(
							usesOAuth && result.error.kind === 'http' && result.error.status === 422
								? 'OAuth authorization has expired or was rejected. Reconnect OAuth to continue, then grant tools again.'
								: describeFetchError(result.error),
						);
						setPending(false);
						return;
					}
					await revalidator.revalidate();
					if (controller.signal.aborted) {
						return;
					}
					request.current = null;
					setPending(false);
				}}
			>
				{pending ? 'Refreshing…' : 'Refresh tools'}
			</Button>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{connection.customMcp?.tools.length === 0 && (
				<p className="text-muted-foreground">This server exposes no tools.</p>
			)}
			{connection.customMcp?.tools.map((tool) => (
				<details key={tool.actionId} className="rounded-lg border p-3">
					<summary className="cursor-pointer">
						{tool.title ?? tool.name} <Badge variant="destructive">High risk</Badge>
					</summary>
					<p className="mt-2 break-all">{tool.name}</p>
					<p className="mt-2 whitespace-pre-wrap text-muted-foreground">
						{tool.description ?? 'No description supplied.'}
					</p>
					<p className="mt-3">Input schema</p>
					<pre className="overflow-auto rounded bg-muted p-2">
						{JSON.stringify(tool.inputSchema, null, 2)}
					</pre>
					{tool.outputSchema && (
						<>
							<p className="mt-3">Output schema</p>
							<pre className="overflow-auto rounded bg-muted p-2">
								{JSON.stringify(tool.outputSchema, null, 2)}
							</pre>
						</>
					)}
				</details>
			))}
		</div>
	);
}

export function CustomMcpUnavailable() {
	return (
		<p role="alert" className="text-sm text-destructive">
			Tool metadata could not be loaded. Permissions cannot be viewed or changed here until it
			loads. Existing grants are unchanged. Retry, or disconnect this connection and add it again.
		</p>
	);
}
