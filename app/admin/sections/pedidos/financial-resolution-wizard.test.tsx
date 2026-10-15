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
type Responder = (call: Call) => Promise<Response> | Response

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const completedResponse = () => Response.json({ status: "completed",
  resolution: { id: "r1", type: "mercadopago_refund", amount: 25_000, detail: null } })

async function setup(responder: Responder = () => Response.json({ status: "completed" })) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://financial-wizard.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "financial-wizard-key"
  // Igual que dispatch-realtime: el cliente se crea antes de exponer window.
  const { supabase } = await import("../../../../lib/supabase/client")
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/pedidos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "t" } }, error: null }) })
  const calls: Call[] = []
  const state = { responder }
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? "GET", body: init?.body }
    calls.push(call)
    return state.responder(call)
  }) as typeof fetch
  // react-dom detecta soporte de eventos al cargarse: debe importarse con el DOM ya expuesto.
  const { createRoot } = await import("react-dom/client")
  const { FinancialResolutionWizard, useFinancialResolutionView } = await import("./financial-resolution-wizard")
  const root: Root = createRoot(dom.window.document.getElementById("root")!)
  const events = { changed: 0, billing: 0, attention: 0, download: [] as string[], resolved: [] as Array<{ status: string }> }
  const props = (order: SupabasePedido) => ({
    pedido: order, orderNumber: "BX-1031", customerName: "Begoña Núñez", reason: "Arrepentimiento",
    onOpenBilling: () => { events.billing++ }, onOpenAttention: () => { events.attention++ },
    onDownloadCreditNote: (id: string) => { events.download.push(id) },
  })
  const render = async (view: FinancialResolutionView, order: SupabasePedido = pedido) => {
    await act(async () => {
      root.render(<FinancialResolutionWizard {...props(order)} view={view} onChanged={() => { events.changed++ }}
        onResolved={(resolution) => { events.resolved.push(resolution) }} />)
    })
  }
  // Mismo cableado que RefundManagementPanel: hook real + wizard.
  function Panel() {
    const financial = useFinancialResolutionView(pedido.id, true, "rev")
    if (!financial.view) return <p>Cargando</p>
    return <FinancialResolutionWizard {...props(pedido)} view={financial.view}
      onChanged={() => { events.changed++; financial.reload() }} onResolved={financial.applyResolution} />
  }
  const renderPanel = async () => { await act(async () => { root.render(<Panel />) }) }
  const unmountView = async () => { await act(async () => { root.render(<p>Otro pedido</p>) }) }
  const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
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
  const toReview = async () => {
    await click("Continuar")
    await click(/^Reembolsar al medio de pago original/)
    await click("Continuar")
    await click("Confirmar resolución")
  }
  const text = () => doc.body.textContent ?? ""
  const hasButton = (label: string) => buttons().some((item) => item.textContent?.trim() === label)
  return { doc, calls, events, state, render, renderPanel, unmountView, flush, click, button, buttons, hasButton, text, toReview, cleanup }
}

const posts = (calls: Call[]) => calls.filter((call) => call.method === "POST")

test("doble click: el primer click dispara 1 request; el segundo inmediato no dispara otro", async () => {
  const pending = deferred<Response>()
  const ui = await setup(() => pending.promise)
  try {
    await ui.render(baseView)
    await ui.toReview()
    const confirm = ui.button("Confirmar")
    // Mismo tick, antes de que React re-renderice el botón deshabilitado.
    await act(async () => { confirm.click(); confirm.click() })
    assert.equal(posts(ui.calls).length, 1)
    // Mientras procesa: bloqueado, sin cancelar ni otra confirmación.
    assert.equal(ui.button("Confirmando...").disabled, true)
    assert.equal(ui.button("Cancelar").disabled, true)
    await act(async () => { ui.button("Confirmando...").click() })
    assert.equal(posts(ui.calls).length, 1)
    await act(async () => { pending.resolve(completedResponse()) })
    assert.deepEqual(ui.events.resolved.map((item) => item.status), ["completed"])
    assert.equal(posts(ui.calls).length, 1)
  } finally { await ui.cleanup() }
})

test("éxito: Completado inmediato con la respuesta del POST; el refetch viejo no revive el botón", async () => {
  const slowGet = deferred<Response>()
  let gets = 0
  const ui = await setup((call) => {
    if (call.method === "POST") return completedResponse()
    gets++
    // 1ª lectura: wizard. 2ª (post-éxito): lenta y vieja, todavía sin resolución.
    return gets === 1 ? Response.json(baseView) : slowGet.promise
  })
  try {
    await ui.renderPanel()
    await ui.flush()
    await ui.toReview()
    await ui.click("Confirmar")
    // Sin esperar la relectura: el resultado ya está en pantalla.
    assert.match(ui.text(), /Completado ✅/)
    assert.equal(ui.hasButton("Confirmar resolución"), false)
    assert.equal(gets, 2, "una sola relectura en segundo plano")
    await act(async () => { slowGet.resolve(Response.json(baseView)) })
    await ui.flush()
    assert.match(ui.text(), /Completado ✅/, "la lectura vieja no revive el wizard")
    assert.equal(ui.hasButton("Confirmar resolución"), false)
    assert.equal(posts(ui.calls).length, 1)
  } finally { await ui.cleanup() }
})

