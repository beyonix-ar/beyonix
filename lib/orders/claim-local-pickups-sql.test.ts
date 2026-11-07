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
const admin2 = "20000000-0000-4000-8000-000000000005"

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
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [operator, "operador"], [admin2, "admin"]]) {
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
const loss = (db: Db, claimId: number, items: Array<Record<string, unknown>>, { key = randomUUID(), note = "El cadete perdió el paquete en el traslado", actor = admin } = {}) =>
  db.query("select * from confirm_order_claim_local_pickup_loss($1,$2,$3,$4,$5)", [claimId, actor, JSON.stringify(items), note, key])
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
    assert.equal(reception.items.length, 1)
    assert.deepEqual({ ...reception.items[0], unitIds: undefined },
      { orderItemId: 1, productId: 1, variantId: 1, conditionedStockId: null, quantity: 1, incidentType: null, incidentQuantity: 0, pendingAfter: 1, unitIds: undefined })
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

test("BEYONIX + reintegro (H2): faltante temporal queda pendiente sin incidencia; la novedad sólo sobre lo recibido", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await request(db, id)
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING")
    await collected(db, id)
    // "Cantidad incorrecta" no es el estado de una unidad recibida, ni una novedad sin unidades recibidas.
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "cantidad_incorrecta" }], { note: "Falta una unidad" }), /CLAIM_LOGISTICS_INVALID/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 0, incident_type: "dano_estado" }], { note: "Falta una unidad" }), /CLAIM_LOGISTICS_INVALID/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "dano_estado", incident_quantity: 2 }], { note: "Caja rota" }), /CLAIM_LOGISTICS_INVALID/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "dano_estado" }]), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 0 }]), /CLAIM_LOGISTICS_INVALID/, "una recepción registra al menos una unidad")
    // Esperadas 2, llegó 1: recepción parcial con observación; la recibida NO queda como faltante.
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }], { note: "El cadete trajo una sola unidad" })
    assert.equal((await pickup(db, id)).status, "recibido_parcial")
    const rows = (await db.query<{ location: string; incident_open: boolean; incident_type: string | null }>(
      "select location, incident_open, incident_type from order_claim_units where claim_id=$1 order by id", [id])).rows
    assert.deepEqual(rows.map((row) => [row.location, row.incident_open, row.incident_type]).sort(),
      [["con_cliente", false, null], ["recibida_beyonix", false, null]])
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING")
    await assert.rejects(db.query("update order_claims set status='cerrado' where id=$1", [id]), /CLAIM_LOCAL_PICKUP_OPEN/)
    assert.deepEqual(await customerMessages(db, id), [
      "Coordinaremos con vos el retiro del producto en tu domicilio.",
      "Recibimos parte de tu devolución en BEYONIX. Te avisamos por este medio cómo sigue.",
    ])
    // Llegó después: se completa la recepción; la novedad cae sólo sobre esa unidad.
    await receive(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "dano_estado", incident_quantity: 1 }], { note: "Llegó con la caja rota" })
    assert.equal((await pickup(db, id)).status, "recibido")
    assert.equal(await count(db, "select count(*)::int n from order_claim_units where claim_id=$1 and incident_open", [id]), 1)
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_INCIDENT_OPEN")
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,null,'Revisado: va a baja por daño')", [id, admin])
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING", "recibido pero sin inspeccionar")
    await inspect(db, id, 1, 1, 1)
    assert.equal(await moneyBlock(db, id), null, "inspeccionado: el reintegro sigue sus reglas")
  } finally {
    await db.close()
  }
})

