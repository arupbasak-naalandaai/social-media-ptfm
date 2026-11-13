/**
 * pnpm simulate:webhook meta <fixture> [--account <externalId>] [--text "…"] [--org <id>]
 *
 * Signs a Meta webhook fixture with the workspace's Meta app secret (Settings → Connections)
 * and POSTs it to the local api, exactly like Meta would. Ids and timestamps are made fresh on
 * every run, so each run creates a new comment/DM. Use it to check the whole path locally:
 * webhook → Activity log → worker ingest → filters → inbox → AI drafts → reply.
 *
 * Fixtures: packages/core/fixtures/meta/{fb-comment,ig-comment,fb-dm,ig-dm}.json (or a path).
 * By default the event targets the first Facebook/Instagram account of the workspace (the
 * seeded demo accounts work, and replying to them posts nothing).
 */
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import { createKeyring } from "@inbox/core/crypto"
import { createPrismaClient } from "@inbox/db"
import { signMetaBody } from "../meta"
import { loadSettingsSecret } from "../settings"

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../../../.env"))
} catch {
  // rely on process.env
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    account: { type: "string" },
    text: { type: "string" },
    org: { type: "string" },
    url: { type: "string" },
  },
})
const [source, fixtureArg] = positionals
const FIXTURES = path.resolve(import.meta.dirname, "../../../core/fixtures/meta")

function usage(msg?: string): never {
  if (msg) console.error(`✗ ${msg}\n`)
  console.error(
    'Usage: pnpm simulate:webhook meta <fb-comment|ig-comment|fb-dm|ig-dm|path.json> [--account <id>] [--text "…"]',
  )
  process.exit(1)
}

if (source !== "meta") usage("Only Meta webhooks can be simulated (YouTube is polling only).")
if (!fixtureArg) usage("Name a fixture.")
const file = existsSync(fixtureArg)
  ? fixtureArg
  : path.join(FIXTURES, fixtureArg.endsWith(".json") ? fixtureArg : `${fixtureArg}.json`)
if (!existsSync(file)) usage(`No fixture at ${file}`)

const key = process.env.ENCRYPTION_KEY
if (!key) usage("ENCRYPTION_KEY isn't set (.env).")
const keyring = createKeyring(key, process.env.ENCRYPTION_KEYS_PREVIOUS)
const prisma = createPrismaClient()

interface Payload {
  object: string
  entry: {
    id: string
    time?: number
    changes?: { field: string; value: Record<string, unknown> }[]
    messaging?: {
      sender: { id: string }
      recipient: { id: string }
      timestamp: number
      message?: Record<string, unknown>
    }[]
  }[]
}

try {
  const payload = JSON.parse(readFileSync(file, "utf8")) as Payload
  const platform = payload.object === "instagram" ? "instagram" : "facebook"

  const account = await prisma.platformAccount.findFirst({
    where: {
      platform,
      OR: [{ status: { not: "disconnected" } }, { meta: { path: ["demo"], equals: true } }],
      ...(values.account ? { externalId: values.account } : {}),
      ...(values.org ? { organizationId: values.org } : {}),
    },
    orderBy: { createdAt: "asc" },
  })
  if (!account) {
    usage(
      `No connected ${platform} account${values.account ? ` "${values.account}"` : ""}. Connect one, or run pnpm db:seed for the demo accounts.`,
    )
  }
  const appSecret = await loadSettingsSecret(
    prisma,
    keyring,
    account.organizationId,
    "connections",
    "metaAppSecret",
  )
  if (!appSecret) {
    usage(
      "This workspace has no Meta app secret. Save any value in Settings → Connections → Meta → App secret (the api checks signatures with it).",
    )
  }

  // Fresh ids + times so every run is a new item; target the chosen account.
  const nowMs = Date.now()
  const suffix = nowMs.toString(36)
  for (const e of payload.entry) {
    const old = e.id
    e.id = account.externalId
    e.time = e.time && e.time > 1e12 ? nowMs : Math.floor(nowMs / 1000)
    for (const c of e.changes ?? []) {
      const v = c.value
      if (typeof v.comment_id === "string") v.comment_id = `${v.comment_id}_${suffix}`
      if (typeof v.id === "string") v.id = `${v.id}${suffix}`
      if (typeof v.created_time === "number") v.created_time = Math.floor(nowMs / 1000)
      if (values.text) {
        if ("message" in v) v.message = values.text
        if ("text" in v) v.text = values.text
      }
    }
    for (const m of e.messaging ?? []) {
      if (m.recipient.id === old) m.recipient.id = account.externalId
      if (m.sender.id === old) m.sender.id = account.externalId
      m.timestamp = nowMs
      if (m.message) {
        m.message.mid = `${String(m.message.mid)}_${suffix}`
        if (values.text) m.message.text = values.text
      }
    }
  }

  const body = JSON.stringify(payload)
  const api = values.url ?? `http://localhost:${process.env.API_PORT ?? "3001"}`
  const res = await fetch(`${api}/webhooks/meta`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signMetaBody(body, appSecret),
    },
    body,
  })
  const text = await res.text()
  if (!res.ok) usage(`api answered ${res.status}: ${text}`)
  console.log(
    `✓ ${path.basename(file)} → ${account.displayName} (${platform} ${account.externalId}): ${res.status} ${text}`,
  )
  console.log(
    "  Check Activity log → Webhooks, then the inbox. The worker must be running (pnpm dev).",
  )
} finally {
  await prisma.$disconnect()
}
