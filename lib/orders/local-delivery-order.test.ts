import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test, { mock } from "node:test"

import { CheckoutShippingQuoteError } from "../cart/checkout-shipping.ts"
import {
  getCheckoutOrderShippingFields,
  normalizeCheckoutOrderShipping,
  type CheckoutOrderShippingInput,
} from "./checkout-order-creation.ts"
import {
  getLocalDeliveryStage,
  getLocalDeliveryTransitionError,
  getNextLocalDeliveryAction,
  type LocalDeliveryOrderState,
} from "./local-delivery-status.ts"
import {
  advanceLocalDelivery,
  getMissingLocalDeliveryEffects,
  retryLocalDeliveryEffects,
  type LocalDeliveryEffect,
  type LocalDeliveryOrderRecord,
  type LocalDeliveryServiceDeps,
} from "./local-delivery-service.ts"
import { buildDashboardLedger, getWebShippingCost } from "../business/dashboard-commercial-ledger.ts"
import { INVALID_LOCAL_DELIVERY_SETTINGS } from "../shipping/local-delivery.ts"
import { getOrderPreparationFollowUp } from "./shipping-email-copy.ts"
import { sendOrderStateEmail } from "./order-status-notifications.ts"
import { DEFAULT_SHIPPING_SETTINGS } from "../store-config.ts"
import type { LocalDeliverySettings } from "../shipping/local-delivery.ts"

const SETTINGS: LocalDeliverySettings = {
  enabled: true,
  customerPrice: 2_500,
  internalDeliveryCost: 2_500,
  freeThreshold: 50_000,
  postalCodes: ["2000"],
}
const CUSTOMER = { cpDestino: "2000", localidad: "ROSARIO", provincia: "SANTA FE", direccion: "Córdoba 1234" }
const ITEMS = [{ productId: 1, quantity: 1, variantId: null, conditionedStockId: null }]

function normalize(
  shipping: CheckoutOrderShippingInput,
  productsTotal: number,
  overrides: { settings?: LocalDeliverySettings | null; cp?: string; customerCreditApplied?: boolean } = {},
) {
  return normalizeCheckoutOrderShipping({
    shipping,
    customer: { ...CUSTOMER, cpDestino: overrides.cp ?? CUSTOMER.cpDestino },
    items: ITEMS,
    productsTotal,
    customerCreditApplied: overrides.customerCreditApplied ?? false,
    settings: DEFAULT_SHIPPING_SETTINGS,
    markupPercent: 0,
    localDelivery: overrides.settings === undefined ? SETTINGS : overrides.settings,
  })
}

const local = (expectedCostCharged: number | null | undefined): CheckoutOrderShippingInput =>
  ({ provider: "beyonix", type: "domicilio", expectedCostCharged })

const isQuoteConflict = (error: unknown) => error instanceof CheckoutShippingQuoteError

// ── 40. Pedido ───────────────────────────────────────────────────────────────

test("pedido de $45.000: cobra $2.500 y registra $2.500 de costo interno, proveedor beyonix + domicilio", () => {
  const shipping = normalize(local(2_500), 45_000)
  assert.deepEqual(
    { provider: shipping.provider, type: shipping.type, costCharged: shipping.costCharged, costReal: shipping.costReal, free: shipping.freeShippingApplied },
    { provider: "beyonix", type: "domicilio", costCharged: 2_500, costReal: 2_500, free: false },
  )
})

test("pedido de $55.000: envío gratis para el cliente, costo interno $2.500 (subsidio BEYONIX $2.500)", () => {
  const shipping = normalize(local(0), 55_000)
  assert.equal(shipping.costCharged, 0)
  assert.equal(shipping.costReal, 2_500)
  assert.equal(shipping.freeShippingApplied, true)
  assert.equal(shipping.benefitAmount, 2_500)
})

