import assert from "node:assert/strict"
import test from "node:test"

import { expireAbandonedMercadoPagoOrders } from "./mercadopago-expiration.ts"

// Hardening final Andreani Parte 4/4: expireAbandonedMercadoPagoOrders es el
// único de los 4 caminos de cancelación que nunca pasó por las RPCs
// guardadas (admin_cancel_order / approve_order_claim_cancellation /
// request_customer_order_cancellation_with_claim) -- dependía sólo de que
// financial_status='pending_payment' y andreani_creation_status en curso
// fueran mutuamente excluyentes en la práctica. Estos tests ejercitan la
// función real (no una reimplementación) contra un mock de admin + un fetch
// de Mercado Pago simulado, sin red real ni credenciales.

const originalToken = process.env.MERCADOPAGO_ACCESS_TOKEN
const originalFetch = globalThis.fetch

test.before(() => {
  process.env.MERCADOPAGO_ACCESS_TOKEN = "TEST-secret-token-never-logged"
})
test.after(() => {
  if (originalToken === undefined) delete process.env.MERCADOPAGO_ACCESS_TOKEN
  else process.env.MERCADOPAGO_ACCESS_TOKEN = originalToken
  globalThis.fetch = originalFetch
})

// Ningún pedido de estos tests tiene rastro real en Mercado Pago -- el
// checkout fue abandonado antes de pagar.
function stubNoMercadoPagoPaymentFound() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch
}

interface FakeOrderRow {
  id: number
  estado: string
  payment_status: string | null
  financial_status: string | null
  credit_balance_used: number | null
  mercadopago_preference_expires_at: string
  andreani_creation_status: string | null
  andreani_envio_id: string | null
}

function createFakeAdmin(seedOrders: FakeOrderRow[]) {
  const auditEvents: Array<Record<string, unknown>> = []

  function ordenesTable() {
    return {
      select() {
        const chain = {
          eq: () => chain,
          lte: () => chain,
          order: () => chain,
          limit: (n: number) =>
            Promise.resolve({ data: seedOrders.slice(0, n).map((row) => ({ ...row })), error: null }),
        }
        return chain
      },
      update(payload: Record<string, unknown>) {
        const eqFilters: Array<{ col: string; val: unknown }> = []
        let orFilterRaw: string | null = null
        const builder = {
          eq(col: string, val: unknown) {
            eqFilters.push({ col, val })
            return builder
          },
          lte: () => builder,
          or(raw: string) {
            orFilterRaw = raw
            return builder
          },
          select() {
            return {
              async maybeSingle() {
                const matchesOr = (row: FakeOrderRow) => {
                  if (!orFilterRaw) return true
                  return orFilterRaw.split(",").some((clause) => {
                    const [col, op, val] = clause.split(".")
                    const actual = (row as unknown as Record<string, unknown>)[col]
                    if (op === "is" && val === "null") return actual === null || actual === undefined
                    if (op === "eq") return actual === val
                    return false
                  })
                }

                const row = seedOrders.find(
                  (candidate) =>
                    eqFilters.every(
                      (filter) =>
                        (candidate as unknown as Record<string, unknown>)[filter.col] === filter.val,
                    ) && matchesOr(candidate),
                )
                if (!row) return { data: null, error: null }
                Object.assign(row, payload)
                return { data: { id: row.id }, error: null }
              },
            }
          },
        }
        return builder
      },
    }
  }

  const admin = {
    from(table: string) {
      if (table === "ordenes") return ordenesTable()
      if (table === "order_audit_events") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            auditEvents.push(payload)
            return { error: null }
          },
        }
      }
      throw new Error(`tabla inesperada en el mock: ${table}`)
    },
  }

  return { admin, auditEvents, seedOrders }
}

function baseOrder(overrides: Partial<FakeOrderRow> & { id: number }): FakeOrderRow {
  return {
    estado: "pendiente",
    payment_status: "pendiente_comprobante",
    financial_status: "pending_payment",
    credit_balance_used: 0,
    mercadopago_preference_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    andreani_creation_status: null,
    andreani_envio_id: null,
    ...overrides,
  }
}

test("1. pending_payment normal vencido se cancela (comportamiento existente intacto)", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders, auditEvents } = createFakeAdmin([baseOrder({ id: 1 })])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 1)
  assert.equal(seedOrders[0].estado, "cancelado")
  assert.equal(auditEvents.length, 1)
})

test("2. andreani_creation_status='claimed' NUNCA se cancela", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders, auditEvents } = createFakeAdmin([
    baseOrder({ id: 2, andreani_creation_status: "claimed" }),
  ])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 0)
  assert.equal(seedOrders[0].estado, "pendiente")
  assert.equal(auditEvents.length, 0)
})

test("3. andreani_creation_status='reconciliation_required' NUNCA se cancela", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders } = createFakeAdmin([
    baseOrder({ id: 3, andreani_creation_status: "reconciliation_required" }),
  ])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 0)
  assert.equal(seedOrders[0].estado, "pendiente")
})

test("4. andreani_creation_status='created' NUNCA se cancela", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders } = createFakeAdmin([
    baseOrder({ id: 4, andreani_creation_status: "created", andreani_envio_id: "ENV-1" }),
  ])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 0)
  assert.equal(seedOrders[0].estado, "pendiente")
})

test("5. un envío Andreani ya persistido (andreani_envio_id) NUNCA se cancela, aunque andreani_creation_status sea nulo/histórico", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders } = createFakeAdmin([
    baseOrder({ id: 5, andreani_creation_status: null, andreani_envio_id: "ENV-HISTORICO" }),
  ])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 0)
  assert.equal(seedOrders[0].estado, "pendiente")
})

test("defensa en profundidad: el UPDATE final re-chequea andreani_creation_status por si cambió entre el SELECT y el UPDATE", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders } = createFakeAdmin([baseOrder({ id: 6 })])

  // Simula que, justo después del SELECT (que vio andreani_creation_status
  // en null), otro proceso reclamó la creación del envío -- el CAS del
  // UPDATE debe impedir la cancelación igual.
  seedOrders[0].andreani_creation_status = "claimed"

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 0)
  assert.equal(seedOrders[0].estado, "pendiente")
})

test("un lote mixto sólo cancela los pedidos realmente abandonados, deja intactos los que tienen Andreani en curso", async () => {
  stubNoMercadoPagoPaymentFound()
  const { admin, seedOrders } = createFakeAdmin([
    baseOrder({ id: 10 }),
    baseOrder({ id: 11, andreani_creation_status: "claimed" }),
    baseOrder({ id: 12 }),
    baseOrder({ id: 13, andreani_creation_status: "reconciliation_required" }),
  ])

  const expired = await expireAbandonedMercadoPagoOrders(admin as never)

  assert.equal(expired, 2)
  assert.equal(seedOrders.find((o) => o.id === 10)!.estado, "cancelado")
  assert.equal(seedOrders.find((o) => o.id === 11)!.estado, "pendiente")
  assert.equal(seedOrders.find((o) => o.id === 12)!.estado, "cancelado")
  assert.equal(seedOrders.find((o) => o.id === 13)!.estado, "pendiente")
})
