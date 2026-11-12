import { describe, expect, it } from "vitest"
import { itemLink, type ItemLinkInput } from "./links"

const base: ItemLinkInput = {
  platform: "youtube",
  type: "comment",
  externalId: "UgxABC",
  postId: "dQw4w9WgXcQ",
  postUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  externalUrl: null,
  accountExternalId: "UC123",
}

describe("itemLink", () => {
  it("prefers the adapter's permalink", () => {
    const link = itemLink({
      ...base,
      platform: "facebook",
      externalUrl: "https://www.facebook.com/123/posts/456?comment_id=789",
    })
    expect(link).toEqual({
      url: "https://www.facebook.com/123/posts/456?comment_id=789",
      target: "item",
      label: "Open comment in Facebook",
    })
  })

  it("ignores a non-http permalink", () => {
    expect(
      itemLink({ ...base, platform: "facebook", externalUrl: "javascript:alert(1)" })?.target,
    ).toBe("post")
  })

  it("links a YouTube comment with lc=", () => {
    expect(itemLink(base)?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ&lc=UgxABC")
  })

  it("links a LinkedIn comment URN", () => {
    const link = itemLink({
      ...base,
      platform: "linkedin",
      postId: "urn:li:activity:7",
      externalId: "urn:li:comment:(urn:li:activity:7,9)",
    })
    expect(link?.target).toBe("item")
    expect(link?.url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7/?commentUrn=urn%3Ali%3Acomment%3A(urn%3Ali%3Aactivity%3A7%2C9)",
    )
  })

  it("falls back to the post for Instagram comments", () => {
    const link = itemLink({
      ...base,
      platform: "instagram",
      postUrl: "https://www.instagram.com/p/abc/",
    })
    expect(link).toMatchObject({ target: "post", label: "Open post in Instagram" })
  })

  it("opens the inbox for DMs", () => {
    expect(itemLink({ ...base, platform: "instagram", type: "dm", postUrl: null })?.target).toBe(
      "inbox",
    )
    expect(
      itemLink({
        ...base,
        platform: "facebook",
        type: "dm",
        postUrl: null,
        accountExternalId: "p1",
      })?.url,
    ).toBe("https://business.facebook.com/latest/inbox/all?asset_id=p1")
  })

  it("opens Google reviews when the location has no URL", () => {
    expect(
      itemLink({ ...base, platform: "google_business", type: "review", postUrl: null }),
    ).toMatchObject({ target: "inbox", label: "Open reviews in Google" })
  })

  it("returns null when nothing is linkable", () => {
    expect(itemLink({ ...base, platform: "facebook", postUrl: null })).toBeNull()
  })
})
