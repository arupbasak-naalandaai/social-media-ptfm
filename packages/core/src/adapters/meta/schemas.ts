/**
 * Meta (Facebook Page + Instagram via Facebook Login) wire formats: webhooks and the Graph API
 * responses we read. Loose objects: Meta adds fields over time, and webhook payloads for
 * fields we don't handle must still parse (they're skipped, not rejected).
 * Facts re-verified 2026-11-13 (PLAN §11): Graph API v26.0 is still the newest version.
 */
import { z } from "zod"

const idName = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  username: z.string().optional(),
})

// ─── Webhooks ──────────────────────────────────────────────────────────────────

/** Page `feed` change for a comment (`value.item === "comment"`). */
export const fbFeedCommentValueSchema = z.looseObject({
  item: z.literal("comment"),
  verb: z.string(),
  comment_id: z.string(),
  post_id: z.string(),
  /** The post id for a top-level comment, else the comment it replies to. */
  parent_id: z.string().optional(),
  from: idName.optional(),
  message: z.string().optional(),
  /** Unix seconds. */
  created_time: z.number().optional(),
  post: z
    .looseObject({ permalink_url: z.string().optional(), status_type: z.string().optional() })
    .optional(),
})
export type FbFeedCommentValue = z.infer<typeof fbFeedCommentValueSchema>

/** Instagram `comments` change. */
export const igCommentValueSchema = z.looseObject({
  id: z.string(),
  text: z.string().optional(),
  parent_id: z.string().optional(),
  from: idName.optional(),
  media: z.looseObject({ id: z.string(), media_product_type: z.string().optional() }).optional(),
})
export type IgCommentValue = z.infer<typeof igCommentValueSchema>

/** One Messenger / Instagram messaging event (`entry[].messaging[]`). */
export const metaMessagingEventSchema = z.looseObject({
  sender: z.looseObject({ id: z.string() }),
  recipient: z.looseObject({ id: z.string() }),
  /** Unix milliseconds. */
  timestamp: z.number(),
  message: z
    .looseObject({
      mid: z.string(),
      text: z.string().optional(),
      is_echo: z.boolean().optional(),
      is_deleted: z.boolean().optional(),
      attachments: z.array(z.looseObject({ type: z.string().optional() })).optional(),
      reply_to: z.looseObject({ mid: z.string().optional() }).optional(),
    })
    .optional(),
  message_edit: z.looseObject({ mid: z.string(), text: z.string().optional() }).optional(),
})
export type MetaMessagingEvent = z.infer<typeof metaMessagingEventSchema>

export const metaWebhookSchema = z.looseObject({
  object: z.string(),
  entry: z.array(
    z.looseObject({
      /** Page id (object=page) or Instagram account id (object=instagram). */
      id: z.string(),
      /** Seconds or milliseconds depending on the product. */
      time: z.number().optional(),
      changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })).optional(),
      messaging: z.array(z.unknown()).optional(),
    }),
  ),
})
export type MetaWebhook = z.infer<typeof metaWebhookSchema>

// ─── Graph API ─────────────────────────────────────────────────────────────────

export const metaErrorSchema = z.looseObject({
  error: z.looseObject({
    message: z.string().optional(),
    type: z.string().optional(),
    code: z.number().optional(),
    error_subcode: z.number().optional(),
    fbtrace_id: z.string().optional(),
  }),
})

export const metaTokenSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  /** Seconds; absent for non-expiring tokens. */
  expires_in: z.number().optional(),
})
export type MetaToken = z.infer<typeof metaTokenSchema>

const paging = z
  .looseObject({
    next: z.string().optional(),
    cursors: z.looseObject({ after: z.string().optional() }).optional(),
  })
  .optional()

export const metaPermissionsSchema = z.looseObject({
  data: z.array(z.looseObject({ permission: z.string(), status: z.string() })),
})

export const metaPageSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  access_token: z.string().optional(),
  category: z.string().optional(),
  link: z.string().optional(),
  picture: z.looseObject({ data: z.looseObject({ url: z.string().optional() }) }).optional(),
  instagram_business_account: z
    .looseObject({
      id: z.string(),
      username: z.string().optional(),
      name: z.string().optional(),
      profile_picture_url: z.string().optional(),
    })
    .optional(),
})
export type MetaPage = z.infer<typeof metaPageSchema>

export const metaPageListSchema = z.looseObject({ data: z.array(metaPageSchema), paging })

export const metaSubscribedAppsSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string().optional(),
      subscribed_fields: z.array(z.string()).optional(),
    }),
  ),
})

export const metaSuccessSchema = z.looseObject({ success: z.boolean().optional() })
export const metaIdSchema = z.looseObject({ id: z.string() })
export const metaSendSchema = z.looseObject({
  recipient_id: z.string().optional(),
  message_id: z.string(),
})

/** A Page post with its newest comments (reconcile). */
export const fbCommentNodeSchema = z.looseObject({
  id: z.string(),
  message: z.string().optional(),
  created_time: z.string(),
  from: idName.optional(),
  parent: z.looseObject({ id: z.string() }).optional(),
  permalink_url: z.string().optional(),
})
export type FbCommentNode = z.infer<typeof fbCommentNodeSchema>

export const fbPostListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      created_time: z.string().optional(),
      updated_time: z.string().optional(),
      permalink_url: z.string().optional(),
      message: z.string().optional(),
    }),
  ),
  paging,
})
export const fbCommentListSchema = z.looseObject({ data: z.array(fbCommentNodeSchema), paging })

export const igCommentNodeSchema = z.looseObject({
  id: z.string(),
  text: z.string().optional(),
  timestamp: z.string(),
  username: z.string().optional(),
  from: idName.optional(),
  parent_id: z.string().optional(),
})
export type IgCommentNode = z.infer<typeof igCommentNodeSchema>

export const igMediaListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      permalink: z.string().optional(),
      caption: z.string().optional(),
      timestamp: z.string().optional(),
      comments_count: z.number().optional(),
    }),
  ),
  paging,
})
export const igCommentListSchema = z.looseObject({
  data: z.array(
    igCommentNodeSchema.extend({
      replies: z.looseObject({ data: z.array(igCommentNodeSchema) }).optional(),
    }),
  ),
  paging,
})

/** Conversations API message (reconcile of DMs). */
export const metaConversationMessageSchema = z.looseObject({
  id: z.string(),
  message: z.string().optional(),
  created_time: z.string(),
  from: idName.optional(),
})
export type MetaConversationMessage = z.infer<typeof metaConversationMessageSchema>

export const metaConversationListSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      id: z.string(),
      updated_time: z.string().optional(),
      participants: z.looseObject({ data: z.array(idName) }).optional(),
      messages: z.looseObject({ data: z.array(metaConversationMessageSchema) }).optional(),
    }),
  ),
  paging,
})

export const metaProfileSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  profile_pic: z.string().optional(),
})

/** Permissions the Facebook Login dialog asks for (comments + DMs, Pages + Instagram). */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_metadata",
  "pages_manage_engagement",
  "pages_messaging",
  "instagram_basic",
  "instagram_manage_comments",
  "instagram_manage_messages",
  "business_management",
] as const

/** Fields the Page is subscribed to on connect (comments arrive as `feed`). */
export const META_PAGE_FIELDS = ["feed", "messages", "message_echoes"] as const
