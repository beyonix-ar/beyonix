import assert from "node:assert/strict"
import test from "node:test"
import { JSDOM } from "jsdom"
import { act } from "react"
import userEvent from "@testing-library/user-event"

// Pedido en Despachos: UNA acción principal por etapa y menús secundarios que
// sólo muestran opciones válidas. react-dom detecta el soporte de eventos al
// importarse: el DOM tiene que existir antes.
type Json = Record<string, unknown>
type Role = "operador" | "admin" | "super_admin"

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

async function type(dom: JSDOM, input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })) })
}

async function submit(dom: JSDOM, form: HTMLFormElement) {
  await act(async () => { form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })) })
  await settle()
}

const button = (dom: JSDOM, text: string) => [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent?.includes(text))
const primary = (dom: JSDOM) => dom.window.document.querySelector<HTMLButtonElement>(".dispatch-primary-bar button")
const menu = (dom: JSDOM, label: string) => dom.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const menuItems = async (dom: JSDOM, label: string) => {
  await act(async () => { menu(dom, label)!.click() })
  const items = [...dom.window.document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? "")
  await act(async () => { dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" })) })
  return items
}
const chooseMenu = async (dom: JSDOM, label: string, option: string) => {
  await act(async () => { menu(dom, label)!.click() })
  await act(async () => { [...dom.window.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.includes(option))!.click() })
}

const order = { id: 31, estado: "pagado", financial_status: "payment_confirmed", payment_status: "confirmado", invoice_status: "authorized", shipping_provider: "andreani", envio_proveedor: null, cancelled_at: null, andreani_handed_over_at: null, andreani_handed_over_batch_id: null, created_at: "2026-10-16T09:00:00Z", cliente_nombre: "María José Peña" }

/** Pedido BX-1031 simulado: 3 auriculares + 1 lámpara, con las mismas transiciones que la base. */
function fakeOrder(role: Role, packingBlocked = false) {
  const state = { picked: [0, 0], expected: [3, 1], started: false, shipment: false, identified: false, adjustments: [] as Json[], posts: [] as Json[], labels: 0, confirmations: 0, dropNextScan: false }
  const viewer = { costsVisible: role !== "operador", canShip: role !== "operador", canForce: role === "super_admin" }
  const prepared = () => state.picked.every((picked, index) => picked === state.expected[index])
  const stage = () => !state.started ? "pending" : !prepared() ? "packing" : !state.shipment ? "shipment" : state.identified ? "ready" : "label"
  const detail = (): Json => ({
    order: { ...order, andreani_envio_id: state.shipment ? "ENV-31" : null, andreani_tracking: state.shipment ? "360000001031" : null, andreani_creation_status: state.shipment ? "created" : null },
    package: state.started ? { id: 7, order_id: 31, status: prepared() ? "prepared" : "preparing", attempt_number: 1, prepared_at: null, prepared_by: null, parcel_count: state.shipment ? 1 : null, identification_method: state.identified ? "andreani" : null, identified_at: null } : null,
    lines: state.started ? [
      { order_item_id: 1, expected_sku: "AUR-N", expected_barcode: "7790001000017", expected_quantity: state.expected[0], scanned_quantity: state.picked[0], product_id: 1, variant_id: 11, conditioned_stock_id: null, name: "Auriculares · Negro", orderedQuantity: 3, unitPrice: viewer.costsVisible ? 12000 : null },
      { order_item_id: 2, expected_sku: "LAM-1", expected_barcode: "7790001000024", expected_quantity: state.expected[1], scanned_quantity: state.picked[1], product_id: 2, variant_id: null, conditioned_stock_id: null, name: "Ñandú lámpara", orderedQuantity: 1, unitPrice: viewer.costsVisible ? 8000 : null },
    ] : [],
    parcels: [], stage: stage(), itemCount: 2, expectedUnits: state.expected[0] + state.expected[1],
    shipping: { costsVisible: viewer.costsVisible, estimate: { parcels: [{ lengthCm: 35, widthCm: 25, heightCm: 18, volumeCm3: 15_750, weightKg: 2.2 }] }, parcelQuote: null },
    shipment: { created: state.shipment, envioId: state.shipment ? "ENV-31" : null, tracking: state.shipment ? "360000001031" : null, creationStatus: state.shipment ? "created" : null },
    adjustments: state.adjustments, membership: null, batch: null, hold: null,
    blocked: !state.shipment, blockReason: state.shipment ? null : "Envío pendiente", packingBlocked, pendingBeforeDispatch: state.shipment ? [] : ["Envío pendiente"], viewer,
  })
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    // Imprimir sólo entrega el PDF: no confirma la etiqueta.
    if (path.endsWith("/andreani-label")) { state.labels += 1; return new Response(new Blob(["%PDF"], { type: "application/pdf" })) }
    if (!init?.body) return Response.json(detail())
    const body = JSON.parse(String(init.body)) as Json
    state.posts.push(body)
    if (body.action === "start") { state.started = true; return Response.json(detail()) }
    if (body.action === "confirm_label") {
      // Mismo contrato que confirm_order_andreani_label: sólo el seguimiento real, nunca el ID de la API.
      if (String(body.code).replace(/\s+/g, "").toUpperCase() !== "360000001031") return Response.json({ error: "Esta etiqueta no corresponde al pedido BX-1031." }, { status: 409 })
      const duplicate = state.identified
      if (!duplicate) { state.identified = true; state.confirmations += 1 }
      return Response.json({ ...detail(), labelConfirmation: { orderId: 31, code: "360000001031", duplicate, confirmedAt: "2026-10-16T10:00:00Z" } })
    }
    if (body.action === "scan") {
      if (state.dropNextScan) { state.dropNextScan = false; throw new TypeError("network down") }
      const index = body.code === "7790001000017" ? 0 : body.code === "7790001000024" ? 1 : -1
      if (index < 0) return Response.json({ error: body.code === "OTRO" ? "Este producto no pertenece al pedido." : "Código no reconocido." }, { status: 409 })
      if (state.picked[index] >= state.expected[index]) return Response.json({ error: "Cantidad requerida ya completada." }, { status: 409 })
      state.picked[index] += 1
      return Response.json({ ...detail(), scan: { requiresVariant: false, orderItemId: index + 1, scanned: state.picked[index], expected: state.expected[index], status: "preparing", duplicate: false } })
    }
    if (body.action === "adjust") {
      const index = Number(body.orderItemId) - 1
      state.adjustments.push({ id: 1, orderItemId: body.orderItemId, problem: body.problem, quantityBefore: state.expected[index], quantityAfter: body.quantity, settlement: body.settlement, agreement: body.agreement, createdAt: "2026-10-16T10:00:00Z", differenceAmount: viewer.costsVisible ? 12000 : null })
      state.expected[index] = Number(body.quantity)
      return Response.json(detail())
    }
    if (body.action === "ship") {
      if (role === "operador") return Response.json({ error: "El envío Andreani lo genera un Admin." }, { status: 403 })
      if (body.force && role !== "super_admin") return Response.json({ error: "Sólo Super Admin puede generar el envío con el pickeo incompleto." }, { status: 403 })
      if (!prepared() && !body.force) return Response.json({ error: "Completá el pickeo del pedido antes de generar el envío Andreani." }, { status: 409 })
      state.shipment = true
      return Response.json(detail())
    }
    return Response.json({ error: "Acción inválida." }, { status: 400 })
  }
  return { state, fetch }
}

function fakeLabelWindow(dom: JSDOM) {
  const opened: string[] = []
  dom.window.open = (() => ({ opener: null, close: () => {}, print: () => {}, addEventListener: () => {}, location: { set href(value: string) { opened.push(value) } } })) as unknown as typeof dom.window.open
  return opened
}

test("cancelado: muestra el bloqueo y no ofrece empezar la preparación", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/pedidos/2?tab=armado")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  globalThis.fetch = async () => Response.json({
    order: { ...order, id: 2, estado: "cancelado", financial_status: "refunded", cancelled_at: "2026-10-13T00:00:00Z", andreani_envio_id: null, andreani_tracking: null, andreani_creation_status: null },
    package: null, lines: [], parcels: [], stage: "pending", itemCount: 0, expectedUnits: 0, membership: null, batch: null, blocked: true, blockReason: "Pedido cancelado — no requiere preparación",
    shipping: { costsVisible: false, estimate: null, parcelQuote: null }, shipment: { created: false, envioId: null, tracking: null, creationStatus: null }, adjustments: [], hold: null, packingBlocked: true, pendingBeforeDispatch: [],
  })
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={2} />) })
    await settle()
    assert.match(dom.window.document.body.textContent ?? "", /Pedido cancelado — no requiere preparación/)
    assert.equal(button(dom, "Empezar preparación"), undefined)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("pickeo: una acción por etapa, envío bloqueado hasta completar, errores que no rompen y diferencia resuelta por un operador", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?order=31")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const fake = fakeOrder("operador")
  globalThis.fetch = fake.fetch
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const text = () => dom.window.document.body.textContent ?? ""
    assert.equal(primary(dom)?.textContent, "Empezar preparación")
    assert.equal(menu(dom, "Etiquetas"), null, "sin envío no hay menú de etiquetas")
    await act(async () => { primary(dom)!.click() })
    await settle()

    // Durante el pickeo: el escaneo es protagonista y el envío queda bloqueado.
    assert.match(text(), /En pickeo/)
    assert.match(text(), /0 de 4 unidades/)
    assert.doesNotMatch(text(), /Envío pendiente/, "el envío es una etapa posterior: no se anuncia")
    assert.equal(primary(dom)?.textContent, "Generar envío Andreani")
    assert.equal(primary(dom)?.disabled, true)
    assert.match(text(), /Completá el pickeo: faltan 4 unidades\./)
    for (const future of ["Imprimir etiqueta Andreani", "Agregar al Bulto general", "CERRAR BULTO GENERAL"]) assert.equal(button(dom, future), undefined, future)
    assert.equal(menu(dom, "Más acciones"), null, "un operador no tiene excepciones")

    const input = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escanear o ingresar código / SKU"]')!
    const form = () => input().closest("form") as HTMLFormElement
    assert.equal(dom.window.document.activeElement, input(), "el escaneo recibe foco al empezar el pickeo")
    await type(dom, input(), "OTRO"); await submit(dom, form())
    assert.match(text(), /Este producto no pertenece al pedido\./)
    assert.equal(input().disabled, false, "un código incorrecto no rompe el pickeo")
    assert.equal(dom.window.document.activeElement, input(), "un error devuelve el foco al escaneo")
    fake.state.dropNextScan = true
    await type(dom, input(), "7790001000017"); await submit(dom, form())
    assert.match(text(), /Sin conexión\. Reintentá: el escaneo no se duplica\./)
    assert.equal(input().value, "7790001000017", "el código queda para reintentar")
    await submit(dom, form())
    assert.match(text(), /✓ Auriculares · Negro · 1 de 3 · faltan 2/)
    assert.equal(input().value, "", "el escaneo válido limpia el campo")
    assert.equal(dom.window.document.activeElement, input(), "el escaneo válido devuelve el foco")
    await type(dom, input(), "7790001000017"); await submit(dom, form())
    await type(dom, input(), "7790001000024"); await submit(dom, form())
    assert.match(text(), /3 de 4 unidades/)
    assert.equal(primary(dom)?.disabled, true, "3 de 4: sigue bloqueado")

    // Falta una unidad: el operador la resuelve sin Super Admin, con acuerdo registrado.
    assert.ok((await menuItems(dom, "Pedido")).some((item) => item.includes("Resolver diferencia")))
    await chooseMenu(dom, "Pedido", "Resolver diferencia")
    assert.match(text(), /Unidades que salen/)
    assert.equal(dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Unidades que salen"]')!.value, "2")
    assert.doesNotMatch(text(), /Diferencia: \$/, "el operador no ve importes")
    assert.equal(button(dom, "Registrar diferencia")?.disabled, true, "sin acuerdo no se registra")
    await type(dom, dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!, "El cliente acepta 2 auriculares y reintegro manual del resto")
    await act(async () => { button(dom, "Registrar diferencia")!.click() })
    await settle()
    const adjust = fake.state.posts.find((post) => post.action === "adjust")!
    assert.deepEqual([adjust.orderItemId, adjust.quantity, adjust.problem, adjust.settlement], [1, 2, "stock_shortage", "manual_refund"])
    assert.ok(typeof adjust.requestKey === "string")
    assert.match(text(), /Pedidas 3 · salen 2/)
    assert.match(text(), /Faltante de stock · 3 → 2 · Reintegro manual pendiente/)

    // Completo, pero el envío lo genera un Admin.
    assert.match(text(), /Pedido completo/)
    assert.equal(primary(dom)?.textContent, "Generar envío Andreani")
    assert.equal(primary(dom)?.disabled, true)
    assert.match(text(), /El envío lo genera un Admin\./)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Admin: genera el envío Andreani, imprime la etiqueta y la confirma escaneando su seguimiento", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?order=31")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const fake = fakeOrder("admin")
  Object.assign(fake.state, { started: true, picked: [3, 1] })
  globalThis.fetch = fake.fetch
  const opened = fakeLabelWindow(dom)
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const text = () => dom.window.document.body.textContent ?? ""
    assert.equal(primary(dom)?.textContent, "Generar envío Andreani")
    assert.equal(primary(dom)?.disabled, false, "4 de 4: habilitado")
    assert.equal(menu(dom, "Más acciones"), null, "Admin normal no puede saltarse reglas")
    await act(async () => { primary(dom)!.click() })
    assert.match(text(), /Cantidad de bultos/)
    const parcels = dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Cantidad de bultos"]')!
    assert.equal(parcels.value, "1", "sugiere los bultos estimados")
    await act(async () => { button(dom, "Usar medidas estimadas")!.click() })
    await act(async () => { [...dom.window.document.querySelectorAll("button")].find((item) => item.textContent === "Generar envío")!.click() })
    await settle()
    const ship = fake.state.posts.find((post) => post.action === "ship")!
    assert.deepEqual(ship.parcels, [{ weightKg: 2.2, lengthCm: 35, widthCm: 25, heightCm: 18 }])
    assert.equal(ship.force, undefined)

    // Envío generado: falta imprimir y confirmar la etiqueta Andreani.
    assert.match(text(), /Falta confirmar etiqueta/)
    assert.match(text(), /Andreani: 360000001031/)
    assert.equal(primary(dom)?.textContent, "Imprimir etiqueta Andreani")
    assert.deepEqual(await menuItems(dom, "Etiquetas"), ["Guardar PDF de etiqueta Andreani"])
    assert.ok((await menuItems(dom, "Envío")).includes("Ver seguimiento"))
    assert.doesNotMatch(text(), /BX-PREP/, "sin etiqueta BEYONIX extra")
    await act(async () => { primary(dom)!.click() })
    await settle()
    assert.equal(fake.state.labels, 1)
    assert.equal(opened.length, 1, "abre la etiqueta para imprimir")
    assert.match(opened[0], /^blob:/)
    // Imprimir no alcanza: el pedido sigue esperando la confirmación física.
    assert.match(text(), /Falta confirmar etiqueta/)
    assert.doesNotMatch(text(), /Listo para Bulto/)
    const labelInput = () => dom.window.document.querySelector<HTMLInputElement>('input[aria-label="Escaneá o escribí el seguimiento"]')
    assert.ok(labelInput(), "campo para escanear o tipear el seguimiento")
    assert.equal(dom.window.document.activeElement, labelInput(), "foco automático para el lector")
    assert.equal(button(dom, "Escanear con cámara"), undefined, "sin cámara en este paso")

    // Etiqueta equivocada o ID interno de la API: no avanza.
    for (const wrong of ["360000009999", "ENV-31"]) {
      await type(dom, labelInput()!, wrong); await submit(dom, labelInput()!.closest("form")!)
      assert.match(text(), /Esta etiqueta no corresponde al pedido BX-1031./)
      assert.match(text(), /Falta confirmar etiqueta/)
    }
    assert.equal(fake.state.identified, false)

    // Lector USB: escribe el seguimiento y Enter confirma.
    const user = userEvent.setup({ document: dom.window.document })
    await act(async () => { await user.click(labelInput()!); await user.type(labelInput()!, " 360000001031{Enter}") })
    await settle()
    assert.equal(fake.state.posts.filter((post) => post.action === "confirm_label").length, 3)
    assert.equal(fake.state.confirmations, 1)
    assert.match(text(), /✓ Etiqueta confirmada/)
    assert.match(text(), /Listo para Bulto/)
    assert.equal(labelInput(), null, "confirmada: el campo desaparece")
    assert.deepEqual(await menuItems(dom, "Etiquetas"), ["Reimprimir etiqueta Andreani", "Guardar PDF de etiqueta Andreani"])

    assert.equal(primary(dom), null, "el pedido listo no agrega otra acción")
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("Super Admin: puede forzar el envío con pickeo incompleto, con motivo y auditoría", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?order=31")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const fake = fakeOrder("super_admin")
  Object.assign(fake.state, { started: true, picked: [2, 1] })
  globalThis.fetch = fake.fetch
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const text = () => dom.window.document.body.textContent ?? ""
    assert.equal(primary(dom)?.disabled, true, "la regla sigue visible: pickeo incompleto")
    assert.deepEqual(await menuItems(dom, "Más acciones"), ["Generar envío con pickeo incompleto"])
    await chooseMenu(dom, "Más acciones", "Generar envío con pickeo incompleto")
    assert.match(text(), /Excepción de Super Admin: BX-1031 tiene 3 de 4 unidades pickeadas/)
    assert.equal(button(dom, "Generar envío igual")?.disabled, true, "sin motivo no se fuerza")
    await type(dom, dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!, "Cliente retira hoy, falta una unidad en camino")
    await act(async () => { button(dom, "Generar envío igual")!.click() })
    await settle()
    const ship = fake.state.posts.find((post) => post.action === "ship")!
    assert.deepEqual([ship.force, ship.reason], [true, "Cliente retira hoy, falta una unidad en camino"])
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("input real de picking: teclado, Enter, pegar y Verificar procesan la misma acción", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?order=31")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const fake = fakeOrder("operador")
  fake.state.started = true
  globalThis.fetch = fake.fetch
  const user = userEvent.setup({ document: dom.window.document })
  const input = () => dom.window.document.querySelector<HTMLInputElement>('input[placeholder="Escaneá el producto"]')!
  const scans = () => fake.state.posts.filter((post) => post.action === "scan")
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    assert.equal(dom.window.document.activeElement, input())
    assert.equal(input().type, "text")
    assert.equal(input().readOnly, false)
    assert.equal(input().disabled, false)

    await act(async () => { await user.click(input()); await user.type(input(), "7790001000017") })
    assert.equal(input().value, "7790001000017", "el input controlado muestra lo escrito")
    await act(async () => { await user.keyboard("{Enter}") })
    await settle()
    assert.equal(scans().length, 1, "Enter envía una sola vez")
    assert.equal(scans()[0].code, "7790001000017")
    assert.equal(fake.state.picked[0], 1)
    assert.equal(input().value, "")
    assert.equal(dom.window.document.activeElement, input())

    await act(async () => { await user.paste("7790001000017") })
    assert.equal(input().value, "7790001000017")
    await act(async () => { await user.click(button(dom, "Verificar")!) })
    await settle()
    assert.equal(scans().length, 2)
    assert.equal(fake.state.picked[0], 2)

    await act(async () => { await user.type(input(), "OTRO{Enter}") })
    await settle()
    assert.equal(scans().length, 3)
    assert.equal(fake.state.picked[0], 2)
    assert.match(dom.window.document.body.textContent ?? "", /Este producto no pertenece al pedido/)
    assert.equal(input().disabled, false)
    assert.equal(dom.window.document.activeElement, input())
  } finally { await act(async () => root.unmount()); dom.window.close() }
})

test("bloqueo operativo: el texto de picking sigue editable sin habilitar Verificar", async () => {
  const { dom, root } = await setup("https://beyonix.test/admin/despachos?order=31")
  const { OrderPreparationPanel } = await import("../../app/admin/sections/despachos/order-preparation-panel")
  const fake = fakeOrder("operador", true)
  fake.state.started = true
  globalThis.fetch = fake.fetch
  const user = userEvent.setup({ document: dom.window.document })
  try {
    await act(async () => { root.render(<OrderPreparationPanel orderId={31} />) })
    await settle()
    const input = dom.window.document.querySelector<HTMLInputElement>('input[placeholder="Escaneá el producto"]')!
    assert.equal(input.disabled, false, "el bloqueo de envío no inutiliza el control de texto")
    await act(async () => { await user.type(input, "7170972998100") })
    assert.equal(input.value, "7170972998100")
    assert.equal(button(dom, "Verificar")?.disabled, true)
  } finally { await act(async () => root.unmount()); dom.window.close() }
})