test("persistencia: shipping_provider beyonix, cobrado e interno por separado, sin snapshot de Andreani ni sucursal", () => {
  const fields = getCheckoutOrderShippingFields(normalize(local(0), 55_000))
  assert.equal(fields.shipping_provider, "beyonix")
  assert.equal(fields.shipping_type, "domicilio")
  assert.equal(fields.shipping_cost_charged, 0)
  assert.equal(fields.shipping_cost_real, 2_500)
  assert.equal(fields.free_shipping_applied, true)
  // ordenes_shipping_snapshot_complete_check exige el snapshot completo en NULL.
  for (const key of ["shipping_provider_quote_amount", "shipping_markup_percent", "shipping_markup_amount",
    "shipping_rounding_amount", "shipping_benefit_amount", "shipping_estimate", "andreani_sucursal_id"] as const) {
    assert.equal(fields[key], null, key)
  }
})

test("los pedidos históricos no dependen de la configuración nueva: lo cobrado y el costo quedan fijos en la orden", () => {
  const before = getCheckoutOrderShippingFields(normalize(local(2_500), 45_000))
  // Admin cambia precio, umbral y CPs después de la compra.
  const changed: LocalDeliverySettings = { ...SETTINGS, customerPrice: 4_000, internalDeliveryCost: 3_500, freeThreshold: 40_000, postalCodes: ["2132"] }
  assert.deepEqual(
    { charged: before.shipping_cost_charged, real: before.shipping_cost_real },
    { charged: 2_500, real: 2_500 },
  )
  // Una compra NUEVA sí usa los valores nuevos.
  assert.throws(() => normalize(local(2_500), 45_000, { settings: changed }), isQuoteConflict)
  const fresh = normalize(local(0), 45_000, { settings: { ...changed, postalCodes: ["2000"] } })
  assert.equal(fresh.costReal, 3_500)
  // La orden ya guardada no se recalcula: el detalle de Admin lee las columnas persistidas.
  const adminCard = readFileSync("app/admin/sections/pedidos/local-delivery-order-card.tsx", "utf8")
  assert.match(adminCard, /pedido\.shipping_cost_charged/)
  assert.match(adminCard, /pedido\.shipping_cost_real/)
  assert.doesNotMatch(adminCard, /getLocalDeliverySettings|siteSettings/)
})

// ── 37. Saldo a favor ────────────────────────────────────────────────────────

test("saldo a favor: no vuelve gratis a Envío BEYONIX ni cambia el importe (sí lo hace en Andreani, regla existente)", () => {
  const shipping = normalize(local(2_500), 40_000, { customerCreditApplied: true })
  assert.equal(shipping.costCharged, 2_500)
  assert.equal(shipping.freeShippingApplied, false)
  // Mandar $0 porque hay saldo se rechaza.
  assert.throws(() => normalize(local(0), 40_000, { customerCreditApplied: true }), isQuoteConflict)
})

// ── 39. Seguridad ────────────────────────────────────────────────────────────

test("seguridad: manipular el envío desde el navegador siempre termina en 409 (CheckoutShippingQuoteError)", () => {
  const attempts: Array<[string, () => unknown]> = [
    ["precio 0 con subtotal bajo el umbral", () => normalize(local(0), 45_000)],
    ["provider beyonix con CP no habilitado", () => normalize(local(2_500), 45_000, { cp: "1425" })],
    ["método local desactivado", () => normalize(local(2_500), 45_000, { settings: { ...SETTINGS, enabled: false } })],
    ["precio viejo (Admin subió a $3.000)", () => normalize(local(2_500), 45_000, { settings: { ...SETTINGS, customerPrice: 3_000 } })],
    ["umbral viejo (Admin subió a $60.000)", () => normalize(local(0), 55_000, { settings: { ...SETTINGS, freeThreshold: 60_000 } })],
    ["sin importe visto", () => normalize(local(undefined), 45_000)],
    ["importe no numérico", () => normalize({ provider: "beyonix", type: "domicilio", expectedCostCharged: "0" as unknown as number }, 45_000)],
    ["importe negativo", () => normalize(local(-1), 45_000)],
    ["modalidad sucursal", () => normalize({ provider: "beyonix", type: "sucursal", expectedCostCharged: 2_500 }, 45_000)],
    ["configuración no leída", () => normalize(local(2_500), 45_000, { settings: null })],
  ]
  for (const [label, attempt] of attempts) {
    assert.throws(attempt, isQuoteConflict, label)
  }
})

