import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest, NextResponse } from "next/server"

import { createProxyCookieAdapter } from "./proxy-cookies.ts"

test("el refresh SSR actualiza request y response con las opciones seguras", () => {
  const request = new NextRequest("https://beyonix.com.ar/cuenta", {
    headers: { cookie: "sb-test-auth-token.0=old" },
  })
  const forwarded = new Headers(request.headers)
  const adapter = createProxyCookieAdapter(request, forwarded, () =>
    NextResponse.next({ request: { headers: forwarded } }),
  )
  const options = { path: "/", sameSite: "lax" as const, secure: true, httpOnly: false }

  adapter.cookies.setAll?.(
    [{ name: "sb-test-auth-token.0", value: "new", options }],
    { "Cache-Control": "private, no-store" },
  )

  assert.equal(request.cookies.get("sb-test-auth-token.0")?.value, "new")
  assert.match(forwarded.get("cookie") ?? "", /sb-test-auth-token\.0=new/)
  assert.equal(adapter.getResponse().cookies.get("sb-test-auth-token.0")?.value, "new")
  assert.match(adapter.getResponse().headers.get("set-cookie") ?? "", /Secure; SameSite=lax/i)
  assert.doesNotMatch(adapter.getResponse().headers.get("set-cookie") ?? "", /HttpOnly/i)
  assert.equal(adapter.getResponse().headers.get("cache-control"), "private, no-store")
})

test("logout elimina chunks y el redirect conserva Set-Cookie y no-store", () => {
  const request = new NextRequest("https://beyonix.com.ar/cuenta", {
    headers: { cookie: "sb-test-auth-token.0=old; sb-test-auth-token.1=old" },
  })
  const forwarded = new Headers(request.headers)
  const adapter = createProxyCookieAdapter(request, forwarded, () =>
    NextResponse.next({ request: { headers: forwarded } }),
  )
  const options = { path: "/", sameSite: "lax" as const, secure: true, httpOnly: false, maxAge: 0 }

  adapter.cookies.setAll?.(
    [{ name: "sb-test-auth-token.0", value: "", options }],
    { "Cache-Control": "private, no-store" },
  )
  adapter.cookies.setAll?.(
    [{ name: "sb-test-auth-token.1", value: "", options }],
    { "Cache-Control": "private, no-store" },
  )

  assert.equal(request.cookies.has("sb-test-auth-token.0"), false)
  assert.equal(request.cookies.has("sb-test-auth-token.1"), false)
  const redirect = adapter.redirect(new URL("https://beyonix.com.ar/login"))
  assert.equal(redirect.status, 307)
  assert.equal(redirect.cookies.getAll().length, 2)
  for (const cookie of redirect.cookies.getAll()) {
    assert.equal(cookie.maxAge, 0)
    assert.equal(cookie.secure, true)
    assert.equal(cookie.httpOnly, false)
    assert.equal(cookie.sameSite, "lax")
    assert.equal(cookie.path, "/")
  }
  assert.equal(redirect.headers.get("cache-control"), "private, no-store")
})
