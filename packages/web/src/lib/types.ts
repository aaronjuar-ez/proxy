import type {z} from 'zod';
import type {
	agentSchema,
	auditEntrySchema,
	connectionSchema,
	dataRecordSchema,
} from '@/client/schemas';

export type Connection = z.infer<typeof connectionSchema> & {
	// Local enrichment failed; never interpret missing tool metadata as a grant decision.
	customMcpUnavailable?: boolean;
};
export type AgentLogin = z.infer<typeof agentSchema>;
export type DataRecord = z.infer<typeof dataRecordSchema>;
export type AuditEntry = z.infer<typeof auditEntrySchema>;
