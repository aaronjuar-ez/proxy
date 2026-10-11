import {useNavigate, useSearchParams} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectCustomMcpForm} from '@/components/connect-custom-mcp-form';
import {CUSTOM_MCP_OAUTH_FAILED} from '@/hooks/use-custom-mcp-oauth';
export function AddCustomMcpPage() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	return (
		<AppShell
			title={
				<>
					<BackButton to="/connections/new" label="Back to the catalog" />
					<PageTitle>Connect an MCP server</PageTitle>
				</>
			}
		>
			<ConnectCustomMcpForm
				initialError={params.get('oauth') === 'failed' ? CUSTOM_MCP_OAUTH_FAILED : undefined}
				onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
			/>
		</AppShell>
	);
}
