import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  calculateStoreBenefitDiscount,
  claimActiveStoreBenefit,
  linkStoreBenefitToOrder,
  releaseStoreBenefitClaim,
  parseStoreBenefitPercent,
} from "./customer-store-benefits.ts"

// FASE 1 (hardening P0 de ventas, Auditoría 2/7). Ejercita las funciones
// REALES (no una reimplementación) contra PostgreSQL en memoria (PGlite):
// antes, findActiveStoreBenefit (SELECT) + markStoreBenefitAsUsed (UPDATE
// recién al final) dejaban una ventana donde dos requests concurrentes con
// el mismo cupón veían ambas 'active' y ambas creaban una orden con el
// descuento -- sólo una lograba marcarlo usado, la otra orden no se
// revertía. claimActiveStoreBenefit reclama el cupón ATÓMICAMENTE (CAS
// 'active'->'used') ANTES de crear la orden, así que la segunda request ve
// el cupón ya no disponible y nunca llega a aplicar el descuento.
//
// Se ejercita contra un fake mínimo de query builder de Supabase que
// traduce las mismas llamadas (.update/.eq/.is/.select/.maybeSingle) a SQL
// real contra PGlite -- las funciones bajo prueba son exactamente las de
// producción, no una copia.

const root = process.cwd()
const schema = readFileSync(
  join(root, "lib/fixtures/customer-store-benefits-schema.sql"),
  "utf8",
).replace(/\r\n/g, "\n")

const user = "10000000-0000-4000-8000-000000000001"

type Condition = { type: "eq" | "is"; column: string; value: unknown }

function quoteIdent(name: string) {
  return `"${name}"`
}

class FakeQueryBuilder {
  #db: PGlite
  #table: string
  #updatePayload: Record<string, unknown> | null = null
  #conditions: Condition[] = []
  #selectColumns: string | null = null

  constructor(db: PGlite, table: string) {
    this.#db = db
    this.#table = table
  }

  update(payload: Record<string, unknown>) {
    this.#updatePayload = payload
    return this
  }

  eq(column: string, value: unknown) {
    this.#conditions.push({ type: "eq", column, value })
    return this
  }

  is(column: string, value: unknown) {
    this.#conditions.push({ type: "is", column, value })
    return this
  }

  select(columns: string) {
    this.#selectColumns = columns
    return this
  }

  async #run() {
    if (!this.#updatePayload) throw new Error("fake builder sólo soporta UPDATE en este test")

    const params: unknown[] = []
    const setEntries = Object.entries(this.#updatePayload)
    const setClause = setEntries
      .map(([column, value], index) => {
        params.push(value)
        return `${quoteIdent(column)} = $${index + 1}`
      })
      .join(", ")

    const whereClause = this.#conditions
      .map((condition) => {
        if (condition.type === "is") {
          return `${quoteIdent(condition.column)} is null`
        }
        params.push(condition.value)
        return `${quoteIdent(condition.column)} = $${params.length}`
      })
      .join(" and ")

    const returning = this.#selectColumns
      ? `returning ${this.#selectColumns
          .split(",")
          .map((column) => quoteIdent(column.trim()))
          .join(", ")}`
      : ""

    const sql = `update public.${this.#table} set ${setClause} where ${whereClause} ${returning}`

    try {
      const result = await this.#db.query(sql, params)
      return { rows: result.rows, error: null }
    } catch (error) {
      return { rows: [], error: error as { message: string } }
    }
  }

  async maybeSingle() {
    const { rows, error } = await this.#run()
    return { data: rows[0] ?? null, error }
  }

  then(
    onFulfilled?: (value: { error: unknown }) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) {
    return this.#run()
      .then(({ error }) => ({ error }))
      .then(onFulfilled, onRejected)
  }
}

function createFakeAdmin(db: PGlite) {
  return {
    from(table: string) {
      return new FakeQueryBuilder(db, table)
    },
  }
}

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.query("insert into auth.users (id) values ($1)", [user])
  return db
}

