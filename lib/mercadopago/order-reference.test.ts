import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { supersedeStaleMercadoPagoOrder, type SupersedableMercadoPagoOrder } from "./checkout-supersede.ts"
import {
  findMercadoPagoPaymentByExternalReference,
  findMercadoPagoPaymentForOrder,
} from "./customer-credit-topups.ts"
import { isMercadoPagoPaymentForOrder } from "./order-payment.ts"
import { refundMercadoPagoOrderPayment } from "./order-refund.ts"
import {
  ensureMercadoPagoOrderReference,
  getMercadoPagoOrderExternalReference,
  getMercadoPagoOrderPaymentSearchReferences,
  matchMercadoPagoOrderExternalReference,
  parseMercadoPagoExternalReference,
} from "./order-reference.ts"

// external_reference de Mercado Pago = order:<uuid> (ordenes.mercadopago_reference)
// para órdenes nuevas; la referencia numérica (ordenes.id, reutilizable) queda
// sólo como camino legado.

const NEW_REFERENCE = "6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60"
const ASSIGNED_REFERENCE = "0a9b8c7d-6e5f-4a3b-8c1d-2e3f4a5b6c7d"
const FINGERPRINT = "mercadopago-checkout:v2:current"
const ORDER_CREATED_AT = "2026-09-23T20:34:10.000Z"
const AFTER_ORDER = "2026-09-23T20:40:00.000Z"
const BEFORE_ORDER = "2026-08-27T18:49:49.000Z"

function newOrder(overrides: Partial<SupersedableMercadoPagoOrder> = {}): SupersedableMercadoPagoOrder {
  return {
    id: 3,
    created_at: ORDER_CREATED_AT,
    estado: "pendiente",
    financial_status: "pending_payment",
    payment_status: "preference_created",
    payment_method_id: "mercadopago",
    total: 9_900,
    external_amount_due: 9_900,
    mercadopago_checkout_fingerprint: FINGERPRINT,
    mercadopago_reference: NEW_REFERENCE,
    mercadopago_reference_assigned_at: null,
    mercadopago_preference_id: "pref-3",
    mercadopago_init_point: "https://mercadopago.example/checkout/3",
    mercadopago_preference_expires_at: "2026-09-23T21:04:11.000Z",
    mercadopago_preference_claimed_at: null,
    pricing_snapshot: { economicFingerprint: "checkout-economics:v2:old" },
    ...overrides,
  }
}

function legacyOrder(overrides: Partial<SupersedableMercadoPagoOrder> = {}) {
  return newOrder({ mercadopago_reference: null, mercadopago_reference_assigned_at: null, ...overrides })
}

function legacyOrderWithAssignedReference(overrides: Partial<SupersedableMercadoPagoOrder> = {}) {
  return newOrder({
    mercadopago_reference: ASSIGNED_REFERENCE,
    mercadopago_reference_assigned_at: "2026-09-23T20:38:00.000Z",
    ...overrides,
  })
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 1001,
    status: "approved",
    external_reference: `order:${NEW_REFERENCE}`,
    transaction_amount: 9_900,
    currency_id: "ARS",
    date_created: AFTER_ORDER,
    metadata: { order_id: 3, order_reference: NEW_REFERENCE, checkout_fingerprint: FINGERPRINT },
    ...overrides,
  }
}

const oldNumericPayment = payment({
  id: 175947613530,
  external_reference: "3",
  date_created: BEFORE_ORDER,
  metadata: { order_id: 3, checkout_fingerprint: "fingerprint-of-the-old-order-3" },
})

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

