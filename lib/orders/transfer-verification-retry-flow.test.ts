import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { attemptTransferAutoVerification } from "./transfer-verification-service.ts"
import { retryPendingTransferVerifications } from "./transfer-verification-retry.ts"
import {
  AWAITING_TRANSFER_REASONS,
  RETRYABLE_MANUAL_REVIEW_REASONS,
  TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS,
  TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS,
  TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
  TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS,
} from "./transfer-auto-verification.ts"
import type { MercadoPagoBankTransferCandidate } from "../mercadopago/bank-transfer-search.ts"

// Regresión del caso real: "verificar sin haber transferido -> transferir ->
// verificar de nuevo". Corre el servicio real (attemptTransferAutoVerification
// y el cron retryPendingTransferVerifications) contra PostgreSQL real
// (PGlite) con las migraciones reales de claim/confirm -- intentos, lease,
// rate limit, estados y claims de payment.id son los de producción. Sólo
// Mercado Pago está simulado (una lista mutable de transferencias que
// "aparecen" entre un intento y otro) y el paso del tiempo se simula
// corriendo transfer_last_verification_at hacia atrás.

const migrationFiles = [
  "20260913120000_transfer_auto_verification.sql",
  "20260914090000_transfer_auto_verification_amount_lock_and_stock_claim.sql",
  "20260914100000_transfer_verification_lease_and_payment_claims.sql",
]

const schema = readFileSync(
  new URL("./fixtures/transfer-verification-schema.sql", import.meta.url),
  "utf8",
)
const migrations = migrationFiles.map((file) =>
  readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), "utf8"),
)

type Row = Record<string, unknown>
type Filter = { sql: string; values: unknown[] }

/**
 * Adaptador mínimo del subconjunto de supabase-js que usan el servicio y el
 * cron (rpc, select/update + eq/neq/in/lt/lte/gte/not-is-null, order, limit,
 * maybeSingle), traducido a SQL parametrizado sobre PGlite.
 */
