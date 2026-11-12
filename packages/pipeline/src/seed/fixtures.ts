/**
 * Deterministic fake items across all platforms for local development. Includes the noise the
 * default rules are meant to catch (own replies, echoes, reactions, edits, emoji-only, tag-only,
 * spam, blocklisted authors) next to real work (reviews, questions, complaints, DMs).
 */
import type { EventKind, ItemType, NormalizedItem, Platform } from "@inbox/core"

export interface SeedAccount {
  key: Platform
  platform: Platform
  kind: "gbp_location" | "fb_page" | "ig_account" | "yt_channel" | "li_org"
  externalId: string
  displayName: string
  handle: string
}

export const SEED_ACCOUNTS: SeedAccount[] = [
  {
    key: "google_business",
    platform: "google_business",
    kind: "gbp_location",
    externalId: "locations/demo-downtown",
    displayName: "Demo Bistro – Downtown",
    handle: "demobistro",
  },
  {
    key: "facebook",
    platform: "facebook",
    kind: "fb_page",
    externalId: "fb-page-demo",
    displayName: "Demo Bistro",
    handle: "demobistro",
  },
  {
    key: "instagram",
    platform: "instagram",
    kind: "ig_account",
    externalId: "ig-demo",
    displayName: "Demo Bistro",
    handle: "demobistro",
  },
  {
    key: "youtube",
    platform: "youtube",
    kind: "yt_channel",
    externalId: "UC-demo-channel",
    displayName: "Demo Bistro Kitchen",
    handle: "demobistrokitchen",
  },
  {
    key: "linkedin",
    platform: "linkedin",
    kind: "li_org",
    externalId: "urn:li:organization:demo",
    displayName: "Demo Bistro Group",
    handle: "demo-bistro-group",
  },
]

/** Small deterministic PRNG so the seed is stable across runs. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PEOPLE = [
  ["Priya Sharma", "priya.sharma"],
  ["Marcus Lee", "marcuslee"],
  ["Ana Gómez", "ana.gomez"],
  ["Rahul Verma", "rahulv"],
  ["Sophie Martin", "sophiem"],
  ["Daniel Okafor", "dan.okafor"],
  ["Mei Chen", "meichen"],
  ["Lucas Silva", "lucas_silva"],
  ["Fatima Khan", "fatimak"],
  ["Tom Becker", "tombecker"],
  ["Aisha Bello", "aisha.b"],
  ["Kenji Watanabe", "kenjiw"],
  ["Olivia Brown", "olivia.brown"],
  ["Arjun Nair", "arjun.nair"],
  ["Elena Rossi", "elenarossi"],
] as const

const POSTS: Record<
  Exclude<Platform, "google_business">,
  { id: string; title: string; url: string; ageDays: number }[]
> = {
  facebook: [
    {
      id: "fb-post-1",
      title: "New autumn menu is here 🍂",
      url: "https://facebook.com/demobistro/posts/1",
      ageDays: 6,
    },
    {
      id: "fb-post-2",
      title: "We're hiring line cooks",
      url: "https://facebook.com/demobistro/posts/2",
      ageDays: 45,
    },
  ],
  instagram: [
    {
      id: "ig-media-1",
      title: "Truffle pasta reel",
      url: "https://instagram.com/p/demo1",
      ageDays: 3,
    },
    {
      id: "ig-media-2",
      title: "Behind the scenes: sourdough",
      url: "https://instagram.com/p/demo2",
      ageDays: 60,
    },
  ],
  youtube: [
    {
      id: "yt-video-1",
      title: "How we make our ramen broth (12-hour recipe)",
      url: "https://youtube.com/watch?v=demo1",
      ageDays: 10,
    },
    {
      id: "yt-video-2",
      title: "Kitchen tour 2025",
      url: "https://youtube.com/watch?v=demo2",
      ageDays: 120,
    },
  ],
  linkedin: [
    {
      id: "urn:li:share:demo1",
      title: "Demo Bistro opens its third location",
      url: "https://linkedin.com/feed/update/demo1",
      ageDays: 4,
    },
  ],
}

interface Template {
  platform: Platform
  type: ItemType
  text: string | null
  rating?: number
  language?: string
  eventKind?: EventKind
  own?: boolean
  author?: readonly [string, string]
  post?: number
  thread?: string
  replyToOurReply?: boolean
  /** Name this item so a later follow-up can reply under it (`parentKey`). */
  key?: string
  /** A reply to the comment named `key` (same thread). */
  parentKey?: string
  /** We already answered this one: the seed marks it replied/resolved after ingest. */
  ourReply?: SeedReply
}

