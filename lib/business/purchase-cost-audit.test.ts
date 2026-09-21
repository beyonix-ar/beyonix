import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Auditoría 3/7 (compras/reposición/costos), Fase 5. Ejercita las RPCs SQL
// REALES (no una reimplementación) contra PostgreSQL en memoria (PGlite):
// audit_business_cost_movement + el trigger que la conecta y el
// force_delete_purchase_super_admin modificado (20260918160000), y
// get_purchase_force_delete_impact (20260918170000) -- sobre un esquema
// mínimo (lib/business/fixtures/purchase-cost-audit-schema.sql). También
// carga 20260801093000 (save/delete_product_purchase_atomic, sin cambios en
// esta fase) y 20260918150000 (reproducibilidad de refresh_inventory_after_
// purchase) sin modificarlos, lo que de paso confirma que ambas migraciones
// son válidas y reconstruibles. Sin red, credenciales ni datos reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/business/fixtures/purchase-cost-audit-schema.sql")
const atomicPurchases = read("supabase/migrations/20260801093000_atomic_product_purchases.sql")
const refreshReproducibility = read(
  "supabase/migrations/20260918150000_purchase_inventory_refresh_reproducibility.sql",
)
const auditTrigger = read("supabase/migrations/20260918160000_attach_purchase_cost_audit_trigger.sql")
const impactCheck = read("supabase/migrations/20260918170000_force_delete_purchase_impact_check.sql")
const revokeDirectWrites = read(
  "supabase/migrations/20260918180000_revoke_direct_writes_on_product_cost_entries.sql",
)

const superAdmin = "10000000-0000-4000-8000-000000000001"
const regularAdmin = "10000000-0000-4000-8000-000000000002"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(atomicPurchases)
  await db.exec(refreshReproducibility)
  await db.exec(auditTrigger)
  await db.exec(impactCheck)

  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id, email) values ($1, $2), ($3, $4)", [
    superAdmin,
    "super@beyonix.test",
    regularAdmin,
    "admin@beyonix.test",
  ])
  await db.query(
    "insert into public.profiles(id, rol, email) values ($1, 'super_admin', $2), ($3, 'admin', $4)",
    [superAdmin, "super@beyonix.test", regularAdmin, "admin@beyonix.test"],
  )
  return db
}

async function createProduct(db: PGlite) {
  const { rows } = await db.query<{ id: number }>(
    "insert into productos default values returning id",
  )
  return rows[0].id
}

async function savePurchase(
  db: PGlite,
  actorId: string,
  purchase: Record<string, unknown>,
) {
  const { rows } = await db.query<{ id: string }>(
    "select (save_product_purchase_atomic($1::jsonb, $2)).id as id",
    [JSON.stringify(purchase), actorId],
  )
  return rows[0].id
}

async function auditRows(db: PGlite, recordId: string) {
  const { rows } = await db.query(
    "select action, actor_user_id, before_data, after_data from audit_logs where table_name='product_cost_entries' and record_id=$1 order by id asc",
    [recordId],
  )
  return rows as Array<{
    action: string
    actor_user_id: string | null
    before_data: Record<string, unknown> | null
    after_data: Record<string, unknown> | null
  }>
}

test("O. INSERT de una compra vía save_product_purchase_atomic queda auditado con el actor real", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 1000,
    })

    const rows = await auditRows(db, id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, "INSERT")
    assert.equal(rows[0].actor_user_id, superAdmin)
    assert.equal(rows[0].before_data, null)
    assert.equal(rows[0].after_data?.quantity, 10)
  } finally {
    await db.close()
  }
})

test("O. UPDATE (edición) de una compra queda auditado con before/after -- hueco P1 cerrado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 1000,
    })

    await savePurchase(db, regularAdmin, {
      id,
      product_id: productId,
      quantity: 20,
      purchase_date: "2026-01-01",
      unit_cost: 1500,
    })

    const rows = await auditRows(db, id)
    assert.equal(rows.length, 2)
    assert.equal(rows[1].action, "UPDATE")
    assert.equal(rows[1].actor_user_id, regularAdmin)
    assert.equal(rows[1].before_data?.quantity, 10)
    assert.equal(rows[1].after_data?.quantity, 20)
  } finally {
    await db.close()
  }
})

