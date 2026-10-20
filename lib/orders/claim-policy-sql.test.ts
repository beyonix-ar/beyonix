import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// 20261019120000_claim_policy_consolidation sobre la cadena REAL de
// migraciones de reclamos y el motor REAL de stock (PGlite):
//   * una NC ligada a un reclamo sólo con solución económica;
//   * reemplazo sin devolución (Caso B): dispensa auditada, reserva, VENTA
//     sucursal 400042106, entrega y cierre; idempotente y nunca después de
//     iniciada la devolución.

const customer = "20000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000003"
const operator = "20000000-0000-4000-8000-000000000004"
const BRANCH = "4567"
const NOTE = "Falla de fábrica confirmada, no hace falta que vuelva."

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const migration = (name: string) => source(`../../supabase/migrations/${name}.sql`)

const CHAIN = [
  "20260816120000_atomic_order_claim_cancellation",
  "20260905150000_claims_atomic_operations",
  "20260906090000_claim_case_type_transitions",
  "20260906100000_claims_final_security",
  "20260906110000_claim_credit_note_snapshot",
  "20260920100000_inventory_return_movements_reproducibility",
  "20260920110000_unify_return_reception_rpc",
  "20260920140000_order_replacements",
  "20260922120000_replacement_operation_guard",
  "20260922130000_replacement_admin_audit",
  "20260924150000_claim_product_change_requires_replacement",
  "20260924140000_order_claim_customer_reads",
  "20260924160000_claim_resolution_summary_notifications",
  "20260928100000_claim_andreani_shipments",
  "20260930100000_claim_logistics_branch_only",
  "20261001100000_claim_logistics_hardening",
  "20261001120000_reopen_rejected_order_claim",
  "20261001130000_cancel_order_claim",
  "20261001170000_claim_return_dropoff_copy",
  "20261019120000_claim_policy_consolidation",
  "20261020100000_claim_item_resolutions",
  "20261020110000_claim_item_return_obligation",
]

type Db = PGlite
type Row = Record<string, unknown>

async function setup() {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-logistics-schema.sql"))
  for (const name of CHAIN) await db.exec(migration(name))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [operator, "operador"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.exec("insert into productos(id) values(1),(2); insert into producto_variantes(id,producto_id) values(1,1),(2,1),(3,2)")
  for (const [variant, stock] of [[1, 5], [2, 3], [3, 2]]) {
    await db.query("select adjust_variant_stock_idempotent($1,$2,'seed de test',$3,$4)", [variant, stock, admin, `seed-variant-${variant}`])
  }
  await db.query(
    "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio')",
    [customer])
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values(1,1,1,1,3,30000),(2,1,2,3,1,9000)")
  return db
}

async function createClaim(db: Db, items = [{ order_item_id: 1, quantity: 2 }]) {
  const op = randomUUID()
  await db.query("select begin_order_claim_operation($1,$2,1,$3,'{}','order-claim-evidence')", [op, customer, randomUUID().replaceAll("-", "").repeat(2)])
  const result = await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id",
    [op, customer, JSON.stringify({ problemType: "falla", message: "El producto dejó de funcionar.", items })])
  return Number(result.rows[0].id)
}

const one = async <T extends Row = Row>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const version = async (db: Db, id: number) => String((await one<{ v: string }>(db, "select updated_at::text v from order_claims where id=$1", [id])).v)
const mutate = async (db: Db, id: number, patch: Row) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
const stock = async (db: Db, variant: number) => Number((await one<{ s: number }>(db, "select stock s from producto_variantes where id=$1", [variant])).s)
async function units(db: Db, claimId: number) {
  const rows = (await db.query<{ role: string; location: string; n: number }>(
    "select role, location, count(*)::int n from order_claim_units where claim_id=$1 group by role, location order by role, location", [claimId])).rows
  return Object.fromEntries(rows.map((row) => [`${row.role}:${row.location}`, row.n]))
}
const resendWithoutReturn = async (db: Db, claimId: number, { note = NOTE, actor = admin } = {}) =>
  Number((await one(db, "select * from request_order_claim_resend_without_return($1,$2,$3,$4,'Sucursal Once','Av. Pueyrredón 100')",
    [claimId, actor, note, BRANCH])).id)
const plan = async (db: Db, claimId: number, direction: string) =>
  Number((await one(db, "select * from request_order_claim_logistics($1,$2,$3,null,$4,'Sucursal Once','Av. Pueyrredón 100')",
    [claimId, admin, direction, BRANCH])).id)
const reserve = (db: Db, claimId: number, variant: number, quantity: number, key = randomUUID(), reason = "mismo_producto") =>
  db.query("select * from create_order_replacement(1,1,$1,$2,$3,$4,$5,null,null,$6)", [variant, quantity, reason, admin, key, claimId])
async function generate(db: Db, legId: number, modality: string, contract: string, envioId: string) {
  const token = randomUUID()
  await db.query("select * from claim_order_claim_shipment_creation($1,$2,'PROD',$3,$4)", [legId, token, modality, contract])
  await db.query("select * from complete_order_claim_shipment_creation($1,$2,$3,$3,'Creada',null)", [legId, token, envioId])
}
const track = (db: Db, legId: number, phase: string, event: string, at: string) =>
  db.query("select * from apply_order_claim_shipment_tracking($1,$2,false,'Estado Andreani',null,$3,$4::timestamptz,$4::timestamptz,null)",
    [legId, phase, event, at])
