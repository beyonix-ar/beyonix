import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Logística de postventa con la cadena REAL de migraciones de reclamos y el
// motor REAL de stock (PGlite). Postventa SÓLO por sucursal Andreani y con el
// método elegido explícitamente por el Admin:
//   * Cambio directo (CAMBIO sucursal 400042110);
//   * Retiro + revisión (RETIRO sucursal 400042114) -> inspección -> reenvío
//     a sucursal (VENTA sucursal 400042106).

const customer = "20000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000003"
const admin2 = "20000000-0000-4000-8000-000000000005"
const operator = "20000000-0000-4000-8000-000000000004"
const ACCEPTED = "BEYONIX aceptó el cambio del producto."
const BRANCH = "4567"

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
  // Histórica, ya aplicada en remoto (modelo inicial) + corrección posterior.
  "20260928100000_claim_andreani_shipments",
  "20260930100000_claim_logistics_branch_only",
  "20261001100000_claim_logistics_hardening",
  "20261001120000_reopen_rejected_order_claim",
  "20261001130000_cancel_order_claim",
  // Devolución: sucursal Andreani habilitada + etiqueta (nunca una sucursal fija).
  "20261001170000_claim_return_dropoff_copy",
]

type Db = PGlite
type Row = Record<string, unknown>

// Producto 1 (variantes 1 y 2) y producto 2 (variante 3). Pedido 1 (compra a
// domicilio): ítem 1 = 3 unidades de la variante 1; ítem 2 = 1 de la variante 3.
async function setup({ shipping = "domicilio" } = {}) {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-logistics-schema.sql"))
  for (const name of CHAIN) await db.exec(migration(name))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [admin2, "super_admin"], [operator, "operador"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.exec("insert into productos(id) values(1),(2); insert into producto_variantes(id,producto_id) values(1,1),(2,1),(3,2)")
  for (const [variant, stock] of [[1, 5], [2, 3], [3, 2]]) {
    await db.query("select adjust_variant_stock_idempotent($1,$2,'seed de test',$3,$4)", [variant, stock, admin, `seed-variant-${variant}`])
  }
  await db.query(
    "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,andreani_sucursal_id,andreani_sucursal_nombre) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',90000,$2,$3,$4)",
    [customer, shipping, shipping === "sucursal" ? "10179" : null, shipping === "sucursal" ? "Sucursal Centro" : null])
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values(1,1,1,1,3,30000),(2,1,2,3,1,9000)")
  return db
}

async function createClaim(db: Db, items: Array<{ order_item_id: number; quantity: number }> = [{ order_item_id: 1, quantity: 2 }], problemType = "falla") {
  const op = randomUUID()
  await db.query("select begin_order_claim_operation($1,$2,1,$3,'{}','order-claim-evidence')", [op, customer, randomUUID().replaceAll("-", "").repeat(2)])
  const result = await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id",
    [op, customer, JSON.stringify({ problemType, message: "El producto dejó de funcionar.", items })])
  return Number(result.rows[0].id)
}

const version = async (db: Db, id: number) =>
  (await db.query<{ v: string }>("select updated_at::text v from order_claims where id=$1", [id])).rows[0].v
const mutate = async (db: Db, id: number, patch: Row, actor = admin) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, actor, await version(db, id), JSON.stringify(patch)])
const one = async <T extends Row = Row>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const count = async (db: Db, sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(db, sql, params)).n)
const stock = async (db: Db, variant: number) => Number((await one<{ s: number }>(db, "select stock s from producto_variantes where id=$1", [variant])).s)
const leg = async (db: Db, legId: number) => one(db, "select * from order_claim_shipments where id=$1", [legId])
const messages = async (db: Db, id: number) =>
  (await db.query<{ message: string; system_key: string | null }>(
    "select message, system_key from order_claim_messages where claim_id=$1 and author_role<>'cliente' order by created_at, id", [id])).rows
const keys = async (db: Db, id: number) => (await messages(db, id)).map((row) => row.system_key).filter(Boolean)

/** "rol:ubicación" -> cantidad, opcionalmente para un ítem. */
async function units(db: Db, claimId: number, itemId?: number) {
  const rows = (await db.query<{ role: string; location: string; n: number }>(
    `select role, location, count(*)::int n from order_claim_units where claim_id=$1 ${itemId ? "and order_item_id=$2" : ""}
     group by role, location order by role, location`, itemId ? [claimId, itemId] : [claimId])).rows
  return Object.fromEntries(rows.map((row) => [`${row.role}:${row.location}`, row.n]))
}

async function acceptChange(db: Db, items?: Array<{ order_item_id: number; quantity: number }>) {
  const id = await createClaim(db, items)
  await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
  return id
}

/** Método logístico elegido por el Admin (sucursal verificada por la aplicación). */
async function plan(db: Db, claimId: number, direction: string, { branch = BRANCH as string | null, note = null as string | null, actor = admin } = {}) {
  const row = (await db.query<Row>("select * from request_order_claim_logistics($1,$2,$3,$4,$5,'Sucursal Once','Av. Pueyrredón 100')",
    [claimId, actor, direction, note, branch])).rows[0]
  return Number(row.id)
}
const reserve = (db: Db, claimId: number, itemId: number, variant: number, quantity: number, key = randomUUID(), reason = "mismo_producto") =>
  db.query("select * from create_order_replacement(1,$1,$2,$3,$4,$5,$6,null,null,$7)", [itemId, variant, quantity, reason, admin, key, claimId])
const claimLeg = (db: Db, legId: number, token: string, modality: string, contract: string) =>
  db.query<Row>("select * from claim_order_claim_shipment_creation($1,$2,'PROD',$3,$4)", [legId, token, modality, contract])
const complete = (db: Db, legId: number, token: string, envioId: string) =>
  db.query("select * from complete_order_claim_shipment_creation($1,$2,$3,$3,'Creada',null)", [legId, token, envioId])
async function generate(db: Db, legId: number, modality: string, contract: string, envioId: string) {
  const token = randomUUID()
  const claimed = (await claimLeg(db, legId, token, modality, contract)).rows[0]
  assert.equal(claimed.creation_status, "processing")
  await complete(db, legId, token, envioId)
}
const EXCHANGE = ["cambio_sucursal", "400042110"] as const
const RETURN = ["despacho_sucursal", "400042114"] as const
const RESEND = ["entrega_sucursal", "400042106"] as const
const track = (db: Db, legId: number, phase: string, event: string, at: string, incident = false, review: string | null = null) =>
  db.query("select * from apply_order_claim_shipment_tracking($1,$2,$3,'Estado Andreani',null,$4,$5::timestamptz,$5::timestamptz,$6)",
    [legId, phase, incident, event, at, review])
const arrival = (db: Db, claimId: number, role: string, itemId: number, quantity: number,
  { key = randomUUID(), note = "Llegó al depósito", incidentType = null as string | null, actor = admin } = {}) =>
  db.query("select register_order_claim_units_arrival($1,$2,$3,$4,$5,$6,$7,$8) n", [claimId, actor, role, itemId, quantity, note, incidentType, key])
const inspectOriginal = (db: Db, claimId: number, itemId: number, restock: number, writeOff: number, key = randomUUID()) =>
  db.query("select process_claim_return_inventory($1,1,$2,$3,$4,'Revisado en depósito',$5,$6)", [claimId, itemId, restock, writeOff, admin, key])
const incident = (db: Db, claimId: number, role: string, itemId: number, type: string | null, note: string) =>
  db.query("select set_order_claim_units_incident($1,$2,$3,$4,$5,$6)", [claimId, admin, role, itemId, type, note])
const close = (db: Db, claimId: number) => mutate(db, claimId, { status: "cerrado", resolution: "cambio_producto" })

