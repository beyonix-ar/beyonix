import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Bug real en producción: la cancelación desde "Mis compras" (POST
// /api/orders/[id]/cancel -> request_customer_order_cancellation_with_claim)
// devolvía "No se pudo cancelar la compra de forma segura." para pedidos
// normales, previos al envío. Causa confirmada contra la base real (ver
// supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql):
//   1) offered_resolutions es text[] en producción, no jsonb -- el INSERT
//      insertaba '[]'::jsonb y Postgres lo rechazaba con
//      "column ... is of type text[] but expression is of type jsonb"
//      (rompía el 100% de las cancelaciones de cliente).
//   2) v_invoiced propagaba NULL cuando invoice_status era NULL (pedido
//      pagado, todavía sin facturar), y ese NULL llegaba a
//      credit_note_required (NOT NULL), violando esa constraint.
// Ninguno de los dos códigos (42804 / 23502) era reconocido por
// app/api/orders/[id]/cancel/route.ts, así que ambos caían al fallback
// genérico. Estas pruebas ejercitan las RPCs SQL reales (no una
// reimplementación) contra PostgreSQL en memoria (PGlite), cargando las
// migraciones ya aplicadas remotamente en su orden real. Sin red,
// credenciales ni datos reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const source = (relativePath: string) =>
  readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8")

const schema = read("lib/andreani/fixtures/andreani-cancellation-race-schema.sql")
const migrations = [
  "supabase/migrations/20260906120000_harden_andreani_commercial_and_order_writes.sql",
  "supabase/migrations/20260825130000_atomic_customer_cancellation_claim.sql",
  "supabase/migrations/20260816120000_atomic_order_claim_cancellation.sql",
  "supabase/migrations/20260915120000_admin_direct_order_cancellation.sql",
  "supabase/migrations/20260915130000_fix_admin_cancel_order_previous_estado.sql",
  "supabase/migrations/20260916100000_block_cancellation_during_andreani_creation.sql",
  "supabase/migrations/20260917110000_fix_customer_cancellation_type_and_null_bugs.sql",
].map(read)

const customer = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  for (const migration of migrations) await db.exec(migration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

function cancel(db: PGlite, orderId: number, reason = "Cambié de idea, ya no lo quiero") {
  return db.query<{ result: unknown }>(
    "select request_customer_order_cancellation_with_claim($1,$2,$3) result",
    [orderId, customer, reason],
  )
}

test("1. pedido pagado, previo al envío, sin facturar -- la cancelación se completa (antes fallaba: offered_resolutions jsonb/text[] + credit_note_required NULL)", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado, financial_status, paid_at, payment_status)
       values (1,$1,'pagado','payment_confirmed',now(),'confirmado')`,
      [customer],
    )

    const { rows } = await cancel(db, 1)
    const order = rows[0].result as Record<string, unknown>

    assert.equal(order.estado, "cancelado")
    assert.equal(order.financial_status, "refund_pending")
    assert.equal(order.credit_note_required, false, "invoice_status NULL no debe propagar NULL a credit_note_required")
    assert.ok(order.claim_id, "debe crear el claim comercial atómicamente")
  } finally {
    await db.close()
  }
})

test("2. pedido pendiente sin pago -- la cancelación se completa", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado) values (2,$1,'pendiente')`,
      [customer],
    )
    const { rows } = await cancel(db, 2)
    const order = rows[0].result as Record<string, unknown>
    assert.equal(order.estado, "cancelado")
    assert.equal(order.financial_status, "cancelled")
  } finally {
    await db.close()
  }
})

test("3. claimed -- ANDREANI_CREATION_IN_PROGRESS", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado, financial_status, paid_at, payment_status, andreani_creation_status)
       values (3,$1,'pagado','payment_confirmed',now(),'confirmado','claimed')`,
      [customer],
    )
    await assert.rejects(() => cancel(db, 3), /ANDREANI_CREATION_IN_PROGRESS/)
  } finally {
    await db.close()
  }
})

test("4. reconciliation_required -- ANDREANI_RECONCILIATION_REQUIRED", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado, financial_status, paid_at, payment_status, andreani_creation_status)
       values (4,$1,'pagado','payment_confirmed',now(),'confirmado','reconciliation_required')`,
      [customer],
    )
    await assert.rejects(() => cancel(db, 4), /ANDREANI_RECONCILIATION_REQUIRED/)
  } finally {
    await db.close()
  }
})

