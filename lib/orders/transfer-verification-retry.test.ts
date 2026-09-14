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

/** Captura los argumentos de cada llamada al query builder, para poder assertar el filtro SQL en sí (no sólo el resultado final). */
function createSpyAdmin(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ["select", "eq", "in", "not", "neq", "lte", "order"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return builder
    }
  }
  builder.limit = () => Promise.resolve({ data: rows, error: null })
  return { admin: { from: () => builder } as never, calls }
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

test("P1 starvation: la propia consulta SQL ya filtra por motivo reintentable -- no depende únicamente del filtro en JS, así que órdenes con motivo permanente nunca ocupan lugar en el batch", async () => {
  const { admin, calls } = createSpyAdmin([])

  await retryPendingTransferVerifications(admin, {
    attempt: async () => ({ status: "manual_review", reason: "no_candidates", order: {} as never }),
  })

  const failureReasonFilter = calls.find(
    (c) => c.method === "in" && c.args[0] === "transfer_verification_failure_reason",
  )
  assert.ok(
    failureReasonFilter,
    "debe filtrar por transfer_verification_failure_reason en la propia consulta SQL",
  )
  assert.deepEqual(failureReasonFilter!.args[1], ["no_candidates", "mercadopago_unavailable"])
})

test("nunca corre más allá del presupuesto de tiempo por corrida -- corta antes de agotar todos los candidatos si toma demasiado (deja margen bajo el --max-time del curl del systemd timer)", async () => {
  const admin = createFakeAdmin([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })])
  const originalNow = Date.now
  let fakeNow = 0
  Date.now = () => fakeNow
  let attempts = 0

  try {
    const result = await retryPendingTransferVerifications(admin, {
      attempt: async () => {
        attempts += 1
        // El primer intento ya "tarda" más que el presupuesto -- el segundo
        // candidato nunca debería ni empezar a procesarse en esta corrida.
        fakeNow += 100_000
        return { status: "manual_review", reason: "no_candidates", order: {} as never }
      },
    })

    assert.equal(attempts, 1)
    assert.equal(result.attempted, 1)
  } finally {
    Date.now = originalNow
  }
})
