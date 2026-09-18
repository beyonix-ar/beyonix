import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// P0 FINANCIERO (auditoría de cancelaciones/reintegros/NC): begin_partial_credit_note
// topeaba el importe de una Nota de Crédito SOLO contra el total facturado,
// sin descontar dinero ya devuelto por otro canal (saldo a favor ya
// revertido por cancelación, u otra NC/refund ya comprometido). Ver
// supabase/migrations/20260917120000_credit_note_refundable_external_cap.sql
// para el detalle completo. Estas pruebas ejercitan las RPCs SQL REALES
// (no una reimplementación) contra PostgreSQL en memoria (PGlite), cargando
// las migraciones ya aplicadas remotamente en su orden real más el fix
// nuevo. Sin red, credenciales ni datos reales.

const schema = readFileSync(new URL("./fixtures/claim-schema.sql", import.meta.url), "utf8")
const migrations = [
  "../../supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
  "../../supabase/migrations/20260905150000_claims_atomic_operations.sql",
  "../../supabase/migrations/20260906090000_claim_case_type_transitions.sql",
  "../../supabase/migrations/20260906100000_claims_final_security.sql",
  "../../supabase/migrations/20260906110000_claim_credit_note_snapshot.sql",
  "../../supabase/migrations/20260917120000_credit_note_refundable_external_cap.sql",
].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))

const admin = "10000000-0000-4000-8000-000000000003"
const customer = "10000000-0000-4000-8000-000000000001"

type OrderSeed = {
  id: number
  total: number
  creditBalanceUsed?: number
  paymentConfirmedAmount?: number | null
  externalAmountDue?: number | null
  financialStatus?: string | null
}

async function setup(order: OrderSeed) {
  const db = new PGlite()
  await db.exec(schema)
  for (const migration of migrations) await db.exec(migration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users values($1,$2,now()),($3,$4,now())", [
    admin,
    "admin@example.test",
    customer,
    "customer@example.test",
  ])
  await db.query("insert into profiles(id,email,rol) values($1,$2,'super_admin'),($3,$4,'cliente')", [
    admin,
    "admin@example.test",
    customer,
    "customer@example.test",
  ])
  await db.query(
    `insert into ordenes(
       id, usuario_id, estado, total, invoice_status, invoice_cae, invoice_number, invoice_point,
       credit_balance_used, payment_confirmed_amount, external_amount_due, financial_status
     ) values ($1,$2,'cancelado',$3,'authorized','CAE-TEST',1,1,$4,$5,$6,$7)`,
    [
      order.id,
      customer,
      order.total,
      order.creditBalanceUsed ?? 0,
      order.paymentConfirmedAmount ?? null,
      order.externalAmountDue ?? null,
      order.financialStatus ?? "refund_pending",
    ],
  )
  return db
}

// begin_partial_credit_note sólo RESERVA la nota (status='processing') --
// la transición a 'authorized' ocurre en el route.ts real recién después de
// que ARCA confirma el CAE. Estas pruebas no ejercitan ARCA: simulan esa
// misma transición para poder verificar el tope de importe en una
// secuencia de varias notas, tal como lo vería begin_partial_credit_note en
// llamadas sucesivas reales.
async function issueNote(
  db: PGlite,
  orderId: number,
  destination: "external_refund" | "customer_balance" | "none",
  amount: number,
) {
  const result = await db.query<{ id: string }>(
    `select id from begin_partial_credit_note($1,null,$2,'Ajuste de prueba',0,$3,$3,1,1,$4,'[]','ajuste_manual')`,
    [orderId, destination, amount, admin],
  )
  await db.query("update order_credit_notes set status='authorized' where id=$1", [result.rows[0].id])
  return result
}

// Caso 1: $20k saldo + $30k transferencia
test("saldo $20k + transferencia $30k: reintegro externo tope $30k, no $50k", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await issueNote(db, 1, "external_refund", 30000)
    const committed = await db.query<{ total: string }>(
      "select coalesce(sum(total_amount),0)::text as total from order_credit_notes where order_id=1 and status='authorized'",
    )
    assert.equal(Number(committed.rows[0].total), 30000)
  } finally {
    await db.close()
  }
})

test("saldo $20k + transferencia $30k: intentar $50k (el total facturado) es rechazado -- ya no alcanza el fiscal, ahora tampoco el financiero", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await assert.rejects(
      issueNote(db, 1, "external_refund", 50000),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
  } finally {
    await db.close()
  }
})

test("saldo $20k + transferencia $30k: $30.001 (un peso más del remanente) también se rechaza", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await assert.rejects(
      issueNote(db, 1, "external_refund", 30001),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
  } finally {
    await db.close()
  }
})

