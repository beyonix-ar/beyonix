import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import { dispatchToday } from "./dispatch-records"

type Json = Record<string, unknown>

// Confirmar → siguiente pantalla → confirmar → … → terminado, sólo con la respuesta exitosa del servidor.
test("Despachos avanza solo tras cada confirmación: etiqueta → pedidos para Bulto → Bulto → QR → tabla", async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dispatch-advance.invalid"
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dispatch-advance-key"
  const dom = new JSDOM("<!doctype html><div id='root'></div>", { url: "https://beyonix.test/admin/despachos" })
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })
  const { supabase } = await import("../../lib/supabase/client")
  Object.defineProperty(supabase.auth, "getSession", { configurable: true, value: async () => ({ data: { session: { access_token: "test-token" } }, error: null }) })
  const { createRoot } = await import("react-dom/client")
  const { AdminDispatches } = await import("../../app/admin/sections/despachos/admin-dispatches")
  let root = createRoot(dom.window.document.getElementById("root")!)
  const today = dispatchToday()
  const tracking = "360003136911715"

  let identified = false
  let bundle: { status: "open" | "closed" | "handed_over"; verified: boolean } | null = null
  const posts: Json[] = []
  const searches: URLSearchParams[] = []
  const order = () => ({ id: 15, created_at: `${today}T09:00:00-03:00`, cliente_nombre: "Lucía Núñez", estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved", invoice_status: "authorized", total: 30000, shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: bundle?.status === "handed_over" ? `${today}T15:00:00-03:00` : null, andreani_handed_over_batch_id: null, andreani_envio_id: "API000017418515", andreani_tracking: tracking, andreani_creation_status: "created", andreani_created_at: `${today}T09:30:00-03:00` })
  const pkg = () => ({ id: 15, order_id: 15, status: "prepared", attempt_number: 1, prepared_at: `${today}T10:00:00-03:00`, prepared_by: null, identification_method: identified ? "andreani" : null, identified_at: identified ? `${today}T10:05:00-03:00` : null })
  const batchRow = () => ({ id: 9, code: "DSP-20261024-001", display_number: 9, status: bundle!.status, created_at: `${today}T11:00:00-03:00`, closed_at: bundle!.status === "open" ? null : `${today}T11:10:00-03:00`, prepared_at: null, handed_over_at: bundle!.status === "handed_over" ? `${today}T15:00:00-03:00` : null, handed_over_by: null, verification_round: 1 })
  const orderDetail = () => ({ order: order(), package: pkg(), lines: [], saleItems: [{ orderItemId: 1, sku: "ENC-01", productName: "Encendedor eléctrico", variantName: null, orderedQuantity: 1, unitPrice: null }], parcels: [],
    stage: !identified ? "label" : bundle ? "in_batch" : "ready", itemCount: 1, expectedUnits: 1, membership: null, batch: bundle ? batchRow() : null, shipping: { costsVisible: false, estimate: null, parcelQuote: null }, hold: null,
    shipment: { created: true, envioId: "API000017418515", tracking, creationStatus: "created" }, adjustments: [], blocked: false, blockReason: null, packingBlocked: false, pendingBeforeDispatch: [], viewer: { costsVisible: false, canShip: false, canForce: false } })
  const batchDetail = () => ({ batch: batchRow(), items: [{ id: 1, batch_id: 9, order_id: 15, package_id: 15, added_at: `${today}T11:00:00-03:00`, removed_at: null, blocked: false, blockReason: null, cancellationHold: false, labelCode: tracking,
    verified: bundle!.verified, verifiedAt: bundle!.verified ? `${today}T11:10:00-03:00` : null, verificationMethod: bundle!.verified ? "manual_code" : null, parcelCount: 1, parcels: [] }],
    blockedCount: 0, cancelledCount: 0, expectedCount: 1, verifiedCount: bundle!.verified ? 1 : 0, missingCount: bundle!.verified ? 0 : 1, requiresRevalidation: false, parcelCount: 1, operatorName: null })

  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as Json : null
    if (body) posts.push({ url, ...body })
    if (/\/orders\/15$/.test(url)) {
      if (body?.action === "confirm_label") {
        if (body.code !== tracking) return Response.json({ error: "Esa etiqueta no corresponde a BX-1015." }, { status: 409 })
        const duplicate = identified
        identified = true
        return Response.json({ ...orderDetail(), labelConfirmation: { duplicate } })
      }
      return Response.json(orderDetail())
    }
    if (url.endsWith("/batches") && body) { bundle = { status: "open", verified: false }; return Response.json(batchDetail()) }
    if (url.endsWith("/batches/9?history")) return Response.json({ batch: batchRow(), orderCount: 1, parcelCount: 1, pickingBy: [], preparedBy: [], assembledBy: null, controlledBy: [], deliveredBy: null, items: [] })
    if (url.endsWith("/batches/9") && body?.action === "verify") {
      bundle!.verified = true; bundle!.status = "closed"
      return Response.json({ ...batchDetail(), verification: { orderId: 15, code: tracking, method: "manual_code", duplicate: false, expected: 1, verified: 1 } })
    }
    if (url.endsWith("/batches/9") && body?.action === "handover") { bundle!.status = "handed_over"; return Response.json(batchDetail()) }
    if (url.endsWith("/batches/9")) return Response.json(batchDetail())
    const params = new URL(url, "https://beyonix.test").searchParams
    searches.push(params)
    const rows = (bundle
      ? [{ kind: "batch", id: 9, code: "DSP-20261024-001", displayNumber: 9, state: bundle.status === "handed_over" ? "E" : bundle.status === "closed" ? "C" : "P", at: `${today}T11:00:00-03:00`, actorId: null, actorName: null, units: 1, total: 30000, orderCount: 1, selectable: false }]
      : [{ kind: "order", id: 15, code: null, displayNumber: null, state: "C", at: `${today}T10:00:00-03:00`, actorId: null, actorName: null, units: 1, total: 30000, orderCount: 1, selectable: identified }])
      // Un Bulto anterior del día: la tabla general muestra pedidos y Bultos.
      .concat([{ kind: "batch", id: 8, code: "DSP-20261024-000", displayNumber: 8, state: "C", at: `${today}T08:00:00-03:00`, actorId: null, actorName: null, units: 2, total: 50000, orderCount: 2, selectable: false }])
      .filter((row) => (!params.get("state") || row.state === params.get("state")) && (!params.get("kind") || row.kind === params.get("kind")))
    return Response.json({ rows, total: rows.length, page: 1, pageSize: 20, holds: [], users: [] })
  }

  const document = dom.window.document
  const settle = async (ms = 320) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
  const text = () => document.body.textContent ?? ""
  const where = () => `${dom.window.location.pathname}${dom.window.location.search}`
  const button = (label: string) => [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(label))
  const input = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
  const scan = async (label: string, value: string) => {
    const field = input(label)!
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { setter.call(field, value); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
    await act(async () => { field.closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
    await settle()
  }
  const actions = (action: string) => posts.filter((post) => post.action === action).length
  const selectedForBundle = () => input("Seleccionar BX-1015 para un Bulto")?.checked
  const cleanup = async () => {
    await act(async () => root.unmount())
    supabase.auth.stopAutoRefresh()
    await supabase.removeAllChannels()
    supabase.realtime.disconnect()
    const channel: unknown = Reflect.get(supabase.auth, "broadcastChannel")
    if (channel instanceof BroadcastChannel) channel.close()
  }
  const remount = async (props: { initialBatchId?: string } = {}) => {
    await cleanup()
    root = createRoot(document.getElementById("root")!)
    await act(async () => { root.render(<AdminDispatches {...props} />) })
    await settle()
  }

  try {
    await act(async () => { root.render(<AdminDispatches />) })
    await settle()
    await act(async () => { document.querySelector<HTMLTableRowElement>('table[aria-label="Registros de despachos"] tbody tr')!.click() })
    await settle()
    assert.equal(where(), "/admin/despachos?order=15")

    // B. Falla: se queda, muestra el error y deja reintentar.
    await scan("Escaneá o escribí el seguimiento", "360009999999999")
    assert.equal(where(), "/admin/despachos?order=15", "el rechazo no navega")
    assert.match(text(), /Esa etiqueta no corresponde a BX-1015\./)
    assert.ok(input("Escaneá o escribí el seguimiento"), "el campo sigue para reintentar")

    // A + C. Éxito: sin pantalla de "confirmada"; vuelve a la tabla general (pedidos y Bultos) con éste marcado.
    await scan("Escaneá o escribí el seguimiento", tracking)
    assert.equal(actions("confirm_label"), 2)
    assert.equal(where(), "/admin/despachos", "Atrás del detalle apilado: la tabla")
    assert.ok(document.querySelector('table[aria-label="Registros de despachos"]'))
    assert.match(text(), /Etiqueta confirmada · BX-1015 listo para Bulto/)
    assert.deepEqual(["ESTADO", "TIPO"].map((label) => document.querySelector(`button[aria-label="${label}"]`)?.textContent), ["ESTADO", "TIPO"], "sin filtros de estado ni tipo")
    assert.deepEqual([searches.at(-1)?.get("state"), searches.at(-1)?.get("kind"), searches.at(-1)?.get("openAllDates")], [null, null, "true"])
    assert.ok(document.querySelector('tr[aria-label="Ver Bulto - 0008"]'), "los Bultos siguen en la tabla")
    assert.equal(selectedForBundle(), true, "visible y listo para Crear bulto")
    assert.equal(button("Crear bulto")?.disabled, false)

    // I. Adelante/Atrás sobre el pedido ya confirmado: no repite la confirmación; el siguiente paso queda a un toque.
    await act(async () => { dom.window.history.forward() })
    await settle()
    assert.equal(where(), "/admin/despachos?order=15")
    assert.match(text(), /Etiqueta confirmada/)
    assert.equal(actions("confirm_label"), 2, "volver no reenvía nada")
    await act(async () => { button("Agregar a un Bulto")!.click() })
    await settle()
    assert.equal(where(), "/admin/despachos")
    assert.equal(selectedForBundle(), true)

    // H. Refrescar en la tabla: filtros y selección vuelven de la sesión.
    await remount()
    assert.equal(document.querySelector('button[aria-label="ESTADO"]')?.textContent, "ESTADO")
    assert.equal(selectedForBundle(), true)

    // D. Bulto creado → su control.
    await act(async () => { button("Crear bulto")!.click() })
    await settle()
    assert.equal(actions("verify") + actions("handover"), 0)
    assert.equal(where(), "/admin/despachos?batch=9")
    assert.match(text(), /0 de 1 pedidos/)
    assert.ok(input("Escanear o ingresar etiqueta Andreani"))

    // H. Refrescar dentro del Bulto: mismo paso.
    await remount({ initialBatchId: "9" })
    assert.match(text(), /0 de 1 pedidos/)

    // E. Bulto listo → control del QR final en la misma pantalla.
    await scan("Escanear o ingresar etiqueta Andreani", tracking)
    assert.equal(where(), "/admin/despachos?batch=9")
    assert.match(text(), /Bulto listo para entregar/)
    assert.ok(input("Escanear o ingresar el QR del Bulto"))

    // F. QR final confirmado → tabla actualizada, sin pantalla de "despachado".
    await scan("Escanear o ingresar el QR del Bulto", "DSP-20261024-001")
    assert.equal(actions("handover"), 1)
    assert.equal(where(), "/admin/despachos")
    assert.match(text(), /Bulto - 0009 despachado\./)
    assert.equal(input("Escanear o ingresar el QR del Bulto"), null)
    assert.equal(document.querySelector('button[aria-label="ESTADO"]')?.textContent, "ESTADO", "vuelve a la vista del día")
    assert.match(document.querySelector('tr[aria-label="Ver Bulto - 0009"]')?.textContent ?? "", /Despachado/, "la fila ya actualizada")

    // I. Atrás después de terminar: no repite la entrega.
    const sent = posts.length
    await act(async () => { dom.window.history.back() })
    await settle()
    assert.equal(posts.length, sent, "Atrás no reenvía confirmaciones")
  } finally {
    await cleanup()
    dom.window.close()
  }
})
