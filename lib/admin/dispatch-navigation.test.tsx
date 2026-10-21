import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

// Despachos como cola operativa: lo pendiente no desaparece por fecha, cada
// pedido tiene URL estable y Volver/Atrás regresan a la pestaña de origen.
test("Confirmados conserva pedidos de días anteriores; abrir, volver, refrescar y enlace directo no pierden el contexto", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-navigation.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-navigation-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos?tab=ready" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  let root = createRoot(dom.window.document.getElementById("root")!)

  // BX-1011: preparado ayer (20/10 23:46), etiqueta confirmada. BX-1012: hace días, falta confirmar etiqueta.
  const order = (id: number, preparedAt: string, identified: boolean) => ({ id, created_at: preparedAt, cliente_nombre: "Lucía Núñez", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 30000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: `API00001741855${id}`, andreani_tracking: `3600031369117${id}`, andreani_creation_status: "created", andreani_created_at: preparedAt, package: { id, order_id: id, status: "prepared", attempt_number: 1, prepared_at: preparedAt, prepared_by: null, identification_method: identified ? "andreani" : null }, membership: null, itemCount: 1, units: 1, scannedUnits: 1 })
  const board = { orders: [order(11, "2026-10-21T02:46:00Z", true), order(12, "2026-10-14T15:00:00Z", false)], batches: [], holds: [] }
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    const match = /\/orders\/(\d+)$/.exec(url)
    if (match) {
      const item = board.orders.find((entry) => entry.id === Number(match[1]))!
      return Response.json({ order: item, package: item.package, lines: [], saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 1, unitPrice: null }], parcels: [], stage: item.package.identification_method ? "ready" : "label", itemCount: 1, expectedUnits: 1, membership: null, batch: null, shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null, shipment: { created: true, envioId: item.andreani_envio_id, tracking: item.andreani_tracking, creationStatus: "created" }, adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: false, canShip: false, canForce: false } })
    }
    const params = new URL(url, "https://beyonix.test").searchParams
    // El servidor aplica la fecha sólo si llega: sin ella, Confirmados trae todo lo que no está en un Bulto.
    const selected = params.get("tab") === "ready" ? board.orders.filter((item) =>
      (!params.get("search") || `BX-${1000 + item.id}`.includes(params.get("search")!)) &&
      (!params.get("dateFrom") || item.package.prepared_at.slice(0, 10) >= params.get("dateFrom")!)) : []
    return Response.json({ ...board, orders: selected, total: selected.length, page: 1 })
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) }) }
  const text = () => dom.window.document.body.textContent ?? ""
  const rows = () => [...dom.window.document.querySelectorAll<HTMLTableRowElement>('table[aria-label="Pedidos confirmados"] tbody tr')]
  const back = () => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes("Volver"))!
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
    await act(async () => { root.render(<AdminDispatches initialTab="ready" />) })
    await settle()
    // Casos B/C: ayer y hace una semana siguen en la cola; sin fecha por defecto.
    assert.equal(rows().length, 2)
    assert.ok(requests.every((url) => !url.includes("dateFrom")), "Confirmados no manda fecha por defecto")
    assert.match(rows()[0].textContent ?? "", /BX-1011[\s\S]*20\/10, 23:46[\s\S]*Listo para Bulto/)
    assert.match(rows()[1].textContent ?? "", /BX-1012[\s\S]*Falta confirmar etiqueta/)
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1012"]')?.disabled, true, "sin etiqueta confirmada no entra al Bulto")
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1011"]')?.disabled, false)

    // Búsqueda manual: se conserva al volver.
    await change(dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[aria-label="NRO PEDIDO"]')!, "1011")
    await settle()
    assert.equal(rows().length, 1)

    // Abrir desde Confirmados: URL estable del pedido; Volver regresa a Confirmados con el filtro.
    await act(async () => { rows()[0].click() })
    await settle()
    assert.equal(`${dom.window.location.pathname}${dom.window.location.search}`, "/admin/despachos?tab=ready&order=11")
    assert.match(text(), /Pedido BX-1011/)
    assert.match(text(), /Etiqueta confirmada/)
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready")
    assert.ok(dom.window.document.querySelector('table[aria-label="Pedidos confirmados"]'))
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[aria-label="NRO PEDIDO"]')!.value, "1011")
    assert.equal(rows().length, 1)

    // Atrás del navegador: mismo resultado.
    await act(async () => { rows()[0].click() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready&order=11")
    await act(async () => { dom.window.history.back() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready")
    assert.ok(dom.window.document.querySelector('table[aria-label="Pedidos confirmados"]'), "Atrás vuelve a Confirmados")

    // Refrescar dentro de la preparación: la URL reabre el mismo pedido y los filtros de la sesión.
    await act(async () => { rows()[0].click() })
    await settle()
    await cleanup()
    root = createRoot(dom.window.document.getElementById("root")!)
    await act(async () => { root.render(<AdminDispatches initialTab="ready" initialOrderId="11" />) })
    await settle()
    assert.match(text(), /Pedido BX-1011/)
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready", "sin historial propio: reemplaza por la pestaña, no sale de Despachos")
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[aria-label="NRO PEDIDO"]')!.value, "1011", "filtro restaurado de la sesión")

    // Enlace directo desde Pedidos (?order= sin pestaña): la etapa ubica el pedido en Confirmados.
    await cleanup()
    dom.window.history.replaceState(null, "", "/admin/despachos?order=12")
    root = createRoot(dom.window.document.getElementById("root")!)
    await act(async () => { root.render(<AdminDispatches initialOrderId="12" />) })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready&order=12")
    assert.ok(dom.window.document.querySelector('input[aria-label="Escaneá o escribí el seguimiento"]'), "falta confirmar etiqueta: campo de escaneo")
    await act(async () => { back().click() })
    await settle()
    assert.equal(dom.window.location.search, "?tab=ready")
    assert.ok(dom.window.document.querySelector('table[aria-label="Pedidos confirmados"]'))
  } finally {
    await cleanup()
    dom.window.close()
  }
})
