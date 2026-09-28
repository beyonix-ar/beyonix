import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Cambio de producto aceptado -> envíos Andreani de ida y vuelta, con la
// cadena REAL de migraciones de reclamos (PGlite): mensajes idempotentes,
// creación con candado, conciliación manual, tracking monotónico, entregas
// únicas y NUNCA cambios de stock.

const customer = "20000000-0000-4000-8000-000000000001"
const admin = "20000000-0000-4000-8000-000000000003"
const operator = "20000000-0000-4000-8000-000000000004"
const ACCEPTED = "BEYONIX aceptó el cambio del producto."
const PACKING =
  "Para continuar, te pedimos que prepares el producto completo, incluyendo caja, bolsas, manuales, accesorios y todos los elementos recibidos, correctamente embalado y en el mejor estado posible. Esto nos permitirá revisar el producto y agilizar el reemplazo."

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const migration = (name: string) => source(`../../supabase/migrations/${name}.sql`)

async function setup() {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-schema.sql"))
  await db.exec(`alter table customer_notifications
    add column id uuid primary key default gen_random_uuid(), add column is_read boolean not null default false,
    add column created_at timestamptz not null default now(), add column dismissed_at timestamptz`)
  // Columnas reales del envío manual del reemplazo (baseline de producción).
  await db.exec(`alter table order_claims add column replacement_shipping_company text,
    add column replacement_tracking text, add column replacement_sent_at timestamptz`)
  for (const name of [
    "20260816120000_atomic_order_claim_cancellation",
    "20260905150000_claims_atomic_operations",
    "20260906090000_claim_case_type_transitions",
    "20260906100000_claims_final_security",
    "20260906110000_claim_credit_note_snapshot",
  ]) await db.exec(migration(name))
  await db.exec(`create table order_replacements (
    original_order_id bigint references ordenes(id), original_order_item_id bigint references orden_items(id),
    claim_id bigint references order_claims(id), quantity integer not null check(quantity>0), notes text)`)
  for (const name of [
    "20260924150000_claim_product_change_requires_replacement",
    "20260924140000_order_claim_customer_reads",
    "20260924160000_claim_resolution_summary_notifications",
    "20260928100000_claim_andreani_shipments",
  ]) await db.exec(migration(name))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [operator, "operador"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',90000)", [customer])
  await db.exec("insert into orden_items(id,orden_id,cantidad) values(1,1,2)")
  return db
}

async function createClaim(db: PGlite) {
  const op = randomUUID()
  await db.query("select begin_order_claim_operation($1,$2,1,$3,'{}','order-claim-evidence')", [op, customer, randomUUID().replaceAll("-", "").repeat(2)])
  const result = await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id",
    [op, customer, JSON.stringify({ problemType: "falla", message: "El producto dejó de funcionar.", items: [{ order_item_id: 1, quantity: 1 }] })])
  return result.rows[0].id
}

const version = async (db: PGlite, id: number) =>
  (await db.query<{ v: string }>("select updated_at::text v from order_claims where id=$1", [id])).rows[0].v
const mutate = async (db: PGlite, id: number, patch: Record<string, unknown>) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
const beyonixMessages = async (db: PGlite, id: number) =>
  (await db.query<{ message: string; system_key: string | null }>(
    "select message, system_key from order_claim_messages where claim_id=$1 and author_role<>'cliente' order by created_at, id", [id])).rows
const shipment = async (db: PGlite, id: number, direction: string) =>
  (await db.query<Record<string, unknown>>("select * from order_claim_shipments where claim_id=$1 and direction=$2", [id, direction])).rows[0]
const count = async (db: PGlite, sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, params)).rows[0].n)

async function acceptedClaim(db: PGlite) {
  const id = await createClaim(db)
  await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
  return id
}

const claimCreation = (db: PGlite, id: number, direction: string, token: string, modality: string, contract = "400042104") =>
  db.query<Record<string, unknown>>("select * from claim_order_claim_shipment_creation($1,$2,$3,'PROD',$4,$5)",
    [id, direction, token, modality, contract])
const complete = (db: PGlite, id: number, direction: string, token: string, envioId: string) =>
  db.query("select * from complete_order_claim_shipment_creation($1,$2,$3,$4,$4,'Creada',null)", [id, direction, token, envioId])

async function createdShipment(db: PGlite, id: number, direction: string, envioId: string, modality: string) {
  const token = randomUUID()
  await claimCreation(db, id, direction, token, modality)
  await complete(db, id, direction, token, envioId)
}

