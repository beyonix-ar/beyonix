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
  getLocalDeliveryRetryError,
  getLocalDeliveryStage,
  getLocalDeliveryTransitionError,
  getNextLocalDeliveryAction,
  type LocalDeliveryOrderState,
} from "./local-delivery-status.ts"
import {
  advanceLocalDelivery,
  getMissingLocalDeliveryEffects,
  isActiveWarrantyItem,
  parseLocalDeliveryEffectRecord,
  retryLocalDeliveryEffects,
  STALE_EFFECT_RESERVATION_MS,
  summarizeLocalDeliveryEffects,
  type LocalDeliveryEffect,
  type LocalDeliveryEffectState,
  type LocalDeliveryOrderRecord,
  type LocalDeliveryServiceDeps,
  type LocalDeliveryWarrantyItem,
} from "./local-delivery-service.ts"
import { buildDashboardLedger, getWebShippingCost } from "../business/dashboard-commercial-ledger.ts"
import { INVALID_LOCAL_DELIVERY_SETTINGS } from "../shipping/local-delivery.ts"
import { getOrderPreparationFollowUp } from "./shipping-email-copy.ts"
import { sendOrderStateEmail } from "./order-status-notifications.ts"
import { hasConfirmedPaymentEvidence } from "./order-payment-status.ts"
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
  payment_status: "approved",
  payment_confirmed_amount: 45_000,
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

type EffectRow = { effect: LocalDeliveryEffect; state: LocalDeliveryEffectState; metadata: Record<string, unknown>; createdAt: string }