test("aceptar un reclamo NUNCA abre logística; el Admin elige el método y la sucursal (nunca el cliente ni el sistema)", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const [accepted, packing] = await messages(db, id)
    assert.deepEqual([accepted.message, accepted.system_key, packing.system_key], [ACCEPTED, "change_accepted", "change_packing_instructions"])
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1", [id]), 0)
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1", [id]), 0)
    await assert.rejects(plan(db, id, "cambio", { actor: operator }), /CLAIM_LOGISTICS_FORBIDDEN/)
    await assert.rejects(plan(db, id, "cambio", { actor: customer }), /CLAIM_LOGISTICS_FORBIDDEN/)
    // Compra a domicilio: sin sucursal indicada no hay operación (nunca domicilio).
    await assert.rejects(plan(db, id, "cambio", { branch: null }), /CLAIM_LOGISTICS_BRANCH_REQUIRED/, "la base nunca infiere sucursales")
    await assert.rejects(plan(db, id, "cambio", { branch: "Av. Siempre Viva 742" }), /CLAIM_LOGISTICS_BRANCH_REQUIRED/)
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_NOT_ALLOWED/, "sin retiro ni inspección no hay reenvío")
    const legId = await plan(db, id, "cambio")
    assert.deepEqual([(await leg(db, legId)).branch_id, (await leg(db, legId)).direction], [BRANCH, "cambio"])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_logistics_plan_selected'"), 1)
  } finally {
    await db.close()
  }
})

test("modalidades de domicilio rechazadas por la base en los tres tramos", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    await assert.rejects(claimLeg(db, legId, randomUUID(), "cambio_domicilio", "400042108"), /order_claim_shipments_modality/)
    for (const modality of ["retiro_domicilio", "entrega_domicilio"]) {
      await assert.rejects(db.query("update order_claim_shipments set modality=$1 where id=$2", [modality, legId]), /order_claim_shipments_modality/)
    }
  } finally {
    await db.close()
  }
})

test("CAMBIO DIRECTO por sucursal: reserva -> CAMBIO 400042110 -> intercambio -> recepción -> inspección -> cierre", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2 }, "sólo las 2 unidades reclamadas de 3")
    await assert.rejects(claimLeg(db, legId, randomUUID(), ...EXCHANGE), /CLAIM_SHIPMENT_NOT_READY_RESERVATION/)
    const key = randomUUID()
    await reserve(db, id, 1, 1, 2, key)
    await reserve(db, id, 1, 1, 2, key)
    assert.equal(await stock(db, 1), 3, "salida de stock exactamente una vez (5 - 2)")
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1 and creation_status<>'not_started'", [id]), 0,
      "reservar stock no genera ningún envío")

    await generate(db, legId, ...EXCHANGE, "360000000001")
    let row = await leg(db, legId)
    assert.deepEqual([row.status, row.contract, row.modality, row.branch_id], ["generada", "400042110", "cambio_sucursal", BRANCH])
    assert.match((await messages(db, id)).at(-1)?.message ?? "", /Sucursal Once · Av\. Pueyrredón 100/)
    await assert.rejects(reserve(db, id, 1, 1, 1), /REPLACEMENT_LOGISTICS_LOCKED|REPLACEMENT_QUANTITY_EXCEEDED/)

    await track(db, legId, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2, "reemplazo:en_andreani": 2 })
    assert.equal(await stock(db, 1), 3, "en Andreani sigue fuera del stock vendible")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T15:00:00Z")
    row = await leg(db, legId)
    assert.deepEqual([row.status, row.exchange_outcome, Boolean(row.closed_at)], ["entregada", "completado", true])
    assert.deepEqual(await units(db, id), { "original:en_andreani": 2, "reemplazo:entregada_cliente": 2 })

    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_OPEN/)
    await arrival(db, id, "original", 1, 2)
    assert.deepEqual(await units(db, id), { "original:recibida_beyonix": 2, "reemplazo:entregada_cliente": 2 })
    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_OPEN/, "llegada física != inspección aprobada")
    assert.equal(await stock(db, 1), 3, "la llegada física no toca stock")
    await inspectOriginal(db, id, 1, 1, 1)
    assert.equal(await stock(db, 1), 4, "sólo lo inspeccionado como vendible vuelve al stock")
    await close(db, id)
    assert.deepEqual(await keys(db, id), [
      "change_accepted", "change_packing_instructions", `exchange_generated:${legId}`,
      `exchange_at_branch:${legId}`, `exchange_completed:${legId}`, "original_received",
    ], "mensajes en orden y sin duplicados")
  } finally {
    await db.close()
  }
})

test("CAMBIO: compra a sucursal usa su sucursal; tracking repetido y fuera de orden no retrocede ni duplica", async () => {
  const db = await setup({ shipping: "sucursal" })
  try {
    const id = await acceptChange(db, [{ order_item_id: 2, quantity: 1 }])
    const legId = await plan(db, id, "cambio", { branch: "10179" })
    assert.deepEqual([(await leg(db, legId)).branch_id, (await leg(db, legId)).branch_name], ["10179", "Sucursal Once"],
      "sucursal validada por la aplicación; nombre del catálogo")
    await reserve(db, id, 2, 3, 1)
    await generate(db, legId, ...EXCHANGE, "360000000002")
    await track(db, legId, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T12:00:00Z")
    await track(db, legId, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T12:00:00Z")
    let row = await leg(db, legId)
    assert.equal(new Date(String(row.branch_custody_since)).toISOString(), "2026-09-28T12:00:00.000Z", "fecha de custodia informada, sin inventar el vencimiento")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T12:00:00Z")
    await Promise.all([
      track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T12:00:00Z"),
      track(db, legId, "en_transito", "Distribucion", "2026-09-27T12:00:00Z", true),
    ])
    row = await leg(db, legId)
    assert.deepEqual([row.status, row.andreani_last_event, row.incident_open], ["entregada", "EnvioEntregado", false])
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key like 'exchange_%'", [id]), 3)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_shipment_delivered'"), 1)
  } finally {
    await db.close()
  }
})

test("CAMBIO fallido: el cliente no entrega el original -> custodia -> vuelve -> inspección; el reclamo sigue abierto", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    await generate(db, legId, ...EXCHANGE, "360000000003")
    await assert.rejects(db.query("select mark_order_claim_exchange_not_completed($1,$2,$3)", [legId, admin, "Andreani informó rechazo"]),
      /CLAIM_EXCHANGE_STATE/, "todavía en BEYONIX: no hay intercambio fallido")
    await track(db, legId, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T18:00:00Z")
    await assert.rejects(db.query("select mark_order_claim_exchange_not_completed($1,$2,$3)", [legId, operator, "El cliente no entregó el original"]),
      /CLAIM_LOGISTICS_FORBIDDEN/)
    await db.query("select mark_order_claim_exchange_not_completed($1,$2,$3)", [legId, admin, "El cliente no entregó el original"])
    assert.deepEqual([(await leg(db, legId)).exchange_outcome, (await leg(db, legId)).closed_at], ["no_completado", null])
    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_OPEN/)
    assert.equal(await stock(db, 1), 3)

    await arrival(db, id, "reemplazo", 1, 2)
    assert.ok((await leg(db, legId)).closed_at)
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2, "reemplazo:recibida_beyonix": 2 })
    assert.equal(await stock(db, 1), 3, "retorno NO reincorpora automáticamente")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-10-05T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2, "reemplazo:recibida_beyonix": 2 }, "un 'entregado' tardío no inventa intercambio")

    const key = randomUUID()
    await db.query("select inspect_order_claim_replacement_units($1,$2,1,1,1,'Caja dañada',$3)", [id, admin, key])
    await db.query("select inspect_order_claim_replacement_units($1,$2,1,1,1,'Caja dañada',$3)", [id, admin, key])
    assert.equal(await stock(db, 1), 4, "inspección -> stock (una sola vez)")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2, "reemplazo:baja": 1, "reemplazo:reincorporada_stock": 1 })

    // Reintento explícito del cambio directo (misma sucursal) y nueva reserva.
    const retry = await plan(db, id, "cambio", { branch: BRANCH })
    assert.deepEqual([(await leg(db, retry)).attempt, (await leg(db, retry)).branch_id], [2, BRANCH])
    await reserve(db, id, 1, 1, 2)
    assert.equal(await stock(db, 1), 2)
    const msgs = await keys(db, id)
    assert.ok(msgs.includes(`exchange_not_completed:${legId}`) && msgs.includes(`replacement_returned:${legId}`))
    assert.ok(!msgs.some((item) => item?.startsWith("exchange_completed")), "nunca 'completado' sin intercambio")
  } finally {
    await db.close()
  }
})

