import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Ejercita la función SQL REAL claim_mercadopago_order_preference (no una
// reimplementación) contra PostgreSQL en memoria (PGlite), en su estado
// ACUMULADO: 20260815120000_mercadopago_checkout_attempt_idempotency.sql
// (versión original) seguida de
// 20260924110000_mercadopago_claim_allows_rejected_cancelled.sql (la
// corrección de este bugfix, que agrega 'rejected'/'cancelled' a los
// payment_status reclamables). Sin red, credenciales ni Mercado Pago real.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

function extractSection(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  if (start < 0 || end < 0) {
    throw new Error(`No se encontró la sección ${startMarker} -> ${endMarker}`)
  }
  return source.slice(start, end)
}

const fixture = read("lib/mercadopago/fixtures/claim-mercadopago-order-preference.sql")
const originalMigration = read(
  "supabase/migrations/20260815120000_mercadopago_checkout_attempt_idempotency.sql",
)
const fixMigration = read(
  "supabase/migrations/20260924110000_mercadopago_claim_allows_rejected_cancelled.sql",
)

const originalFunctionSql = extractSection(
  originalMigration,
  "create or replace function public.claim_mercadopago_order_preference(",
  "revoke all on function public.claim_mercadopago_order_preference",
)
const fixFunctionSql = extractSection(
  fixMigration,
  "create or replace function public.claim_mercadopago_order_preference(",
  "revoke all on function public.claim_mercadopago_order_preference",
)

const FINGERPRINT = "fingerprint-abc"

async function switchToServiceRole(db: PGlite) {
  await db.query("select set_config('request.jwt.claims', $1, false)", [
    JSON.stringify({ role: "service_role" }),
  ])
  await db.exec("set role service_role")
}

async function setupOriginal(db: PGlite) {
  await db.exec(fixture)
  await db.exec(originalFunctionSql)
  await switchToServiceRole(db)
}

async function setupWithFix(db: PGlite) {
  await db.exec(fixture)
  await db.exec(originalFunctionSql)
  await db.exec(fixFunctionSql)
  await switchToServiceRole(db)
}

async function insertOrder(
  db: PGlite,
  overrides: Partial<{
    id: number
    estado: string
    financial_status: string | null
    payment_status: string | null
    payment_method_id: string | null
    mercadopago_checkout_fingerprint: string | null
    mercadopago_init_point: string | null
    mercadopago_preference_expires_at: string | null
    mercadopago_preference_claimed_at: string | null
  }> = {},
) {
  const row = {
    id: 1,
    estado: "pendiente",
    financial_status: "pending_payment",
    payment_status: "preference_created",
    payment_method_id: "mercadopago",
    mercadopago_checkout_fingerprint: FINGERPRINT,
    mercadopago_init_point: "https://mercadopago.example/checkout/1",
    // Vencida: el ÚNICO estado en el que claim_mercadopago_order_preference
    // debe poder reclamar una preferencia nueva (si no, "reuse" ya la
    // hubiera devuelto sin pasar por acá).
    mercadopago_preference_expires_at: "2020-01-01T00:00:00.000Z",
    mercadopago_preference_claimed_at: null,
    ...overrides,
  }

  await db.query(
    `insert into public.ordenes
      (id, estado, financial_status, payment_status, payment_method_id, mercadopago_checkout_fingerprint, mercadopago_init_point, mercadopago_preference_expires_at, mercadopago_preference_claimed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      row.id,
      row.estado,
      row.financial_status,
      row.payment_status,
      row.payment_method_id,
      row.mercadopago_checkout_fingerprint,
      row.mercadopago_init_point,
      row.mercadopago_preference_expires_at,
      row.mercadopago_preference_claimed_at,
    ],
  )
}

function claim(db: PGlite, orderId: number, fingerprint: string, claimToken: string) {
  return db.query<{ claim_mercadopago_order_preference: number | null }>(
    "select claim_mercadopago_order_preference($1, $2, $3) as claim_mercadopago_order_preference",
    [orderId, fingerprint, claimToken],
  )
}

test("ANTES del fix: un pago rechazado no se puede reclamar -- queda bloqueando para siempre", async () => {
  const db = new PGlite()
  try {
    await setupOriginal(db)
    await insertOrder(db, { payment_status: "rejected" })

    const { rows } = await claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-000000000001")
    assert.equal(rows[0].claim_mercadopago_order_preference, null)
  } finally {
    await db.close()
  }
})

test("DESPUÉS del fix: un pago rechazado permite reclamar una preferencia nueva sobre la misma orden", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { payment_status: "rejected" })

    const { rows } = await claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-000000000001")
    assert.equal(rows[0].claim_mercadopago_order_preference, 1)

    const { rows: order } = await db.query<{
      payment_status: string
      mercadopago_preference_claim_token: string
    }>(
      "select payment_status, mercadopago_preference_claim_token from public.ordenes where id=1",
    )
    assert.equal(order[0].payment_status, "pending_checkout")
    assert.equal(
      order[0].mercadopago_preference_claim_token,
      "10000000-0000-4000-8000-000000000001",
    )
  } finally {
    await db.close()
  }
})

test("DESPUÉS del fix: un intento cancelado desde Checkout Pro también permite reclamar", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { payment_status: "cancelled" })

    const { rows } = await claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-000000000002")
    assert.equal(rows[0].claim_mercadopago_order_preference, 1)
  } finally {
    await db.close()
  }
})

test("un pago aprobado con conflicto de stock NUNCA se puede reclamar (dinero real sin resolver)", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { payment_status: "approved_stock_conflict" })

    const { rows } = await claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-000000000003")
    assert.equal(rows[0].claim_mercadopago_order_preference, null)
  } finally {
    await db.close()
  }
})

test("doble click: dos claims simultáneos sobre la misma orden -- sólo el primero tiene efecto", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { payment_status: "preference_created" })

    const [first, second] = await Promise.all([
      claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-0000000000f1"),
      claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-0000000000f2"),
    ])

    const results = [
      first.rows[0].claim_mercadopago_order_preference,
      second.rows[0].claim_mercadopago_order_preference,
    ]

    // Uno de los dos gana (generación 1) y el otro no afecta ninguna fila
    // (null) -- nunca los dos a la vez, y nunca dos generaciones distintas.
    assert.ok(
      (results[0] === 1 && results[1] === null) ||
        (results[0] === null && results[1] === 1),
      `resultados inesperados: ${JSON.stringify(results)}`,
    )
  } finally {
    await db.close()
  }
})

test("un claim con la huella de MP equivocada nunca reclama otra orden", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { payment_status: "rejected" })

    const { rows } = await claim(
      db,
      1,
      "otra-huella-distinta",
      "10000000-0000-4000-8000-000000000004",
    )
    assert.equal(rows[0].claim_mercadopago_order_preference, null)
  } finally {
    await db.close()
  }
})

test("una orden ya pagada nunca se puede reclamar, aunque payment_status quedara inconsistente", async () => {
  const db = new PGlite()
  try {
    await setupWithFix(db)
    await insertOrder(db, { estado: "pagado", payment_status: "rejected" })

    const { rows } = await claim(db, 1, FINGERPRINT, "10000000-0000-4000-8000-000000000005")
    assert.equal(rows[0].claim_mercadopago_order_preference, null)
  } finally {
    await db.close()
  }
})
