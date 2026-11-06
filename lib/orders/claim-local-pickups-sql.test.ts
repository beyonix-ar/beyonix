import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Devolución por retiro de un cadete (Envío BEYONIX) con la cadena REAL de
// migraciones de reclamos y el motor REAL de stock (PGlite): coordinación,
// retirado, recepción (completa, parcial, idempotente, concurrente), inspección
// existente, reemplazo / reintegro posteriores, "no requiere devolución" y
// aislamiento del circuito Andreani. Nunca toca Andreani ni stock real.

const customer = "20000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000003"
const operator = "20000000-0000-4000-8000-000000000004"

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
  // Proveedor efectivo (order_shipping_carrier) y el circuito nuevo.
  "20261106110000_dispatch_records_carrier_filter",
  "20261106120000_claim_local_pickups",
]

type Db = PGlite
type Row = Record<string, unknown>

/** Pedido 1: ítem 1 = 3 unidades (variante 1), ítem 2 = 1 unidad (variante 3). */
async function setup({ provider = "beyonix", legacyProvider = null as string | null } = {}) {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-logistics-schema.sql"))
  await db.exec("alter table ordenes add column shipping_provider text, add column envio_proveedor text")
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
    "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,envio_proveedor) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio',$2,$3)",
    [customer, provider, legacyProvider])
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

const version = async (db: Db, id: number) =>
  (await db.query<{ v: string }>("select updated_at::text v from order_claims where id=$1", [id])).rows[0].v
const mutate = async (db: Db, id: number, patch: Row) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
const one = async <T extends Row = Row>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const count = async (db: Db, sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(db, sql, params)).n)
const stock = async (db: Db, variant: number) => Number((await one<{ s: number }>(db, "select stock s from producto_variantes where id=$1", [variant])).s)
async function units(db: Db, claimId: number) {
  const rows = (await db.query<{ role: string; location: string; n: number }>(
    "select role, location, count(*)::int n from order_claim_units where claim_id=$1 group by role, location order by role, location", [claimId])).rows
  return Object.fromEntries(rows.map((row) => [`${row.role}:${row.location}`, row.n]))
}
const pickup = (db: Db, claimId: number) =>
  one<{ id: number; status: string; agreed_for: string | null; picked_up_at: string | null; received_at: string | null }>(db,
    "select *, agreed_for::text agreed_for from order_claim_local_pickups where claim_id=$1 order by id desc limit 1", [claimId])
const customerMessages = async (db: Db, claimId: number) =>
  (await db.query<{ message: string }>("select message from order_claim_messages where claim_id=$1 and system_key like 'local_pickup%' order by id", [claimId])).rows.map((row) => row.message)

const request = (db: Db, claimId: number, actor = admin) => db.query("select * from request_order_claim_local_pickup($1,$2,$3)", [claimId, actor, "Coordinar por WhatsApp"])
const schedule = (db: Db, claimId: number, date: string) => db.query("select * from schedule_order_claim_local_pickup($1,$2,$3::date,null)", [claimId, admin, date])
const collected = (db: Db, claimId: number, actor = admin) => db.query("select * from mark_order_claim_local_pickup_collected($1,$2,'Retiró Juan')", [claimId, actor])
const pickupIncident = (db: Db, claimId: number, note: string) => db.query("select * from report_order_claim_local_pickup_incident($1,$2,$3)", [claimId, admin, note])
const receive = (db: Db, claimId: number, items: Array<Record<string, unknown>>, { key = randomUUID(), note = "" } = {}) =>
  db.query("select * from confirm_order_claim_local_pickup_reception($1,$2,$3,$4,$5)", [claimId, admin, JSON.stringify(items), note, key])
const inspect = (db: Db, claimId: number, itemId: number, restock: number, writeOff: number) =>
  db.query("select process_claim_return_inventory($1,1,$2,$3,$4,'Revisado en depósito',$5,$6)", [claimId, itemId, restock, writeOff, admin, randomUUID()])
const reserve = (db: Db, claimId: number, itemId: number, variant: number, quantity: number) =>
  db.query("select * from create_order_replacement(1,$1,$2,$3,'mismo_producto',$4,$5,null,null,$6)", [itemId, variant, quantity, admin, randomUUID(), claimId])
