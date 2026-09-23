import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getMercadoPagoCheckoutAttemptDecision,
  getStaleMercadoPagoAttemptAction,
  type MercadoPagoCheckoutAttemptRow,
} from "./checkout-attempt.ts"
import { supersedeStaleMercadoPagoOrder, type SupersedableMercadoPagoOrder } from "./checkout-supersede.ts"
import { findMercadoPagoPaymentForOrder } from "./customer-credit-topups.ts"
import { isMercadoPagoPaymentForOrder } from "./order-payment.ts"

// Caso real (orden #3 / BX-1003, sólo lectura): la numeración de pedidos se
// reinició y Mercado Pago conserva un pago APROBADO del 27/08 con
// external_reference "3" de la orden #3 ANTERIOR. La orden #3 actual (23/09)
// nunca se pagó, pero la baja segura de intentos viejos buscaba pagos sólo
// por external_reference y respondía "Esta compra ya fue pagada".

const ORDER_FINGERPRINT = "179c8fe16dcbf359-current-order"
const NOW = new Date("2026-09-23T20:40:00.000Z")

function currentOrder(overrides: Partial<SupersedableMercadoPagoOrder> = {}): SupersedableMercadoPagoOrder {
  return {
    id: 3,
    created_at: "2026-09-23T20:34:10.542792+00:00",
    estado: "pendiente",
    financial_status: "pending_payment",
    payment_status: "preference_created",
    payment_method_id: "mercadopago",
    total: 9_900,
    external_amount_due: 9_900,
    mercadopago_checkout_fingerprint: ORDER_FINGERPRINT,
    mercadopago_preference_id: "pref-3",
    mercadopago_init_point: "https://mercadopago.example/checkout/3",
    mercadopago_preference_expires_at: "2026-09-23T21:04:11.003+00:00",
    mercadopago_preference_claimed_at: null,
    pricing_snapshot: { economicFingerprint: "checkout-economics:v2:old" },
    ...overrides,
  }
}

const foreignApprovedPayment = {
  id: 175947613530,
  status: "approved",
  external_reference: "3",
  transaction_amount: 1_000,
  date_created: "2026-08-27T18:49:49.000-04:00",
  metadata: { order_id: 3, checkout_fingerprint: "fingerprint-of-the-old-order-3" },
}

const ownApprovedPayment = {
  id: 999,
  status: "approved",
  external_reference: "3",
  transaction_amount: 9_900,
  date_created: "2026-09-23T20:36:00.000-00:00",
  metadata: { order_id: 3, checkout_fingerprint: ORDER_FINGERPRINT },
}

function decision(overrides: Partial<MercadoPagoCheckoutAttemptRow>) {
  return getMercadoPagoCheckoutAttemptDecision(currentOrder(overrides), NOW).kind
}

test("1-5. preference_created, pending sin pago, rejected, cancelled y superseded NUNCA son 'ya pagada'", () => {
  assert.equal(decision({}), "reuse")
  assert.notEqual(decision({ payment_status: "pending", mercadopago_init_point: null, mercadopago_preference_expires_at: null }), "already_paid")
  assert.equal(decision({ payment_status: "rejected", mercadopago_init_point: null, mercadopago_preference_expires_at: null }), "claim_preference")
  assert.equal(decision({ payment_status: "cancelled", mercadopago_init_point: null, mercadopago_preference_expires_at: null }), "claim_preference")
  assert.equal(
    decision({ estado: "cancelado", financial_status: "cancelled", payment_status: "checkout_superseded" }),
    "unavailable",
  )
  for (const payment_status of ["preference_created", "pending", "rejected", "cancelled", "checkout_superseded"]) {
    assert.notEqual(getStaleMercadoPagoAttemptAction(currentOrder({ payment_status }), NOW), "already_paid", payment_status)
  }
})

test("6-7. pago aprobado con evidencia canónica (orden pagada / payment_confirmed) SÍ bloquea", () => {
  const paid = { estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved" }
  assert.equal(decision(paid), "already_paid")
  assert.equal(getStaleMercadoPagoAttemptAction(currentOrder(paid), NOW), "already_paid")
  // Reintegro en curso de una orden ya cobrada: sigue siendo "pagada".
  assert.equal(decision({ estado: "cancelado", financial_status: "refund_pending", payment_status: "approved" }), "already_paid")
})

test("el pago de una orden anterior con el mismo número NO pertenece a la orden actual", () => {
  const order = currentOrder()
  assert.equal(isMercadoPagoPaymentForOrder(foreignApprovedPayment, order), false)
  // Cada chequeo por separado alcanza para descartarlo.
  assert.equal(isMercadoPagoPaymentForOrder({ ...foreignApprovedPayment, metadata: null }, order), false, "anterior a la orden")
  assert.equal(
    isMercadoPagoPaymentForOrder({ ...foreignApprovedPayment, date_created: ownApprovedPayment.date_created }, order),
    false,
    "huella de checkout distinta",
  )
  assert.equal(isMercadoPagoPaymentForOrder(ownApprovedPayment, order), true)
  assert.equal(isMercadoPagoPaymentForOrder({ ...ownApprovedPayment, external_reference: "4" }, order), false)
  // Orden sin huella (legado) y pago sin metadata: decide la fecha.
  assert.equal(isMercadoPagoPaymentForOrder({ ...ownApprovedPayment, metadata: null }, { ...order, mercadopago_checkout_fingerprint: null }), true)
})

async function withMercadoPagoSearch<T>(results: unknown[], run: () => Promise<T>) {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token"
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
    process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  }
}