export interface SeedReply {
  text: string | null
  status: "replied" | "resolved"
}

/** Work the team should see. */
const REAL: Template[] = [
  // Google reviews
  {
    platform: "google_business",
    type: "review",
    rating: 5,
    text: "Best ramen in town. The broth is incredibly rich and the staff remembered our order from last time!",
    ourReply: {
      text: "Thank you so much! We'll pass this on to the kitchen team 🍜",
      status: "replied",
    },
  },
  {
    platform: "google_business",
    type: "review",
    rating: 4,
    text: "Great food, a bit noisy on Friday nights. Would love a quieter corner for families.",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 2,
    text: "Waited 45 minutes for a table even though we had a reservation. Food was fine but the wait was frustrating.",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 1,
    text: "Terrible experience. Found a hair in my soup and the manager was rude about it. I want a refund.",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 3,
    text: "Decent but overpriced for the portion size.",
    ourReply: { text: null, status: "resolved" },
  },
  { platform: "google_business", type: "review", rating: 5, text: null },
  { platform: "google_business", type: "review", rating: 4, text: null },
  {
    platform: "google_business",
    type: "review",
    rating: 5,
    text: "¡La mejor comida que he probado en mucho tiempo! Volveremos pronto.",
    language: "es",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 2,
    text: "Order was wrong twice. Not working well on busy nights, please fix the kitchen display.",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 5,
    text: "Celebrated my mom's birthday here — they brought a little dessert with a candle. So thoughtful ❤️",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 1,
    text: "Disappointed. Cold food and the card machine was broken so we had to go find an ATM.",
  },
  {
    platform: "google_business",
    type: "review",
    rating: 4,
    text: "खाना बहुत स्वादिष्ट था, सर्विस थोड़ी धीमी थी।",
    language: "hi",
  },
  // Facebook comments
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "Is the pumpkin soup vegan? My daughter has a dairy allergy.",
  },
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "Do you take reservations for groups of 12 on Saturday?",
  },
  {
    platform: "facebook",
    type: "comment",
    post: 1,
    text: "What are the hours for the line cook role? Is it full time?",
  },
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "The new menu looks amazing, can't wait to try the duck!",
  },
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "Still waiting on a refund for my cancelled catering order from two weeks ago. Nobody answers the phone.",
  },
  // Instagram comments
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    text: "Recipe please!! Or at least tell us which mushrooms you use 😍",
  },
  { platform: "instagram", type: "comment", post: 0, text: "Are you open on Mondays now?" },
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    key: "ig-vegan",
    author: ["Sophie Martin", "sophiem"],
    text: "Do you have vegan options on the new menu?",
    ourReply: {
      text: "Yes! The mushroom ragù and the pumpkin soup are both fully vegan 🌱",
      status: "replied",
    },
  },
  {
    platform: "instagram",
    type: "comment",
    post: 1,
    text: "How long do you proof the sourdough for?",
  },
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    text: "Had this last night, worth every penny. Service was quick too.",
  },
  // YouTube comments
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    text: "Can I use chicken feet instead of pork bones for the broth? Great video btw.",
  },
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    text: "At 6:32 you said 2 tbsp of tare but the description says 3. Which one is right?",
  },
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    text: "Tried this recipe and the broth turned cloudy. What did I do wrong?",
  },
  {
    platform: "youtube",
    type: "comment",
    post: 1,
    text: "This kitchen is so clean, respect to the whole team.",
  },
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    text: "Thanks for the reply! The tip about skimming worked perfectly.",
    replyToOurReply: true,
  },
  // LinkedIn comments
  {
    platform: "linkedin",
    type: "comment",
    post: 0,
    text: "Congratulations to the whole team! Are you hiring a general manager for the new location?",
  },
  {
    platform: "linkedin",
    type: "comment",
    post: 0,
    text: "We supply organic produce to restaurants in the area — would love to connect with your purchasing team.",
  },
  {
    platform: "linkedin",
    type: "comment",
    post: 0,
    text: "Proud to have worked with you on the interior design. Looks fantastic.",
  },
]