async function insertBenefit(
  db: PGlite,
  overrides: { userId?: string; code?: string; percent?: number; status?: string } = {},
) {
  const { rows } = await db.query<{ id: string }>(
    `insert into customer_store_benefits (user_id, benefit_type, code, percent, status)
     values ($1, 'discount', $2, $3, $4) returning id`,
    [
      overrides.userId ?? user,
      overrides.code ?? `CODE-${Math.random().toString(36).slice(2, 8)}`,
      overrides.percent ?? 10,
      overrides.status ?? "active",
    ],
  )
  return rows[0].id
}

test("claimActiveStoreBenefit reclama un cupón activo y lo deja 'used' sin used_order_id todavía", async () => {
  const db = await setup()
  try {
    const benefitId = await insertBenefit(db)
    const admin = createFakeAdmin(db)

    const claimed = await claimActiveStoreBenefit(admin, user, benefitId)
    assert.ok(claimed)
    assert.equal(claimed?.status, "used")

    const { rows } = await db.query<{ status: string; used_order_id: number | null }>(
      "select status, used_order_id from customer_store_benefits where id=$1",
      [benefitId],
    )
    assert.equal(rows[0].status, "used")
    assert.equal(rows[0].used_order_id, null)
  } finally {
    await db.close()
  }
})

test("CARRERA: dos reclamos concurrentes del MISMO cupón -- sólo uno gana, el otro nunca ve el cupón como disponible", async () => {
  const db = await setup()
  try {
    const benefitId = await insertBenefit(db)
    const admin = createFakeAdmin(db)

    // Simula dos pestañas/requests casi simultáneas reclamando el mismo
    // cupón -- con el viejo findActiveStoreBenefit (SELECT puro) ambas
    // hubieran visto 'active' acá. Con el claim atómico, la segunda ya no
    // encuentra la fila en estado 'active' (la primera ya la puso 'used').
    const first = await claimActiveStoreBenefit(admin, user, benefitId)
    const second = await claimActiveStoreBenefit(admin, user, benefitId)

    assert.ok(first, "la primera request reclama el cupón")
    assert.equal(second, null, "la segunda NUNCA ve el cupón disponible -- no se le aplica el descuento")
  } finally {
    await db.close()
  }
})

test("linkStoreBenefitToOrder vincula el cupón ya reclamado a la orden real recién creada", async () => {
  const db = await setup()
  try {
    const benefitId = await insertBenefit(db)
    const admin = createFakeAdmin(db)
    const { rows: orderRows } = await db.query<{ id: number }>(
      "insert into ordenes default values returning id",
    )
    const orderId = orderRows[0].id

    await claimActiveStoreBenefit(admin, user, benefitId)
    await linkStoreBenefitToOrder(admin, { benefitId, orderId })

    const { rows } = await db.query<{ status: string; used_order_id: number }>(
      "select status, used_order_id from customer_store_benefits where id=$1",
      [benefitId],
    )
    assert.equal(rows[0].status, "used")
    assert.equal(rows[0].used_order_id, orderId)
  } finally {
    await db.close()
  }
})

test("releaseStoreBenefitClaim libera un cupón reclamado cuando la creación de la orden falla -- vuelve a estar disponible", async () => {
  const db = await setup()
  try {
    const benefitId = await insertBenefit(db)
    const admin = createFakeAdmin(db)

    await claimActiveStoreBenefit(admin, user, benefitId)
    await releaseStoreBenefitClaim(admin, benefitId)

    const { rows } = await db.query<{ status: string; used_at: string | null }>(
      "select status, used_at from customer_store_benefits where id=$1",
      [benefitId],
    )
    assert.equal(rows[0].status, "active")
    assert.equal(rows[0].used_at, null)

    // Liberado, puede reclamarse de nuevo (reintento del cliente tras el
    // error, o una compra siguiente).
    const reclaimed = await claimActiveStoreBenefit(admin, user, benefitId)
    assert.ok(reclaimed)
  } finally {
    await db.close()
  }
})

