import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Ejecuta las funciones SQL REALES (no una reimplementación) del estado
// ACUMULADO Fase 1 + Fase 2:
// supabase/migrations/20260911170000_mercadopago_order_refunds.sql y
// supabase/migrations/20260911180000_mercadopago_refund_phase2.sql, contra
// PostgreSQL en memoria (PGlite). Fase 2 redefine
// record_mercadopago_order_refund_result (CREATE OR REPLACE) -- se carga
// DESPUÉS de la de Fase 1 para reproducir el orden real de aplicación de
// las migraciones. No hay red, credenciales ni llamadas a Mercado Pago.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const fixture = read("lib/mercadopago/fixtures/order-refund-rpc.sql")
const migration = read("supabase/migrations/20260911170000_mercadopago_order_refunds.sql")
const phase2Migration = read("supabase/migrations/20260911180000_mercadopago_refund_phase2.sql")

function extractSection(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) throw new Error(`No se encontró la sección ${startMarker} -> ${endMarker}`)
  return source.slice(start, end)
}

const tableDdl = extractSection(
  migration,
  "create table public.mercadopago_order_refunds (",
  "-- ============================================================\n-- 2. begin_mercadopago_order_refund",
)
const beginFunctionSql = extractSection(
  migration,
  "create or replace function public.begin_mercadopago_order_refund(",
  "-- ============================================================\n-- 3. record_mercadopago_order_refund_result",
)
const reconcileFunctionSql = extractSection(
  migration,
  "create or replace function public.reconcile_mercadopago_order_refund(",
  "notify pgrst",
)
const closeClaimFunctionSql = extractSection(
  phase2Migration,
  "create or replace function public.close_mercadopago_order_refund_claim(",
  "-- ============================================================\n-- 2. claim_mercadopago_refunds_for_reconciliation",
)
const claimBatchFunctionSql = extractSection(
  phase2Migration,
  "create or replace function public.claim_mercadopago_refunds_for_reconciliation(",
  "-- ============================================================\n-- 3. record_mercadopago_order_refund_result",
)
const recordFunctionSqlPhase2 = extractSection(
  phase2Migration,
  "create or replace function public.record_mercadopago_order_refund_result(",
  "notify pgrst",
)

const user = "40000000-0000-4000-8000-000000000001"
const admin1 = "40000000-0000-4000-8000-0000000000a1"
const admin2 = "40000000-0000-4000-8000-0000000000a2"
const order = 1

async function setup(db: PGlite) {
  await db.exec(fixture)
  await db.exec(tableDdl)
  await db.exec(beginFunctionSql)
  await db.exec(closeClaimFunctionSql)
  await db.exec(claimBatchFunctionSql)
  await db.exec(recordFunctionSqlPhase2)
  await db.exec(reconcileFunctionSql)

  await db.query("insert into auth.users (id) values ($1), ($2), ($3)", [user, admin1, admin2])
  await db.query("insert into public.profiles (id, rol) values ($1, 'admin'), ($2, 'admin')", [admin1, admin2])
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ role: "service_role" }),
  ])
  await db.exec("set role service_role")
}

async function insertCancellationClaim(db: PGlite, orderId: number, status = "reintegro_pendiente") {
  const { rows } = await db.query<{ id: number }>(
    `insert into public.order_claims (order_id, user_id, claim_type, status, failure_type, resolution, admin_needs_action)
     values ($1, $2, 'transporte_48hs', $3, 'cancelar_compra', 'reintegro_total', true)
     returning id`,
    [orderId, user, status],
  )
  return rows[0].id
}