test("RETIRO + REVISIÓN + REENVÍO: RETIRO 400042114 -> recepción -> inspección -> reemplazo autorizado -> VENTA sucursal 400042106", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const returnLeg = await plan(db, id, "devolucion")
    await assert.rejects(reserve(db, id, 1, 1, 2), /REPLACEMENT_REQUIRES_PLAN/, "ningún producto nuevo antes de la revisión")
    await assert.rejects(reserve(db, id, 1, 1, 2, randomUUID(), "garantia"), /REPLACEMENT_REQUIRES_PLAN/, "ni siquiera con excepción de garantía")
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_OPEN|CLAIM_LOGISTICS_NOT_ALLOWED/)
    await generate(db, returnLeg, ...RETURN, "360000000301")
    // Mensaje de la base (20261001170000): sucursal Andreani habilitada + etiqueta, nunca una sucursal fija.
    const returnMessage = (await messages(db, id)).at(-1)?.message ?? ""
    assert.match(returnMessage, /acercalo a una sucursal Andreani habilitada con la etiqueta de devolución/)
    assert.match(returnMessage, /Andreani identificará automáticamente los datos del envío y su destino/)
    assert.doesNotMatch(returnMessage, /Sucursal Once|llevalo a/)
    await track(db, returnLeg, "en_transito", "EnvioDespachado", "2026-09-28T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:en_andreani": 2 })
    await track(db, returnLeg, "entregada", "EnvioEntregado", "2026-09-29T10:00:00Z")
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_REQUIRES_INSPECTION/, "Andreani entregó != recibido e inspeccionado")

    // Llega con faltantes: incidencia registrada al abrirlo.
    await assert.rejects(arrival(db, id, "original", 1, 2, { incidentType: "faltantes_accesorios", note: "x" }), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await arrival(db, id, "original", 1, 2, { incidentType: "faltantes_accesorios", note: "Falta el cargador" })
    assert.equal((await one(db, "select admin_needs_action a from order_claims where id=$1", [id])).a, true)
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_INCIDENT/)
    await inspectOriginal(db, id, 1, 0, 2)
    await assert.rejects(plan(db, id, "reemplazo"), /CLAIM_LOGISTICS_INCIDENT/, "inspeccionado pero con incidencia: nada sale")
    await assert.rejects(incident(db, id, "original", 1, null, "Ok"), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await incident(db, id, "original", 1, null, "El cliente envió el cargador por separado")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_units_incident_resolved'"), 1)

    // Reenvío autorizado: sucursal del retiro, reserva única, VENTA sucursal.
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1 and role='reemplazo'", [id]), 0)
    const resend = await plan(db, id, "reemplazo")
    assert.deepEqual([(await leg(db, resend)).direction, (await leg(db, resend)).branch_id], ["reemplazo", BRANCH])
    await assert.rejects(claimLeg(db, resend, randomUUID(), ...RESEND), /CLAIM_SHIPMENT_NOT_READY_RESERVATION/)
    const key = randomUUID()
    await reserve(db, id, 1, 2, 2, key, "otra_variante")
    await reserve(db, id, 1, 2, 2, key, "otra_variante")
    assert.equal(await stock(db, 2), 1, "reserva una sola vez")
    await assert.rejects(claimLeg(db, resend, randomUUID(), "entrega_domicilio", "400042104"), /order_claim_shipments_modality/)
    await generate(db, resend, ...RESEND, "360000000302")
    assert.deepEqual([(await leg(db, resend)).contract, (await leg(db, resend)).modality], ["400042106", "entrega_sucursal"])
    assert.match((await messages(db, id)).at(-1)?.message ?? "", /Retiralo en Sucursal Once/)
    await track(db, resend, "entregada", "EnvioEntregado", "2026-10-02T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:baja": 2, "reemplazo:entregada_cliente": 2 })
    await close(db, id)
  } finally {
    await db.close()
  }
})

test("DEVOLUCIÓN para reintegro: RETIRO sucursal -> recepción -> inspección; antes no se cierra", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1", [id]), 0)
    await assert.rejects(plan(db, id, "cambio"), /CLAIM_LOGISTICS_NOT_ALLOWED/)
    const legId = await plan(db, id, "devolucion")
    assert.equal(await plan(db, id, "devolucion"), legId, "doble click: el mismo tramo")
    await generate(db, legId, ...RETURN, "360000000401")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T10:00:00Z")
    assert.deepEqual(await units(db, id), { "original:en_andreani": 2 })
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOGISTICS_OPEN/)
    await arrival(db, id, "original", 1, 2)
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOGISTICS_OPEN/)
    await inspectOriginal(db, id, 1, 2, 0)
    assert.equal(await stock(db, 1), 7)
    await db.query("update order_claims set status='cerrado' where id=$1", [id])
  } finally {
    await db.close()
  }
})

test("cambio de método: libre antes de Andreani; con una operación real exige motivo y queda auditado", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const pending = await plan(db, id, "cambio")
    const switched = await plan(db, id, "devolucion")
    assert.equal((await leg(db, pending)).status, "cancelada", "nunca llegó a Andreani: se cancela y audita")
    await generate(db, switched, ...RETURN, "360000000501")
    await assert.rejects(plan(db, id, "cambio"), /CLAIM_LOGISTICS_PLAN_LOCKED/, "operación real: sin motivo no se cambia")
    await assert.rejects(plan(db, id, "cambio", { note: "El cliente prefiere cambio directo" }), /CLAIM_LOGISTICS_OPEN/,
      "ni con motivo mientras la operación sigue en curso")
    // Anular una orden que Andreani nunca retiró ya es la salida auditada.
    await db.query("select cancel_order_claim_leg($1,$2,'Andreani anuló la orden sin retirar')", [switched, admin])
    await plan(db, id, "cambio")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_logistics_cancelled'"), 2)
    // Con una operación real vigente sí se exige el flujo explícito.
    const db2 = await setup()
    try {
      const other = await acceptChange(db2)
      const exchange = await plan(db2, other, "cambio")
      await reserve(db2, other, 1, 1, 2)
      await generate(db2, exchange, ...EXCHANGE, "360000000502")
      await track(db2, exchange, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T10:00:00Z")
      await db2.query("select mark_order_claim_exchange_not_completed($1,$2,$3)", [exchange, admin, "No entregó el original"])
      await arrival(db2, other, "reemplazo", 1, 2)
      await db2.query("select inspect_order_claim_replacement_units($1,$2,1,2,0,null,$3)", [other, admin, randomUUID()])
      await assert.rejects(plan(db2, other, "devolucion"), /CLAIM_LOGISTICS_PLAN_LOCKED/)
      await plan(db2, other, "devolucion", { note: "Se revisará el producto antes de otro cambio" })
      assert.equal(await count(db2, "select count(*)::int n from order_audit_events where action='claim_logistics_plan_changed'"), 1)
    } finally {
      await db2.close()
    }
  } finally {
    await db.close()
  }
})

test("concurrencia: doble toma, timeout -> conciliación sólo Admin, orden ajena rechazada, sin segundo POST", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    const [first, second] = [randomUUID(), randomUUID()]
    assert.equal((await claimLeg(db, legId, first, ...EXCHANGE)).rows[0].creation_status, "processing")
    assert.equal((await claimLeg(db, legId, second, ...EXCHANGE)).rows[0].claim_id, null, "la segunda toma no entra")
    await assert.rejects(complete(db, legId, second, "X1"), /CLAIM_SHIPMENT_NOT_CLAIMED/)
    await db.query("select fail_order_claim_shipment_creation($1,$2,'TIMEOUT','manual_review')", [legId, first])
    assert.equal((await claimLeg(db, legId, randomUUID(), ...EXCHANGE)).rows[0].claim_id, null, "incierto: nunca otro intento")
    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_OPEN/)

    const reconcile = (actor: string, resolution: string, envioId: string | null, notes = "Consultado en el portal Andreani") =>
      db.query("select * from resolve_order_claim_shipment_reconciliation($1,$2,$3,$4,null,$5)", [legId, actor, resolution, envioId, notes])
    await assert.rejects(reconcile(operator, "not_created", null), /RECONCILIATION_FORBIDDEN/)
    await db.query("update ordenes set andreani_envio_id='360000999999' where id=1")
    await assert.rejects(reconcile(admin, "created", "360000999999"), /CLAIM_SHIPMENT_ENVIO_IN_USE/, "nunca la orden de una venta")
    await reconcile(admin, "not_created", null)
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where shipment_id=$1", [legId]), 0, "liberadas para reintentar")
    const retry = randomUUID()
    await claimLeg(db, legId, retry, ...EXCHANGE)
    await db.query("select fail_order_claim_shipment_creation($1,$2,'TIMEOUT','manual_review')", [legId, retry])
    await reconcile(admin, "created", "360000000009")
    const row = await leg(db, legId)
    assert.deepEqual([row.creation_status, row.status, row.andreani_envio_id], ["created", "generada", "360000000009"])
    await assert.rejects(db.query("insert into order_claim_shipments(claim_id,order_id,direction,attempt,branch_id) values($1,1,'devolucion',1,'1')", [id]),
      /order_claim_shipments_one_open_per_claim/, "un solo tramo abierto por reclamo")
  } finally {
    await db.close()
  }
})

