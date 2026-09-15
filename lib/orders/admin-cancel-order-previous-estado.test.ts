import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { ADMIN_ORDER_CANCELLATION_REASONS } from "./admin-order-cancellation-reasons.ts"

// Ejecuta la función SQL REAL de public.admin_cancel_order (no una
// reimplementación) contra PostgreSQL en memoria (PGlite). Carga la
// migración ORIGINAL (20260915120000, ya aplicada en remoto, nunca se
// edita) y DESPUÉS la de fix (20260915130000, CREATE OR REPLACE) para
// reproducir el orden real de aplicación. Sin red, credenciales ni datos
// reales. Mismo patrón que lib/orders/claim-atomic.test.ts y
// lib/mercadopago/order-refund-rpc.test.ts.

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")

const schema = read("lib/orders/fixtures/admin-cancel-order-schema.sql")
const baseMigration = read(
  "supabase/migrations/20260915120000_admin_direct_order_cancellation.sql",
)
const fixMigration = read(
  "supabase/migrations/20260915130000_fix_admin_cancel_order_previous_estado.sql",
)

const admin = "20000000-0000-4000-8000-000000000001"

async function setup(options: { withFix?: boolean } = {}) {
  const { withFix = true } = options
  const db = new PGlite()
  await db.exec(schema)
  await db.exec(baseMigration)
  if (withFix) await db.exec(fixMigration)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.query("insert into auth.users(id,email) values($1,'admin@example.test')", [admin])
  await db.query("insert into profiles(id,email,rol) values($1,'admin@example.test','admin')", [admin])
  return db
}

function cancelOrder(
  db: PGlite,
  orderId: number,
  action: "reject" | "cancel",
  reasonCode = "pago_no_recibido",
  reasonText = "",
) {
  return db.query(
    "select admin_cancel_order($1,$2,$3,$4,$5,$6)",
    [orderId, admin, "admin", action, reasonCode, reasonText],
  )
}

async function lastAuditEvent(db: PGlite, orderId: number) {
  const result = await db.query<{
    action: string
    previous_status: string
    new_status: string
    metadata: { previousEstado?: string; newEstado?: string; reasonCode?: string }
  }>(
    "select action, previous_status, new_status, metadata from order_audit_events where order_id=$1 order by id desc limit 1",
    [orderId],
  )
  return result.rows[0]
}

async function orderRow(db: PGlite, orderId: number) {
  const result = await db.query<{ estado: string; financial_status: string }>(
    "select estado, financial_status from ordenes where id=$1",
    [orderId],
  )
  return result.rows[0]
}

test("1. Rechazar un pedido 'pendiente': order_audit_events.metadata guarda previousEstado='pendiente' y newEstado='cancelado'", async () => {
  const db = await setup()
  try {
    await db.query(
      "insert into ordenes(id, estado, payment_status) values(1, 'pendiente', 'pendiente_comprobante')",
    )
    await cancelOrder(db, 1, "reject")

    const event = await lastAuditEvent(db, 1)
    assert.equal(event.metadata.previousEstado, "pendiente")
    assert.equal(event.metadata.newEstado, "cancelado")
    assert.equal(event.action, "order_rejected_by_admin")

    const order = await orderRow(db, 1)
    assert.equal(order.estado, "cancelado")
  } finally {
    await db.close()
  }
})

test("2. Cancelar un pedido con un estado previo distinto ('pagado', pago confirmado): previousEstado conserva exactamente ese valor, financial_status queda en refund_pending", async () => {
  const db = await setup()
  try {
    await db.query(
      "insert into ordenes(id, estado, payment_status) values(2, 'pagado', 'confirmado')",
    )
    await cancelOrder(db, 2, "cancel")

    const event = await lastAuditEvent(db, 2)
    assert.equal(event.metadata.previousEstado, "pagado")
    assert.equal(event.metadata.newEstado, "cancelado")
    assert.equal(event.action, "order_cancelled_refund_pending")
    assert.equal(event.new_status, "refund_pending")

    const order = await orderRow(db, 2)
    assert.equal(order.estado, "cancelado")
    assert.equal(order.financial_status, "refund_pending")
  } finally {
    await db.close()
  }
})

test("REGRESIÓN: sin el fix (sólo la migración original), el mismo caso reproduce el bug -- previousEstado queda mal (igual a newEstado)", async () => {
  const db = await setup({ withFix: false })
  try {
    await db.query(
      "insert into ordenes(id, estado, payment_status) values(1, 'pendiente', 'pendiente_comprobante')",
    )
    await cancelOrder(db, 1, "reject")

    const event = await lastAuditEvent(db, 1)
    // Esto es EXACTAMENTE el bug reportado: sin el fix, previousEstado no
    // es 'pendiente' -- quedó pisado por el valor post-UPDATE.
    assert.equal(event.metadata.previousEstado, "cancelado")
    assert.notEqual(event.metadata.previousEstado, "pendiente")
  } finally {
    await db.close()
  }
})

