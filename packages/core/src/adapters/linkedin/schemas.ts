/**
 * LinkedIn Community Management API wire formats (PLAN §11, checked against the 202610 docs on
 * 2026-11-15). REST API under `/rest` with `LinkedIn-Version: YYYYMM` and
 * `X-Restli-Protocol-Version: 2.0.0`.
 *
 * Comments are found through the organization's social action notifications (pushed by the
 * webhook, or pulled from `organizationalEntityNotifications`, 60-day lookback), then each
 * comment is read with `GET /rest/socialActions/{thread}/comments/{id}`.
 */
import { z } from "zod"

export const LINKEDIN_API_BASE = "https://api.linkedin.com/rest"
export const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"

/**
 * - `rw_organization_admin`: Pages the member administers (organizationAcls), notifications and
 *   webhook subscriptions.
 * - `r_organization_social_feed` / `w_organization_social_feed`: read and write comments.
 */
export const LINKEDIN_SCOPES = [
  "rw_organization_admin",
  "r_organization_social_feed",
  "w_organization_social_feed",
] as const

/** Notification actions that carry a comment (`generatedActivity` is its comment URN). */
export const LINKEDIN_COMMENT_ACTIONS = ["COMMENT", "ADMIN_COMMENT", "COMMENT_EDIT"] as const

export const linkedinTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  /** Seconds; 60 days for 3-legged tokens. */
  expires_in: z.number(),
  /** Only for apps with programmatic refresh tokens (365 days). */
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
  scope: z.string().optional(),
})
export type LinkedinToken = z.infer<typeof linkedinTokenSchema>

/** REST errors (`message`, `status`) and OAuth errors (`error`, `error_description`). */
export const linkedinErrorSchema = z.looseObject({
  message: z.string().optional(),
  status: z.number().optional(),
  serviceErrorCode: z.number().optional(),
  code: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
})

const pagingSchema = z
  .looseObject({
    start: z.number().optional(),
    count: z.number().optional(),
    total: z.number().optional(),
    links: z.array(z.unknown()).optional(),
  })
  .optional()

export const linkedinOrgAclListSchema = z.looseObject({
  elements: z
    .array(
      z.looseObject({
        role: z.string(),
        state: z.string().optional(),
        roleAssignee: z.string().optional(),
        // The docs show both names depending on the finder.
        organization: z.string().optional(),
        organizationTarget: z.string().optional(),
      }),
    )
    .default([]),
  paging: pagingSchema,
})

export const linkedinOrganizationSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  localizedName: z.string().optional(),
  vanityName: z.string().optional(),
})
export type LinkedinOrganization = z.infer<typeof linkedinOrganizationSchema>

export const linkedinNotificationSchema = z.looseObject({
  notificationId: z.union([z.number(), z.string()]),
  organizationalEntity: z.string(),
  action: z.string(),
  sourcePost: z.string().optional(),
  generatedActivity: z.string().optional(),
  lastModifiedAt: z.number(),
  subscriber: z.string().optional(),
})
export type LinkedinNotification = z.infer<typeof linkedinNotificationSchema>

export const linkedinNotificationListSchema = z.looseObject({
  elements: z.array(linkedinNotificationSchema).default([]),
  paging: pagingSchema,
})

/** Webhook body: notifications batched by event type, up to 10 at a time. */
export const linkedinWebhookSchema = z.looseObject({
  type: z.string(),
  notifications: z.array(linkedinNotificationSchema).default([]),
})

const auditStampSchema = z.looseObject({ time: z.number(), actor: z.string().optional() })

export const linkedinCommentSchema = z.looseObject({
  /** `urn:li:person:…` (a member) or `urn:li:organization:…` (a Page). */
  actor: z.string(),
  /** The member who commented on a Page's behalf. */
  agent: z.string().optional(),
  commentUrn: z.string().optional(),
  id: z.string(),
  created: auditStampSchema,
  lastModified: auditStampSchema.optional(),
  message: z.looseObject({ text: z.string().optional() }).optional(),
  /** The thread (activity, share or ugcPost) the comment is on. */
  object: z.string(),
  parentComment: z.string().optional(),
})
export type LinkedinComment = z.infer<typeof linkedinCommentSchema>

export const linkedinPersonSchema = z.looseObject({
  localizedFirstName: z.string().optional(),
  localizedLastName: z.string().optional(),
  vanityName: z.string().optional(),
})

export const orgUrn = (id: string | number) => `urn:li:organization:${id}`

/** `urn:li:organization:123` → `123` (null for anything else). */
export function orgIdOf(urn: string): string | null {
  return /^urn:li:organization:(\d+)$/.exec(urn)?.[1] ?? null
}

/**
 * Splits a comment URN, `urn:li:comment:(urn:li:activity:1,2)`, into its thread and id.
 * Tolerates the docs' sample shape `(activity:1, 2)`.
 */
export function parseCommentUrn(urn: string): { thread: string; id: string } | null {
  const m = /^urn:li:comment:\((.+),\s*(\d+)\)$/.exec(urn.trim())
  if (!m) return null
  const raw = m[1]!.trim()
  const thread = raw.startsWith("urn:") ? raw : `urn:li:${raw}`
  return { thread, id: m[2]! }
}

export const commentUrnOf = (c: Pick<LinkedinComment, "commentUrn" | "object" | "id">) =>
  c.commentUrn ?? `urn:li:comment:(${c.object},${c.id})`
