import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { CUSTOMER_CLAIM_SYSTEM_KEY_MILESTONES } from "./customer-claim-experience.ts"

// Campana del cliente para los hitos del reclamo, con la cadena REAL de
// migraciones (PGlite): un hito = como máximo UNA notificación, venga de
// Andreani, de una acción de Admin o de un estado forzado; el cierre no repite
// un resultado ya avisado; ver el reclamo no "lee" los hitos.

const customer = "30000000-0000-4000-8000-000000000001"
const admin = "30000000-0000-4000-8000-000000000003"
const superAdmin = "30000000-0000-4000-8000-000000000005"
const BRANCH = "4567"
const MILESTONE_MIGRATION = "20261020130000_claim_customer_milestone_notifications"

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
  "20261019110000_claim_shipment_test_status",
  "20261019111000_claim_test_simulation_provenance",
  "20261019112000_claim_tracking_override_race_guard",
  "20261019120000_claim_policy_consolidation",
  "20261020100000_claim_item_resolutions",
  "20261020110000_claim_item_return_obligation",
  "20261020120000_claim_replacement_status_override",
  MILESTONE_MIGRATION,
  "20261020140000_claim_notification_copy_and_money_dedup",
]

type Db = PGlite
type Row = Record<string, unknown>

async function setup() {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-logistics-schema.sql"))
  for (const name of CHAIN) await db.exec(migration(name))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [superAdmin, "super_admin"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.exec("insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1),(2,1)")
  for (const [variant, stock] of [[1, 5], [2, 3]]) {
    await db.query("select adjust_variant_stock_idempotent($1,$2,'seed de test',$3,$4)", [variant, stock, admin, `seed-variant-${variant}`])
  }
  await db.query(
    "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type) values(9,$1,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio')",
    [customer])
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values(1,9,1,1,1,90000)")
  return db
}

async function createClaim(db: Db) {
  const op = randomUUID()
  await db.query("select begin_order_claim_operation($1,$2,9,$3,'{}','order-claim-evidence')", [op, customer, randomUUID().replaceAll("-", "").repeat(2)])
  const result = await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id",
    [op, customer, JSON.stringify({ problemType: "falla", message: "El producto dejó de funcionar.", items: [{ order_item_id: 1, quantity: 1 }] })])
  return Number(result.rows[0].id)
}

const version = async (db: Db, id: number) =>
  (await db.query<{ v: string }>("select updated_at::text v from order_claims where id=$1", [id])).rows[0].v
const mutate = async (db: Db, id: number, patch: Row) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
const plan = async (db: Db, claimId: number, direction: string) =>
  Number((await db.query<Row>("select * from request_order_claim_logistics($1,$2,$3,null,$4,'Sucursal Once','Av. Pueyrredón 100')",
    [claimId, admin, direction, BRANCH])).rows[0].id)
async function generate(db: Db, legId: number, modality: string, contract: string, envioId: string) {
  const token = randomUUID()
  await db.query("select * from claim_order_claim_shipment_creation($1,$2,'PROD',$3,$4)", [legId, token, modality, contract])
  await db.query("select * from complete_order_claim_shipment_creation($1,$2,$3,$3,'Creada',null)", [legId, token, envioId])
}
const track = (db: Db, legId: number, phase: string, at: string) =>
  db.query("select * from apply_order_claim_shipment_tracking_guarded($1,$2,false,'Estado Andreani',null,'Evento',$3::timestamptz,$3::timestamptz,null)",
    [legId, phase, at])
const reserve = (db: Db, claimId: number) =>
  db.query("select * from create_order_replacement(9,1,2,1,'otra_variante',$1,$2,null,null,$3)", [admin, randomUUID(), claimId])

interface Notification { type: string; title: string; body: string; action_url: string; source_key: string; is_read: boolean }
const notifications = async (db: Db) =>
  (await db.query<Notification>(
    "select type,title,body,action_url,source_key,is_read from customer_notifications where user_id=$1 and type like 'claim_%' order by created_at, source_key",
    [customer])).rows

/** Reclamo de cambio con retiro + inspección y el reenvío generado (en camino). */
async function replacementOnTheWay(db: Db) {
  const id = await createClaim(db)
  await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
  const returnLeg = await plan(db, id, "devolucion")
  await generate(db, returnLeg, "despacho_sucursal", "400042114", "360000000901")
  await track(db, returnLeg, "entregada", "2026-10-18T10:00:00Z")
  await db.query("select register_order_claim_units_arrival($1,$2,'original',1,1,'Llegó al depósito',null,$3)", [id, admin, randomUUID()])
  await db.query("select process_claim_return_inventory($1,9,1,0,1,'Revisado en depósito',$2,$3)", [id, admin, randomUUID()])
  const resend = await plan(db, id, "reemplazo")
  await reserve(db, id)
  await generate(db, resend, "entrega_sucursal", "400042106", "360000000902")
  return { id, resend }
}

