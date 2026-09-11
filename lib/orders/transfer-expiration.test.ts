import assert from "node:assert/strict"
import test from "node:test"

import {
  expireOverdueTransferOrders,
  isTransferOrderExpiredWithoutProof,
} from "./transfer-expiration.ts"

// Investigación Gateway Timeout (2026-09-11): expireOverdueTransferOrders
// hacía `select("*")` sin `.limit()` sobre `ordenes` -- sin cota de filas ni
// columnas, a diferencia de su equivalente de Mercado Pago
// (expireAbandonedMercadoPagoOrders, que sí limita a 50). Esta función corre
// cada 15 min por cron Y en cada carga de GET /api/admin/pedidos: un payload
// creciente sin límite es un riesgo directo de latencia/timeout. Estos tests
// verifican la consulta real (columnas + límite), no una reimplementación.

test("isTransferOrderExpiredWithoutProof exige transferencia, sin comprobante, estado vencible y ventana cumplida", () => {
  const base = {
    created_at: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    payment_proof_url: null,
    payment_proof_uploaded_at: null,
  }

  assert.equal(isTransferOrderExpiredWithoutProof(base), true)
  assert.equal(isTransferOrderExpiredWithoutProof({ ...base, payment_method_id: "mercadopago" }), false)
  assert.equal(isTransferOrderExpiredWithoutProof({ ...base, estado: "cancelado" }), false)
  assert.equal(isTransferOrderExpiredWithoutProof({ ...base, payment_proof_url: "x.jpg" }), false)
  assert.equal(isTransferOrderExpiredWithoutProof({ ...base, payment_status: "confirmado" }), false)
  assert.equal(
    isTransferOrderExpiredWithoutProof({
      ...base,
      created_at: new Date().toISOString(),
    }),
    false,
    "todavía dentro de la ventana de 48hs",
  )
})

interface FakeOrderRow {
  id: number
  created_at: string
  estado: string
  payment_method_id: string
  payment_status: string
  payment_proof_url: string | null
  payment_proof_uploaded_at: string | null
  financial_status: string | null
}

function createFakeAdmin(seedOrders: FakeOrderRow[]) {
  const selectCalls: string[] = []
  const limitCalls: number[] = []
  const auditEvents: Array<Record<string, unknown>> = []

  function ordenesTable() {
    return {
      select(columns: string) {
        selectCalls.push(columns)
        const chain = {
          eq: () => chain,
          in: () => chain,
          is: () => chain,
          neq: () => chain,
          lte: () => chain,
          order: () => chain,
          limit(n: number) {
            limitCalls.push(n)
            return Promise.resolve({
              data: seedOrders.slice(0, n).map((row) => ({ ...row })),
              error: null,
            })
          },
        }
        return chain
      },
      update(payload: Record<string, unknown>) {
        const filters: Array<{ col: string; val: unknown }> = []
        const builder = {
          eq(col: string, val: unknown) {
            filters.push({ col, val })
            return builder
          },
          in: () => builder,
          is: () => builder,
          neq: () => builder,
          select() {
            return {
              async maybeSingle() {
                const row = seedOrders.find((candidate) =>
                  filters.every(
                    (filter) => (candidate as unknown as Record<string, unknown>)[filter.col] === filter.val,
                  ),
                )
                if (!row || row.estado === "cancelado") return { data: null, error: null }
                Object.assign(row, payload)
                return { data: { ...row }, error: null }
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

  return { admin, selectCalls, limitCalls, auditEvents }
}

test("la consulta pide sólo las columnas necesarias (nunca '*') y limita explícitamente las filas", async () => {
  const { admin, selectCalls, limitCalls } = createFakeAdmin([])

  await expireOverdueTransferOrders(admin as never)

  assert.equal(selectCalls.length, 1)
  assert.doesNotMatch(selectCalls[0], /\*/)
  for (const column of [
    "id",
    "created_at",
    "estado",
    "payment_method_id",
    "payment_status",
    "payment_proof_url",
    "payment_proof_uploaded_at",
  ]) {
    assert.match(selectCalls[0], new RegExp(`\\b${column}\\b`))
  }
  assert.deepEqual(limitCalls, [50])
})

test("expira los pedidos vencidos del lote y cuenta sólo los que efectivamente cambiaron", async () => {
  const overdueCreatedAt = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString()
  const { admin, auditEvents } = createFakeAdmin([
    {
      id: 1,
      created_at: overdueCreatedAt,
      estado: "pendiente",
      payment_method_id: "transferencia",
      payment_status: "pendiente_comprobante",
      payment_proof_url: null,
      payment_proof_uploaded_at: null,
      financial_status: "pending_payment",
    },
    {
      id: 2,
      created_at: overdueCreatedAt,
      estado: "pendiente",
      payment_method_id: "transferencia",
      payment_status: "pendiente_comprobante",
      payment_proof_url: null,
      payment_proof_uploaded_at: null,
      financial_status: "pending_payment",
    },
  ])

  const expired = await expireOverdueTransferOrders(admin as never)

  assert.equal(expired, 2)
  assert.equal(auditEvents.length, 2)
  assert.ok(auditEvents.every((event) => event.action === "order_auto_cancelled_payment_timeout"))
})

test("un error de carga (p. ej. Gateway Timeout) no revienta la ruta: se registra y devuelve 0", async () => {
  const admin = {
    from(table: string) {
      if (table !== "ordenes") throw new Error(`tabla inesperada en el mock: ${table}`)
      return {
        select() {
          const chain = {
            eq: () => chain,
            in: () => chain,
            is: () => chain,
            neq: () => chain,
            lte: () => chain,
            order: () => chain,
            limit: () => Promise.resolve({ data: null, error: { message: "Gateway Timeout" } }),
          }
          return chain
        },
      }
    },
  }

  const expired = await expireOverdueTransferOrders(admin as never)
  assert.equal(expired, 0)
})
