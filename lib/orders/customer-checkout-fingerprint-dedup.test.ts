import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// FASE 1 (hardening P0 de ventas, Auditoría 2/7). Ejercita el índice único
// parcial REAL (no una reimplementación) que cierra el hueco de "dos
// pestañas del mismo carrito generan dos órdenes reales" -- ver
// lib/orders/checkout-order-creation.ts (computeCustomerCheckoutFingerprint)
// para el cálculo del valor que este índice protege.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n")

const schema = read("lib/orders/fixtures/customer-checkout-fingerprint-dedup-schema.sql")
const migration = read(
  "supabase/migrations/20260918130000_customer_checkout_fingerprint_dedup.sql",
)

async function setup() {
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(migration)
  return db
}

function insertOrder(
  db: PGlite,
  { estado = "pendiente", fingerprint }: { estado?: string; fingerprint: string | null },
) {
  return db.query<{ id: number }>(
    "insert into ordenes (estado, customer_checkout_fingerprint) values ($1, $2) returning id",
    [estado, fingerprint],
  )
}

test("dos órdenes 'pendiente' con el mismo fingerprint -- la segunda es rechazada por el índice único (dos pestañas, mismo carrito)", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { fingerprint: "customer-checkout:v1:aaa" })
    await assert.rejects(
      insertOrder(db, { fingerprint: "customer-checkout:v1:aaa" }),
      /ordenes_customer_checkout_fingerprint_pending_unique/,
    )
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from ordenes where customer_checkout_fingerprint='customer-checkout:v1:aaa'",
    )
    assert.equal(rows[0].count, "1", "sólo una orden real quedó creada")
  } finally {
    await db.close()
  }
})

test("una vez que la primera orden deja de estar 'pendiente' (pagada o cancelada), el mismo fingerprint puede volver a usarse -- no es un bloqueo permanente", async () => {
  const db = await setup()
  try {
    const first = await insertOrder(db, { fingerprint: "customer-checkout:v1:bbb" })
    await db.query("update ordenes set estado='cancelado' where id=$1", [first.rows[0].id])

    // Recompra legítima del mismo carrito, semanas después: no debe chocar
    // contra la orden vieja ya resuelta.
    const second = await insertOrder(db, { fingerprint: "customer-checkout:v1:bbb" })
    assert.ok(second.rows[0].id)

    // Idem para el camino de "pagado" (saldo 100%, que confirma en el mismo
    // request): tampoco debe quedar bloqueado.
    await db.query("update ordenes set estado='pagado' where id=$1", [second.rows[0].id])
    const third = await insertOrder(db, { fingerprint: "customer-checkout:v1:bbb" })
    assert.ok(third.rows[0].id)
  } finally {
    await db.close()
  }
})

test("fingerprints NULL (invitados) nunca chocan entre sí -- múltiples órdenes de invitados pendientes conviven sin problema", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { fingerprint: null })
    await insertOrder(db, { fingerprint: null })
    await insertOrder(db, { fingerprint: null })
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from ordenes where customer_checkout_fingerprint is null",
    )
    assert.equal(rows[0].count, "3")
  } finally {
    await db.close()
  }
})

test("dos usuarios distintos con carritos que producen fingerprints distintos nunca compiten entre sí", async () => {
  const db = await setup()
  try {
    await insertOrder(db, { fingerprint: "customer-checkout:v1:user-a-cart" })
    // No debe rechazar: es un fingerprint distinto (otro usuario/carrito).
    const second = await insertOrder(db, { fingerprint: "customer-checkout:v1:user-b-cart" })
    assert.ok(second.rows[0].id)
  } finally {
    await db.close()
  }
})

test("dos medios de pago distintos (MP y transferencia) para el mismo carrito -- el segundo intento choca igual (el fingerprint no incluye el medio de pago)", async () => {
  const db = await setup()
  try {
    // Simula: create-preference (MP) insertó primero con este fingerprint.
    await insertOrder(db, { fingerprint: "customer-checkout:v1:same-cart" })
    // create-order (transferencia), otra pestaña, mismo carrito -- debe
    // chocar contra la orden de MP, no crear una segunda compra real.
    await assert.rejects(
      insertOrder(db, { fingerprint: "customer-checkout:v1:same-cart" }),
      /ordenes_customer_checkout_fingerprint_pending_unique/,
    )
  } finally {
    await db.close()
  }
})
