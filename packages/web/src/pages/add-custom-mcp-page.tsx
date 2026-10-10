import {useNavigate} from 'react-router';
import {AppShell, PageTitle} from '@/components/app-shell';
import {BackButton} from '@/components/back-button';
import {ConnectCustomMcpForm} from '@/components/connect-custom-mcp-form';
export function AddCustomMcpPage() {
	const navigate = useNavigate();
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
				onConnected={(connection) => navigate(`/connections/${connection.id}?added`)}
			/>
		</AppShell>
	);
}
