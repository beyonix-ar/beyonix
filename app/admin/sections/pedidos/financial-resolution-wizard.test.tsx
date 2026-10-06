import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import type { Root } from "react-dom/client"
import type { FinancialResolutionView } from "../../../../lib/orders/financial-resolution-wizard"
import type { SupabasePedido } from "../../../../lib/supabase/types"

const TECHNICAL = /ARCA|concilia|acreditaci|reconciliation|settlement|refund claim|postproceso|RPC|FINANCIAL_|CAE/i
const option = (type: "beyonix_credit" | "mercadopago_refund" | "manual_refund", label: string) => ({ type, label, requiresConfirmation: true as const })
const baseView: FinancialResolutionView = {
  mode: "wizard", amount: 25_000, status: "Pendiente", product: "no_return", reception: "not_applicable",
  financialOptions: [option("beyonix_credit", "Saldo BEYONIX"), option("mercadopago_refund", "Reembolsar al medio de pago original")],
  receptionOptions: [], notice: null, resolution: null,
}
const pedido = { id: 31, order_credit_notes: [] } as unknown as SupabasePedido

type Call = { method: string; body: BodyInit | null | undefined }

async function setup() {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://financial-wizard.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "financial-wizard-key"
  // Igual que dispatch-realtime: el cliente se crea antes de exponer window.
  const { supabase } = await import("../../../../lib/supabase/client")
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/pedidos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "t" } }, error: null }) })
  const calls: Call[] = []
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", body: init?.body })
    return Response.json({ status: "completed" })
  }) as typeof fetch
  // react-dom detecta soporte de eventos al cargarse: debe importarse con el DOM ya expuesto.
  const { createRoot } = await import("react-dom/client")
  const { FinancialResolutionWizard } = await import("./financial-resolution-wizard")
  const root: Root = createRoot(dom.window.document.getElementById("root")!)
  const events = { changed: 0, billing: 0, attention: 0, download: [] as string[] }
  const render = async (view: FinancialResolutionView, order: SupabasePedido = pedido) => {
    await act(async () => {
      root.render(<FinancialResolutionWizard pedido={order} view={view} orderNumber="BX-1031" customerName="Begoña Núñez"
        reason="Arrepentimiento" onChanged={() => { events.changed++ }} onOpenBilling={() => { events.billing++ }}
        onOpenAttention={() => { events.attention++ }} onDownloadCreditNote={(id) => { events.download.push(id) }} />)
    })
  }
  const doc = dom.window.document
  const buttons = () => [...doc.querySelectorAll("button")]
  const button = (text: string | RegExp) => {
    const found = buttons().find((item) => typeof text === "string" ? item.textContent?.trim() === text : text.test(item.textContent ?? ""))
    assert.ok(found, `botón ${text} no encontrado: ${buttons().map((item) => item.textContent).join(" | ")}`)
    return found
  }
  const click = async (text: string | RegExp) => { await act(async () => { button(text).click() }) }
  const cleanup = async () => {
    await act(async () => root.unmount())
    supabase.auth.stopAutoRefresh()
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    dom.window.close()
  }
  return { doc, calls, events, render, click, button, buttons, cleanup }
}

test("H. saldo BEYONIX: tres pasos, un único paso visible y una sola confirmación", async () => {
  const ui = await setup()
  try {
    await ui.render(baseView)
    const panel = () => ui.doc.querySelector("[data-testid='financial-resolution']")!
    assert.deepEqual([...ui.doc.querySelectorAll("ol li")].map((item) => item.textContent), ["1Producto", "2Dinero", "3Revisar"])
    assert.equal(ui.doc.querySelectorAll("fieldset").length, 1)
    assert.match(panel().textContent ?? "", /¿Qué pasa con el producto\?/)
    assert.equal(ui.button(/Debe volver/).disabled, true)
    await ui.click("Continuar")
    assert.match(panel().textContent ?? "", /¿Cómo querés resolver/)
    assert.doesNotMatch(panel().textContent ?? "", /¿Qué pasa con el producto\?/)
    assert.equal(ui.button("Continuar").disabled, true)
    await ui.click(/^Saldo BEYONIX/)
    await ui.click("Continuar")
    const review = panel().textContent ?? ""
    assert.match(review, /BX-1031.*Begoña Núñez.*Arrepentimiento/)
    assert.match(review, /Se emitirá automáticamente si corresponde/)
    assert.doesNotMatch(review, TECHNICAL)
    await ui.click("Confirmar resolución")
    const dialog = ui.doc.querySelector("[role='dialog']")!
    assert.match(dialog.textContent ?? "", /¿Confirmás esta resolución\?.*Saldo BEYONIX/)
    await ui.click("Confirmar")
    assert.equal(ui.calls.length, 1)
    assert.deepEqual(JSON.parse(String(ui.calls[0].body)), { action: "resolve", choice: "beyonix_credit", confirmed: true })
    assert.equal(ui.events.changed, 1)
    assert.equal(ui.doc.querySelector("[role='dialog']"), null)
  } finally { await ui.cleanup() }
})