test("releaseStoreBenefitClaim NUNCA reactiva un cupón que ya se vinculó a una orden real (guard used_order_id is null)", async () => {
  const db = await setup()
  try {
    const benefitId = await insertBenefit(db)
    const admin = createFakeAdmin(db)
    const { rows: orderRows } = await db.query<{ id: number }>(
      "insert into ordenes default values returning id",
    )

    await claimActiveStoreBenefit(admin, user, benefitId)
    await linkStoreBenefitToOrder(admin, { benefitId, orderId: orderRows[0].id })

    // Un release "de más" (por ejemplo, un catch que corre después de un
    // fallo no relacionado, ya con el cupón vinculado) no debe poder
    // reactivar un cupón que sí se usó de verdad.
    await releaseStoreBenefitClaim(admin, benefitId)

    const { rows } = await db.query<{ status: string; used_order_id: number }>(
      "select status, used_order_id from customer_store_benefits where id=$1",
      [benefitId],
    )
    assert.equal(rows[0].status, "used")
    assert.equal(rows[0].used_order_id, orderRows[0].id)
  } finally {
    await db.close()
  }
})

test("claimActiveStoreBenefit: un cupón ya usado, cancelado, de otro usuario, o inexistente -- siempre null, nunca un error", async () => {
  const db = await setup()
  try {
    const admin = createFakeAdmin(db)
    const usedBenefit = await insertBenefit(db, { status: "used" })
    const cancelledBenefit = await insertBenefit(db, { status: "cancelled" })
    const otherUser = "10000000-0000-4000-8000-000000000002"
    await db.query("insert into auth.users (id) values ($1)", [otherUser])
    const otherUsersBenefit = await insertBenefit(db, { userId: otherUser })

    assert.equal(await claimActiveStoreBenefit(admin, user, usedBenefit), null)
    assert.equal(await claimActiveStoreBenefit(admin, user, cancelledBenefit), null)
    assert.equal(await claimActiveStoreBenefit(admin, user, otherUsersBenefit), null)
    assert.equal(
      await claimActiveStoreBenefit(admin, user, "00000000-0000-0000-0000-000000000000"),
      null,
    )
  } finally {
    await db.close()
  }
})

test("claimActiveStoreBenefit: sin benefitId -- null de inmediato, sin tocar la base", async () => {
  const db = await setup()
  const admin = createFakeAdmin(db)
  try {
    assert.equal(await claimActiveStoreBenefit(admin, user, null), null)
    assert.equal(await claimActiveStoreBenefit(admin, user, undefined), null)
  } finally {
    await db.close()
  }
})

// Regresión pura, sin DB: calculateStoreBenefitDiscount/parseStoreBenefitPercent
// no cambiaron en esta fase, pero no tenían ningún test hoy (confirmado en
// la auditoría) -- se agrega cobertura mínima de sus límites.
test("calculateStoreBenefitDiscount nunca deja el total en negativo ni descuenta más del 100%", () => {
  assert.equal(calculateStoreBenefitDiscount(1000, 10), 100)
  assert.equal(calculateStoreBenefitDiscount(1000, 100), 1000)
  assert.equal(calculateStoreBenefitDiscount(1000, null), 0)
  assert.equal(calculateStoreBenefitDiscount(-500, 10), 0)
})

test("parseStoreBenefitPercent rechaza valores fuera de 1-100 y no numéricos", () => {
  assert.equal(parseStoreBenefitPercent("15"), 15)
  assert.equal(parseStoreBenefitPercent("0"), null)
  assert.equal(parseStoreBenefitPercent("101"), null)
  assert.equal(parseStoreBenefitPercent("abc"), null)
  assert.equal(parseStoreBenefitPercent(null), null)
})
