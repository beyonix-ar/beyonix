import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Auditoría 4/7 (devoluciones), cierre de validación -- Sección 7
// (reemplazos). Ejercita create_order_replacement REAL (no una
// reimplementación) contra PostgreSQL en memoria (PGlite), ver
// 20260920140000_order_replacements.sql.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/orders/fixtures/return-reception-schema.sql")
const reproducibility = read(
  "supabase/migrations/20260920100000_inventory_return_movements_reproducibility.sql",
)
const unifiedRpc = read("supabase/migrations/20260920110000_unify_return_reception_rpc.sql")
const replacements = read("supabase/migrations/20260920140000_order_replacements.sql")

const superAdmin = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(reproducibility)
  await db.exec(unifiedRpc)
  await db.exec(replacements)
  await db.exec(read("supabase/migrations/20260922120000_replacement_operation_guard.sql"))
  await db.exec(read("supabase/migrations/20260922130000_replacement_admin_audit.sql"))

  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id, email) values ($1, $2)", [
    superAdmin,
    "super@beyonix.test",
  ])
  await db.query("insert into public.profiles(id, rol, email) values ($1, 'super_admin', $2)", [
    superAdmin,
    "super@beyonix.test",
  ])
  return db
}

async function createProduct(db: PGlite) {
  const { rows } = await db.query<{ id: number }>(
    "insert into productos default values returning id",
  )
  return rows[0].id
}

let seedCounter = 0

async function createVariant(db: PGlite, productId: number, stock = 0) {
  const { rows } = await db.query<{ id: number }>(
    "insert into producto_variantes (producto_id) values ($1) returning id",
    [productId],
  )
  const variantId = rows[0].id
  if (stock > 0) {
    // El stock es SIEMPRE derivado del ledger (igual que en producción) --
    // sembrarlo con un UPDATE directo lo dejaría en 0 apenas corriera
    // cualquier refresh_inventory_stock real. Se siembra vía la misma RPC
    // real de ajuste manual que usará create_order_replacement después.
    seedCounter += 1
    await db.query(
      "select adjust_variant_stock_idempotent($1, $2, 'seed inicial de test', $3, $4)",
      [variantId, stock, superAdmin, `seed-${variantId}-${seedCounter}`],
    )
  }
  return variantId
}

async function createOrder(db: PGlite) {
  const { rows } = await db.query<{ id: number }>(
    "insert into ordenes default values returning id",
  )
  return rows[0].id
}

async function createOrderItem(db: PGlite, orderId: number, productId: number, cantidad: number) {
  const { rows } = await db.query<{ id: number }>(
    "insert into orden_items (orden_id, producto_id, cantidad) values ($1, $2, $3) returning id",
    [orderId, productId, cantidad],
  )
  return rows[0].id
}

async function createFormalClaim(db: PGlite, orderId: number, itemId: number, quantity: number) {
  const { rows } = await db.query<{ id: number }>(
    "insert into order_claims (order_id, failure_type, affected_items) values ($1, 'danado', $2::jsonb) returning id",
    [orderId, JSON.stringify([{ order_item_id: itemId, quantity }])],
  )
  return rows[0].id
}

test("reemplazo: original recibido -> salida de stock exactamente una vez, costo congelado, actor/fecha", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)
    const claimId = await createFormalClaim(db, orderId, itemId, 1)

    // Recepción física del original -- requisito previo del reemplazo.
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,0,1,$4,$5,$6)",
      [claimId, orderId, itemId, "llegó roto, se cambia", superAdmin, "replacement-original-recibido"],
    )

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 5)

    const { rows } = await db.query<{
      quantity: number
      unit_cost: string
      created_by: string
      created_at: string
      reason: string
    }>(
      "select quantity, unit_cost, created_by, created_at, reason from create_order_replacement($1,$2,$3,1,'otro_producto',$4,$5)",
      [orderId, itemId, replacementVariantId, superAdmin, "replacement-attempt-1"],
    )

    assert.equal(rows[0].quantity, 1)
    assert.equal(Number(rows[0].unit_cost), 500, "costo congelado vía compute_historical_unit_cost")
    assert.equal(rows[0].created_by, superAdmin, "actor registrado")
    assert.ok(rows[0].created_at, "fecha registrada")
    assert.equal(rows[0].reason, "otro_producto")

    const stock = await db.query<{ stock: number }>(
      "select stock from producto_variantes where id=$1",
      [replacementVariantId],
    )
    assert.equal(stock.rows[0].stock, 4, "salida de stock exactamente una vez (5 - 1)")
  } finally {
    await db.close()
  }
})

