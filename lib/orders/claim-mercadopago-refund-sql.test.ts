import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Refund REAL de Mercado Pago frente a la logística de reclamos, con las
// funciones SQL reales: begin_mercadopago_order_refund vigente
// (20260917130000) + la guarda de 20260930100000. Sin red ni Mercado Pago.

const customer = "30000000-0000-4000-8000-000000000001"
const admin = "30000000-0000-4000-8000-000000000003"
const admin2 = "30000000-0000-4000-8000-000000000004"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
const migration = (name: string) => source(`../../supabase/migrations/${name}.sql`)
const section = (text: string, start: string, end: string) => {
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error(`Sección no encontrada: ${start}`)
  return text.slice(from, to)
}

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
]

type Db = PGlite

async function setup({ estado = "pagado", financialStatus = "refund_pending" } = {}) {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-logistics-schema.sql"))
  const refunds = migration("20260911170000_mercadopago_order_refunds")
  await db.exec(section(refunds, "create table public.mercadopago_order_refunds (",
    "-- ============================================================\n-- 2. begin_mercadopago_order_refund"))
  // Versión VIGENTE de begin (20260917130000).
  await db.exec(section(migration("20260917130000_external_refund_without_credit_note_and_mp_nc_policy"),
    "create or replace function public.begin_mercadopago_order_refund(", "revoke execute on function public.begin_mercadopago_order_refund"))
  for (const name of CHAIN) await db.exec(migration(name))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [admin, "admin"], [admin2, "admin"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.exec("insert into productos(id) values(1); insert into producto_variantes(id,producto_id) values(1,1)")
  await db.query("select adjust_variant_stock_idempotent(1,5,'seed de test',$1,'seed-mp-1')", [admin])
  await db.query(
    `insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,original_total,payment_method_id,payment_id,payment_confirmed_amount,credit_note_required)
     values(1,$1,$2,now()-interval '1 day',$3,60000,60000,'mercadopago','9001',60000,false)`,
    [customer, estado, financialStatus])
  await db.exec("insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values(1,1,1,1,2,30000)")
  return db
}

async function refundClaimWithReturn(db: Db) {
  const claim = Number((await db.query<{ id: number }>(
    "insert into order_claims(order_id,user_id,claim_type,failure_type,description,status,resolution,affected_items) values(1,$1,'garantia_beyonix','falla','x','reintegro_pendiente','reintegro_total',$2) returning id",
    [customer, JSON.stringify([{ order_item_id: 1, quantity: 2 }])])).rows[0].id)
  const leg = Number((await db.query<{ id: number }>(
    "select id from request_order_claim_logistics($1,$2,'devolucion',null,'4567','Sucursal Once',null)", [claim, admin])).rows[0].id)
  const token = randomUUID()
  await db.query("select claim_order_claim_shipment_creation($1,$2,'PROD','despacho_sucursal','400042114')", [leg, token])
  await db.query("select complete_order_claim_shipment_creation($1,$2,'360000000801','360000000801','Creada',null)", [leg, token])
  return { claim, leg }
}

const begin = (db: Db, actor = admin) =>
  db.query<{ refund_id: string; status: string; should_call_mp: boolean }>("select * from begin_mercadopago_order_refund(1,$1)", [actor])
const count = async (db: Db, sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0].n)
const arrival = (db: Db, claim: number, incidentType: string | null = null, note = "Llegó al depósito") =>
  db.query("select register_order_claim_units_arrival($1,$2,'original',1,2,$3,$4,$5)", [claim, admin, note, incidentType, randomUUID()])
const inspect = (db: Db, claim: number, restock: number, writeOff: number) =>
  db.query("select process_claim_return_inventory($1,1,1,$2,$3,'Revisado',$4,$5)", [claim, restock, writeOff, admin, randomUUID()])