function localDeliveryStore(initial: Partial<LocalDeliveryOrderRecord> = {}) {
  const order: LocalDeliveryOrderRecord = {
    id: 7,
    estado: "pagado",
    shipping_provider: "beyonix",
    financial_status: "payment_confirmed",
    paid_at: "2026-11-03T12:00:00.000Z",
    payment_status: "approved",
    payment_confirmed_amount: 45_000,
    delivered_at: null,
    cancelled_at: null,
    shipping_cost_real: 2_500,
    cliente_email: "ana@test.com",
    cliente_nombre: "Ana",
    ...initial,
  }
  const rows: EffectRow[] = []
  const warranties = [1, 2].map((id) => ({
    id, warranty_started_at: null as string | null, warranty_expires_at: null as string | null,
    warranty_status: "pending_delivery" as string | null, warranty_months: 6, activations: 0,
  }))
  const emails: string[] = []
  const failures = {
    email: 0, emailThrows: 0, status: 0, markersRead: 0, warrantyRead: 0,
    /** Ítems cuya activación falla en el próximo intento. */
    warrantyItems: 0,
    /** Escrituras de un estado puntual que fallan (p. ej. `failed`). */
    state: {} as Partial<Record<LocalDeliveryEffectState, number>>,
  }
  /** Hooks para simular otro proceso entre pasos. */
  const hooks: { onReserve?: (attemptId: string) => void } = {}
  let authorizations = 0
  // Mismo WHERE que whereLocalDeliveryEligible en la ruta.
  const eligibleInDb = () => order.shipping_provider === "beyonix" && !order.cancelled_at && hasConfirmedPaymentEvidence(order)
  let clock = Date.parse("2026-11-03T15:00:00.000Z")
  const now = () => new Date(clock).toISOString()
  const deps: LocalDeliveryServiceDeps = {
    async loadOrder() { return { ...order } },
    async transitionOrder({ fromEstado, action, deliveredAt }) {
      await Promise.resolve()
      // Mismo WHERE que el UPDATE real.
      if (order.estado !== fromEstado || !eligibleInDb()) return null
      order.estado = action
      if (deliveredAt) order.delivered_at = deliveredAt
      return { ...order }
    },
    async loadEffectRecords() {
      if (failures.markersRead > 0) { failures.markersRead -= 1; throw new Error("db down") }
      return rows.map(({ effect, state, createdAt, metadata }) =>
        ({ effect, state, createdAt, attemptId: typeof metadata.attemptId === "string" ? metadata.attemptId : null }))
    },
    async recordEffect(_orderId, effect, state, metadata) {
      await Promise.resolve()
      if (failures.status > 0 && effect.endsWith("_status")) { failures.status -= 1; throw new Error("audit down") }
      if ((failures.state[state] ?? 0) > 0) { failures.state[state]! -= 1; throw new Error(`${state} down`) }
      rows.push({ effect, state, metadata, createdAt: now() })
      if (state === "reserved" && typeof metadata.attemptId === "string") hooks.onReserve?.(metadata.attemptId)
    },
    async authorizeEmail(_orderId, expectedEstado) {
      await Promise.resolve()
      const ok = order.estado === expectedEstado && eligibleInDb()
      if (ok) authorizations += 1
      return ok
    },
    async activateWarranties(_orderId, deliveredAt) {
      let failing = failures.warrantyItems
      failures.warrantyItems = 0
      for (const item of warranties) {
        // Mismo guard que el UPDATE real: sólo ítems sin garantía iniciada.
        if (item.warranty_started_at || item.warranty_expires_at) continue
        if (failing > 0) { failing -= 1; continue }
        item.warranty_started_at = deliveredAt
        item.warranty_expires_at = "2027-05-03T15:00:00.000Z"
        item.warranty_status = "active"
        item.activations += 1
      }
    },
    async loadWarrantyItems() {
      if (failures.warrantyRead > 0) { failures.warrantyRead -= 1; throw new Error("items down") }
      return warranties.map(({ id, warranty_started_at, warranty_expires_at, warranty_status, warranty_months }) =>
        ({ id, warranty_started_at, warranty_expires_at, warranty_status, warranty_months }))
    },
    async sendStateEmail(current) {
      await Promise.resolve()
      if (failures.emailThrows > 0) { failures.emailThrows -= 1; throw new Error("smtp down") }
      if (failures.email > 0) { failures.email -= 1; return false }
      emails.push(current.estado ?? "")
      return true
    },
    now,
  }
  const completed = () => rows.filter((row) => row.state === "completed").map((row) => row.effect).sort()
  const rowsOf = (effect: LocalDeliveryEffect) => rows.filter((row) => row.effect === effect).map((row) => row.state)
  const advanceClock = (ms: number) => { clock += ms }
  return { order, deps, rows, warranties, emails, failures, completed, rowsOf, advanceClock, hooks, authorizations: () => authorizations }
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
  assert.deepEqual(store.completed(), ["delivered_email", "delivered_status", "delivered_warranty", "in_transit_email", "in_transit_status"])
  assert.deepEqual(store.emails, ["en_camino", "entregado"])
  assert.equal(store.warranties.every((item) => item.warranty_status === "active"), true)
  const deliveredAudit = store.rows.find((row) => row.effect === "delivered_status")
  assert.deepEqual(deliveredAudit?.metadata, { previousEstado: "en_camino", newEstado: "entregado", localDeliveryCost: 2_500 })
  // Reintentar con todo completo no repite nada.
  const rowsBefore = store.rows.length
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["en_camino", "entregado"])
  assert.equal(store.rows.length, rowsBefore)
})

test("Preparando → Entregado por API: rechazado sin tocar el pedido ni disparar efectos", async () => {
  const store = localDeliveryStore()
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(result.status, 409)
  assert.match(result.body.error ?? "", /Primero marcá el pedido como En camino/)
  assert.equal(store.order.estado, "pagado")
  assert.equal(store.order.delivered_at, null)
  assert.deepEqual(store.rows, [])
  assert.deepEqual(store.emails, [])
})

test("Entregado → cualquier avance: rechazado", async () => {
  const store = localDeliveryStore({ estado: "entregado", delivered_at: "2026-11-03T15:00:00.000Z" })
  for (const action of ["en_camino", "entregado"] as const) {
    assert.equal((await advanceLocalDelivery(store.deps, 7, action)).status, 409, action)
  }
  assert.deepEqual(store.emails, [])
})