test("un token de Andreani nunca sirve para pedir Envío BEYONIX ni al revés", () => {
  // provider beyonix ignora cualquier token: sólo cuenta la configuración fresca.
  const shipping = normalize({ ...local(2_500), quoteToken: "token-de-andreani" }, 45_000)
  assert.equal(shipping.provider, "beyonix")
  // provider andreani sin token válido sigue rechazándose como siempre.
  assert.throws(() => normalize({ provider: "andreani", type: "domicilio", expectedCostCharged: 0 }, 45_000), isQuoteConflict)
})

// ── 38. Cambios en vivo ──────────────────────────────────────────────────────

test("cambios en vivo: CP, carrito, umbral, precio o desactivación rechazan la selección vieja", () => {
  // Cliente vio $2.500 con $45.000 de productos.
  assert.equal(normalize(local(2_500), 45_000).costCharged, 2_500)
  // Cambió el CP a uno no habilitado.
  assert.throws(() => normalize(local(2_500), 45_000, { cp: "5000" }), isQuoteConflict)
  // El carrito cruzó el umbral ($52.000): el envío pasa a $0 y el $2.500 visto ya no vale.
  assert.throws(() => normalize(local(2_500), 52_000), isQuoteConflict)
  assert.equal(normalize(local(0), 52_000).costCharged, 0)
  // Y al revés: quitó un producto ($45.000) y había visto GRATIS.
  assert.throws(() => normalize(local(0), 45_000), isQuoteConflict)
  // Admin cambió umbral, precio o la desactivó.
  assert.throws(() => normalize(local(2_500), 45_000, { settings: { ...SETTINGS, freeThreshold: 40_000 } }), isQuoteConflict)
  assert.throws(() => normalize(local(2_500), 45_000, { settings: { ...SETTINGS, customerPrice: 2_000 } }), isQuoteConflict)
  assert.throws(() => normalize(local(2_500), 45_000, { settings: { ...SETTINGS, enabled: false } }), isQuoteConflict)
})

test("las 3 rutas que crean pedidos leen la configuración fresca de Envío BEYONIX y la pasan a la validación", () => {
  for (const route of [
    "app/api/mercadopago/create-preference/route.ts",
    "app/api/transferencia/create-order/route.ts",
    "app/api/customer-credit/create-order/route.ts",
  ]) {
    const source = readFileSync(route, "utf8")
    assert.match(source, /loadCheckoutLocalDeliverySettings\(payload\.shipping\)/, route)
    assert.match(source, /markupPercent: shippingQuoteSettings\.logisticsMarkupPercent,\s+localDelivery,/, route)
    // CheckoutShippingQuoteError → 409 (sin crear el pedido).
    assert.match(source, /error instanceof CheckoutShippingQuoteError/, route)
  }
  const creation = readFileSync("lib/orders/checkout-order-creation.ts", "utf8")
  assert.match(creation, /isLocalDeliveryProvider\(shipping\?\.provider\) \? getLocalDeliverySettings\(\) : Promise\.resolve\(null\)/)
  const reader = readFileSync("lib/shipping/local-delivery-settings.ts", "utf8")
  // Sin caché y estricta: una falla de lectura corta la compra.
  assert.match(reader, /if \(error\) throw new LocalDeliverySettingsUnavailableError\(\)/)
})

// ── 41. Despachos ────────────────────────────────────────────────────────────

const paidLocalOrder = (overrides: Partial<LocalDeliveryOrderState> = {}): LocalDeliveryOrderState => ({
  estado: "pagado",
  shipping_provider: "beyonix",
  financial_status: "payment_confirmed",
  paid_at: "2026-11-03T12:00:00.000Z",
  ...overrides,
})

test("secuencia estricta: Preparando → En camino → Entregado, sin saltos", () => {
  assert.equal(getLocalDeliveryStage({ estado: "pagado" }), "preparing")
  assert.equal(getLocalDeliveryStage({ estado: "en_camino" }), "in_transit")
  assert.equal(getLocalDeliveryStage({ estado: "entregado" }), "delivered")
  assert.equal(getNextLocalDeliveryAction("preparing"), "en_camino")
  assert.equal(getNextLocalDeliveryAction("in_transit"), "entregado")
  assert.equal(getNextLocalDeliveryAction("delivered"), null)

  // Preparando → En camino = OK.
  assert.equal(getLocalDeliveryTransitionError(paidLocalOrder(), "en_camino"), null)
  // Preparando → Entregado = rechazado.
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder(), "entregado") ?? "", /Primero marcá el pedido como En camino/)
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "preparado" }), "entregado") ?? "", /Primero marcá/)
  // En camino → Entregado = OK.
  assert.equal(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "en_camino" }), "entregado"), null)
})