// Caso 2: $20k saldo + $30k Mercado Pago -- misma fórmula, distinto medio
test("saldo $20k + Mercado Pago $30k: refund/NC tope $30k", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await issueNote(db, 1, "customer_balance", 30000)
    await assert.rejects(
      // ya se comprometió el remanente completo -- cualquier importe adicional, aunque sea $1, se rechaza
      issueNote(db, 1, "external_refund", 1),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
  } finally {
    await db.close()
  }
})

// Caso 3: 100% saldo -- nada que devolver en dinero externo
test("100% saldo: el remanente externo es $0 -- cualquier NC que mueva dinero se rechaza", async () => {
  const db = await setup({
    id: 1,
    total: 50000,
    creditBalanceUsed: 50000,
    paymentConfirmedAmount: 0,
    externalAmountDue: 0,
  })
  try {
    await assert.rejects(
      issueNote(db, 1, "external_refund", 1),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
    await assert.rejects(
      issueNote(db, 1, "customer_balance", 1),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
  } finally {
    await db.close()
  }
})

test("100% saldo: una NC fiscal-only (destino 'none') sigue permitida hasta el total facturado -- no se deformó la lógica fiscal", async () => {
  const db = await setup({
    id: 1,
    total: 50000,
    creditBalanceUsed: 50000,
    paymentConfirmedAmount: 0,
    externalAmountDue: 0,
  })
  try {
    const result = await issueNote(db, 1, "none", 50000)
    assert.ok(result.rows[0]?.id)
  } finally {
    await db.close()
  }
})

// Caso 4: 100% transferencia
test("100% transferencia: refund externo tope = monto realmente pagado", async () => {
  const db = await setup({ id: 1, total: 50000, paymentConfirmedAmount: 50000 })
  try {
    await issueNote(db, 1, "external_refund", 50000)
    await assert.rejects(issueNote(db, 1, "external_refund", 1), /CREDIT_NOTE_PROCESSING_IN_PROGRESS|CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT|CREDIT_NOTE_EXCEEDS_INVOICE/)
  } finally {
    await db.close()
  }
})

// Caso 5: 100% Mercado Pago
test("100% Mercado Pago: refund tope = monto realmente confirmado en MP", async () => {
  const db = await setup({ id: 1, total: 50000, paymentConfirmedAmount: 50000 })
  try {
    const result = await issueNote(db, 1, "customer_balance", 50000)
    assert.ok(result.rows[0]?.id)
  } finally {
    await db.close()
  }
})

// Caso 8/9: pedido ya refunded -- no permite un segundo settlement, por ningún destino que mueva dinero
test("pedido ya financial_status='refunded': ninguna NC nueva con destino external_refund/customer_balance -- ORDER_ALREADY_REFUNDED", async () => {
  const db = await setup({
    id: 1,
    total: 50000,
    paymentConfirmedAmount: 30000,
    financialStatus: "refunded",
  })
  try {
    await assert.rejects(issueNote(db, 1, "external_refund", 1), /ORDER_ALREADY_REFUNDED/)
    await assert.rejects(issueNote(db, 1, "customer_balance", 1), /ORDER_ALREADY_REFUNDED/)
  } finally {
    await db.close()
  }
})

test("pedido ya refunded: una NC fiscal-only (destino 'none') no está bloqueada por este guard -- sigue sujeta sólo al tope fiscal", async () => {
  const db = await setup({
    id: 1,
    total: 50000,
    paymentConfirmedAmount: 30000,
    financialStatus: "refunded",
  })
  try {
    const result = await issueNote(db, 1, "none", 50000)
    assert.ok(result.rows[0]?.id)
  } finally {
    await db.close()
  }
})

// Caso 12: saldo restaurado + refund -- suma exacta, nunca superior (end to end del P0-1)
test("suma exacta: saldo revertido ($20k, fuera de esta RPC) + NC externa ($30k) = $50k, nunca más", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await issueNote(db, 1, "external_refund", 30000)
    const totals = await db.query<{ total: string }>(
      "select coalesce(sum(total_amount),0)::text as total from order_credit_notes where order_id=1 and destination in ('external_refund','customer_balance') and status='authorized'",
    )
    const externalSettled = Number(totals.rows[0].total)
    const saldoYaRevertido = 20000 // reverse_customer_credit_for_order, fuera del alcance de esta RPC
    assert.equal(externalSettled + saldoYaRevertido, 50000)
  } finally {
    await db.close()
  }
})

