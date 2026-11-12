-- AlterTable
ALTER TABLE "item" ADD COLUMN     "externalUrl" TEXT,
ADD COLUMN     "isFollowUp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "threadKey" TEXT;

-- CreateIndex
CREATE INDEX "item_organizationId_threadKey_idx" ON "item"("organizationId", "threadKey");

-- CreateIndex
CREATE INDEX "item_organizationId_isFollowUp_status_idx" ON "item"("organizationId", "isFollowUp", "status");

-- Backfill thread keys (same format as packages/pipeline/src/threads.ts threadKeyFor).
UPDATE "item" SET "threadKey" = CASE
  WHEN "conversationId" IS NOT NULL THEN 'c:' || "conversationId"
  WHEN "type" = 'comment' THEN 'p:' || "platformAccountId" || ':' || COALESCE("parentExternalId", "externalId")
  ELSE 'i:' || "platformAccountId" || ':' || "externalId"
END;

-- Backfill follow-ups: replies to our replies, and later items in threads we already engaged with.
UPDATE "item" AS i SET "isFollowUp" = true
WHERE i."isReplyToOurReply"
   OR EXISTS (
     SELECT 1 FROM "item" AS e
     WHERE e."organizationId" = i."organizationId"
       AND e."threadKey" = i."threadKey"
       AND e."id" <> i."id"
       AND e."status" IN ('replied', 'resolved')
       AND e."receivedAt" < i."receivedAt"
   );