const track = (db: PGlite, id: number, direction: string, phase: string, event = "Distribucion") =>
  db.query("select * from apply_order_claim_shipment_tracking($1,$2,$3,'En camino','T-1',$4,now())", [id, direction, phase, event])

test("aceptar el cambio: los dos mensajes exactos, en orden, y devolución pendiente", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    assert.deepEqual((await beyonixMessages(db, id)).slice(0, 2), [
      { message: ACCEPTED, system_key: "change_accepted" },
      { message: PACKING, system_key: "change_packing_instructions" },
    ])
    const row = await shipment(db, id, "devolucion")
    assert.deepEqual([row.status, row.creation_status, Number(row.order_id)], ["pendiente", "not_started", 1])
    assert.equal(await shipment(db, id, "reemplazo"), undefined, "el reemplazo recién existe cuando se registra")
  } finally {
    await db.close()
  }
})

test("idempotente: guardados posteriores y reaplicar la decisión no duplican mensajes ni envíos", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    await mutate(db, id, { status: "cambio_pendiente" })
    await mutate(db, id, { admin_response: "Te escribimos por el retiro.", append_message: true })
    await db.query("update order_claims set resolution='cambio_producto', status='cambio_pendiente' where id=$1", [id])
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key='change_accepted'", [id]), 1)
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1", [id]), 1)
    await assert.rejects(
      db.query("insert into order_claim_messages(claim_id,author_role,message,system_key) values($1,'admin','x','change_accepted')", [id]),
      /order_claim_messages_system_key_unique/,
    )
  } finally {
    await db.close()
  }
})

test("otras resoluciones no generan mensajes de cambio ni envíos", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "reintegro_total" })
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key is not null", [id]), 0)
    assert.equal(await count(db, "select count(*)::int n from order_claim_shipments where claim_id=$1", [id]), 0)
    await assert.rejects(claimCreation(db, id, "devolucion", randomUUID(), "retiro_domicilio"), /CLAIM_SHIPMENT_NOT_READY/)
  } finally {
    await db.close()
  }
})

test("creación: doble click -> una sola toma; completar idempotente; nunca pisa otro envío", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    const [first, second] = [randomUUID(), randomUUID()]
    const a = (await claimCreation(db, id, "devolucion", first, "retiro_domicilio", "RET-1")).rows[0]
    const b = (await claimCreation(db, id, "devolucion", second, "retiro_domicilio", "RET-1")).rows[0]
    assert.equal(a.creation_status, "processing")
    assert.equal(b.claim_id, null, "la segunda toma no entra")
    await assert.rejects(complete(db, id, "devolucion", second, "X1"), /CLAIM_SHIPMENT_NOT_CLAIMED/)
    await complete(db, id, "devolucion", first, "360000000001")
    const row = await shipment(db, id, "devolucion")
    assert.deepEqual([row.status, row.creation_status, row.andreani_envio_id, row.modality, row.contract, row.environment],
      ["generada", "created", "360000000001", "retiro_domicilio", "RET-1", "PROD"])
    assert.equal(row.cost_amount, null, "sin costo informado no se inventa")
    await complete(db, id, "devolucion", first, "360000000001")
    await assert.rejects(complete(db, id, "devolucion", first, "999"), /CLAIM_SHIPMENT_ALREADY_CREATED/)
    assert.equal((await claimCreation(db, id, "devolucion", randomUUID(), "retiro_domicilio")).rows[0].creation_status, "created")
    // El mismo envío Andreani no puede quedar en dos tramos del mismo ambiente.
    await assert.rejects(
      db.query("insert into order_claim_shipments(claim_id,order_id,direction,environment,andreani_envio_id) values($1,1,'reemplazo','PROD','360000000001')", [id]),
      /order_claim_shipments_andreani_envio_unique/,
    )
    // Modalidad de un tramo en el otro: rechazada por la base.
    await assert.rejects(claimCreation(db, id, "reemplazo", randomUUID(), "retiro_domicilio"), /order_claim_shipments_modality|CLAIM_SHIPMENT_NOT_READY/)
  } finally {
    await db.close()
  }
})

