import {z} from 'zod';

// The api's response shapes, shared by the human side's and the agent side's clients.

export const customMcpToolSchema = z.object({
	name: z.string(),
	title: z.string().optional(),
	description: z.string().optional(),
	actionId: z.string(),
	inputSchema: z.record(z.string(), z.json()),
	outputSchema: z.record(z.string(), z.json()).optional(),
	annotations: z.record(z.string(), z.json()).optional(),
});
export const customMcpSchema = z.object({
	url: z.string(),
	tools: z.array(customMcpToolSchema),
	authType: z.enum(['none', 'bearer', 'oauth']),
	oauth: z.object({issuer: z.string(), clientId: z.string()}).optional(),
});

export const connectionSchema = z.object({
	id: z.string(),
	integrationId: z.string(),
	account: z.string(),
	// The actions agents get by default.
	defaults: z.array(z.string()),
	customMcp: customMcpSchema.optional(),
});

export const agentSchema = z.object({
	id: z.string(),
	providerId: z.string(),
	name: z.string(),
	username: z.string(),
	createdAt: z.string(),
	lastActiveAt: z.string().nullable(),
	revokedAt: z.string().nullable(),
	// The agent's own settings, one per action; every other action follows the default.
	grants: z.array(z.object({connectionId: z.string(), actionId: z.string(), allowed: z.boolean()})),
});

export const dataRecordSchema = z.object({
	id: z.string(),
	values: z.record(z.string(), z.string()),
	updatedAt: z.string(),
	// In a nested collection, whether it holds records of its own to list.
	hasChildren: z.boolean().optional(),
});

export const auditEntrySchema = z.object({
	id: z.string(),
	at: z.string(),
	agentId: z.string(),
	connectionId: z.string(),
	collectionId: z.string(),
	action: z.string(),
	recordTitle: z.string().nullable(),
	query: z.string().nullable(),
	outcome: z.enum(['allowed', 'denied']),
	// The web app's agent pages, or the MCP server.
	via: z.enum(['web', 'mcp']),
});