function createPgliteAdmin(db: PGlite) {
  function from(table: string) {
    let mode: "select" | "update" = "select"
    let columns = "*"
    let updateValues: Row = {}
    const filters: Filter[] = []
    let orderBy = ""
    let limitCount: number | null = null

    const addFilter = (column: string, op: string, value: unknown) => {
      filters.push({ sql: `${column} ${op} $?`, values: [value] })
    }

    async function execute(single: boolean) {
      const values: unknown[] = []
      const bind = (sql: string, filterValues: unknown[]) =>
        filterValues.reduce<string>((acc, value) => {
          values.push(value)
          return acc.replace("$?", `$${values.length}`)
        }, sql)

      let sql: string
      if (mode === "update") {
        const sets = Object.entries(updateValues).map(([column, value]) => {
          values.push(value)
          return `${column} = $${values.length}`
        })
        sql = `update ${table} set ${sets.join(", ")}`
      } else {
        sql = `select ${columns} from ${table}`
      }
      const where = filters.map((filter) => bind(filter.sql, filter.values))
      if (where.length) sql += ` where ${where.join(" and ")}`
      if (mode === "update") sql += " returning *"
      if (orderBy) sql += ` order by ${orderBy}`
      if (limitCount !== null) sql += ` limit ${limitCount}`

      try {
        const result = await db.query<Row>(sql, values)
        return { data: single ? (result.rows[0] ?? null) : result.rows, error: null }
      } catch (error) {
        return { data: null, error: { message: (error as Error).message } }
      }
    }

    const builder = {
      select(selected?: string) {
        if (mode === "select" && selected) columns = selected
        return builder
      },
      update(values: Row) {
        mode = "update"
        updateValues = values
        return builder
      },
      eq(column: string, value: unknown) {
        addFilter(column, "=", value)
        return builder
      },
      neq(column: string, value: unknown) {
        addFilter(column, "<>", value)
        return builder
      },
      lt(column: string, value: unknown) {
        addFilter(column, "<", value)
        return builder
      },
      gt(column: string, value: unknown) {
        addFilter(column, ">", value)
        return builder
      },
      lte(column: string, value: unknown) {
        addFilter(column, "<=", value)
        return builder
      },
      gte(column: string, value: unknown) {
        addFilter(column, ">=", value)
        return builder
      },
      in(column: string, list: readonly unknown[]) {
        filters.push({ sql: `${column} = any($?)`, values: [[...list]] })
        return builder
      },
      or(expression: string) {
        assert.equal(expression,
          `and(transfer_verification_status.eq.pending,or(transfer_verification_failure_reason.in.(${AWAITING_TRANSFER_REASONS.join(",")}),and(transfer_verification_failure_reason.is.null,transfer_verification_attempts.gt.0))),` +
          `and(transfer_verification_status.eq.manual_review,transfer_verification_failure_reason.in.(${RETRYABLE_MANUAL_REVIEW_REASONS.join(",")}))`,
        )
        filters.push({
          sql: "((transfer_verification_status = 'pending' and (transfer_verification_failure_reason = any($?) or (transfer_verification_failure_reason is null and transfer_verification_attempts > 0))) or (transfer_verification_status = 'manual_review' and transfer_verification_failure_reason = any($?)))",
          values: [[...AWAITING_TRANSFER_REASONS], [...RETRYABLE_MANUAL_REVIEW_REASONS]],
        })
        return builder
      },
      not(column: string, operator: string, value: unknown) {
        assert.equal(operator, "is")
        assert.equal(value, null)
        filters.push({ sql: `${column} is not null`, values: [] })
        return builder
      },
      order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}) {
        orderBy = `${column} ${options.ascending === false ? "desc" : "asc"} ${
          options.nullsFirst ? "nulls first" : "nulls last"
        }`
        return builder
      },
      limit(count: number) {
        limitCount = count
        return builder
      },
      maybeSingle() {
        return execute(true)
      },
      then<T>(
        resolve: (value: Awaited<ReturnType<typeof execute>>) => T,
        reject?: (reason: unknown) => T,
      ) {
        return execute(false).then(resolve, reject)
      },
    }
    return builder
  }

  async function rpc(name: string, args: Record<string, unknown>) {
    const entries = Object.entries(args)
    const params = entries.map(([key], index) => `${key} => $${index + 1}`).join(", ")
    try {
      const result = await db.query<Row>(
        `select * from public.${name}(${params})`,
        entries.map(([, value]) => value),
      )
      return { data: result.rows[0] ?? null, error: null }
    } catch (error) {
      return { data: null, error: { message: (error as Error).message } }
    }
  }

  return { from, rpc } as never
}

async function setup() {
  // PostgREST serializa numeric como número JSON; PGlite lo devuelve como
  // string por defecto (1700 = oid de numeric).
  const db = new PGlite({ parsers: { 1700: (value: string) => Number(value) } })
  await db.exec(schema)
  for (const migration of migrations) await db.exec(migration)
  // Columnas que el cron selecciona y el fixture compartido no incluye.
  await db.exec(
    "alter table ordenes add column payment_proof_url text, add column payment_proof_uploaded_at timestamptz",
  )
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return { db, admin: createPgliteAdmin(db) }
}

function buildValidCuil(prefix: string, dni: string): string {
  const first10 = `${prefix}${dni}`
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  let sum = 0
  for (let i = 0; i < 10; i += 1) sum += Number(first10[i]) * weights[i]
  const verifier = 11 - (sum % 11)
  const checkDigit = verifier === 11 ? 0 : verifier === 10 ? 9 : verifier
  return `${first10}${checkDigit}`
}

const CUSTOMER_DNI = "30111222"
const OTHER_DNI = "27444555"

