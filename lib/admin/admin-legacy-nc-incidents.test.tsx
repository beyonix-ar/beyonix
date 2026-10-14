import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

test("Admin: NC heredada con acción explícita e incidentes marcables sin borrar el evento", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://legacy-nc.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const { supabase } = await import("../supabase/client")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "token" } }, error: null }))
  const { LegacyCreditNotePanel } = await import("../../app/admin/sections/pedidos/legacy-credit-note-panel")
  const { PaymentIncidentsPanel } = await import("../../app/admin/sections/pedidos/payment-incidents-panel")
  const { createRoot } = await import("react-dom/client")

  const calls: Array<{ path: string; body: unknown }> = []
  let releaseEmission: () => void = () => {}
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === "/api/admin/orders/2/legacy-credit-note") {
      await new Promise<void>((resolve) => { releaseEmission = resolve })
      return Response.json({ order: { ...order, credit_note_required: false, order_credit_notes: [{ status: "authorized" }] } })
    }
    if (path === "/api/admin/orders/2/audit-incidents/9/resolve") {
      return Response.json({ resolution: { resolution: "false_positive", note: "Reintegro propio", resolved_at: "2026-10-15T15:00:00.000Z" } })
    }
    throw new Error(`Petición inesperada: ${path}`)
  })

  const order = {
    id: 2, total: 1000, estado: "cancelado", financial_status: "refunded", credit_note_required: true,
    refunded_at: "2026-10-13T22:42:31.371Z", invoice_status: "authorized", invoice_cae: "86417596112941",
    invoice_number: 8, invoice_point: 1, order_credit_notes: [],
    order_audit_events: [
      { id: 9, order_id: 2, actor_type: "system", action: "mp_external_refund_detected", created_at: "2026-10-13T22:42:32.445Z", metadata: {} },
      { id: 8, order_id: 2, actor_type: "system", action: "payment_refunded_by_provider", created_at: "2026-10-13T22:42:32.313Z", metadata: {} },
    ],
  }
  let current: Record<string, unknown> = order
  const root = createRoot(document.getElementById("root")!)
  const render = async () => act(async () => {
    root.render(createElement("div", null,
      createElement(LegacyCreditNotePanel, { pedido: current as never, onUpdated: (next) => { current = next as never; void render() } }),
      createElement(PaymentIncidentsPanel, { pedido: current as never, onUpdated: (next) => { current = next as never; void render() } }),
    ))
  })
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)
  const click = async (node: Element | undefined) => { assert.ok(node); await act(async () => (node as HTMLElement).click()) }
  const settle = async () => { for (let index = 0; index < 10; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5))) }

  try {
    await render()
    const legacy = document.querySelector('[aria-label="Nota de crédito pendiente — caso heredado"]')
    assert.ok(legacy, "se muestra el caso heredado")
    assert.match(legacy.textContent ?? "", /Nota de crédito pendiente — caso heredado/)
    assert.match(legacy.textContent ?? "", /no devuelve dinero ni acredita saldo/)

    // La emisión real exige confirmación explícita.
    await click(button("Emitir nota de crédito"))
    assert.equal(calls.length, 0, "abrir el modal no emite nada")
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? "", /Nota de Crédito C real por \$\s?1\.000 asociada a la factura 1-8/)
    const confirmButton = button("Emitir en ARCA")
    await click(confirmButton)
    await click(confirmButton)
    assert.equal(calls.filter((call) => call.path.endsWith("/legacy-credit-note")).length, 1, "doble click: un solo envío")
    releaseEmission()
    await settle()
    assert.equal(document.querySelector('[aria-label="Nota de crédito pendiente — caso heredado"]'), null, "emitida: deja de figurar como pendiente")

    // Incidente: alerta abierta → falso positivo con motivo → sigue visible, resuelto.
    const incidents = () => document.querySelector('[aria-label="Incidentes de pago"]')?.textContent ?? ""
    assert.match(incidents(), /Reintegro externo detectado en Mercado Pago.*Requiere revisión/)
    assert.doesNotMatch(incidents(), /payment_refunded_by_provider/, "sólo incidentes")
    await click(button("Marcar como falso positivo"))
    assert.equal(button("Confirmar")?.hasAttribute("disabled"), true, "exige motivo")
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Motivo de la resolución"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Reintegro propio")
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
    await click(button("Confirmar"))
    await settle()
    assert.deepEqual(calls.at(-1), { path: "/api/admin/orders/2/audit-incidents/9/resolve", body: { resolution: "false_positive", note: "Reintegro propio" } })
    assert.match(incidents(), /Reintegro externo detectado en Mercado Pago.*Falso positivo.*Reintegro propio/, "sigue visible en el historial")
    assert.equal(button("Marcar como falso positivo"), undefined, "ya no es una alerta activa")
  } finally {
    await act(async () => root.unmount())
    fetchMock.mock.restore()
    session.mock.restore()
    process.env = env
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
