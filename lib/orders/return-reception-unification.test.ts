import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Auditoría 4/7 (devoluciones), Fase 5. Ejercita las RPCs SQL REALES (no una
// reimplementación) contra PostgreSQL en memoria (PGlite): la autoridad
// única de recepción física (record_order_item_return_reception) y su
// wrapper de reclamos (process_claim_return_inventory) -- ver
// 20260920100000_inventory_return_movements_reproducibility.sql y
// 20260920110000_unify_return_reception_rpc.sql. Sin red, credenciales ni
// datos reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/orders/fixtures/return-reception-schema.sql")
const reproducibility = read(
  "supabase/migrations/20260920100000_inventory_return_movements_reproducibility.sql",
)
const unifiedRpc = read("supabase/migrations/20260920110000_unify_return_reception_rpc.sql")

const superAdmin = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(reproducibility)
  await db.exec(unifiedRpc)

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

async function createProduct(db: PGlite, overrides: { activo?: boolean } = {}) {
  const { rows } = await db.query<{ id: number }>(
    "insert into productos (activo) values ($1) returning id",
    [overrides.activo ?? true],
  )
  return rows[0].id
}

async function createVariant(db: PGlite, productId: number) {
  const { rows } = await db.query<{ id: number }>(
    "insert into producto_variantes (producto_id) values ($1) returning id",
    [productId],
  )
  return rows[0].id
}

async function createOrder(db: PGlite) {
  const { rows } = await db.query<{ id: number }>(
    "insert into ordenes default values returning id",
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

async function createFormalClaim(
  db: PGlite,
  orderId: number,
  affectedItems: Array<{ order_item_id: number; quantity: number }>,
) {
  const { rows } = await db.query<{ id: number }>(
    "insert into order_claims (order_id, failure_type, affected_items) values ($1, 'danado', $2::jsonb) returning id",
    [orderId, JSON.stringify(affectedItems)],
  )
  return rows[0].id
}

async function getItem(db: PGlite, itemId: number) {
  const { rows } = await db.query<{
    return_restocked_quantity: number
    return_written_off_quantity: number
    return_inventory_processed_at: string | null
  }>(
    "select return_restocked_quantity, return_written_off_quantity, return_inventory_processed_at from orden_items where id=$1",
    [itemId],
  )
  return rows[0]
}

test("A. devolución completa sana: vuelve al stock, queda procesada", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, "todo sano", superAdmin, "attempt-a-1"],
    )

    const item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2)
    assert.equal(item.return_written_off_quantity, 0)
    assert.ok(item.return_inventory_processed_at)

    const { rows: movement } = await db.query<{ sellable_quantity: number }>(
      "select sellable_quantity from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movement[0].sellable_quantity, 2)
  } finally {
    await db.close()
  }
})

test("B. devolución completa rota: NO vuelve al stock, pero SÍ queda una fila en el ledger (write-off visible para reconciliación)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,0,2,$4,$5,$6)",
      [claimId, orderId, itemId, "llegó roto", superAdmin, "attempt-b-1"],
    )

    const item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 0)
    assert.equal(item.return_written_off_quantity, 2)

    const { rows: movement } = await db.query<{
      sellable_quantity: number
      non_sellable_quantity: number
    }>(
      "select sellable_quantity, non_sellable_quantity from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movement.length, 1, "el write-off ahora SÍ genera fila en el ledger (P2 cerrado)")
    assert.equal(movement[0].sellable_quantity, 0)
    assert.equal(movement[0].non_sellable_quantity, 2)
  } finally {
    await db.close()
  }
})

test("C/D. 2 sanas + 1 rota en un mismo evento: stock vendible +2, 1 excluida", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 3)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 3 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,1,$4,$5,$6)",
      [claimId, orderId, itemId, "una rota", superAdmin, "attempt-c-1"],
    )

    const item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2)
    assert.equal(item.return_written_off_quantity, 1)

    const stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 2, "sólo las 2 sanas suman al stock vendible")
  } finally {
    await db.close()
  }
})