const insertCreditNote = (db: Db, claimId: number) =>
  db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,reason,operation_type,created_by) values(1,$1,'processing','external_refund',1000,'Prueba','devolucion_parcial',$2)",
    [claimId, admin])

test("NC: un reemplazo nunca emite nota de crédito; un reintegro sí", async () => {
  const db = await setup()
  try {
    const replacement = await createClaim(db)
    await mutate(db, replacement, { status: "aprobado", resolution: "cambio_producto" })
    await assert.rejects(insertCreditNote(db, replacement), /CREDIT_NOTE_CLAIM_NOT_FINANCIAL/)
  } finally {
    await db.close()
  }

  const db2 = await setup()
  try {
    const refund = await createClaim(db2)
    await mutate(db2, refund, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await insertCreditNote(db2, refund)
    assert.equal(Number((await one(db2, "select count(*)::int n from order_credit_notes where claim_id=$1", [refund])).n), 1)
  } finally {
    await db2.close()
  }
})

test("CASO B: reemplazo sin devolución -> reserva -> VENTA sucursal -> entrega -> cierre", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_NOT_ALLOWED/, "sin dispensa ni retiro no hay reenvío")
    await assert.rejects(resendWithoutReturn(db, id, { note: "corto" }), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await assert.rejects(resendWithoutReturn(db, id, { actor: operator }), /CLAIM_LOGISTICS_FORBIDDEN/)

    const legId = await resendWithoutReturn(db, id)
    assert.equal(await resendWithoutReturn(db, id), legId, "reintento: mismo tramo, sin efectos dobles")
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2 })
    assert.equal((await one(db, "select direction, status from order_claim_shipments where id=$1", [legId])).direction, "reemplazo")
    assert.equal(Number((await one(db, "select count(*)::int n from order_audit_events where action='claim_original_return_waived'")).n), 1)
    assert.equal(Number((await one(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key='resend_without_return'", [id])).n), 1)
    await assert.rejects(plan(db, id, "devolucion"), /CLAIM_LOGISTICS_NOT_NEEDED|CLAIM_LOGISTICS_OPEN/, "ya no se puede pedir la devolución")

    // Reserva sin recepción previa (el original no vuelve), una sola vez.
    const key = randomUUID()
    await reserve(db, id, 1, 2, key)
    await reserve(db, id, 1, 2, key)
    assert.equal(await stock(db, 1), 3, "descuenta una sola vez")
    await assert.rejects(reserve(db, id, 1, 1), /REPLACEMENT_QUANTITY_EXCEEDED/, "nunca más que lo reclamado")

    await assert.rejects(mutate(db, id, { status: "cerrado", resolution: "cambio_producto" }), /CLAIM_LOGISTICS_OPEN/, "no cierra antes de la entrega")
    await generate(db, legId, "entrega_sucursal", "400042106", "360000000901")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-10-20T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2, "reemplazo:entregada_cliente": 2 })
    await mutate(db, id, { status: "cerrado", resolution: "cambio_producto" })
    const closed = await one<{ status: string; label: string }>(db, "select status, resolution_summary->>'label' label from order_claims where id=$1", [id])
    assert.deepEqual(closed, { status: "cerrado", label: "Reemplazo del producto" })
  } finally {
    await db.close()
  }
})

test("CASO B: no se dispensa la devolución después de iniciarla; sí reemplaza un retiro todavía no generado", async () => {
  const db = await setup()
  try {
    const started = await createClaim(db)
    await mutate(db, started, { status: "aprobado", resolution: "cambio_producto" })
    const returnLeg = await plan(db, started, "devolucion")
    await generate(db, returnLeg, "despacho_sucursal", "400042114", "360000000902")
    await assert.rejects(resendWithoutReturn(db, started), /CLAIM_RETURN_ALREADY_STARTED/)
    assert.equal(Number((await one(db, "select count(*)::int n from order_claim_units where claim_id=$1 and location='conservada_cliente'", [started])).n), 0)
  } finally {
    await db.close()
  }

  const db2 = await setup()
  try {
    const pending = await createClaim(db2)
    await mutate(db2, pending, { status: "aprobado", resolution: "cambio_producto" })
    const returnLeg = await plan(db2, pending, "devolucion")
    const resend = await resendWithoutReturn(db2, pending)
    assert.equal((await one(db2, "select status from order_claim_shipments where id=$1", [returnLeg])).status, "cancelada")
    assert.notEqual(resend, returnLeg)
  } finally {
    await db2.close()
  }
})

test("CASO B: sólo para reemplazo aceptado (no para reintegro)", async () => {
  const db = await setup()
  try {
    const refund = await createClaim(db)
    await mutate(db, refund, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await assert.rejects(resendWithoutReturn(db, refund), /CLAIM_LOGISTICS_NOT_ALLOWED/)
  } finally {
    await db.close()
  }
})
