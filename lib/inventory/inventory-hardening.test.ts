import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// FASE 1 (auditoría de stock, hardening P0/P1). Ejercita las RPCs SQL
// REALES (no una reimplementación) contra PostgreSQL en memoria (PGlite):
// las 3 migraciones nuevas de esta fase (CHECK stock>=0,
// refresh_inventory_stock fail-closed, reproducibilidad de los triggers de
// refresco) sobre un esquema mínimo, más las RPCs auxiliares reales
// (checkout, devoluciones, ajuste manual) fetchadas de producción el
// 2026-09-18 -- ver lib/inventory/fixtures/*.sql para el detalle y el
// alcance exacto de la simplificación. Sin red, credenciales ni datos
// reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/inventory/fixtures/inventory-hardening-schema.sql")
const migrationFailClosed = read(
  "supabase/migrations/20260918100000_refresh_inventory_stock_fail_closed.sql",
)
const migrationReproducibility = read(
  "supabase/migrations/20260918110000_inventory_refresh_reproducibility.sql",
)
const migrationCheckConstraint = read(
  "supabase/migrations/20260918120000_stock_nonnegative_check_constraint.sql",
)
const views = read("lib/inventory/fixtures/inventory-hardening-views.sql")
const functions = read("lib/inventory/fixtures/inventory-hardening-functions.sql")

const admin = "10000000-0000-4000-8000-000000000003"

async function setup(options: { withCheckConstraint?: boolean } = {}) {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(migrationFailClosed)
  await db.exec(migrationReproducibility)
  if (options.withCheckConstraint ?? true) {
    await db.exec(migrationCheckConstraint)
  }
  await db.exec(views)
  await db.exec(functions)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id) values($1)", [admin])
  return db
}

async function createProduct(db: PGlite, overrides: { activo?: boolean } = {}) {
  const { rows } = await db.query<{ id: number }>(
    "insert into productos (activo) values ($1) returning id",
    [overrides.activo ?? true],
  )
  return rows[0].id
}

async function createVariant(db: PGlite, productId: number, overrides: { activo?: boolean } = {}) {
  const { rows } = await db.query<{ id: number }>(
    "insert into producto_variantes (producto_id, activo) values ($1, $2) returning id",
    [productId, overrides.activo ?? true],
  )
  return rows[0].id
}

// Única forma real de dejar stock inicial: una compra + refresh (igual que
// save_product_purchase_idempotent en producción, simplificado acá porque
// esa RPC no es objeto de esta fase).
async function seedStock(db: PGlite, productId: number, variantId: number | null, quantity: number) {
  await db.query(
    "insert into product_cost_entries (product_id, variant_id, received_quantity) values ($1, $2, $3)",
    [productId, variantId, quantity],
  )
  await db.query("select refresh_inventory_stock($1)", [productId])
}

async function getProductStock(db: PGlite, productId: number) {
  const { rows } = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
  return rows[0].stock
}

async function getVariantStock(db: PGlite, variantId: number) {
  const { rows } = await db.query<{ stock: number }>("select stock from producto_variantes where id=$1", [variantId])
  return rows[0].stock
}

async function createOrder(db: PGlite, estado: string, paymentStatus: string | null = null) {
  const { rows } = await db.query<{ id: number }>(
    "insert into ordenes (estado, payment_status) values ($1, $2) returning id",
    [estado, paymentStatus],
  )
  return rows[0].id
}

async function createOrderItem(
  db: PGlite,
  orderId: number,
  productId: number,
  variantId: number | null,
  cantidad: number,
) {
  const { rows } = await db.query<{ id: number }>(
    "insert into orden_items (orden_id, producto_id, variante_id, cantidad) values ($1, $2, $3, $4) returning id",
    [orderId, productId, variantId, cantidad],
  )
  return rows[0].id
}

// --- A/B: CHECK stock >= 0 (punto 1) ---

test("A. UPDATE directo a productos.stock = -1 -- rechazado por la DB", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    // Sin bypass del guard: ya rechazado por guard_derived_inventory_stock
    // (INVENTORY_STOCK_IS_DERIVED) -- confirma que ni siquiera se llega al
    // CHECK en el camino normal.
    await assert.rejects(
      db.query("update productos set stock=-1 where id=$1", [productId]),
      /INVENTORY_STOCK_IS_DERIVED/,
    )
    // Con el guard bypaseado (mismo mecanismo que usa refresh_inventory_stock
    // internamente) -- ahora sí se ejercita el CHECK en sí, no el guard.
    // is_local=false (a diferencia de refresh_inventory_stock, que lo usa
    // local a su propia transacción): acá necesitamos que sobreviva entre
    // dos llamadas a db.query() separadas, cada una su propia transacción
    // implícita.
    await db.query("select set_config('beyonix.inventory_refresh','on',false)")
    await assert.rejects(
      db.query("update productos set stock=-1 where id=$1", [productId]),
      /productos_stock_nonnegative_check/,
    )
    assert.equal(await getProductStock(db, productId), 0, "el intento rechazado no dejó nada escrito")
  } finally {
    await db.close()
  }
})

