import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { dispatchToday } from "./dispatch-records"

// Cada pedido tiene URL estable; Volver/Atrás regresan a la tabla con sus filtros.
test("abrir, volver, refrescar y enlace directo no pierden el pedido ni los filtros", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-navigation.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-navigation-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos?tab=ready" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  let root = createRoot(dom.window.document.getElementById("root")!)
  const today = dispatchToday()

  // BX-1011 con etiqueta confirmada; BX-1012 falta confirmar etiqueta.
  const order = (id: number, identified: boolean) => ({ id, created_at: `${today}T09:00:00-03:00`, cliente_nombre: "Lucía Núñez", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 30000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: `API00001741855${id}`, andreani_tracking: `3600031369117${id}`, andreani_creation_status: "created", andreani_created_at: `${today}T09:30:00-03:00`, package: { id, order_id: id, status: "prepared", attempt_number: 1, prepared_at: `${today}T10:00:00-03:00`, prepared_by: null, identification_method: identified ? "andreani" : null } })
  const orders = [order(11, true), order(12, false)]
  const rows = orders.map((item) => ({ kind: "order", id: item.id, code: null, displayNumber: null, state: "C", at: item.package.prepared_at, actorId: null, actorName: null, units: 1, total: 30000, orderCount: 1, selectable: Boolean(item.package.identification_method) }))
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const match = /\/orders\/(\d+)$/.exec(url)
    if (match) {
      const item = orders.find((entry) => entry.id === Number(match[1]))!
      return Response.json({ order: item, package: item.package, lines: [], saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 1, unitPrice: null }], parcels: [], stage: item.package.identification_method ? "ready" : "label", itemCount: 1, expectedUnits: 1, membership: null, batch: null, shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null, shipment: { created: true, envioId: item.andreani_envio_id, tracking: item.andreani_tracking, creationStatus: "created" }, adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: false, canShip: false, canForce: false } })
    }
    const params = new URL(url, "https://beyonix.test").searchParams
    const selected = rows.filter((row) => !params.get("order") || `BX-${1000 + row.id}`.includes(params.get("order")!))
    return Response.json({ rows: selected, total: selected.length, page: 1, pageSize: 20, holds: [], users: [] })
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) }) }
  const text = () => dom.window.document.body.textContent ?? ""
  const tableRows = () => [...dom.window.document.querySelectorAll<HTMLTableRowElement>('table[aria-label="Registros de despachos"] tbody tr')]
  const back = () => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes("Volver"))!
  const orderFilter = () => dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[aria-label="N° PEDIDO"]')!
  const change = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
  }
  const cleanup = async () => {
    await act(async () => root.unmount())
    supabase.auth.stopAutoRefresh()
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    const channel: unknown = Reflect.get(supabase.auth, "broadcastChannel")
    if (channel instanceof BroadcastChannel) channel.close()
  }
  try {
    // Enlace viejo con ?tab=: abre la tabla única.
    await act(async () => { root.render(<AdminDispatches />) })
    await settle()
    assert.equal(tableRows().length, 2)
    assert.ok(requests.every((url) => !url.includes("tab=")))
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1012 para un Bulto"]'), null, "sin etiqueta confirmada no entra al Bulto")
    assert.ok(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1011 para un Bulto"]'))

    await change(orderFilter(), "1011")
    await settle()
    assert.equal(tableRows().length, 1)

    // Abrir: URL estable del pedido; Volver regresa a la tabla con el filtro.
    await act(async () => { tableRows()[0].click() })
    await settle()
    assert.equal(`${dom.window.location.pathname}${dom.window.location.search}`, "/admin/despachos?order=11")
    assert.match(text(), /Pedido BX-1011/)
    assert.match(text(), /Etiqueta confirmada/)
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready", "Volver = atrás: la entrada previa del historial")
    assert.equal(orderFilter().value, "1011")
    assert.equal(tableRows().length, 1)

    // Atrás del navegador: mismo resultado.
    await act(async () => { tableRows()[0].click() })
    await settle()
    assert.equal(dom.window.location.search, "?order=11")
    await act(async () => { dom.window.history.back() })
    await settle()
    assert.ok(dom.window.document.querySelector('table[aria-label="Registros de despachos"]'), "Atrás vuelve a la tabla")

    // Refrescar dentro del pedido: la URL lo reabre y los filtros vuelven de la sesión.
    await act(async () => { tableRows()[0].click() })
    await settle()
    await cleanup()
    root = createRoot(dom.window.document.getElementById("root")!)
    await act(async () => { root.render(<AdminDispatches initialOrderId="11" />) })
    await settle()
    assert.match(text(), /Pedido BX-1011/)
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "", "sin historial propio: reemplaza por la tabla, no sale de Despachos")
    assert.equal(orderFilter().value, "1011", "filtro restaurado de la sesión")

    // Enlace directo desde Pedidos (?order=).
    await cleanup()
    dom.window.history.replaceState(null, "", "/admin/despachos?order=12")
    root = createRoot(dom.window.document.getElementById("root")!)
    await act(async () => { root.render(<AdminDispatches initialOrderId="12" />) })
    await settle()
    assert.equal(dom.window.location.search, "?order=12")
    assert.ok(dom.window.document.querySelector('input[aria-label="Escaneá o escribí el seguimiento"]'), "falta confirmar etiqueta: campo de escaneo")
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "")
    assert.ok(dom.window.document.querySelector('table[aria-label="Registros de despachos"]'))
  } finally {
    await cleanup()
    dom.window.close()
  }
})