test("H1 reintegro: recepción parcial + pérdida confirmada en traslado; nunca recepción ficticia, stock ni dinero automático", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await request(db, id)
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1 }]), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED/, "antes del retiro el producto sigue con el cliente")
    await collected(db, id)
    const stockBefore = await stock(db, 1)
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }])

    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1 }], { actor: operator }), /CLAIM_LOGISTICS_FORBIDDEN/)
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1 }], { note: "corto" }), /CLAIM_LOGISTICS_NOTE_REQUIRED/)
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 2 }]), /CLAIM_UNITS_NOT_AVAILABLE/, "nunca la unidad ya recibida ni más que lo pendiente")
    await assert.rejects(loss(db, id, [{ order_item_id: 2, quantity: 1 }]), /CLAIM_UNITS_NOT_AVAILABLE/, "producto ajeno a la devolución")
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 0 }]), /CLAIM_LOGISTICS_INVALID/)
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1, incident_type: "otro" }]), /CLAIM_LOGISTICS_INVALID/)

    const key = randomUUID()
    const note = "El cadete informó el extravío del paquete en el traslado"
    await loss(db, id, [{ order_item_id: 1, quantity: 1 }], { key, note })
    // Reintento legítimo: misma clave, mismo contenido -> sin efectos nuevos.
    await loss(db, id, [{ order_item_id: 1, quantity: 1 }], { key, note })
    // Misma clave con otro contenido u otro actor: conflicto explícito, sin efectos.
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1 }], { key, note: `${note} (otra versión)` }), /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/)
    await assert.rejects(loss(db, id, [{ order_item_id: 1, quantity: 1 }], { key, note, actor: admin2 }), /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }], { key }), /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/, "otra acción con la misma clave")

    const current = await one<{ status: string; loss_confirmed_at: string | null; received_at: string | null }>(db,
      "select status, loss_confirmed_at::text, received_at::text from order_claim_local_pickups where claim_id=$1", [id])
    assert.equal(current.status, "resuelto_con_perdida")
    assert.ok(current.loss_confirmed_at && current.received_at)
    assert.deepEqual(await units(db, id), { "original:perdida_traslado": 1, "original:recibida_beyonix": 1 })
    assert.equal(await count(db, "select count(*)::int n from order_claim_local_pickup_receptions where claim_id=$1", [id]), 1, "ninguna recepción ficticia")
    const losses = (await db.query<{ actor_id: string; note: string; items: Array<Record<string, unknown>> }>(
      "select actor_id, note, items from order_claim_local_pickup_losses where claim_id=$1", [id])).rows
    assert.equal(losses.length, 1, "idempotente: una sola pérdida")
    assert.equal(losses[0].actor_id, admin)
    assert.equal(losses[0].note, note)
    assert.deepEqual({ ...losses[0].items[0], unitIds: undefined }, { orderItemId: 1, productId: 1, variantId: 1, conditionedStockId: null, quantity: 1, unitIds: undefined })
    const audit = await one<{ actor_id: string; metadata: Record<string, unknown> }>(db,
      "select actor_id, metadata from order_audit_events where action='claim_local_pickup_loss_confirmed'")
    assert.equal(audit.metadata.quantity, 1)
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_local_pickup_loss_confirmed'"), 1)
    const messages = await customerMessages(db, id)
    assert.match(messages.at(-1) ?? "", /inconveniente durante el traslado/)
    assert.doesNotMatch(messages.at(-1) ?? "", /Recibimos|recibido/i, "nunca se comunica como recibido")

    // Sin stock artificial: la unidad perdida nunca se inspecciona ni vuelve a stock.
    assert.equal(await stock(db, 1), stockBefore)
    await assert.rejects(inspect(db, id, 1, 2, 0), /CLAIM_LOCAL_PICKUP_NOT_RECEIVED/)
    await assert.rejects(db.query("update order_claim_units set location='recibida_beyonix' where claim_id=$1 and location='perdida_traslado'", [id]), /CLAIM_UNIT_TRANSIT_LOSS_FINAL/)
    await assert.rejects(receive(db, id, [{ order_item_id: 1, quantity: 1 }]), /CLAIM_LOCAL_PICKUP_NOT_COLLECTED/, "nada más para recibir")
    // La recibida sigue exigiendo inspección antes del dinero (protección intacta).
    assert.equal(await moneyBlock(db, id), "CLAIM_MONEY_RETURN_PENDING")
    await inspect(db, id, 1, 1, 0)
    assert.equal(await stock(db, 1), stockBefore + 1, "sólo la unidad recibida y apta vuelve al stock")
    assert.equal(await moneyBlock(db, id), null, "la resolución comercial sigue con sus reglas existentes")
    assert.equal(await count(db, "select count(*)::int n from order_credit_notes where claim_id=$1", [id]), 0, "ninguna NC automática")
  } finally {
    await db.close()
  }
})

