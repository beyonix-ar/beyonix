import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

test("control móvil: Bulto correcto, cancelado bloquea, retiro recalcula y confirmación termina", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-mobile.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-mobile-key"
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos/bultos/47/control" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import("react-dom/client")
  const { MobileBundleControl } = await import("../../app/admin/despachos/bultos/[id]/control/mobile-bundle-control")
  const root = createRoot(dom.window.document.getElementById("root")!)
  const batch = { id: 47, code: "DSP-20261018-001", display_number: 1, status: "closed", created_at: "2026-10-18T12:00:00Z", handed_over_at: null }
  let removed = false
  let confirmed = false
  const posts: string[] = []
  const detail = () => ({ batch: { ...batch, status: confirmed ? "handed_over" : "closed" }, name: 1,
    items: [{ orderId: 9, status: "CORRECTO", blocked: false, hold: null }, ...removed ? [] : [{ orderId: 10, status: "CANCELADO", blocked: true,
      hold: { id: 1, orderId: 10, units: 1, pickedUnits: 1, prepared: true, itemCount: 1, detectedAt: batch.created_at, batchId: 47, batchCode: batch.code } }]],
    removedOrderIds: removed ? [10] : [], parcelCount: removed ? 1 : 2 })
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/batches/47/control") && init?.body) { posts.push("confirm"); confirmed = true; return Response.json({ batchId: 47, duplicate: false }) }
    if (path.endsWith("/batches/47/control")) return Response.json(detail())
    if (path.endsWith("/resolutions") && init?.body) { posts.push("remove"); removed = true; return Response.json({ orderId: 10, units: 1, pickedUnits: 1, batchId: 47, batchCode: batch.code, duplicate: false, alreadyResolved: false }) }
    return Response.json({ error: "Ruta inesperada" }, { status: 404 })
  }
  const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) }) }
  try {
    await act(async () => { root.render(<MobileBundleControl id="47" />) })
    await settle()
    const body = () => dom.window.document.body.textContent ?? ""
    const confirm = () => [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "CONFIRMAR")!
    assert.match(body(), /Bulto: 0001/)
    assert.match(body(), /BX-1009CORRECTO/)
    assert.match(body(), /BX-1010CANCELADO/)
    assert.equal(confirm().disabled, true)
    assert.match(body(), /Cantidad de paquetes a despachar: 2/)
    await act(async () => { dom.window.document.querySelector("summary")!.click() })
    await act(async () => { [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Retirar")!.click() })
    await act(async () => { dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click() })
    const input = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear pedido cancelado"]')!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(input, "BX-1010"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    await act(async () => { input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
    await settle()
    await act(async () => { [...dom.window.document.querySelectorAll("button")].find((button) => button.textContent === "Listo")!.click() })
    await settle()
    assert.match(body(), /BX-1010RETIRADO/)
    assert.match(body(), /Cantidad de paquetes a despachar: 1/)
    assert.equal(confirm().disabled, false)
    await act(async () => { confirm().click() })
    await settle()
    assert.deepEqual(posts, ["remove", "confirm"])
    assert.match(body(), /ENTREGADO/)
    assert.equal(confirm(), undefined, "la entrega no añade otro paso")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
