import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import {
  LIST_KINDS_BY_LIST,
  createListEntrySchema,
  listKindSchema,
  listNameSchema,
  platformSchema,
  type ListEntryDto,
} from "@inbox/core"
import { Prisma, type ListEntry, type PrismaClient } from "@inbox/db"
import { notifyInbox } from "@inbox/pipeline"
import type { JobSender } from "../lib/jobs"
import { validate } from "../lib/validate"
import { requireAuth, requireRole } from "../middleware/session"
import type { AppEnv } from "../types"

export interface ListRouteDeps {
  prisma: PrismaClient
  jobs: JobSender
}

function toDto(row: ListEntry): ListEntryDto {
  return {
    id: row.id,
    list: listNameSchema.parse(row.list),
    kind: listKindSchema.parse(row.kind),
    value: row.value,
    platform: row.platform ? platformSchema.parse(row.platform) : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Normalizes values so matching is predictable: handles without "@", domains without "www.". */
function normalizeValue(kind: string, value: string): string {
  const v = value.trim()
  if (kind === "author_handle") return v.replace(/^@/, "").toLowerCase()
  if (kind === "domain")
    return v
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
  if (kind === "keyword") return v.toLowerCase()
  return v
}

export function listRoutes({ prisma, jobs }: ListRouteDeps) {
  async function changed(
    organizationId: string,
    actorId: string,
    requestId: string,
    action: string,
    entry: ListEntry,
  ) {
    await prisma.auditLog.create({
      data: {
        organizationId,
        actorId,
        action,
        entity: "list_entry",
        entityId: entry.id,
        after: { list: entry.list, kind: entry.kind, value: entry.value, platform: entry.platform },
      },
    })
    await notifyInbox(prisma, { type: "lists.changed", organizationId })
    await jobs.enqueueRefilter(organizationId, requestId)
  }

  return new Hono<AppEnv>()
    .use("*", requireAuth)

    .get("/", async (c) => {
      const org = c.get("org")!
      const rows = await prisma.listEntry.findMany({
        where: { organizationId: org.id },
        orderBy: [{ list: "asc" }, { createdAt: "asc" }],
      })
      return c.json({ entries: rows.map(toDto) })
    })

    .post("/", requireRole("admin"), validate("json", createListEntrySchema), async (c) => {
      const org = c.get("org")!
      const body = c.req.valid("json")
      if (!LIST_KINDS_BY_LIST[body.list].includes(body.kind)) {
        throw new HTTPException(400, {
          message: `The ${body.list} list doesn't take ${body.kind} entries`,
        })
      }
      try {
        const row = await prisma.listEntry.create({
          data: {
            organizationId: org.id,
            list: body.list,
            kind: body.kind,
            value: normalizeValue(body.kind, body.value),
            platform: body.platform,
            note: body.note ?? null,
            createdById: c.get("user")!.id,
          },
        })
        await changed(org.id, c.get("user")!.id, c.get("requestId"), "list_entry.create", row)
        return c.json(toDto(row), 201)
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new HTTPException(409, { message: "That entry is already on the list" })
        }
        throw err
      }
    })

    .delete(
      "/:id",
      requireRole("admin"),
      validate("param", z.object({ id: z.string().min(1) })),
      async (c) => {
        const org = c.get("org")!
        const { id } = c.req.valid("param")
        const row = await prisma.listEntry.findFirst({ where: { id, organizationId: org.id } })
        if (!row) throw new HTTPException(404, { message: "Entry not found" })
        await prisma.listEntry.delete({ where: { id } })
        await changed(org.id, c.get("user")!.id, c.get("requestId"), "list_entry.delete", row)
        return c.body(null, 204)
      },
    )
}
