import assert from "node:assert/strict"
import test, { mock } from "node:test"
import { JSDOM } from "jsdom"
import { act, createElement } from "react"

test("Admin: clasificar compra de prueba exige motivo y BX exacto, muestra el reingreso y envía una sola vez", async () => {
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
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-orders.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon"
  const { supabase } = await import("../supabase/client")
  const session = mock.method(supabase.auth, "getSession", async () => ({ data: { session: { access_token: "token" } }, error: null }))
  const { OrderTestClassificationPanel } = await import("../../app/admin/sections/pedidos/order-test-classification-panel")
  const { ADMIN_NOTIFICATIONS_CHANGED_EVENT } = await import("./admin-notifications")
  const { createRoot } = await import("react-dom/client")

  const calls: Array<{ method: string; path: string; body: unknown }> = []
  let reasons: string[] = ["Sólo se pueden clasificar compras hechas con una cuenta interna del equipo, nunca la de un cliente."]
  const plan = [{ orderItemId: 26, productId: 22, variantId: 22, productName: "AURICULAR ÑANDÚ", variantName: "Negro mate", quantity: 1, consumed: 1, returned: 0, released: 0, compensated: 0, pending: 1, supported: true }]
  const fetchMock = mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? "GET"
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === "/api/admin/orders/19/test-classification" && method === "GET") {
      return Response.json({ blockers: reasons.length ? ["buyer_not_internal"] : [], reasons, restockPlan: plan, confirmation: "BX-1019" })
    }
    if (path === "/api/admin/orders/19/test-classification" && method === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json({ classification: {
        test_order_at: "2026-11-24T20:00:00.000Z", test_order_by: "s", test_order_reason: "Compra de prueba del propietario",
        archived_at: "2026-11-24T20:00:00.000Z", archived_by: "s", archive_reason: "Pedido de prueba: Compra de prueba del propietario", customer_hidden_at: null,
      } })
    }
    if (path === "/api/admin/orders/22/archive" && method === "GET") return Response.json({ blockers: [], reasons: [] })
    throw new Error(`Petición inesperada: ${method} ${path}`)
  })
  let notifications = 0
  const onNotify = () => { notifications += 1 }
  dom.window.addEventListener(ADMIN_NOTIFICATIONS_CHANGED_EVENT, onNotify)

  let pedido: Record<string, unknown> = { id: 19, total: 20, estado: "entregado", invoice_status: "authorized", test_order_at: null, archived_at: null }
  const root = createRoot(document.getElementById("root")!)
  const render = async () => act(async () => {
    root.render(createElement(OrderTestClassificationPanel, { pedido: pedido as never, onUpdated: (next) => { pedido = next as never; void render() } }))
  })
  const text = () => document.getElementById("root")?.textContent ?? ""
  const modalText = () => document.body.textContent ?? ""
  const buttons = (label: string) => [...document.querySelectorAll("button")].filter((node) => node.textContent?.trim() === label)
  const click = async (node: Element | undefined) => { assert.ok(node, "botón presente"); await act(async () => (node as HTMLElement).click()) }
  const settle = async () => { for (let index = 0; index < 10; index += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 5))) }
  const setValue = async (selector: string, value: string) => {
    const element = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!
    assert.ok(element, selector)
    const prototype = element instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value)
      element.dispatchEvent(new dom.window.Event("input", { bubbles: true }))
    })
  }
  const submitButton = () => buttons("Clasificar como prueba").at(-1)

  try {
    await render()
    assert.match(text(), /Pago y factura no se modifican/)

    // Con bloqueos: los explica y no deja confirmar.
    await click(buttons("Clasificar como prueba")[0])
    await settle()
    assert.match(document.querySelector('[data-testid="order-test-blockers"]')?.textContent ?? "", /cuenta interna del equipo/)
    assert.equal(submitButton()?.hasAttribute("disabled"), true)
    await click(buttons("Cancelar")[0])

    // Sin bloqueos: muestra el reingreso exacto y exige motivo + BX-1019.
    reasons = []
    await click(buttons("Clasificar como prueba")[0])
    await settle()
    assert.match(document.querySelector('[data-testid="order-test-restock-plan"]')?.textContent ?? "", /AURICULAR ÑANDÚ · Negro mate: \+1/)
    assert.match(modalText(), /Reingresar al stock 1 unidad/)
    assert.equal(submitButton()?.hasAttribute("disabled"), true, "sin motivo")
    await setValue('textarea[aria-label="Motivo de la clasificación"]', "Compra de prueba del propietario")
    assert.equal(submitButton()?.hasAttribute("disabled"), true, "sin confirmación")
    await setValue('input[aria-label="Confirmación BX-1019"]', "BX-1020")
    assert.equal(submitButton()?.hasAttribute("disabled"), true, "confirmación incorrecta")
    await setValue('input[aria-label="Confirmación BX-1019"]', "bx-1019")
    assert.equal(submitButton()?.hasAttribute("disabled"), false)

    const confirm = submitButton()
    await click(confirm)
    await click(confirm)
    await settle()
    const posts = calls.filter((call) => call.method === "POST")
    assert.deepEqual(posts, [{
      method: "POST",
      path: "/api/admin/orders/19/test-classification",
      body: { reason: "Compra de prueba del propietario", confirmation: "bx-1019", restock: true },
    }], "doble clic = un solo envío")
    assert.match(text(), /Clasificada el .*Compra de prueba del propietario.*Fuera de las estadísticas comerciales/)
    assert.equal(buttons("Clasificar como prueba").length, 0, "ya no ofrece clasificar")
    assert.equal(pedido.archived_at, "2026-11-24T20:00:00.000Z")
    assert.equal(notifications, 1)

    // Archivo: una prueba clasificada no ofrece "Restaurar"; un pedido común
    // archivado sí, y archivar nunca ofrece ocultar la compra al cliente.
    const { OrderArchivePanel } = await import("../../app/admin/sections/pedidos/order-archive-panel")
    const renderArchive = async (order: Record<string, unknown>) => act(async () => {
      root.render(createElement(OrderArchivePanel, { pedido: order as never, onUpdated: () => {} }))
    })
    await renderArchive(pedido)
    assert.match(text(), /Compra de prueba: permanece archivada/)
    assert.equal(buttons("Restaurar al listado").length, 0)
    await renderArchive({ id: 21, estado: "entregado", archived_at: "2026-11-24T20:00:00.000Z", archive_reason: "Archivo ordinario", test_order_at: null })
    assert.equal(buttons("Restaurar al listado").length, 1)
    await renderArchive({ id: 22, estado: "entregado", archived_at: null, test_order_at: null })
    await click(buttons("Archivar pedido")[0])
    await settle()
    assert.ok(document.querySelector('textarea[aria-label="Motivo del archivo"]'), "modal abierto")
    assert.equal(document.querySelector('input[type="checkbox"]'), null, "sin opción de ocultar al cliente")
    assert.match(document.body.textContent ?? "", /El cliente lo sigue viendo/)
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