test("fallo de email: el pedido queda Entregado, el email queda failed (no enviado) y el reintento lo envía una sola vez", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.email = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(result.status, 200)
  assert.equal(store.order.estado, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.match(result.body.warning ?? "", /email al cliente[\s\S]*Reintentar avisos/)
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed"])
  assert.equal(store.completed().includes("delivered_email"), false)
  assert.deepEqual(store.emails, [])

  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["entregado"])
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed", "reserved", "completed"])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.emails, ["entregado"], "completed: no reenvía")
})

test("fallo de auditoría: queda pendiente y el reintento la registra una vez, sin reenviar el email", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.status = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_status"])
  assert.deepEqual(store.emails, ["entregado"])
  await retryLocalDeliveryEffects(store.deps, 7)
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.rowsOf("delivered_status"), ["completed"])
  assert.deepEqual(store.emails, ["entregado"])
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
  assert.deepEqual(store.completed(), ["in_transit_email", "in_transit_status"])
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
  assert.deepEqual(store.rowsOf("delivered_status"), ["completed"])
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
  assert.deepEqual(store.rows, [])
})

test("reintentar avisos sólo aplica a pedidos en camino o entregados", async () => {
  assert.equal((await retryLocalDeliveryEffects(localDeliveryStore().deps, 7)).status, 409)
  assert.equal((await retryLocalDeliveryEffects(localDeliveryStore({ estado: "cancelado" }).deps, 7)).status, 409)
})

// ── Bloqueante 2: "Reintentar avisos" revalida el pedido fresco ─────────────

async function deliveredWithFailedEmail() {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.email = 1
  await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed"])
  return store
}

test("reintento: entregado válido con email pendiente => reintenta y envía", async () => {
  const store = await deliveredWithFailedEmail()
  const result = await retryLocalDeliveryEffects(store.deps, 7)
  assert.equal(result.status, 200)
  assert.deepEqual(store.emails, ["entregado"])
})

test("reintento: cancelado, refund_pending, refunded, Andreani o sin pago confirmado => 409 sin ejecutar ningún aviso", async () => {
  const cases: Array<[string, Partial<LocalDeliveryOrderRecord>]> = [
    ["cancelado", { estado: "cancelado", cancelled_at: "2026-11-03T16:00:00.000Z", financial_status: "cancelled" }],
    ["cancelled_at sin estado cancelado", { cancelled_at: "2026-11-03T16:00:00.000Z" }],
    ["refund_pending", { financial_status: "refund_pending" }],
    ["refunded", { financial_status: "refunded" }],
    ["Andreani", { shipping_provider: "andreani" }],
    ["pago no confirmado", { financial_status: "pending_payment", paid_at: null }],
  ]
  for (const [label, change] of cases) {
    const store = await deliveredWithFailedEmail()
    Object.assign(store.order, change)
    const rowsBefore = store.rows.length
    const result = await retryLocalDeliveryEffects(store.deps, 7)
    assert.equal(result.status, 409, label)
    assert.ok(result.body.error, label)
    assert.deepEqual(store.emails, [], `${label}: no envía "Tu pedido fue entregado"`)
    assert.equal(store.rows.length, rowsBefore, `${label}: no escribe efectos`)
  }
})

test("reintento: si el pedido se cancela entre la validación y el envío, el email no sale", async () => {
  const store = await deliveredWithFailedEmail()
  let reads = 0
  const racing = {
    ...store.deps,
    loadOrder: async () => {
      reads += 1
      // Primera lectura: válido. Antes del email (segunda lectura): reintegrado.
      if (reads === 2) store.order.financial_status = "refunded"
      return { ...store.order }
    },
  }
  const result = await retryLocalDeliveryEffects(racing, 7)
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.emails, [])
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed"], "ni siquiera reserva")
})

test("reintento por etapa: en camino sólo ejecuta efectos de En camino (nunca el email de Entregado)", async () => {
  const store = localDeliveryStore()
  store.failures.email = 1
  await advanceLocalDelivery(store.deps, 7, "en_camino")
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.emails, ["en_camino"])
  assert.deepEqual(store.completed(), ["in_transit_email", "in_transit_status"])
})

