import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"

import {
  HomologationGuardError,
  assertCreditNoteTarget,
  assertHomologationRuntime,
  assertInvoiceableForTest,
  assertTestOrder,
  assertTestProduct,
  assertTestUser,
  assertTestUserIsolated,
  type OrderFacts,
} from "./guards.ts"
import { arcaTestEnv } from "../../lib/arca/fixtures/arca-test-certificates.ts"
import { harnessState } from "./harness-state.ts"
import { SHIMMED_SPECIFIERS, assertRouteUsesShims, registerRouteShims } from "./route-shims.ts"

// Arnés de homologación ARCA: nunca opera fuera de homologación ni sobre
// datos que no sean inequívocamente de prueba. Sin red: ningún test contacta
// a ARCA ni a la base.

const runtime: { arcaEnv: string | undefined; autoInvoicingEnabled: string | undefined; certificateIssuerCn: string } = {
  arcaEnv: "homologation",
  autoInvoicingEnabled: undefined,
  certificateIssuerCn: "Computadores Test",
}
const USER = "11111111-1111-4111-8111-111111111111"
const order = (extra: Partial<OrderFacts> = {}): OrderFacts => ({
  id: 20, usuario_id: USER, total: 900, invoice_status: "pending", invoice_arca_environment: null,
  items: [{ producto_id: 7 }], ...extra,
})

test("configuración: sólo homologación, certificado de testing y automática apagada", () => {
  assertHomologationRuntime(runtime)
  assertHomologationRuntime({ ...runtime, arcaEnv: " homologation " })
  const blocked: Array<[string, typeof runtime | Record<string, unknown>]> = [
    ["sin ARCA_ENV (ya no hay homologación por defecto)", { ...runtime, arcaEnv: undefined }],
    ["ARCA_ENV vacío", { ...runtime, arcaEnv: "" }],
    ["production", { ...runtime, arcaEnv: "production" }],
    ["PRODUCTION", { ...runtime, arcaEnv: "PRODUCTION" }],
    ["valor raro", { ...runtime, arcaEnv: "prod" }],
    ["automática", { ...runtime, autoInvoicingEnabled: "true" }],
    ["cert producción", { ...runtime, certificateIssuerCn: "Computadores" }],
  ]
  for (const [label, facts] of blocked) {
    assert.throws(() => assertHomologationRuntime(facts as typeof runtime), HomologationGuardError, label)
  }
})

test("usuario y producto deben identificarse como prueba", () => {
  assertTestUser({ id: USER, email: "lucas+arca@gmail.com", rol: "cliente" }, USER)
  assertTestUser({ id: USER, email: "prueba.beyonix@gmail.com", rol: "cliente" }, USER)
  assert.throws(() => assertTestUser({ id: USER, email: "cliente.real@gmail.com", rol: "cliente" }, USER), /identificarlo como prueba/)
  assert.throws(() => assertTestUser({ id: USER, email: "test@beyonix.com.ar", rol: "super_admin" }, USER), /rol cliente/)
  assert.throws(() => assertTestUser(null, USER), /no existe/)
  assertTestProduct({ id: 7, nombre: "PRUEBA ARCA HOMOLOGACIÓN - NO COMPRAR" }, 7)
  assert.throws(() => assertTestProduct({ id: 7, nombre: "Trípode profesional" }, 7), /identificarlo como prueba/)
})

test("pedido: del usuario de prueba y sólo con el producto de prueba; el usuario nunca compró otra cosa", () => {
  assertTestOrder(order(), USER, 7)
  assert.throws(() => assertTestOrder(order({ usuario_id: "otro" }), USER, 7), /no pertenece/)
  assert.throws(() => assertTestOrder(order({ items: [{ producto_id: 7 }, { producto_id: 1 }] }), USER, 7), /no son el producto de prueba/)
  assert.throws(() => assertTestOrder(order({ items: [] }), USER, 7), /no son el producto de prueba/)
  assert.throws(() => assertTestUserIsolated([order(), order({ id: 21, items: [{ producto_id: 1 }] })], USER, 7), /21/)
})

