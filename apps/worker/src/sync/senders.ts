/**
 * Reply senders, one per platform, registered as each platform phase lands (Google in this
 * phase's Google slice). Seeded demo accounts use a sender that posts nothing.
 */
import type { Keyring } from "@inbox/core/crypto"
import type { PlatformAccount, PrismaClient } from "@inbox/db"
import { isDemoAccount, ReplySendError, type ReplySender } from "@inbox/pipeline"

export type SenderFactory = (deps: { prisma: PrismaClient; keyring: Keyring }) => ReplySender

const factories = new Map<string, SenderFactory>()

export function registerReplySender(platform: string, factory: SenderFactory): void {
  factories.set(platform, factory)
}

/** Demo accounts: "sends" locally so the whole flow can be tried; nothing is posted. */
const demoSender: ReplySender = {
  idempotent: true,
  async send({ reply }) {
    return { externalReplyId: `demo:${reply.id}` }
  },
}

export function senderResolver(deps: { prisma: PrismaClient; keyring: Keyring }) {
  return (account: PlatformAccount): ReplySender => {
    if (isDemoAccount(account)) return demoSender
    const factory = factories.get(account.platform)
    if (!factory) {
      return {
        idempotent: true,
        async send() {
          throw new ReplySendError(`Replying on ${account.platform} isn't built yet`, false)
        },
      }
    }
    return factory(deps)
  }
}