async function insertRefundPendingOrder(
  db: PGlite,
  overrides: Partial<{
    payment_method_id: string
    payment_id: string | null
    payment_confirmed_amount: number | null
    financial_status: string
    estado: string
    tracking_number: string | null
  }> = {},
) {
  const row = {
    payment_method_id: "mercadopago",
    payment_id: "9001",
    payment_confirmed_amount: 70000,
    financial_status: "refund_pending",
    estado: "cancelado",
    tracking_number: null,
    ...overrides,
  }
  await db.query(
    `insert into public.ordenes
      (id, usuario_id, total, original_total, payment_method_id, payment_id, payment_confirmed_amount, financial_status, estado, tracking_number)
     values ($1, $2, 100000, 100000, $3, $4, $5, $6, $7, $8)`,
    [order, user, row.payment_method_id, row.payment_id, row.payment_confirmed_amount, row.financial_status, row.estado, row.tracking_number],
  )
}

async function begin(db: PGlite, adminId: string) {
  const { rows } = await db.query<{
    refund_id: string
    payment_id: string
    amount: string
    idempotency_key: string
    status: string
    should_call_mp: boolean
    mp_refund_id: string | null
  }>("select * from public.begin_mercadopago_order_refund($1, $2)", [order, adminId])
  return rows[0]
}

test("begin_mercadopago_order_refund calcula el monto EXACTO del componente MP (mixto: total $100k, MP $70k)", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db, { payment_confirmed_amount: 70000 })

    const attempt = await begin(db, admin1)
    assert.equal(Number(attempt.amount), 70000, "nunca usa ordenes.total ($100.000)")
    assert.equal(attempt.should_call_mp, true)
    assert.equal(attempt.status, "processing")
    assert.equal(attempt.payment_id, "9001")
    assert.match(attempt.idempotency_key, /^mercadopago-order-refund:/)
  } finally {
    await db.close()
  }
})

test("doble click del mismo admin: reutiliza la MISMA fila y la MISMA idempotency_key, nunca dispara un segundo intento", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)

    const first = await begin(db, admin1)
    const second = await begin(db, admin1)

    assert.equal(first.refund_id, second.refund_id)
    assert.equal(first.idempotency_key, second.idempotency_key)
    assert.equal(second.should_call_mp, false, "el segundo click no debe volver a llamar a Mercado Pago")
    assert.equal(second.status, "processing")

    const count = await db.query<{ n: number }>(
      "select count(*)::int n from public.mercadopago_order_refunds where order_id = $1",
      [order],
    )
    assert.equal(count.rows[0].n, 1, "una sola fila para el pedido")
  } finally {
    await db.close()
  }
})

test("dos admins simultáneos: el segundo reutiliza el intento del primero, nunca genera un segundo refund", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)

    const fromAdmin1 = await begin(db, admin1)
    const fromAdmin2 = await begin(db, admin2)

    assert.equal(fromAdmin1.refund_id, fromAdmin2.refund_id)
    assert.equal(fromAdmin2.should_call_mp, false)

    const rows = await db.query<{ n: number }>(
      "select count(*)::int n from public.mercadopago_order_refunds where order_id = $1",
      [order],
    )
    assert.equal(rows.rows[0].n, 1)
  } finally {
    await db.close()
  }
})

test("resultado confirmado marca ordenes.financial_status='refunded' y audita -- nunca por el solo envío del POST", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)

    let order2 = await db.query<{ financial_status: string }>(
      "select financial_status from public.ordenes where id = $1",
      [order],
    )
    assert.equal(order2.rows[0].financial_status, "refund_pending", "sigue pendiente mientras el intento está 'processing'")

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-555"],
    )

    order2 = await db.query("select financial_status from public.ordenes where id = $1", [order])
    assert.equal(order2.rows[0].financial_status, "refunded")

    const audit = await db.query<{ action: string }>(
      "select action from public.order_audit_events where order_id = $1",
      [order],
    )
    assert.equal(audit.rows[0].action, "mp_refund_confirmed")

    const row = await db.query<{ status: string; mp_refund_id: string; completed_at: string | null }>(
      "select status, mp_refund_id, completed_at from public.mercadopago_order_refunds where id = $1",
      [attempt.refund_id],
    )
    assert.equal(row.rows[0].status, "confirmed")
    assert.equal(row.rows[0].mp_refund_id, "mp-refund-555")
    assert.ok(row.rows[0].completed_at)
  } finally {
    await db.close()
  }
})

