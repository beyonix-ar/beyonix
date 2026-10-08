import assert from "node:assert/strict"
import test from "node:test"

import { getTrustedClientIp } from "./trusted-client-ip.ts"

test("la limitación de auth ignora cabeceras de IP aportadas por el cliente", () => {
  const request = new Request("https://beyonix.com.ar/api/auth/forgot-password", {
    headers: {
      "cf-connecting-ip": "203.0.113.1",
      "x-forwarded-for": "203.0.113.2",
      "x-nf-client-connection-ip": "203.0.113.3",
    },
  })
  assert.equal(getTrustedClientIp(request), null)
  request.headers.set("x-real-ip", "198.51.100.4")
  assert.equal(getTrustedClientIp(request), "198.51.100.4")
})
