import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

import { getCanonicalWwwRedirectUrl } from "./canonical-domain.ts"

// Canonicalización www.beyonix.com.ar -> beyonix.com.ar. getCanonicalWwwRedirectUrl
// es la función real que usa proxy.ts (no una reimplementación) -- se probó
// acá, aislada de next/server y Supabase, porque importar proxy.ts directo
// arrastra "next/server" y no resuelve bajo node plano sin bundler.
//
// CAUSA RAÍZ CONFIRMADA EN PRODUCCIÓN (detrás de Nginx): `request.nextUrl.hostname`
// no refleja el header HTTP `Host` real -- `curl -H "Host: www.beyonix.com.ar"
// http://127.0.0.1:3000/...` daba 200 en vez de 301 pese a que Nginx ya hace
// `proxy_set_header Host $host` correctamente. La función ahora recibe el
// header `Host` CRUDO (primer argumento = `request.headers.get("host")`,
// nunca `nextUrl.hostname`) y lo normaliza ella misma (trim, lowercase,
// quitar sólo el puerto final).
const proxySource = readFileSync(join(process.cwd(), "proxy.ts"), "utf8")
const canonicalDomainSource = readFileSync(
  join(process.cwd(), "lib/canonical-domain.ts"),
  "utf8",
)

test("Host: www.beyonix.com.ar -> redirect", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", "?id=123"),
    "https://beyonix.com.ar/productos?id=123",
  )
})

test("Host: www.beyonix.com.ar:443 -> redirect (puerto final se ignora)", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar:443", "/productos", "?id=123"),
    "https://beyonix.com.ar/productos?id=123",
  )
})

test("Host: www.beyonix.com.ar:3000 -> redirect (puerto final se ignora)", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar:3000", "/productos", "?id=123"),
    "https://beyonix.com.ar/productos?id=123",
  )
})

test("Host con mayúsculas/espacios (típico de algunos clientes/proxies) también matchea", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("  WWW.BEYONIX.COM.AR:3000  ", "/", ""),
    "https://beyonix.com.ar/",
  )
})

test("Host: beyonix.com.ar -> no redirect", () => {
  assert.equal(getCanonicalWwwRedirectUrl("beyonix.com.ar", "/productos", "?id=123"), null)
  assert.equal(getCanonicalWwwRedirectUrl("beyonix.com.ar:443", "/", ""), null)
})

test("Host: localhost:3000 -> no redirect", () => {
  assert.equal(getCanonicalWwwRedirectUrl("localhost:3000", "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("127.0.0.1:3000", "/productos", ""), null)
})

test("Host: www.beyonix.com.ar.evil.com -> no redirect (match exacto, no sufijo/prefijo)", () => {
  assert.equal(getCanonicalWwwRedirectUrl("www.beyonix.com.ar.evil.com", "/", ""), null)
})

test("Host: evilwww.beyonix.com.ar -> no redirect", () => {
  assert.equal(getCanonicalWwwRedirectUrl("evilwww.beyonix.com.ar", "/", ""), null)
})

test("Host vacío/null -> no redirect", () => {
  assert.equal(getCanonicalWwwRedirectUrl(null, "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("", "/", ""), null)
  assert.equal(getCanonicalWwwRedirectUrl("   ", "/", ""), null)
})

test("www raíz redirige al apex raíz", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/", ""),
    "https://beyonix.com.ar/",
  )
})

test("www con query string conserva la query exacta, incluido orden y múltiples params", () => {
  assert.equal(
    getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", "?id=123&x=abc"),
    "https://beyonix.com.ar/productos?id=123&x=abc",
  )
})

test("nunca hay loop: el destino jamás resuelve de nuevo a un Host con www", () => {
  const redirected = getCanonicalWwwRedirectUrl("www.beyonix.com.ar", "/productos", "?id=123")
  assert.ok(redirected)
  const destinationHost = new URL(redirected!).hostname
  assert.equal(destinationHost, "beyonix.com.ar")
  assert.equal(getCanonicalWwwRedirectUrl(destinationHost, "/productos", "?id=123"), null)
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

test("proxy.ts lee el header Host CRUDO (nunca nextUrl.hostname) y llama a la función ANTES de nonce/CSP/auth", () => {
  assert.match(proxySource, /from "@\/lib\/canonical-domain"/)
  assert.match(proxySource, /getCanonicalWwwRedirectUrl\(\s*\n\s*request\.headers\.get\("host"\)/)
  assert.doesNotMatch(proxySource, /getCanonicalWwwRedirectUrl\([^)]*nextUrl\.hostname/)

  const usageIndex = proxySource.indexOf(
    "getCanonicalWwwRedirectUrl(",
    proxySource.indexOf("export async function proxy"),
  )
  const nonceIndex = proxySource.indexOf("generateNonce()", usageIndex)
  const authIndex = proxySource.indexOf("supabase.auth.getUser()")
  assert.ok(usageIndex > 0, "debe llamarse dentro de proxy()")
  assert.ok(nonceIndex > usageIndex, "el nonce se genera después de la canonicalización")
  assert.ok(authIndex > usageIndex, "Supabase Auth se consulta después de la canonicalización")
  assert.match(
    proxySource,
    /if \(canonicalRedirectUrl\) \{\s*\n\s*return NextResponse\.redirect\(canonicalRedirectUrl, 301\)/,
  )
})

test("el destino nunca se construye desde headers del cliente (Host/X-Forwarded-Host/Origin/Referer)", () => {
  for (const source of [proxySource, canonicalDomainSource]) {
    assert.doesNotMatch(source, /headers\.get\(\s*["']x-forwarded-host["']/i)
    assert.doesNotMatch(source, /headers\.get\(\s*["']origin["']/i)
    assert.doesNotMatch(source, /headers\.get\(\s*["']referer["']/i)
  }
  // CANONICAL_ORIGIN es un string literal fijo -- nunca se reasigna ni se
  // interpola con el hostHeader recibido; sólo se usa como condición booleana.
  assert.match(
    canonicalDomainSource,
    /const CANONICAL_ORIGIN = "https:\/\/beyonix\.com\.ar"/,
  )
  assert.doesNotMatch(canonicalDomainSource, /new URL\([^)]*hostHeader/)
})