test("retry después de éxito: begin() detecta 'confirmed' y no vuelve a llamar a Mercado Pago", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-1"],
    )

    const retry = await begin(db, admin1)
    assert.equal(retry.status, "confirmed")
    assert.equal(retry.should_call_mp, false)
    assert.equal(retry.mp_refund_id, "mp-refund-1")
  } finally {
    await db.close()
  }
})

test("timeout/respuesta ambigua -> needs_reconciliation, y begin() ya no vuelve a intentar el POST", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout esperando respuesta"],
    )

    const retry = await begin(db, admin1)
    assert.equal(retry.status, "needs_reconciliation")
    assert.equal(retry.should_call_mp, false, "nunca dispara un segundo POST a ciegas")

    // La orden sigue sin tocarse -- nunca se marcó 'refunded' por el solo envío.
    const order2 = await db.query<{ financial_status: string }>(
      "select financial_status from public.ordenes where id = $1",
      [order],
    )
    assert.equal(order2.rows[0].financial_status, "refund_pending")
  } finally {
    await db.close()
  }
})

test("reconciliación: Mercado Pago confirma el refund -> se cierra igual que la respuesta directa", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout"],
    )

    await db.query(
      "select * from public.reconcile_mercadopago_order_refund($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-reconciled"],
    )

    const order2 = await db.query<{ financial_status: string }>(
      "select financial_status from public.ordenes where id = $1",
      [order],
    )
    assert.equal(order2.rows[0].financial_status, "refunded")
  } finally {
    await db.close()
  }
})

test("reconciliación: Mercado Pago NUNCA recibió el refund -> vuelve a 'requested' con la MISMA idempotency_key", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout"],
    )

    await db.query(
      "select * from public.reconcile_mercadopago_order_refund($1, 'requested')",
      [attempt.refund_id],
    )

    const retry = await begin(db, admin1)
    assert.equal(retry.refund_id, attempt.refund_id)
    assert.equal(retry.idempotency_key, attempt.idempotency_key, "nunca una idempotency_key nueva")
    assert.equal(retry.should_call_mp, true, "ahora sí es seguro reintentar el POST")
    assert.equal(retry.status, "processing")
  } finally {
    await db.close()
  }
})

test("reconciliar una fila 'requested' recién creada (nunca intentada) falla explícitamente", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    // Simula una fila 'requested' manualmente (begin() normalmente ya la
    // deja en 'processing', pero el estado 'requested' puede alcanzarse vía
    // una reconciliación previa -- acá se prueba el fail-closed cuando
    // jamás se intentó nada).
    const inserted = await db.query<{ id: string }>(
      `insert into public.mercadopago_order_refunds (order_id, payment_id, amount, status, idempotency_key, requested_by)
       values ($1, '9001', 70000, 'requested', 'mercadopago-order-refund:test', $2) returning id`,
      [order, admin1],
    )
    await assert.rejects(
      db.query("select * from public.reconcile_mercadopago_order_refund($1, 'confirmed')", [inserted.rows[0].id]),
      /REFUND_ATTEMPT_NOT_STARTED/,
    )
  } finally {
    await db.close()
  }
})

test("pedido no pagado por Mercado Pago: begin() rechaza explícitamente", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db, { payment_method_id: "transferencia", payment_id: null })
    await assert.rejects(
      db.query("select * from public.begin_mercadopago_order_refund($1, $2)", [order, admin1]),
      /ORDER_NOT_PAID_BY_MERCADOPAGO/,
    )
  } finally {
    await db.close()
  }
})

