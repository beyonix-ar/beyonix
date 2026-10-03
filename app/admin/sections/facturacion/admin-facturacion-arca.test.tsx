import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

import type { ArcaConfigurationStatus } from "../../../../lib/arca/configuration"
import type { ArcaAutoInvoicingView } from "../../../../lib/arca/auto-invoicing-control"

// Panel de Facturación con React real (JSDOM): el estado ARCA del servidor
// decide si se puede emitir. Configuración inválida o sin verificar ->
// botón bloqueado y motivo visible; homologación -> aviso de prueba.

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" })
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  BroadcastChannel: undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true })
}
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://local-test.invalid"
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "local-test-key"

const baseStatus: ArcaConfigurationStatus = {
  configured: true,
  environment: "production",
  certificateType: "production",
  certificateExpiresAt: "2028-06-12T16:13:43.000Z",
  cuitMatches: true,
  privateKeyMatches: true,
  pointOfSale: 1,
  pointOfSaleConfigured: true,
  autoInvoicingEnabled: false,
  errors: [],
}
const invalidStatus: ArcaConfigurationStatus = {
  ...baseStatus,
  configured: false,
  environment: null,
  errors: ["ARCA_ENV no está configurada: definí homologation (pruebas) o production (fiscal)."],
}

let arcaReply: ArcaConfigurationStatus | "error" = invalidStatus
let autoReply: ArcaAutoInvoicingView = { enabled: false, controlEnabled: false, canActivate: false, cutoffAt: null, serverEnabled: false }
let invoiceRequests = 0
let mountKey = 0