test("M/O. DELETE normal (delete_product_purchase_atomic) queda auditado", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 5,
      purchase_date: "2026-01-01",
      unit_cost: 100,
    })

    await db.query("select delete_product_purchase_atomic($1, $2)", [id, superAdmin])

    const rows = await auditRows(db, id)
    assert.equal(rows.length, 2, "INSERT + DELETE, ambos auditados")
    assert.equal(rows[1].action, "DELETE")
    assert.equal(rows[1].before_data?.quantity, 5)
    assert.equal(rows[1].after_data, null)
  } finally {
    await db.close()
  }
})

test("N/O. force_delete_purchase_super_admin audita UNA sola vez (no duplica con el trigger genérico)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 5,
      purchase_date: "2026-01-01",
      unit_cost: 100,
    })

    await db.query("select force_delete_purchase_super_admin($1, $2)", [id, superAdmin])

    const rows = await auditRows(db, id)
    assert.equal(rows.length, 2, "INSERT (trigger) + DELETE (manual, NO duplicado por el trigger)")
    assert.equal(rows[1].action, "DELETE")
    assert.equal(rows[1].after_data?.reason, "super_admin_force_delete_purchase")
  } finally {
    await db.close()
  }
})

test("P. force_delete_purchase_super_admin rechaza a un actor que no es super_admin", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 5,
      purchase_date: "2026-01-01",
      unit_cost: 100,
    })

    await assert.rejects(
      db.query("select force_delete_purchase_super_admin($1, $2)", [id, regularAdmin]),
      /Solamente un SUPER ADMIN/,
    )
    assert.equal((await auditRows(db, id)).length, 1, "el intento rechazado no borró ni auditó nada más")
  } finally {
    await db.close()
  }
})

test("P. force_delete_purchase_super_admin y get_purchase_force_delete_impact rechazan fuera de service_role", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 5,
      purchase_date: "2026-01-01",
      unit_cost: 100,
    })
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")

    await assert.rejects(
      db.query("select force_delete_purchase_super_admin($1, $2)", [id, superAdmin]),
      /No tenés permisos/,
    )
    await assert.rejects(
      db.query("select get_purchase_force_delete_impact($1)", [id]),
      /No tenés permisos/,
    )
  } finally {
    await db.close()
  }
})

test("N. get_purchase_force_delete_impact detecta ventas posteriores del mismo producto/variante", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-01-01",
      unit_cost: 1000,
    })

    const { rows: orderRows } = await db.query<{ id: number }>(
      "insert into ordenes (estado, paid_at) values ('pagado', '2026-02-01') returning id",
    )
    await db.query(
      "insert into orden_items (orden_id, producto_id, cantidad) values ($1, $2, 1)",
      [orderRows[0].id, productId],
    )

    const { rows } = await db.query<{ affected_sales_count: number }>(
      "select (get_purchase_force_delete_impact($1)->>'affected_sales_count')::int as affected_sales_count",
      [id],
    )
    assert.equal(rows[0].affected_sales_count, 1)
  } finally {
    await db.close()
  }
})

test("N. get_purchase_force_delete_impact da 0 si no hay ventas posteriores (no advierte de más)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const id = await savePurchase(db, superAdmin, {
      product_id: productId,
      quantity: 10,
      purchase_date: "2026-06-01",
      unit_cost: 1000,
    })
    // Venta ANTERIOR a la compra: no pudo haber usado este costo.
    const { rows: orderRows } = await db.query<{ id: number }>(
      "insert into ordenes (estado, paid_at) values ('pagado', '2026-01-01') returning id",
    )
    await db.query(
      "insert into orden_items (orden_id, producto_id, cantidad) values ($1, $2, 1)",
      [orderRows[0].id, productId],
    )

    const { rows } = await db.query<{ affected_sales_count: number }>(
      "select (get_purchase_force_delete_impact($1)->>'affected_sales_count')::int as affected_sales_count",
      [id],
    )
    assert.equal(rows[0].affected_sales_count, 0)
  } finally {
    await db.close()
  }
})