test("pedido ya despachado: begin() rechaza aunque financial_status siga 'refund_pending'", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db, { estado: "enviado", tracking_number: "TRACK-1" })
    await assert.rejects(
      db.query("select * from public.begin_mercadopago_order_refund($1, $2)", [order, admin1]),
      /ORDER_ALREADY_DISPATCHED/,
    )
  } finally {
    await db.close()
  }
})

test("pedido sin financial_status='refund_pending': begin() rechaza (nada que reembolsar todavía)", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db, { financial_status: "payment_confirmed" })
    await assert.rejects(
      db.query("select * from public.begin_mercadopago_order_refund($1, $2)", [order, admin1]),
      /ORDER_NOT_REFUND_PENDING/,
    )
  } finally {
    await db.close()
  }
})

test("guarda service_role/rol admin: un operador o un rol no-service_role no puede iniciar un refund", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const operatorId = "40000000-0000-4000-8000-0000000000b1"
    await db.query("insert into auth.users (id) values ($1)", [operatorId])
    await db.query("insert into public.profiles (id, rol) values ($1, 'operador')", [operatorId])

    await assert.rejects(
      db.query("select * from public.begin_mercadopago_order_refund($1, $2)", [order, operatorId]),
      /REFUND_FORBIDDEN/,
    )

    await db.query("select set_config('request.jwt.claims', $1, false)", [
      JSON.stringify({ role: "authenticated" }),
    ])
    await db.exec("set role authenticated")
    // Doble barrera: ni siquiera tiene EXECUTE sobre la función (revoke
    // explícito) -- si lo tuviera igual la rechazaría el auth.role() interno.
    await assert.rejects(
      db.query("select * from public.begin_mercadopago_order_refund($1, $2)", [order, admin1]),
      /permission denied for function begin_mercadopago_order_refund|SERVICE_ROLE_REQUIRED/,
    )
  } finally {
    await db.close()
  }
})

// ============================================================
// FASE 2
// ============================================================

test("confirmed cierra automáticamente el order_claim de cancelación asociado", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const claimId = await insertCancellationClaim(db, order)
    const attempt = await begin(db, admin1)

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-777"],
    )

    const claim = await db.query<{ status: string; resolution: string; admin_needs_action: boolean }>(
      "select status, resolution, admin_needs_action from public.order_claims where id = $1",
      [claimId],
    )
    assert.equal(claim.rows[0].status, "cerrado")
    assert.equal(claim.rows[0].resolution, "reintegro_total")
    assert.equal(claim.rows[0].admin_needs_action, false)

    const messages = await db.query<{ author_role: string }>(
      "select author_role from public.order_claim_messages where claim_id = $1",
      [claimId],
    )
    assert.equal(messages.rows.length, 1)

    const audit = await db.query<{ action: string }>(
      "select action from public.order_audit_events where order_id = $1 and action = 'mp_refund_claim_closed'",
      [order],
    )
    assert.equal(audit.rows.length, 1)
  } finally {
    await db.close()
  }
})

test("confirmed repetido (reentrega/reconciliación posterior) es idempotente: no vuelve a cerrar ni auditar el claim otra vez", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const claimId = await insertCancellationClaim(db, order)
    const attempt = await begin(db, admin1)

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-777"],
    )
    // record_mercadopago_order_refund_result ya es idempotente (early-return
    // en 'confirmed'), pero close_mercadopago_order_refund_claim también
    // debe serlo si se lo llama directo una segunda vez (p.ej. una
    // reconciliación que confirma de nuevo el mismo refund).
    await db.query(
      "select * from public.close_mercadopago_order_refund_claim($1, $2)",
      [order, attempt.refund_id],
    )

    const claim = await db.query<{ status: string }>(
      "select status from public.order_claims where id = $1",
      [claimId],
    )
    assert.equal(claim.rows[0].status, "cerrado")

    const audit = await db.query<{ n: number }>(
      "select count(*)::int n from public.order_audit_events where order_id = $1 and action = 'mp_refund_claim_closed'",
      [order],
    )
    assert.equal(audit.rows[0].n, 1, "no se duplica el evento de auditoría")
  } finally {
    await db.close()
  }
})