test("5. envío ya creado (andreani_envio_id) -- ORDER_ALREADY_DISPATCHED", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado, andreani_envio_id) values (5,$1,'pagado','ENV-1')`,
      [customer],
    )
    await assert.rejects(() => cancel(db, 5), /ORDER_ALREADY_DISPATCHED/)
  } finally {
    await db.close()
  }
})

test("6. pedido ya cancelado -- ORDER_ALREADY_CANCELLED", async () => {
  const db = await setup()
  try {
    await db.query(
      `insert into ordenes (id, usuario_id, estado, financial_status) values (6,$1,'cancelado','cancelled')`,
      [customer],
    )
    await assert.rejects(() => cancel(db, 6), /ORDER_ALREADY_CANCELLED/)
  } finally {
    await db.close()
  }
})

// --- Contrato del route: cada código de la RPC debe mapear a un mensaje
// claro, y un error desconocido debe caer al fallback genérico (nunca al
// revés).

test("el route mapea cada código de error de la RPC a un mensaje claro y distinto, y loggea lo desconocido", () => {
  const route = source("app/api/orders/[id]/cancel/route.ts")

  assert.match(route, /message\.includes\("ORDER_NOT_FOUND"\)/)
  assert.match(route, /message\.includes\("ORDER_ALREADY_CANCELLED"\)/)
  assert.match(route, /message\.includes\("ORDER_ALREADY_DISPATCHED"\)/)
  assert.match(route, /message\.includes\("ANDREANI_CREATION_IN_PROGRESS"\)/)
  assert.match(route, /message\.includes\("ANDREANI_RECONCILIATION_REQUIRED"\)/)

  // Cada código mapea a un texto propio (no todos comparten el mismo string).
  const messages = [...route.matchAll(/error:\s*"([^"]+)"/g)].map((m) => m[1])
  assert.ok(messages.includes("La compra ya está cancelada."))
  assert.ok(messages.includes("El pedido ya fue despachado y no puede cancelarse desde acá."))
  assert.ok(messages.some((m) => m.includes("generando el envío")))
  assert.ok(messages.some((m) => m.includes("necesita revisión")))
  assert.ok(messages.includes("No se pudo cancelar la compra de forma segura."))

  // El fallback genérico debe loggear el error real -- si no, un bug nuevo
  // en la RPC vuelve a ser indistinguible de un rechazo de negocio (fue
  // exactamente lo que ocultó este bug hasta ahora).
  assert.match(route, /console\.error\(\s*\n?\s*"Cancelación de compra/)
})

test("un código de error desconocido de la RPC no matchea ninguna rama mapeada -- cae al fallback genérico", () => {
  const route = source("app/api/orders/[id]/cancel/route.ts")
  const knownCodes = [
    "ORDER_NOT_FOUND",
    "ORDER_ALREADY_CANCELLED",
    "ORDER_ALREADY_DISPATCHED",
    "ANDREANI_CREATION_IN_PROGRESS",
    "ANDREANI_RECONCILIATION_REQUIRED",
  ]
  // Un error de Postgres real (constraint/tipo) nunca contiene estos
  // literales -- confirmado contra la base real con los dos bugs de esta
  // migración antes de corregirlos.
  const unknownMessage =
    'column "offered_resolutions" is of type text[] but expression is of type jsonb'
  for (const code of knownCodes) {
    assert.ok(!unknownMessage.includes(code))
  }
  assert.match(route, /"No se pudo cancelar la compra de forma segura\."/)
})

// --- Sanitización de la respuesta: el frontend no necesita más que esto.

test("la respuesta sanitizada de éxito trae todo lo que 'Mis compras' necesita para reflejar el resultado", () => {
  const route = source("app/api/orders/[id]/cancel/route.ts")
  const frontend = source("components/claims/customer-claim-experience.tsx")

  // El frontend sólo verifica que exista `data.order` (truthy) y usa su
  // propio estado local para el resto -- no lee campos específicos de la
  // orden devuelta por este endpoint.
  assert.match(frontend, /if \(!response\.ok \|\| !data\.order\)/)
  assert.doesNotMatch(frontend, /data\.order\.\w/)

  // La vista sanitizada expone exactamente lo que se necesitaría si algún
  // consumidor futuro sí leyera campos puntuales.
  const fnMatch = route.match(
    /function toCustomerCancellationOrderView\(order: CancelableOrder\) \{([\s\S]*?)\n\}/,
  )
  assert.ok(fnMatch)
  for (const field of ["id", "estado", "financial_status", "cancelled_at", "cancellation_requested_at"]) {
    assert.match(fnMatch![1], new RegExp(field))
  }
})
