import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// customer-credit-topups.ts importa createAdminClient ("@/lib/supabase/admin"),
// que requiere el alias de paths de Next.js -- no resuelve con
// --experimental-strip-types en un test suelto. Se verifica el contenido de
// MERCADOPAGO_TOPUP_REVERSAL_STATUSES leyendo el código fuente, igual que ya
// hacen los tests de app/api/mercadopago/webhook/route.ts en order-payment.test.ts.
const topupsSource = readFileSync(
  join(process.cwd(), "lib/mercadopago/customer-credit-topups.ts"),
  "utf8",
)

// P1: una carga de saldo (customer_credit_topups) acreditada por Mercado
// Pago quedaba "acreditado" para siempre si MP notificaba después
// refunded/charged_back/cancelled/rejected sobre el mismo pago -- el saldo
// acreditado (customer_credit_movements) nunca se revertía. Este test
// ejecuta las funciones SQL reales (no una reimplementación): las extrae de
// supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql
// (credit_customer_credit_topup_from_mercadopago vigente) y de
// 20260911160000_reverse_customer_credit_topup_on_mp_reversal.sql (la
// corrección) y las corre contra PostgreSQL en memoria (PGlite). No hay red,
// credenciales ni RPC financieras contra Supabase real.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const fixture = read("lib/customer-credit/fixtures/credit-topup-reversal.sql")
const baselineMigration = read(
  "supabase/migrations/20260911130000_harden_customer_credit_rpc_authorization.sql",
)
const fixMigration = read(
  "supabase/migrations/20260911160000_reverse_customer_credit_topup_on_mp_reversal.sql",
)

function extractFunctions(source: string) {
  const matches = [...source.matchAll(
    /CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?AS \$function\$[\s\S]*?\$function\$;/g,
  )]
  return new Map(matches.map(([definition, name]) => [name, definition]))
}

const baselineFunctions = extractFunctions(baselineMigration)
const fixFunctions = extractFunctions(fixMigration)

const user = "30000000-0000-4000-8000-000000000001"

async function setup(db: PGlite) {
  await db.exec(fixture)
  await db.exec(baselineFunctions.get("get_customer_credit_balance")!)
  await db.exec(baselineFunctions.get("create_customer_credit_movement")!)
  // La versión VIGENTE de credit_customer_credit_topup_from_mercadopago es la
  // redefinida en 20260911160000 (agrega el guard 'revertido' es terminal),
  // no la original de 20260911130000.
  await db.exec(fixFunctions.get("credit_customer_credit_topup_from_mercadopago")!)
  await db.exec(fixFunctions.get("reverse_customer_credit_topup")!)

  await db.query("insert into auth.users (id) values ($1)", [user])
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ role: "service_role" }),
  ])
  await db.exec("set role service_role")
}