test("transiciones inválidas: entregado, cancelado, no pagado, reintegro, cambio pendiente o retroceso", () => {
  const delivered = paidLocalOrder({ estado: "entregado", delivered_at: "2026-11-03T15:00:00Z" })
  assert.match(getLocalDeliveryTransitionError(delivered, "en_camino") ?? "", /ya figura como entregado/)
  assert.match(getLocalDeliveryTransitionError(delivered, "entregado") ?? "", /ya figura como entregado/)
  for (const action of ["en_camino", "entregado"] as const) {
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "cancelado" }), action) ?? "", /cancelado/, action)
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "en_camino", cancelled_at: "x" }), action) ?? "", /cancelado/, action)
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ financial_status: "refund_pending" }), action) ?? "", /cancelado/, action)
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ paid_at: null, financial_status: null, estado: "pendiente" }), action) ?? "", /pago confirmado/, action)
    // Pago "confirmado" por otra señal pero sin financial_status = payment_confirmed: no avanza.
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ financial_status: "pending" }), action) ?? "", /pago confirmado/, action)
  }
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ shipping_provider: "andreani" }), "en_camino") ?? "", /no usa Envío BEYONIX/)
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ order_change_status: "change_requested" }), "en_camino") ?? "", /cambio pendiente/)
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "en_camino" }), "en_camino") ?? "", /en preparación/)
})

test("configuración local inválida (desactivada): el servidor rechaza provider=beyonix", () => {
  assert.throws(() => normalize(local(2_500), 45_000, { settings: INVALID_LOCAL_DELIVERY_SETTINGS }), isQuoteConflict)
})