const deliverManually = (db: Db, claimId: number, itemId: number, quantity: number) =>
  db.query("select confirm_order_claim_replacement_delivered_manually($1,$2,$3,$4,'Entregado por el cadete en domicilio',$5)", [claimId, admin, itemId, quantity, randomUUID()])
const today = (offsetDays = 0) => {
  const date = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(date)
}
const moneyBlock = async (db: Db, claimId: number) => (await one<{ b: string | null }>(db, "select order_claim_money_block($1) b", [claimId])).b

test("BEYONIX + reemplazo: coordinar sin fecha, fallido, retirado (sin stock), recepción parcial idempotente, inspección y entrega local", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    // Nunca Andreani para Envío BEYONIX (ni sucursal, ni etiqueta, ni tracking).
    await assert.rejects(db.query("select * from request_order_claim_logistics($1,$2,'devolucion',null,'4567','Sucursal','Dir')", [id, admin]), /CLAIM_LOGISTICS_LOCAL_DELIVERY/)
    await assert.rejects(request(db, id, operator), /CLAIM_LOGISTICS_FORBIDDEN/, "sólo administradores")
    await assert.rejects(request(db, id, customer), /CLAIM_LOGISTICS_FORBIDDEN/)

    const first = (await request(db, id)).rows[0] as { id: number; status: string }
    assert.equal(first.status, "pendiente_coordinacion")
    assert.equal(((await request(db, id)).rows[0] as { id: number }).id, first.id, "pedirlo de nuevo devuelve el mismo retiro")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2 })
    assert.deepEqual(await customerMessages(db, id), ["Coordinaremos con vos el retiro del producto en tu domicilio."], "sin fechas ni horarios")
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1", [id]), 0, "ningún envío Andreani")

    // Recepción antes de que el cadete lo retire: nunca.
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }]), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED/)
    await assert.rejects(schedule(db, id, today(-1)), /CLAIM_LOCAL_PICKUP_DATE/, "nunca una fecha pasada")
    await schedule(db, id, today(1))
    assert.deepEqual([(await pickup(db, id)).status, (await pickup(db, id)).agreed_for], ["coordinado", today(1)])
    // Retiro fallido -> incidencia -> se vuelve a coordinar.
    await pickupIncident(db, id, "El cliente no estaba en el domicilio")
    assert.equal((await pickup(db, id)).status, "incidencia")
    await schedule(db, id, today(2))
    assert.equal((await pickup(db, id)).status, "coordinado")

    // Retirado: el cadete tiene el producto. Ni stock, ni inspección, ni cierre.
    const stockBefore = await stock(db, 1)
    await collected(db, id)
    await collected(db, id)
    assert.equal((await pickup(db, id)).status, "retirado")
    assert.deepEqual(await units(db, id), { "original:con_cliente": 2 })
    assert.equal(await stock(db, 1), stockBefore)
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOCAL_PICKUP_OPEN/)
    await assert.rejects(inspect(db, id, 1, 1, 0), /CLAIM_LOCAL_PICKUP_NOT_RECEIVED/, "la inspección sólo alcanza lo recibido")
    await assert.rejects(db.query("select * from cancel_order_claim_local_pickup($1,$2,'Ya no hace falta retirarlo')", [id, admin]), /CLAIM_LOCAL_PICKUP_ALREADY_COLLECTED/)

    // Recepción parcial: 1 de 2. Más de lo autorizado o un producto ajeno, nunca.
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 3 }]), /CLAIM_UNITS_NOT_AVAILABLE/)
    await assert.rejects(receive(db, id, [{ order_item_id: 2, quantity: 1 }]), /CLAIM_UNITS_NOT_AVAILABLE/, "producto que no forma parte de la devolución")
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1.5 }]), /CLAIM_LOGISTICS_INVALID/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 1, quantity: 1 }]), /CLAIM_LOGISTICS_INVALID/)
    const key = randomUUID()
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }], { key })
    // Doble clic / reintento con la misma clave: no se registra dos veces.
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }], { key })
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "original:recibida_beyonix": 1 })
    assert.equal((await pickup(db, id)).status, "recibido_parcial")
    const reception = await one<{ actor_id: string; items: Array<Record<string, unknown>> }>(db,
      "select actor_id, items from order_claim_local_pickup_receptions where claim_id=$1", [id])
    assert.equal(reception.actor_id, admin)
    assert.deepEqual(reception.items, [{ orderItemId: 1, productId: 1, variantId: 1, conditionedStockId: null, quantity: 1, incidentType: null }])
    assert.equal(await stock(db, 1), stockBefore, "recibir no devuelve stock vendible")

    // "Concurrente": otra recepción (otra clave) por más de lo que queda.
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 2 }]), /CLAIM_UNITS_NOT_AVAILABLE/)
    await receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "dano_estado" }], { note: "Llegó con la caja rota" })
    assert.equal((await pickup(db, id)).status, "recibido")
    assert.deepEqual(await units(db, id), { "original:recibida_beyonix": 2 })
    assert.equal((await customerMessages(db, id)).at(-1), "Recibimos tu producto en BEYONIX. Lo vamos a revisar y te avisamos por este medio cómo sigue.")
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }]), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED|CLAIM_UNITS_NOT_AVAILABLE/, "nada más para recibir")

    // Inspección existente: apto -> stock, dañado -> baja (incidencia resuelta antes).
    await assert.rejects(reserve(db, id, 1, 1, 2), /REPLACEMENT_REQUIRES_INSPECTION/)
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,null,'Revisado: va a baja por daño')", [id, admin])
    await inspect(db, id, 1, 1, 1)
    assert.deepEqual(await units(db, id), { "original:baja": 1, "original:reincorporada_stock": 1 })
    assert.equal(await stock(db, 1), stockBefore + 1, "sólo la unidad apta vuelve al stock, una vez")

    // Reemplazo posterior a la recepción, entregado sin Andreani.
    await reserve(db, id, 1, 1, 2)
    assert.deepEqual(await units(db, id), { "original:baja": 1, "original:reincorporada_stock": 1, "reemplazo:reservada": 2 })
    await deliverManually(db, id, 1, 2)
    await db.query("update order_claims set status='cerrado' where id=$1", [id])
    assert.equal(await count(db, "select count(*)::int n from order_credit_notes where claim_id=$1", [id]), 0, "un reemplazo nunca emite nota de crédito")
    const actions = (await db.query<{ action: string }>("select action from order_audit_events where metadata->>'claimId' = $1::text or action like 'claim_local_pickup%' order by id", [id])).rows.map((row) => row.action)
    for (const action of ["claim_local_pickup_requested", "claim_local_pickup_scheduled", "claim_local_pickup_incident", "claim_local_pickup_collected", "claim_local_pickup_received"]) {
      assert.ok(actions.includes(action), action)
    }
  } finally {
    await db.close()
  }
})