test("H1 reemplazo: todo perdido tras el retiro -> reemplazo y cierre sin recepción ficticia; la pérdida no se usa fuera del retiro local", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }])
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await request(db, id)
    await collected(db, id)
    await assert.rejects(db.query("select * from cancel_order_claim_local_pickup($1,$2,'Ya no hace falta retirarlo')", [id, admin]), /CLAIM_LOCAL_PICKUP_ALREADY_COLLECTED/)
    await assert.rejects(reserve(db, id, 1, 1, 2), /REPLACEMENT_REQUIRES_INSPECTION/, "bloqueado mientras falte resolver la recepción")
    const stockBefore = await stock(db, 1)
    await loss(db, id, [{ order_item_id: 1, quantity: 2 }])
    const lost = await pickup(db, id)
    assert.equal(lost.status, "resuelto_con_perdida")
    assert.equal(lost.received_at, null, "nada se recibió")
    assert.deepEqual(await units(db, id), { "original:perdida_traslado": 2 })
    assert.equal(await stock(db, 1), stockBefore)
    // Reemplazo con su regla existente (reserva de stock real), sin inspección simulada.
    await reserve(db, id, 1, 1, 2)
    assert.equal(await stock(db, 1), stockBefore - 2)
    await deliverManually(db, id, 1, 2)
    await db.query("update order_claims set status='cerrado' where id=$1", [id])
    assert.deepEqual(await units(db, id), { "original:perdida_traslado": 2, "reemplazo:entregada_cliente": 2 }, "cerrar no la convierte en 'conservada'")
  } finally {
    await db.close()
  }

  const other = await setup()
  try {
    // Sin retiro local retirado (p. ej. un reclamo Andreani o un retiro sin retirar): nunca 'perdida_traslado'.
    const id = await createClaim(other, [{ order_item_id: 1, quantity: 1 }])
    await mutate(other, id, { status: "aprobado", resolution: "cambio_producto" })
    await request(other, id)
    await assert.rejects(other.query("update order_claim_units set location='perdida_traslado' where claim_id=$1", [id]), /CLAIM_UNIT_TRANSIT_LOSS_INVALID/)
    await assert.rejects(other.query("insert into order_claim_units(claim_id,order_id,order_item_id,role,location) values($1,1,1,'original','perdida_traslado')", [id]), /CLAIM_UNIT_TRANSIT_LOSS_INVALID/)
  } finally {
    await other.close()
  }
})

test("H3 idempotencia estricta de la recepción: mismo contenido = reintento; otro contenido u otro actor = conflicto", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }, { order_item_id: 2, quantity: 1 }])
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await request(db, id)
    await collected(db, id)
    const key = randomUUID()
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }], { key, note: "Llegó todo bien" })
    // Mismo contenido semántico (otro orden de productos / claves, notas con espacios): reintento sin efectos.
    await receive(db, id, [{ quantity: 1, order_item_id: 2 }, { order_item_id: 1, quantity: 1 }], { key, note: "  Llegó todo bien " })
    assert.equal(await count(db, "select count(*)::int n from order_claim_local_pickup_receptions where claim_id=$1", [id]), 1)
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "original:recibida_beyonix": 2 })
    // Otra cantidad, otro producto, otra nota u otro actor con la misma clave: conflicto, nada se mueve.
    for (const [items, note, actor] of [
      [[{ order_item_id: 1, quantity: 2 }, { order_item_id: 2, quantity: 1 }], "Llegó todo bien", admin],
      [[{ order_item_id: 1, quantity: 1 }], "Llegó todo bien", admin],
      [[{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }], "Otra observación", admin],
      [[{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }], "Llegó todo bien", admin2],
    ] as const) {
      await assert.rejects(db.query("select * from confirm_order_claim_local_pickup_reception($1,$2,$3,$4,$5)", [id, actor, JSON.stringify(items), note, key]),
        /CLAIM_LOGISTICS_IDEMPOTENCY_CONFLICT/)
    }
    assert.equal(await count(db, "select count(*)::int n from order_claim_local_pickup_receptions where claim_id=$1", [id]), 1)
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "original:recibida_beyonix": 2 })
    // La utilidad compartida de los demás flujos no cambió (sigue comparando reclamo y acción).
    const shared = randomUUID()
    assert.equal((await one<{ ok: boolean }>(db, "select begin_order_claim_unit_event($1,$2,'arrival:original',$3,'{\"a\":1}') ok", [id, shared, admin])).ok, true)
    assert.equal((await one<{ ok: boolean }>(db, "select begin_order_claim_unit_event($1,$2,'arrival:original',$3,'{\"a\":1}') ok", [id, shared, admin])).ok, false)
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
    await assert.rejects(db.query("select * from order_claim_local_pickup_losses"), /permission denied/i)
    await assert.rejects(db.query("select * from confirm_order_claim_local_pickup_loss(1,$1,'[]','motivo suficiente','clave-123456')", [admin]), /permission denied/i)
    await assert.rejects(db.query("select begin_order_claim_local_pickup_event(1,'clave-123456','x',$1,'{}')", [admin]), /permission denied/i)
    await assert.rejects(db.query("select * from request_order_claim_local_pickup(1,$1,null)", [admin]), /permission denied/i)
  } finally {
    await db.close()
  }
})