test("un pedido local nunca entra al circuito Andreani: sin etiqueta, guía ni Bulto", () => {
  // La creación de envío Andreani rechaza cualquier proveedor que no sea andreani.
  assert.match(readFileSync("lib/andreani/order-shipment.ts", "utf8"),
    /\(order\.shipping_provider \?\? order\.envio_proveedor\)\?\.toLowerCase\(\) !== "andreani"/)
  // Los registros de Despachos (pickeo/Bulto/etiqueta) sólo listan Andreani.
  assert.match(readFileSync("supabase/migrations/20261022110000_dispatch_records_open_work_no_annulled.sql", "utf8"),
    /lower\(coalesce\(o\.shipping_provider, o\.envio_proveedor, ''\)\) = 'andreani'/)
  // Las alertas de armado/despacho del Admin son sólo para Andreani.
  assert.match(readFileSync("lib/orders/admin-pending-actions.ts", "utf8"), /if \(isAndreaniOrder\(order\)\) addDispatchWork/)
  // En el detalle del pedido, Envío BEYONIX reemplaza las acciones de Andreani.
  const detail = readFileSync("app/admin/sections/pedidos/admin-pedidos.tsx", "utf8")
  assert.match(detail, /\{localDelivery \? \(\s+<LocalDeliveryOrderCard pedido=\{pedido\} \/>/)
  assert.match(detail, /\{!localDelivery && \(\s+<OrderDispatchStatus/)
})

// ── Efectos recuperables, idempotencia y concurrencia ───────────────────────

function localDeliveryStore(initial: Partial<LocalDeliveryOrderRecord> = {}) {
  const order: LocalDeliveryOrderRecord = {
    id: 7,
    estado: "pagado",
    shipping_provider: "beyonix",
    financial_status: "payment_confirmed",
    paid_at: "2026-11-03T12:00:00.000Z",
    delivered_at: null,
    cancelled_at: null,
    shipping_cost_real: 2_500,
    cliente_email: "ana@test.com",
    cliente_nombre: "Ana",
    ...initial,
  }
  const markers: Array<{ id: string; effect: LocalDeliveryEffect; metadata: Record<string, unknown> }> = []
  const warranties = [{ pending: true }, { pending: true }]
  const emails: string[] = []
  const failures = { email: 0, record: 0, warranty: 0, markersRead: 0 }
  let nextId = 1
  const deps: LocalDeliveryServiceDeps = {
    async loadOrder() { return { ...order } },
    async transitionOrder({ fromEstado, action, deliveredAt }) {
      await Promise.resolve()
      // Mismo WHERE que el UPDATE real.
      if (order.estado !== fromEstado || order.shipping_provider !== "beyonix" ||
          order.financial_status !== "payment_confirmed" || order.cancelled_at) return null
      order.estado = action
      if (deliveredAt) order.delivered_at = deliveredAt
      return { ...order }
    },
    async loadEffectMarkers() {
      if (failures.markersRead > 0) { failures.markersRead -= 1; throw new Error("db down") }
      return new Set(markers.map((marker) => marker.effect))
    },
    async recordEffect(_orderId, effect, metadata) {
      if (failures.record > 0 && !effect.endsWith("_email")) { failures.record -= 1; throw new Error("audit down") }
      const id = String(nextId++)
      markers.push({ id, effect, metadata })
      return id
    },
    async removeEffect(id) {
      const index = markers.findIndex((marker) => marker.id === id)
      if (index >= 0) markers.splice(index, 1)
    },
    async activateWarranties() {
      if (failures.warranty > 0) { failures.warranty -= 1; return }
      for (const item of warranties) item.pending = false
    },
    async countPendingWarranties() { return warranties.filter((item) => item.pending).length },
    async sendStateEmail(current) {
      await Promise.resolve()
      if (failures.email > 0) { failures.email -= 1; return false }
      emails.push(current.estado ?? "")
      return true
    },
    now: () => "2026-11-03T15:00:00.000Z",
  }
  const effects = () => markers.map((marker) => marker.effect).sort()
  return { order, deps, markers, warranties, emails, failures, effects }
}

test("avance completo: cada efecto una sola vez (historial, garantía, email) y el costo del cadete en la auditoría de la entrega", async () => {
  const store = localDeliveryStore()
  const inTransit = await advanceLocalDelivery(store.deps, 7, "en_camino")
  assert.equal(inTransit.status, 200)
  assert.deepEqual(inTransit.body.pendingEffects, [])
  const delivered = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(delivered.status, 200)
  assert.equal(store.order.estado, "entregado")
  assert.equal(store.order.delivered_at, "2026-11-03T15:00:00.000Z")
  assert.deepEqual(store.effects(), ["delivered_email", "delivered_status", "in_transit_email", "in_transit_status"])
  assert.deepEqual(store.emails, ["en_camino", "entregado"])
  assert.equal(store.warranties.every((item) => !item.pending), true)
  const deliveredAudit = store.markers.find((marker) => marker.effect === "delivered_status")
  assert.deepEqual(deliveredAudit?.metadata, { previousEstado: "en_camino", newEstado: "entregado", localDeliveryCost: 2_500 })
  // Reintentar con todo completo no repite nada.
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["en_camino", "entregado"])
  assert.equal(store.markers.length, 4)
})

test("Preparando → Entregado por API: rechazado sin tocar el pedido ni disparar efectos", async () => {
  const store = localDeliveryStore()
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(result.status, 409)
  assert.match(result.body.error ?? "", /Primero marcá el pedido como En camino/)
  assert.equal(store.order.estado, "pagado")
  assert.equal(store.order.delivered_at, null)
  assert.deepEqual(store.markers, [])
  assert.deepEqual(store.emails, [])
})

test("Entregado → cualquier avance: rechazado", async () => {
  const store = localDeliveryStore({ estado: "entregado", delivered_at: "2026-11-03T15:00:00.000Z" })
  for (const action of ["en_camino", "entregado"] as const) {
    assert.equal((await advanceLocalDelivery(store.deps, 7, action)).status, 409, action)
  }
  assert.deepEqual(store.emails, [])
})

test("fallo de email: el pedido queda Entregado, el email queda pendiente y el reintento lo envía una sola vez", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.email = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(result.status, 200)
  assert.equal(store.order.estado, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.match(result.body.warning ?? "", /email al cliente[\s\S]*Reintentar avisos/)
  // La reserva del email se liberó: no figura como enviado.
  assert.equal(store.effects().includes("delivered_email"), false)
  assert.deepEqual(store.emails, [])

  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["entregado"])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.emails, ["entregado"], "no duplica un email ya enviado")
})

test("fallo de auditoría: queda pendiente y el reintento la registra una vez, sin reenviar el email", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.record = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_status"])
  assert.deepEqual(store.emails, ["entregado"])
  await retryLocalDeliveryEffects(store.deps, 7)
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.equal(store.markers.filter((marker) => marker.effect === "delivered_status").length, 1)
  assert.deepEqual(store.emails, ["entregado"])
})