test("reemplazo: sólo con todas las unidades reemplazadas; despacho con mensajes y datos del envío; nunca toca stock", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    await assert.rejects(claimCreation(db, id, "reemplazo", randomUUID(), "entrega_domicilio"), /CLAIM_SHIPMENT_NOT_READY/)
    const itemBefore = (await db.query("select * from orden_items where id=1")).rows[0]
    await db.query("insert into order_replacements(original_order_id,original_order_item_id,claim_id,quantity) values(1,1,$1,1)", [id])
    const replacementsBefore = await count(db, "select count(*)::int n from order_replacements")
    await createdShipment(db, id, "reemplazo", "360000000002", "entrega_domicilio")
    const messages = await beyonixMessages(db, id)
    const dispatched = messages.findIndex((row) => row.system_key === "replacement_dispatched")
    assert.equal(messages[dispatched].message, "Tu producto de reemplazo ya fue despachado.")
    assert.equal(messages[dispatched + 1].system_key, "replacement_dispatch_details")
    assert.match(messages[dispatched + 1].message, /Seguimiento Andreani: 360000000002/)
    assert.match(messages[dispatched + 1].message, /entrega en el domicilio de tu compra/i)
    const claim = (await db.query<Record<string, unknown>>("select replacement_shipping_company c, replacement_tracking t, replacement_sent_at s from order_claims where id=$1", [id])).rows[0]
    assert.deepEqual([claim.c, claim.t, Boolean(claim.s)], ["Andreani", "360000000002", true])
    // Reintentos: ni mensajes ni reemplazos ni stock se duplican.
    await createdShipment(db, id, "reemplazo", "360000000002", "entrega_domicilio").catch(() => null)
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key like 'replacement_dispatch%'", [id]), 2)
    assert.equal(await count(db, "select count(*)::int n from order_replacements"), replacementsBefore)
    assert.deepEqual((await db.query("select * from orden_items where id=1")).rows[0], itemBefore)
  } finally {
    await db.close()
  }
})

test("fallos: rechazo explícito reintentable; incierto a revisión manual; bloqueo sólo anota el motivo", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    await db.query("select * from fail_order_claim_shipment_creation($1,'devolucion',null,'Falta configurar el contrato','blocked')", [id])
    let row = await shipment(db, id, "devolucion")
    assert.deepEqual([row.creation_status, row.creation_error], ["not_started", "Falta configurar el contrato"])
    // Bloqueo del reemplazo: crea el tramo pendiente con el motivo visible.
    await db.query("select * from fail_order_claim_shipment_creation($1,'reemplazo',null,'Falta el reemplazo','blocked')", [id])
    assert.equal((await shipment(db, id, "reemplazo")).creation_error, "Falta el reemplazo")

    const token = randomUUID()
    await claimCreation(db, id, "devolucion", token, "retiro_domicilio")
    await db.query("select * from fail_order_claim_shipment_creation($1,'devolucion',$2,'HTTP 422','failed')", [id, token])
    assert.equal((await shipment(db, id, "devolucion")).creation_status, "failed")

    const retry = randomUUID()
    await claimCreation(db, id, "devolucion", retry, "retiro_domicilio")
    await db.query("select * from fail_order_claim_shipment_creation($1,'devolucion',$2,'TIMEOUT','manual_review')", [id, retry])
    row = await shipment(db, id, "devolucion")
    assert.equal(row.creation_status, "manual_review")
    assert.equal((await claimCreation(db, id, "devolucion", randomUUID(), "retiro_domicilio")).rows[0].claim_id, null,
      "incierto: nunca un segundo intento automático")
  } finally {
    await db.close()
  }
})

test("conciliación: sólo admin, con nota y sobre un resultado incierto; vincula o libera", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    const reconcile = (actor: string, resolution: string, envioId: string | null, notes = "Confirmado con Andreani por teléfono") =>
      db.query("select * from resolve_order_claim_shipment_reconciliation($1,'devolucion',$2,$3,$4,null,$5)", [id, actor, resolution, envioId, notes])
    await assert.rejects(reconcile(admin, "not_created", null), /CLAIM_SHIPMENT_RECONCILIATION_NOT_PENDING/)
    const token = randomUUID()
    await claimCreation(db, id, "devolucion", token, "retiro_domicilio")
    await assert.rejects(reconcile(admin, "not_created", null), /NOT_PENDING/, "una toma reciente no se concilia")
    await db.query("update order_claim_shipments set creation_started_at = now() - interval '11 minutes' where claim_id=$1", [id])
    await assert.rejects(reconcile(operator, "not_created", null), /RECONCILIATION_FORBIDDEN/)
    await assert.rejects(reconcile(admin, "not_created", null, "ok"), /CLAIM_SHIPMENT_INVALID/)
    await reconcile(admin, "not_created", null)
    assert.equal((await shipment(db, id, "devolucion")).creation_status, "failed")

    const again = randomUUID()
    await claimCreation(db, id, "devolucion", again, "retiro_domicilio")
    await db.query("select * from fail_order_claim_shipment_creation($1,'devolucion',$2,'TIMEOUT','manual_review')", [id, again])
    await reconcile(admin, "created", "360000000009")
    const row = await shipment(db, id, "devolucion")
    assert.deepEqual([row.creation_status, row.status, row.andreani_envio_id], ["created", "generada", "360000000009"])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_shipment_reconciled'"), 2)
  } finally {
    await db.close()
  }
})

