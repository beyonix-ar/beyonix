import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

// UI de Despachos para las cancelaciones posteriores al armado y la salida a
// Andreani: alerta visible, confirmación explícita del retiro, escaneo y
// resultado claro; la entrega exige escanear la etiqueta del lote.

type Json = Record<string, unknown>

async function setup(url: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-cancel.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-cancel-key"
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  return { dom, root: createRoot(dom.window.document.getElementById("root")!) }
}

const settle = async (ms = 80) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
const button = (dom: JSDOM, text: string) => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes(text))

async function type(dom: JSDOM, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
}
async function submit(dom: JSDOM, input: HTMLInputElement) {
  await act(async () => { input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
  await settle()
}

const hold = { id: 4, orderId: 6, units: 3, pickedUnits: 3, prepared: true, itemCount: 2, detectedAt: "2026-10-16T10:00:00Z", batchId: 9, batchCode: "DSP-20261016-001", preparedCode: "BX-PREP-1006" }

test("filtro 1/2: alerta, confirmación del retiro, escaneo y stock liberado una vez", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?resolve=6")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  let resolved = false
  const posts: Json[] = []
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/resolutions")) {
      const body = JSON.parse(String(init?.body)) as Json
      posts.push(body)
      if (body.code === "BAR-A-RED") return Response.json({ error: "Ese código es de un producto. Escaneá el código del pedido preparado o la etiqueta de un bulto." }, { status: 409 })
      resolved = true
      return Response.json({ orderId: 6, units: 3, batchId: 9, batchCode: "DSP-20261016-001", duplicate: false, alreadyResolved: false })
    }
    return Response.json({ orders: [], batches: [], holds: resolved ? [] : [hold] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialResolveId="6" />) })
    await settle(150)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /Pedido BX-1006 cancelado/)
    assert.match(text(), /Este pedido ya fue preparado físicamente y está dentro del lote DSP-20261016-001/)
    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear pedido cancelado"]')!
    assert.equal(input().disabled, true, "sin confirmar el retiro no se puede escanear")
    const confirm = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((item) => item.closest("label")?.textContent?.includes("Confirmo que retiré físicamente"))!
    await act(async () => { confirm.click() })
    assert.equal(input().disabled, false)
    await type(dom, input(), "BAR-A-RED"); await submit(dom, input())
    assert.match(text(), /Ese código es de un producto/)
    await type(dom, input(), "BX-PREP-1006"); await submit(dom, input())
    assert.match(text(), /BX-1006 retirado del despacho/)
    assert.match(text(), /Stock liberado: 3 unidades/)
    assert.match(text(), /Quitado del lote DSP-20261016-001/)
    assert.match(text(), /Reintegro manual requerido: nada vuelve automáticamente \(tampoco el saldo a favor\)/, "el escaneo no habilita reintegro automático")
    assert.deepEqual(posts.map((post) => [post.code, post.orderId]), [["BAR-A-RED", 6], ["BX-PREP-1006", 6]])
    assert.notEqual(posts[0].requestKey, posts[1].requestKey, "un código nuevo usa una clave nueva")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("pickeo parcial: requiere resolución física, pide devolver lo pickeado e identifica el pedido por su número", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos")
  const { CancellationResolution } = await import("../../app/admin/sections/despachos/cancellation-resolution")
  const posts: Json[] = []
  globalThis.fetch = async (_input, init) => {
    posts.push(JSON.parse(String(init?.body)) as Json)
    return Response.json({ orderId: 6, units: 3, pickedUnits: 1, batchId: null, batchCode: null, duplicate: false, alreadyResolved: false })
  }
  try {
    await act(async () => { root.render(<CancellationResolution hold={{ ...hold, pickedUnits: 1, prepared: false, batchId: null, batchCode: null }} onClose={() => {}} />) })
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /ya tenía 1 de 3 unidades pickeadas/)
    assert.match(text(), /Requiere resolución física/)
    assert.match(text(), /El reintegro \(incluido el saldo a favor\) es manual: nunca automático/)
    assert.match(text(), /Confirmo que devolví a la estantería la unidad pickeada de BX-1006/)
    const confirm = [...dom.window.document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')][0]
    await act(async () => { confirm.click() })
    const input = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear pedido cancelado"]')!
    await type(dom, input, "BX-1006"); await submit(dom, input)
    assert.deepEqual(posts.map((post) => [post.code, post.orderId]), [["BX-1006", 6]])
    assert.match(text(), /Stock liberado: 3 unidades/)
    assert.match(text(), /Reintegro manual requerido/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("salida a Andreani: sólo con la etiqueta de ESTE lote y una confirmación", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?batch=9")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const batch = { id: 9, code: "DSP-20261016-001", status: "closed", created_at: "2026-10-16T09:00:00Z", closed_at: "2026-10-16T11:00:00Z", prepared_at: "2026-10-16T11:00:00Z", handed_over_at: null as string | null, handed_over_by: null }
  const handovers: Json[] = []
  const detail = (): Json => ({ batch, blockedCount: 0, operatorName: null, parcelCount: 1, scannedParcelCount: 1, items: [{ id: 1, batch_id: 9, order_id: 31, package_id: 7, added_at: batch.created_at, removed_at: null, blocked: false, blockReason: null, cancellationHold: false, parcelCount: 1, scannedParcels: 1, parcels: [] }] })
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/barcode")) return new Response(new Blob(), { status: 500 })
    if (path.endsWith("/batches/9") && init?.body) {
      const body = JSON.parse(String(init.body)) as Json
      handovers.push(body)
      Object.assign(batch, { status: "handed_over", handed_over_at: "2026-10-16T12:00:00Z" })
      return Response.json({ ...detail(), handover: { duplicate: false } })
    }
    if (path.endsWith("/batches/9")) return Response.json(detail())
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: 1, packageCount: 1, blockedCount: 0 }], holds: [] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="9" />) })
    await settle(150)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /Lote cerrado no es lo mismo que entregado/)
    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear etiqueta del lote"]')!
    await type(dom, input(), "DSP-20261015-007"); await submit(dom, input())
    assert.match(text(), /Ese código no corresponde a este lote/)
    assert.equal(handovers.length, 0, "un código equivocado no envía nada")
    await type(dom, input(), "dsp-20261016-001"); await submit(dom, input())
    assert.match(text(), /¿Confirmás que el lote salió físicamente hacia Andreani\?/)
    await act(async () => { button(dom, "Confirmar salida")!.click() })
    await settle(150)
    assert.deepEqual(handovers, [{ action: "handover", code: "DSP-20261016-001" }])
    assert.match(text(), /Lote entregado a Andreani/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