/** DM threads (customer messages, plus one echo of our own reply). */
const THREADS: { platform: "facebook" | "instagram"; person: number; messages: Template[] }[] = [
  {
    platform: "facebook",
    person: 3,
    messages: [
      {
        platform: "facebook",
        type: "dm",
        text: "Hi! Can I book a private dining room for 20 people on Dec 14?",
        ourReply: {
          text: "Hi Rahul, yes we can. Could you share a phone number?",
          status: "replied",
        },
      },
      {
        platform: "facebook",
        type: "dm",
        text: "Hi Rahul, yes we can. Could you share a phone number?",
        own: true,
        eventKind: "echo",
      },
      {
        platform: "facebook",
        type: "dm",
        text: "Sure, it's in my profile. Also, do you have a set menu option?",
      },
    ],
  },
  {
    platform: "facebook",
    person: 8,
    messages: [
      {
        platform: "facebook",
        type: "dm",
        text: "I think I left my scarf at your restaurant yesterday, a blue wool one. Did anyone find it?",
      },
    ],
  },
  {
    platform: "instagram",
    person: 1,
    messages: [
      {
        platform: "instagram",
        type: "dm",
        text: "Hey, do you do collabs with food bloggers? I have 12k followers in the city.",
      },
      { platform: "instagram", type: "dm", text: "Happy to send my media kit." },
    ],
  },
  {
    platform: "instagram",
    person: 12,
    messages: [
      {
        platform: "instagram",
        type: "dm",
        text: "Your gluten-free options — are they made in a separate area? I'm coeliac.",
      },
    ],
  },
  {
    platform: "instagram",
    person: 6,
    messages: [{ platform: "instagram", type: "dm", text: null, eventKind: "story_mention" }],
  },
  {
    platform: "instagram",
    person: 10,
    messages: [{ platform: "instagram", type: "dm", text: "😍", eventKind: "story_reaction" }],
  },
  {
    platform: "facebook",
    person: 13,
    messages: [
      {
        platform: "facebook",
        type: "dm",
        text: "Worst delivery experience ever. 90 minutes late and the order was wrong. I want my money back.",
      },
    ],
  },
]