function transfer(
  id: string,
  overrides: Partial<MercadoPagoBankTransferCandidate> = {},
): MercadoPagoBankTransferCandidate {
  const now = new Date().toISOString()
  return {
    id,
    status: "approved",
    operationType: "money_transfer",
    paymentMethodId: "account_money",
    transactionAmount: 900,
    currencyId: "ARS",
    dateCreated: now,
    dateApproved: now,
    identificationType: "CUIL",
    identificationNumber: buildValidCuil("20", CUSTOMER_DNI),
    bankTransferId: null,
    ...overrides,
  }
}

/** Mercado Pago simulado: cada búsqueda devuelve lo que exista EN ESE MOMENTO. */
function createMercadoPago() {
  const payments: MercadoPagoBankTransferCandidate[] = []
  let searches = 0
  return {
    payments,
    get searches() {
      return searches
    },
    searchTransfers: async () => {
      searches += 1
      return { candidates: [...payments], exhaustive: true }
    },
  }
}

async function insertOrder(db: PGlite, id: number, amount = 900) {
  await db.query(
    `insert into ordenes(id, estado, payment_method_id, payment_status, financial_status, total, external_amount_due)
     values ($1, 'pendiente', 'transferencia', 'pendiente_comprobante', 'pending_payment', $2, $2)`,
    [id, amount],
  )
}

/** Simula que pasó el tiempo desde el último intento (cooldown / lease). */
async function advanceTime(db: PGlite, orderId: number, seconds: number) {
  await db.query(
    `update ordenes
     set transfer_last_verification_at = transfer_last_verification_at - make_interval(secs => $2)
     where id = $1`,
    [orderId, seconds],
  )
}

async function readOrder(db: PGlite, id: number) {
  const result = await db.query<{
    estado: string
    payment_status: string
    financial_status: string | null
    payment_confirmed_at: Date | null
    payment_confirmed_amount: string | null
    transfer_verification_status: string | null
    transfer_verification_failure_reason: string | null
    transfer_verification_attempts: number
    transfer_last_verification_at: Date | null
    transfer_matched_payment_id: string | null
  }>(
    `select estado, payment_status, financial_status, payment_confirmed_at, payment_confirmed_amount,
            transfer_verification_status, transfer_verification_failure_reason,
            transfer_verification_attempts, transfer_last_verification_at, transfer_matched_payment_id
     from ordenes where id = $1`,
    [id],
  )
  return result.rows[0]
}

async function claimsFor(db: PGlite, paymentId: string) {
  return (
    await db.query<{ order_id: string }>(
      "select order_id from transfer_verification_payment_claims where payment_id = $1",
      [paymentId],
    )
  ).rows.map((row) => Number(row.order_id))
}

const declared = { firstName: "Romina Ayelén", lastName: "Pérez", dni: CUSTOMER_DNI, amount: 900 }

function verifyAsCustomer(
  admin: never,
  mp: ReturnType<typeof createMercadoPago>,
  orderId: number,
  overrides: Partial<typeof declared> = {},
) {
  return attemptTransferAutoVerification(
    admin,
    {
      orderId,
      declared: { ...declared, ...overrides },
      maxAttempts: TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS,
    },
    { searchTransfers: mp.searchTransfers },
  )
}