test("E/J. dos devoluciones parciales sucesivas: 5 vendidas, devuelve 2, después 1 más = 3 acumuladas; un tercer intento de 3 más se rechaza", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 5)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 5 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-e-1"],
    )
    let item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2)

    // Segunda devolución parcial sobre el MISMO ítem -- antes del rediseño
    // esto se rechazaba con "ya fue registrada"; ahora debe permitirse
    // porque queda remanente (5 - 2 = 3).
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,1,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-e-2"],
    )
    item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 3, "total acumulado 2+1=3")

    // Tercer intento: pedir 3 más excede el remanente (5-3=2) -- debe
    // rechazarse.
    await assert.rejects(
      db.query(
        "select process_claim_return_inventory($1,$2,$3,3,0,$4,$5,$6)",
        [claimId, orderId, itemId, null, superAdmin, "attempt-e-3"],
      ),
      /CLAIM_INVALID_ITEMS|RETURN_EXCEEDS_REMAINING/,
    )
    item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 3, "el intento rechazado no modificó nada")
  } finally {
    await db.close()
  }
})

test("F. intento de devolver más que lo vendido se rechaza", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    await assert.rejects(
      db.query(
        "select process_claim_return_inventory($1,$2,$3,3,0,$4,$5,$6)",
        [claimId, orderId, itemId, null, superAdmin, "attempt-f-1"],
      ),
      /CLAIM_INVALID_ITEMS/,
    )
  } finally {
    await db.close()
  }
})

test("G. doble procesamiento -- Vía A (reclamo) y luego Vía B (equivalente a credit-note) sobre el MISMO ítem: la segunda respeta el remanente, nunca duplica más allá de lo vendido", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    // Vía A: reclamo procesa 2 unidades completas.
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-g-1"],
    )

    // Vía B: credit-note/route.ts llama directo a
    // record_order_item_return_reception (mismo mecanismo que usa el
    // wrapper de reclamos) -- con su propia idempotency key
    // ("credit-note-item:X"). Como ya no queda remanente (2 de 2), se
    // rechaza -- no duplica el reingreso a stock.
    await assert.rejects(
      db.query(
        "select record_order_item_return_reception($1,$2,2,0,0,$3,$4)",
        [orderId, itemId, "credit-note-item:99", superAdmin],
      ),
      /RETURN_EXCEEDS_REMAINING/,
    )

    const stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 2, "el stock no se duplicó por el segundo camino")
  } finally {
    await db.close()
  }
})

test("H. orden inverso: Vía B (equivalente a credit-note) recibe primero, Vía A (reclamo) después respeta lo ya recibido", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    // Vía B primero (como haría credit-note/route.ts).
    await db.query(
      "select record_order_item_return_reception($1,$2,2,0,0,$3,$4)",
      [orderId, itemId, "credit-note-item:1", superAdmin],
    )
    const item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2, "Vía B ya dejó el agregado en orden_items")

    // Vía A después, mismo ítem: no queda remanente -- se rechaza, no
    // duplica. El pre-chequeo de process_claim_return_inventory compara
    // contra lo RECLAMADO (2 de 2, pasa); la autoridad única es la que
    // finalmente rechaza comparando contra lo ya recibido acumulado.
    await assert.rejects(
      db.query(
        "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
        [claimId, orderId, itemId, null, superAdmin, "attempt-h-1"],
      ),
      /RETURN_EXCEEDS_REMAINING/,
    )

    const stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 2)
  } finally {
    await db.close()
  }
})

test("I. reintento con la MISMA idempotency key (doble click / retry) no duplica -- devuelve el mismo resultado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-i-1"],
    )
    // Mismo idempotency key: reintento seguro, no debe fallar ni duplicar.
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-i-1"],
    )

    const item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2, "el reintento no sumó de nuevo")
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(rows[0].count, "1")
  } finally {
    await db.close()
  }
})

test("J. variant_id real: la devolución de la variante A nunca acredita a la variante B ni al producto padre", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const variantA = await createVariant(db, productId)
    const variantB = await createVariant(db, productId)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, variantA, 2)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 2 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,2,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-j-1"],
    )

    const { rows: movement } = await db.query<{ variant_id: number }>(
      "select variant_id from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movement[0].variant_id, variantA)
    assert.notEqual(movement[0].variant_id, variantB)
  } finally {
    await db.close()
  }
})