async function withMercadoPagoSearch<T>(
  resultsByReference: Record<string, unknown[]>,
  run: (searchedReferences: string[]) => Promise<T>,
) {
  const originalFetch = globalThis.fetch
  const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
  const searchedReferences: string[] = []
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-token"
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const reference = url.searchParams.get("external_reference") ?? ""
    searchedReferences.push(reference)
    return new Response(JSON.stringify({ results: resultsByReference[reference] ?? [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
  try {
    return await run(searchedReferences)
  } finally {
    globalThis.fetch = originalFetch
    if (originalToken === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN
    else process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  }
}

test("1. migración: UUID por default sólo para órdenes nuevas, único, inmutable y sin backfill", () => {
  const migration = readSource("../../supabase/migrations/20260924120000_ordenes_mercadopago_reference.sql")
  assert.match(migration, /add column if not exists mercadopago_reference uuid,/)
  // El default se define DESPUÉS de agregar la columna: las filas existentes
  // quedan en NULL (legado) y las nuevas reciben UUID.
  assert.ok(
    migration.indexOf("add column if not exists mercadopago_reference uuid") <
      migration.indexOf("alter column mercadopago_reference set default gen_random_uuid()"),
  )
  assert.match(migration, /create unique index if not exists ordenes_mercadopago_reference_unique\s+on public\.ordenes \(mercadopago_reference\)/)
  assert.match(migration, /before update of mercadopago_reference, mercadopago_reference_assigned_at/)
  assert.doesNotMatch(migration, /update public\.ordenes/i)
  assert.doesNotMatch(migration, /\bnot null default gen_random_uuid/i)
})

test("2. la referencia de una orden nueva es order:<uuid>; la legada, su id numérico", async () => {
  assert.equal(getMercadoPagoOrderExternalReference(newOrder()), `order:${NEW_REFERENCE}`)
  assert.equal(
    getMercadoPagoOrderExternalReference(newOrder({ mercadopago_reference: NEW_REFERENCE.toUpperCase() })),
    `order:${NEW_REFERENCE}`,
  )
  assert.equal(getMercadoPagoOrderExternalReference(legacyOrder()), "3")

  // Una orden nueva ya trae el UUID: no se toca la base.
  const admin = { from: () => assert.fail("no debe consultar la base") } as never
  assert.equal((await ensureMercadoPagoOrderReference(admin, newOrder())).mercadopago_reference, NEW_REFERENCE)

  const route = readSource("../../app/api/mercadopago/create-preference/route.ts")
  assert.match(route, /const orderReference = await ensureMercadoPagoOrderReference\(admin, order\)/)
  assert.match(route, /const externalReference = getMercadoPagoOrderExternalReference\(orderReference\)/)
  assert.match(route, /external_reference: externalReference,/)
  assert.doesNotMatch(route, /external_reference: String\(order\.id\)/)
  assert.match(
    route,
    /flow: "checkout_order",\n\s+order_id: order\.id,\n\s+order_reference: orderReference\.mercadopago_reference,\n\s+checkout_fingerprint: checkoutFingerprint,/,
  )
  assert.match(route, /idempotencyKey: `beyonix-order-\$\{orderReference\.mercadopago_reference\}-preference-/)
})

test("3. webhook: order:<uuid> resuelve la orden por mercadopago_reference", () => {
  assert.deepEqual(parseMercadoPagoExternalReference(`order:${NEW_REFERENCE}`), {
    kind: "order",
    reference: NEW_REFERENCE,
  })
  assert.deepEqual(parseMercadoPagoExternalReference("order:no-es-un-uuid"), { kind: "invalid" })
  assert.deepEqual(parseMercadoPagoExternalReference(""), { kind: "invalid" })
  assert.deepEqual(parseMercadoPagoExternalReference("3.5"), { kind: "invalid" })

  assert.equal(isMercadoPagoPaymentForOrder(payment(), newOrder()), true)
  assert.equal(
    isMercadoPagoPaymentForOrder(payment({ external_reference: `order:${ASSIGNED_REFERENCE}` }), newOrder()),
    false,
  )

  const webhook = readSource("../../app/api/mercadopago/webhook/route.ts")
  assert.match(webhook, /const externalReference = parseMercadoPagoExternalReference\(payment\.external_reference\)/)
  assert.match(webhook, /orderQuery\.eq\("mercadopago_reference", externalReference\.reference\)/)
  assert.match(webhook, /orderQuery\.eq\("id", externalReference\.orderId\)/)
  assert.match(webhook, /mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at"/)
  assert.match(webhook, /const orderId = orderRow\.id/)
  assert.doesNotMatch(webhook, /Number\(payment\.external_reference\)/)
  // La pertenencia se valida antes de cualquier efecto financiero.
  const guard = webhook.indexOf("if (!isMercadoPagoPaymentForOrder(payment, orderRow)) {")
  assert.ok(guard > 0 && guard < webhook.indexOf("processApprovedMercadoPagoOrderPayment("))
})

test("4. un pago numérico viejo NO puede pegarse a una orden nueva con UUID", () => {
  const order = newOrder()
  assert.equal(matchMercadoPagoOrderExternalReference("3", order), null)
  assert.equal(isMercadoPagoPaymentForOrder(oldNumericPayment, order), false)
  // Ni siquiera con la misma huella y fecha posterior: sólo order:<uuid>.
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "3" }), order), false)
  assert.deepEqual(getMercadoPagoOrderPaymentSearchReferences(order), [`order:${NEW_REFERENCE}`])
})

test("5 y 14. orden legada: su referencia numérica sigue resolviendo (preferencias emitidas antes del deploy)", () => {
  const order = legacyOrder()
  assert.deepEqual(parseMercadoPagoExternalReference("3"), { kind: "legacy_order", orderId: 3 })
  assert.equal(matchMercadoPagoOrderExternalReference("3", order), "legacy_numeric")
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "3" }), order), true)
  // Pago legado sin metadata ni huella en la orden: decide la fecha.
  assert.equal(
    isMercadoPagoPaymentForOrder(
      payment({ external_reference: "3", metadata: null }),
      legacyOrder({ mercadopago_checkout_fingerprint: null }),
    ),
    true,
  )
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "4" }), order), false)
  // Una orden sin UUID nunca acepta un order:<uuid>.
  assert.equal(isMercadoPagoPaymentForOrder(payment(), order), false)
  assert.deepEqual(getMercadoPagoOrderPaymentSearchReferences(order), ["3"])
})

test("6. la huella de checkout se sigue validando", () => {
  const foreign = { metadata: { checkout_fingerprint: "otra-huella" } }
  assert.equal(isMercadoPagoPaymentForOrder(payment(foreign), newOrder()), false)
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "3", ...foreign }), legacyOrder()), false)
})

test("7. la fecha se sigue validando", () => {
  assert.equal(isMercadoPagoPaymentForOrder(payment({ date_created: BEFORE_ORDER }), newOrder()), false)
  assert.equal(
    isMercadoPagoPaymentForOrder(payment({ external_reference: "3", date_created: BEFORE_ORDER }), legacyOrder()),
    false,
  )
})

function fakeSupersedeAdmin() {
  const chain: Record<string, unknown> = {}
  for (const method of ["eq", "in", "is", "or", "update", "insert", "select"]) chain[method] = () => chain
  chain.maybeSingle = () => Promise.resolve({ data: { id: 3 }, error: null })
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null })
  return { from: () => chain, rpc: () => Promise.resolve({ data: [], error: null }) } as never
}

test("8. la baja segura busca pagos por order:<uuid> y sigue frenando con un pago propio aprobado", async () => {
  const run = (results: Record<string, unknown[]>) =>
    withMercadoPagoSearch(results, async (searched) => ({
      searched,
      result: await supersedeStaleMercadoPagoOrder(fakeSupersedeAdmin(), newOrder(), {
        dependencies: {
          expirePreference: async () => {},
          findPayment: (order) => findMercadoPagoPaymentForOrder(order),
        },
        currentEconomicFingerprint: "checkout-economics:v2:new-price",
        now: new Date(AFTER_ORDER),
      }),
    }))

  const withoutPayment = await run({ "3": [oldNumericPayment] })
  assert.deepEqual(withoutPayment.searched, [`order:${NEW_REFERENCE}`])
  assert.equal(withoutPayment.result, "superseded")

  const paid = await run({ [`order:${NEW_REFERENCE}`]: [payment()] })
  assert.equal(paid.result, "already_paid")

  const supersede = readSource("./checkout-supersede.ts")
  assert.match(supersede, /findPayment: \(order\) => findMercadoPagoPaymentForOrder\(order\)/)
})

test("9. el cron de expiración busca por order:<uuid>", async () => {
  const expiration = readSource("../orders/mercadopago-expiration.ts")
  assert.match(expiration, /findMercadoPagoPaymentForOrder\(order\)/)
  assert.match(expiration, /mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at,/)

  const cronOrder = {
    id: 3,
    created_at: ORDER_CREATED_AT,
    mercadopago_checkout_fingerprint: FINGERPRINT,
    mercadopago_reference: NEW_REFERENCE,
    mercadopago_reference_assigned_at: null,
  }
  const found = await withMercadoPagoSearch(
    { [`order:${NEW_REFERENCE}`]: [payment()], "3": [oldNumericPayment] },
    async (searched) => ({ searched, payment: await findMercadoPagoPaymentForOrder(cronOrder) }),
  )
  assert.deepEqual(found.searched, [`order:${NEW_REFERENCE}`])
  assert.equal(found.payment?.id, 1001)

  for (const path of ["../../app/api/mercadopago/create-preference/route.ts", "../../app/api/transferencia/create-order/route.ts"]) {
    assert.match(readSource(path), /mercadopago_checkout_fingerprint, mercadopago_reference, mercadopago_reference_assigned_at,/)
  }
})

function fakeRefundAdmin() {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []
  const admin = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      if (name === "begin_mercadopago_order_refund") {
        return {
          data: [
            {
              refund_id: "attempt-1",
              payment_id: "1001",
              amount: 9_900,
              idempotency_key: "mercadopago-order-refund:attempt-1",
              status: "processing",
              should_call_mp: true,
              mp_refund_id: null,
            },
          ],
          error: null,
        }
      }
      return { data: {}, error: null }
    },
  }
  return { admin: admin as never, rpcCalls }
}

async function refundWith(order: SupersedableMercadoPagoOrder | null, externalReference: string) {
  const { admin, rpcCalls } = fakeRefundAdmin()
  let refundCalls = 0
  const result = await refundMercadoPagoOrderPayment(
    admin,
    { orderId: 3, adminId: "admin-1" },
    {
      getOrderReference: async () => order,
      getPayment: async () =>
        ({ ...payment({ external_reference: externalReference }), transaction_amount_refunded: 0 }) as never,
      createRefund: async () => {
        refundCalls += 1
        return { kind: "confirmed", refund: { id: 555, payment_id: 1001, amount: 9_900 } }
      },
    },
  )
  return { result, refundCalls, rpcCalls }
}

test("10. reintegro de orden nueva: acepta order:<uuid>", async () => {
  const { result, refundCalls } = await refundWith(newOrder(), `order:${NEW_REFERENCE}`)
  assert.deepEqual(result, { kind: "confirmed", mpRefundId: "555", amount: 9_900 })
  assert.equal(refundCalls, 1)
})

test("11. reintegro de orden nueva: rechaza la referencia numérica vieja sin contactar el refund", async () => {
  const numeric = await refundWith(newOrder(), "3")
  assert.deepEqual(numeric.result, { kind: "validation_failed", reason: "EXTERNAL_REFERENCE_MISMATCH" })
  assert.equal(numeric.refundCalls, 0)

  const otherOrder = await refundWith(newOrder(), `order:${ASSIGNED_REFERENCE}`)
  assert.deepEqual(otherOrder.result, { kind: "validation_failed", reason: "EXTERNAL_REFERENCE_MISMATCH" })

  const missing = await refundWith(null, `order:${NEW_REFERENCE}`)
  assert.deepEqual(missing.result, { kind: "validation_failed", reason: "ORDER_NOT_FOUND" })
  assert.equal(missing.refundCalls, 0)
})

test("12. reintegro de orden legada: acepta su referencia numérica correcta", async () => {
  const legacy = await refundWith(legacyOrder(), "3")
  assert.equal(legacy.result.kind, "confirmed")
  const wrong = await refundWith(legacyOrder(), "4")
  assert.deepEqual(wrong.result, { kind: "validation_failed", reason: "EXTERNAL_REFERENCE_MISMATCH" })
  // Legada con UUID asignado post-deploy: el pago persistido pudo ser numérico o UUID.
  assert.equal((await refundWith(legacyOrderWithAssignedReference(), "3")).result.kind, "confirmed")
  assert.equal(
    (await refundWith(legacyOrderWithAssignedReference(), `order:${ASSIGNED_REFERENCE}`)).result.kind,
    "confirmed",
  )
})

test("13. credit-topup sigue intacto", async () => {
  assert.deepEqual(parseMercadoPagoExternalReference("credit-topup:1b2c3d4e-0000-4000-8000-000000000000"), {
    kind: "credit_topup",
  })
  const webhook = readSource("../../app/api/mercadopago/webhook/route.ts")
  assert.match(
    webhook,
    /if \(externalReference\.kind === "credit_topup"\) \{\n\s+const result = await processCustomerCreditTopupPayment\(payment\)/,
  )
  assert.ok(
    webhook.indexOf('externalReference.kind === "credit_topup"') < webhook.indexOf('.from("ordenes")'),
  )

  const topupReference = "credit-topup:1b2c3d4e-0000-4000-8000-000000000000"
  const found = await withMercadoPagoSearch(
    { [topupReference]: [payment({ id: 77, external_reference: topupReference })] },
    async (searched) => ({ searched, payment: await findMercadoPagoPaymentByExternalReference(topupReference) }),
  )
  assert.deepEqual(found.searched, [topupReference])
  assert.equal(found.payment?.id, 77)
})

function fakeAssignAdmin({ winner }: { winner: { mercadopago_reference: string; mercadopago_reference_assigned_at: string } | null }) {
  const updates: Array<Record<string, unknown>> = []
  const filters: Array<[string, unknown]> = []
  const admin = {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        updates.push(payload)
        const chain = {
          eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
          is: (column: string, value: unknown) => (filters.push([column, value]), chain),
          select: () => chain,
          maybeSingle: async () => ({
            data: winner ? null : { id: 3, ...payload },
            error: null,
          }),
        }
        return chain
      },
      select: () => {
        const chain = {
          eq: () => chain,
          maybeSingle: async () => ({ data: { id: 3, ...winner }, error: null }),
        }
        return chain
      },
    }),
  }
  return { admin: admin as never, updates, filters }
}

test("15. orden legada que emite una preferencia post-deploy: recibe UUID sin ambigüedad", async () => {
  const now = new Date("2026-09-23T20:38:00.000Z")
  const { admin, updates, filters } = fakeAssignAdmin({ winner: null })
  const assigned = await ensureMercadoPagoOrderReference(admin, legacyOrder(), now)

  // UPDATE condicional: sólo si todavía no tiene UUID.
  assert.deepEqual(filters, [["id", 3], ["mercadopago_reference", null]])
  assert.equal(updates.length, 1)
  assert.equal(assigned.mercadopago_reference_assigned_at, now.toISOString())
  assert.match(getMercadoPagoOrderExternalReference(assigned), /^order:[0-9a-f-]{36}$/)

  const order = { ...legacyOrder(), ...assigned }
  // Pagos nuevos: order:<uuid>.
  assert.equal(
    isMercadoPagoPaymentForOrder(payment({ external_reference: getMercadoPagoOrderExternalReference(assigned) }), order),
    true,
  )
  // Pago sobre la preferencia numérica emitida antes del deploy: sólo con su huella.
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "3" }), order), true)
  assert.equal(
    isMercadoPagoPaymentForOrder(payment({ external_reference: "3", metadata: { checkout_fingerprint: "otra" } }), order),
    false,
  )
  assert.equal(isMercadoPagoPaymentForOrder(payment({ external_reference: "3", metadata: null }), order), false)
  assert.equal(
    isMercadoPagoPaymentForOrder(payment({ external_reference: "3" }), { ...order, mercadopago_checkout_fingerprint: null }),
    false,
  )
  assert.equal(isMercadoPagoPaymentForOrder(oldNumericPayment, order), false)
  assert.deepEqual(getMercadoPagoOrderPaymentSearchReferences(order), [
    getMercadoPagoOrderExternalReference(assigned),
    "3",
  ])

  // Carrera: otro request ya le asignó UUID -> se usa el persistido, nunca uno nuevo.
  const race = fakeAssignAdmin({
    winner: { mercadopago_reference: ASSIGNED_REFERENCE, mercadopago_reference_assigned_at: "2026-09-23T20:37:59.000Z" },
  })
  const raced = await ensureMercadoPagoOrderReference(race.admin, legacyOrder(), now)
  assert.equal(raced.mercadopago_reference, ASSIGNED_REFERENCE)
  assert.equal(getMercadoPagoOrderExternalReference(raced), `order:${ASSIGNED_REFERENCE}`)
})