test("factura: no reemite ni pisa una en curso; NC: sólo sobre factura de homologación y dentro del saldo", () => {
  assertInvoiceableForTest(order(), true)
  assertInvoiceableForTest(order({ invoice_status: "error" }), false)
  assert.throws(() => assertInvoiceableForTest(order({ invoice_status: "authorized" }), true), /ya está facturado/)
  assert.throws(() => assertInvoiceableForTest(order({ invoice_status: "processing" }), true), /facturándose/)
  assert.throws(() => assertInvoiceableForTest(order({ invoice_status: null }), false), /no es facturable/)

  const invoiced = order({ invoice_status: "authorized", invoice_arca_environment: "homologation" })
  assertCreditNoteTarget(invoiced, 900, 900)
  assertCreditNoteTarget(invoiced, 0.1, 900)
  assert.throws(() => assertCreditNoteTarget({ ...invoiced, invoice_arca_environment: "production" }, 100, 900), /no es de homologación/)
  assert.throws(() => assertCreditNoteTarget(invoiced, 500, 400), /supera/)
  assert.throws(() => assertCreditNoteTarget(invoiced, 1.005, 900), /2 decimales/)
  assert.throws(() => assertCreditNoteTarget(order(), 100, 900), /no tiene Factura C/)
})

test("las rutas reales importan auth y gateway exactamente por los especificadores interceptados", () => {
  for (const route of [
    "app/api/admin/orders/[id]/invoice/route.ts",
    "app/api/admin/orders/[id]/credit-note/route.ts",
    "app/api/admin/credit-notes/[noteId]/reconcile/route.ts",
  ]) {
    assertRouteUsesShims(route)
  }
  const dir = mkdtempSync(join(tmpdir(), "beyonix-harness-"))
  try {
    writeFileSync(join(dir, "route.ts"), 'import { requireAdmin } from "@/app/api/admin/clientes/_auth"\nimport { createWsfeInvoiceGateway } from "../lib/arca/wsfe-invoice-gateway"\n')
    assert.throws(() => assertRouteUsesShims("route.ts", dir), /no importa "@\/lib\/arca\/wsfe-invoice-gateway"/)
    writeFileSync(join(dir, "route.ts"), `${Object.keys(SHIMMED_SPECIFIERS).map((s) => `import x from "${s}"`).join("\n")}\nfecaeSolicitar({})\n`)
    assert.throws(() => assertRouteUsesShims("route.ts", dir), /por fuera del gateway/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("shims: redirección real; gateway fuera de homologación o con CAE prohibido aborta antes de contactar a ARCA", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "https://example.invalid"
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-key"
  registerRouteShims()
  const dir = mkdtempSync(join(process.cwd(), "scripts", "arca-homologation", ".tmp-"))
  try {
    const fixture = join(dir, "uses-aliases.ts")
    writeFileSync(fixture, [
      'export { createWsfeInvoiceGateway } from "@/lib/arca/wsfe-invoice-gateway"',
      'export { requireAdmin } from "@/app/api/admin/clientes/_auth"',
    ].join("\n"))
    const mod = await import(pathToFileURL(fixture).href)
    const state = harnessState()

    // Auth: sin actor -> 401; con actor -> super_admin explícito.
    state.actor = null
    const denied = await mod.requireAdmin(new Request("http://harness"))
    assert.equal(denied.error.status, 401)
    state.actor = { id: USER, email: "admin@beyonix.test", rol: "super_admin" }
    const granted = await mod.requireAdmin(new Request("http://harness"))
    assert.equal(granted.profile.rol, "super_admin")
    assert.equal(granted.user.id, USER)

    // Gateway: configuración real del proceso, validada por el guard central.
    const keys = ["ARCA_ENV", "ARCA_CERT", "ARCA_PRIVATE_KEY", "ARCA_CUIT", "ARCA_PTO_VTA"] as const
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, arcaTestEnv("homologation"))
      delete process.env.ARCA_ENV
      assert.throws(() => mod.createWsfeInvoiceGateway(), /ARCA_ENV no está configurada/)
      process.env.ARCA_ENV = "production"
      assert.throws(() => mod.createWsfeInvoiceGateway(), /no admite un certificado de homologación/)
      Object.assign(process.env, arcaTestEnv("production"))
      assert.throws(() => mod.createWsfeInvoiceGateway(), /no está en homologación/)
      Object.assign(process.env, arcaTestEnv("homologation"))
      const gateway = mod.createWsfeInvoiceGateway()
      assert.equal(gateway.environment, "homologation")
      state.forbidCae = true
      await assert.rejects(
        gateway.requestCae({ pointOfSale: 1, voucherNumber: 1, voucherDate: "20260927", total: 1 }),
        /no puede pedir CAE/,
      )
      assert.equal(state.caeRequests, 0)
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key]
        else process.env[key] = previous[key]
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