test("B. UPDATE directo a producto_variantes.stock = -1 -- rechazado por la DB", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const variantId = await createVariant(db, productId)
    await assert.rejects(
      db.query("update producto_variantes set stock=-1 where id=$1", [variantId]),
      /INVENTORY_STOCK_IS_DERIVED/,
    )
    await db.query("select set_config('beyonix.inventory_refresh','on',false)")
    await assert.rejects(
      db.query("update producto_variantes set stock=-1 where id=$1", [variantId]),
      /producto_variantes_stock_nonnegative_check/,
    )
  } finally {
    await db.close()
  }
})

// --- C/D: checkout y concurrencia (punto 3, audit-only) ---

test("C. checkout que intenta consumir más stock que el disponible -- rechazado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 2)

    await assert.rejects(
      db.query(
        "select validate_checkout_inventory_reservation($1::jsonb, $2, $3)",
        [JSON.stringify([{ product_id: productId, quantity: 3 }]), "session-overselling-attempt", 999],
      ),
      /CHECKOUT_ITEMS_INVALID/, // falla antes: la orden 999 no existe en este fixture
    )

    // Con una orden real de por medio, el rechazo correcto es por stock.
    const orderId = await createOrder(db, "pendiente")
    await assert.rejects(
      db.query(
        "select validate_checkout_inventory_reservation($1::jsonb, $2, $3)",
        [JSON.stringify([{ product_id: productId, quantity: 3 }]), "session-overselling-attempt", orderId],
      ),
      /CHECKOUT_STOCK_INSUFFICIENT/,
    )
    assert.equal(await getProductStock(db, productId), 2, "el intento fallido no descontó nada")
  } finally {
    await db.close()
  }
})

test("D. dos operaciones compitiendo por la última unidad -- nunca terminan en negativo", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 1)

    const orderA = await createOrder(db, "pendiente")
    const orderB = await createOrder(db, "pendiente")

    const resultA = await db.query<{ result: { validated: boolean } }>(
      "select validate_checkout_inventory_reservation($1::jsonb, $2, $3) as result",
      [JSON.stringify([{ product_id: productId, quantity: 1 }]), "session-a-last-unit-00", orderA],
    )
    assert.equal(resultA.rows[0].result.validated, true)

    // B pide la misma unidad ya reservada por A -- debe fallar, nunca
    // "ganar" ni dejar el producto en negativo.
    await assert.rejects(
      db.query(
        "select validate_checkout_inventory_reservation($1::jsonb, $2, $3)",
        [JSON.stringify([{ product_id: productId, quantity: 1 }]), "session-b-last-unit-00", orderB],
      ),
      /CHECKOUT_STOCK_INSUFFICIENT/,
    )

    assert.equal(await getProductStock(db, productId), 1, "el stock físico nunca se toca en el checkout")
    const reservations = await db.query<{ count: string }>(
      "select count(*)::text as count from stock_reservations where product_id=$1",
      [productId],
    )
    assert.equal(reservations.rows[0].count, "1", "sólo A quedó con una reserva activa")
  } finally {
    await db.close()
  }
})

// --- E: cancelación paga (puntos 2 y 5) ---

test("E. cancelación de un pedido pagado -- el stock vuelve exactamente una vez", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 5)

    const orderId = await createOrder(db, "pagado", "approved")
    await createOrderItem(db, orderId, productId, null, 2)
    assert.equal(await getProductStock(db, productId), 3, "la venta descontó 2 unidades")

    await db.query("update ordenes set estado='cancelado' where id=$1", [orderId])
    assert.equal(await getProductStock(db, productId), 5, "cancelar devolvió exactamente las 2 unidades")

    // Reintento del mismo cambio de estado (doble click / cron + manual) --
    // el trigger detecta que inventory_order_consumes_stock no cambió
    // (false -> false) y no vuelve a tocar nada; el recompute además es
    // idempotente (recalcula el total, no aplica un delta), así que aunque
    // se disparara de nuevo el resultado sería el mismo.
    await db.query("update ordenes set estado='cancelado' where id=$1", [orderId])
    assert.equal(await getProductStock(db, productId), 5, "el segundo intento no duplicó la devolución")
  } finally {
    await db.close()
  }
})

// --- F/G/H: devoluciones físicas (auditoría, sin cambios de código) ---