test("REGRESIÓN: verificar sin transferir -> transferir -> verificar de nuevo confirma el pedido", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    // T0: pedido pendiente, sin transferencia.
    await insertOrder(db, 1)

    // T1: click prematuro -> no encontrado, reintentable, sin fijar nada.
    const first = await verifyAsCustomer(admin, mp, 1)
    assert.equal(first.status, "awaiting_transfer")
    assert.equal(first.status === "awaiting_transfer" && first.reason, "no_candidates")
    const afterFirst = await readOrder(db, 1)
    assert.equal(afterFirst.payment_status, "pendiente_comprobante")
    assert.equal(afterFirst.estado, "pendiente")
    assert.equal(afterFirst.transfer_verification_status, "pending")
    assert.equal(afterFirst.transfer_verification_attempts, 1)
    assert.equal(afterFirst.transfer_matched_payment_id, null)

    // T2: la transferencia real aparece DESPUÉS del primer intento.
    const transferredAt = new Date()
    mp.payments.push(transfer("PAY-REAL"))
    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)

    // T3: segundo intento -> búsqueda nueva, encuentra, confirma.
    const second = await verifyAsCustomer(admin, mp, 1)
    assert.equal(second.status, "verified")
    assert.equal(mp.searches, 2, "cada intento consulta Mercado Pago de nuevo")

    const confirmed = await readOrder(db, 1)
    assert.equal(confirmed.payment_status, "confirmado")
    assert.equal(confirmed.estado, "pagado")
    assert.equal(confirmed.financial_status, "payment_confirmed")
    assert.equal(confirmed.transfer_verification_status, "auto_verified")
    assert.equal(confirmed.transfer_verification_failure_reason, null)
    assert.equal(confirmed.transfer_matched_payment_id, "PAY-REAL")
    assert.equal(Number(confirmed.payment_confirmed_amount), 900)
    assert.ok(confirmed.payment_confirmed_at)
    assert.ok(
      new Date(confirmed.payment_confirmed_at).getTime() >= transferredAt.getTime() - 1000,
      "payment_confirmed_at corresponde al intento que confirmó, no al primero",
    )
    assert.deepEqual(await claimsFor(db, "PAY-REAL"), [1], "reclamada una sola vez")

    // Un intento más sobre el pedido ya confirmado nunca vuelve a acreditar.
    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const again = await verifyAsCustomer(admin, mp, 1)
    assert.equal(again.status, "rejected")
    assert.deepEqual(await claimsFor(db, "PAY-REAL"), [1])
  } finally {
    await db.close()
  }
})

test("REGRESIÓN (causa raíz): una transferencia del mismo monto ya usada por otro pedido del mismo titular no bloquea ni el primer intento ni el segundo", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    // Pedido anterior del mismo titular, mismo monto, ya confirmado con PAY-OLD.
    await insertOrder(db, 1)
    mp.payments.push(transfer("PAY-OLD"))
    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "verified")

    // Pedido nuevo: click prematuro. Antes: PAY-OLD se tomaba como candidata
    // -> payment_id_already_used (no reintentable).
    await insertOrder(db, 2)
    const premature = await verifyAsCustomer(admin, mp, 2)
    assert.equal(premature.status, "awaiting_transfer")
    assert.equal(premature.status === "awaiting_transfer" && premature.reason, "no_candidates")

    // Transfiere. Antes: PAY-OLD + PAY-NEW -> multiple_candidates para siempre.
    mp.payments.push(transfer("PAY-NEW"))
    await advanceTime(db, 2, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const second = await verifyAsCustomer(admin, mp, 2)
    assert.equal(second.status, "verified")

    assert.equal((await readOrder(db, 2)).transfer_matched_payment_id, "PAY-NEW")
    assert.deepEqual(await claimsFor(db, "PAY-OLD"), [1])
    assert.deepEqual(await claimsFor(db, "PAY-NEW"), [2])
  } finally {
    await db.close()
  }
})

test("REGRESIÓN: en una cuenta con movimientos de otros pagadores, el click prematuro queda reintentable y el segundo intento confirma", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    // Otra venta por otro importe, y otra persona que transfirió el MISMO importe.
    mp.payments.push(transfer("PAY-OTHER-AMOUNT", { transactionAmount: 1500 }))
    mp.payments.push(
      transfer("PAY-OTHER-PAYER", { identificationNumber: buildValidCuil("27", OTHER_DNI) }),
    )

    const premature = await verifyAsCustomer(admin, mp, 1)
    assert.equal(premature.status, "manual_review")
    assert.equal(premature.status === "manual_review" && premature.reason, "dni_mismatch")
    assert.equal((await readOrder(db, 1)).transfer_matched_payment_id, null)

    mp.payments.push(transfer("PAY-REAL"))
    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const second = await verifyAsCustomer(admin, mp, 1)
    assert.equal(second.status, "verified")
    assert.equal((await readOrder(db, 1)).transfer_matched_payment_id, "PAY-REAL")
    assert.deepEqual(await claimsFor(db, "PAY-OTHER-PAYER"), [])
  } finally {
    await db.close()
  }
})

