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

test("ARMAR PEDIDO: cancelado muestra el bloqueo y no permite iniciar armado", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/pedidos/2?tab=armado")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  globalThis.fetch = async () => Response.json({
    order: { id: 2, estado: "cancelado", financial_status: "refunded", cancelled_at: "2026-10-13T00:00:00Z" },
    package: null, lines: [], parcels: [], stage: "pending", itemCount: 0, expectedUnits: 0,
    membership: null, batch: null, blocked: true, blockReason: "Pedido cancelado — no requiere preparación",
    shipping: { costsVisible: false, estimate: null, parcelQuote: null },
  })
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={2} />) })
    await settle()
    assert.match(dom.window.document.body.textContent ?? "", /Pedido cancelado — no requiere preparación/)
    assert.equal(button(dom, "INICIAR ARMADO"), undefined)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("ARMAR PEDIDO: escaneo con mensajes exactos, reintento idempotente, identificación BX-PREP antes de las medidas del paquete", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/pedidos/31?tab=armado")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const order = { id: 31, estado: "pagado", financial_status: "payment_confirmed", payment_status: "confirmado", invoice_status: "authorized", shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null }
  let scanned = 0
  let identified = false
  let parcelCount: number | null = null
  let savedParcels: Array<{ weightKg: number; lengthCm: number; widthCm: number; heightCm: number }> = []
  const keys: string[] = []
  let dropNextScan = false
  const detail = (): Json => ({
    order,
    package: { id: 7, order_id: 31, status: scanned === 1 ? "prepared" : "preparing", attempt_number: 1, prepared_at: null, prepared_by: null, parcel_count: parcelCount, identification_method: identified ? "printed" : null, identified_at: identified ? "2026-10-16T10:00:00Z" : null },
    lines: [{ order_item_id: 1, expected_sku: "AUR-N", expected_barcode: "7790001000017", expected_quantity: 1, scanned_quantity: scanned, product_id: 1, variant_id: 11, conditioned_stock_id: null, name: "Auriculares · Negro" }],
    parcels: parcelCount ? Array.from({ length: parcelCount }, (_, index) => ({ id: index + 1, parcel_index: index + 1, parcel_count: parcelCount, barcode: `BX-PKG-1031-0${index + 1}`, attempt_number: 1, weight_kg: savedParcels[index]?.weightKg ?? null, length_cm: savedParcels[index]?.lengthCm ?? null, width_cm: savedParcels[index]?.widthCm ?? null, height_cm: savedParcels[index]?.heightCm ?? null })) : [],
    shipping: { costsVisible: false, estimate: { parcels: [{ lengthCm: 35, widthCm: 25, heightCm: 18, volumeCm3: 15_750, weightKg: 2.2 }] }, parcelQuote: null },
    stage: !scanned ? "packing" : !identified ? "identify" : parcelCount ? "parcels_ready" : "measures",
    itemCount: 1, expectedUnits: 1, membership: null, batch: null, blocked: true, blockReason: "Envío pendiente",
    // El envío pendiente no frena el pickeo (sólo el ingreso al lote).
    packingBlocked: false, pendingBeforeDispatch: ["Envío pendiente"], hold: null,
    preparedCode: scanned === 1 ? "BX-PREP-1031" : null,
  })
  globalThis.fetch = async (_input, init) => {
    if (!init?.body) return Response.json(detail())
    const body = JSON.parse(String(init.body)) as { action: string; code?: string; requestKey?: string; parcels?: typeof savedParcels }
    if (body.action === "scan") {
      keys.push(body.requestKey ?? "")
      if (dropNextScan) { dropNextScan = false; throw new TypeError("network down") }
      if (body.code === "OTRO") return Response.json({ error: "Este producto no pertenece al pedido." }, { status: 409 })
      if (body.code === "ZZZ") return Response.json({ error: "Código no reconocido." }, { status: 409 })
      if (scanned === 1) return Response.json({ error: "Cantidad requerida ya completada." }, { status: 409 })
      scanned = 1
      return Response.json({ ...detail(), scan: { orderItemId: 1, scanned: 1, expected: 1, duplicate: false } })
    }
    if (body.action === "identify") { identified = true; return Response.json(detail()) }
    if (body.action === "parcels") { savedParcels = body.parcels ?? []; parcelCount = savedParcels.length; return Response.json(detail()) }
    return Response.json({ error: "Acción inválida." }, { status: 400 })
  }
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /En preparación/)
    assert.match(text(), /Envío pendiente: podés preparar el pedido igual/)
    assert.doesNotMatch(text(), /Pedido bloqueado/)
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
    assert.match(text(), /Pedido preparado/)
    assert.match(text(), /BX-PREP-1031/, "muestra el código general del pedido preparado")
    // Orden operativo: sin identificación BX-PREP no se cargan las medidas del paquete.
    assert.equal(button(dom, "CARGAR MEDIDAS DEL PAQUETE")!.disabled, true)
    assert.match(text(), /Primero identificá el pedido con su BX-PREP/)
    const panelText = text()
    assert.ok(panelText.indexOf("Identificación física") < panelText.indexOf("Paquete de envío"), "la identificación se muestra antes del paquete")
    await act(async () => { button(dom, "Etiqueta colocada")!.click() })
    await settle()
    await act(async () => { button(dom, "Reimprimir BX-PREP-1031")!.click() })
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[name="label-format"][value="single"]')?.checked, true, "etiqueta interna pequeña por defecto, aun si el código llegó después de montar el diálogo")
    await act(async () => { button(dom, "Cancelar")!.click() })
    await act(async () => { button(dom, "CARGAR MEDIDAS DEL PAQUETE")!.click() })
    assert.match(text(), /¿Cuántos paquetes de envío salen con este pedido\?/)
    assert.match(text(), /Estimación utilizada en checkout/)
    assert.match(text(), /1 paquete · 35 × 25 × 18 cm · 2,2 kg/)
    const parcels = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Cantidad de paquetes"]')!
    assert.equal(parcels.value, "1", "sugiere la cantidad de paquetes estimada")
    const measure = (index: number, label: string) =>
      dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Paquete ${index}: ${label}"]`)!
    await act(async () => { button(dom, "Usar medidas estimadas")!.click() })
    assert.equal(measure(1, "Peso en kg").value, "2,2")
    assert.equal(measure(1, "Largo en cm").value, "35")
    assert.match(text(), /Medidas copiadas ✓/)
    await type(dom, measure(1, "Peso en kg"), "2,450")
    assert.equal(measure(1, "Peso en kg").value, "2,450", "los campos copiados siguen editables")
    await type(dom, parcels, "2")
    assert.match(text(), /PAQUETE 1/)
    assert.match(text(), /PAQUETE 2/)
    assert.equal(button(dom, "Usar medidas estimadas")!.disabled, true, "con cantidad distinta no duplica la estimación en otro paquete")
    assert.equal(button(dom, "Confirmar paquetes")!.disabled, true, "las medidas son obligatorias")
    for (const [index, values] of [[1, ["2,450", "40", "30", "20"]], [2, ["0,8", "25", "20", "8"]]] as const) {
      await type(dom, measure(index, "Peso en kg"), values[0])
      await type(dom, measure(index, "Largo en cm"), values[1])
      await type(dom, measure(index, "Ancho en cm"), values[2])
      if (index === 2) assert.equal(button(dom, "Confirmar paquetes")!.disabled, true, "falta el alto del paquete 2")
      await type(dom, measure(index, "Alto en cm"), values[3])
    }
    await act(async () => { button(dom, "Confirmar paquetes")!.click() })
    await settle()
    assert.deepEqual(savedParcels, [
      { weightKg: 2.45, lengthCm: 40, widthCm: 30, heightCm: 20 },
      { weightKg: 0.8, lengthCm: 25, widthCm: 20, heightCm: 8 },
    ])
    assert.match(text(), /Paquete de envío · 2 paquetes/)
    assert.match(text(), /BX-PKG-1031-02 · Paquete 2\/2/)
    assert.doesNotMatch(text(), /Bulto [0-9]|[0-9] bultos?\b/, "BX-PKG nunca se llama bulto")
    assert.match(text(), /40 × 30 × 20 cm · 2,45 kg/)
    assert.doesNotMatch(text(), /Cotizado con paquete real/, "el operador no ve importes")
    assert.match(text(), /Etiquetas de paquetes de envío/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
