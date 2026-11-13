/**
 * AES-256-GCM encryption for secrets at rest (platform tokens, app secrets, AI keys).
 *
 * Ciphertext format: `v1:<keyId>:<iv>:<tag>:<ct>` (each part base64url).
 * AAD = `organizationId|model|field`, so a ciphertext copied into another row or field
 * fails to decrypt. `keyId` is derived from the key itself, so rotating `ENCRYPTION_KEY`
 * (old key moved to `ENCRYPTION_KEYS_PREVIOUS`) keeps old values readable.
 *
 * Node-only: import from `@inbox/core/crypto`, never from the browser bundle.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const VERSION = "v1"
const IV_BYTES = 12
const KEY_BYTES = 32

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DecryptionError"
  }
}

export interface Keyring {
  /** Key id used for new ciphertexts. */
  readonly currentKeyId: string
  encrypt(plaintext: string, aad: string): string
  decrypt(ciphertext: string, aad: string): string
}

/** Stable, non-secret id for a key: first 8 bytes of SHA-256(key), base64url. */
export function keyIdFor(key: Buffer): string {
  return createHash("sha256").update(key).digest().subarray(0, 8).toString("base64url")
}

function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64.trim(), "base64")
  if (key.length !== KEY_BYTES) throw new Error("Encryption keys must be 32 bytes, base64")
  return key
}

/**
 * @param current  ENCRYPTION_KEY (base64, 32 bytes): used for new values.
 * @param previous ENCRYPTION_KEYS_PREVIOUS (comma-separated base64 keys): decrypt only.
 */
export function createKeyring(current: string, previous: string | string[] = []): Keyring {
  const currentKey = parseKey(current)
  const currentKeyId = keyIdFor(currentKey)
  const keys = new Map<string, Buffer>([[currentKeyId, currentKey]])
  const prev = Array.isArray(previous) ? previous : previous.split(",")
  for (const p of prev) {
    if (!p.trim()) continue
    const k = parseKey(p)
    keys.set(keyIdFor(k), k)
  }

  return {
    currentKeyId,
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", currentKey, iv)
      cipher.setAAD(Buffer.from(aad, "utf8"))
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return [VERSION, currentKeyId, iv, tag, ct]
        .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
        .join(":")
    },
    decrypt(ciphertext, aad) {
      const parts = ciphertext.split(":")
      if (parts.length !== 5 || parts[0] !== VERSION) {
        throw new DecryptionError("Unrecognized ciphertext format")
      }
      const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string]
      const key = keys.get(keyId)
      if (!key) throw new DecryptionError(`Unknown encryption key id ${keyId}`)
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"))
        decipher.setAAD(Buffer.from(aad, "utf8"))
        decipher.setAuthTag(Buffer.from(tagB64, "base64url"))
        return Buffer.concat([
          decipher.update(Buffer.from(ctB64, "base64url")),
          decipher.final(),
        ]).toString("utf8")
      } catch {
        throw new DecryptionError("Ciphertext failed authentication (tampered, or wrong row/field)")
      }
    },
  }
}

/** AAD binding a ciphertext to one organization, model and field. */
export function aadFor(organizationId: string, model: string, field: string): string {
  return `${organizationId}|${model}|${field}`
}
