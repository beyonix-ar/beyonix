import assert from "node:assert/strict"
import test from "node:test"

import { retryPendingTransferVerifications } from "./transfer-verification-retry.ts"
import { TRANSFER_PAYMENT_EXPIRATION_HOURS } from "./transfer-expiration.ts"
import {
  AWAITING_TRANSFER_REASONS,
  RETRYABLE_MANUAL_REVIEW_REASONS,
  TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
} from "./transfer-auto-verification.ts"

function createFakeAdmin(rows: Array<Record<string, unknown>>) {
  return { from: () => {
    const predicates: Array<(row: Record<string, unknown>) => boolean> = []
    const compare = (key: string, value: unknown, op: (left: string, right: string) => boolean) => {
      predicates.push((row) => row[key] != null && op(String(row[key]), String(value)))
      return builder
    }
    const builder = {
      select: () => builder,
      eq: (key: string, value: unknown) => compare(key, value, (a, b) => a === b),
      neq: (key: string, value: unknown) => compare(key, value, (a, b) => a !== b),
      in: (key: string, values: readonly unknown[]) => {
        predicates.push((row) => values.includes(row[key]))
        return builder
      },
      or: () => {
        predicates.push((row) => {
          const reason = row.transfer_verification_failure_reason
          if (row.transfer_verification_status === "pending") {
            return reason == null
              ? Number(row.transfer_verification_attempts) > 0
              : typeof reason === "string" && (AWAITING_TRANSFER_REASONS as readonly string[]).includes(reason)
          }
          return row.transfer_verification_status === "manual_review" &&
            typeof reason === "string" && (RETRYABLE_MANUAL_REVIEW_REASONS as readonly string[]).includes(reason)
        })
        return builder
      },
      not: (key: string) => {
        predicates.push((row) => row[key] != null)
        return builder
      },
      lte: (key: string, value: unknown) => compare(key, value, (a, b) => a <= b),
      lt: (key: string, value: unknown) => compare(key, value, (a, b) =>
        key === "transfer_verification_attempts" ? Number(a) < Number(b) : a < b),
      gt: (key: string, value: unknown) => compare(key, value, (a, b) => a > b),
      order: () => builder,
      limit: (count: number) => Promise.resolve({
        data: rows.filter((row) => predicates.every((predicate) => predicate(row))).slice(0, count),
        error: null,
      }),
    }
    return builder
  } } as never
}

/** Captura los argumentos de cada llamada al query builder, para poder assertar el filtro SQL en sí (no sólo el resultado final). */
function createSpyAdmin(rows: Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const builder: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of ["select", "eq", "in", "or", "not", "neq", "lte", "lt", "gt", "gte", "order"]) {
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
    payment_method_id: "transferencia",
    estado: "pendiente",
    transfer_verification_status: "pending",
    transfer_verification_failure_reason: "no_candidates",
    transfer_verification_attempts: 1,
    transfer_last_verification_at: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    transfer_payer_first_name: "Jose",
    transfer_payer_last_name: "Perez",
    transfer_payer_dni: "30111222",
    transfer_amount_declared: 900,
    ...overrides,
  }
}

test("reintenta únicamente motivos que pueden cambiar con el tiempo (la transferencia todavía no aparece o MP falló)", async () => {
  const attempts: number[] = []
  const admin = createFakeAdmin([
    row({ id: 1, transfer_verification_failure_reason: "no_candidates" }),
    row({ id: 2, transfer_verification_status: "manual_review", transfer_verification_failure_reason: "dni_mismatch" }),
    row({ id: 3, transfer_verification_failure_reason: "mercadopago_unavailable" }),
    row({ id: 4, transfer_verification_failure_reason: "multiple_candidates" }),
    row({ id: 5, transfer_verification_failure_reason: "amount_mismatch_mp" }),
    row({ id: 6, transfer_verification_status: "manual_review", transfer_verification_failure_reason: "identification_unavailable" }),
    row({ id: 7, transfer_verification_status: "manual_review", transfer_verification_failure_reason: "confirmation_error" }),
  ])

  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      attempts.push(orderId)
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
    },
  })

  assert.deepEqual(attempts, [1, 2, 3, 5, 7])
  assert.equal(result.attempted, 5)
  assert.equal(result.verified, 0)
})

test("recupera pedidos trabados en 'pending' sin motivo tras un intento (error de confirmación anterior)", async () => {
  const attempts: number[] = []
  const admin = createFakeAdmin([
    row({ id: 10, transfer_verification_status: "pending", transfer_verification_failure_reason: null, transfer_verification_attempts: 3 }),
    row({ id: 11, transfer_verification_status: "pending", transfer_verification_failure_reason: "dni_mismatch" }),
    row({ id: 12, transfer_verification_status: "checking", transfer_verification_failure_reason: null }),
  ])

  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      attempts.push(orderId)
      return { status: "verified", order: {} as never }
    },
  })

  assert.deepEqual(attempts, [10], "sólo el pedido trabado sin motivo; nunca un 'checking' en curso")
  assert.equal(result.verified, 1)
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
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
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
        return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
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
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
    },
  })

  assert.equal(result.attempted, 2)
  assert.equal(result.verified, 1)
})

