/**
 * Platform API versions (PLAN §4). Defaults live here; each organization can override them in
 * Settings → Connections → Advanced. Re-verified at the start of each platform phase.
 */
export const PLATFORM_VERSIONS = {
  /** Meta Graph API (re-check for v27.0 before Phase 5). */
  metaGraphApiVersion: "v26.0",
  /** LinkedIn REST `LinkedIn-Version` header (YYYYMM). */
  linkedinApiVersion: "202610",
  /** Google Business Profile reviews (still v4). */
  googleReviewsBaseUrl: "https://mybusiness.googleapis.com/v4",
  /** Google My Business Notifications (Pub/Sub settings). */
  googleNotificationsBaseUrl: "https://mybusinessnotifications.googleapis.com/v1",
  /** YouTube Data API (not overridable). */
  youtubeApiVersion: "v3",
} as const