test("F. devolución de producto sano -- vuelve al stock vendible", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 5)
    const orderId = await createOrder(db, "entregado", "approved")
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    assert.equal(await getProductStock(db, productId), 3)

    await db.query(
      "select process_order_item_return_inventory($1, $2, $3, $4, $5, $6)",
      [orderId, itemId, 2, 0, null, admin],
    )
    assert.equal(await getProductStock(db, productId), 5, "las 2 unidades sanas vuelven a stock vendible")
  } finally {
    await db.close()
  }
})

test("G. devolución de producto roto -- NO vuelve al stock vendible", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 5)
    const orderId = await createOrder(db, "entregado", "approved")
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    assert.equal(await getProductStock(db, productId), 3)

    await db.query(
      "select process_order_item_return_inventory($1, $2, $3, $4, $5, $6)",
      [orderId, itemId, 0, 2, "Llegó roto de fábrica", admin],
    )
    assert.equal(await getProductStock(db, productId), 3, "el producto roto se dio de baja, nunca vuelve a vender")

    const movements = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movements.rows[0].count, "0", "no se crea ningún movimiento de reingreso para lo roto")
  } finally {
    await db.close()
  }
})

test("H. la misma devolución procesada dos veces -- el stock no aumenta dos veces", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    await seedStock(db, productId, null, 5)
    const orderId = await createOrder(db, "entregado", "approved")
    const itemId = await createOrderItem(db, orderId, productId, null, 2)

    await db.query(
      "select process_order_item_return_inventory($1, $2, $3, $4, $5, $6)",
      [orderId, itemId, 2, 0, null, admin],
    )
    assert.equal(await getProductStock(db, productId), 5)

    await assert.rejects(
      db.query(
        "select process_order_item_return_inventory($1, $2, $3, $4, $5, $6)",
        [orderId, itemId, 2, 0, null, admin],
      ),
      /ya fue registrada/,
    )
    assert.equal(await getProductStock(db, productId), 5, "el segundo intento no sumó stock de nuevo")
  } finally {
    await db.close()
  }
})

// --- I: ajuste manual (auditoría, sin cambios de código) ---

test("I. ajuste manual que llevaría el stock a negativo -- rechazado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const variantId = await createVariant(db, productId)
    await seedStock(db, productId, variantId, 3)
    assert.equal(await getVariantStock(db, variantId), 3)

    await assert.rejects(
      db.query(
        "select adjust_variant_stock_idempotent($1, $2, $3, $4, $5)",
        [variantId, -1, "corrección de inventario", admin, "adjust-negative-attempt-001"],
      ),
      /no puede ser negativa/,
    )
    assert.equal(await getVariantStock(db, variantId), 3, "el intento rechazado no modificó el stock")
  } finally {
    await db.close()
  }
})

// --- Regresión: refresh_inventory_stock fail-closed (punto 2) ---

test("refresh_inventory_stock: si el ledger queda corrupto (negativo), aborta con excepción en vez de pisar con 0", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    // Simula corrupción real del ledger: una "compra" con cantidad negativa
    // que nadie debería poder cargar por las validaciones normales de
    // save_product_purchase_idempotent (fuera de alcance de esta fase),
    // pero que si llegara a existir, refresh_inventory_stock no debe
    // esconder silenciosamente.
    await db.query(
      "insert into product_cost_entries (product_id, variant_id, received_quantity) values ($1, null, $2)",
      [productId, -5],
    )
    // Dos capas de defensa activas a la vez (esta fase agrega ambas): el
    // CHECK stock>=0 (punto 1) actúa DENTRO del mismo UPDATE de
    // refresh_inventory_stock (apenas se intenta escribir el -5), así que
    // en la práctica gana la carrera contra el chequeo manual posterior de
    // la función (punto 2) -- ambas capas abortan igual toda la operación,
    // ninguna dejaría el -5 escrito ni lo disimularía con un GREATEST(0,...).
    await assert.rejects(
      db.query("select refresh_inventory_stock($1)", [productId]),
      /INVENTORY_CORRUPTION_NEGATIVE_STOCK|productos_stock_nonnegative_check/,
    )
    // La excepción abortó toda la operación: nunca queda el -5 escrito.
    assert.equal(await getProductStock(db, productId), 0, "no quedó ningún negativo escrito")
  } finally {
    await db.close()
  }
})

test("refresh_inventory_stock: el chequeo fail-closed propio funciona incluso SIN el CHECK constraint (defensa en profundidad real, no una sola capa)", async () => {
  const db = await setup({ withCheckConstraint: false })
  try {
    const productId = await createProduct(db)
    await db.query(
      "insert into product_cost_entries (product_id, variant_id, received_quantity) values ($1, null, $2)",
      [productId, -5],
    )
    await assert.rejects(
      db.query("select refresh_inventory_stock($1)", [productId]),
      /INVENTORY_CORRUPTION_NEGATIVE_STOCK/,
    )
    assert.equal(await getProductStock(db, productId), 0)
  } finally {
    await db.close()
  }
})
