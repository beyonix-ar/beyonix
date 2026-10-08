import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

test("proxy aplica CSP en producción con nonce y sin unsafe-eval", async () => {
  const previousEnv = process.env.NODE_ENV
  const previousMode = process.env.CSP_MODE
  Reflect.set(process.env, "NODE_ENV", "production")
  delete process.env.CSP_MODE

  try {
    const { proxy } = await import("../../proxy.ts")
    const response = await proxy(new NextRequest("https://beyonix.com.ar/"))
    const policy = response.headers.get("content-security-policy")

    assert.ok(policy)
    assert.equal(response.headers.has("content-security-policy-report-only"), false)
    assert.match(policy, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/)
    assert.match(policy, /style-src 'self' 'unsafe-inline'/)
    assert.match(policy, /img-src 'self' data: blob: https:/)
    assert.match(policy, /report-uri \/api\/csp-report/)
    assert.doesNotMatch(policy, /unsafe-eval|\*/)
  } finally {
    if (previousEnv === undefined) Reflect.deleteProperty(process.env, "NODE_ENV")
    else Reflect.set(process.env, "NODE_ENV", previousEnv)
    if (previousMode === undefined) delete process.env.CSP_MODE
    else process.env.CSP_MODE = previousMode
  }
})
