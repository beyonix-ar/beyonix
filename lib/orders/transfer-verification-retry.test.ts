import assert from "node:assert/strict"
import test from "node:test"

import { retryPendingTransferVerifications } from "./transfer-verification-retry.ts"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "./transfer-expiration.ts"

function createFakeAdmin(rows: Array<Record<string, unknown>>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    not: () => builder,
    neq: () => builder,
    lte: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return { from: () => builder } as never
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    created_at: new Date().toISOString(),
    payment_status: "pendiente_comprobante",
    transfer_verification_failure_reason: "no_candidates",
    transfer_payer_first_name: "Jose",
    transfer_payer_last_name: "Perez",
    transfer_payer_dni: "30111222",
    transfer_amount_declared: 900,
    ...overrides,
  }
}

test("reintenta únicamente motivos transitorios (no_candidates/mercadopago_unavailable)", async () => {
  const attempts: number[] = []
  const admin = createFakeAdmin([
    row({ id: 1, transfer_verification_failure_reason: "no_candidates" }),
    row({ id: 2, transfer_verification_failure_reason: "dni_mismatch" }),
    row({ id: 3, transfer_verification_failure_reason: "mercadopago_unavailable" }),
    row({ id: 4, transfer_verification_failure_reason: "multiple_candidates" }),
  ])

  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      attempts.push(orderId)
      return { status: "manual_review", reason: "no_candidates", order: {} as never }
    },
  })

  assert.deepEqual(attempts, [1, 3])
  assert.equal(result.attempted, 2)
  assert.equal(result.verified, 0)
})

test("nunca reintenta un pedido cuya ventana de conciliación ya venció (no reabre 48hs después)", async () => {
  const attempts: number[] = []
  const oldCreatedAt = new Date(
    Date.now() - (TRANSFER_PAYMENT_EXPIRATION_HOURS + 1) * 60 * 60 * 1000,
  ).toISOString()
  const admin = createFakeAdmin([row({ id: 5, created_at: oldCreatedAt })])

  await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      attempts.push(orderId)
      return { status: "manual_review", reason: "no_candidates", order: {} as never }
    },
  })

  assert.deepEqual(attempts, [])
})

test("nunca reintenta si faltan los datos declarados por el cliente (nunca inventa nombre/DNI/monto)", () => {
  return (async () => {
    const attempts: number[] = []
    const admin = createFakeAdmin([
      row({ id: 6, transfer_payer_dni: null }),
      row({ id: 7, transfer_amount_declared: null }),
    ])

    await retryPendingTransferVerifications(admin, {
      attempt: async (_admin, { orderId }) => {
        attempts.push(orderId)
        return { status: "manual_review", reason: "no_candidates", order: {} as never }
      },
    })

    assert.deepEqual(attempts, [])
  })()
})

test("cuenta correctamente los verificados dentro de la corrida", async () => {
  const admin = createFakeAdmin([row({ id: 8 }), row({ id: 9 })])

  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      if (orderId === 8) return { status: "verified", order: {} as never }
      return { status: "manual_review", reason: "no_candidates", order: {} as never }
    },
  })

  assert.equal(result.attempted, 2)
  assert.equal(result.verified, 1)
})
