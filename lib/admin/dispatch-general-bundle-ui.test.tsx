import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"

// Bulto general (esperado ≠ verificado por la etiqueta Andreani de cada
// pedido) y cámara en Admin → Etiquetas. Lector USB, cámara,
// tipeo y pegado llegan al mismo envío; sólo cambia el método informado.

type Json = Record<string, unknown>

async function setup(url: string) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-bundle.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-bundle-key"
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 })
  Object.defineProperty(dom.window.HTMLMediaElement.prototype, "play", { configurable: true, value: async () => {} })
  const { createRoot } = await import("react-dom/client")
  return { dom, root: createRoot(dom.window.document.getElementById("root")!) }
}

/** Cámara simulada (BarcodeDetector nativo): un cuadro por lectura, null = sin código. */
function fakeCamera(frames: Array<string | null>) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }) } } })
  Object.defineProperty(globalThis, "BarcodeDetector", { configurable: true, value: class {
    static async getSupportedFormats() { return ["code_128", "ean_13"] }
    async detect() { const code = frames.length ? frames.shift() ?? null : null; return code ? [{ rawValue: code }] : [] }
  } })
}

const settle = async (ms = 60) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
const button = (dom: JSDOM, text: string) => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes(text))

async function type(dom: JSDOM, input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
}
/** Lector USB: teclas seguidas en pocos milisegundos y Enter. */
async function scanWithReader(dom: JSDOM, input: HTMLInputElement, value: string) {
  await act(async () => { for (const key of value) input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true })) })
  await type(dom, input, value)
  await submit(dom, input)
}
async function paste(dom: JSDOM, input: HTMLInputElement, value: string) {
  await act(async () => { input.dispatchEvent(new dom.window.Event("paste", { bubbles: true })) })
  await type(dom, input, value)
  await submit(dom, input)
}
async function submit(dom: JSDOM, input: HTMLInputElement) {
  await act(async () => { input.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
  await settle()
}

test("Bulto general: esperado ≠ verificado, etiqueta Andreani por lector/cámara/tipeo/pegado, errores visibles y cierre", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?batch=5")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const batch = { id: 5, code: "DSP-20261016-001", status: "open", created_at: "2026-10-16T12:00:00Z", closed_at: null, prepared_at: null, handed_over_at: null, handed_over_by: null, verification_round: 1 }
  const orders = [1006, 1007, 1008, 1009]
  const verified = new Map<number, string>()
  const posts: Json[] = []
  const item = (orderId: number) => ({ id: orderId, batch_id: 5, order_id: orderId - 1000, package_id: orderId, added_at: batch.created_at, removed_at: null, blocked: false, blockReason: null, cancellationHold: false,
    labelCode: `36000000${orderId}`, verified: verified.has(orderId), verifiedAt: verified.has(orderId) ? batch.created_at : null, verificationMethod: verified.get(orderId) ?? null, parcelCount: 1, parcels: [] })
  const detail = (): Json => ({ batch, items: orders.map(item), blockedCount: 0, cancelledCount: 0, expectedCount: orders.length, verifiedCount: verified.size, missingCount: orders.length - verified.size, requiresRevalidation: false, parcelCount: orders.length, operatorName: null })
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/batches/5") && init?.body) {
      const body = JSON.parse(String(init.body)) as { action: string; code?: string; method: string; orderId?: number }
      posts.push(body)
      if (body.action === "close") { batch.status = "closed"; return Response.json(detail()) }
      const orderId = body.method === "manual_selection" ? 1000 + Number(body.orderId) : Number(/^36000000(\d{4})$/.exec(body.code ?? "")?.[1])
      if (/^BX-PKG-/i.test(body.code ?? "")) return Response.json({ error: "Esa es una etiqueta interna (BX-PKG). Escaneá la etiqueta Andreani del pedido." }, { status: 409 })
      if (!orders.includes(orderId)) return Response.json({ error: "Código no reconocido." }, { status: 409 })
      const duplicate = verified.has(orderId)
      if (!duplicate) verified.set(orderId, body.method)
      return Response.json({ ...detail(), verification: { orderId: orderId - 1000, code: `36000000${orderId}`, method: verified.get(orderId), duplicate, expected: orders.length, verified: verified.size } })
    }
    if (path.endsWith("/batches/5")) return Response.json(detail())
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: orders.length, verifiedCount: verified.size, packageCount: orders.length, blockedCount: 0 }], holds: [] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="5" />) })
    await settle(150)
    const text = () => dom.window.document.body.textContent ?? ""
    const control = () => dom.window.document.querySelector("[aria-label='Control del Bulto general']")?.textContent ?? ""
    assert.match(text(), /Bulto general/)
    assert.match(control(), /Pedidos esperados: 4 · Verificados: 0/, "seleccionar no es verificar")
    assert.equal(button(dom, "CERRAR BULTO GENERAL")?.disabled, true, "cierre bloqueado con faltantes")
    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar etiqueta Andreani"]')!

    await scanWithReader(dom, input(), "360000001006")
    assert.match(text(), /✓ BX-1006 verificado · 1 de 4 pedidos/)
    await type(dom, input(), "360000001007"); await submit(dom, input())
    await paste(dom, input(), "360000001008")
    assert.deepEqual(posts.map((post) => post.method), ["scanner", "manual_code", "manual_code"], "tipeado y pegado: código ingresado")

    // Errores y duplicados: se avisan, se cuentan y el campo sigue disponible.
    await type(dom, input(), "BX-PKG-1009-01"); await submit(dom, input())
    assert.match(text(), /Esa es una etiqueta interna \(BX-PKG\)/)
    await type(dom, input(), "ZZZ"); await submit(dom, input())
    assert.match(text(), /ZZZ: Código no reconocido\./)
    await type(dom, input(), "360000001006"); await submit(dom, input())
    assert.match(text(), /BX-1006 ya estaba verificado · 3 de 4 pedidos/)
    assert.match(control(), /Lecturas con error: 3/)
    assert.equal(input().disabled, false)
    assert.equal(button(dom, "CERRAR BULTO GENERAL")?.disabled, true)

    // Cámara: misma acción, método "camera".
    fakeCamera([null, "360000001009", "360000001009", null])
    await act(async () => { button(dom, "Escanear con cámara")!.click() })
    await settle(700)
    assert.equal(posts.filter((post) => post.method === "camera").length, 1, "la misma etiqueta en cuadro no se cuenta dos veces")
    await act(async () => { button(dom, "Cerrar cámara")!.click() })
    assert.match(control(), /Verificados: 4/)
    assert.match(text(), /Lector/)
    assert.match(text(), /Cámara/)

    await settle(300)
    assert.equal(button(dom, "CERRAR BULTO GENERAL")?.disabled, false, "cierre habilitado con todos verificados")
    await act(async () => { button(dom, "CERRAR BULTO GENERAL")!.click() })
    await act(async () => { button(dom, "Cerrar Bulto general")!.click() })
    await settle(150)
    assert.deepEqual(posts.at(-1), { action: "close" })
    assert.match(text(), /Listo para entregar/)
    assert.equal(input(), null, "el escaneo del DSP aparece sólo al iniciar la entrega")
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>('button[aria-label="Etiquetas"]')!.click() })
    assert.deepEqual([...dom.window.document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent), ["Imprimir", "Guardar PDF", "Ver etiqueta"])
    await act(async () => { button(dom, "Ver etiqueta")!.click() })
    assert.ok(dom.window.document.querySelector("#dispatch-print-label"))
    await act(async () => { button(dom, "Entregar a Andreani")!.click() })
    assert.ok(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar DSP"]'))
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Bulto general: un cancelado muestra sólo el problema y su retiro", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?batch=6")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const batch = { id: 6, code: "DSP-20261016-002", status: "open", created_at: "2026-10-16T12:00:00Z", closed_at: null, prepared_at: null, handed_over_at: null, handed_over_by: null, verification_round: 1 }
  let verified = false
  const posts: Json[] = []
  const items = () => [
    { id: 1, batch_id: 6, order_id: 6, package_id: 1, added_at: batch.created_at, removed_at: null, blocked: false, blockReason: null, cancellationHold: false, labelCode: "360000001006", verified, verifiedAt: verified ? batch.created_at : null, verificationMethod: verified ? "manual_selection" : null, parcelCount: 1, parcels: [] },
    { id: 2, batch_id: 6, order_id: 8, package_id: 2, added_at: batch.created_at, removed_at: null, blocked: true, blockReason: "Pedido cancelado dentro del Bulto general", cancellationHold: true, labelCode: "360000001008", verified: true, verifiedAt: batch.created_at, verificationMethod: "scanner", parcelCount: 1, parcels: [] },
  ]
  const detail = (): Json => ({ batch, items: items(), blockedCount: 1, cancelledCount: 1, expectedCount: 2, verifiedCount: verified ? 2 : 1, missingCount: verified ? 0 : 1, requiresRevalidation: false, parcelCount: 2, operatorName: null })
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path.endsWith("/batches/6") && init?.body) {
      posts.push(JSON.parse(String(init.body)) as Json)
      verified = true
      return Response.json({ ...detail(), verification: { orderId: 6, code: "360000001006", method: "manual_selection", duplicate: false, expected: 2, verified: 2 } })
    }
    if (path.endsWith("/batches/6")) return Response.json(detail())
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: 2, verifiedCount: 1, packageCount: 2, blockedCount: 1 }], holds: [{ id: 3, orderId: 8, units: 1, pickedUnits: 1, prepared: true, itemCount: 1, detectedAt: batch.created_at, batchId: 6, batchCode: batch.code }] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="6" />) })
    await settle(150)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /Problema[\s\S]*Sacá este pedido del bulto para continuar[\s\S]*BX-1008[\s\S]*Cancelado[\s\S]*Retirar pedido/)
    assert.equal(button(dom, "Retirar pedido")?.disabled, false)
    assert.equal(posts.length, 0)
    for (const hidden of ["Requiere revisión", "Pedido bloqueado", "Envío ya en curso", "Pedidos esperados", "Verificados", "Confirmar entrega", "Verificar DSP"]) assert.doesNotMatch(text(), new RegExp(hidden))
    assert.equal(dom.window.document.querySelector('input[aria-label="Escanear o ingresar DSP"]'), null)
    assert.equal(dom.window.document.querySelector(".dispatch-progress-track"), null)
    await act(async () => { button(dom, "Retirar pedido")!.click() })
    assert.match(text(), /Retirar BX-1008/)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Etiquetas: la cámara suma ×1 por lectura usando el mismo camino que el lector", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/etiquetas")
  const { LabelSearchPanel } = await import("../../app/admin/sections/etiquetas/label-search-panel")
  const product = { id: 10, name: "Encendedor USB", active: true, sku: null, barcode: null, price: null, randomSale: false,
    variants: [{ id: 101, name: "NEGRO", active: true, stock: 5, sku: "ENC-NEG", colorHex: "#000000", colorHexSecondary: null, barcode: "7790000000041" }], aliases: [] }
  const searches: string[] = []
  globalThis.fetch = async (input) => {
    const query = new URL(String(input), "https://beyonix.test").searchParams.get("q") ?? ""
    searches.push(query)
    return Response.json({ items: query === "" || query === "7790000000041" ? [product] : [], hasMore: false })
  }
  const added: Array<[string, number]> = []
  fakeCamera([null, "7790000000041", "7790000000041", null, null, null, "7790000000041", null])
  try {
    await act(async () => { root.render(<LabelSearchPanel maxCopies={500} queuedCopies={new Map()} onAdd={(_target, code, copies) => added.push([code, copies])} onProducts={() => {}} />) })
    await settle(400)
    await act(async () => { button(dom, "Escanear con cámara")!.click() })
    // Pasos cortos: cada lectura se procesa (búsqueda incluida) antes de la siguiente.
    for (let step = 0; step < 24; step += 1) await settle(80)
    assert.deepEqual(added, [["7790000000041", 1], ["7790000000041", 1]], "escanear de nuevo el mismo artículo suma; quieto en cuadro no")
    assert.ok(searches.includes("7790000000041"))
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Cerrados: varios cancelados se listan para retirar y al resolver el último vuelve la entrega", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const { ADMIN_DISPATCH_CHANGED_EVENT } = await import("../../hooks/use-admin-notifications")
  const batch = { id: 8, code: "DSP-20261017-001", display_number: 1, status: "closed", created_at: "2026-10-17T12:00:00Z", closed_at: "2026-10-17T13:00:00Z", prepared_at: "2026-10-17T13:00:00Z", handed_over_at: null, handed_over_by: null, verification_round: 1 }
  const cancelled = new Set([6, 11, 15])
  let needsRevalidation = false
  const items = () => [6, 11, 15].map((id) => ({ id, batch_id: 8, order_id: id, package_id: id, added_at: batch.created_at, removed_at: null, blocked: cancelled.has(id), blockReason: cancelled.has(id) ? "Pedido cancelado" : null, cancellationHold: cancelled.has(id), labelCode: `3600000010${String(id).padStart(2, "0")}`, verified: !needsRevalidation, verifiedAt: needsRevalidation ? null : batch.closed_at, verificationMethod: needsRevalidation ? null : "scanner", parcelCount: 1, parcels: [] }))
  const holds = () => [...cancelled].map((id) => ({ id, orderId: id, units: 1, pickedUnits: 1, prepared: true, itemCount: 1, detectedAt: batch.created_at, batchId: 8, batchCode: batch.code }))
  const detail = () => ({ batch, items: items(), blockedCount: cancelled.size, cancelledCount: cancelled.size, expectedCount: 3, verifiedCount: needsRevalidation ? 0 : 3, missingCount: needsRevalidation ? 3 : 0, requiresRevalidation: needsRevalidation, parcelCount: 3, operatorName: null })
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path.endsWith("/barcode")) return new Response(new Blob(), { status: 500 })
    if (path.endsWith("/batches/8")) return Response.json(detail())
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: 3, verifiedCount: 3, packageCount: 3, blockedCount: cancelled.size }], holds: holds() })
  }
  try {
    await act(async () => { root.render(<AdminDispatches />) })
    await settle(100)
    await act(async () => { button(dom, "Cerrados")!.click() })
    assert.match(dom.window.document.body.textContent ?? "", /Bulto - 0001[\s\S]*3 pedidos[\s\S]*Tiene 3 pedidos cancelados/)
    assert.doesNotMatch(dom.window.document.body.textContent ?? "", /Requiere revisión|Verificados/)
    await act(async () => { button(dom, "Abrir")!.click() })
    await settle(120)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /Hay 3 pedidos que tenés que retirar/)
    for (const code of ["BX-1006", "BX-1011", "BX-1015"]) assert.match(text(), new RegExp(code))
    assert.equal([...dom.window.document.querySelectorAll("button")].filter((item) => item.textContent?.includes("Retirar pedido")).length, 3)
    assert.doesNotMatch(text(), /Entregar a Andreani|Verificar DSP|Pedidos esperados|Verificados/)
    assert.equal(dom.window.document.querySelector(".dispatch-progress-track"), null)
    cancelled.clear()
    needsRevalidation = true
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)) })
    await settle(350)
    assert.match(text(), /Verificá 3 pedidos para continuar/)
    assert.equal(dom.window.document.querySelector('input[aria-label="Escanear o ingresar DSP"]'), null)
    assert.doesNotMatch(text(), /Entregar a Andreani/)
    needsRevalidation = false
    await act(async () => { dom.window.dispatchEvent(new dom.window.Event(ADMIN_DISPATCH_CHANGED_EVENT)) })
    await settle(350)
    assert.match(text(), /3 pedidos · Listo para entregar[\s\S]*Entregar a Andreani/)
    assert.equal(dom.window.document.querySelector('input[aria-label="Escanear o ingresar DSP"]'), null)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Bulto general histórico sin escaneos: legible, no figura como verificado y no bloquea la entrega", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?batch=7")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  const batch = { id: 7, code: "DSP-20261001-001", status: "closed", created_at: "2026-10-01T12:00:00Z", closed_at: "2026-10-01T13:00:00Z", prepared_at: "2026-10-01T13:00:00Z", handed_over_at: null, handed_over_by: null, verification_round: 1, verification_required: false }
  const item = (orderId: number, verified: boolean) => ({ id: orderId, batch_id: 7, order_id: orderId, package_id: orderId, added_at: batch.created_at, removed_at: null, blocked: false, blockReason: null, cancellationHold: false,
    labelCode: `BX-PREP-${1000 + orderId}`, verified, verifiedAt: verified ? batch.closed_at : null, verificationMethod: verified ? "legacy_parcels" : null, parcelCount: 1, parcels: [] })
  const detail = { batch, items: [item(31, true), item(32, false)], blockedCount: 0, cancelledCount: 0, expectedCount: 2, verifiedCount: 1, missingCount: 0, verificationRequired: false, requiresRevalidation: false, parcelCount: 2, operatorName: null }
  globalThis.fetch = async (input) => {
    const path = String(input)
    if (path.endsWith("/barcode")) return new Response(new Blob(), { status: 500 })
    if (path.endsWith("/batches/7")) return Response.json(detail)
    return Response.json({ orders: [], batches: [{ ...batch, orderCount: 2, verifiedCount: 1, packageCount: 2, blockedCount: 0 }], holds: [] })
  }
  try {
    await act(async () => { root.render(<AdminDispatches initialBatchId="7" />) })
    await settle(150)
    const text = () => dom.window.document.body.textContent ?? ""
    assert.match(text(), /2 pedidos · Listo para entregar/)
    assert.doesNotMatch(text(), /Histórico|Verificados|Pedidos esperados/)
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar DSP"]'), null)
    await act(async () => { button(dom, "Entregar a Andreani")!.click() })
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar DSP"]')?.disabled, false)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