// N1: con un producto perdido por BEYONIX el reclamo nunca se cancela ni se
// rechaza, y sólo se finaliza con la solución ejecutada (no elegida ni en curso).
const cancelClaim = async (db: Db, claimId: number) =>
  db.query("select * from cancel_order_claim($1,$2,$3::timestamptz,'El cliente desistió del reclamo')", [claimId, admin, await version(db, claimId)])
const cancelBlockers = async (db: Db, claimId: number) => {
  const error = await cancelClaim(db, claimId).then(() => null, (reason: { message?: string; detail?: string }) => reason)
  assert.ok(error, "la cancelación debía rechazarse")
  assert.match(String(error.message), /CLAIM_CANCEL_BLOCKED/)
  return String(error.detail ?? "").split(",")
}
/** Saltear la RPC: ni un UPDATE directo cancela, rechaza o cierra sin la solución. */
const forceCancel = (db: Db, claimId: number) =>
  db.query("update order_claims set status='cerrado', closed_at=now(), cancelled_at=now(), cancelled_by=$2, cancellation_reason='Cancelación forzada directa' where id=$1", [claimId, admin])
const forceStatus = (db: Db, claimId: number, status: string) => db.query("update order_claims set status=$2 where id=$1", [claimId, status])
const status = async (db: Db, claimId: number) => (await one<{ status: string; cancelled_at: string | null }>(db, "select status, cancelled_at from order_claims where id=$1", [claimId]))
const creditNote = async (db: Db, claimId: number, destination: string, noteStatus: string, settlement: string, quantity: number) => {
  const note = await one<{ id: string }>(db,
    "insert into order_credit_notes(order_id,claim_id,status,destination,cae,total_amount,settlement_status) values(1,$1,$2,$3,$4,1000,$5) returning id",
    [claimId, noteStatus, destination, noteStatus === "authorized" ? "CAE-1" : null, settlement])
  await db.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount) values($1,1,$2,500,1000)", [note.id, quantity])
  return note.id
}
async function lostClaim(db: Db, resolution: string, claimStatus: string, quantity = 2) {
  const id = await createClaim(db, [{ order_item_id: 1, quantity }])
  await mutate(db, id, { status: claimStatus, resolution })
  await request(db, id)
  await collected(db, id)
  await loss(db, id, [{ order_item_id: 1, quantity }])
  return id
}

test("N1 reemplazo: perdido y sin resolver / sólo reservado -> nunca se cancela ni cierra; entregado -> se finaliza, nunca se cancela", async () => {
  const db = await setup()
  try {
    const id = await lostClaim(db, "cambio_producto", "aprobado")
    // Sin solución: la RPC, un UPDATE directo, el rechazo y el cierre, rechazados.
    assert.ok((await cancelBlockers(db, id)).includes("transit_loss_pending"))
    await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS/)
    await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
    await assert.rejects(forceStatus(db, id, "rechazado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
    // Reemplazo sólo reservado: no es una solución entregada.
    await reserve(db, id, 1, 1, 2)
    const reserved = await cancelBlockers(db, id)
    assert.ok(reserved.includes("transit_loss_pending") && reserved.includes("reservation"))
    await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS/)
    await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED|CLAIM_LOGISTICS_OPEN/)
    assert.deepEqual(await status(db, id), { status: "aprobado", cancelled_at: null })
    // Entregado: corresponde finalizar (nunca cancelar).
    await deliverManually(db, id, 1, 2)
    const delivered = await cancelBlockers(db, id)
    assert.ok(delivered.includes("transit_loss_resolved") && delivered.includes("replacement_delivered"))
    assert.ok(!delivered.includes("transit_loss_pending"))
    await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS/)
    await forceStatus(db, id, "cerrado")
    assert.deepEqual(await status(db, id), { status: "cerrado", cancelled_at: null })
  } finally {
    await db.close()
  }
})