test("catálogo de hitos: la base y la vista del cliente usan exactamente las mismas claves", () => {
  const sql = migration(MILESTONE_MIGRATION)
  const fn = sql.slice(sql.indexOf("function public.order_claim_customer_milestone("), sql.indexOf("function public.notify_order_claim_customer_milestone("))
  const fromSql = Object.fromEntries([...fn.matchAll(/when '([a-z_]+)' then '([a-z_]+)'/g)].map((match) => [match[1], match[2]]))
  const fromTs = Object.fromEntries(Object.entries(CUSTOMER_CLAIM_SYSTEM_KEY_MILESTONES).filter(([, milestone]) => milestone))
  assert.deepEqual(fromSql, fromTs)
})

test("CASO A/B: cada hito del circuito genera UNA notificación sin leer con CTA al reclamo; los mensajes automáticos no son 'respuestas'", async () => {
  const db = await setup()
  try {
    const { id, resend } = await replacementOnTheWay(db)
    await track(db, resend, "en_sucursal", "2026-10-20T10:00:00Z")
    await track(db, resend, "entregada", "2026-10-21T10:00:00Z")
    // Andreani repite el evento: nada nuevo.
    await track(db, resend, "entregada", "2026-10-21T11:00:00Z")

    const rows = await notifications(db)
    const updates = rows.filter((row) => row.type === "claim_update")
    assert.deepEqual(updates.map((row) => row.title), [
      "Aprobamos tu reclamo",
      "Llevá el producto a Andreani",
      "Recibimos tu producto",
      "Tu reemplazo está en camino",
      "Tu reemplazo te espera en Andreani",
      "Tu reemplazo fue entregado",
    ], "Andreani 'entregado' + recepción física = un solo 'Recibimos tu producto'")
    assert.ok(updates.every((row) => !row.is_read && row.action_url === "/cuenta/compras/9/ayuda"))
    const delivered = updates.at(-1)!
    assert.equal(delivered.body, "El reemplazo de tu pedido BX-1009 figura como entregado.")
    assert.equal(delivered.source_key, `claim-milestone:${id}:replacement_delivered:${resend}`)
    assert.equal(rows.filter((row) => row.type === "claim_response").length, 0, "ningún mensaje automático se anuncia como respuesta")
    assert.doesNotMatch(JSON.stringify(rows), /Andreani informó|forzad|simulaci|QA|override|super ?admin/i)
  } finally { await db.close() }
})

test("CASO C/D/G: estado forzado ENTREGADO = mismo aviso; Andreani después no duplica; el cierre inmediato no suma spam", async () => {
  const db = await setup()
  try {
    const { id, resend } = await replacementOnTheWay(db)
    await assert.rejects(db.query("select * from force_order_claim_shipment_status($1,$2,'entregada','Entregado según el cliente')", [resend, admin]),
      /CLAIM_SHIPMENT_FORCE_FORBIDDEN/)
    await db.query("select * from force_order_claim_shipment_status($1,$2,'entregada','Entregado según el cliente')", [resend, superAdmin])
    const forced = (await notifications(db)).filter((row) => row.source_key.includes(":replacement_delivered"))
    assert.deepEqual(forced.map(({ title, body, is_read }) => ({ title, body, is_read })), [{
      title: "Tu reemplazo fue entregado",
      body: "El reemplazo de tu pedido BX-1009 figura como entregado.",
      is_read: false,
    }])

    // Andreani informa la entrega después del override: sólo se observa.
    await track(db, resend, "entregada", "2026-10-22T10:00:00Z")
    const before = await notifications(db)
    assert.equal(before.filter((row) => row.source_key.includes(":replacement_delivered")).length, 1)

    // Cierre inmediato: el resultado ya fue avisado.
    await mutate(db, id, { status: "cerrado", resolution: "cambio_producto" })
    assert.deepEqual(await notifications(db), before, "ni 'reclamo resuelto' ni 'respondió' después de 'entregado'")
    assert.doesNotMatch(JSON.stringify(before), /forzad|override|Registramos/i)
  } finally { await db.close() }
})

/** Cierre + mensaje automático en la misma transacción, como en mutate_admin_order_claim. */
const closeWithMessage = (db: Db, claimId: number) => db.transaction(async (tx) => {
  await tx.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [claimId])
  await tx.query("insert into order_claim_messages(claim_id,author_role,message) select $1,'admin',public.order_claim_resolution_message(resolution_summary) from order_claims where id=$1", [claimId])
})

test("CASO E/F: reintegro o saldo ya avisados no se repiten al cerrar; sin aviso previo el cierre lo dice en simple", async () => {
  const db = await setup()
  try {
    const refundClaim = await createClaim(db)
    await db.query("update order_claims set status='reintegro_pendiente', resolution='reintegro_total' where id=$1", [refundClaim])
    await db.query("insert into customer_notifications(user_id,type,title,body,action_url,order_id,source_key) values($1,'order_refunded','Dinero reintegrado','Registramos el reintegro de tu pedido.','/cuenta/compras/9',9,'order:9:refunded')", [customer])
    await closeWithMessage(db, refundClaim)
    assert.equal((await notifications(db)).filter((row) => row.type === "claim_resolved").length, 0, "el reintegro ya está en la campana")
  } finally { await db.close() }

  const db2 = await setup()
  try {
    const creditClaim = await createClaim(db2)
    await db2.query("update order_claims set status='cupon_pendiente', resolution='saldo_a_favor' where id=$1", [creditClaim])
    await closeWithMessage(db2, creditClaim)
    const resolved = (await notifications(db2)).filter((row) => row.type === "claim_resolved")
    assert.deepEqual(resolved.map(({ title, is_read, action_url }) => ({ title, is_read, action_url })), [{
      title: "Tu saldo a favor ya está disponible", is_read: false, action_url: "/cuenta/compras/9/ayuda",
    }])
  } finally { await db2.close() }
})

