/**
 * pg-boss queue names and retry policy, shared by api (enqueue) and worker (process).
 * Every job handler must be idempotent: jobs can be retried after partial success.
 */
export const QUEUES = {
  ingest: "ingest",
  filter: "filter",
  aiDraft: "ai-draft",
  notifySlack: "notify-slack",
  sendReply: "send-reply",
  poll: "poll",
  tokenRefresh: "token-refresh",
  /** Data retention clean-up (Settings → Data). */
  maintenance: "maintenance",
} as const

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES]

export interface QueueConfig {
  name: QueueName
  /** pg-boss queue policy. */
  policy: "standard" | "singleton" | "stately"
  retryLimit: number
  /** Seconds before the first retry; doubles each time (retryBackoff). */
  retryDelay: number
  retryDelayMax: number
}

export const QUEUE_CONFIG: readonly QueueConfig[] = [
  { name: QUEUES.ingest, policy: "standard", retryLimit: 5, retryDelay: 5, retryDelayMax: 600 },
  { name: QUEUES.filter, policy: "standard", retryLimit: 3, retryDelay: 5, retryDelayMax: 300 },
  { name: QUEUES.aiDraft, policy: "standard", retryLimit: 3, retryDelay: 10, retryDelayMax: 600 },
  {
    name: QUEUES.notifySlack,
    policy: "standard",
    retryLimit: 5,
    retryDelay: 5,
    retryDelayMax: 600,
  },
  // A platform 2xx followed by a crash must not re-post publicly. The handler records
  // externalReplyId before acking and checks Reply.idempotencyKey on retry.
  { name: QUEUES.sendReply, policy: "standard", retryLimit: 3, retryDelay: 15, retryDelayMax: 600 },
  // No pg-boss retries: a failed poll is recorded on its SyncState and the scheduler retries it
  // with backoff (min(interval × 2^failures, 6 h)). One active poll per sync state (singleton).
  { name: QUEUES.poll, policy: "singleton", retryLimit: 0, retryDelay: 30, retryDelayMax: 900 },
  {
    name: QUEUES.tokenRefresh,
    policy: "singleton",
    retryLimit: 3,
    retryDelay: 60,
    retryDelayMax: 3600,
  },
  {
    name: QUEUES.maintenance,
    policy: "singleton",
    retryLimit: 2,
    retryDelay: 300,
    retryDelayMax: 3600,
  },
]

export const deadLetterQueueName = (name: QueueName): string => `${name}-dlq`

/** Job payload for the `filter` queue. */
export type FilterJobData = {
  /** Re-run all rules over the organization's stored items (after a rule/list change). */
  kind: "refilter"
  organizationId: string
  requestId?: string | undefined
}

/** Job payload for the `poll` queue (enqueued by the scheduler or "Run now"). */
export type PollJobData = {
  organizationId: string
  syncStateId: string
  /** "schedule" (due), "manual" (Run now) or "webhook" (a push said something changed). */
  trigger: "schedule" | "manual" | "webhook"
  requestId?: string | undefined
}

/** Job payload for the `token-refresh` queue. */
export type TokenRefreshJobData = { organizationId: string }

/** Job payload for the `maintenance` queue. */
export type MaintenanceJobData = { organizationId: string; kind: "retention" }

/** Job payload for the `ingest` queue. */
export type IngestJobData = {
  kind: "webhook"
  organizationId?: string | undefined
  webhookEventId: string
  /** True when someone pressed Replay in the Activity log. */
  replay?: boolean | undefined
  requestId?: string | undefined
}

/** Job payload for the `ai-draft` queue. */
export type AiDraftJobData = {
  organizationId: string
  itemId: string
  /** Regenerate even when drafts exist (the "Regenerate" button). */
  force?: boolean | undefined
  requestId?: string | undefined
}

/** Job payload for the `send-reply` queue. */
export type SendReplyJobData = {
  organizationId: string
  replyId: string
  requestId?: string | undefined
}