test("segundo intento dentro del cooldown -> rate_limited sin consumir intento; después del cooldown busca de nuevo y confirma", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    await verifyAsCustomer(admin, mp, 1)

    mp.payments.push(transfer("PAY-REAL"))
    const tooSoon = await verifyAsCustomer(admin, mp, 1)
    assert.equal(tooSoon.status, "rate_limited")
    assert.equal(mp.searches, 1, "dentro del cooldown no se consulta Mercado Pago")
    assert.equal((await readOrder(db, 1)).transfer_verification_attempts, 1)

    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const afterCooldown = await verifyAsCustomer(admin, mp, 1)
    assert.equal(afterCooldown.status, "verified")
    assert.equal(mp.searches, 2)
  } finally {
    await db.close()
  }
})

test("retry automático: click prematuro -> la transferencia aparece -> el cron confirma solo", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    // En una cuenta con movimiento, el motivo típico del click prematuro es
    // amount_mismatch_mp: antes no era reintentable y el cron lo ignoraba.
    mp.payments.push(transfer("PAY-OTHER-AMOUNT", { transactionAmount: 1500 }))
    const premature = await verifyAsCustomer(admin, mp, 1)
    assert.equal(premature.status === "awaiting_transfer" && premature.reason, "amount_mismatch_mp")

    mp.payments.push(transfer("PAY-REAL"))
    await advanceTime(db, 1, 15 * 60)

    const run = await retryPendingTransferVerifications(admin, {
      attempt: (client, args) =>
        attemptTransferAutoVerification(client, args, { searchTransfers: mp.searchTransfers }),
    })
    assert.deepEqual(run, { attempted: 1, verified: 1 })

    const order = await readOrder(db, 1)
    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.transfer_matched_payment_id, "PAY-REAL")
    assert.deepEqual(await claimsFor(db, "PAY-REAL"), [1])

    // Una corrida posterior del cron no lo vuelve a tomar.
    const nextRun = await retryPendingTransferVerifications(admin, {
      attempt: (client, args) =>
        attemptTransferAutoVerification(client, args, { searchTransfers: mp.searchTransfers }),
    })
    assert.deepEqual(nextRun, { attempted: 0, verified: 0 })
  } finally {
    await db.close()
  }
})

test("cron encuentra un pago que aparece a las 6, 12, 24 o casi 48 horas", async () => {
  for (const ageHours of [6, 12, 24, 47.9]) {
    const { db, admin } = await setup()
    const mp = createMercadoPago()
    try {
      await insertOrder(db, 1)
      assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "awaiting_transfer")
      await db.query(
        `update ordenes
         set created_at = now() - make_interval(secs => $1),
             transfer_last_verification_at = now() - interval '3 hours'
         where id = 1`,
        [Math.round(ageHours * 60 * 60)],
      )
      mp.payments.push(transfer(`PAY-${ageHours}`))
      const run = await retryPendingTransferVerifications(admin, {
        attempt: (client, args) => attemptTransferAutoVerification(client, args, { searchTransfers: mp.searchTransfers }),
      })
      assert.deepEqual(run, { attempted: 1, verified: 1 }, `edad ${ageHours} h`)
      assert.equal((await readOrder(db, 1)).payment_status, "confirmado")
      assert.deepEqual(await claimsFor(db, `PAY-${ageHours}`), [1])
    } finally {
      await db.close()
    }
  }
})

