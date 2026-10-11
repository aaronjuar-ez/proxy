-- Serialize upstream OAuth refreshes across instances. An abandoned lease requires reconnect;
-- automatically retrying its old refresh token could revoke a rotated token family.
ALTER TABLE "Connection"
    ADD COLUMN "customMcpRefreshLeaseId" TEXT,
    ADD COLUMN "customMcpRefreshLeaseExpiresAt" TIMESTAMP(3);

CREATE TABLE "CustomMcpOAuthAttempt" (
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomMcpOAuthAttempt_pkey" PRIMARY KEY ("stateHash")
);

CREATE INDEX "CustomMcpOAuthAttempt_userId_idx" ON "CustomMcpOAuthAttempt"("userId");
CREATE INDEX "CustomMcpOAuthAttempt_orgId_idx" ON "CustomMcpOAuthAttempt"("orgId");
CREATE INDEX "CustomMcpOAuthAttempt_expiresAt_idx" ON "CustomMcpOAuthAttempt"("expiresAt");