test("fallo de activación de garantía: queda pendiente y el reintento la completa", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.warranty = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_warranty"])
  assert.equal(store.warranties.some((item) => item.pending), true)
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.equal(store.warranties.every((item) => !item.pending), true)
  assert.deepEqual(store.emails, ["entregado"], "el email no se repite")
})

test("sin poder leer las marcas no se ejecuta ningún efecto (nunca a ciegas); el reintento los completa", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.markersRead = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_warranty", "delivered_status", "delivered_email"])
  assert.deepEqual(store.emails, [])
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["entregado"])
})

test("dos operadores marcan En camino a la vez: uno gana, el otro recibe conflicto y no hay efectos duplicados", async () => {
  const store = localDeliveryStore()
  const results = await Promise.all([advanceLocalDelivery(store.deps, 7, "en_camino"), advanceLocalDelivery(store.deps, 7, "en_camino")])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  assert.deepEqual(store.emails, ["en_camino"])
  assert.deepEqual(store.effects(), ["in_transit_email", "in_transit_status"])
})

test("dos operadores marcan Entregado a la vez (incluso desde otro proceso con lectura vieja): una sola entrega y un solo email", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  const results = await Promise.all([advanceLocalDelivery(store.deps, 7, "entregado"), advanceLocalDelivery(store.deps, 7, "entregado")])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  // Otro proceso (sin compartir el candado) que leyó "en_camino" antes de la entrega:
  const stale: LocalDeliveryOrderRecord = { ...store.order, estado: "en_camino", delivered_at: null }
  const otherProcess = { ...store.deps, loadOrder: async () => ({ ...stale }) }
  const late = await advanceLocalDelivery(otherProcess, 7, "entregado")
  assert.equal(late.status, 409, "el UPDATE condicional no encuentra el estado de origen")
  assert.deepEqual(store.emails, ["entregado"])
  assert.equal(store.markers.filter((marker) => marker.effect === "delivered_status").length, 1)
})

test("cancelación o reintegro concurrente: el pedido leído como pagado no avanza si se canceló antes de escribir", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  const racing = {
    ...store.deps,
    loadOrder: async () => {
      const snapshot = { ...store.order }
      store.order.financial_status = "refund_pending"
      return snapshot
    },
  }
  const result = await advanceLocalDelivery(racing, 7, "entregado")
  assert.equal(result.status, 409)
  assert.equal(store.order.estado, "en_camino")
  assert.deepEqual(store.emails, [])
  assert.deepEqual(store.markers, [])
})

test("reintentar avisos sólo aplica a pedidos en camino o entregados", async () => {
  assert.equal((await retryLocalDeliveryEffects(localDeliveryStore().deps, 7)).status, 409)
  assert.equal((await retryLocalDeliveryEffects(localDeliveryStore({ estado: "cancelado" }).deps, 7)).status, 409)
})

test("efectos pendientes por etapa (para el listado de Despachos)", () => {
  assert.deepEqual(getMissingLocalDeliveryEffects("preparing", new Set(), 0), [])
  assert.deepEqual(getMissingLocalDeliveryEffects("in_transit", new Set(["in_transit_status"]), 0), ["in_transit_email"])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", new Set(["delivered_status", "delivered_email"]), 2), ["delivered_warranty"])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", new Set(["delivered_status", "delivered_email"]), 0), [])
})