test("cron y cliente simultáneos sólo pueden reclamar y confirmar una vez", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "awaiting_transfer")
    await advanceTime(db, 1, 15 * 60)
    mp.payments.push(transfer("PAY-SIMULTANEOUS"))

    const [cron, customer] = await Promise.all([
      retryPendingTransferVerifications(admin, {
        attempt: (client, args) => attemptTransferAutoVerification(client, args, { searchTransfers: mp.searchTransfers }),
      }),
      verifyAsCustomer(admin, mp, 1),
    ])
    assert.equal((await readOrder(db, 1)).payment_status, "confirmado")
    assert.deepEqual(await claimsFor(db, "PAY-SIMULTANEOUS"), [1])
    assert.equal(cron.verified + Number(customer.status === "verified"), 1)
  } finally {
    await db.close()
  }
})

test("dos clicks concurrentes: uno verifica, el otro recibe checking_in_progress; se confirma una sola vez", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    mp.payments.push(transfer("PAY-REAL"))

    const results = await Promise.all([
      verifyAsCustomer(admin, mp, 1),
      verifyAsCustomer(admin, mp, 1),
    ])
    const statuses = results.map((result) => result.status).sort()
    assert.deepEqual(statuses, ["checking_in_progress", "verified"])

    const order = await readOrder(db, 1)
    assert.equal(order.transfer_verification_attempts, 1)
    assert.deepEqual(await claimsFor(db, "PAY-REAL"), [1])
    const audits = await db.query<{ count: number }>(
      "select count(*)::integer as count from order_audit_events where order_id = 1 and action = 'transfer_auto_verified'",
    )
    assert.equal(audits.rows[0].count, 1)
  } finally {
    await db.close()
  }
})

test("monto distinto -> no confirma (tanto transferido como declarado)", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    mp.payments.push(transfer("PAY-SHORT", { transactionAmount: 899.99 }))

    const transferredLess = await verifyAsCustomer(admin, mp, 1)
    assert.equal(
      transferredLess.status === "awaiting_transfer" && transferredLess.reason,
      "amount_mismatch_mp",
    )

    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const declaredLess = await verifyAsCustomer(admin, mp, 1, { amount: 899.99 })
    assert.equal(
      declaredLess.status === "manual_review" && declaredLess.reason,
      "declared_amount_mismatch",
    )

    const order = await readOrder(db, 1)
    assert.equal(order.payment_status, "pendiente_comprobante")
    assert.equal(order.transfer_matched_payment_id, null)
    assert.deepEqual(await claimsFor(db, "PAY-SHORT"), [])
  } finally {
    await db.close()
  }
})

test("DNI distinto -> no confirma", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    mp.payments.push(
      transfer("PAY-OTHER-PAYER", { identificationNumber: buildValidCuil("27", OTHER_DNI) }),
    )

    const result = await verifyAsCustomer(admin, mp, 1)
    assert.equal(result.status === "manual_review" && result.reason, "dni_mismatch")
    const order = await readOrder(db, 1)
    assert.equal(order.payment_status, "pendiente_comprobante")
    assert.equal(order.transfer_matched_payment_id, null)
    assert.deepEqual(await claimsFor(db, "PAY-OTHER-PAYER"), [])
  } finally {
    await db.close()
  }
})

test("transferencia ya usada por otro pedido -> no confirma, el pedido queda sin acreditar", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    await insertOrder(db, 2)
    mp.payments.push(transfer("PAY-SHARED"))

    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "verified")
    const second = await verifyAsCustomer(admin, mp, 2)
    assert.equal(second.status, "awaiting_transfer")
    assert.equal(second.status === "awaiting_transfer" && second.reason, "no_candidates")

    const order = await readOrder(db, 2)
    assert.equal(order.payment_status, "pendiente_comprobante")
    assert.equal(order.transfer_matched_payment_id, null)
    assert.deepEqual(await claimsFor(db, "PAY-SHARED"), [1])
  } finally {
    await db.close()
  }
})

test("dos transferencias libres del mismo monto y del mismo DNI -> ambiguo, revisión manual (nunca elige una)", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    mp.payments.push(transfer("PAY-A"), transfer("PAY-B"))

    const result = await verifyAsCustomer(admin, mp, 1)
    assert.equal(result.status === "manual_review" && result.reason, "multiple_candidates")
    assert.equal((await readOrder(db, 1)).transfer_matched_payment_id, null)
  } finally {
    await db.close()
  }
})

