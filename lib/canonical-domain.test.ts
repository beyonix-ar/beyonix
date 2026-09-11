import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { getCanonicalWwwRedirectUrl } from "./canonical-domain.ts"

// Canonicalización www.beyonix.com.ar -> beyonix.com.ar. getCanonicalWwwRedirectUrl
// es la función real que usa proxy.ts (no una reimplementación) -- se probó
// acá, aislada de next/server y Supabase, porque importar proxy.ts directo
// arrastra "next/server" y no resuelve bajo node plano sin bundler.
const proxySource = readFileSync(join(process.cwd(), "proxy.ts"), "utf8")

test("www raíz redirige al apex raíz", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/", ""),
    "https://beyonix.com.ar/",
  )
})

test("www /productos conserva el path exacto", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", ""),
    "https://beyonix.com.ar/productos",
  )
})

test("www con query string conserva la query exacta, incluido orden y múltiples params", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", "?id=123&x=abc"),
    "https://beyonix.com.ar/productos?id=123&x=abc",
  )
})

test("el apex (sin www) nunca redirige", () => {
  assert.equal(getCanonicalWwwRedirectUrl("beyonix.com.ar", "/productos", "?id=123"), null)
  assert.equal(getCanonicalWwwRedirectUrl("beyonix.com.ar", "/", ""), null)
})

test("localhost/dev nunca redirige", () => {
  assert.equal(getCanonicalWwwRedirectUrl("localhost", "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("127.0.0.1", "/productos", ""), null)
})

test("hosts de preview/otros dominios nunca redirigen (match exacto, no parcial)", () => {
  assert.equal(getCanonicalWwwRedirectUrl("beyonix-web.vercel.app", "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("www.beyonix.com.ar.evil.com", "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("notwww.beyonix.com.ar", "/", ""), null)
})

test("nunca hay loop: el destino jamás resuelve de nuevo a un hostname con www", () => {
  const redirected = getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", "?id=123")
  assert.ok(redirected)
  assert.equal(new URL(redirected!).hostname, "beyonix.com.ar")
  assert.equal(getCanonicalWwwRedirectUrl(new URL(redirected!).hostname, "/productos", "?id=123"), null)
})

test("el destino siempre apunta exclusivamente a https://beyonix.com.ar, nunca a otro origin", () => {
  for (const [pathname, search] of [
    ["/", ""],
    ["/productos", ""],
    ["/productos", "?id=123"],
    ["/cuenta/pedidos", "?estado=pendiente"],
  ] as const) {
    const redirected = getCanonicalWwwRedirectUrl("www.beyonix.com.ar", pathname, search)
    assert.ok(redirected)
    assert.match(redirected!, /^https:\/\/beyonix\.com\.ar\//)
  }
})

test("proxy.ts usa esta misma función ANTES de generar el nonce/CSP y antes de tocar Supabase Auth", () => {
  assert.match(proxySource, /from "@\/lib\/canonical-domain"/)
  const callIndex = proxySource.indexOf("getCanonicalWwwRedirectUrl(", proxySource.indexOf("import"))
  const usageIndex = proxySource.indexOf(
    "getCanonicalWwwRedirectUrl(",
    proxySource.indexOf("export async function proxy"),
  )
  const nonceIndex = proxySource.indexOf("generateNonce()", usageIndex)
  const authIndex = proxySource.indexOf("supabase.auth.getUser()")
  assert.ok(callIndex > 0)
  assert.ok(usageIndex > 0, "debe llamarse dentro de proxy()")
  assert.ok(nonceIndex > usageIndex, "el nonce se genera después de la canonicalización")
  assert.ok(authIndex > usageIndex, "Supabase Auth se consulta después de la canonicalización")
  assert.match(
    proxySource,
    /if \(canonicalRedirectUrl\) \{\s*\n\s*return NextResponse\.redirect\(canonicalRedirectUrl, 301\)/,
  )
})

test("el destino nunca se construye desde headers del cliente (Host/X-Forwarded-Host)", () => {
  assert.doesNotMatch(proxySource, /x-forwarded-host/i)
})