async function insertTopup(db: PGlite, amount: number) {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.customer_credit_topups
      (user_id, amount, gross_amount, payment_method, status, external_reference)
     values ($1, $2, $2, 'mercadopago', 'en_revision', 'credit-topup:x')
     returning id`,
    [user, amount],
  )
  return rows[0].id
}

async function creditTopup(db: PGlite, topupId: string, paymentId: string, amount: number) {
  return db.query<{ topup_status: string; movement_id: string | null; resulting_balance: string }>(
    "select * from public.credit_customer_credit_topup_from_mercadopago($1, $2, 'approved', $3)",
    [topupId, paymentId, amount],
  )
}

async function getBalance(db: PGlite) {
  const { rows } = await db.query<{ balance: string }>(
    "select public.get_customer_credit_balance($1) balance",
    [user],
  )
  return Number(rows[0].balance)
}

async function getTopup(db: PGlite, topupId: string) {
  const { rows } = await db.query<{
    status: string
    reversed_movement_id: string | null
    reversal_shortfall_amount: string | null
  }>(
    "select status, reversed_movement_id, reversal_shortfall_amount from public.customer_credit_topups where id = $1",
    [topupId],
  )
  return rows[0]
}

test("approved -> acreditado -> refunded: el saldo se revierte por completo", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 30000)
    await creditTopup(db, topupId, "1001", 30000)
    assert.equal(await getBalance(db), 30000)

    const { rows } = await db.query<{
      topup_status: string
      resulting_balance: string
      shortfall_amount: string
    }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "1001"],
    )

    assert.equal(rows[0].topup_status, "revertido")
    assert.equal(Number(rows[0].resulting_balance), 0)
    assert.equal(Number(rows[0].shortfall_amount), 0)
    assert.equal(await getBalance(db), 0)
    const topup = await getTopup(db, topupId)
    assert.equal(topup.status, "revertido")
    assert.ok(topup.reversed_movement_id)
    assert.equal(Number(topup.reversal_shortfall_amount), 0)
  } finally {
    await db.close()
  }
})

test("approved -> acreditado -> charged_back: el saldo se revierte por completo", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 15000)
    await creditTopup(db, topupId, "2002", 15000)
    assert.equal(await getBalance(db), 15000)

    const { rows } = await db.query<{ topup_status: string; resulting_balance: string }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'charged_back')",
      [topupId, "2002"],
    )

    assert.equal(rows[0].topup_status, "revertido")
    assert.equal(Number(rows[0].resulting_balance), 0)
    assert.equal(await getBalance(db), 0)
  } finally {
    await db.close()
  }
})

test("doble webhook de reversa (refunded repetido) no debita dos veces", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 10000)
    await creditTopup(db, topupId, "3003", 10000)

    const first = await db.query<{ movement_id: string }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "3003"],
    )
    const second = await db.query<{ movement_id: string }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "3003"],
    )

    assert.equal(first.rows[0].movement_id, second.rows[0].movement_id)
    assert.equal(await getBalance(db), 0, "no queda en negativo ni se debita dos veces")
    const debits = await db.query<{ n: number }>(
      "select count(*)::int n from public.customer_credit_movements where movement_type = 'debit' and source_type = 'reversal'",
    )
    assert.equal(debits.rows[0].n, 1)
  } finally {
    await db.close()
  }
})

test("reversa con saldo ya gastado: debita lo disponible y registra la deuda explícita, sin negativo ni ocultarlo", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 30000)
    await creditTopup(db, topupId, "4004", 30000)

    // El cliente ya gastó $25.000 de los $30.000 acreditados (p. ej. aplicados
    // a un pedido) antes de que Mercado Pago avise el refund.
    await db.query(
      `insert into public.customer_credit_movements
        (user_id, movement_type, amount, description, source_type, resulting_balance)
       values ($1, 'debit', 25000, 'Saldo aplicado a un pedido', 'order', 5000)`,
      [user],
    )
    assert.equal(await getBalance(db), 5000)

    const { rows } = await db.query<{
      topup_status: string
      resulting_balance: string
      shortfall_amount: string
    }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "4004"],
    )

    assert.equal(rows[0].topup_status, "revertido")
    assert.equal(Number(rows[0].resulting_balance), 0, "nunca queda negativo")
    assert.equal(Number(rows[0].shortfall_amount), 25000, "la deuda queda registrada explícitamente")
    assert.equal(await getBalance(db), 0)

    const topup = await getTopup(db, topupId)
    assert.equal(Number(topup.reversal_shortfall_amount), 25000)
  } finally {
    await db.close()
  }
})

test("rejected/cancelled ANTES de acreditarse sigue sin generar ningún movimiento (no-op ya existente)", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 8000)

    const { rows } = await db.query<{ topup_status: string; movement_id: string | null }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'rejected')",
      [topupId, "5005"],
    )

    assert.equal(rows[0].topup_status, "en_revision")
    assert.equal(rows[0].movement_id, null)
    assert.equal(await getBalance(db), 0)
    const topup = await getTopup(db, topupId)
    assert.equal(topup.status, "en_revision")
  } finally {
    await db.close()
  }
})

// P1 (segunda vuelta): 'revertido' debe ser terminal salvo reconciliación
// administrativa explícita. Sin el guard agregado a
// credit_customer_credit_topup_from_mercadopago, un 'approved' tardío
// (reentrega fuera de orden del mismo payment_id, o un intento de "reabrir"
// la carga) volvía a poner status='acreditado' aunque
// create_customer_credit_movement no duplicara el saldo (mismo source_key).
test("approved -> acreditado -> refunded -> revertido -> approved tardío: sigue revertido, saldo sin cambios", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 12000)
    await creditTopup(db, topupId, "6006", 12000)
    await db.query(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "6006"],
    )
    assert.equal((await getTopup(db, topupId)).status, "revertido")
    assert.equal(await getBalance(db), 0)

    // Mercado Pago reentrega (o reenvía) 'approved' tardíamente para el
    // MISMO payment_id ya revertido.
    const late = await creditTopup(db, topupId, "6006", 12000)
    assert.equal(late.rows[0].topup_status, "revertido", "nunca vuelve a 'acreditado' sola")
    assert.equal(await getBalance(db), 0, "el saldo no cambia")

    const topupAfter = await getTopup(db, topupId)
    assert.equal(topupAfter.status, "revertido")
    assert.equal(
      (
        await db.query<{ n: number }>(
          "select count(*)::int n from public.customer_credit_movements where user_id = $1",
          [user],
        )
      ).rows[0].n,
      2,
      "sigue habiendo sólo el credit original + el debit de la reversa, nada nuevo",
    )

    // Auditable: queda una alerta explícita en admin_notes.
    const { rows: notesRows } = await db.query<{ admin_notes: string | null }>(
      "select admin_notes from public.customer_credit_topups where id = $1",
      [topupId],
    )
    assert.match(notesRows[0].admin_notes ?? "", /approved.*DESPUÉS de una reversa/)

    // Idempotente: una segunda reentrega del mismo approved tardío no duplica la alerta.
    await creditTopup(db, topupId, "6006", 12000)
    const { rows: notesAfterSecond } = await db.query<{ admin_notes: string | null }>(
      "select admin_notes from public.customer_credit_topups where id = $1",
      [topupId],
    )
    const alertCount = (notesAfterSecond[0].admin_notes?.match(/\[Alerta\]/g) ?? []).length
    assert.equal(alertCount, 1)
  } finally {
    await db.close()
  }
})

test("reversal_shortfall_amount no se acumula ante una segunda reversa idempotente", async () => {
  const db = new PGlite()
  try {
    await setup(db)
    const topupId = await insertTopup(db, 20000)
    await creditTopup(db, topupId, "7007", 20000)

    // El cliente ya gastó todo el saldo antes del refund.
    await db.query(
      `insert into public.customer_credit_movements
        (user_id, movement_type, amount, description, source_type, resulting_balance)
       values ($1, 'debit', 20000, 'Saldo aplicado a un pedido', 'order', 0)`,
      [user],
    )

    const first = await db.query<{ shortfall_amount: string }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'refunded')",
      [topupId, "7007"],
    )
    assert.equal(Number(first.rows[0].shortfall_amount), 20000)

    // Reentrega del mismo webhook de reversa (o un 'charged_back' adicional
    // sobre el mismo pago ya revertido).
    const second = await db.query<{ shortfall_amount: string }>(
      "select * from public.reverse_customer_credit_topup($1, $2, 'charged_back')",
      [topupId, "7007"],
    )
    assert.equal(Number(second.rows[0].shortfall_amount), 20000, "no se duplica a 40000")

    const topup = await getTopup(db, topupId)
    assert.equal(Number(topup.reversal_shortfall_amount), 20000)
    assert.equal(await getBalance(db), 0)
  } finally {
    await db.close()
  }
})

test("MERCADOPAGO_TOPUP_REVERSAL_STATUSES sólo incluye reversas de dinero reales", () => {
  assert.match(
    topupsSource,
    /export const MERCADOPAGO_TOPUP_REVERSAL_STATUSES = new Set\(\[\s*"refunded",\s*"charged_back",\s*\]\)/,
  )
  // Estados transitorios/pre-aprobación que NO deben aparecer en ese Set.
  const setLiteral = topupsSource.match(
    /MERCADOPAGO_TOPUP_REVERSAL_STATUSES = new Set\(\[[\s\S]*?\]\)/,
  )?.[0]
  assert.ok(setLiteral)
  for (const transientOrPreApproval of [
    "pending",
    "in_process",
    "authorized",
    "in_mediation",
    "cancelled",
    "rejected",
    "approved",
  ]) {
    assert.doesNotMatch(setLiteral, new RegExp(`"${transientOrPreApproval}"`))
  }

  // El chequeo genérico `!== "approved"` para decidir si se revierte un
  // topup ya acreditado quedó reemplazado por la lista explícita.
  assert.match(
    topupsSource,
    /if \(!MERCADOPAGO_TOPUP_REVERSAL_STATUSES\.has\(payment\.status\)\)/,
  )
})
