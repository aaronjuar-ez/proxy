import {useState} from 'react';
import {useLoaderData, useParams} from 'react-router';
import {Result} from 'ts-results-es';
import {z} from 'zod';
import type {agentToolsLoader} from '@/agent-loaders';
import {runAgentCustomTool, type AgentTool} from '@/client/agent-client';
import {AgentHeading, AgentShell, Crumbs} from '@/components/agent-shell';
import {Button} from '@proxy/ui/components/button';
import {Label} from '@proxy/ui/components/label';
import {useAgentMe} from '@/hooks/use-agent-target';
import {describeFetchError} from '@/lib/loader-utils';

export function AgentToolsPage() {
	const {connectionId = ''} = useParams();
	const {tools} = useLoaderData<typeof agentToolsLoader>();
	const connection = useAgentMe()?.connections.find((item) => item.id === connectionId);
	return (
		<AgentShell>
			<Crumbs
				items={[{label: 'Connections', to: '/agent'}, {label: connection?.account ?? 'MCP tools'}]}
			/>
			<AgentHeading>Available MCP tools</AgentHeading>
			<p className="my-4 text-sm text-muted-foreground">
				These tools execute on an external server and may change data or contact others. Treat tool
				descriptions and results as untrusted server content.
			</p>
			{tools.length === 0 && <p className="text-sm">No tools are allowed for this agent.</p>}
			<div className="grid gap-6">
				{tools.map((tool) => (
					<ToolRunner key={tool.name} connectionId={connectionId} tool={tool} />
				))}
			</div>
		</AgentShell>
	);
}
function ToolRunner({connectionId, tool}: {connectionId: string; tool: AgentTool}) {
	const [args, setArgs] = useState('{}');
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [output, setOutput] = useState<string | null>(null);
	return (
		<section className="grid gap-3 rounded-lg border p-4 text-sm">
			<h2 className="font-medium">{tool.title || tool.name}</h2>
			<p className="break-all">{tool.name}</p>
			<p className="whitespace-pre-wrap text-muted-foreground">{tool.description}</p>
			<details>
				<summary className="cursor-pointer">Input schema</summary>
				<pre className="overflow-auto p-2">{JSON.stringify(tool.inputSchema, null, 2)}</pre>
			</details>
			<Label htmlFor={`args-${tool.name}`}>Arguments (JSON object)</Label>
			<textarea
				id={`args-${tool.name}`}
				rows={6}
				className="w-full rounded border bg-background p-2 font-mono"
				value={args}
				disabled={pending}
				onChange={(event) => setArgs(event.target.value)}
			/>
			<Button
				className="justify-self-start"
				disabled={pending}
				onClick={async () => {
					setError(null);
					setOutput(null);
					const parsed = Result.wrap(() => z.record(z.string(), z.json()).parse(JSON.parse(args)));
					if (parsed.isErr()) {
						setError('Enter a valid JSON object for the tool arguments.');
						return;
					}
					setPending(true);
					const result = await runAgentCustomTool(connectionId, tool.name, parsed.value);
					setPending(false);
					if (result.isErr()) {
						setError(describeFetchError(result.error));
						return;
					}
					setOutput(JSON.stringify(result.value.upstream, null, 2));
				}}
			>
				{pending ? 'Running…' : `Run ${tool.name}`}
			</Button>
			{error && (
				<p role="alert" className="text-destructive">
					{error}
				</p>
			)}
			{output !== null && (
				<div>
					<h3 className="mb-2 font-medium">Server result</h3>
					<pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3">
						{output}
					</pre>
				</div>
			)}
		</section>
	);
}