/** Noise the default rules should drop or archive. */
const NOISE: Template[] = [
  // own activity (drop)
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    own: true,
    text: "Thanks so much! Yes, the pumpkin soup is fully vegan 🌱",
  },
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    own: true,
    text: "Use 2 tbsp — we'll fix the description. Thanks for spotting it!",
  },
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    own: true,
    text: "We're open Mondays from December!",
  },
  // non-content events (drop)
  { platform: "facebook", type: "comment", post: 0, eventKind: "reaction", text: null },
  { platform: "linkedin", type: "comment", post: 0, eventKind: "like", text: null },
  { platform: "facebook", type: "dm", eventKind: "read", text: null, thread: "fb-thread-read" },
  {
    platform: "instagram",
    type: "dm",
    eventKind: "typing",
    text: null,
    thread: "ig-thread-typing",
  },
  // edits / deletions of unknown items (archive)
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    eventKind: "edited",
    text: "Edited: actually the soup was great",
  },
  { platform: "youtube", type: "comment", post: 0, eventKind: "deleted", text: null },
  // emoji-only / very short comments (archive)
  { platform: "instagram", type: "comment", post: 0, text: "🔥🔥" },
  { platform: "instagram", type: "comment", post: 0, text: "nice" },
  { platform: "instagram", type: "comment", post: 1, text: "😍😍😍" },
  { platform: "facebook", type: "comment", post: 0, text: "Yum!" },
  { platform: "youtube", type: "comment", post: 0, text: "first" },
  { platform: "youtube", type: "comment", post: 1, text: "👍🏽" },
  { platform: "linkedin", type: "comment", post: 0, text: "Congrats!" },
  // low-value praise (archive: "Archive low-value comments")
  { platform: "instagram", type: "comment", post: 0, text: "Good content bro, keep it up 👏" },
  { platform: "facebook", type: "comment", post: 0, text: "Thanks for sharing!" },
  { platform: "youtube", type: "comment", post: 0, text: "Great video sir, very informative 🙏" },
  { platform: "linkedin", type: "comment", post: 0, text: "Wow amazing work team!!" },
  { platform: "instagram", type: "comment", post: 1, text: "Sooo goood 😍🔥" },
  // tag-only (archive)
  { platform: "instagram", type: "comment", post: 0, text: "@meichen @lucas_silva" },
  { platform: "facebook", type: "comment", post: 0, text: "@Olivia Brown" },
  { platform: "instagram", type: "comment", post: 0, text: "@kenjiw" },
  // spam (archive)
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    text: "Want 10k followers? DM me for a promo 💸",
    author: ["Growth Guru", "growth.guru.official"],
  },
  {
    platform: "instagram",
    type: "comment",
    post: 1,
    text: "Check my profile for crypto investment tips! Easy 300% returns",
    author: ["Crypto King", "cryptoking_signals"],
  },
  {
    platform: "youtube",
    type: "comment",
    post: 0,
    text: "Earn money from home, visit http://quick-cash-now.biz/join today",
    author: ["Easy Money", "easymoney4u"],
  },
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "Free followers at https://insta-boost.xyz 🚀🚀",
    author: ["Boost Bot", "boostbot"],
  },
  {
    platform: "linkedin",
    type: "comment",
    post: 0,
    text: "Great post! Let's collab — check my profile for a forex opportunity.",
    author: ["Forex Mentor", "forex-mentor-pro"],
  },
  // blocklisted author (archive)
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "You guys are a joke lol, go out of business",
    author: ["Known Troll", "known.troll"],
  },
  {
    platform: "youtube",
    type: "comment",
    post: 1,
    text: "Another boring video from this channel",
    author: ["Known Troll", "known.troll"],
  },
  // trusted link: NOT spam, stays in the inbox
  {
    platform: "facebook",
    type: "comment",
    post: 0,
    text: "Here's the video I mentioned of your chef: https://youtube.com/watch?v=abc123 — amazing technique!",
  },
  // allowlisted VIP: shown at high priority even though short
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    text: "Love it",
    author: ["Chef Marco (partner)", "chef.marco"],
  },
  {
    platform: "google_business",
    type: "review",
    rating: 5,
    text: "As always, a pleasure. See you next week!",
    author: ["Chef Marco (partner)", "chef.marco"],
  },
  // comments on old posts (rule off by default)
  {
    platform: "facebook",
    type: "comment",
    post: 1,
    text: "Is this job still open? I have 5 years experience in Italian kitchens.",
  },
  { platform: "instagram", type: "comment", post: 1, text: "Do you sell your sourdough starter?" },
  { platform: "youtube", type: "comment", post: 1, text: "Where did you buy that stockpot?" },
]

/** Later activity under items we already answered (they land under Follow-ups). */
const FOLLOW_UPS: (Template & { parentKey: string; afterMinutes: number })[] = [
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    parentKey: "ig-vegan",
    afterMinutes: 180,
    author: ["Sophie Martin", "sophiem"],
    text: "Amazing, is the ragù gluten free too? Asking for my sister.",
  },
  {
    platform: "instagram",
    type: "comment",
    post: 0,
    parentKey: "ig-vegan",
    afterMinutes: 200,
    author: ["Sophie Martin", "sophiem"],
    text: "Thank you so much!! 🙏",
  },
]

export interface SeedItem {
  accountKey: Platform
  item: NormalizedItem
  ourReply?: SeedReply
}