test("concurrencia: dos Admin / reintentos sobre la misma recepción no duplican; cron + Admin llegan al mismo estado", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    await generate(db, legId, ...EXCHANGE, "360000000004")
    await Promise.all([
      track(db, legId, "entregada", "EnvioEntregado", "2026-09-28T15:00:00Z"),
      track(db, legId, "entregada", "EnvioEntregado", "2026-09-28T15:00:00Z"),
    ])
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where system_key=$1", [`exchange_completed:${legId}`]), 1)
    const key = randomUUID()
    await arrival(db, id, "original", 1, 2, { key })
    const replay = (await arrival(db, id, "original", 1, 2, { key, actor: admin2 })).rows[0] as { n: number }
    assert.equal(Number(replay.n), 0, "misma clave: no se reaplica")
    await assert.rejects(arrival(db, id, "original", 1, 1), /CLAIM_UNITS_NOT_AVAILABLE/)
    await assert.rejects(arrival(db, id, "reemplazo", 1, 1, { key }), /IDEMPOTENCY_CONFLICT/)
    const inspectKey = randomUUID()
    await inspectOriginal(db, id, 1, 2, 0, inspectKey)
    await inspectOriginal(db, id, 1, 2, 0, inspectKey)
    assert.equal(await stock(db, 1), 5, "3 + 2 reingresadas, una sola vez")
  } finally {
    await db.close()
  }
})

test("MULTI-ÍTEM: productos y variantes distintos; reserva completa por ítem; tope por lo reclamado", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db, [{ order_item_id: 1, quantity: 2 }, { order_item_id: 2, quantity: 1 }])
    const legId = await plan(db, id, "cambio")
    assert.deepEqual(await units(db, id, 1), { "original:con_cliente": 2 })
    assert.deepEqual(await units(db, id, 2), { "original:con_cliente": 1 })
    await assert.rejects(reserve(db, id, 1, 1, 3), /REPLACEMENT_QUANTITY_EXCEEDED/, "nunca más que lo reclamado (el ítem tiene 3 vendidas)")
    await reserve(db, id, 1, 1, 1)
    await reserve(db, id, 1, 2, 1, randomUUID(), "otra_variante")
    await assert.rejects(claimLeg(db, legId, randomUUID(), ...EXCHANGE), /NOT_READY_RESERVATION/)
    await reserve(db, id, 2, 3, 1)
    await generate(db, legId, ...EXCHANGE, "360000000005")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-28T15:00:00Z")
    assert.deepEqual(await units(db, id, 1), { "original:en_andreani": 2, "reemplazo:entregada_cliente": 2 })
    assert.deepEqual([await stock(db, 1), await stock(db, 2), await stock(db, 3)], [4, 2, 1])
    await arrival(db, id, "original", 1, 1, { incidentType: "cantidad_incorrecta", note: "Llegó una sola unidad" })
    await arrival(db, id, "original", 2, 1, { incidentType: "producto_distinto", note: "Vino otro modelo" })
    await inspectOriginal(db, id, 1, 1, 0)
    await inspectOriginal(db, id, 2, 0, 1)
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOGISTICS_INCIDENT|CLAIM_LOGISTICS_OPEN/)
    assert.deepEqual(await units(db, id, 1), { "original:en_andreani": 1, "original:reincorporada_stock": 1, "reemplazo:entregada_cliente": 2 })
  } finally {
    await db.close()
  }
})

test("original conservado + reemplazo entregado: bloqueado salvo excepción explícita; incidencias bloquean el cierre", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db, [{ order_item_id: 2, quantity: 1 }])
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 2, 3, 1)
    await db.query("select cancel_order_claim_leg($1,$2,'Se gestiona fuera de Andreani')", [legId, admin])
    await db.query("select confirm_order_claim_replacement_delivered_manually($1,$2,2,1,'Entregado en mano en el local',$3)", [id, admin, randomUUID()])
    await assert.rejects(close(db, id), /CLAIM_ORIGINAL_NOT_RETURNED/, "nunca: original en el cliente + reemplazo entregado")
    await incident(db, id, "original", 2, "dano_estado", "Golpe en la carcasa")
    await db.query("select waive_order_claim_original_return($1,$2,2,1,'Política comercial: el cliente conserva la unidad fallada',$3)", [id, admin, randomUUID()])
    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_INCIDENT/)
    await incident(db, id, "original", 2, null, "Se acordó con el cliente")
    await close(db, id)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_original_return_waived'"), 1)
  } finally {
    await db.close()
  }
})

test("corrección: Andreani informó 'entregado' pero el producto nuevo volvió -> no completado, el original sigue con el cliente", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db, [{ order_item_id: 2, quantity: 1 }])
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 2, 3, 1)
    await generate(db, legId, ...EXCHANGE, "360000000006")
    await track(db, legId, "entregada", "EnvioEntregado", "2026-10-06T10:00:00Z")
    await assert.rejects(arrival(db, id, "reemplazo", 2, 1, { note: "corto" }), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await arrival(db, id, "reemplazo", 2, 1, { note: "Volvió de la sucursal sin retirar" })
    assert.equal((await leg(db, legId)).exchange_outcome, "no_completado")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "reemplazo:recibida_beyonix": 1 })
  } finally {
    await db.close()
  }
})

test("unidades respetan recepciones ya registradas del reclamo; un faltante no abre logística", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await inspectOriginal(db, id, 1, 1, 0)
    await plan(db, id, "devolucion")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "original:reincorporada_stock": 1 })
  } finally {
    await db.close()
  }
  const db2 = await setup()
  try {
    const missing = await createClaim(db2, [{ order_item_id: 1, quantity: 1 }], "faltante")
    await mutate(db2, missing, { status: "aprobado", resolution: "cambio_producto" })
    assert.equal(await count(db2, "select count(*)::int n from order_claim_shipments where claim_id=$1", [missing]), 0)
  } finally {
    await db2.close()
  }
})