test("los reintentos automáticos nunca agotan los intentos manuales del cliente", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    await verifyAsCustomer(admin, mp, 1)
    // Horas de reintentos del cron sin transferencia: agotan su propio tope.
    await db.query(
      "update ordenes set transfer_verification_attempts = $2 where id = $1",
      [1, TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS],
    )
    await advanceTime(db, 1, 15 * 60)
    const cronRun = await retryPendingTransferVerifications(admin, {
      attempt: (client, args) =>
        attemptTransferAutoVerification(client, args, { searchTransfers: mp.searchTransfers }),
    })
    assert.deepEqual(cronRun, { attempted: 1, verified: 0 })
    assert.equal((await readOrder(db, 1)).transfer_verification_attempts, TRANSFER_VERIFICATION_MAX_AUTOMATIC_ATTEMPTS + 1)

    // El cliente transfiere recién ahora y vuelve a verificar: sigue pudiendo.
    mp.payments.push(transfer("PAY-LATE"))
    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const result = await verifyAsCustomer(admin, mp, 1)
    assert.equal(result.status, "verified")
    assert.equal((await readOrder(db, 1)).transfer_matched_payment_id, "PAY-LATE")
  } finally {
    await db.close()
  }
})

test("dos crons con selección vieja respetan el intervalo del tramo; el cliente conserva su cooldown de 10 s", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "awaiting_transfer")
    await advanceTime(db, 1, 15 * 60)
    const cronArgs = {
      orderId: 1,
      declared,
      maxAttempts: TRANSFER_VERIFICATION_AUTOMATIC_CLAIM_MAX_ATTEMPTS,
      minIntervalSeconds: 13 * 60,
    }
    assert.equal((await attemptTransferAutoVerification(admin, cronArgs, { searchTransfers: mp.searchTransfers })).status, "awaiting_transfer")
    await advanceTime(db, 1, TRANSFER_VERIFICATION_MIN_INTERVAL_SECONDS + 1)
    const attemptsBeforeSecondCron = (await readOrder(db, 1)).transfer_verification_attempts
    assert.equal((await attemptTransferAutoVerification(admin, cronArgs, { searchTransfers: mp.searchTransfers })).status, "rate_limited")
    assert.equal((await readOrder(db, 1)).transfer_verification_attempts, attemptsBeforeSecondCron)

    mp.payments.push(transfer("PAY-AFTER-CRON"))
    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "verified")
    assert.deepEqual(await claimsFor(db, "PAY-AFTER-CRON"), [1])
  } finally {
    await db.close()
  }
})

test("tras 60 automáticos y 29 manuales, el manual número 30 todavía reclama y confirma", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    await db.query(
      "update ordenes set transfer_verification_attempts = $2 where id = $1",
      [1, TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS - 1],
    )
    mp.payments.push(transfer("PAY-LAST-MANUAL"))
    assert.equal((await verifyAsCustomer(admin, mp, 1)).status, "verified")
    assert.equal((await readOrder(db, 1)).transfer_verification_attempts, TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS)
    assert.deepEqual(await claimsFor(db, "PAY-LAST-MANUAL"), [1])
  } finally {
    await db.close()
  }
})

test("el tope de intentos del cliente sigue existiendo (antiabuso)", async () => {
  const { db, admin } = await setup()
  const mp = createMercadoPago()
  try {
    await insertOrder(db, 1)
    await db.query(
      "update ordenes set transfer_verification_attempts = $2 where id = $1",
      [1, TRANSFER_VERIFICATION_CUSTOMER_MAX_ATTEMPTS],
    )
    mp.payments.push(transfer("PAY-REAL"))
    const result = await verifyAsCustomer(admin, mp, 1)
    assert.equal(result.status, "rejected")
    assert.equal(mp.searches, 0)
  } finally {
    await db.close()
  }
})