test("el refund del pedido A NUNCA puede cerrar el claim del pedido B", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-777"],
    )

    const otherOrderId = 2
    await db.query(
      `insert into public.ordenes
        (id, usuario_id, total, original_total, payment_method_id, payment_id, payment_confirmed_amount, financial_status, estado)
       values ($1, $2, 50000, 50000, 'mercadopago', '9002', 50000, 'refund_pending', 'cancelado')`,
      [otherOrderId, user],
    )
    const otherClaimId = await insertCancellationClaim(db, otherOrderId)

    await assert.rejects(
      db.query("select * from public.close_mercadopago_order_refund_claim($1, $2)", [otherOrderId, attempt.refund_id]),
      /REFUND_ORDER_MISMATCH/,
    )

    const otherClaim = await db.query<{ status: string }>(
      "select status from public.order_claims where id = $1",
      [otherClaimId],
    )
    assert.equal(otherClaim.rows[0].status, "reintegro_pendiente", "el claim ajeno queda intacto")
  } finally {
    await db.close()
  }
})

test("close_mercadopago_order_refund_claim rechaza un refund que todavía no está 'confirmed'", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    await insertCancellationClaim(db, order)
    const attempt = await begin(db, admin1)

    await assert.rejects(
      db.query("select * from public.close_mercadopago_order_refund_claim($1, $2)", [order, attempt.refund_id]),
      /REFUND_NOT_CONFIRMED/,
    )
  } finally {
    await db.close()
  }
})

test("reconciliación por lote: FOR UPDATE SKIP LOCKED evita que dos workers tomen el mismo registro", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout"],
    )

    const worker1 = await db.query<{ id: string }>(
      "select * from public.claim_mercadopago_refunds_for_reconciliation(10, 300)",
    )
    assert.equal(worker1.rows.length, 1)
    assert.equal(worker1.rows[0].id, attempt.refund_id)

    // Un segundo worker, en la MISMA ventana de lock, no debe encontrar nada
    // para reconciliar -- ya está tomado.
    const worker2 = await db.query<{ id: string }>(
      "select * from public.claim_mercadopago_refunds_for_reconciliation(10, 300)",
    )
    assert.equal(worker2.rows.length, 0, "el segundo worker no debe tomar el mismo registro")
  } finally {
    await db.close()
  }
})

test("reconciliación por lote: un lock huérfano (worker caído) se libera pasado el timeout", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout"],
    )

    await db.query("select * from public.claim_mercadopago_refunds_for_reconciliation(10, 300)")
    // Simula que el lock quedó viejo (worker caído hace rato).
    await db.query(
      "update public.mercadopago_order_refunds set reconciliation_locked_at = now() - interval '1 hour' where id = $1",
      [attempt.refund_id],
    )

    const worker2 = await db.query<{ id: string }>(
      "select * from public.claim_mercadopago_refunds_for_reconciliation(10, 300)",
    )
    assert.equal(worker2.rows.length, 1, "un lock huérfano se puede volver a tomar")
  } finally {
    await db.close()
  }
})

test("needs_reconciliation repetido (sigue ambiguo) no duplica el evento de auditoría", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout 1"],
    )
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'needs_reconciliation', null, $2, $3)",
      [attempt.refund_id, "MP_RESPONSE_UNKNOWN", "timeout 2 (sigue ambiguo)"],
    )

    const audit = await db.query<{ n: number }>(
      "select count(*)::int n from public.order_audit_events where order_id = $1 and action = 'mp_refund_needs_reconciliation'",
      [order],
    )
    assert.equal(audit.rows[0].n, 1, "needs_reconciliation -> needs_reconciliation no es una transición real")
  } finally {
    await db.close()
  }
})