test("ruta y panel: transición atómica en el WHERE, reintento explícito y sólo el próximo paso visible", () => {
  const route = readFileSync("app/api/admin/dispatch/local/route.ts", "utf8")
  assert.match(route, /requireOperator\(request\)/)
  assert.match(route, /\.eq\("estado", fromEstado\)\s+\.eq\("shipping_provider", LOCAL_DELIVERY_PROVIDER\)\s+\.eq\("financial_status", "payment_confirmed"\)\s+\.is\("cancelled_at", null\)/)
  assert.match(route, /action === "retry_effects"\s+\? await retryLocalDeliveryEffects\(deps, orderId\)\s+: await advanceLocalDelivery\(deps, orderId, action\)/)
  assert.match(route, /activatePendingItemWarranties\(admin/)
  assert.match(route, /sendOrderStateEmail\(order\)/)
  assert.doesNotMatch(route.replace(/^\s*\/\/.*$/gm, ""), /andreani|tracking_number|etiqueta/i)
  const panel = readFileSync("app/admin/sections/despachos/local-delivery-panel.tsx", "utf8")
  assert.match(panel, /const next = getNextLocalDeliveryAction\(order\.stage\)/)
  assert.match(panel, /\{next === "en_camino" && \(/)
  assert.match(panel, /\{next === "entregado" && \(/)
  assert.match(panel, /Reintentar avisos/)
  const page = readFileSync("app/admin/sections/despachos/admin-dispatches.tsx", "utf8")
  assert.match(page, /\{listView && <LocalDeliveryPanel refreshSignal=\{board\} \/>\}/)
})

// ── Costo del cadete devengado al entregar ───────────────────────────────────

const ledgerOrder = (overrides: Record<string, unknown>) => ({
  shipping_provider: "beyonix", envio_proveedor: null, shipping_provider_quote_amount: null,
  shipping_cost_real: 2_500, andreani_costo: null, estado: "pagado", delivered_at: null, ...overrides,
}) as Parameters<typeof getWebShippingCost>[0]

test("rentabilidad: Envío BEYONIX devenga $2.500 sólo al entregarse; antes o cancelado, $0", () => {
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "pagado" })), 0, "preparando")
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "en_camino" })), 0, "en camino")
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "cancelado" })), 0, "cancelado sin entregar")
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "entregado", delivered_at: "2026-11-03T15:00:00Z" })), 2_500, "entregado")
  // Entregado con envío gratis o cobrado: el costo es el mismo (no depende de lo cobrado).
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "entregado", shipping_cost_charged: 0 })), 2_500, "gratis entregado")
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "entregado", shipping_cost_charged: 2_500 })), 2_500, "cobrado entregado")
  // Entregado y después devuelto/cancelado: el cadete ya cobró.
  assert.equal(getWebShippingCost(ledgerOrder({ estado: "cancelado", delivered_at: "2026-11-03T15:00:00Z" })), 2_500)
})

test("rentabilidad Andreani sin regresión: tarifa cotizada, o el costo histórico si no hay snapshot", () => {
  const andreani = (overrides: Record<string, unknown>) => ledgerOrder({ shipping_provider: "andreani", ...overrides })
  assert.equal(getWebShippingCost(andreani({ shipping_provider_quote_amount: 8_000, shipping_cost_real: 8_900, estado: "pagado" })), 8_000)
  assert.equal(getWebShippingCost(andreani({ shipping_cost_real: 8_900 })), 8_900)
  assert.equal(getWebShippingCost(andreani({ shipping_cost_real: null, andreani_costo: 7_000 })), 7_000)
  assert.match(readFileSync("app/api/admin/dashboard/route.ts", "utf8").replace(/\r\n/g, "\n"), /envio_proveedor,\n\s+delivered_at,\n\s+shipping_cost_real,/)
})

