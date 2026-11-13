/**
 * Poll adapters: one per platform stream, registered as each platform phase lands.
 * Phase 3 ships only the demo adapter (seeded demo accounts), so the scheduler can be watched
 * end to end locally without real connections.
 */
import type { NormalizedItem, Platform, SyncStreamKey } from "@inbox/core"
import type { Keyring } from "@inbox/core/crypto"
import type { Logger } from "@inbox/core/logger"
import type { PlatformAccount, PrismaClient, SyncState } from "@inbox/db"

export interface PollContext {
  prisma: PrismaClient
  keyring: Keyring
  logger: Logger
  account: PlatformAccount
  state: SyncState
  stream: SyncStreamKey
  /** Abort when the job is cancelled or the worker shuts down. */
  signal: AbortSignal
}

export interface PollResult {
  items: NormalizedItem[]
  /** New cursor to store; undefined = keep the current one. */
  cursor?: string | null | undefined
  /** YouTube units (or other quota) this poll used. */
  quotaUnits?: number | undefined
}

export type PollAdapter = (ctx: PollContext) => Promise<PollResult>

/** Phase that builds each platform's sync, for the "not built yet" message. */
const PHASE_FOR: Record<SyncStreamKey, number> = {
  gbp_reviews: 4,
  fb_comments: 5,
  ig_comments: 5,
  yt_comments: 6,
  fb_dms: 7,
  ig_dms: 7,
  li_comments: 9,
}

const adapters = new Map<SyncStreamKey, PollAdapter>()

export function registerPollAdapter(stream: SyncStreamKey, adapter: PollAdapter): void {
  adapters.set(stream, adapter)
}

/** Seeded demo accounts: a successful poll that finds nothing new. */
const demoAdapter: PollAdapter = async () => ({ items: [] })

export class AdapterMissingError extends Error {
  constructor(stream: SyncStreamKey, platform: Platform) {
    super(
      `Syncing ${platform} (${stream}) isn't built yet: it arrives in Phase ${PHASE_FOR[stream]}`,
    )
    this.name = "AdapterMissingError"
  }
}

export function pollAdapterFor(account: PlatformAccount, stream: SyncStreamKey): PollAdapter {
  const meta = account.meta as { demo?: unknown } | null
  if (meta && typeof meta === "object" && meta.demo === true) return demoAdapter
  const adapter = adapters.get(stream)
  if (!adapter) throw new AdapterMissingError(stream, account.platform as Platform)
  return adapter
}
