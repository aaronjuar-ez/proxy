-- The fork's custom MCP OAuth (v013_custom_mcp_oauth) was replaced by the upstream custom MCP
-- integration. Drop what it left behind on databases that applied it; a no-op elsewhere.
ALTER TABLE "Connection"
    DROP COLUMN IF EXISTS "customMcpRefreshLeaseId",
    DROP COLUMN IF EXISTS "customMcpRefreshLeaseExpiresAt";

DROP TABLE IF EXISTS "CustomMcpOAuthAttempt";