test("cerrar el claim NUNCA toca estado (stock derivado) ni vuelve a acreditar customer_credit", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db, { estado: "cancelado" })
    await insertCancellationClaim(db, order)
    const attempt = await begin(db, admin1)
    const before = await db.query<{ estado: string }>("select estado from public.ordenes where id = $1", [order])

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-999"],
    )

    const after = await db.query<{ estado: string }>("select estado from public.ordenes where id = $1", [order])
    assert.equal(after.rows[0].estado, before.rows[0].estado, "estado (del que depende el stock derivado) no cambia")
    assert.equal(after.rows[0].estado, "cancelado")

    // El cuerpo de la función no menciona en absoluto stock ni saldo: no
    // sólo se prueba el efecto observable, también que no existe el camino.
    const phase2Source = read("supabase/migrations/20260911180000_mercadopago_refund_phase2.sql")
    const closeClaimBody = extractSection(
      phase2Source,
      "create or replace function public.close_mercadopago_order_refund_claim(",
      "revoke execute on function public.close_mercadopago_order_refund_claim",
    )
    assert.doesNotMatch(closeClaimBody, /orden_items|customer_credit|reverse_customer_credit/i)
  } finally {
    await db.close()
  }
})

test("failed nunca deja financial_status en 'refunded' y audita mp_refund_failed", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)

    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'failed', null, $2, $3)",
      [attempt.refund_id, "PAYMENT_ALREADY_FULLY_REFUNDED", "Mercado Pago rechazó el refund"],
    )

    const order2 = await db.query<{ financial_status: string }>(
      "select financial_status from public.ordenes where id = $1",
      [order],
    )
    assert.equal(order2.rows[0].financial_status, "refund_pending")

    const audit = await db.query<{ action: string }>(
      "select action from public.order_audit_events where order_id = $1 and action = 'mp_refund_failed'",
      [order],
    )
    assert.equal(audit.rows.length, 1)
  } finally {
    await db.close()
  }
})

test("las constraints siguen permitiendo el diseño futuro de refunds parciales, sin permitir exceder el monto capturado hoy", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    await insertRefundPendingOrder(db)
    const attempt = await begin(db, admin1)
    await db.query(
      "select * from public.record_mercadopago_order_refund_result($1, 'confirmed', $2)",
      [attempt.refund_id, "mp-refund-full"],
    )

    // Fase 1: un segundo refund TOTAL confirmado para el mismo pedido sigue
    // bloqueado (el índice único ahora es is_partial=false, no todo status='confirmed').
    await assert.rejects(
      db.query(
        `insert into public.mercadopago_order_refunds
          (order_id, payment_id, amount, status, is_partial, idempotency_key, requested_by)
         values ($1, '9001', 70000, 'confirmed', false, 'mercadopago-order-refund:otro-total', $2)`,
        [order, admin1],
      ),
      /duplicate key value violates unique constraint "mercadopago_order_refunds_confirmed_full_per_order_idx"/,
    )

    // Pero SÍ permite (a nivel de constraint -- la RPC de refund parcial es
    // Fase 3/P2 pendiente) que existan filas 'confirmed' marcadas is_partial=true
    // para el mismo pedido: la tabla no le cierra la puerta a esa evolución.
    await db.query(
      `insert into public.mercadopago_order_refunds
        (order_id, payment_id, amount, status, is_partial, idempotency_key, requested_by)
       values ($1, '9001', 20000, 'confirmed', true, 'mercadopago-order-refund:parcial-1', $2)`,
      [order, admin1],
    )
    const partials = await db.query<{ n: number }>(
      "select count(*)::int n from public.mercadopago_order_refunds where order_id = $1 and is_partial = true",
      [order],
    )
    assert.equal(partials.rows[0].n, 1)
  } finally {
    await db.close()
  }
})
