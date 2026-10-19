import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { dispatchToday } from "./dispatch-board-filters"

test("Pendientes y Confirmados: filtros, selección y fila accesible abren el pedido", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-queue-ui.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-queue-ui-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const order = (id: number, prepared: boolean) => ({ id, created_at: id === 7 ? `${dispatchToday()}T15:32:00-03:00` : "2026-10-16T15:32:00-03:00", cliente_nombre: "Lucas", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 50000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, andreani_envio_id: prepared ? "ENV" : null, andreani_tracking: prepared ? `3600000010${id.toString().padStart(2, "0")}` : null, andreani_creation_status: prepared ? "created" : null, package: prepared ? { id, order_id: id, status: "prepared", attempt_number: 1, prepared_at: "2026-10-16T15:00:00Z", prepared_by: null, identification_method: "andreani" } : null, membership: null, itemCount: 1, units: 2, scannedUnits: prepared ? 2 : 0 })
  const board = { orders: [order(6, false), order(7, true), { ...order(9, true), andreani_envio_id: null, andreani_tracking: null, andreani_creation_status: null, package: { ...order(9, true).package!, identification_method: null } }], batches: [], holds: [] }
  const detail = { order: board.orders[0], package: null, lines: [], saleItems: [{ orderItemId: 1, sku: "MT01", productName: "Mate", variantName: "Negro", orderedQuantity: 2, unitPrice: 10000 }], parcels: [], stage: "pending", itemCount: 1, expectedUnits: 2, membership: null, batch: null, shipping: { costsVisible: true, estimate: null, parcelQuote: null }, hold: null, shipment: { created: false, envioId: null, tracking: null, creationStatus: null }, adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: true, canShip: true, canForce: false } }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/orders/6")) return Response.json(detail)
    const params = new URL(url, "https://beyonix.test").searchParams
    const selected = board.orders.filter((item) => {
      const ready = item.package?.status === "prepared" && Boolean(item.andreani_tracking)
      return (params.get("tab") === "ready" ? ready : !ready) &&
        (!params.get("search") || `BX-${1000 + item.id}`.includes(params.get("search")!)) &&
        (!params.get("dateFrom") || item.created_at.slice(0, 10) >= params.get("dateFrom")!) &&
        (!params.get("dateTo") || item.created_at.slice(0, 10) <= params.get("dateTo")!)
    })
    return Response.json({ ...board, orders: selected, total: selected.length, page: 1 })
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)) }) }
  const change = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); input.dispatchEvent(new dom.window.Event("change", { bubbles: true })) })
  }
  try {
    await act(async () => { root.render(<AdminDispatches />) })
    await settle()
    assert.equal(dom.window.document.querySelectorAll('table[aria-label="Pedidos pendientes"] tbody tr').length, 2)
    assert.match(dom.window.document.querySelector('table[aria-label="Pedidos pendientes"]')?.textContent ?? "", /BX-1009[\s\S]*Pedido completo/)
    const search = dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[type="search"]')!
    await change(search, "1007")
    await settle()
    assert.equal(dom.window.document.querySelectorAll('table[aria-label="Pedidos pendientes"] tbody tr').length, 0)
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click() })
    await settle()
    assert.equal(dom.window.document.querySelectorAll('table[aria-label="Pedidos pendientes"] tbody tr').length, 2)
    const date = dom.window.document.querySelector<HTMLInputElement>('.dispatch-filters input[type="date"]')!
    await change(date, "2026-10-15")
    await settle()
    assert.equal(dom.window.document.querySelectorAll('table[aria-label="Pedidos pendientes"] tbody tr').length, 0)
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".dispatch-filter-clear")!.click() })
    await settle()
    await act(async () => { [...dom.window.document.querySelectorAll<HTMLButtonElement>(".dispatch-tabs button")].find((button) => button.textContent?.includes("Confirmados"))!.click() })
    await settle()
    assert.equal(dom.window.document.querySelectorAll('table[aria-label="Pedidos confirmados"] tbody tr').length, 1)
    assert.doesNotMatch(dom.window.document.querySelector('table[aria-label="Pedidos confirmados"]')?.textContent ?? "", /BX-1009/)
    const checkbox = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Seleccionar BX-1007"]')!
    await act(async () => { checkbox.click() })
    assert.match(dom.window.document.body.textContent ?? "", /1 seleccionados/)
    assert.ok(dom.window.document.querySelector('table[aria-label="Pedidos confirmados"]'))
    await act(async () => { [...dom.window.document.querySelectorAll<HTMLButtonElement>(".dispatch-tabs button")].find((button) => button.textContent?.includes("Pendientes"))!.click() })
    await settle()
    const row = dom.window.document.querySelector<HTMLTableRowElement>('table[aria-label="Pedidos pendientes"] tbody tr')!
    await act(async () => { row.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })) })
    await settle()
    assert.match(dom.window.document.body.textContent ?? "", /Pedido BX-1006/)
    assert.ok(dom.window.document.querySelector('table[aria-label="Productos del pedido"]'))
    assert.match(dom.window.document.body.textContent ?? "", /TOTAL PEDIDO:[\s\S]*50\.000/)
  } finally {
    await act(async () => root.unmount())
    supabase.auth.stopAutoRefresh()
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    const channel: unknown = Reflect.get(supabase.auth, "broadcastChannel")
    if (channel instanceof BroadcastChannel) channel.close()
    dom.window.close()
  }
})
