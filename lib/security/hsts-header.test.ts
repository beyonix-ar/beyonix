import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"

// HSTS de producción: un año en el dominio principal.
// Deliberadamente SIN includeSubDomains ni preload (ver comentario en
// next.config.mjs). El header se genera exclusivamente ahí -- CSP depende de
// un nonce por request y vive en proxy.ts, no en este archivo.
const source = readFileSync(join(process.cwd(), "next.config.mjs"), "utf8")

test("el header Strict-Transport-Security se declara una única vez", () => {
  const occurrences = source.match(/Strict-Transport-Security/g) ?? []
  assert.equal(occurrences.length, 1)
})

test("max-age quedó en 31536000 (un año)", () => {
  const match = source.match(/key: "Strict-Transport-Security",\s*value: "([^"]+)"/)
  assert.ok(match, "no se encontró la declaración de Strict-Transport-Security")
  assert.equal(match![1], "max-age=31536000")
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
    /process\.env\.NODE_ENV === "production"\s*\n\s*\? \[\{ key: "Strict-Transport-Security", value: "max-age=31536000" \}\]\s*\n\s*: \[\]/,
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
    /key: "Permissions-Policy",\s*\n\s*value: "camera=\(self\), microphone=\(\), geolocation=\(\), payment=\(self\)",/,
  )
})

// Con camera=() Chrome rechaza getUserMedia (NotAllowedError) sin mostrar el
// pedido de permiso: el escáner de Despachos quedaba siempre "denegado".
test("Permissions-Policy habilita la cámara sólo para el propio origen, en todas las rutas", async () => {
  const { default: config } = await import(pathToFileURL(join(process.cwd(), "next.config.mjs")).href)
  const rules = await config.headers()
  const policies = rules.flatMap((rule: { source: string; headers: Array<{ key: string; value: string }> }) =>
    rule.headers.filter((header) => header.key === "Permissions-Policy").map((header) => ({ source: rule.source, value: header.value })))
  assert.deepEqual(policies.map((policy: { source: string }) => policy.source), ["/:path*"])
  const camera = policies[0].value.split(",").map((item: string) => item.trim()).find((item: string) => item.startsWith("camera="))
  assert.equal(camera, "camera=(self)")
  assert.match(policies[0].value, /microphone=\(\)/)
})

test("Next.js no expone X-Powered-By", () => {
  assert.match(source, /poweredByHeader:\s*false/)
})