// ── Bloqueante 3: estados explícitos del email ──────────────────────────────

test("email OK => reserved + completed", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "completed"])
})

test("email que lanza excepción => failed/retryable, nunca completed", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.emailThrows = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed"])
})

test("falla el email y también la marca failed: la reserva NO cuenta como enviado y se recupera al vencer", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.email = 1
  store.failures.state.failed = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved"])
  assert.equal(store.completed().includes("delivered_email"), false)
  const statuses = summarizeLocalDeliveryEffects(await store.deps.loadEffectRecords(7), Date.parse(store.deps.now()))
  assert.equal(statuses.get("delivered_email"), "in_progress")
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", statuses, 0), ["delivered_email"], "sigue pendiente en Despachos")

  // Reserva reciente: no se reenvía a ciegas.
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.emails, [])
  // Reserva vencida: se reintenta.
  store.advanceClock(STALE_EFFECT_RESERVATION_MS + 1)
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["entregado"])
})

test("email enviado pero falla la marca completed: el reintento sólo escribe la marca, sin reenviar", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  const deps = { ...store.deps }
  let failNextEmailCompleted = true
  deps.recordEffect = async (orderId, effect, state, metadata) => {
    if (failNextEmailCompleted && effect === "delivered_email" && state === "completed") {
      failNextEmailCompleted = false
      throw new Error("completed down")
    }
    return store.deps.recordEffect(orderId, effect, state, metadata)
  }
  const result = await advanceLocalDelivery(deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.emails, ["entregado"])
  assert.deepEqual((await retryLocalDeliveryEffects(deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.emails, ["entregado"], "no duplica el email")
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "completed"])
})

test("dos reintentos simultáneos en la misma instancia: uno solo envía", async () => {
  const store = await deliveredWithFailedEmail()
  const results = await Promise.all([retryLocalDeliveryEffects(store.deps, 7), retryLocalDeliveryEffects(store.deps, 7)])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  assert.deepEqual(store.emails, ["entregado"])
  assert.equal(store.rowsOf("delivered_email").filter((state) => state === "completed").length, 1)
})

test("resumen de estados: sólo completed cuenta como hecho; failed y reserved vencido son reintentables", () => {
  const at = (minutes: number) => new Date(Date.parse("2026-11-03T15:00:00.000Z") + minutes * 60_000).toISOString()
  const now = Date.parse(at(10))
  const summary = summarizeLocalDeliveryEffects([
    { effect: "delivered_email", state: "reserved", createdAt: at(8), attemptId: "a" },
    { effect: "delivered_email", state: "failed", createdAt: at(8), attemptId: "a" },
    { effect: "in_transit_email", state: "reserved", createdAt: at(9), attemptId: "b" },
    // Otro intento cerrado con failed no oculta la reserva vigente de "b".
    { effect: "in_transit_email", state: "reserved", createdAt: at(9), attemptId: "c" },
    { effect: "in_transit_email", state: "failed", createdAt: at(9), attemptId: "c" },
    { effect: "delivered_status", state: "completed", createdAt: at(0) },
    { effect: "delivered_warranty", state: "reserved", createdAt: at(0), attemptId: "d" },
    { effect: "in_transit_status", state: null, createdAt: at(0) },
  ], now)
  assert.equal(summary.get("delivered_email"), "retryable", "failed cierra su intento")
  assert.equal(summary.get("in_transit_email"), "in_progress")
  assert.equal(summary.get("delivered_status"), "completed")
  assert.equal(summary.get("delivered_warranty"), "retryable", "reserva vencida")
  assert.equal(summary.get("in_transit_status"), "retryable", "sin estado explícito no es completed")
  assert.equal(parseLocalDeliveryEffectRecord({ localDeliveryEffect: "delivered_email" }, at(0))?.state, null)
  assert.equal(parseLocalDeliveryEffectRecord({ localDeliveryEffect: "otro" }, at(0)), null)
  assert.equal(parseLocalDeliveryEffectRecord({ localDeliveryEffect: "delivered_email", localDeliveryEffectState: "reserved", attemptId: "x" }, at(0))?.attemptId, "x")
})

