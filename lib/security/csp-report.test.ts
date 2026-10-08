import assert from "node:assert/strict"
import test from "node:test"

import { NextRequest } from "next/server"

import { POST } from "../../app/api/csp-report/route.ts"

test("CSP report rechaza body mayor a 8 KB aunque no haya Content-Length", async () => {
  let reads = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1
      controller.enqueue(new Uint8Array(4_100))
      if (reads === 3) controller.close()
    },
  })
  const init = { method: "POST", body, duplex: "half" as const }
  const request = new NextRequest("https://beyonix.com.ar/api/csp-report", init)
  assert.equal(request.headers.has("content-length"), false)
  const response = await POST(request)
  assert.equal(response.status, 413)
  assert.ok(reads <= 3)
})

test("CSP report no registra query strings ni tokens de URLs bloqueadas", async () => {
  const warnings: unknown[][] = []
  const previousWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    const request = new NextRequest("https://beyonix.com.ar/api/csp-report", {
      method: "POST",
      body: JSON.stringify({
        "csp-report": {
          "document-uri": "https://beyonix.com.ar/checkout?token=secreto",
          "blocked-uri": "https://externo.example/foto?access_token=secreto",
          "violated-directive": "img-src",
        },
      }),
    })
    const response = await POST(request)
    assert.equal(response.status, 204)
    assert.equal(warnings.length, 1)
    const logged = JSON.stringify(warnings[0])
    assert.doesNotMatch(logged, /secreto|access_token/)
    assert.match(logged, /externo\.example/)
  } finally {
    console.warn = previousWarn
  }
})