test("8. la búsqueda por orden descarta el pago ajeno: la preferencia sin pago puede continuar", async () => {
  const found = await withMercadoPagoSearch([foreignApprovedPayment], () => findMercadoPagoPaymentForOrder(currentOrder()))
  assert.equal(found, null)

  const own = await withMercadoPagoSearch([foreignApprovedPayment, ownApprovedPayment], () =>
    findMercadoPagoPaymentForOrder(currentOrder()),
  )
  assert.equal(own?.id, ownApprovedPayment.id)
})

function fakeAdmin() {
  const chain: Record<string, unknown> = {}
  for (const method of ["eq", "in", "is", "or", "update", "insert", "select"]) chain[method] = () => chain
  chain.maybeSingle = () => Promise.resolve({ data: { id: 3 }, error: null })
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null })
  return { from: () => chain, rpc: () => Promise.resolve({ data: [], error: null }) } as never
}

test("9. cambio de precio + intento viejo: con sólo el pago ajeno se reemplaza, nunca 'ya pagada'", async () => {
  const result = await withMercadoPagoSearch([foreignApprovedPayment], () =>
    supersedeStaleMercadoPagoOrder(fakeAdmin(), currentOrder(), {
      dependencies: {
        expirePreference: async () => {},
        findPayment: (order) => findMercadoPagoPaymentForOrder(order),
      },
      currentEconomicFingerprint: "checkout-economics:v2:new-price",
      now: NOW,
    }),
  )
  assert.equal(result, "superseded")

  // Con un pago aprobado REAL de esta orden, la protección sigue intacta.
  const paid = await withMercadoPagoSearch([ownApprovedPayment], () =>
    supersedeStaleMercadoPagoOrder(fakeAdmin(), currentOrder(), {
      dependencies: {
        expirePreference: async () => {},
        findPayment: (order) => findMercadoPagoPaymentForOrder(order),
      },
      currentEconomicFingerprint: "checkout-economics:v2:new-price",
      now: NOW,
    }),
  )
  assert.equal(paid, "already_paid")
})

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

test("10. webhook: ignora pagos de otra orden y sigue bloqueando duplicados reales", () => {
  const webhook = readSource("../../app/api/mercadopago/webhook/route.ts")
  const guard = webhook.indexOf("if (!isMercadoPagoPaymentForOrder(payment, orderRow)) {")
  assert.ok(guard > 0)
  assert.ok(guard < webhook.indexOf("if (isMercadoPagoOrderAlreadyConfirmed(orderRow)) {"))
  assert.ok(guard < webhook.indexOf("processApprovedMercadoPagoOrderPayment("))
  assert.match(webhook, /"id, created_at, estado,[^"]*mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at"/)
  // El pago aprobado propio pasa la validación y una orden ya confirmada sigue
  // tratándose como duplicado.
  assert.equal(isMercadoPagoPaymentForOrder(ownApprovedPayment, currentOrder()), true)
  assert.equal(decision({ estado: "pagado", financial_status: "payment_confirmed", payment_status: "approved" }), "already_paid")
})

test("11. 'Esta compra ya fue pagada' sólo sale de evidencia real de pago de ESTA orden", () => {
  const route = readSource("../../app/api/mercadopago/create-preference/route.ts")
  const uses = [...route.matchAll(/ALREADY_PAID_MESSAGE/g)].length
  // Definición + intento idéntico ya pagado + orden pendiente ya pagada + baja
  // segura que encontró el pago aprobado propio.
  assert.equal(uses, 4)
  const supersede = readSource("./checkout-supersede.ts")
  assert.match(supersede, /findPayment: \(order\) => findMercadoPagoPaymentForOrder\(order\)/)
  assert.doesNotMatch(supersede, /findMercadoPagoPaymentByExternalReference/)
  const expiration = readSource("../orders/mercadopago-expiration.ts")
  assert.match(expiration, /findMercadoPagoPaymentForOrder\(order\)/)
  assert.doesNotMatch(expiration, /findMercadoPagoPaymentByExternalReference/)
})