// ── Bloqueante 2 (ronda 2): reserva + autorización condicional antes del email ──

test("email: la reserva se autoriza una sola vez en base antes de llamar al proveedor", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(store.authorizations(), 1)
  const reserved = store.rows.find((row) => row.effect === "delivered_email" && row.state === "reserved")
  assert.equal(reserved?.metadata.expectedEstado, "entregado")
  assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "completed"])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.equal(store.authorizations(), 1, "completed: no vuelve a autorizar")
})

test("email: cancelación, refund_pending, refunded o cambio de estado entre la lectura y la reserva => la autorización en base falla y no se envía", async () => {
  const invalidations: Array<[string, (order: LocalDeliveryOrderRecord) => void]> = [
    ["cancelación", (order) => { order.estado = "cancelado"; order.cancelled_at = "2026-11-03T15:00:01.000Z"; order.financial_status = "cancelled" }],
    ["refund_pending", (order) => { order.financial_status = "refund_pending" }],
    ["refunded", (order) => { order.financial_status = "refunded" }],
    ["cambio de estado", (order) => { order.estado = "en_camino"; order.delivered_at = null }],
  ]
  for (const [label, invalidate] of invalidations) {
    const store = await deliveredWithFailedEmail()
    // Otro proceso invalida el pedido justo cuando se persiste la reserva.
    store.hooks.onReserve = () => invalidate(store.order)
    const result = await retryLocalDeliveryEffects(store.deps, 7)
    assert.deepEqual(result.body.pendingEffects, ["delivered_email"], label)
    assert.deepEqual(store.emails, [], `${label}: el proveedor nunca se llama`)
    assert.deepEqual(store.rowsOf("delivered_email"), ["reserved", "failed", "reserved", "failed"], `${label}: la reserva queda cerrada como failed`)
    const notAuthorized = store.rows.at(-1)
    assert.equal(notAuthorized?.metadata.reason, "not_authorized", label)
  }
})

test("email: invalidación anterior a la lectura => ni siquiera reserva", async () => {
  for (const change of [{ financial_status: "refund_pending" }, { financial_status: "refunded" }, { cancelled_at: "2026-11-03T16:00:00.000Z" }]) {
    const store = await deliveredWithFailedEmail()
    const rowsBefore = store.rows.length
    const authorizationsBefore = store.authorizations()
    Object.assign(store.order, change)
    assert.equal((await retryLocalDeliveryEffects(store.deps, 7)).status, 409)
    assert.deepEqual(store.emails, [])
    assert.equal(store.authorizations(), authorizationsBefore)
    assert.equal(store.rows.length, rowsBefore, "sin reserva nueva")
  }
})

test("email: dos intentos que reservan a la vez (otro proceso sin el candado) => sólo la reserva más vieja queda autorizada", async () => {
  const store = await deliveredWithFailedEmail()
  // Otro proceso reservó un instante antes y sigue enviando.
  store.hooks.onReserve = (attemptId) => {
    store.hooks.onReserve = undefined
    store.rows.splice(store.rows.length - 1, 0, {
      effect: "delivered_email", state: "reserved", metadata: { attemptId: `0-otro-${attemptId}` },
      createdAt: new Date(Date.parse(store.deps.now()) - 1_000).toISOString(),
    })
  }
  const result = await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(result.body.pendingEffects, ["delivered_email"])
  assert.deepEqual(store.emails, [], "el que perdió no envía")
  // Mientras la otra reserva esté vigente, el efecto figura en curso.
  const statuses = summarizeLocalDeliveryEffects(await store.deps.loadEffectRecords(7), Date.parse(store.deps.now()))
  assert.equal(statuses.get("delivered_email"), "in_progress")
})