test("backend en proceso: muestra Procesando y no ofrece confirmar; completado oculta toda acción", async () => {
  const ui = await setup(() => Response.json(baseView))
  try {
    const resolved = (status: string) => ({ ...baseView, mode: "resolution" as const, financialOptions: [],
      resolution: { id: "r1", type: "mercadopago_refund" as const, status, amount: 25_000, detail: null } })
    await ui.render(resolved("processing"))
    assert.match(ui.text(), /Procesando reintegro…/)
    assert.deepEqual(ui.buttons().map((item) => item.textContent?.trim()), ["Actualizar"])
    await ui.render(resolved("completed"))
    assert.match(ui.text(), /Completado ✅/)
    assert.deepEqual(ui.buttons().map((item) => item.textContent?.trim()), [], "operación completada: nada para reintentar ni confirmar")
  } finally { await ui.cleanup() }
})

test("salir y volver a entrar con la confirmación en vuelo: bloqueado, sin una segunda confirmación", async () => {
  const pending = deferred<Response>()
  const ui = await setup(() => pending.promise)
  try {
    await ui.render(baseView)
    await ui.toReview()
    await ui.click("Confirmar")
    await ui.unmountView()
    await ui.render(baseView)
    assert.match(ui.text(), /Confirmando resolución…/)
    assert.equal(ui.hasButton("Continuar"), false)
    assert.equal(ui.hasButton("Confirmar resolución"), false)
    assert.equal(ui.hasButton("Volver"), false)
    const changedBefore = ui.events.changed
    await act(async () => { pending.resolve(completedResponse()) })
    await ui.flush()
    assert.ok(ui.events.changed > changedBefore, "al terminar, relee el pedido")
    assert.match(ui.text(), /Confirmando resolución…/, "sigue bloqueado hasta que llega la vista nueva")
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "mercadopago_refund", status: "completed", amount: 25_000, detail: null } })
    assert.match(ui.text(), /Completado ✅/)
    assert.equal(posts(ui.calls).length, 1)
  } finally { await ui.cleanup() }
})

test("error: libera para reintentar (el backend es idempotente) y relee por si llegó a registrarse", async () => {
  let fail = true
  const ui = await setup(() => fail
    ? Response.json({ error: "No se pudo continuar. Revisá el pedido e intentá nuevamente." }, { status: 409 })
    : completedResponse())
  try {
    await ui.render(baseView)
    await ui.toReview()
    await ui.click("Confirmar")
    assert.match(ui.doc.querySelector("[role='alert']")?.textContent ?? "", /No se pudo continuar/)
    assert.equal(ui.events.changed, 1, "relee aunque falle")
    assert.equal(ui.button("Confirmar resolución").disabled, false)
    fail = false
    await ui.click("Confirmar resolución")
    await ui.click("Confirmar")
    assert.equal(posts(ui.calls).length, 2)
    assert.deepEqual(ui.events.resolved.map((item) => item.status), ["completed"])
  } finally { await ui.cleanup() }
})

test("éxito sin resolución legible: queda bloqueado hasta la relectura (nunca reaparece Confirmar)", async () => {
  const ui = await setup()
  try {
    await ui.render(baseView)
    await ui.toReview()
    await ui.click("Confirmar")
    assert.equal(ui.events.resolved.length, 0)
    assert.match(ui.text(), /Confirmando resolución…/)
    assert.equal(ui.hasButton("Confirmar resolución"), false)
  } finally { await ui.cleanup() }
})

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
    // "Ver nota de crédito" abre el visor existente ahí mismo (sin navegar a Facturación).
    await ui.click("Ver nota de crédito")
    await ui.flush()
    assert.ok(ui.doc.querySelector("[role='dialog']"), "abre el visor")
    assert.ok(ui.calls.some((call) => call.method === "GET"), "pide el PDF de la NC")
    assert.equal(ui.events.billing, 0)
    await ui.click("Descargar")
    assert.deepEqual(ui.events.download, ["nc-1"])
    // Navegar a Facturación queda como acción secundaria.
    await ui.click("Ir a facturación")
    assert.equal(ui.events.billing, 1)
  } finally { await ui.cleanup() }
})

test("G. reintegro manual pendiente: exige el comprobante; referencia y observación opcionales", async () => {
  const ui = await setup()
  try {
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "manual_refund", status: "manual_pending", amount: 25_000, detail: null } })
    assert.match(ui.doc.body.textContent ?? "", /Reintegro pendiente: \$\s?25\.000/)
    await ui.click("Registrar reintegro realizado")
    // Sin comprobante del pago saliente no se puede cerrar el reintegro.
    assert.equal(ui.button("Confirmar reintegro").disabled, true)
    await ui.click("Confirmar reintegro")
    assert.equal(ui.calls.length, 0)
    const input = ui.doc.querySelector("input[type='file']") as HTMLInputElement
    const file = new ui.doc.defaultView!.File(["%PDF-1.4"], "transferencia.pdf", { type: "application/pdf" })
    Object.defineProperty(input, "files", { configurable: true, value: [file] })
    await act(async () => { input.dispatchEvent(new ui.doc.defaultView!.Event("change", { bubbles: true })) })
    await ui.click("Confirmar reintegro")
    assert.equal(ui.calls.length, 1)
    const form = ui.calls[0].body as FormData
    assert.equal(form.get("action"), "complete_manual")
    assert.equal(form.get("confirmed"), "true")
    // (FormData de Node con el File de JSDOM: sólo se verifica que viaje el archivo.)
    assert.ok(form.has("file"), "el comprobante viaja en el formulario")
    assert.equal(form.get("reference"), null, "la referencia sigue siendo opcional")
    await ui.render({ ...baseView, mode: "resolution", financialOptions: [],
      resolution: { id: "r1", type: "manual_refund", status: "completed", amount: 25_000, detail: null } })
    assert.match(ui.doc.body.textContent ?? "", /Reintegro completado ✅/)
  } finally { await ui.cleanup() }
})