test("tracking: avanza, no retrocede desde entregada; incidencia puede recuperarse", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    await assert.rejects(track(db, id, "devolucion", "en_transito"), /CLAIM_SHIPMENT_NOT_CREATED/)
    await createdShipment(db, id, "devolucion", "360000000001", "retiro_domicilio")
    await track(db, id, "devolucion", "sin_cambio", "OrdenDeEnvioCreada")
    assert.equal((await shipment(db, id, "devolucion")).status, "generada")
    for (const [phase, expected] of [["en_transito", "en_transito"], ["incidencia", "incidencia"], ["en_transito", "en_transito"]]) {
      await track(db, id, "devolucion", phase)
      assert.equal((await shipment(db, id, "devolucion")).status, expected, phase)
    }
    assert.ok((await shipment(db, id, "devolucion")).last_checked_at)
  } finally {
    await db.close()
  }
})

test("entregas: devolución recibida y reemplazo entregado avisan UNA vez al cliente y al Admin; sin stock", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    await createdShipment(db, id, "devolucion", "360000000001", "despacho_sucursal")
    const itemBefore = (await db.query("select * from orden_items where id=1")).rows[0]
    await track(db, id, "devolucion", "entregada", "EnvioEntregado")
    await track(db, id, "devolucion", "entregada", "EnvioEntregado")
    await track(db, id, "devolucion", "en_transito")
    assert.equal((await shipment(db, id, "devolucion")).status, "entregada", "nunca retrocede")
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key='return_received'", [id]), 1)
    assert.equal((await db.query<{ a: boolean }>("select admin_needs_action a from order_claims where id=$1", [id])).rows[0].a, true,
      "el Admin queda avisado aunque el mensaje de BEYONIX apague la atención")

    await db.query("insert into order_replacements(original_order_id,original_order_item_id,claim_id,quantity) values(1,1,$1,1)", [id])
    await createdShipment(db, id, "reemplazo", "360000000002", "entrega_sucursal")
    await track(db, id, "reemplazo", "entregada", "EnvioEntregado")
    await track(db, id, "reemplazo", "entregada", "EnvioEntregado")
    const delivered = (await db.query<{ message: string }>(
      "select message from order_claim_messages where claim_id=$1 and system_key='replacement_delivered'", [id])).rows
    assert.deepEqual(delivered.map((row) => row.message), ["Andreani informó que tu producto de reemplazo fue entregado."])
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_shipment_delivered'"), 2)
    assert.deepEqual((await db.query("select * from orden_items where id=1")).rows[0], itemBefore, "la recepción física sigue siendo manual")
  } finally {
    await db.close()
  }
})

test("permisos: sólo service_role; el cliente no lee la tabla directamente", async () => {
  const db = await setup()
  try {
    const id = await acceptedClaim(db)
    const grants = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon','public.claim_order_claim_shipment_creation(bigint,text,uuid,text,text,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.complete_order_claim_shipment_creation(bigint,text,uuid,text,text,text,numeric)','EXECUTE') b,
      has_function_privilege('authenticated','public.apply_order_claim_shipment_tracking(bigint,text,text,text,text,text,timestamptz)','EXECUTE') c,
      has_function_privilege('authenticated','public.resolve_order_claim_shipment_reconciliation(bigint,text,uuid,text,text,text,text)','EXECUTE') d,
      has_table_privilege('authenticated','public.order_claim_shipments','SELECT') e`)).rows[0]
    assert.deepEqual(grants, { a: false, b: false, c: false, d: false, e: false })
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(claimCreation(db, id, "devolucion", randomUUID(), "retiro_domicilio"), /FORBIDDEN/)
  } finally {
    await db.close()
  }
})