test("ledger: un pedido local en camino no suma costo logístico; entregado lo suma una sola vez", () => {
  const ledger = (estado: string, delivered_at: string | null) => buildDashboardLedger({
    orders: [{
      id: 70, estado, delivered_at, created_at: "2026-11-03T12:00:00Z", paid_at: "2026-11-03T12:00:00Z",
      total: 47_500, original_total: 47_500, financial_status: "payment_confirmed", payment_method_id: "transferencia",
      shipping_provider: "beyonix", shipping_cost_real: 2_500, shipping_cost_charged: 2_500,
    } as never],
    items: [{ id: 1, orden_id: 70, producto_id: 1, cantidad: 1, precio: 45_000 } as never],
    authorizedCreditNotes: [],
    creditMovements: [],
    marketplaceRows: [],
    marketplaceReturnReviews: [],
    externalRows: [],
    productCosts: [],
    expenses: [],
  })
  assert.equal(ledger("en_camino", null).web.shippingCost, 0)
  assert.equal(ledger("entregado", "2026-11-03T15:00:00Z").web.shippingCost, 2_500)
  // El ingreso por envío cobrado no cambia con la entrega (no se duplica ni desaparece).
  assert.equal(ledger("en_camino", null).web.shippingCharged, 2_500)
  assert.equal(ledger("entregado", "2026-11-03T15:00:00Z").web.shippingCharged, 2_500)
})

// ── 42. Emails ───────────────────────────────────────────────────────────────

async function captureStateEmail(order: Parameters<typeof sendOrderStateEmail>[0]) {
  const previous = { key: process.env.RESEND_API_KEY, from: process.env.STORE_EMAIL_FROM }
  process.env.RESEND_API_KEY = "test-key"
  process.env.STORE_EMAIL_FROM = "BEYONIX <pedidos@beyonix.test>"
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }))
  try {
    await sendOrderStateEmail(order)
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.arguments[1] as RequestInit | undefined)?.body ?? "{}")) as { subject?: string; html?: string }
    return body
  } finally {
    fetchMock.mock.restore()
    if (previous.key === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previous.key
    if (previous.from === undefined) delete process.env.STORE_EMAIL_FROM; else process.env.STORE_EMAIL_FROM = previous.from
  }
}

test("email En camino de Envío BEYONIX: sin seguimiento ni link aunque hubiera datos cargados", async () => {
  const email = await captureStateEmail({
    id: 7, estado: "en_camino", cliente_email: "cliente@test.com", cliente_nombre: "Ana",
    shipping_provider: "beyonix", tracking_number: "123", tracking_url: "https://andreani.com/x",
  })
  assert.match(email.html ?? "", /Tu pedido está en camino/)
  assert.doesNotMatch(email.html ?? "", /Seguimiento|andreani|sucursal/i)
})

test("email Entregado de Envío BEYONIX: 'tu pedido fue entregado', sin retiro en sucursal", async () => {
  const email = await captureStateEmail({ id: 7, estado: "entregado", cliente_email: "cliente@test.com", cliente_nombre: "Ana", shipping_provider: "beyonix" })
  assert.match(email.html ?? "", /fue entregado/)
  assert.doesNotMatch(email.html ?? "", /andreani|sucursal|seguimiento/i)
})

test("email Andreani sin cambios: sigue mostrando el seguimiento", async () => {
  const email = await captureStateEmail({
    id: 7, estado: "en_camino", cliente_email: "cliente@test.com", cliente_nombre: "Ana",
    shipping_provider: "andreani", tracking_number: "AND-1",
  })
  assert.match(email.html ?? "", /Seguimiento: AND-1/)
})

test("email de pago confirmado: Envío BEYONIX anuncia la preparación sin prometer número de seguimiento", () => {
  assert.equal(getOrderPreparationFollowUp({ shipping_provider: "beyonix" }), "Tu pedido está siendo preparado. Te vamos a avisar cuando esté en camino.")
  assert.doesNotMatch(getOrderPreparationFollowUp({ shipping_provider: "beyonix" }), /seguimiento|andreani|sucursal/i)
  assert.match(getOrderPreparationFollowUp({ shipping_provider: "andreani" }), /número o link de seguimiento/)
  for (const route of ["app/api/mercadopago/webhook/route.ts", "app/api/customer-credit/create-order/route.ts"]) {
    assert.match(readFileSync(route, "utf8"), /getOrderPreparationFollowUp\(/, route)
  }
})

test("devoluciones siguen por sucursal Andreani: Envío BEYONIX es sólo la entrega inicial", () => {
  // Ningún flujo de devolución/reclamo conoce el proveedor local.
  for (const file of ["lib/andreani/claim-shipments.ts", "lib/orders/claim-server.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /beyonix:|LOCAL_DELIVERY|local-delivery/, file)
  }
})