test("motivo inválido (fuera de la lista real) es rechazado server-side, no sólo en la ruta TypeScript", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes(id, estado) values(3, 'pendiente')")
    await assert.rejects(
      cancelOrder(db, 3, "reject", "motivo_inventado"),
      /INVALID_REASON/,
    )
    assert.equal(
      (await db.query("select * from order_audit_events where order_id=3")).rows.length,
      0,
    )
  } finally {
    await db.close()
  }
})

test("la lista de motivos validada en SQL es EXACTAMENTE la misma que ADMIN_ORDER_CANCELLATION_REASONS (TS) -- no se inventó ningún motivo nuevo", () => {
  const sqlSection = fixMigration.slice(
    fixMigration.indexOf("v_reason_code not in ("),
    fixMigration.indexOf(")", fixMigration.indexOf("v_reason_code not in (")),
  )
  const sqlCodes = [...sqlSection.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
  const tsCodes = ADMIN_ORDER_CANCELLATION_REASONS.map((r) => r.value)

  assert.deepEqual([...sqlCodes].sort(), [...tsCodes].sort())
})

test("todos los motivos reales de la lista son aceptados por la RPC", async () => {
  const db = await setup()
  try {
    let orderId = 10
    for (const reason of ADMIN_ORDER_CANCELLATION_REASONS) {
      orderId += 1
      await db.query("insert into ordenes(id, estado) values($1, 'pendiente')", [orderId])
      await cancelOrder(
        db,
        orderId,
        "reject",
        reason.value,
        reason.value === "otro" ? "Detalle del motivo otro" : "",
      )
      const event = await lastAuditEvent(db, orderId)
      assert.equal(event.metadata.reasonCode, reason.value)
    }
  } finally {
    await db.close()
  }
})

test("se mantiene intacto: pedido ya facturado sigue bloqueado (factura/CAE nunca se tocan)", async () => {
  const db = await setup()
  try {
    await db.query(
      "insert into ordenes(id, estado, payment_status, invoice_status, invoice_cae) values(4, 'pagado', 'confirmado', 'authorized', 'CAE-TEST')",
    )
    await assert.rejects(cancelOrder(db, 4, "cancel"), /ORDER_ALREADY_INVOICED/)
    const order = await db.query("select estado, invoice_status, invoice_cae from ordenes where id=4")
    assert.deepEqual(order.rows[0], { estado: "pagado", invoice_status: "authorized", invoice_cae: "CAE-TEST" })
  } finally {
    await db.close()
  }
})

test("se mantiene intacto: pedido con tracking (despachado) sigue bloqueado, Andreani/tracking nunca se borra", async () => {
  const db = await setup()
  try {
    await db.query(
      "insert into ordenes(id, estado, payment_status, tracking_number, andreani_envio_id) values(5, 'pagado', 'confirmado', 'TRACK-1', 'ENV-1')",
    )
    await assert.rejects(cancelOrder(db, 5, "cancel"), /ORDER_ALREADY_DISPATCHED/)
    const order = await db.query("select tracking_number, andreani_envio_id from ordenes where id=5")
    assert.deepEqual(order.rows[0], { tracking_number: "TRACK-1", andreani_envio_id: "ENV-1" })
  } finally {
    await db.close()
  }
})

test("se mantiene intacto: Rechazar y Cancelar siguen siendo mutuamente excluyentes según pago confirmado", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes(id, estado) values(6, 'pendiente')")
    await assert.rejects(cancelOrder(db, 6, "cancel"), /ORDER_NOT_PAID_USE_REJECT/)

    await db.query("insert into ordenes(id, estado, payment_status) values(7, 'pagado', 'confirmado')")
    await assert.rejects(cancelOrder(db, 7, "reject"), /ORDER_ALREADY_PAID_USE_CANCEL/)
  } finally {
    await db.close()
  }
})

test("se mantiene intacto: doble cancelación es idempotente -- el segundo intento se rechaza, no se vuelve a auditar", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes(id, estado) values(8, 'pendiente')")
    await cancelOrder(db, 8, "reject")
    await assert.rejects(cancelOrder(db, 8, "reject"), /ORDER_ALREADY_CANCELLED/)

    const events = await db.query("select * from order_audit_events where order_id=8")
    assert.equal(events.rows.length, 1)
  } finally {
    await db.close()
  }
})

test("se mantiene intacto: no toca transfer_matched_payment_id ni ninguna tabla de stock/claims (esas columnas no existen siquiera en el esquema que admin_cancel_order necesita)", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes(id, estado) values(9, 'pendiente')")
    await cancelOrder(db, 9, "reject")
    // Si la función intentara tocar columnas fuera de las que declara este
    // fixture mínimo (deliberadamente sin stock/transferencias/claims), la
    // llamada ya habría fallado con "column does not exist".
    assert.equal((await orderRow(db, 9)).estado, "cancelado")
  } finally {
    await db.close()
  }
})
