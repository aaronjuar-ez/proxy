import {useState} from 'react';
import {useRevalidator} from 'react-router';
import {refreshCustomMcp} from '@/client/connections-client';
import {Button} from '@proxy/ui/components/button';
import {Badge} from '@proxy/ui/components/badge';
import {describeFetchError} from '@/lib/loader-utils';
import type {Connection} from '@/lib/types';

export function CustomMcpTools({connection}: {connection: Connection}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const revalidator = useRevalidator();
	return (
		<div className="grid gap-4 text-sm">
			<p className="break-all text-muted-foreground">{connection.customMcp?.url}</p>
			<p className="text-muted-foreground">
				Tools are blocked by default. Open an agent’s page to grant individual tools. Server
				descriptions and read-only claims are untrusted; every tool is treated as high risk.
			</p>
			<p className="text-muted-foreground">
				Refreshing discovers added or changed tools. Changed tools lose their previous grants and
				must be approved again.
			</p>
			<Button
				variant="outline"
				className="justify-self-start"
				disabled={pending}
				onClick={async () => {
					setPending(true);
					setError(null);
					const result = await refreshCustomMcp(connection.id);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						setPending(false);
						return;
					}
					await revalidator.revalidate();
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
