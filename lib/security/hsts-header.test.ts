import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

// Tercera fase de HSTS: 24hs (max-age=86400) -> 7 días (max-age=604800).
// Deliberadamente SIN includeSubDomains ni preload todavía (ver comentario en
// next.config.mjs). El header se genera exclusivamente ahí -- CSP depende de
// un nonce por request y vive en proxy.ts, no en este archivo.
const source = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8")

test("el header Strict-Transport-Security se declara una única vez", () => {
  const occurrences = source.match(/Strict-Transport-Security/g) ?? []
  assert.equal(occurrences.length, 1)
})

test("max-age quedó en 604800 (7 días), reemplazando los 86400 (24hs) anteriores", () => {
  const match = source.match(/key: "Strict-Transport-Security",\s*value: "([^"]+)"/)
  assert.ok(match, "no se encontró la declaración de Strict-Transport-Security")
  assert.equal(match![1], "max-age=604800")
  assert.doesNotMatch(source, /max-age=86400/)
})

test("no se agregó includeSubDomains ni preload al valor del header", () => {
  const match = source.match(/key: "Strict-Transport-Security",\s*value: "([^"]+)"/)
  assert.ok(match)
  assert.doesNotMatch(match![1], /includeSubDomains/)
  assert.doesNotMatch(match![1], /preload/)
})

test("el header sólo aplica en producción (nunca en next dev)", () => {
  assert.match(
    source,
    /process\.env\.NODE_ENV === "production"\s*\n\s*\? \[\{ key: "Strict-Transport-Security", value: "max-age=604800" \}\]\s*\n\s*: \[\]/,
  )
})

test("CSP no se define como header en next.config.mjs (vive en proxy.ts, sin tocar acá)", () => {
  assert.doesNotMatch(source, /key:\s*"Content-Security-Policy"/)
})

test("el resto de los headers de seguridad estáticos no cambió", () => {
  assert.match(source, /key: "X-Content-Type-Options", value: "nosniff"/)
  assert.match(source, /key: "X-Frame-Options", value: "SAMEORIGIN"/)
  assert.match(
    source,
    /key: "Referrer-Policy", value: "strict-origin-when-cross-origin"/,
  )
  assert.match(
    source,
    /key: "Permissions-Policy",\s*\n\s*value: "camera=\(\), microphone=\(\), geolocation=\(\), payment=\(self\)",/,
  )
})