// Caso 10 (concurrencia, aproximado): dos "admins" comprometen el remanente en secuencia -- el segundo ve el estado real, no uno stale
test("dos intentos sucesivos sobre el mismo remanente: sólo el primero que efectivamente cabe gana", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await issueNote(db, 1, "external_refund", 20000)
    // el remanente real ya bajó a $10.000 -- un segundo intento por $20.000 más excede lo que queda
    await assert.rejects(issueNote(db, 1, "external_refund", 20000), /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/)
    // pero $10.000 sí entra
    await issueNote(db, 1, "external_refund", 10000)
    const totals = await db.query<{ total: string }>(
      "select coalesce(sum(total_amount),0)::text as total from order_credit_notes where order_id=1 and status='authorized'",
    )
    assert.equal(Number(totals.rows[0].total), 30000)
  } finally {
    await db.close()
  }
})

// Caso 7 (otherAdjustmentAmount / cualquier componente del total): el tope se aplica sobre el total combinado, no solo sobre items
test("un ajuste manual que por sí solo excede el remanente es rechazado igual que un item", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000, paymentConfirmedAmount: 30000 })
  try {
    await assert.rejects(
      db.query(
        `select id from begin_partial_credit_note($1,null,'external_refund','Ajuste manual excesivo',0,$2,$2,1,1,$3,'[]','ajuste_manual')`,
        [1, 40000, admin],
      ),
      /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/,
    )
  } finally {
    await db.close()
  }
})

// El tope fiscal existente (contra el total facturado) sigue intacto y es independiente del nuevo tope financiero
test("el tope fiscal (CREDIT_NOTE_EXCEEDS_INVOICE) sigue aplicando sin cambios, independiente del tope financiero nuevo", async () => {
  const db = await setup({ id: 1, total: 50000, paymentConfirmedAmount: 50000 })
  try {
    await assert.rejects(issueNote(db, 1, "external_refund", 50001), /CREDIT_NOTE_EXCEEDS_INVOICE/)
  } finally {
    await db.close()
  }
})

test("pedido legado sin payment_confirmed_amount/external_amount_due: cae a total-credit_balance_used", async () => {
  const db = await setup({ id: 1, total: 50000, creditBalanceUsed: 20000 })
  try {
    await issueNote(db, 1, "external_refund", 30000)
    await assert.rejects(issueNote(db, 1, "external_refund", 1), /CREDIT_NOTE_EXCEEDS_REFUNDABLE_AMOUNT/)
  } finally {
    await db.close()
  }
})

// --- Regresión de grants (bloqueante detectado en la auditoría corta) ---
//
// 20260906110000_claim_credit_note_snapshot.sql ya había revocado EXECUTE de
// service_role sobre begin_partial_credit_note(12 args): sólo el wrapper de
// 13 args (dueño de la función) puede invocarla, para que nadie se salte
// CREDIT_NOTE_SNAPSHOT_CONFLICT llamando directo al motor. Una versión
// anterior de 20260917120000 volvía a otorgar ese EXECUTE por copiar el
// bloque grant/revoke de la migración original sin tener en cuenta el
// hardening posterior. Esto NO es un `assert.match` sobre texto de la
// migración (frágil e indirecto): ejercita el GRANT/REVOKE real de
// PostgreSQL en PGlite con `set role service_role`, tal como ya lo hace
// lib/orders/claim-atomic.test.ts para la misma función.
test("grants: service_role NO puede ejecutar begin_partial_credit_note de 12 args directamente, incluso después del fix financiero", async () => {
  const db = await setup({ id: 1, total: 50000, paymentConfirmedAmount: 50000 })
  try {
    await db.exec("set role service_role")
    await assert.rejects(
      db.query(
        `select id from begin_partial_credit_note($1,null,'external_refund','Prueba aislada',0,$2,$2,1,1,$3,'[]','ajuste_manual')`,
        [1, 1000, admin],
      ),
      /permission denied/,
    )
  } finally {
    await db.close()
  }
})

test("grants: service_role SÍ puede ejecutar el wrapper de 13 args (el único camino habilitado)", async () => {
  const db = await setup({ id: 1, total: 50000, paymentConfirmedAmount: 50000 })
  try {
    await db.exec("set role service_role")
    // Puede fallar por motivos de negocio (p.ej. snapshot), pero nunca por
    // falta de permiso -- eso es justamente lo que distingue esta prueba de
    // la anterior.
    await assert.doesNotReject(
      db.query(
        `select id from begin_partial_credit_note($1,null,'external_refund','Prueba aislada',0,$2,$2,1,1,$3,'[]','ajuste_manual','{}'::uuid[])`,
        [1, 1000, admin],
      ),
    )
  } finally {
    await db.close()
  }
})