test("email: dos reintentos simultáneos en la misma instancia => una sola autorización y un solo envío", async () => {
  const store = await deliveredWithFailedEmail()
  const before = store.authorizations()
  const results = await Promise.all([retryLocalDeliveryEffects(store.deps, 7), retryLocalDeliveryEffects(store.deps, 7)])
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409])
  assert.equal(store.authorizations() - before, 1)
  assert.deepEqual(store.emails, ["entregado"])
})

// ── Bloqueante 3: evidencia real de pago ────────────────────────────────────

test("evidencia de pago: MP, transferencia y saldo confirmados de verdad avanzan; payment_confirmed sin respaldo no", () => {
  // Campos que escribe cada vía real de confirmación.
  const mercadoPago = { financial_status: "payment_confirmed", payment_status: "approved", paid_at: "2026-11-03T12:00:00.000Z", payment_confirmed_amount: 45_000 }
  const transfer = { financial_status: "payment_confirmed", payment_status: "confirmado", paid_at: "2026-11-03T12:00:00.000Z", payment_confirmed_amount: 42_750 }
  const customerCredit = { financial_status: "payment_confirmed", payment_status: "confirmado", paid_at: "2026-11-03T12:00:00.000Z", payment_confirmed_amount: 47_500 }
  for (const [label, payment] of [["MP", mercadoPago], ["transferencia", transfer], ["saldo", customerCredit]] as const) {
    assert.equal(hasConfirmedPaymentEvidence(payment), true, label)
    assert.equal(getLocalDeliveryTransitionError(paidLocalOrder(payment), "en_camino"), null, label)
  }
  const unbacked: Array<[string, Partial<LocalDeliveryOrderState>]> = [
    ["sólo financial_status", { paid_at: null, payment_status: null, payment_confirmed_amount: null }],
    ["sin paid_at", { paid_at: null }],
    ["importe confirmado 0", { payment_confirmed_amount: 0 }],
    ["payment_status pendiente", { payment_status: "pending" }],
    ["pago revertido", { payment_status: "approved_amount_mismatch" }],
    ["rechazado", { payment_status: "rechazado" }],
  ]
  for (const [label, change] of unbacked) {
    const order = paidLocalOrder(change)
    assert.equal(hasConfirmedPaymentEvidence(order), false, label)
    assert.match(getLocalDeliveryTransitionError(order, "en_camino") ?? "", /pago confirmado/, label)
    assert.match(getLocalDeliveryRetryError({ ...order, estado: "entregado" }) ?? "", /pago confirmado/, label)
  }
  for (const financial_status of ["refund_pending", "refunded", "cancelled"]) {
    assert.equal(hasConfirmedPaymentEvidence({ ...mercadoPago, financial_status }), false, financial_status)
    assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ financial_status }), "en_camino") ?? "", /cancelado/, financial_status)
  }
  assert.match(getLocalDeliveryTransitionError(paidLocalOrder({ estado: "cancelado" }), "en_camino") ?? "", /cancelado/)
})

test("evidencia de pago: el UPDATE atómico tampoco avanza un payment_confirmed sin respaldo", async () => {
  const store = localDeliveryStore()
  const racing = {
    ...store.deps,
    loadOrder: async () => {
      const snapshot = { ...store.order }
      // Entre la lectura y la escritura alguien deja financial_status sin respaldo.
      store.order.paid_at = null
      return snapshot
    },
  }
  assert.equal((await advanceLocalDelivery(racing, 7, "en_camino")).status, 409)
  assert.equal(store.order.estado, "pagado")
  assert.deepEqual(store.rows, [])
})

// ── Bloqueante 4: garantía completa antes de marcar el efecto ───────────────

test("garantía: todos los ítems OK => una sola auditoría final completed", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"])
  const audit = store.rows.find((row) => row.effect === "delivered_warranty")
  assert.deepEqual((audit?.metadata.items as Array<{ id: number }>).map((item) => item.id), [1, 2])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"])
})