/** Builds ~100 normalized items with receivedAt spread over the last 14 days. */
export function buildSeedItems(now: Date = new Date()): SeedItem[] {
  const rand = mulberry32(20261112)
  const out: SeedItem[] = []
  let n = 0
  const minutesAgo = (maxDays: number) => Math.floor(rand() * maxDays * 24 * 60)

  const keyed = new Map<string, { externalId: string; receivedAt: Date }>()

  const make = (
    t: Template,
    opts: { receivedAt: Date; author?: readonly [string, string]; thread?: string },
  ) => {
    n++
    const externalId = `seed-${t.platform}-${n}`
    if (t.key) keyed.set(t.key, { externalId, receivedAt: opts.receivedAt })
    const parent = t.parentKey ? keyed.get(t.parentKey) : undefined
    const account = SEED_ACCOUNTS.find((a) => a.platform === t.platform)!
    const author = t.own
      ? ([account.displayName, account.handle] as const)
      : (t.author ?? opts.author ?? PEOPLE[Math.floor(rand() * PEOPLE.length)]!)
    const post =
      t.post !== undefined && t.platform !== "google_business"
        ? POSTS[t.platform][t.post]
        : undefined
    const threadId = opts.thread ?? t.thread
    const item: NormalizedItem = {
      platform: t.platform,
      type: t.type,
      eventKind: t.eventKind ?? "created",
      externalId,
      parentExternalId:
        parent?.externalId ?? (t.replyToOurReply ? `seed-${t.platform}-our-reply` : null),
      postId: post?.id ?? (t.platform === "google_business" ? account.externalId : null),
      postUrl: post?.url ?? null,
      externalUrl: null,
      postTitle: post?.title ?? (t.platform === "google_business" ? account.displayName : null),
      postPublishedAt: post ? new Date(now.getTime() - post.ageDays * 86_400_000) : null,
      authorName: author[0],
      authorHandle: author[1],
      authorId: t.own ? account.externalId : `${t.platform}-user-${author[1]}`,
      authorAvatarUrl: null,
      isOwnAccount: t.own === true,
      isReplyToOurReply: t.replyToOurReply === true,
      text: t.text,
      rating: t.rating ?? null,
      language: t.language ?? (t.text ? "en" : null),
      platformCreatedAt: opts.receivedAt,
      platformUpdatedAt: null,
      receivedAt: opts.receivedAt,
      conversation:
        t.type === "dm"
          ? {
              externalThreadId: threadId ?? `seed-thread-${n}`,
              customerId: `${t.platform}-user-${(opts.author ?? author)[1]}`,
              customerName: (opts.author ?? author)[0],
            }
          : null,
      raw: { seed: true, template: n },
    }
    out.push({ accountKey: t.platform, item, ...(t.ourReply ? { ourReply: t.ourReply } : {}) })
  }

  const at = (mins: number) => new Date(now.getTime() - mins * 60_000)

  for (const t of REAL) make(t, { receivedAt: at(minutesAgo(14)) })

  // DM threads: messages a few minutes apart; the most recent thread is inside the 24 h window.
  THREADS.forEach((thread, i) => {
    const person = PEOPLE[thread.person]!
    let mins = i === 0 ? 90 : minutesAgo(10)
    for (const m of thread.messages) {
      make(m, {
        receivedAt: at(mins),
        author: person,
        thread: `seed-thread-${thread.platform}-${i}`,
      })
      mins -= 4
    }
  })

  for (const t of NOISE) make(t, { receivedAt: at(minutesAgo(14)) })

  for (const t of FOLLOW_UPS) {
    const parent = keyed.get(t.parentKey)!
    const receivedAt = new Date(
      Math.min(parent.receivedAt.getTime() + t.afterMinutes * 60_000, now.getTime() - 60_000),
    )
    make(t, { receivedAt })
  }

  // Top up with varied everyday comments so lists and pagination have volume.
  const filler: Template[] = [
    {
      platform: "instagram",
      type: "comment",
      post: 0,
      text: "What time does the kitchen close on Sundays?",
    },
    { platform: "facebook", type: "comment", post: 0, text: "Do you have parking nearby?" },
    {
      platform: "youtube",
      type: "comment",
      post: 0,
      text: "Could you do a video on homemade noodles next?",
    },
    {
      platform: "google_business",
      type: "review",
      rating: 4,
      text: "Solid food and friendly staff. Desserts could be better.",
    },
    {
      platform: "google_business",
      type: "review",
      rating: 5,
      text: "Amazing brunch, the shakshuka is a must.",
    },
    { platform: "instagram", type: "comment", post: 0, text: "Is there a kids menu?" },
    { platform: "facebook", type: "comment", post: 0, text: "Are dogs allowed on the terrace?" },
    {
      platform: "youtube",
      type: "comment",
      post: 0,
      text: "What brand of soy sauce do you recommend for the tare?",
    },
  ]
  let i = 0
  while (out.length < 100) {
    make(filler[i % filler.length]!, { receivedAt: at(minutesAgo(14)) })
    i++
  }
  return out
}
