import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

test("Admin: NC parcial sin emisión, último rechazo visible y archivo de prueba con bloqueos y motivo", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" })
  const originals = new Map<string, PropertyDescriptor | undefined>()
  for (const [key, value] of Object.entries({
    window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node, navigator: dom.window.navigator, BroadcastChannel: undefined, IS_REACT_ACT_ENVIRONMENT: true,
    Event: dom.window.Event,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  }
  const env = { ...process.env }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://archive.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const { supabase } = await import("../supabase/client")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "token" } }, error: null }))
  const { LegacyCreditNotePanel } = await import("../../app/admin/sections/pedidos/legacy-credit-note-panel")
  const { OrderArchivePanel } = await import("../../app/admin/sections/pedidos/order-archive-panel")
  const { ADMIN_NOTIFICATIONS_CHANGED_EVENT } = await import("./admin-notifications")
  const { createRoot } = await import("react-dom/client")

  const calls: Array<{ method: string; path: string; body: unknown }> = []
  let blockers: string[] = ["Hay un incidente de pago abierto."]
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === "/api/admin/orders/7/archive" && method === "GET") return Response.json({ blockers, reasons: blockers })
    if (path === "/api/admin/orders/7/archive" && method === "POST") {
      return Response.json({ archive: { archived_at: "2026-10-15T15:00:00.000Z", archived_by: "s", archive_reason: "Pedido de prueba interna", customer_hidden_at: null } })
    }
    throw new Error(`Petición inesperada: ${method} ${path}`)
  })
  let notifications = 0
  const onNotify = () => { notifications += 1 }
  dom.window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED_EVENT, onNotify)

  const base = {
    total: 1000, estado: "cancelado", financial_status: "refunded", credit_note_required: true,
    refunded_at: "2026-10-13T22:42:31.371Z", invoice_status: "authorized", invoice_cae: "CAE", invoice_number: 8, invoice_point: 1,
  }
  let partial: Record<string, unknown> = { ...base, id: 2, order_credit_notes: [{ status: "authorized", total_amount: 400 }], order_audit_events: [] }
  let pendingWithRejection: Record<string, unknown> = {
    ...base, id: 3, order_credit_notes: [],
    order_audit_events: [{ id: 1, action: "legacy_credit_note_rejected", created_at: "2026-10-15T10:00:00.000Z", metadata: { code: "ARCA_ENVIRONMENT_MISMATCH", message: "La factura pertenece a otro ambiente de ARCA." } }],
  }
  const covered = { ...base, id: 4, order_credit_notes: [{ status: "authorized", total_amount: 1000 }], order_audit_events: [] }
  let archivable: Record<string, unknown> = { ...base, id: 7, credit_note_required: false, archived_at: null }

  const root = createRoot(document.getElementById("root")!)
  const render = async () => act(async () => {
    root.render(createElement("div", null,
      createElement("div", { id: "partial" }, createElement(LegacyCreditNotePanel, { pedido: partial as never, onUpdated: (next) => { partial = next as never } })),
      createElement("div", { id: "rejected" }, createElement(LegacyCreditNotePanel, { pedido: pendingWithRejection as never, onUpdated: (next) => { pendingWithRejection = next as never } })),
      createElement("div", { id: "covered" }, createElement(LegacyCreditNotePanel, { pedido: covered as never, onUpdated: () => {} })),
      createElement("div", { id: "archive" }, createElement(OrderArchivePanel, { pedido: archivable as never, onUpdated: (next) => { archivable = next as never; void render() } })),
    ))
  })
  const text = (id: string) => document.getElementById(id)?.textContent ?? ""
  const button = (label: string) => [...document.querySelectorAll("button")].find((node) => node.textContent?.trim() === label)
  const click = async (node: Element | undefined) => { assert.ok(node, "botón presente"); await act(async () => (node as HTMLElement).click()) }
  const settle = async () => { for (let index = 0; index < 10; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5))) }
  const type = async (selector: string, value: string) => {
    const textarea = document.querySelector<HTMLTextAreaElement>(selector)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, value)
      textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
  }

  try {
    await render()
    // NC parcial: explica el faltante y nunca ofrece emitir otra.
    assert.match(text("partial"), /Nota de crédito parcial — requiere revisión/)
    assert.match(text("partial"), /Falta cubrir\s*\$\s?600/)
    assert.equal(document.querySelector("#partial button"), null, "sin botón de emisión")
    // NC faltante con un rechazo previo: dice exactamente por qué no se emitió.
    assert.match(text("rejected"), /Último intento rechazado.*otro ambiente de ARCA/)
    assert.ok(document.querySelector("#rejected button"), "se puede reintentar")
    // NC autorizada por el total: no se muestra nada pendiente.
    assert.equal(text("covered"), "")

    // Archivo: primero muestra los bloqueos y no deja confirmar.
    await click(button("Archivar pedido de prueba"))
    await settle()
    assert.match(document.querySelector('[data-testid="order-archive-blockers"]')?.textContent ?? "", /incidente de pago abierto/)
    assert.equal(button("Archivar")?.hasAttribute("disabled"), true)
    assert.equal(calls.filter((call) => call.method === "POST").length, 0)
    await click(button("Cancelar"))

    // Sin bloqueos: exige motivo, envía una sola vez y queda archivado con aviso a la campana.
    blockers = []
    await click(button("Archivar pedido de prueba"))
    await settle()
    assert.equal(button("Archivar")?.hasAttribute("disabled"), true, "exige motivo")
    await type('textarea[aria-label="Motivo del archivo"]', "Pedido de prueba interna")
    const confirm = button("Archivar")
    await click(confirm)
    await click(confirm)
    await settle()
    const posts = calls.filter((call) => call.method === "POST")
    assert.deepEqual(posts, [{ method: "POST", path: "/api/admin/orders/7/archive", body: { reason: "Pedido de prueba interna", hideFromCustomer: false } }])
    assert.match(text("archive"), /Pedido archivado.*Pedido de prueba interna.*El cliente lo sigue viendo/)
    assert.ok(button("Restaurar al listado"))
    assert.equal(notifications, 1)
  } finally {
    dom.window.removeEventListener(ADMIN_NOTIFICATIONS_CHANGED_EVENT, onNotify)
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