test("migración correctiva sobre datos del modelo inicial: cancela lo automático, conserva operaciones reales, idempotente", async () => {
  const db = new PGlite()
  try {
    await db.exec(source("./fixtures/claim-logistics-schema.sql"))
    // Secuencia real de producción: modelo inicial (20260928100000) con datos,
    // luego 20260930100000 (aplicada) y 20261001100000 (dos veces: idempotente).
    const historical = CHAIN.slice(0, CHAIN.indexOf("20260930100000_claim_logistics_branch_only"))
    for (const name of historical) await db.exec(migration(name))
    await db.query("select set_config('request.jwt.claim.role','service_role',false)")
    for (const [id, role] of [[customer, "cliente"], [admin, "admin"]]) {
      await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
      await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
    }
    await db.exec("insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)")
    await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,shipping_type) values(1,$1,'entregado',now(),'domicilio'),(2,$1,'entregado',now(),'domicilio')", [customer])
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values(1,1,1,1,1),(2,2,1,1,1)")
    // Modelo inicial: aceptar un cambio abría una devolución automáticamente.
    const insertClaim = async (orderId: number, itemId: number) => Number((await one(db,
      "insert into order_claims(order_id,user_id,claim_type,failure_type,description,status,resolution,affected_items) values($1,$2,'garantia_beyonix','falla','x','aprobado','cambio_producto',$3) returning id",
      [orderId, customer, JSON.stringify([{ order_item_id: itemId, quantity: 1 }])])).id)
    const auto = await insertClaim(1, 1)
    const real = await insertClaim(2, 2)
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where direction='devolucion' and status='pendiente'"), 2)
    // Una operación real heredada (retiro a domicilio con novedad) y un reemplazo entregado.
    await db.query(`update order_claim_shipments set creation_status='created', status='incidencia', modality='retiro_domicilio',
      environment='PROD', contract='400042112', andreani_envio_id='360000000777', andreani_last_event='EnvioNoEntregado' where claim_id=$1`, [real])
    await db.query(`insert into order_claim_shipments(claim_id,order_id,direction,status,modality,environment,contract,andreani_envio_id,creation_status,delivered_at)
      values($1,2,'reemplazo','entregada','entrega_domicilio','PROD','400042104','360000000778','created',now())`, [real])

    await db.exec(migration("20260930100000_claim_logistics_branch_only"))
    const corrective = migration("20261001100000_claim_logistics_hardening")
    await db.exec(corrective)
    await db.exec(corrective)
    await db.exec(migration("20261001120000_reopen_rejected_order_claim"))
    await db.exec(migration("20261001130000_cancel_order_claim"))
    await db.exec(migration("20261001130000_cancel_order_claim"))
    // Sin sobrecargas viejas con lógica obsoleta (p. ej. tracking sin revisión de eventos).
    assert.deepEqual((await db.query<{ sig: string }>(
      "select p.oid::regprocedure::text sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='apply_order_claim_shipment_tracking'")).rows.map((row) => row.sig),
    ["apply_order_claim_shipment_tracking(bigint,text,boolean,text,text,text,timestamp with time zone,timestamp with time zone,text)"])

    const autoLeg = await one(db, "select * from order_claim_shipments where claim_id=$1", [auto])
    assert.deepEqual([autoLeg.status, autoLeg.legacy, Boolean(autoLeg.closed_at)], ["cancelada", true, true], "lo abierto automáticamente se cancela")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_logistics_cancelled' and metadata->>'reason'='legacy_auto_opened'"), 1,
      "re-ejecutar la migración no duplica efectos")
    const returnLeg = await one(db, "select * from order_claim_shipments where claim_id=$1 and direction='devolucion'", [real])
    assert.deepEqual([returnLeg.status, returnLeg.incident_open, returnLeg.modality, returnLeg.closed_at], ["generada", true, "retiro_domicilio", null],
      "operación real heredada: se conserva y sigue abierta")
    assert.ok((await one(db, "select closed_at from order_claim_shipments where claim_id=$1 and direction='reemplazo'", [real])).closed_at)

    // Lo heredado se sigue con las funciones nuevas y bloquea abrir otra operación.
    await assert.rejects(plan(db, real, "devolucion"), /CLAIM_LOGISTICS_LEGACY/, "un reclamo con logística previa nunca se transforma")
    await track(db, Number(returnLeg.id), "en_transito", "EnvioDespachado", "2026-09-30T10:00:00Z")
    assert.equal((await leg(db, Number(returnLeg.id))).closed_at, null, "sin unidades no se cierra antes de la entrega")
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [real]), /CLAIM_LOGISTICS_OPEN/)
    await track(db, Number(returnLeg.id), "entregada", "EnvioEntregado", "2026-10-01T10:00:00Z")
    assert.ok((await leg(db, Number(returnLeg.id))).closed_at)

    // El reclamo con lo automático cancelado elige método explícitamente, sólo sucursal.
    const fresh = await plan(db, auto, "cambio")
    assert.deepEqual([(await leg(db, fresh)).legacy, (await leg(db, fresh)).branch_id], [false, BRANCH])
    await assert.rejects(db.query("update order_claim_shipments set modality='retiro_domicilio' where id=$1", [fresh]), /order_claim_shipments_modality/)
    await assert.rejects(db.query("insert into order_claim_shipments(claim_id,order_id,direction,attempt) values($1,2,'devolucion',2)", [real]),
      /order_claim_shipments_branch_check/, "ninguna operación nueva sin sucursal")
    const obsolete = (await db.query<{ n: number }>(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='public' and p.proname in ('order_claim_shipment_ready','claim_order_claim_shipment_creation','fail_order_claim_shipment_creation')
        and pg_get_function_identity_arguments(p.oid) like '%p_direction%'`)).rows[0].n
    assert.equal(obsolete, 0, "no quedan las funciones del modelo inicial")
  } finally {
    await db.close()
  }
})

test("evento Andreani no clasificable: se guarda, pide revisión, congela avance/stock/cierre; resolución Admin auditada", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db, [{ order_item_id: 2, quantity: 1 }])
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 2, 3, 1)
    await generate(db, legId, ...EXCHANGE, "360000000901")
    await track(db, legId, "en_transito", "EnvioDespachado", "2026-09-28T10:00:00Z")
    await track(db, legId, "en_transito", "CambioDeDestino", "2026-09-28T12:00:00Z", false, "CambioDeDestino")
    let row = await leg(db, legId)
    assert.deepEqual([row.review_required, row.review_event, row.andreani_last_event], [true, "CambioDeDestino", "CambioDeDestino"], "evento guardado")
    // Aunque después llegue "entregado", nada avanza hasta revisar.
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T12:00:00Z", false, "CambioDeDestino")
    row = await leg(db, legId)
    assert.deepEqual([row.status, row.exchange_outcome], ["en_transito", null])
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "reemplazo:en_andreani": 1 })
    assert.equal(await stock(db, 3), 1, "nunca devuelve stock")
    await assert.rejects(db.query("update order_claims set status='rechazado', resolution='rechazado', rejection_reason='Prueba de cierre' where id=$1", [id]),
      /CLAIM_LOGISTICS_INCIDENT|CLAIM_LOGISTICS_OPEN/)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_shipment_review_required'"), 1)
    await assert.rejects(db.query("select resolve_order_claim_shipment_review($1,$2,'Confirmado con Andreani')", [legId, operator]), /CLAIM_LOGISTICS_FORBIDDEN/)
    await assert.rejects(db.query("select resolve_order_claim_shipment_review($1,$2,'ok')", [legId, admin]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await db.query("select resolve_order_claim_shipment_review($1,$2,'Andreani confirmó que el destino no cambió')", [legId, admin])
    // El mismo evento ya revisado no vuelve a frenar; el avance se reanuda.
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T12:00:00Z", false, "CambioDeDestino")
    row = await leg(db, legId)
    assert.deepEqual([row.review_required, row.status, row.exchange_outcome], [false, "entregada", "completado"])
    // Respuesta fuera del maestro: se marca para revisión sin tocar nada más.
    const other = await setup()
    try {
      const claimId = await acceptChange(other, [{ order_item_id: 2, quantity: 1 }])
      const otherLeg = await plan(other, claimId, "devolucion")
      await generate(other, otherLeg, ...RETURN, "360000000902")
      await other.query("select flag_order_claim_shipment_review($1,'Seguimiento no interpretable')", [otherLeg])
      await other.query("select flag_order_claim_shipment_review($1,'Seguimiento no interpretable')", [otherLeg])
      const flagged = await leg(other, otherLeg)
      assert.deepEqual([flagged.review_required, flagged.status], [true, "generada"])
      assert.equal(await count(other, "select count(*)::int n from order_audit_events where action='claim_shipment_review_required'"), 1, "idempotente")
    } finally {
      await other.close()
    }
  } finally {
    await db.close()
  }
})

test("NC y reintegro en BASE: bloqueados sin recepción/inspección; excepción Admin auditada de un solo uso; incidencia siempre bloquea", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    const legId = await plan(db, id, "devolucion")
    await generate(db, legId, ...RETURN, "360000000911")
    const creditNote = (status = "authorized") => db.query(
      "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,created_by,operation_type) values(1,$1,$2,'external_refund',30000,$3,'devolucion_total') returning id",
      [id, status, admin])
    const refundProof = () => db.query("insert into order_refund_proofs(order_id,uploaded_by,amount,method) values(1,$1,30000,'Devolución de dinero')", [admin])
    await assert.rejects(creditNote(), /CLAIM_MONEY_RETURN_PENDING/, "NC antes de la recepción física")
    await assert.rejects(refundProof(), /CLAIM_MONEY_RETURN_PENDING/, "reintegro antes de la inspección")
    await assert.rejects(db.query("select register_claim_financial_exception($1,$2,'corto')", [id, admin]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await assert.rejects(db.query("select register_claim_financial_exception($1,$2,'Cliente con discapacidad, se reintegra antes')", [id, operator]), /CLAIM_LOGISTICS_FORBIDDEN/)
    await db.query("select register_claim_financial_exception($1,$2,'Autorizado por gerencia: reintegro anticipado')", [id, admin])
    await creditNote()
    await assert.rejects(creditNote(), /CLAIM_MONEY_RETURN_PENDING/, "la excepción es de un solo uso: no hay doble NC por el mismo evento")
    await refundProof()
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action in ('claim_financial_exception_registered','claim_financial_exception_used')"), 2)

    // Llega con incidencia: ni NC, ni reintegro, ni excepción.
    await track(db, legId, "entregada", "EnvioEntregado", "2026-09-29T10:00:00Z")
    await arrival(db, id, "original", 1, 2, { incidentType: "paquete_vacio", note: "La caja llegó vacía" })
    await assert.rejects(db.query("select register_claim_financial_exception($1,$2,'Otra excepción con motivo')", [id, admin]), /CLAIM_MONEY_INCIDENT_OPEN/)
    await assert.rejects(creditNote(), /CLAIM_MONEY_INCIDENT_OPEN/)
    await assert.rejects(refundProof(), /CLAIM_MONEY_INCIDENT_OPEN/, "reintegro con incidencia abierta")
    // Paquete vacío: nunca vuelve a stock; se registra como baja y se resuelve.
    await assert.rejects(inspectOriginal(db, id, 1, 1, 1), /CLAIM_INSPECTION_NOT_RESTOCKABLE/)
    await inspectOriginal(db, id, 1, 0, 2)
    await incident(db, id, "original", 1, null, "Se reclamó a Andreani por el contenido faltante")
    await creditNote()
    assert.equal(await stock(db, 1), 5, "nada volvió al stock vendible")
  } finally {
    await db.close()
  }
})

test("inspección: producto distinto / paquete vacío nunca vuelven a stock (original y reemplazo); cantidad menor parcial", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    await generate(db, legId, ...EXCHANGE, "360000000921")
    await track(db, legId, "en_sucursal", "ComienzoCustodiaEnSucursal", "2026-09-28T10:00:00Z")
    await db.query("select mark_order_claim_exchange_not_completed($1,$2,'El cliente no entregó el original')", [legId, admin])
    // Vuelve una sola unidad del producto nuevo (cantidad menor) y distinta.
    await arrival(db, id, "reemplazo", 1, 1, { incidentType: "producto_distinto", note: "Volvió otro modelo" })
    await assert.rejects(db.query("select inspect_order_claim_replacement_units($1,$2,1,1,0,null,$3)", [id, admin, randomUUID()]),
      /CLAIM_INSPECTION_NOT_RESTOCKABLE/)
    await db.query("select inspect_order_claim_replacement_units($1,$2,1,0,1,'Producto distinto',$3)", [id, admin, randomUUID()])
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2, "reemplazo:baja": 1, "reemplazo:en_andreani": 1 })
    assert.equal(await stock(db, 1), 3, "la unidad distinta no volvió a stock")
    await arrival(db, id, "reemplazo", 1, 1)
    await db.query("select inspect_order_claim_replacement_units($1,$2,1,1,0,null,$3)", [id, admin, randomUUID()])
    assert.equal(await stock(db, 1), 4, "la unidad correcta sí, tras inspección")
  } finally {
    await db.close()
  }
})

test("legacy: reclamos anteriores no se transforman si tuvieron movimientos; siguen su flujo; los nuevos exigen método", async () => {
  const db = await setup()
  try {
    // Nuevo: sin método, no reserva stock.
    const fresh = await acceptChange(db, [{ order_item_id: 2, quantity: 1 }])
    await assert.rejects(reserve(db, fresh, 2, 3, 1, randomUUID(), "garantia"), /REPLACEMENT_REQUIRES_PLAN/)
    await db.query("update order_claims set status='rechazado', resolution='rechazado', rejection_reason='Cierre de prueba' where id=$1", [fresh])
    // Reclamos anteriores a la migración (logistics_legacy = true).
    await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status) values(3,$1,'entregado',now(),'payment_confirmed'),(4,$1,'entregado',now(),'payment_confirmed')", [customer])
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values(3,3,1,1,1),(4,4,1,1,1)")
    const legacyClaim = async (orderId: number, itemId: number) => Number((await one(db,
      "insert into order_claims(order_id,user_id,claim_type,failure_type,description,status,resolution,affected_items,logistics_legacy) values($1,$2,'garantia_beyonix','falla','x','aprobado','cambio_producto',$3,true) returning id",
      [orderId, customer, JSON.stringify([{ order_item_id: itemId, quantity: 1 }])])).id)
    // Con movimientos (recepción previa): continúa su flujo original.
    const old = await legacyClaim(3, 3)
    await db.query("select process_claim_return_inventory($1,3,3,1,0,'Recibido antes',$2,$3)", [old, admin, randomUUID()])
    await assert.rejects(plan(db, old, "cambio"), /CLAIM_LOGISTICS_LEGACY/)
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1", [old]), 0, "no se inventan unidades")
    await db.query("select * from create_order_replacement(3,3,1,1,'mismo_producto',$1,$2,null,null,$3)", [admin, randomUUID(), old])
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1", [old]), 0)
    await close(db, old)
    // Sin ningún movimiento: puede pasar al circuito nuevo (auditado).
    const clean = await legacyClaim(4, 4)
    await plan(db, clean, "devolucion")
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_logistics_legacy_opt_in'"), 1)
  } finally {
    await db.close()
  }
})

test("cambio de método: Retiro -> Cambio antes de Andreani libre; con resultado incierto bloqueado", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const retiro = await plan(db, id, "devolucion")
    const cambio = await plan(db, id, "cambio")
    assert.equal((await leg(db, retiro)).status, "cancelada")
    await reserve(db, id, 1, 1, 2)
    const token = randomUUID()
    await claimLeg(db, cambio, token, ...EXCHANGE)
    await db.query("select fail_order_claim_shipment_creation($1,$2,'TIMEOUT','manual_review')", [cambio, token])
    await assert.rejects(plan(db, id, "devolucion", { note: "Preferimos revisar el producto primero" }), /CLAIM_LOGISTICS_OPEN/,
      "operación incierta: primero se concilia")
    await assert.rejects(db.query("select cancel_order_claim_leg($1,$2,'Intento de cancelar lo incierto')", [cambio, admin]), /CLAIM_SHIPMENT_IN_FLIGHT/)
  } finally {
    await db.close()
  }
})

test("permisos: todo por service_role; el navegador (anon/authenticated) no lee ni muta logística", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const legId = await plan(db, id, "cambio")
    const grants = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon','public.claim_order_claim_shipment_creation(bigint,uuid,text,text,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.complete_order_claim_shipment_creation(bigint,uuid,text,text,text,numeric)','EXECUTE') b,
      has_function_privilege('authenticated','public.apply_order_claim_shipment_tracking(bigint,text,boolean,text,text,text,timestamptz,timestamptz,text)','EXECUTE') c,
      has_function_privilege('authenticated','public.resolve_order_claim_shipment_reconciliation(bigint,uuid,text,text,text,text)','EXECUTE') d,
      has_function_privilege('authenticated','public.register_order_claim_units_arrival(bigint,uuid,text,bigint,integer,text,text,text)','EXECUTE') e,
      has_function_privilege('authenticated','public.request_order_claim_logistics(bigint,uuid,text,text,text,text,text)','EXECUTE') f,
      has_table_privilege('authenticated','public.order_claim_shipments','SELECT') g,
      has_table_privilege('authenticated','public.order_claim_units','SELECT') h,
      has_table_privilege('service_role','public.order_claim_units','UPDATE') i`)).rows[0]
    assert.deepEqual(grants, { a: false, b: false, c: false, d: false, e: false, f: false, g: false, h: false, i: false })
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(arrival(db, id, "original", 1, 1), /FORBIDDEN/)
    await assert.rejects(claimLeg(db, legId, randomUUID(), ...EXCHANGE), /FORBIDDEN/)
    await assert.rejects(plan(db, id, "devolucion"), /FORBIDDEN/)
  } finally {
    await db.close()
  }
})

