import { createHash, randomBytes } from "node:crypto"

export function normalizeGiftCardEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase()
}

export function isValidGiftCardEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export function createGiftCardClaimToken() {
  return randomBytes(32).toString("base64url")
}

export function hashGiftCardClaimToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function createGiftCardDisplayCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = randomBytes(12)
  const part = (offset: number) =>
    Array.from(bytes.subarray(offset, offset + 4), (byte) =>
      characters[byte % characters.length],
    ).join("")

  return `BX-GIFT-${part(0)}-${part(4)}-${part(8)}`
}

export function getGiftCardExpirationDate() {
  const date = new Date()
  date.setUTCFullYear(date.getUTCFullYear() + 1)
  return date.toISOString()
}

export function getPublicSiteUrl() {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.VERCEL_URL ||
    "https://beyonix.netlify.app"

  return (configured.startsWith("http") ? configured : `https://${configured}`).replace(
    /\/$/,
    "",
  )
}