test("P1 starvation: la propia consulta SQL ya filtra por motivo reintentable -- no depende únicamente del filtro en JS, así que órdenes con motivo permanente nunca ocupan lugar en el batch", async () => {
  const { admin, calls } = createSpyAdmin([])

  await retryPendingTransferVerifications(admin, {
    attempt: async () => ({ status: "awaiting_transfer", reason: "no_candidates", order: {} as never }),
  })

  const candidateFilter = calls.find((c) => c.method === "or")
  assert.ok(candidateFilter, "debe filtrar estado y motivo en la propia consulta SQL")
  assert.equal(
    candidateFilter!.args[0],
    `and(transfer_verification_status.eq.pending,or(transfer_verification_failure_reason.in.(${AWAITING_TRANSFER_REASONS.join(",")}),and(transfer_verification_failure_reason.is.null,transfer_verification_attempts.gt.0))),` +
      `and(transfer_verification_status.eq.manual_review,transfer_verification_failure_reason.in.(${RETRYABLE_MANUAL_REVIEW_REASONS.join(",")}))`,
  )
  assert.equal(calls.some((c) => c.method === "eq" && c.args[0] === "transfer_verification_status"), false)
})

test("un pedido ya confirmado (o en conflicto de stock / cancelado) nunca entra al retry: filtro por estado del pago en la propia consulta SQL", async () => {
  const { admin, calls } = createSpyAdmin([])

  await retryPendingTransferVerifications(admin, {
    attempt: async () => ({ status: "manual_review", reason: "no_candidates", order: {} as never }),
  })

  const paymentFilter = calls.find((c) => c.method === "in" && c.args[0] === "payment_status")
  assert.deepEqual(paymentFilter?.args[1], ["pendiente_comprobante", "en_revision"], "excluye confirmado y auto_verified_stock_conflict")
  assert.ok(calls.some((c) => c.method === "neq" && c.args[0] === "estado" && c.args[1] === "cancelado"))
  assert.ok(calls.some((c) => c.method === "eq" && c.args[0] === "payment_method_id" && c.args[1] === "transferencia"))
})

test("P1 starvation (segunda auditoría): la consulta SQL también filtra intentos agotados y ventana vencida ANTES del LIMIT, no sólo el motivo", async () => {
  const { admin, calls } = createSpyAdmin([])

  await retryPendingTransferVerifications(admin, {
    attempt: async () => ({ status: "awaiting_transfer", reason: "no_candidates", order: {} as never }),
  })

  const attemptsFilter = calls.find(
    (c) => c.method === "lt" && c.args[0] === "transfer_verification_attempts",
  )
  assert.ok(attemptsFilter, "debe filtrar por transfer_verification_attempts en la propia consulta SQL")
  assert.equal(attemptsFilter!.args[1], TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS)

  const windowFilter = calls.find(
    (c) => c.method === "gt" && c.args[0] === "created_at",
  )
  assert.ok(windowFilter, "debe filtrar por ventana de conciliación vigente en la propia consulta SQL")
  assert.equal(typeof windowFilter!.args[1], "string")
})

test("P1 starvation (segunda auditoría): 25 órdenes con intentos agotados nunca ocupan el lugar de una orden nueva válida -- la válida SIEMPRE se procesa", async () => {
  const exhausted = Array.from({ length: 25 }, (_, i) =>
    row({ id: i + 1, transfer_verification_attempts: TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS }),
  )
  const validOrder = row({ id: 999, transfer_verification_attempts: 1 })
  const admin = createFakeAdmin([...exhausted, validOrder])

  const attempts: number[] = []
  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_admin, { orderId }) => {
      attempts.push(orderId)
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
    },
  })

  assert.deepEqual(attempts, [999], "la orden válida debe procesarse aunque venga después de 25 agotadas")
  assert.equal(result.attempted, 1)
})

test("el cron pasa al claim el intervalo de su tramo, además de filtrarlo antes del LIMIT", async () => {
  const admin = createFakeAdmin([row({ id: 10 })])
  const intervals: number[] = []
  await retryPendingTransferVerifications(admin, {
    attempt: async (_client, args) => {
      intervals.push(args.minIntervalSeconds ?? 0)
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
    },
  })
  assert.deepEqual(intervals, [13 * 60])
})

test("motivos terminales, no-due, cancelados y confirmados quedan fuera del LIMIT SQL", async () => {
  const now = Date.now()
  const blocked = Array.from({ length: 25 }, (_, index) => {
    const id = index + 1
    if (index % 4 === 0) return row({ id, transfer_verification_failure_reason: "multiple_candidates" })
    if (index % 4 === 1) return row({ id, transfer_last_verification_at: new Date(now - 60_000).toISOString() })
    if (index % 4 === 2) return row({ id, estado: "cancelado" })
    return row({ id, payment_status: "confirmado", transfer_verification_status: "auto_verified" })
  })
  const admin = createFakeAdmin([...blocked, row({ id: 999 })])
  const attempts: number[] = []
  const result = await retryPendingTransferVerifications(admin, {
    attempt: async (_client, { orderId }) => {
      attempts.push(orderId)
      return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
    },
  })
  assert.deepEqual(attempts, [999])
  assert.equal(result.attempted, 1)
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
        return { status: "awaiting_transfer", reason: "no_candidates", order: {} as never }
      },
    })

    assert.equal(attempts, 1)
    assert.equal(result.attempted, 1)
  } finally {
    Date.now = originalNow
  }
})