test("Facturación: emitir sólo con configuración ARCA válida; homologación con aviso de prueba", async () => {
  const { createElement } = await import("react")
  const { createRoot } = await import("react-dom/client")
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime")
  const { supabase } = await import("../../../../lib/supabase/client")
  mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "test-token" } }, error: null }))
  mock.method(supabase, "channel", () => ({ on() { return this }, subscribe() { return this } }))
  mock.method(supabase, "removeChannel", async () => "ok")
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path === "/api/admin/arca/status") {
      if (arcaReply === "error") return Response.json({ error: "Error interno" }, { status: 500 })
      return Response.json({ arca: arcaReply })
    }
    if (path === "/api/admin/arca/auto-invoicing") {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean }
        autoReply = { ...autoReply, enabled: body.enabled, controlEnabled: body.enabled, cutoffAt: body.enabled ? "2026-10-03T15:00:00Z" : autoReply.cutoffAt }
      }
      return Response.json({ autoInvoicing: autoReply })
    }
    if (path === "/api/admin/arca/diagnostics") {
      return Response.json({ diagnostics: {
        ok: true,
        environment: "production",
        pointOfSale: 1,
        readyForFirstFiscalInvoice: true,
        nextInvoiceNumber: 1,
        steps: ["Configuración", "FEDummy", "WSAA", "Punto de venta", "Última Factura C", "Última Nota de Crédito C"].map((label, index) => ({ id: String(index), label, ok: true, detail: "OK" })),
      } })
    }
    if (path === "/api/admin/facturacion") {
      return Response.json({
        orders: [{ id: 76, cliente_nombre: "María Núñez", cliente_email: "maria@example.com", total: 900, created_at: "2026-09-29T12:00:00Z", invoice_status: "pending" }],
      })
    }
    if (path === "/api/admin/orders/76/invoice" && init?.method === "POST") {
      invoiceRequests += 1
      return Response.json({ invoice: { invoice_status: "authorized" } })
    }
    throw new Error(`Unexpected test request: ${path}`)
  })

  const { AdminFacturacion } = await import("./admin-facturacion")
  const root = createRoot(document.getElementById("root") as HTMLElement)
  const router = { bfcacheId: "test-router", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} }
  const mount = () =>
    act(async () => {
      root.render(createElement(AppRouterContext.Provider, { value: router }, createElement(AdminFacturacion, { key: String(++mountKey) })))
    })
  const issueButton = () => {
    const button = document.querySelector<HTMLButtonElement>("[data-arca-issue-button]")
    assert.ok(button, "botón Emitir factura")
    return button
  }
  const text = () => document.body.textContent ?? ""
  const clickIssue = () =>
    act(async () => {
      issueButton().dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })

  try {
    // 1. Configuración inválida: bloqueado y explicado; un click no emite.
    arcaReply = invalidStatus
    await mount()
    assert.equal(issueButton().disabled, true)
    assert.match(issueButton().title, /Emisión bloqueada por configuración de ARCA inválida/)
    assert.ok(document.querySelector("[data-arca-issue-blocked]"), "motivo visible")
    assert.match(text(), /No se pueden emitir comprobantes\./)
    assert.match(text(), /ARCA_ENV no está configurada/)
    assert.equal(document.querySelector("[data-arca-environment]")?.textContent, "Configuración inválida")
    await clickIssue()
    assert.equal(invoiceRequests, 0, "nunca llama a la emisión")

    // 2. Estado no verificable (error del servidor): también bloqueado.
    arcaReply = "error"
    await mount()
    assert.equal(issueButton().disabled, true)
    assert.match(text(), /No se pudo verificar la configuración de ARCA/)

    // 3. Homologación explícita: se puede emitir, con aviso de prueba.
    arcaReply = { ...baseStatus, environment: "homologation", certificateType: "homologation" }
    await mount()
    assert.equal(issueButton().disabled, false)
    assert.equal(document.querySelector("[data-arca-environment]")?.textContent, "Homologación")
    assert.match(text(), /Este ambiente emite comprobantes de prueba sin validez fiscal\./)
    assert.equal(document.querySelector("[data-arca-issue-blocked]"), null)

    // 4. Producción: sin aviso de prueba; muestra punto de venta, certificado y automática.
    arcaReply = baseStatus
    await mount()
    assert.equal(issueButton().disabled, false)
    assert.equal(document.querySelector("[data-arca-environment]")?.textContent, "Producción")
    assert.doesNotMatch(text(), /comprobantes de prueba/)
    assert.match(text(), /Punto de venta1/)
    assert.match(text(), /CertificadoProducción · vence 12\/06\/2028/)
    assert.match(text(), /Facturación automáticaInactiva/)
    assert.ok(document.querySelector("[data-arca-summary]"))
    assert.ok(document.querySelector("[data-arca-diagnostic-surface]"))
    assert.ok(document.querySelector("[data-arca-pending-surface]"))
    for (const theme of ["light", "dark"]) {
      document.documentElement.setAttribute("data-admin-theme", theme)
      for (const selector of ["[data-arca-summary]", "[data-arca-diagnostic-surface]", "[data-arca-pending-surface]"]) {
        assert.match(document.querySelector(selector)?.className ?? "", /bx-surface-section/)
      }
      assert.match(document.querySelector("[data-arca-pending-surface] .bx-surface-card")?.className ?? "", /bx-surface-card/)
    }
    assert.match(document.querySelector("[data-arca-summary]")?.className ?? "", /sm:p-5/)
    assert.match(text(), /Los comprobantes históricos no se procesarán automáticamente/)
    assert.equal(document.querySelector<HTMLButtonElement>("[data-arca-summary] button")?.disabled, true)

    autoReply = { enabled: true, controlEnabled: true, canActivate: true, cutoffAt: "2026-10-03T15:00:00Z", serverEnabled: true }
    arcaReply = { ...baseStatus, autoInvoicingEnabled: true }
    await mount()
    assert.match(text(), /Facturación automáticaActiva/)
    assert.match(text(), /Pedidos elegibles desde:/)
    await act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("[data-arca-diagnostic-surface] button")][0]
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })
    assert.equal(document.querySelectorAll("[data-arca-diagnostics] li").length, 6)
    assert.match(document.querySelector("[data-arca-diagnostics]")?.className ?? "", /sm:grid-cols-2/)
    assert.match(document.querySelector("[data-arca-final-state]")?.textContent ?? "", /Listo para emitir la primera Factura C fiscal/)
    assert.match(document.querySelector("[data-arca-final-state]")?.className ?? "", /bx-surface-card/)

    autoReply = { enabled: false, controlEnabled: true, canActivate: false, cutoffAt: "2026-10-03T15:00:00Z", serverEnabled: false }
    arcaReply = baseStatus
    await mount()
    assert.match(text(), /Control activo, interruptor del servidor apagado/)
    const disableButton = [...document.querySelectorAll<HTMLButtonElement>("[data-arca-summary] button")][0]
    assert.equal(disableButton.disabled, false)
    await act(async () => disableButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })))
    assert.equal(autoReply.controlEnabled, false)

    autoReply = { enabled: false, controlEnabled: false, canActivate: true, cutoffAt: null, serverEnabled: true }
    arcaReply = { ...baseStatus, autoInvoicingEnabled: true }
    await mount()
    await act(async () => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("[data-arca-summary] button")][0]
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })
    assert.match(document.querySelector("[role=dialog]")?.textContent ?? "", /Los comprobantes históricos no se procesarán automáticamente/)
    await act(async () => {
      const confirm = [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")].find((button) => button.textContent?.includes("Confirmar activación"))
      assert.ok(confirm)
      confirm.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }))
    })
    assert.equal(autoReply.enabled, true)
    assert.match(text(), /Pedidos elegibles desde:/)
    await clickIssue()
    assert.equal(invoiceRequests, 1)
  } finally {
    await act(async () => root.unmount())
    mock.restoreAll()
  }
})
