-- The provider's own id for a connection's account, which stays as its address changes: Google's
-- `sub`. Signing in again finds the connection by it, and a Google grant is kept while another
-- connection is for the same account. Connections from before it, and the integrations whose
-- providers give none, have none and go by their address.
ALTER TABLE "Connection" ADD COLUMN "providerAccountId" TEXT;

CREATE INDEX "Connection_integrationId_providerAccountId_idx" ON "Connection"("integrationId", "providerAccountId");