test("garantía: falla un ítem => sin completed ni auditoría final; el reintento completa sólo el faltante y audita una vez", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.warrantyItems = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_warranty"])
  assert.deepEqual(store.rowsOf("delivered_warranty"), [], "ninguna auditoría falsa de éxito")
  assert.deepEqual(store.warranties.map((item) => item.activations), [0, 1])

  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.warranties.map((item) => item.activations), [1, 1], "cada ítem se activa una sola vez")
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"], "auditoría final una sola vez")
  assert.deepEqual(store.warranties.map((item) => item.activations), [1, 1])
  assert.deepEqual(store.emails, ["entregado"], "el email no se repite")
})

test("garantía: si no se pueden verificar los ítems, no se marca completada", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.warrantyRead = 1
  const result = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.deepEqual(result.body.pendingEffects, ["delivered_warranty"])
  assert.deepEqual(store.rowsOf("delivered_warranty"), [])
  assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, [])
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"])
})

test("garantía: todos los ítems activos con fechas válidas => completed y la auditoría guarda cada ítem verificado", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  await advanceLocalDelivery(store.deps, 7, "entregado")
  const audit = store.rows.find((row) => row.effect === "delivered_warranty")
  for (const item of audit?.metadata.items as LocalDeliveryWarrantyItem[]) {
    assert.equal(isActiveWarrantyItem(item), true)
    assert.equal(item.warranty_started_at, "2026-11-03T15:00:00.000Z")
  }
})

test("garantía: ningún ítem 'pendiente' pero uno con estado inválido o sin fecha => NO completed ni auditoría", async () => {
  const inconsistencies: Array<[string, Partial<LocalDeliveryWarrantyItem>]> = [
    ["estado inválido", { warranty_status: "expired", warranty_started_at: "2026-01-01T00:00:00.000Z", warranty_expires_at: "2026-07-01T00:00:00.000Z" }],
    ["sin vencimiento", { warranty_status: "active", warranty_started_at: "2026-11-03T15:00:00.000Z", warranty_expires_at: null }],
    ["sin inicio", { warranty_status: "active", warranty_started_at: null, warranty_expires_at: "2027-05-03T15:00:00.000Z" }],
    ["vencimiento anterior al inicio", { warranty_status: "active", warranty_started_at: "2026-11-03T15:00:00.000Z", warranty_expires_at: "2026-11-01T00:00:00.000Z" }],
    ["fecha ilegible", { warranty_status: "active", warranty_started_at: "no-es-fecha", warranty_expires_at: "2027-05-03T15:00:00.000Z" }],
    ["sin meses", { warranty_status: "active", warranty_started_at: "2026-11-03T15:00:00.000Z", warranty_expires_at: "2027-05-03T15:00:00.000Z", warranty_months: 0 }],
  ]
  for (const [label, change] of inconsistencies) {
    const store = localDeliveryStore({ estado: "en_camino" })
    Object.assign(store.warranties[0], change)
    const before = { ...store.warranties[0] }
    const result = await advanceLocalDelivery(store.deps, 7, "entregado")
    assert.deepEqual(result.body.pendingEffects, ["delivered_warranty"], label)
    assert.deepEqual(store.rowsOf("delivered_warranty"), [], `${label}: sin auditoría final de éxito`)
    assert.deepEqual(store.warranties[0], before, `${label}: un ítem con garantía iniciada nunca se pisa`)
    assert.equal(store.warranties[1].activations, 1, `${label}: el ítem pendiente sí se activa`)
    // Reintentar sin corregir el dato sigue sin completar.
    assert.deepEqual((await retryLocalDeliveryEffects(store.deps, 7)).body.pendingEffects, ["delivered_warranty"], label)
    assert.deepEqual(store.rowsOf("delivered_warranty"), [], label)
  }
})

test("garantía: fallo parcial + reintento => no toca ítems válidos, completa el faltante, verifica todos y audita una vez", async () => {
  const store = localDeliveryStore({ estado: "en_camino" })
  store.failures.warrantyItems = 1
  await advanceLocalDelivery(store.deps, 7, "entregado")
  const validItem = { ...store.warranties[1] }
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.warranties[1], validItem, "el ítem ya válido no se reescribe")
  assert.equal(store.warranties.every(isActiveWarrantyItem), true)
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.rowsOf("delivered_warranty"), ["completed"])
})

