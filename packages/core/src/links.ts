/**
 * "Open in <platform>" links. Adapters store the platform's own permalink in `externalUrl`
 * when the API returns one (Facebook comment `permalink_url`, …). Otherwise we build the most
 * specific URL the platform supports: the comment itself, else its post, else the account's
 * inbox. On phones these https links open the native app when it's installed.
 *
 * URL formats are re-checked against each platform in its phase (PLAN §11, [verify]).
 */
import type { ItemType, Platform } from "./filters/types"

export type ItemLinkTarget = "item" | "post" | "inbox"

export interface ItemLink {
  url: string
  /** How precise the link is: the item itself, its post/video/location, or the inbox. */
  target: ItemLinkTarget
  /** Button label, e.g. "Open comment in YouTube". */
  label: string
}

export interface ItemLinkInput {
  platform: Platform
  type: ItemType
  externalId: string
  postId: string | null
  postUrl: string | null
  /** Adapter-provided permalink to the item itself. */
  externalUrl: string | null
  /** PlatformAccount.externalId (Page id, IG account id, channel id, …). */
  accountExternalId: string
}

export const PLATFORM_APP_NAMES: Record<Platform, string> = {
  google_business: "Google",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  linkedin: "LinkedIn",
}

const NOUN: Record<ItemType, string> = { review: "review", comment: "comment", dm: "conversation" }

function isHttpUrl(value: string | null): value is string {
  if (!value) return false
  try {
    const u = new URL(value)
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}

export function itemLink(input: ItemLinkInput): ItemLink | null {
  const app = PLATFORM_APP_NAMES[input.platform]
  const make = (url: string, target: ItemLinkTarget, label?: string): ItemLink => ({
    url,
    target,
    label:
      label ??
      (target === "item"
        ? `Open ${NOUN[input.type]} in ${app}`
        : target === "post"
          ? `Open ${input.platform === "google_business" ? "location" : input.platform === "youtube" ? "video" : "post"} in ${app}`
          : `Open ${app} inbox`),
  })

  if (isHttpUrl(input.externalUrl)) return make(input.externalUrl, "item")

  const id = encodeURIComponent(input.externalId)
  switch (input.platform) {
    case "youtube":
      // `lc` highlights the comment (top-level or "parent.reply" ids) at the top of the video.
      if (input.type === "comment" && input.postId)
        return make(
          `https://www.youtube.com/watch?v=${encodeURIComponent(input.postId)}&lc=${id}`,
          "item",
        )
      break
    case "linkedin":
      if (
        input.type === "comment" &&
        input.postId &&
        input.externalId.startsWith("urn:li:comment:")
      )
        return make(
          `https://www.linkedin.com/feed/update/${encodeURI(input.postId)}/?commentUrn=${id}`,
          "item",
        )
      break
    case "facebook":
      if (input.type === "dm")
        return make(
          `https://business.facebook.com/latest/inbox/all?asset_id=${encodeURIComponent(input.accountExternalId)}`,
          "inbox",
        )
      break
    case "instagram":
      // Instagram has no per-comment or per-thread web links: the post, or the DM inbox.
      if (input.type === "dm") return make("https://www.instagram.com/direct/inbox/", "inbox")
      break
    case "google_business":
      if (input.type === "review" && !isHttpUrl(input.postUrl))
        return make("https://business.google.com/reviews", "inbox", "Open reviews in Google")
      break
  }
  return isHttpUrl(input.postUrl) ? make(input.postUrl, "post") : null
}