test("BEYONIX + reintegro: el dinero espera recepción e inspección; faltante queda en incidencia", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await request(db, id)
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING")
    await collected(db, id)
    // Llegó una sola unidad: la otra falta y queda en incidencia (frena dinero y cierre).
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 0, incident_type: "cantidad_incorrecta" }], { note: "Falta una unidad" }), /CLAIM_UNITS_NOT_AVAILABLE/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "cantidad_incorrecta" }]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }])
    await receive(db, id, [{ order_item_id: 1, quantity: 0, incident_type: "cantidad_incorrecta" }], { note: "El cadete trajo una sola unidad" })
    assert.equal((await pickup(db, id)).status, "incidencia")
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_INCIDENT_OPEN")
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOCAL_PICKUP_OPEN/)
    // Llegó después: se resuelve la incidencia y se completa la recepción.
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,null,'Apareció la segunda unidad')", [id, admin])
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }])
    assert.equal((await pickup(db, id)).status, "recibido")
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING", "recibido pero sin inspeccionar")
    await inspect(db, id, 1, 2, 0)
    assert.equal(await moneyBlock(db, id), null, "inspeccionado: el reintegro sigue sus reglas")
  } finally {
    await db.close()
  }
})

test("No requiere devolución, cancelar antes de retirar y aislamiento con Andreani", async () => {
  const db = await setup()
  try {
    // Cancelar antes de retirar: se puede elegir otra opción.
    const change = await createClaim(db, [{ order_item_id: 2, quantity: 1 }])
    await mutate(db, change, { status: "aprobado", resolution: "cambio_producto" })
    await request(db, change)
    await assert.rejects(db.query("select * from cancel_order_claim_local_pickup($1,$2,'corto')", [change, admin]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await assert.rejects(db.query("select waive_order_claim_local_return($1,$2,'El cliente conserva el producto')", [change, admin]), /CLAIM_RETURN_ALREADY_STARTED/)
    await db.query("select * from cancel_order_claim_local_pickup($1,$2,'El cliente prefiere conservarlo')", [change, admin])
    assert.equal((await pickup(db, change)).status, "cancelado")
    // No requiere devolución: queda con el cliente (auditado) y el reemplazo sale sin Andreani.
    await assert.rejects(db.query("select waive_order_claim_local_return($1,$2,'corto')", [change, admin]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await db.query("select waive_order_claim_local_return($1,$2,'Producto de bajo valor: no requiere devolución')", [change, admin])
    assert.deepEqual(await units(db, change), { "original:conservada_cliente": 1 })
    await reserve(db, change, 2, 3, 1)
    await deliverManually(db, change, 2, 1)
    await db.query("update order_claims set status='cerrado' where id=$1", [change])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_original_return_waived' and metadata->>'mode'='local_no_return'"), 1)
  } finally {
    await db.close()
  }

  const refundDb = await setup()
  try {
    const refund = await createClaim(refundDb, [{ order_item_id: 1, quantity: 1 }])
    await mutate(refundDb, refund, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await refundDb.query("select waive_order_claim_local_return($1,$2,'Reintegro sin devolución por política comercial')", [refund, admin])
    assert.equal(await moneyBlock(refundDb, refund), null)
  } finally {
    await refundDb.close()
  }

  // Pedido Andreani: el retiro por cadete no existe y el circuito Andreani sigue intacto.
  const andreani = await setup({ provider: "andreani" })
  try {
    const id = await createClaim(andreani)
    await mutate(andreani, id, { status: "aprobado", resolution: "cambio_producto" })
    await assert.rejects(request(andreani, id), /CLAIM_LOGISTICS_NOT_LOCAL/)
    await assert.rejects(andreani.query("select waive_order_claim_local_return($1,$2,'El cliente conserva el producto')", [id, admin]), /CLAIM_LOGISTICS_NOT_LOCAL/)
    const leg = (await andreani.query<{ id: number; branch_id: string }>("select * from request_order_claim_logistics($1,$2,'devolucion',null,'4567','Sucursal Once','Av. Pueyrredón 100')", [id, admin])).rows[0]
    assert.equal(leg.branch_id, "4567")
    // Reemplazo Andreani sin tramo de reemplazo: sigue exigiendo el plan (comportamiento previo).
    await assert.rejects(reserve(andreani, id, 1, 1, 1), /REPLACEMENT_REQUIRES_PLAN|REPLACEMENT_REQUIRES_RECEIVED_ITEM/)
  } finally {
    await andreani.close()
  }

  // Legacy: shipping_provider vacío -> manda envio_proveedor (beyonix).
  const legacy = await setup({ provider: "  ", legacyProvider: "BEYONIX" })
  try {
    const id = await createClaim(legacy)
    await mutate(legacy, id, { status: "aprobado", resolution: "cambio_producto" })
    assert.equal(((await request(legacy, id)).rows[0] as { status: string }).status, "pendiente_coordinacion")
  } finally {
    await legacy.close()
  }

  // Explícito andreani con envio_proveedor residual beyonix: es Andreani.
  const explicit = await setup({ provider: "andreani", legacyProvider: "beyonix" })
  try {
    const id = await createClaim(explicit)
    await mutate(explicit, id, { status: "aprobado", resolution: "cambio_producto" })
    await assert.rejects(request(explicit, id), /CLAIM_LOGISTICS_NOT_LOCAL/)
  } finally {
    await explicit.close()
  }
})

test("seguridad: tablas sólo para el servidor; un reclamo ajeno o sin aceptar no se opera", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await assert.rejects(request(db, id), /CLAIM_LOGISTICS_NOT_ALLOWED/, "sin aceptar no hay logística")
    await assert.rejects(db.query("select * from confirm_order_claim_local_pickup_reception(999,$1,'[{\"order_item_id\":1,\"quantity\":1}]','',$2)", [admin, randomUUID()]), /CLAIM_NOT_FOUND/)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await request(db, id)
    await db.exec("set role authenticated")
    await assert.rejects(db.query("select * from order_claim_local_pickups"), /permission denied/i)
    await assert.rejects(db.query("select * from order_claim_local_pickup_receptions"), /permission denied/i)
    await assert.rejects(db.query("select * from request_order_claim_local_pickup(1,$1,null)", [admin]), /permission denied/i)
  } finally {
    await db.close()
  }
})