const reject = (db: Db, id: number, actor = admin) =>
  mutate(db, id, { status: "rechazado", resolution: "rechazado", rejection_reason: "No corresponde: daño por mal uso." }, actor)
const reopen = async (db: Db, id: number, reason = "Me equivoqué: el reclamo sí corresponde", actor = admin) =>
  db.query<Row>("select * from reopen_rejected_order_claim($1,$2,$3::timestamptz,$4)", [id, actor, await version(db, id), reason])

test("Revisión editable: Corresponde -> No corresponde sin efectos reales (tramo pendiente se cancela); con efectos, la base lo impide", async () => {
  const db = await setup()
  try {
    const free = await acceptChange(db)
    const pending = await plan(db, free, "cambio")
    await reject(db, free)
    assert.equal((await one(db, "select status from order_claims where id=$1", [free])).status, "rechazado")
    assert.equal((await leg(db, pending)).status, "cancelada", "el método elegido sin operación real no deja nada abierto")
    assert.deepEqual(await units(db, free), { "original:conservada_cliente": 2 })

  } finally {
    await db.close()
  }
  const db3 = await setup()
  try {
    // Cambiar la solución aprobada (cambio -> saldo a favor) sin efectos: permitido y la base lo registra.
    const other = await acceptChange(db3)
    await plan(db3, other, "cambio")
    await mutate(db3, other, { status: "aprobado", resolution: "saldo_a_favor" })
    assert.equal((await one(db3, "select resolution from order_claims where id=$1", [other])).resolution, "saldo_a_favor")
    assert.equal(await count(db3, "select count(*)::int n from order_claim_shipments where claim_id=$1 and status<>'cancelada'", [other]), 0,
      "el cambio directo elegido (sin operación real) no queda abierto")
  } finally {
    await db3.close()
  }
  const db2 = await setup()
  try {
    // Con stock reservado u operación Andreani real: ni rechazo ni cambio de solución en silencio.
    const reserved = await acceptChange(db2)
    const legId = await plan(db2, reserved, "cambio")
    await reserve(db2, reserved, 1, 1, 2)
    await assert.rejects(reject(db2, reserved), /CLAIM_LOGISTICS_OPEN/)
    await assert.rejects(mutate(db2, reserved, { status: "aprobado", resolution: "saldo_a_favor" }), /CLAIM_LOGISTICS_LOCKED/)
    await generate(db2, legId, ...EXCHANGE, "360000000901")
    await assert.rejects(reject(db2, reserved), /CLAIM_LOGISTICS_OPEN/)
    assert.equal((await one(db2, "select status from order_claims where id=$1", [reserved])).status, "aprobado")
  } finally {
    await db2.close()
  }
})