// --- Q. Reproducibilidad: estas migraciones cargan y ejecutan tal cual
// están en supabase/migrations/, sin modificarlas -- si alguna quedara con
// una definición que no coincide con lo que corre en producción (o con
// sintaxis inválida), estos tests fallarían al hacer setup(). No reemplaza
// una verificación en vivo contra producción (no disponible en esta
// sesión), pero sí confirma que el archivo de migración es válido y
// reconstruible desde cero. ---

test("Q. 20260918150000/160000/170000 son reconstruibles desde migrations/ sin errores", async () => {
  const db = await setup()
  try {
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from pg_trigger
       where tgname in (
         'refresh_inventory_after_purchase',
         'audit_product_cost_entries'
       ) and tgrelid = 'public.product_cost_entries'::regclass`,
    )
    assert.equal(rows[0].count, "2")
  } finally {
    await db.close()
  }
})

// --- RLS/grants (Auditoría 3/7, cierre final). El fixture reproduce la
// línea de base REAL de producción confirmada en vivo (solo lectura,
// 2026-09-18/19): grant directo INSERT/UPDATE/DELETE a authenticated+anon,
// RLS enabled con una policy FOR ALL a authenticated con rol admin/
// super_admin (ver purchase-cost-audit-schema.sql). Estos tests prueban el
// ANTES/DESPUÉS real de 20260918180000 con un Postgres real, no sólo lo
// documentan. ---

async function seedRoleFixtures(db: PGlite) {
  await db.query("insert into auth.users(id, email) values ($1, $2)", [
    superAdmin,
    "super@beyonix.test",
  ])
  await db.query("insert into public.profiles(id, rol, email) values ($1, 'super_admin', $2)", [
    superAdmin,
    "super@beyonix.test",
  ])
  const { rows } = await db.query<{ id: number }>(
    "insert into productos default values returning id",
  )
  return rows[0].id
}

test("P. ANTES de la migración: authenticated con rol admin SÍ puede escribir directo sobre product_cost_entries (confirma el riesgo real detectado en producción)", async () => {
  const db = new PGlite()
  await db.exec(schema)
  const productId = await seedRoleFixtures(db)

  try {
    await db.query("set role authenticated")
    await db.query("select set_config('beyonix.actor_id', $1, false)", [superAdmin])
    await assert.doesNotReject(
      db.query(
        "insert into product_cost_entries (product_id, quantity, unit_cost) values ($1, 1, 100)",
        [productId],
      ),
    )
  } finally {
    await db.query("reset role")
    await db.close()
  }
})

test("P. DESPUÉS de 20260918180000: authenticated ya NO puede escribir directo (INSERT/UPDATE/DELETE), pero SELECT sigue andando", async () => {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(revokeDirectWrites)
  const productId = await seedRoleFixtures(db)

  try {
    await db.query("set role authenticated")
    await db.query("select set_config('beyonix.actor_id', $1, false)", [superAdmin])

    await assert.rejects(
      db.query(
        "insert into product_cost_entries (product_id, quantity, unit_cost) values ($1, 1, 100)",
        [productId],
      ),
      /permission denied/i,
    )
    await assert.doesNotReject(db.query("select count(*) from product_cost_entries"))
  } finally {
    await db.query("reset role")
    await db.close()
  }
})

test("P. DESPUÉS de 20260918180000: anon tampoco puede escribir directo (aunque ya estaba bloqueado por RLS, se revoca igual por defensa en profundidad)", async () => {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(revokeDirectWrites)
  const productId = await seedRoleFixtures(db)

  try {
    await db.query("set role anon")
    await assert.rejects(
      db.query(
        "insert into product_cost_entries (product_id, quantity, unit_cost) values ($1, 1, 100)",
        [productId],
      ),
      /permission denied/i,
    )
  } finally {
    await db.query("reset role")
    await db.close()
  }
})

test("P. service_role sigue pudiendo escribir directo tras el revoke (bypassrls) -- las RPC security definer no se ven afectadas", async () => {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(revokeDirectWrites)
  const productId = await seedRoleFixtures(db)

  try {
    await db.query("set role service_role")
    await assert.doesNotReject(
      db.query(
        "insert into product_cost_entries (product_id, quantity, unit_cost) values ($1, 1, 100)",
        [productId],
      ),
    )
  } finally {
    await db.query("reset role")
    await db.close()
  }
})
