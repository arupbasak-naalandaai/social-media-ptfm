import { EventEmitter } from "node:events"
import pg from "pg"
import { INBOX_CHANNEL, type InboxEvent } from "@inbox/pipeline"
import type { Logger } from "@inbox/core/logger"

/**
 * One LISTEN connection per api process, fanned out to SSE subscribers by organization.
 * Works with any number of api replicas: every replica receives every NOTIFY.
 */
export class InboxEventBus {
  private readonly emitter = new EventEmitter()
  private client: pg.Client | null = null
  private stopped = false

  constructor(
    private readonly connectionString: string,
    private readonly logger: Logger,
  ) {
    this.emitter.setMaxListeners(0)
  }

  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString })
    client.on("notification", (msg) => {
      if (msg.channel !== INBOX_CHANNEL || !msg.payload) return
      try {
        const event = JSON.parse(msg.payload) as InboxEvent
        this.emitter.emit(event.organizationId, event)
      } catch (err) {
        this.logger.warn({ err }, "events: bad NOTIFY payload")
      }
    })
    client.on("error", (err) => {
      this.logger.error({ err }, "events: LISTEN connection error; reconnecting")
      void this.reconnect()
    })
    await client.connect()
    await client.query(`LISTEN ${INBOX_CHANNEL}`)
    this.client = client
    this.logger.info("events: listening for inbox events")
  }

  private async reconnect(): Promise<void> {
    const old = this.client
    this.client = null
    await old?.end().catch(() => {})
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        await this.connect()
        return
      } catch (err) {
        const delay = Math.min(30_000, 1000 * 2 ** attempt)
        this.logger.warn({ err, attempt, delay }, "events: reconnect failed")
        await new Promise((r) => setTimeout(r, delay))
      }
    }
  }

  subscribe(organizationId: string, listener: (event: InboxEvent) => void): () => void {
    this.emitter.on(organizationId, listener)
    return () => this.emitter.off(organizationId, listener)
  }

  /** In-process publish (tests, and api-side changes before NOTIFY round-trips). */
  publishLocal(event: InboxEvent): void {
    this.emitter.emit(event.organizationId, event)
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.client?.end().catch(() => {})
    this.client = null
  }
}

export interface EventSource {
  subscribe(organizationId: string, listener: (event: InboxEvent) => void): () => void
}
