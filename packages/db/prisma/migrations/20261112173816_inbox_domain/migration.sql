-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('google_business', 'facebook', 'instagram', 'youtube', 'linkedin');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('gbp_location', 'fb_page', 'ig_account', 'yt_channel', 'li_org');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('connected', 'expiring', 'error', 'disconnected');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('review', 'comment', 'dm');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('new', 'filtered', 'archived', 'pending', 'replied', 'ignored', 'failed');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "SyncMode" AS ENUM ('webhook', 'polling', 'webhook_reconcile');

-- CreateEnum
CREATE TYPE "ReplySource" AS ENUM ('ai_draft', 'manual_dashboard', 'slack_button', 'slack_send_prefix', 'auto_reply');

-- CreateEnum
CREATE TYPE "ReplyStatus" AS ENUM ('queued', 'sending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "platform_account" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "kind" "AccountKind" NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "parentAccountId" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AccountStatus" NOT NULL DEFAULT 'connected',
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "included" BOOLEAN NOT NULL DEFAULT true,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_state" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "stream" TEXT NOT NULL,
    "mode" "SyncMode" NOT NULL,
    "intervalSeconds" INTEGER NOT NULL,
    "cursor" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "quotaUsedToday" INTEGER NOT NULL DEFAULT 0,
    "quotaDay" TIMESTAMP(3),
    "lastError" TEXT,
    "backfillDays" INTEGER NOT NULL DEFAULT 30,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "source" TEXT NOT NULL,
    "dedupeKey" TEXT,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "type" "ItemType" NOT NULL,
    "externalId" TEXT NOT NULL,
    "parentExternalId" TEXT,
    "conversationId" TEXT,
    "postId" TEXT,
    "postUrl" TEXT,
    "postTitle" TEXT,
    "postPublishedAt" TIMESTAMP(3),
    "authorName" TEXT,
    "authorHandle" TEXT,
    "authorId" TEXT,
    "authorAvatarUrl" TEXT,
    "isOwnAccount" BOOLEAN NOT NULL DEFAULT false,
    "isReplyToOurReply" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT,
    "rating" INTEGER,
    "language" TEXT,
    "eventKind" TEXT NOT NULL DEFAULT 'created',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platformCreatedAt" TIMESTAMP(3),
    "platformUpdatedAt" TIMESTAMP(3),
    "status" "ItemStatus" NOT NULL DEFAULT 'new',
    "priority" "Priority" NOT NULL DEFAULT 'normal',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dryRunRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "filterReason" TEXT,
    "manualOverride" BOOLEAN NOT NULL DEFAULT false,
    "lastFilteredAt" TIMESTAMP(3),
    "aiSpamScore" DOUBLE PRECISION,
    "aiSentiment" TEXT,
    "aiToxicity" DOUBLE PRECISION,
    "aiDraftsAllowed" BOOLEAN NOT NULL DEFAULT true,
    "requireApproval" BOOLEAN NOT NULL DEFAULT true,
    "slackChannelId" TEXT,
    "slackTs" TEXT,
    "skipSlack" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformAccountId" TEXT NOT NULL,
    "externalThreadId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT,
    "customerLastMessageAt" TIMESTAMP(3),
    "slackTs" TEXT,
    "status" "ItemStatus" NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_draft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reply" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "source" "ReplySource" NOT NULL,
    "sentById" TEXT,
    "status" "ReplyStatus" NOT NULL DEFAULT 'queued',
    "externalReplyId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "filter_rule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL,
    "stopProcessing" BOOLEAN NOT NULL DEFAULT false,
    "platforms" JSONB NOT NULL,
    "itemTypes" JSONB NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "defaultKey" TEXT,
    "autoReply" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "filter_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_match" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "list_entry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "platform" "Platform",
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "list_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_account_organizationId_platform_externalId_key" ON "platform_account"("organizationId", "platform", "externalId");

-- CreateIndex
CREATE INDEX "sync_state_nextRunAt_idx" ON "sync_state"("nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_state_platformAccountId_stream_key" ON "sync_state"("platformAccountId", "stream");

-- CreateIndex
CREATE INDEX "webhook_event_receivedAt_idx" ON "webhook_event"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_event_source_dedupeKey_key" ON "webhook_event"("source", "dedupeKey");

-- CreateIndex
CREATE INDEX "item_organizationId_status_receivedAt_idx" ON "item"("organizationId", "status", "receivedAt" DESC);

-- CreateIndex
CREATE INDEX "item_organizationId_platform_type_idx" ON "item"("organizationId", "platform", "type");

-- CreateIndex
CREATE INDEX "item_conversationId_idx" ON "item"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "item_organizationId_platform_platformAccountId_externalId_key" ON "item"("organizationId", "platform", "platformAccountId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_organizationId_platform_platformAccountId_exte_key" ON "conversation"("organizationId", "platform", "platformAccountId", "externalThreadId");

-- CreateIndex
CREATE INDEX "ai_draft_itemId_idx" ON "ai_draft"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "reply_idempotencyKey_key" ON "reply"("idempotencyKey");

-- CreateIndex
CREATE INDEX "reply_itemId_idx" ON "reply"("itemId");

-- CreateIndex
CREATE INDEX "filter_rule_organizationId_priority_idx" ON "filter_rule"("organizationId", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "filter_rule_organizationId_defaultKey_key" ON "filter_rule"("organizationId", "defaultKey");

-- CreateIndex
CREATE INDEX "rule_match_organizationId_ruleId_matchedAt_idx" ON "rule_match"("organizationId", "ruleId", "matchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "rule_match_ruleId_itemId_key" ON "rule_match"("ruleId", "itemId");

-- CreateIndex
CREATE INDEX "list_entry_organizationId_list_idx" ON "list_entry"("organizationId", "list");

-- CreateIndex
CREATE UNIQUE INDEX "list_entry_organizationId_list_kind_value_platform_key" ON "list_entry"("organizationId", "list", "kind", "value", "platform");

-- AddForeignKey
ALTER TABLE "platform_account" ADD CONSTRAINT "platform_account_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_platformAccountId_fkey" FOREIGN KEY ("platformAccountId") REFERENCES "platform_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_event" ADD CONSTRAINT "webhook_event_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_platformAccountId_fkey" FOREIGN KEY ("platformAccountId") REFERENCES "platform_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item" ADD CONSTRAINT "item_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_platformAccountId_fkey" FOREIGN KEY ("platformAccountId") REFERENCES "platform_account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft" ADD CONSTRAINT "ai_draft_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_draft" ADD CONSTRAINT "ai_draft_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply" ADD CONSTRAINT "reply_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply" ADD CONSTRAINT "reply_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "filter_rule" ADD CONSTRAINT "filter_rule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_match" ADD CONSTRAINT "rule_match_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_match" ADD CONSTRAINT "rule_match_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "filter_rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rule_match" ADD CONSTRAINT "rule_match_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "list_entry" ADD CONSTRAINT "list_entry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