test("K. producto archivado: la recepción se procesa igual, el stock derivado se actualiza sin filtrar por activo", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db, { activo: false })
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 1)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 1 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,1,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-k-1"],
    )

    const stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 1)
  } finally {
    await db.close()
  }
})

test("T. auditoría central: cada movimiento de devolución queda en audit_logs con actor y before/after", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 1)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 1 }])

    await db.query(
      "select process_claim_return_inventory($1,$2,$3,1,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "attempt-t-1"],
    )

    const { rows } = await db.query<{
      action: string
      table_name: string
      actor_user_id: string
      before_data: unknown
      after_data: { sellable_quantity?: number } | null
    }>(
      "select action, table_name, actor_user_id, before_data, after_data from audit_logs where table_name='inventory_return_movements'",
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, "INSERT")
    assert.equal(rows[0].before_data, null)
    assert.equal(rows[0].after_data?.sellable_quantity, 1)
  } finally {
    await db.close()
  }
})

// --- Escenario exacto de validación pre-producción (cierre 4/7, sección 2):
// pedido cantidad=5, reclamo por 3, dos recepciones parciales sucesivas
// (1 vendible + 1 rota, después 1 vendible más), un tercer intento se
// rechaza. Mismos números que pidió el cierre, no una variante. ---

test("Validación E2E (sección 2): pedido x5, reclamo x3, recepción parcial A (1 sana + 1 rota), recepción parcial B (1 sana), intento extra rechazado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const orderId = await createOrder(db)
    const itemId = await createOrderItem(db, orderId, productId, null, 5)
    const claimId = await createFormalClaim(db, orderId, [{ order_item_id: itemId, quantity: 3 }])

    // Paso B: primera recepción parcial -- 1 vendible + 1 rota.
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,1,1,$4,$5,$6)",
      [claimId, orderId, itemId, "una llegó rota", superAdmin, "e2e-step-b"],
    )
    let item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 1, "acumulado vendible = 1")
    assert.equal(item.return_written_off_quantity, 1, "acumulado write-off = 1")
    let stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 1, "stock vendible +1")
    let movements = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movements.rows[0].count, "1", "un solo evento, sin duplicación")

    // Paso C: segunda recepción parcial -- 1 vendible más.
    await db.query(
      "select process_claim_return_inventory($1,$2,$3,1,0,$4,$5,$6)",
      [claimId, orderId, itemId, null, superAdmin, "e2e-step-c"],
    )
    item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2, "acumulado vendible = 1+1 = 2")
    assert.equal(item.return_written_off_quantity, 1, "write-off sigue en 1, sin tocarse")
    stock = await db.query<{ stock: number }>("select stock from productos where id=$1", [productId])
    assert.equal(stock.rows[0].stock, 2, "stock vendible acumulado +2")

    // Paso D: recibido acumulado = 3 (1+1+1), igual al reclamo -- un
    // intento de una unidad más se rechaza de forma segura.
    await assert.rejects(
      db.query(
        "select process_claim_return_inventory($1,$2,$3,1,0,$4,$5,$6)",
        [claimId, orderId, itemId, null, superAdmin, "e2e-step-d"],
      ),
      /CLAIM_INVALID_ITEMS|RETURN_EXCEEDS_REMAINING/,
    )
    item = await getItem(db, itemId)
    assert.equal(item.return_restocked_quantity, 2, "el intento rechazado no modificó nada")
    assert.equal(item.return_written_off_quantity, 1)

    // Auditoría: dos eventos de recepción, cada uno con su fila propia --
    // reconstruible.
    movements = await db.query<{ count: string }>(
      "select count(*)::text as count from inventory_return_movements where order_item_id=$1",
      [itemId],
    )
    assert.equal(movements.rows[0].count, "2")
    const auditRows = await db.query<{ count: string }>(
      "select count(*)::text as count from audit_logs where table_name='inventory_return_movements'",
    )
    assert.equal(auditRows.rows[0].count, "2", "cada evento queda auditado por separado")
  } finally {
    await db.close()
  }
})
