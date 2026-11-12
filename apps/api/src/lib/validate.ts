import { zValidator } from "@hono/zod-validator"
import type { ValidationTargets } from "hono"
import type { z } from "zod"

/** zod validation with a consistent 400 body: { error, issues: [{ path, message }] }. */
export function validate<T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: "Invalid request",
          issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
        400,
      )
    }
  })
}
