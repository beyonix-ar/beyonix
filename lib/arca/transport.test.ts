import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer } from "node:https"
import { fileURLToPath } from "node:url"
import test from "node:test"

import forge from "node-forge"
import { Agent, getGlobalDispatcher } from "undici"

import { arcaFetch, getArcaTlsDispatcher, WSFE_PRODUCTION_URL } from "./transport.ts"

const WSFE_HOMOLOGATION_URL = "https://wswhomo.afip.gov.ar/wsfev1/service.asmx"
const WSAA_PRODUCTION_URL = "https://wsaa.afip.gov.ar/ws/services/LoginCms"

test("el dispatcher TLS legado se reutiliza sólo para el endpoint exacto de WSFE PROD", () => {
  const dispatcher = getArcaTlsDispatcher(WSFE_PRODUCTION_URL)
  assert.ok(dispatcher instanceof Agent)
  assert.equal(getArcaTlsDispatcher(WSFE_PRODUCTION_URL), dispatcher)
  for (const url of [
    WSFE_HOMOLOGATION_URL,
    WSAA_PRODUCTION_URL,
    "https://servicios1.afip.gov.ar/otro-servicio",
    "https://otro-dominio.example/wsfev1/service.asmx",
  ]) {
    assert.equal(getArcaTlsDispatcher(url), undefined, url)
  }
})

test("WSFE PROD entrega la solicitud al agente local sin cambiar el dispatcher global", async (context) => {
  const dispatcher = getArcaTlsDispatcher(WSFE_PRODUCTION_URL)
  assert.ok(dispatcher)
  const globalDispatcher = getGlobalDispatcher()
  const originalFetch = globalThis.fetch
  let dispatched = false
  context.mock.method(dispatcher, "dispatch", () => {
    dispatched = true
    throw new Error("Intercepción local de prueba")
  })
  globalThis.fetch = async () => { throw new Error("No debe usar fetch global") }

  try {
    await assert.rejects(arcaFetch(WSFE_PRODUCTION_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml" },
      body: "<test/>",
      cache: "no-store",
      signal: AbortSignal.timeout(1_000),
    }))
    assert.equal(dispatched, true)
    assert.equal(getGlobalDispatcher(), globalDispatcher)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("WSAA, homologación y otros fetch conservan el transporte global", async () => {
  const globalDispatcher = getGlobalDispatcher()
  const originalFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    assert.equal(Object.hasOwn(init ?? {}, "dispatcher"), false)
    return new Response("ok")
  }

  try {
    const init = {
      method: "POST" as const,
      headers: { "Content-Type": "text/xml" },
      body: "<test/>",
      cache: "no-store" as const,
      signal: AbortSignal.timeout(1_000),
    }
    for (const url of [WSFE_HOMOLOGATION_URL, WSAA_PRODUCTION_URL, "https://example.com/api"]) {
      assert.equal((await arcaFetch(url, init)).status, 200)
    }
    assert.deepEqual(urls, [WSFE_HOMOLOGATION_URL, WSAA_PRODUCTION_URL, "https://example.com/api"])
    assert.equal(getGlobalDispatcher(), globalDispatcher)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("el agente ARCA sigue rechazando certificados HTTPS no confiables", async () => {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keys.publicKey
  certificate.serialNumber = "01"
  certificate.validity.notBefore = new Date(Date.now() - 60_000)
  certificate.validity.notAfter = new Date(Date.now() + 60_000)
  certificate.setSubject([{ name: "commonName", value: "localhost" }])
  certificate.setIssuer([{ name: "commonName", value: "localhost" }])
  certificate.sign(keys.privateKey, forge.md.sha256.create())

  const server = createServer({
    key: forge.pki.privateKeyToPem(keys.privateKey),
    cert: forge.pki.certificateToPem(certificate),
  }, (_request, response) => response.end("ok"))
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))

  try {
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const dispatcher = getArcaTlsDispatcher(WSFE_PRODUCTION_URL)
    assert.ok(dispatcher)
    await assert.rejects(
      dispatcher.request({ origin: `https://127.0.0.1:${address.port}`, path: "/", method: "GET" }),
      { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
    )
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("no hay downgrade TLS global en el transporte ARCA", () => {
  const source = readFileSync(fileURLToPath(new URL("./transport.ts", import.meta.url)), "utf8")
  assert.match(source, /rejectUnauthorized: true/)
  assert.doesNotMatch(source, /setGlobalDispatcher|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|DEFAULT_MIN_VERSION/)
})