test("orden inverso: cerrado el reclamo con reintegro/saldo, el aviso financiero posterior no se suma; el uso de saldo sí", async () => {
  const db = await setup()
  try {
    const creditClaim = await createClaim(db)
    await db.query("update order_claims set status='cupon_pendiente', resolution='saldo_a_favor' where id=$1", [creditClaim])
    await closeWithMessage(db, creditClaim)
    await db.query("insert into customer_credit_movements(id,order_id,claim_id,source_type,movement_type) values(501,9,$1,'credit_note','credit'),(502,9,null,'order','debit')", [creditClaim])
    await db.query(`insert into customer_notifications(user_id,type,title,body,action_url,order_id,source_key) values
      ($1,'customer_credit','Saldo a favor acreditado','Se acreditaron $27.900.','/cuenta?tab=saldo',9,'customer-credit:501'),
      ($1,'order_refunded','Saldo acreditado','El saldo de tu pedido ya está disponible.','/cuenta/saldo',9,'financial-resolution:1:credited'),
      ($1,'customer_credit','Saldo a favor usado','Usaste $1.000.','/cuenta?tab=saldo',9,'customer-credit:502')`, [customer])
    const rows = (await db.query<{ type: string; title: string }>(
      "select type,title from customer_notifications where user_id=$1 and type in ('claim_resolved','customer_credit','order_refunded') order by title", [customer])).rows
    assert.deepEqual(rows, [
      { type: "customer_credit", title: "Saldo a favor usado" },
      { type: "claim_resolved", title: "Tu saldo a favor ya está disponible" },
    ])
  } finally { await db.close() }
})

test("reclamo formal recién creado: 'Recibimos tu reclamo' (el texto de ayuda queda para consultas)", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    const started = (await db.query<{ title: string; body: string }>(
      "select title,body from customer_notifications where source_key=$1", [`claim:${id}:created`])).rows
    assert.deepEqual(started, [{ title: "Recibimos tu reclamo", body: "Vamos a revisar tu reclamo del pedido BX-1009 y te avisamos por acá." }])
  } finally { await db.close() }
})

test("rechazo: aviso simple; respuesta escrita: 'respondió' y se lee al ver el reclamo, los hitos no", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "en_revision", admin_response: "¿Nos mandás una foto del daño?", append_message: true })
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    const last = (await db.query<{ created_at: string }>("select max(created_at)::text created_at from order_claim_messages where claim_id=$1", [id])).rows[0]
    await db.query("select mark_order_claim_customer_read($1,$2,$3)", [id, customer, last.created_at])
    const rows = (await notifications(db)).filter((row) => row.type !== "claim_started")
    assert.deepEqual(rows.map(({ type, is_read }) => ({ type, is_read })), [
      { type: "claim_response", is_read: true },
      { type: "claim_update", is_read: false },
    ])
  } finally { await db.close() }

  const db2 = await setup()
  try {
    const rejected = await createClaim(db2)
    await mutate(db2, rejected, { status: "rechazado", resolution: "rechazado", rejection_reason: "El producto presenta daño por mal uso." })
    const notice = (await notifications(db2)).find((row) => row.source_key === `claim-resolved:${rejected}`)
    assert.deepEqual([notice?.title, notice?.body], ["Respondimos tu reclamo", "Entrá para ver la respuesta sobre tu pedido BX-1009."])
  } finally { await db2.close() }
})

test("entrega del reemplazo confirmada fuera de Andreani: mismo aviso, una sola vez", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    // Reserva para un cambio que después se gestiona fuera de Andreani.
    const legId = await plan(db, id, "cambio")
    await reserve(db, id)
    await db.query("select cancel_order_claim_leg($1,$2,'Se gestiona fuera de Andreani')", [legId, admin])
    const reserved = Number((await db.query<{ n: number }>("select count(*)::int n from order_claim_units where claim_id=$1 and role='reemplazo' and location='reservada' and shipment_id is null", [id])).rows[0].n)
    assert.equal(reserved, 1, "reserva sin tramo: la entrega se confirma fuera de Andreani")
    const key = randomUUID()
    await db.query("select confirm_order_claim_replacement_delivered_manually($1,$2,1,1,'Entregado en mano en el local',$3)", [id, admin, key])
    await db.query("select confirm_order_claim_replacement_delivered_manually($1,$2,1,1,'Entregado en mano en el local',$3)", [id, admin, key])
    const delivered = (await notifications(db)).filter((row) => row.source_key === `claim-milestone:${id}:replacement_delivered:manual`)
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].title, "Tu reemplazo fue entregado")
  } finally { await db.close() }
})