test("Revisión editable: No corresponde -> Corresponde con reapertura auditada, sólo sin efectos reales", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    await plan(db, id, "cambio")
    await reject(db, id)
    await assert.rejects(reopen(db, id, "corto"), /CLAIM_REOPEN_REASON_REQUIRED/)
    await assert.rejects(reopen(db, id, undefined, operator), /CLAIM_FORBIDDEN/, "sólo Admin")
    await assert.rejects(db.query("select * from reopen_rejected_order_claim($1,$2,now(),'Motivo suficiente de prueba')", [id, admin]), /CLAIM_CONFLICT/)

    const reopened = (await reopen(db, id)).rows[0]
    assert.deepEqual([reopened.status, reopened.resolution, reopened.rejection_reason, reopened.closed_at, reopened.resolution_summary],
      ["en_revision", null, null, null, null])
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2 }, "las unidades vuelven a esperar la nueva decisión")
    const audit = await one(db, "select actor_id, metadata from order_audit_events where action='claim_review_reopened'")
    assert.equal(audit.actor_id, admin)
    assert.match(JSON.stringify(audit.metadata), /Me equivoqué: el reclamo sí corresponde.*No corresponde: daño por mal uso/)
    assert.ok((await messages(db, id)).some((row) => /revisando nuevamente tu reclamo/.test(row.message)), "el cliente recibe el aviso")
    await assert.rejects(reopen(db, id), /CLAIM_REOPEN_NOT_ALLOWED/, "sólo desde rechazado")

    // Vuelve al flujo normal: se aprueba de nuevo y la logística funciona.
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    const legId = await plan(db, id, "devolucion")
    assert.equal((await leg(db, legId)).status, "pendiente")
  } finally {
    await db.close()
  }
})