for (const [resolution, claimStatus, destination] of [
  ["reintegro_total", "reintegro_pendiente", "external_refund"],
  ["saldo_a_favor", "aprobado", "customer_balance"],
] as const) {
  test(`N1 ${resolution}: pendiente, en curso o sin liquidar -> nunca; liquidado -> se finaliza (nunca se cancela)`, async () => {
    const db = await setup()
    try {
      const id = await lostClaim(db, resolution, claimStatus)
      assert.equal(await moneyBlock(db, id), null, "la pérdida no frena el dinero")
      assert.ok((await cancelBlockers(db, id)).includes("transit_loss_pending"))
      await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS/)
      await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Solicitado / en curso: NC en proceso.
      const note = await creditNote(db, id, destination, "processing", "pendiente", 2)
      const inProgress = await cancelBlockers(db, id)
      assert.ok(inProgress.includes("transit_loss_pending") && inProgress.includes("credit_note_pending"))
      await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Autorizada pero sin liquidar (reintegro no procesado / saldo no acreditado).
      await db.query("update order_credit_notes set status='authorized', cae='CAE-1' where id=$1", [note])
      await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      await db.query("update order_credit_notes set settlement_status='procesando' where id=$1", [note])
      await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Liquidada pero cubriendo sólo una de las dos unidades perdidas.
      await db.query("update order_credit_note_items set quantity=1 where credit_note_id=$1", [note])
      await db.query("update order_credit_notes set settlement_status='completado' where id=$1", [note])
      await assert.rejects(forceStatus(db, id, "cerrado"), /CLAIM_TRANSIT_LOSS_UNRESOLVED/)
      // Liquidada por las dos: corresponde finalizar; cancelar, nunca.
      await db.query("update order_credit_note_items set quantity=2 where credit_note_id=$1", [note])
      const settled = await cancelBlockers(db, id)
      assert.ok(settled.includes("transit_loss_resolved") && settled.includes("credit_note_issued"))
      await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS/)
      await forceStatus(db, id, "cerrado")
      assert.deepEqual(await status(db, id), { status: "cerrado", cancelled_at: null })
      assert.equal(await count(db, "select count(*)::int n from order_credit_notes where claim_id=$1", [id]), 1, "los movimientos financieros se conservan")
    } finally {
      await db.close()
    }
  })
}

test("N1: recibidas + perdidas + pendientes no se cancelan; sin pérdidas y Andreani, sin cambios", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 3 }])
    await mutate(db, id, { status: "reintegro_pendiente", resolution: "reintegro_total" })
    await request(db, id)
    await collected(db, id)
    await receive(db, id, [{ order_item_id: 1, quantity: 1 }])
    await loss(db, id, [{ order_item_id: 1, quantity: 1 }])
    assert.deepEqual(await units(db, id), { "original:con_cliente": 1, "original:perdida_traslado": 1, "original:recibida_beyonix": 1 })
    const codes = await cancelBlockers(db, id)
    assert.ok(codes.includes("transit_loss_pending") && codes.includes("inspection_pending"))
    await assert.rejects(forceCancel(db, id), /CLAIM_CANCEL_TRANSIT_LOSS|CLAIM_LOCAL_PICKUP_OPEN/)
    assert.deepEqual(await status(db, id), { status: "reintegro_pendiente", cancelled_at: null })
  } finally {
    await db.close()
  }

  // Envío BEYONIX sin pérdidas: se cancela como antes (retiro cancelado antes de retirar).
  const plain = await setup()
  try {
    const id = await createClaim(plain, [{ order_item_id: 1, quantity: 1 }])
    await mutate(plain, id, { status: "aprobado", resolution: "cambio_producto" })
    await request(plain, id)
    await plain.query("select * from cancel_order_claim_local_pickup($1,$2,'El cliente prefiere no devolverlo')", [id, admin])
    assert.equal((await one<{ applied: boolean }>(plain, "select applied from cancel_order_claim($1,$2,$3::timestamptz,'El cliente desistió del reclamo')", [id, admin, await version(plain, id)])).applied, true)
    assert.equal((await status(plain, id)).status, "cerrado")
  } finally {
    await plain.close()
  }

  // Andreani: la cancelación sigue sus reglas previas.
  const andreani = await setup({ provider: "andreani" })
  try {
    const id = await createClaim(andreani)
    await mutate(andreani, id, { status: "aprobado", resolution: "cambio_producto" })
    await andreani.query("select * from request_order_claim_logistics($1,$2,'devolucion',null,'4567','Sucursal Once','Av. Pueyrredón 100')", [id, admin])
    assert.deepEqual((await andreani.query("select order_claim_cancellation_blockers($1) b", [id])).rows[0], { b: [] })
    assert.equal((await one<{ applied: boolean }>(andreani, "select applied from cancel_order_claim($1,$2,$3::timestamptz,'El cliente desistió del reclamo')", [id, admin, await version(andreani, id)])).applied, true)
  } finally {
    await andreani.close()
  }
})