test("pedido ENTREGADO con reclamo: el flujo de reclamos no puede reintegrar por Mercado Pago (fail-closed, sin intento)", async () => {
  const db = await setup({ estado: "entregado", financialStatus: "payment_confirmed" })
  try {
    await refundClaimWithReturn(db)
    await assert.rejects(begin(db), /ORDER_NOT_REFUND_PENDING/, "un reclamo nunca pone refund_pending")
    await db.query("update ordenes set financial_status='refund_pending' where id=1")
    await assert.rejects(begin(db), /ORDER_ALREADY_DISPATCHED|CLAIM_MONEY_RETURN_PENDING/, "entregado: begin lo rechaza")
    assert.equal(await count(db, "select count(*)::int n from mercadopago_order_refunds"), 0, "nunca se creó un intento")
  } finally {
    await db.close()
  }
})

test("refund MP con reclamo con logística: recepción pendiente / sin inspección / incidencia -> bloqueado; inspección válida -> permitido", async () => {
  const db = await setup()
  try {
    const { claim } = await refundClaimWithReturn(db)
    await assert.rejects(begin(db), /CLAIM_MONEY_RETURN_PENDING/, "recepción pendiente")
    await arrival(db, claim)
    await assert.rejects(begin(db), /CLAIM_MONEY_RETURN_PENDING/, "recibido pero no inspeccionado")
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,'faltantes_accesorios','Falta el cargador')", [claim, admin])
    await assert.rejects(begin(db), /CLAIM_MONEY_INCIDENT_OPEN/, "incidencia pendiente")
    await inspect(db, claim, 1, 1)
    await assert.rejects(begin(db), /CLAIM_MONEY_INCIDENT_OPEN/, "inspeccionado pero con la incidencia sin resolver")
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,null,'Cargador recibido por separado')", [claim, admin])
    const attempt = (await begin(db)).rows[0]
    assert.deepEqual([attempt.status, attempt.should_call_mp], ["processing", true])
    assert.equal(await count(db, "select count(*)::int n from mercadopago_order_refunds"), 1)
  } finally {
    await db.close()
  }
})

test("refund MP: doble click, dos Admin y retry -> un solo intento activo; un reintento vuelve a pasar por la guarda", async () => {
  const db = await setup()
  try {
    const { claim } = await refundClaimWithReturn(db)
    await arrival(db, claim)
    await inspect(db, claim, 2, 0)
    const [first, second] = await Promise.all([begin(db, admin), begin(db, admin2)])
    assert.deepEqual([first.rows[0].should_call_mp, second.rows[0].should_call_mp], [true, false], "dos Admin / doble click: un solo POST")
    assert.equal((await begin(db)).rows[0].should_call_mp, false, "retry con intento en curso: no se vuelve a llamar")
    assert.equal(await count(db, "select count(*)::int n from mercadopago_order_refunds"), 1)
    // Reconciliación "no existe en MP" -> 'requested': el reintento vuelve a validar la guarda.
    await db.query("update mercadopago_order_refunds set status='requested'")
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,'dano_estado','Daño detectado después')", [claim, admin])
    await assert.rejects(begin(db), /CLAIM_MONEY_INCIDENT_OPEN/)
    await db.query("select set_order_claim_units_incident($1,$2,'original',1,null,'Se verificó que no afecta el reintegro')", [claim, admin])
    assert.equal((await begin(db)).rows[0].should_call_mp, true)
    await db.query("update mercadopago_order_refunds set status='confirmed', completed_at=now()")
    assert.equal((await begin(db)).rows[0].should_call_mp, false, "confirmado: nunca un segundo refund")
    await assert.rejects(db.query("insert into mercadopago_order_refunds(order_id,payment_id,amount,status,idempotency_key,requested_by) values(1,'9001',60000,'confirmed',$1,$2)",
      [randomUUID(), admin]), /mercadopago_order_refunds_confirmed_full_per_order_idx/, "no puede haber dos refunds totales confirmados")
  } finally {
    await db.close()
  }
})

test("refund MP: sólo total (monto = cobrado por MP, nunca del navegador); pedido sin logística de reclamo no cambia", async () => {
  const db = await setup()
  try {
    const attempt = (await db.query<{ amount: string }>("select * from begin_mercadopago_order_refund(1,$1)", [admin])).rows[0]
    assert.equal(Number(attempt.amount), 60000, "refund total calculado server-side; el parcial no está soportado")
    assert.equal((await db.query<{ p: boolean }>("select is_partial p from mercadopago_order_refunds")).rows[0].p, false)
  } finally {
    await db.close()
  }
})
