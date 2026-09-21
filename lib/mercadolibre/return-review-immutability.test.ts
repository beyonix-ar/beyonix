import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Auditoría 4/7 (devoluciones), Fase 5. Ejercita review_mercadolibre_return
// REAL (no una reimplementación) contra PostgreSQL en memoria (PGlite) --
// control optimista + motivo de corrección obligatorio, ver
// 20260920120000_ml_return_review_immutability.sql. Sin red, credenciales
// ni datos reales.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/orders/fixtures/return-reception-schema.sql")
const reproducibility = read(
  "supabase/migrations/20260920100000_inventory_return_movements_reproducibility.sql",
)
const mlImmutability = read(
  "supabase/migrations/20260920120000_ml_return_review_immutability.sql",
)

const superAdmin = "10000000-0000-4000-8000-000000000001"

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(reproducibility)
  await db.exec(mlImmutability)

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

async function createMlSale(db: PGlite, productId: number, quantity = 2) {
  const { rows } = await db.query<{ id: string }>(
    "insert into mercadolibre_sales (product_id, quantity) values ($1, $2) returning id",
    [productId, quantity],
  )
  return rows[0].id
}

test("L. primera revisión de una devolución de ML: se registra sin necesitar expected_approved_at", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    const { rows } = await db.query<{ approved_at: string; sellable_quantity: number }>(
      "select approved_at, sellable_quantity from review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,null,null)",
      [saleId, superAdmin],
    )
    assert.equal(rows[0].sellable_quantity, 2)
    assert.ok(rows[0].approved_at)
  } finally {
    await db.close()
  }
})

test("primera revisión con expected_approved_at != null se rechaza (no puede haber una revisión previa que no existe)", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    await assert.rejects(
      db.query(
        "select review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,now(),null)",
        [saleId, superAdmin],
      ),
      /ML_RETURN_CONFLICT/,
    )
  } finally {
    await db.close()
  }
})

test("M. corrección legítima: con el approved_at correcto y motivo, se permite reclasificar", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    const first = await db.query<{ approved_at: string }>(
      "select approved_at from review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,null,null)",
      [saleId, superAdmin],
    )
    const approvedAt = first.rows[0].approved_at

    const corrected = await db.query<{ sellable_quantity: number; non_sellable_quantity: number }>(
      "select sellable_quantity, non_sellable_quantity from review_mercadolibre_return($1,2,0,0,2,null,null,'llegó roto en realidad',null,null,$2,$3,'Se había clasificado mal, estaba roto')",
      [saleId, superAdmin, approvedAt],
    )
    assert.equal(corrected.rows[0].sellable_quantity, 0)
    assert.equal(corrected.rows[0].non_sellable_quantity, 2)
  } finally {
    await db.close()
  }
})

test("M. corrección SIN motivo se rechaza -- no se puede pisar en silencio una revisión ya existente", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    const first = await db.query<{ approved_at: string }>(
      "select approved_at from review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,null,null)",
      [saleId, superAdmin],
    )

    await assert.rejects(
      db.query(
        "select review_mercadolibre_return($1,2,0,0,2,null,null,'roto',null,null,$2,$3,null)",
        [saleId, superAdmin, first.rows[0].approved_at],
      ),
      /ML_RETURN_CORRECTION_REASON_REQUIRED/,
    )
  } finally {
    await db.close()
  }
})

test("M. dos admins simultáneos: el segundo, con un approved_at desactualizado (el que vio ANTES de la corrección del primero), recibe conflicto en vez de pisar en silencio", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    // Ambos admins cargan la pantalla con la MISMA revisión inicial.
    const first = await db.query<{ approved_at: string }>(
      "select approved_at from review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,null,null)",
      [saleId, superAdmin],
    )
    const staleApprovedAt = first.rows[0].approved_at

    // Admin A corrige primero -- éxito, approved_at avanza.
    await db.query(
      "select review_mercadolibre_return($1,2,0,0,2,null,null,'roto',null,null,$2,$3,'A: en realidad estaba roto')",
      [saleId, superAdmin, staleApprovedAt],
    )

    // Admin B, todavía con el approved_at VIEJO (no vio la corrección de A),
    // intenta su propia corrección -- debe rechazarse, nunca pisar en
    // silencio lo que A ya guardó.
    await assert.rejects(
      db.query(
        "select review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,$3,'B: para mí estaba sano')",
        [saleId, superAdmin, staleApprovedAt],
      ),
      /ML_RETURN_CONFLICT/,
    )

    // El estado final es el de A, no el de B.
    const { rows } = await db.query<{ sellable_quantity: number; non_sellable_quantity: number }>(
      "select sellable_quantity, non_sellable_quantity from inventory_return_movements where mercadolibre_sale_id=$1",
      [saleId],
    )
    assert.equal(rows[0].sellable_quantity, 0)
    assert.equal(rows[0].non_sellable_quantity, 2)
  } finally {
    await db.close()
  }
})

test("auditoría: cada revisión (alta y corrección) queda en audit_logs, sin duplicar por el trigger genérico", async () => {
  const db = await setup()
  try {
    const productId = await createProduct(db)
    const saleId = await createMlSale(db, productId, 2)

    const first = await db.query<{ approved_at: string }>(
      "select approved_at from review_mercadolibre_return($1,2,2,0,0,null,null,null,null,null,$2,null,null)",
      [saleId, superAdmin],
    )
    await db.query(
      "select review_mercadolibre_return($1,2,0,0,2,null,null,'roto',null,null,$2,$3,'corrección')",
      [saleId, superAdmin, first.rows[0].approved_at],
    )

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from audit_logs where table_name='inventory_return_movements'",
    )
    assert.equal(rows[0].count, "2", "una fila de auditoría por revisión, no dos por la misma (sin duplicar)")
  } finally {
    await db.close()
  }
})
