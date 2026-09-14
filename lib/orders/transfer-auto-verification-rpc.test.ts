import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Tests contra PostgreSQL real (PGlite), no mocks: exactamente las dos
// funciones que aplica supabase/migrations/20260913120000_transfer_auto_verification.sql,
// corriendo sobre un esquema aislado (lib/orders/fixtures/transfer-verification-schema.sql).
// Mismo patrón que lib/orders/claim-atomic.test.ts.

const schema = readFileSync(
  new URL("./fixtures/transfer-verification-schema.sql", import.meta.url),
  "utf8",
)
const migration = readFileSync(
  new URL(
    "../../supabase/migrations/20260913120000_transfer_auto_verification.sql",
    import.meta.url,
  ),
  "utf8",
)

const PAYMENT_ID = "177895301225"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(migration)
  // Config leída por auth.role() dentro de las funciones (chequeo interno,
  // independiente del rol real de Postgres usado para el ACL de EXECUTE).
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

async function insertOrder(
  db: PGlite,
  id: number,
  overrides: Record<string, unknown> = {},
) {
  const row = {
    estado: "pendiente",
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    total: 900,
    external_amount_due: 900,
    ...overrides,
  }
  await db.query(
    `insert into ordenes(id, estado, payment_method_id, payment_status, total, external_amount_due)
     values ($1,$2,$3,$4,$5,$6)`,
    [id, row.estado, row.payment_method_id, row.payment_status, row.total, row.external_amount_due],
  )
}

function confirmArgs(orderId: number, paymentId = PAYMENT_ID) {
  return [
    orderId,
    paymentId,
    "money_transfer",
    "account_money",
    900,
    "CUIL",
    "20301112220",
    "30111222",
    null,
    "2026-09-13T18:17:43.000-04:00",
    "2026-09-13T18:17:43.000-04:00",
  ]
}

const CONFIRM_SQL =
  "select confirm_transfer_auto_verification($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)"