test("C/D. recepción pendiente: esperar no resuelve; excepción exige motivo", async () => {
  const ui = await setup()
  try {
    await ui.render({ ...baseView, product: "return", reception: "pending", financialOptions: [],
      receptionOptions: [option("manual_refund", "Reintegro manual")] })
    assert.equal(ui.doc.querySelectorAll("ol li").length, 4)
    await ui.click("Continuar")
    await ui.click(/^Reintegro manual/)
    await ui.click("Continuar")
    await ui.click(/^No/)
    assert.match(ui.doc.body.textContent ?? "", /El reintegro normalmente se completa después de recibir el producto/)
    await ui.click("Esperar recepción")
    assert.equal(ui.calls.length, 0)
    await ui.click("Resolver ahora")
    // Vuelve al mismo paso con las decisiones intactas.
    assert.equal(ui.doc.querySelector("[data-step]")?.getAttribute("data-step"), "reception")
    await ui.click("Continuar con excepción")
    assert.equal(ui.button("Continuar").disabled, true)
    const textarea = ui.doc.querySelector("textarea")!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(ui.doc.defaultView!.HTMLTextAreaElement.prototype, "value")!.set!
      setter.call(textarea, "Cliente autorizado por gerencia")
      textarea.dispatchEvent(new ui.doc.defaultView!.Event("input", { bubbles: true }))
    })
    await ui.click("Continuar")
    assert.match(ui.doc.body.textContent ?? "", /Pendiente \(excepción\)/)
    await ui.click("Confirmar resolución")
    await ui.click("Confirmar")
    assert.deepEqual(JSON.parse(String(ui.calls[0].body)), {
      action: "resolve", choice: "manual_refund", confirmed: true, receptionExceptionReason: "Cliente autorizado por gerencia",
    })
  } finally { await ui.cleanup() }
})

test("J. fallo de postproceso: sólo Reintentar y detalle técnico a pedido", async () => {
  const ui = await setup()
  try {
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "beyonix_credit", status: "requires_action", amount: 25_000, detail: "La actualización fiscal está pendiente." } })
    const panel = ui.doc.querySelector("[data-testid='financial-resolution']")!
    assert.equal(panel.getAttribute("data-requires-action"), "true")
    assert.match(panel.textContent ?? "", /Actualización pendiente.*BEYONIX no pudo completar una actualización interna/)
    assert.deepEqual(ui.buttons().map((item) => item.textContent?.trim()), ["Reintentar", "Ver detalle técnico"])
    assert.doesNotMatch(panel.textContent ?? "", /fiscal/)
    await ui.click("Ver detalle técnico")
    assert.match(panel.textContent ?? "", /fiscal/)
    await ui.click("Reintentar")
    assert.deepEqual(JSON.parse(String(ui.calls[0].body)), { action: "retry", confirmed: true })
  } finally { await ui.cleanup() }
})

test("I. NC emitida se muestra como resultado, sin acciones fiscales manuales", async () => {
  const ui = await setup()
  try {
    const order = { id: 31, order_credit_notes: [{ id: "nc-1", status: "authorized", cae: "123", destination: "customer_balance", created_at: "2026-10-05T12:00:00Z" }] } as unknown as SupabasePedido
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "beyonix_credit", status: "completed", amount: 25_000, detail: null } }, order)
    const text = ui.doc.body.textContent ?? ""
    assert.match(text, /Completado ✅.*Nota de crédito emitida ✅/)
    assert.doesNotMatch(text, /Emitir|Conciliar|Reintentar acreditación|CAE/)
    await ui.click("Ver")
    await ui.click("Descargar")
    assert.equal(ui.events.billing, 1)
    assert.deepEqual(ui.events.download, ["nc-1"])
  } finally { await ui.cleanup() }
})

test("G. reintegro manual pendiente: registrar con datos opcionales", async () => {
  const ui = await setup()
  try {
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "manual_refund", status: "manual_pending", amount: 25_000, detail: null } })
    assert.match(ui.doc.body.textContent ?? "", /Reintegro pendiente: \$\s?25\.000/)
    await ui.click("Registrar reintegro realizado")
    await ui.click("Confirmar reintegro")
    assert.equal(ui.calls.length, 1)
    const form = ui.calls[0].body as FormData
    assert.equal(form.get("action"), "complete_manual")
    assert.equal(form.get("confirmed"), "true")
    assert.equal(form.get("file"), null)
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "manual_refund", status: "completed", amount: 25_000, detail: null } })
    assert.match(ui.doc.body.textContent ?? "", /Reintegro completado ✅/)
  } finally { await ui.cleanup() }
})