// ── Aviso En camino obsoleto ────────────────────────────────────────────────

test("aviso En camino fallido + Entregado: no bloquea, queda superseded, nunca se envía y sale el de Entregado", async () => {
  const store = localDeliveryStore()
  store.failures.email = 1
  const inTransit = await advanceLocalDelivery(store.deps, 7, "en_camino")
  assert.deepEqual(inTransit.body.pendingEffects, ["in_transit_email"])
  const delivered = await advanceLocalDelivery(store.deps, 7, "entregado")
  assert.equal(delivered.status, 200)
  assert.deepEqual(delivered.body.pendingEffects, [])
  assert.deepEqual(store.rowsOf("in_transit_email"), ["reserved", "failed", "superseded"])
  assert.deepEqual(store.emails, ["entregado"])
  await retryLocalDeliveryEffects(store.deps, 7)
  assert.deepEqual(store.emails, ["entregado"], "el aviso viejo nunca sale")
  assert.deepEqual(store.rowsOf("in_transit_email"), ["reserved", "failed", "superseded"])
})

test("efectos pendientes por etapa (para el listado de Despachos)", () => {
  const done = (...effects: LocalDeliveryEffect[]) => new Map(effects.map((effect) => [effect, "completed" as const]))
  assert.deepEqual(getMissingLocalDeliveryEffects("preparing", new Map(), 0), [])
  assert.deepEqual(getMissingLocalDeliveryEffects("in_transit", done("in_transit_status"), 0), ["in_transit_email"])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", done("delivered_status", "delivered_email"), 0), ["delivered_warranty"])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", done("delivered_status", "delivered_email", "delivered_warranty"), 2), ["delivered_warranty"])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", done("delivered_status", "delivered_email", "delivered_warranty"), 0), [])
  assert.deepEqual(getMissingLocalDeliveryEffects("delivered", new Map([
    ["delivered_status", "completed"], ["delivered_warranty", "completed"], ["delivered_email", "retryable"], ["in_transit_email", "superseded"],
  ]), 0), ["delivered_email"])
})

test("ruta y panel: transición atómica en el WHERE, reintento explícito y sólo el próximo paso visible", () => {
  const route = readFileSync("app/api/admin/dispatch/local/route.ts", "utf8")
  assert.match(route, /requireOperator\(request\)/)
  // Transición, autorización del email y listado comparten el mismo WHERE.
  assert.match(route, /\.eq\("shipping_provider", LOCAL_DELIVERY_PROVIDER\)\s+\.eq\("financial_status", "payment_confirmed"\)\s+\.is\("cancelled_at", null\)\s+\.not\("paid_at", "is", null\)\s+\.gt\("payment_confirmed_amount", 0\)\s+\.in\("payment_status", CONFIRMED_PAYMENT_STATUSES\)/)
  assert.match(route, /\.eq\("estado", fromEstado\)\s+const \{ data, error \} = await whereLocalDeliveryEligible<typeof query>\(query\)/)
  assert.match(route, /async authorizeEmail\(orderId, expectedEstado\) \{\s+const query = admin\.from\("ordenes"\)\.select\("id"\)\.eq\("id", orderId\)\.eq\("estado", expectedEstado\)\s+const \{ data, error \} = await whereLocalDeliveryEligible<typeof query>\(query\)/)
  assert.equal(route.match(/whereLocalDeliveryEligible<typeof query>\(query\)/g)?.length, 3)
  assert.match(route, /action === "retry_effects"\s+\? await retryLocalDeliveryEffects\(deps, orderId\)\s+: await advanceLocalDelivery\(deps, orderId, action\)/)
  assert.match(route, /startPendingItemWarranties\(admin/)
  // Efectos append-only: nunca se borra una marca para representar un fallo.
  assert.doesNotMatch(route, /\.delete\(\)/)
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
