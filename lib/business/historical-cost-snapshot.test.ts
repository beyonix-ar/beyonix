import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Auditoría 3/7 (cierre final): congelamiento DETERMINÍSTICO del costo
// histórico -- reemplaza el diseño "lazy" (congelaba recién al abrir
// dashboard/listado) por triggers server-side que se disparan en el momento
// exacto en que cada canal reconoce la venta (ver
// 20260919100000_deterministic_historical_cost_snapshot.sql). Ejercita las
// RPCs/triggers SQL REALES contra PostgreSQL en memoria (PGlite), no una
// reimplementación. Sin red, credenciales ni datos reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/business/fixtures/purchase-cost-audit-schema.sql")
const atomicPurchases = read("supabase/migrations/20260801093000_atomic_product_purchases.sql")
// freeze_order_item*_historical_cost usan inventory_order_consumes_stock
// (definida acá, no en la migración de snapshot -- ver 20260918110000).
const orderInventoryReproducibility = read(
  "supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql",
)
const deterministicSnapshot = read(
  "supabase/migrations/20260919100000_deterministic_historical_cost_snapshot.sql",
)

const superAdmin = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(atomicPurchases)
  await db.exec(orderInventoryReproducibility)
  await db.exec(deterministicSnapshot)

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

async function savePurchase(db: PGlite, purchase: Record<string, unknown>) {
  const { rows } = await db.query<{ id: string }>(
    "select (save_product_purchase_atomic($1::jsonb, $2)).id as id",
    [JSON.stringify(purchase), superAdmin],
  )
  return rows[0].id
}

async function createOrder(
  db: PGlite,
  overrides: { estado?: string; payment_status?: string | null; paid_at?: string | null } = {},
) {
  const { rows } = await db.query<{ id: number }>(
    "insert into ordenes (estado, payment_status, paid_at) values ($1, $2, $3) returning id",
    [overrides.estado ?? "pendiente", overrides.payment_status ?? null, overrides.paid_at ?? null],
  )
  return rows[0].id
}

async function createOrderItem(
  db: PGlite,
  orderId: number,
  productId: number,
  variantId: number | null,
  cantidad = 1,
) {
  const { rows } = await db.query<{ id: number; costo_unitario_historico: string | null }>(
    "insert into orden_items (orden_id, producto_id, variante_id, cantidad) values ($1, $2, $3, $4) returning id, costo_unitario_historico",
    [orderId, productId, variantId, cantidad],
  )
  return rows[0]
}

async function getOrderItemSnapshot(db: PGlite, itemId: number) {
  const { rows } = await db.query<{ costo_unitario_historico: string | null }>(
    "select costo_unitario_historico from orden_items where id=$1",
    [itemId],
  )
  return rows[0].costo_unitario_historico == null ? null : Number(rows[0].costo_unitario_historico)
}

test("A. venta web: el costo se congela al pasar la orden a un estado vendido, con el valor vigente en ese momento", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await savePurchase(db, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 1000,
    })

    const orderId = await createOrder(db)
    const item = await createOrderItem(db, orderId, productId, null, 2)
    assert.equal(item.costo_unitario_historico, null, "todavía no vendida: sin congelar")

    await db.query("update ordenes set estado='pagado', paid_at=now() where id=$1", [orderId])

    assert.equal(await getOrderItemSnapshot(db, item.id), 1000)
  } finally {
    await db.close()
  }
})

test("B/D. modificar una compra histórica DESPUÉS de congelar no cambia el costo ya reportado (server-side, no se recalcula después)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const purchaseId = await savePurchase(db, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 1000,
    })

    const orderId = await createOrder(db)
    const item = await createOrderItem(db, orderId, productId, null, 1)
    await db.query("update ordenes set estado='pagado', paid_at=now() where id=$1", [orderId])
    assert.equal(await getOrderItemSnapshot(db, item.id), 1000, "costo congelado con el precio original")

    // Se modifica la compra histórica: si el snapshot no fuera inmutable,
    // esto cambiaría retroactivamente la ganancia ya reportada de la venta.
    await savePurchase(db, {
      id: purchaseId,
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 5000,
    })
    assert.equal(
      await getOrderItemSnapshot(db, item.id),
      1000,
      "la venta mantiene el costo congelado pese a la edición posterior de la compra",
    )

    // Reintento del mismo cambio de estado (doble webhook / cron + manual):
    // tampoco debe recalcular ni sobrescribir.
    await db.query("update ordenes set payment_status='approved' where id=$1", [orderId])
    assert.equal(await getOrderItemSnapshot(db, item.id), 1000, "idempotente: no se sobrescribe")
  } finally {
    await db.close()
  }
})