test("reapertura bloqueada con efectos reales (operación Andreani generada, saldo) y para consultas; navegador sin permiso", async () => {
  const db = await setup()
  try {
    const andreani = await acceptChange(db)
    const legId = await plan(db, andreani, "devolucion")
    await generate(db, legId, ...RETURN, "360000000902")
    await db.query("select cancel_order_claim_leg($1,$2,'Andreani nunca retiró el paquete')", [legId, admin])
    await reject(db, andreani)
    await assert.rejects(reopen(db, andreani), /CLAIM_REOPEN_HAS_EFFECTS/, "hubo una operación Andreani real")
    assert.equal((await one(db, "select status from order_claims where id=$1", [andreani])).status, "rechazado")

    const grants = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon','public.reopen_rejected_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.reopen_rejected_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') b,
      has_function_privilege('service_role','public.reopen_rejected_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') c`)).rows[0]
    assert.deepEqual(grants, { a: false, b: false, c: true })
  } finally {
    await db.close()
  }
  const db2 = await setup()
  try {
    const credit = await createClaim(db2)
    await reject(db2, credit)
    await db2.query("insert into customer_credit_movements(order_id,claim_id,source_type,movement_type) values(1,$1,'credit_note','credit')", [credit])
    await assert.rejects(reopen(db2, credit), /CLAIM_REOPEN_HAS_EFFECTS/, "hubo saldo a favor")
    await db2.query("delete from customer_credit_movements where claim_id=$1", [credit])
    await db2.query("update order_claims set failure_type='consulta_pedido' where id=$1", [credit])
    await assert.rejects(reopen(db2, credit), /CLAIM_REOPEN_NOT_ALLOWED/, "consultas y cancelaciones tienen su circuito")
  } finally {
    await db2.close()
  }
})

const cancelClaim = async (db: Db, id: number, reason = "El cliente desistió del reclamo", actor = admin) =>
  (await db.query<{ claim_id: number; applied: boolean }>("select * from cancel_order_claim($1,$2,$3::timestamptz,$4)",
    [id, actor, await version(db, id), reason])).rows[0]
const cancelBlocked = (codes: string[]) => (error: unknown) => {
  const failure = error as { message?: string; detail?: string }
  assert.equal(failure.message, "CLAIM_CANCEL_BLOCKED")
  assert.deepEqual((failure.detail ?? "").split(",").filter(Boolean), codes)
  return true
}

test("cancelar reclamo limpio: estado final Cancelado, auditoría completa, aviso al cliente, sin duplicar con doble click", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const pending = await plan(db, id, "cambio")
    await assert.rejects(cancelClaim(db, id, "corto"), /CLAIM_CANCEL_REASON_REQUIRED/, "motivo obligatorio")
    await assert.rejects(cancelClaim(db, id, undefined, operator), /CLAIM_FORBIDDEN/, "sólo Admin")
    await assert.rejects(db.query("select * from cancel_order_claim($1,$2,now(),'El cliente desistió del reclamo')", [id, admin]), /CLAIM_CONFLICT/)

    assert.deepEqual(await cancelClaim(db, id), { claim_id: id, applied: true })
    const claim = await one(db, "select status, closed_at, cancelled_at, cancelled_by, cancellation_reason, admin_needs_action, resolution_summary from order_claims where id=$1", [id])
    assert.deepEqual([claim.status, claim.cancelled_by, claim.cancellation_reason, claim.admin_needs_action], ["cerrado", admin, "El cliente desistió del reclamo", false])
    assert.ok(claim.closed_at && claim.cancelled_at)
    assert.deepEqual(claim.resolution_summary, { kind: "cancelado", label: "Reclamo cancelado", detail: "Motivo: El cliente desistió del reclamo", amount: null, notice: "El reclamo fue cancelado." })
    assert.equal((await leg(db, pending)).status, "cancelada", "el método sin operación real no queda abierto")
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2 })

    const audit = await one(db, "select actor_id, previous_status, new_status, metadata, created_at from order_audit_events where action='claim_cancelled'")
    assert.deepEqual([audit.actor_id, audit.previous_status, audit.new_status], [admin, "aprobado", "cancelado"])
    assert.equal((audit.metadata as Row).reason, "El cliente desistió del reclamo")
    assert.ok(audit.created_at, "fecha")
    const notice = await one(db, "select title, body, type from customer_notifications where source_key=$1", [`claim-resolved:${id}`])
    assert.deepEqual([notice.type, notice.title], ["claim_resolved", "Tu reclamo fue cancelado"])
    assert.match(String(notice.body), /Motivo: El cliente desistió del reclamo/)
    assert.ok((await messages(db, id)).some((row) => /BEYONIX canceló el reclamo\.\nMotivo: El cliente desistió/.test(row.message)), "aviso en el chat")

    // Doble click / reintento / segundo Admin: devuelve el mismo reclamo sin repetir efectos.
    assert.deepEqual(await cancelClaim(db, id), { claim_id: id, applied: false })
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_cancelled'"), 1)
    assert.equal(await count(db, "select count(*)::int n from customer_notifications where order_id=1 and type='claim_resolved'"), 1)
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and message like 'BEYONIX canceló%'", [id]), 1)
    // Terminal: ya no se puede reabrir como si hubiera sido rechazado.
    await assert.rejects(reopen(db, id), /CLAIM_REOPEN_NOT_ALLOWED/)
  } finally {
    await db.close()
  }
})

test("cancelar reclamo bloqueado mientras haya efectos reales pendientes (reserva, Andreani, incidencia, NC); nunca en silencio", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    const exchange = await plan(db, id, "cambio")
    await reserve(db, id, 1, 1, 2)
    await assert.rejects(cancelClaim(db, id), cancelBlocked(["reservation"]))
    await generate(db, exchange, ...EXCHANGE, "360000000911")
    await assert.rejects(cancelClaim(db, id), cancelBlocked(["andreani_open", "reservation"]))
    assert.equal((await one(db, "select status, cancelled_at from order_claims where id=$1", [id])).status, "aprobado", "no se canceló nada")
  } finally {
    await db.close()
  }
  const db2 = await setup()
  try {
    const id = await acceptChange(db2)
    await plan(db2, id, "devolucion")
    await db2.query("update order_claim_units set incident_open=true, incident_type='otro', incident_note='Falta revisar' where claim_id=$1 and id=(select min(id) from order_claim_units where claim_id=$1)", [id])
    await assert.rejects(cancelClaim(db2, id), cancelBlocked(["incident"]))
    await db2.query("update order_claim_units set incident_open=false where claim_id=$1", [id])
    await db2.query("select register_claim_financial_exception($1,$2,'NC anticipada autorizada por gerencia')", [id, admin])
    await db2.query("insert into order_credit_notes(order_id,claim_id,status,total_amount) values(1,$1,'processing',1000)", [id])
    await assert.rejects(cancelClaim(db2, id), cancelBlocked(["credit_note_pending"]))
    await db2.query("update order_credit_notes set status='authorized' where claim_id=$1", [id])
    await assert.rejects(cancelClaim(db2, id), cancelBlocked(["credit_note_issued"]))
  } finally {
    await db2.close()
  }
})

test("cancelar reclamo: no aplica a rechazados/finalizados ni a consultas; el navegador no puede ejecutarlo", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db)
    await reject(db, id)
    await assert.rejects(cancelClaim(db, id), /CLAIM_TERMINAL/)
    const grants = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon','public.cancel_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.cancel_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') b,
      has_function_privilege('authenticated','public.order_claim_cancellation_blockers(bigint)','EXECUTE') c,
      has_function_privilege('service_role','public.cancel_order_claim(bigint,uuid,timestamptz,text)','EXECUTE') d`)).rows[0]
    assert.deepEqual(grants, { a: false, b: false, c: false, d: true })
  } finally {
    await db.close()
  }
  const db2 = await setup()
  try {
    const id = await createClaim(db2)
    await db2.query("update order_claims set failure_type='consulta_pedido' where id=$1", [id])
    await assert.rejects(cancelClaim(db2, id), /CLAIM_CANCEL_NOT_ALLOWED/)
  } finally {
    await db2.close()
  }
})

// Estado del producto ≠ estado del reclamo: cancelar sólo cierra el reclamo.
const physicalSnapshot = async (db: Db, orderItemId: number) => ({
  stock: [await stock(db, 1), await stock(db, 2), await stock(db, 3)],
  item: await one(db, "select return_restocked_quantity, return_written_off_quantity from orden_items where id=$1", [orderItemId]),
  movements: await count(db, "select count(*)::int n from inventory_return_movements where order_item_id=$1", [orderItemId]),
  stockOperations: await count(db, "select count(*)::int n from inventory_operation_log"),
  stockAdjustments: await count(db, "select count(*)::int n from inventory_stock_adjustments"),
})

test("cancelar después de recibir y dar de baja (reclamo histórico): no toca stock, recepción ni inspección", async () => {
  const db = await setup()
  try {
    await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status) values(3,$1,'entregado',now(),'payment_confirmed')", [customer])
    await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad) values(3,3,1,1,1)")
    const id = Number((await one(db,
      "insert into order_claims(order_id,user_id,claim_type,failure_type,description,status,resolution,affected_items,logistics_legacy) values(3,$1,'garantia_beyonix','danado','x','aprobado','cambio_producto',$2,true) returning id",
      [customer, JSON.stringify([{ order_item_id: 3, quantity: 1 }])])).id)
    // La baja exige una decisión explícita con motivo; no hay default.
    await assert.rejects(db.query("select process_claim_return_inventory($1,3,3,0,1,'',$2,$3)", [id, admin, randomUUID()]), /motivo de la baja/)
    const before = await physicalSnapshot(db, 3)
    await db.query("select process_claim_return_inventory($1,3,3,0,1,'Está muy roto',$2,$3)", [id, admin, randomUUID()])
    const inspected = await physicalSnapshot(db, 3)
    assert.deepEqual(inspected.stock, before.stock, "dar de baja no suma stock vendible")
    assert.deepEqual([inspected.item.return_restocked_quantity, inspected.item.return_written_off_quantity], [0, 1])
    const reception = await one(db, "select actor_id, metadata from order_audit_events where action='return_inventory_processed' and order_id=3")
    assert.equal(reception.actor_id, admin, "la baja queda auditada con su Admin")
    assert.equal((reception.metadata as Row).nonSellableQuantity, 1)

    assert.deepEqual(await cancelClaim(db, id, "Era un test de prueba"), { claim_id: id, applied: true })
    assert.deepEqual(await physicalSnapshot(db, 3), inspected, "cancelar no mueve stock ni reescribe la recepción")
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1", [id]), 0, "no se inventan unidades")
    const events = (await db.query<{ action: string }>("select action from order_audit_events where order_id=3 order by created_at, id")).rows.map((row) => row.action)
    assert.ok(events.indexOf("return_inventory_processed") < events.indexOf("claim_cancelled"), "el historial conserva ambos hechos en orden")
  } finally {
    await db.close()
  }
})

test("cancelar con unidades ya inspeccionadas: reincorporadas y dadas de baja quedan igual; lo no recibido queda con el cliente, nunca como baja", async () => {
  const db = await setup()
  try {
    const id = await acceptChange(db, [{ order_item_id: 1, quantity: 3 }])
    await plan(db, id, "devolucion")
    await db.query("update order_claim_shipments set status='cancelada', closed_at=now() where claim_id=$1", [id])
    await arrival(db, id, "original", 1, 2)
    const beforeInspection = await stock(db, 1)
    await inspectOriginal(db, id, 1, 1, 1)
    assert.equal(await stock(db, 1), beforeInspection + 1, "sólo la unidad reincorporada vuelve al stock")
    assert.deepEqual(await units(db, id), { "original:baja": 1, "original:con_cliente": 1, "original:reincorporada_stock": 1 })
    const inspected = await physicalSnapshot(db, 1)

    await cancelClaim(db, id)
    assert.deepEqual(await physicalSnapshot(db, 1), inspected, "cancelar no reincorpora ni da de baja")
    assert.deepEqual(await units(db, id), { "original:baja": 1, "original:conservada_cliente": 1, "original:reincorporada_stock": 1 },
      "la unidad nunca recibida queda con el cliente, no se marca baja")
  } finally {
    await db.close()
  }
})
