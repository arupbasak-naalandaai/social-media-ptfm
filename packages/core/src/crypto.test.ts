import { randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { aadFor, createKeyring, DecryptionError, keyIdFor } from "./crypto"

const keyA = randomBytes(32).toString("base64")
const keyB = randomBytes(32).toString("base64")
const aad = aadFor("org-1", "settings", "connections.metaAppSecret")

describe("keyring", () => {
  it("round-trips, including unicode and empty strings", () => {
    const ring = createKeyring(keyA)
    for (const value of ["s3cret", "", "ключ 🔑 with spaces"]) {
      const ct = ring.encrypt(value, aad)
      expect(ct).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+:[\w-]*$/)
      expect(ct).not.toContain(value || "\u0000")
      expect(ring.decrypt(ct, aad)).toBe(value)
    }
  })

  it("uses a fresh IV every time", () => {
    const ring = createKeyring(keyA)
    expect(ring.encrypt("same", aad)).not.toBe(ring.encrypt("same", aad))
  })

  it("rejects a tampered ciphertext", () => {
    const ring = createKeyring(keyA)
    const parts = ring.encrypt("secret value", aad).split(":")
    const ct = Buffer.from(parts[4]!, "base64url")
    ct[0] = ct[0]! ^ 0xff
    parts[4] = ct.toString("base64url")
    expect(() => ring.decrypt(parts.join(":"), aad)).toThrow(DecryptionError)
  })

  it("rejects a tampered tag", () => {
    const ring = createKeyring(keyA)
    const parts = ring.encrypt("secret value", aad).split(":")
    parts[3] = Buffer.alloc(16).toString("base64url")
    expect(() => ring.decrypt(parts.join(":"), aad)).toThrow(DecryptionError)
  })

  it("rejects the wrong AAD (copied to another org, model or field)", () => {
    const ring = createKeyring(keyA)
    const ct = ring.encrypt("secret", aad)
    expect(() =>
      ring.decrypt(ct, aadFor("org-2", "settings", "connections.metaAppSecret")),
    ).toThrow(DecryptionError)
    expect(() => ring.decrypt(ct, aadFor("org-1", "settings", "ai.openaiApiKey"))).toThrow(
      DecryptionError,
    )
  })

  it("rejects unknown formats and key ids", () => {
    const ring = createKeyring(keyA)
    expect(() => ring.decrypt("plaintext", aad)).toThrow(DecryptionError)
    const other = createKeyring(keyB).encrypt("x", aad)
    expect(() => ring.decrypt(other, aad)).toThrow(/Unknown encryption key id/)
  })

  it("decrypts values written with a previous key after rotation", () => {
    const old = createKeyring(keyA).encrypt("old secret", aad)
    const rotated = createKeyring(keyB, `${keyA}, `)
    expect(rotated.decrypt(old, aad)).toBe("old secret")
    expect(rotated.encrypt("new", aad).split(":")[1]).toBe(keyIdFor(Buffer.from(keyB, "base64")))
  })

  it("refuses keys that are not 32 bytes", () => {
    expect(() => createKeyring(randomBytes(16).toString("base64"))).toThrow(/32 bytes/)
  })
})