test("SQL: dos requests simultáneas para LA MISMA orden y el MISMO payment.id -- sólo una confirma, la otra ve ALREADY_RESOLVED", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const results = await Promise.allSettled([
      db.query(CONFIRM_SQL, confirmArgs(1)),
      db.query(CONFIRM_SQL, confirmArgs(1)),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1, "sólo una de las dos debe confirmar")
    assert.equal(rejected.length, 1)
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason.message,
      /ALREADY_RESOLVED/,
    )

    const order = (
      await db.query<{ payment_status: string; transfer_matched_payment_id: string }>(
        "select payment_status, transfer_matched_payment_id from ordenes where id=1",
      )
    ).rows[0]
    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.transfer_matched_payment_id, PAYMENT_ID)

    // Nunca se auditó dos veces el mismo pago.
    const auditCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from order_audit_events where order_id=1 and action='transfer_auto_verified'",
      )
    ).rows[0].count
    assert.equal(auditCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: dos ÓRDENES DISTINTAS compitiendo por el MISMO payment.id -- sólo una lo acredita, nunca las dos", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await insertOrder(db, 2)

    const results = await Promise.allSettled([
      db.query(CONFIRM_SQL, confirmArgs(1)),
      db.query(CONFIRM_SQL, confirmArgs(2)),
    ])

    const fulfilled = results.filter((r) => r.status === "fulfilled")
    const rejected = results.filter((r) => r.status === "rejected")
    assert.equal(fulfilled.length, 1, "un mismo payment.id nunca puede acreditar dos pedidos")
    assert.equal(rejected.length, 1)
    assert.match(
      (rejected[0] as PromiseRejectedResult).reason.message,
      /TRANSFER_PAYMENT_ID_ALREADY_USED/,
    )

    const confirmedCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from ordenes where payment_status='confirmado' and transfer_matched_payment_id=$1",
        [PAYMENT_ID],
      )
    ).rows[0].count
    assert.equal(confirmedCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: el cron reintentando una orden ya confirmada entre lecturas nunca la vuelve a acreditar ni a auditar", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.query(CONFIRM_SQL, confirmArgs(1))

    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1)),
      /ALREADY_RESOLVED/,
    )

    const amount = (
      await db.query<{ payment_confirmed_amount: string }>(
        "select payment_confirmed_amount from ordenes where id=1",
      )
    ).rows[0].payment_confirmed_amount
    assert.equal(Number(amount), 900)
    const auditCount = (
      await db.query<{ count: number }>(
        "select count(*)::integer as count from order_audit_events where order_id=1",
      )
    ).rows[0].count
    assert.equal(auditCount, 1)
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt respeta el tope de intentos", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    for (let i = 0; i < 3; i += 1) {
      await db.query(
        "select claim_transfer_verification_attempt($1,$2,0,0)",
        [1, 3],
      )
    }
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1,$2,0,0)", [1, 3]),
      /MAX_ATTEMPTS_EXCEEDED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt aplica rate limit por intervalo mínimo", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    // p_stale_checking_seconds=0: el lease de "checking" ya se considera vencido
    // de inmediato, así que el segundo intento no cae en ALREADY_CHECKING sino
    // en el chequeo de intervalo mínimo (p_min_interval_seconds=60) que sí
    // queremos aislar acá.
    await db.query("select claim_transfer_verification_attempt($1,20,60,0)", [1])
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1,20,60,0)", [1]),
      /RATE_LIMITED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: claim_transfer_verification_attempt nunca reclama un pedido ya confirmado/rechazado", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { payment_status: "confirmado" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /ALREADY_RESOLVED/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: ninguna de las dos RPC es ejecutable por anon", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.exec("set role anon")
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /permission denied/,
    )
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1)),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: ninguna de las dos RPC es ejecutable por authenticated", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.exec("set role authenticated")
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /permission denied/,
    )
    await assert.rejects(
      db.query(CONFIRM_SQL, confirmArgs(1)),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test("SQL: service_role puede ejecutar ambas RPC de punta a punta", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    const claimed = await db.query("select claim_transfer_verification_attempt($1)", [1])
    assert.equal(claimed.rows.length, 1)
    const confirmed = await db.query(CONFIRM_SQL, confirmArgs(1))
    assert.equal(confirmed.rows.length, 1)
  } finally {
    await db.close()
  }
})

test("SQL: una orden cancelada nunca puede reclamarse ni confirmarse automáticamente", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { estado: "cancelado" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /ORDER_CANCELLED/,
    )
    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1)), /ORDER_CANCELLED/)
  } finally {
    await db.close()
  }
})

test("SQL: un pedido que no es de transferencia nunca puede reclamarse ni confirmarse por este camino", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1, { payment_method_id: "mercadopago" })
    await assert.rejects(
      db.query("select claim_transfer_verification_attempt($1)", [1]),
      /NOT_TRANSFER_ORDER/,
    )
    await assert.rejects(db.query(CONFIRM_SQL, confirmArgs(1)), /NOT_TRANSFER_ORDER/)
  } finally {
    await db.close()
  }
})

test("SQL: confirm_transfer_auto_verification reutiliza exactamente el mismo esquema de campos que la confirmación manual (no duplica lógica financiera propia)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, 1)
    await db.query(CONFIRM_SQL, confirmArgs(1))
    const order = (
      await db.query<Record<string, unknown>>("select * from ordenes where id=1")
    ).rows[0]

    assert.equal(order.payment_status, "confirmado")
    assert.equal(order.estado, "pagado")
    assert.equal(order.financial_status, "payment_confirmed")
    assert.equal(order.payment_confirmed_by, null)
    assert.ok(order.payment_confirmed_at)
    assert.equal(Number(order.payment_confirmed_amount), 900)
    assert.equal(order.order_change_status, "change_approved")
    assert.equal(Number(order.order_change_extra_amount), 0)
    assert.equal(order.transfer_verification_status, "auto_verified")
  } finally {
    await db.close()
  }
})
