import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

// react-dom detecta el soporte de eventos al importarse: el DOM tiene que
// existir antes (si no, onChange no recibe los eventos "input" simulados).
type Json = Record<string, unknown>

async function setup(url: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-armado.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-armado-key"
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  return { dom, root: createRoot(dom.window.document.getElementById("root")!) }
}

const settle = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }

async function type(dom: JSDOM, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
}

async function submit(dom: JSDOM, form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
  await settle()
}

const button = (dom: JSDOM, text: string) => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes(text))

test("ARMAR PEDIDO: escaneo con mensajes exactos, reintento idempotente y bultos editables", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/pedidos/31?tab=armado")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const order = { id: 31, estado: "pagado", financial_status: "payment_confirmed", payment_status: "confirmado", invoice_status: "authorized", shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null }
  let scanned = 0
  let parcelCount: number | null = null
  const keys: string[] = []
  let dropNextScan = false
  const detail = (): Json => ({
    order,
    package: { id: 7, order_id: 31, status: scanned === 1 ? "prepared" : "preparing", attempt_number: 1, prepared_at: null, prepared_by: null, parcel_count: parcelCount },
    lines: [{ order_item_id: 1, expected_sku: "AUR-N", expected_barcode: "7790001000017", expected_quantity: 1, scanned_quantity: scanned, product_id: 1, variant_id: 11, conditioned_stock_id: null, name: "Auriculares · Negro" }],
    parcels: parcelCount ? Array.from({ length: parcelCount }, (_, index) => ({ id: index + 1, parcel_index: index + 1, parcel_count: parcelCount, barcode: `BX-PKG-1031-0${index + 1}`, attempt_number: 1 })) : [],
    stage: parcelCount ? "parcels_ready" : scanned ? "packed" : "packing",
    itemCount: 1, expectedUnits: 1, membership: null, batch: null, blocked: false, blockReason: null,
  })
  globalThis.fetch = async (_input, init) => {
    if (!init?.body) return Response.json(detail())
    const body = JSON.parse(String(init.body)) as { action: string; code?: string; requestKey?: string; parcelCount?: number }
    if (body.action === "scan") {
      keys.push(body.requestKey ?? "")
      if (dropNextScan) { dropNextScan = false; throw new TypeError("network down") }
      if (body.code === "OTRO") return Response.json({ error: "Este producto no pertenece al pedido." }, { status: 409 })
      if (body.code === "ZZZ") return Response.json({ error: "Código no reconocido." }, { status: 409 })
      if (scanned === 1) return Response.json({ error: "Cantidad requerida ya completada." }, { status: 409 })
      scanned = 1
      return Response.json({ ...detail(), scan: { orderItemId: 1, scanned: 1, expected: 1, duplicate: false } })
    }
    if (body.action === "parcels") { parcelCount = body.parcelCount ?? null; return Response.json(detail()) }
    return Response.json({ error: "Acción inválida." }, { status: 400 })
  }
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /En armado/)
    assert.match(text(), /Auriculares · Negro/)
    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar código / SKU"]')!
    const form = () => input().closest("form") as HTMLFormElement
    await type(dom, input(), "OTRO"); await submit(dom, form())
    assert.match(text(), /Este producto no pertenece al pedido\./)
    await type(dom, input(), "ZZZ"); await submit(dom, form())
    assert.match(text(), /Código no reconocido\./)
    dropNextScan = true
    await type(dom, input(), "7790001000017"); await submit(dom, form())
    assert.match(text(), /Sin conexión\. Reintentá: el escaneo no se duplica\./)
    assert.equal(input().value, "7790001000017", "el código queda para reintentar")
    await submit(dom, form())
    assert.match(text(), /✓ Auriculares · Negro · 1 de 1/)
    assert.equal(keys.at(-1), keys.at(-2), "el reintento de red reutiliza la misma clave")
    assert.equal(new Set(keys).size, keys.length - 1, "cada escaneo nuevo usa su propia clave")
    assert.match(text(), /Completo/)
    await act(async () => { button(dom, "FINALIZAR ARMADO")!.click() })
    assert.match(text(), /¿Cuántos bultos físicos tiene este pedido\?/)
    const parcels = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Cantidad de bultos"]')!
    assert.equal(parcels.value, "1", "un pedido de una sola unidad sugiere 1 bulto")
    await type(dom, parcels, "3")
    await act(async () => { button(dom, "Confirmar bultos")!.click() })
    await settle()
    assert.match(text(), /Armado completo · 3 bultos/)
    assert.match(text(), /BX-PKG-1031-03 · Bulto 3\/3/)
    assert.match(text(), /Etiquetas de bultos/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("lote de envío: escaneo de bultos, Pedidos/Bultos y CERRAR LOTE sólo con todos los bultos", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?batch=5")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const batch = { id: 5, code: "DSP-20261007-001", status: "open", created_at: "2026-10-07T12:00:00Z", closed_at: null, prepared_at: null, handed_over_at: null, handed_over_by: null }
  const scannedIds = new Set<number>()
  const parcels = [1, 2].map((index) => ({ id: index, parcel_index: index, parcel_count: 2, barcode: `BX-PKG-1050-0${index}`, attempt_number: 1 }))
  const detail = (): Json => ({ batch, blockedCount: 0, operatorName: null, parcelCount: 2, scannedParcelCount: scannedIds.size, items: [{ id: 9, batch_id: 5, order_id: 50, package_id: 7, added_at: batch.created_at, removed_at: null, blocked: false, blockReason: null, parcelCount: 2, scannedParcels: scannedIds.size, parcels: parcels.map((parcel) => ({ ...parcel, scanned: scannedIds.has(parcel.id) })) }] })
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/barcode")) return new Response(new Blob(), { status: 500 })
    if (path.endsWith("/batches/5") && init?.body) {
      const body = JSON.parse(String(init.body)) as { action: string; code: string }
      const parcel = parcels.find((item) => item.barcode === body.code)
      if (!parcel) return Response.json({ error: "Bulto no reconocido." }, { status: 409 })
      const duplicate = scannedIds.has(parcel.id)
      scannedIds.add(parcel.id)
      return Response.json({ ...detail(), scan: { orderId: 50, parcelIndex: parcel.parcel_index, parcelCount: 2, scannedCount: scannedIds.size, complete: scannedIds.size === 2, duplicate } })
    }
    if (path.endsWith("/batches/5")) return Response.json(detail())
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: 1, packageCount: 2, blockedCount: 0 }] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="5" />) })
    await settle(120)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /Pedidos: 1 \/ Bultos: 2/)
    assert.equal(button(dom, "CERRAR LOTE")?.disabled, true)
    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear bulto"]')!
    const form = () => input().closest("form") as HTMLFormElement
    await type(dom, input(), "BX-PKG-1050-01"); await submit(dom, form())
    assert.match(text(), /✓ BX-1050 · Bulto 1\/2 · 1 de 2 bultos/)
    await type(dom, input(), "BX-PKG-1050-01"); await submit(dom, form())
    assert.match(text(), /Bulto ya escaneado BX-1050 · Bulto 1\/2/)
    await type(dom, input(), "BX-PKG-9999-01"); await submit(dom, form())
    assert.match(text(), /Bulto no reconocido\./)
    assert.equal(button(dom, "CERRAR LOTE")?.disabled, true)
    await type(dom, input(), "BX-PKG-1050-02"); await submit(dom, form())
    assert.match(text(), /pedido completo/)
    await settle(300)
    assert.equal(button(dom, "CERRAR LOTE")?.disabled, false)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
