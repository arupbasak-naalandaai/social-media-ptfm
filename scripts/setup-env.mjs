// `pnpm setup:env`: creates the root .env from .env.example (if missing) and fills the
// generated secrets (BETTER_AUTH_SECRET, ENCRYPTION_KEY) when they're empty.
// Never overwrites a value that is already set: replacing ENCRYPTION_KEY would make every
// stored secret unreadable.
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const envPath = path.join(root, ".env")
const examplePath = path.join(root, ".env.example")

const GENERATED = ["BETTER_AUTH_SECRET", "ENCRYPTION_KEY"]
const YOU_PROVIDE = {
  GOOGLE_CLIENT_ID: "Google OAuth client (sign-in, Business Profile and YouTube)",
  GOOGLE_CLIENT_SECRET: "Google OAuth client secret",
}

if (!existsSync(envPath)) {
  copyFileSync(examplePath, envPath)
  console.log("Created .env from .env.example")
}

const lines = readFileSync(envPath, "utf8").split("\n")
const values = new Map()
const filled = []

for (let i = 0; i < lines.length; i++) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(lines[i])
  if (!m) continue
  const [, name, raw] = m
  let value = raw.trim()
  if (GENERATED.includes(name) && value === "") {
    value = randomBytes(32).toString("base64")
    lines[i] = `${name}=${value}`
    filled.push(name)
  }
  values.set(name, value)
}

for (const name of GENERATED) {
  if (!values.has(name)) {
    lines.push(`${name}=${randomBytes(32).toString("base64")}`)
    filled.push(name)
  }
}

if (filled.length) {
  writeFileSync(envPath, lines.join("\n"))
  console.log(`Generated: ${filled.join(", ")}`)
} else {
  console.log("Generated secrets are already set (left unchanged).")
}

const missing = Object.entries(YOU_PROVIDE).filter(([name]) => !values.get(name))
if (missing.length) {
  console.log("\nStill to fill in .env:")
  for (const [name, what] of missing) console.log(`  ${name}  ${what}`)
} else {
  console.log("\n.env is ready. Everything else is set up in the app (Settings / Connections).")
}