test("A. un item agregado a una orden que YA está paga se congela de inmediato (no depende de un UPDATE posterior de la orden)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await savePurchase(db, {
      product_id: productId,
      quantity: 5,
      purchase_date: "2026-01-01",
      unit_cost: 2000,
    })
    const orderId = await createOrder(db, { estado: "pagado", paid_at: "2026-02-01T00:00:00Z" })

    const item = await createOrderItem(db, orderId, productId, null, 1)
    assert.equal(
      Number(item.costo_unitario_historico),
      2000,
      "congelado ya en el INSERT, sin esperar otro evento",
    )
  } finally {
    await db.close()
  }
})

test("F. sin historial de costos, el item queda SIN congelar (null), nunca inventa un valor -- sigue el fallback dinámico de siempre", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const item = await createOrderItem(db, orderId, productId, null, 1)

    await db.query("update ordenes set estado='pagado', paid_at=now() where id=$1", [orderId])
    assert.equal(await getOrderItemSnapshot(db, item.id), null)
  } finally {
    await db.close()
  }
})

test("B. external_sales: el costo se congela al crear la fila (no hay estado pendiente en este canal)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await savePurchase(db, {
      product_id: productId,
      quantity: 4,
      purchase_date: "2026-01-01",
      unit_cost: 3000,
    })

    const { rows } = await db.query<{ costo_unitario_historico: string }>(
      "insert into external_sales (product_id, sale_date) values ($1, '2026-02-01') returning costo_unitario_historico",
      [productId],
    )
    assert.equal(Number(rows[0].costo_unitario_historico), 3000)
  } finally {
    await db.close()
  }
})

test("external_sales sin producto catalogado (artículo suelto) no intenta congelar nada", async () => {
  const db = await setup()
  try {
    const { rows } = await db.query<{ costo_unitario_historico: string | null }>(
      "insert into external_sales (product_id, sale_date) values (null, '2026-02-01') returning costo_unitario_historico",
    )
    assert.equal(rows[0].costo_unitario_historico, null)
  } finally {
    await db.close()
  }
})

test("G. compute_historical_unit_cost NO es ejecutable directamente por anon/authenticated -- sólo service_role (GRANT/REVOKE real, no un chequeo de auth.role())", async () => {
  const db = await setup()
  try {
    // A diferencia de auth.role() (una GUC que leen a mano ciertas
    // funciones), esto ejercita el privilegio real de Postgres: SET ROLE
    // cambia el current_user con el que se evalúa el REVOKE/GRANT.
    await db.query("set role authenticated")
    await assert.rejects(
      db.query("select compute_historical_unit_cost(1, null, '2026-01-01'::date)"),
      /permission denied/i,
    )
    await db.query("reset role")

    await db.query("set role anon")
    await assert.rejects(
      db.query("select compute_historical_unit_cost(1, null, '2026-01-01'::date)"),
      /permission denied/i,
    )
    await db.query("reset role")

    await db.query("set role service_role")
    await assert.doesNotReject(
      db.query("select compute_historical_unit_cost(1, null, '2026-01-01'::date)"),
    )
  } finally {
    await db.close()
  }
})

test("compute_historical_unit_cost hace fallback de variante a producto, igual que getHistoricalUnitCost (TS)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const { rows: variantRows } = await db.query<{ id: number }>(
      "insert into producto_variantes (producto_id) values ($1) returning id",
      [productId],
    )
    const variantId = variantRows[0].id

    // Compra a nivel PRODUCTO (variant_id null) -- comportamiento histórico.
    await savePurchase(db, {
      product_id: productId,
      quantity: 2,
      purchase_date: "2026-01-01",
      unit_cost: 700,
    })

    const { rows } = await db.query<{ cost: string | null }>(
      "select compute_historical_unit_cost($1, $2, '2026-06-01'::date) as cost",
      [productId, variantId],
    )
    assert.equal(Number(rows[0].cost), 700, "sin compras propias de la variante, cae al costo a nivel producto")
  } finally {
    await db.close()
  }
})