test("reemplazo: idempotencia -- la misma clave dos veces no duplica la salida de stock", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)
    const claimId = await createFormalClaim(db, orderId, itemId, 1)
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,0,1,$4,$5,$6)",
      [claimId, orderId, itemId, "roto", superAdmin, "replacement-idem-original"],
    )

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 5)

    await db.query(
      "select create_order_replacement($1,$2,$3,1,'otro_producto',$4,$5)",
      [orderId, itemId, replacementVariantId, superAdmin, "replacement-idem-key"],
    )
    // Mismo idempotency key: reintento (doble click / retry) seguro.
    await db.query(
      "select create_order_replacement($1,$2,$3,1,'otro_producto',$4,$5)",
      [orderId, itemId, replacementVariantId, superAdmin, "replacement-idem-key"],
    )

    const stock = await db.query<{ stock: number }>(
      "select stock from producto_variantes where id=$1",
      [replacementVariantId],
    )
    assert.equal(stock.rows[0].stock, 4, "la salida de stock no se duplicó por el reintento")

    const count = await db.query<{ count: string }>(
      "select count(*)::text as count from order_replacements where original_order_item_id=$1",
      [itemId],
    )
    assert.equal(count.rows[0].count, "1")
  } finally {
    await db.close()
  }
})

test("reemplazo rechazado sin recepción previa cuando el motivo NO es garantía", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 5)

    await assert.rejects(
      db.query(
        "select create_order_replacement($1,$2,$3,1,'otra_variante',$4,$5)",
        [orderId, itemId, replacementVariantId, superAdmin, "replacement-no-reception"],
      ),
      /REPLACEMENT_REQUIRES_RECEIVED_ITEM/,
    )

    const stock = await db.query<{ stock: number }>(
      "select stock from producto_variantes where id=$1",
      [replacementVariantId],
    )
    assert.equal(stock.rows[0].stock, 5, "no se movió stock por el intento rechazado")
  } finally {
    await db.close()
  }
})

test("reemplazo por garantía SÍ se permite sin recepción física previa (caso reconocido explícitamente)", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 5)

    await assert.doesNotReject(
      db.query(
        "select create_order_replacement($1,$2,$3,1,'garantia',$4,$5)",
        [orderId, itemId, replacementVariantId, superAdmin, "replacement-warranty"],
      ),
    )
  } finally {
    await db.close()
  }
})

test("reemplazo rechazado si no hay stock suficiente del producto/variante de reemplazo", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)
    const claimId = await createFormalClaim(db, orderId, itemId, 1)
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,0,1,$4,$5,$6)",
      [claimId, orderId, itemId, "roto", superAdmin, "replacement-stock-check"],
    )

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 0)

    await assert.rejects(
      db.query(
        "select create_order_replacement($1,$2,$3,1,'otro_producto',$4,$5)",
        [orderId, itemId, replacementVariantId, superAdmin, "replacement-no-stock"],
      ),
      /STOCK_INSUFICIENTE/,
    )
  } finally {
    await db.close()
  }
})

test("guardia operativa: no permite reemplazar dos veces unidades ya retiradas con otra clave", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, 2)
    const variantId = await createVariant(db, productId, 5)
    const args = [orderId, itemId, variantId, superAdmin]
    await db.query("select create_order_replacement($1,$2,$3,2,'garantia',$4,'guard-first')", args)
    await assert.rejects(db.query("select create_order_replacement($1,$2,$3,1,'garantia',$4,'guard-second')", args), /REPLACEMENT_QUANTITY_EXCEEDED/)
    await assert.rejects(db.query("select create_order_replacement($1,$2,$3,1,'garantia',$4,'guard-first')", args), /REPLACEMENT_CONFLICT/)
    const stock = await db.query<{ stock: number }>("select stock from producto_variantes where id=$1", [variantId])
    assert.equal(stock.rows[0].stock, 3)
  } finally { await db.close() }
})

test("auditoría del reemplazo: queda en order_audit_events con el pedido original", async () => {
  const db = await setup()
  try {
    const originalProductId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, originalProductId, 1)
    const claimId = await createFormalClaim(db, orderId, itemId, 1)
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,0,1,$4,$5,$6)",
      [claimId, orderId, itemId, "roto", superAdmin, "replacement-audit-original"],
    )

    const replacementProductId = await createProduct(db)
    const replacementVariantId = await createVariant(db, replacementProductId, 3)
    await db.query(
      "select create_order_replacement($1,$2,$3,1,'otro_producto',$4,$5)",
      [orderId, itemId, replacementVariantId, superAdmin, "replacement-audit-key"],
    )

    const { rows } = await db.query<{ action: string; actor_id: string }>(
      "select action, actor_id from order_audit_events where order_id=$1 and action='order_replacement_created'",
      [orderId],
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].actor_id, superAdmin)
    const central = await db.query<{ actor_user_id: string; actor_email: string; after_data: Record<string, unknown> }>("select actor_user_id,actor_email,after_data from audit_logs where table_name='order_replacements'")
    assert.equal(central.rows.length, 1)
    assert.equal(central.rows[0].actor_user_id, superAdmin)
    assert.equal(central.rows[0].actor_email, "super@beyonix.test")
    assert.equal(central.rows[0].after_data.original_order_id, orderId)
    assert.equal(central.rows[0].after_data.idempotency_key, undefined)
  } finally {
    await db.close()
  }
})
