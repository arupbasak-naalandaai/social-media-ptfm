-- CreateIndex
CREATE INDEX "sync_state_organizationId_idx" ON "sync_state"("organizationId");

-- CreateIndex
CREATE INDEX "webhook_event_organizationId_receivedAt_idx" ON "webhook_event"("organizationId", "receivedAt" DESC);
