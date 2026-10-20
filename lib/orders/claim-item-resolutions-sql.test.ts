import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite, type Transaction } from "@electric-sql/pglite"

// 20261020100000_claim_item_resolutions sobre la cadena REAL de migraciones de
// reclamos y el motor REAL de stock (PGlite): resolución por producto/unidad,
// NC parcial por solución, cierre mixto y Reemplazo -> Reintegro/Saldo por
// falta de stock.

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
]

type Db = PGlite
type Row = Record<string, unknown>
type Line = { order_item_id: number; solution: "replacement" | "refund" | "credit"; quantity: number }

// Pedido: ítem 1 = Auricular x3 ($30.000 c/u, variante 1); ítem 2 = Encendedor x1 ($9.000, variante 3).
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
    "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',99000,'domicilio')",
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

const one = async <T extends Row = Row>(db: Db | Transaction, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const count = async (db: Db, sql: string, params: unknown[] = []) => Number((await one<{ n: number }>(db, sql, params)).n)
const version = async (db: Db, id: number) => String((await one<{ v: string }>(db, "select updated_at::text v from order_claims where id=$1", [id])).v)
const mutate = async (db: Db, id: number, patch: Row) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
const setLines = async (db: Db, id: number, lines: Line[], actor = admin) =>
  db.query("select * from set_order_claim_item_resolutions($1,$2,$3,$4,null)", [id, actor, await version(db, id), JSON.stringify(lines)])
const switchToFinancial = async (db: Db, id: number, target: "refund" | "credit", itemId: number | null = null, expected?: string) =>
  db.query("select * from switch_order_claim_replacement_resolution($1,$2,$3,$4,$5,'Sin stock del modelo')",
    [id, admin, expected ?? await version(db, id), itemId, target])
const lines = async (db: Db, id: number) =>
  (await db.query<{ order_item_id: number; solution: string; quantity: number }>(
    "select order_item_id::int, solution, quantity from order_claim_item_resolutions where claim_id=$1 order by order_item_id, solution", [id])).rows
const stock = async (db: Db, variant: number) => Number((await one<{ s: number }>(db, "select stock s from producto_variantes where id=$1", [variant])).s)
async function units(db: Db, claimId: number) {
  const rows = (await db.query<{ role: string; location: string; n: number }>(
    "select role, location, count(*)::int n from order_claim_units where claim_id=$1 group by role, location order by role, location", [claimId])).rows
  return Object.fromEntries(rows.map((row) => [`${row.role}:${row.location}`, row.n]))
}
const resendWithoutReturn = async (db: Db, claimId: number) =>
  Number((await one(db, "select * from request_order_claim_resend_without_return($1,$2,$3,$4,'Sucursal Once','Av. Pueyrredón 100')",
    [claimId, admin, NOTE, BRANCH])).id)
const reserve = (db: Db, claimId: number, itemId: number, variant: number, quantity: number, key = randomUUID()) =>
  db.query("select * from create_order_replacement(1,$1,$2,$3,'mismo_producto',$4,$5,null,null,$6)", [itemId, variant, quantity, admin, key, claimId])
async function generate(db: Db, legId: number, envioId: string) {
  const token = randomUUID()
  await db.query("select * from claim_order_claim_shipment_creation($1,$2,'PROD','entrega_sucursal','400042106')", [legId, token])
  await db.query("select * from complete_order_claim_shipment_creation($1,$2,$3,$3,'Creada',null)", [legId, token, envioId])
}
const deliver = (db: Db, legId: number) =>
  db.query("select * from apply_order_claim_shipment_tracking($1,'entregada',false,'Estado Andreani',null,'EnvioEntregado','2026-10-20T10:00:00Z'::timestamptz,'2026-10-20T10:00:00Z'::timestamptz,null)", [legId])

/** NC ligada al reclamo (encabezado + renglones en UNA transacción, como begin_partial_credit_note). */
async function creditNote(db: Db, claimId: number, destination: string, items: Array<[number, number]>,
  { status = "processing", settled = false } = {}) {
  const prices: Record<number, number> = { 1: 30000, 2: 9000 }
  const total = items.reduce((sum, [itemId, quantity]) => sum + prices[itemId] * quantity, 0)
  return db.transaction(async (tx) => {
    const note = await one<{ id: string }>(tx,
      "insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,items_amount,manual_amount,reason,operation_type,created_by,cae,settlement_status) values(1,$1,$2,$3,$4,$4,0,'Reclamo mixto','devolucion_parcial',$5,$6,$7) returning id",
      [claimId, status, destination, total, admin, status === "authorized" ? "75123456789012" : null, settled ? "completado" : "pendiente"])
    for (const [itemId, quantity] of items) {
      await tx.query("insert into order_credit_note_items(credit_note_id,order_item_id,quantity,unit_amount,total_amount,product_name) values($1,$2,$3,$4,$5,'Producto')",
        [note.id, itemId, quantity, prices[itemId], prices[itemId] * quantity])
    }
    return note.id
  })
}
const settle = (db: Db, noteId: string) =>
  db.query("update order_credit_notes set status='authorized', cae='75123456789012', settlement_status='completado' where id=$1", [noteId])
const close = (db: Db, id: number, resolution = "mixta") => mutate(db, id, { status: "cerrado", resolution })

test("G: nunca más unidades que las reclamadas ni dos veces la misma unidad", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await assert.rejects(setLines(db, id, [
      { order_item_id: 1, solution: "replacement", quantity: 2 }, { order_item_id: 1, solution: "refund", quantity: 1 },
    ]), /CLAIM_RESOLUTION_QUANTITY_EXCEEDED/, "2 reemplazos + 1 reintegro sobre 2 reclamadas")
    await assert.rejects(setLines(db, id, [{ order_item_id: 2, solution: "refund", quantity: 1 }, { order_item_id: 1, solution: "replacement", quantity: 1 }]),
      /CLAIM_RESOLUTION_INVALID_ITEM/, "un ítem que no forma parte del reclamo")
    await assert.rejects(setLines(db, id, [
      { order_item_id: 1, solution: "refund", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 },
    ]), /CLAIM_RESOLUTION_INVALID_LINES/, "la misma solución dos veces")
    await assert.rejects(setLines(db, id, [{ order_item_id: 1, solution: "replacement", quantity: 2 }]),
      /CLAIM_RESOLUTION_NOT_MIXED/, "una sola solución para todo es un reclamo simple")
    await assert.rejects(setLines(db, id, [
      { order_item_id: 1, solution: "replacement", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 },
    ], operator), /CLAIM_FORBIDDEN/)
    await assert.rejects(mutate(db, id, { status: "aprobado", resolution: "mixta" }), /CLAIM_INVALID/, "mixta sólo con su operación")
    assert.deepEqual(await lines(db, id), [], "ningún intento rechazado dejó filas")

    await setLines(db, id, [{ order_item_id: 1, solution: "replacement", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 }])
    // La base también lo exige ante una escritura directa.
    await assert.rejects(db.query("insert into order_claim_item_resolutions(claim_id,order_item_id,solution,quantity) values($1,1,'credit',1)", [id]),
      /CLAIM_RESOLUTION_QUANTITY_EXCEEDED/)
    await assert.rejects(db.query("update order_claim_item_resolutions set quantity=2 where claim_id=$1 and solution='refund'", [id]),
      /CLAIM_RESOLUTION_QUANTITY_EXCEEDED/)
    await assert.rejects(mutate(db, id, { action: "affected_items", items: [{ order_item_id: 1, quantity: 1 }] }), /CLAIM_ITEMS_LOCKED/,
      "no se reducen los ítems por debajo de lo ya resuelto")
  } finally {
    await db.close()
  }
})

test("D/P/L/M: Auricular x2 = 1 reemplazo + 1 reintegro; NC sólo por la unidad reintegrada; cierra con ambas ramas", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await setLines(db, id, [{ order_item_id: 1, solution: "replacement", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 }])
    const claim = await one<{ status: string; resolution: string }>(db, "select status, resolution from order_claims where id=$1", [id])
    assert.deepEqual(claim, { status: "aprobado", resolution: "mixta" })
    assert.equal(await count(db, "select count(*)::int n from order_audit_events where action='claim_item_resolutions_set'"), 1)

    // Stock mixto: sólo UNA unidad nueva sale del stock.
    const legId = await resendWithoutReturn(db, id)
    const key = randomUUID()
    await reserve(db, id, 1, 1, 1, key)
    await reserve(db, id, 1, 1, 1, key)
    assert.equal(await stock(db, 1), 4, "O: misma clave, un solo descuento")
    await assert.rejects(reserve(db, id, 1, 1, 1), /REPLACEMENT_QUANTITY_EXCEEDED/, "la unidad de reintegro nunca se reemplaza")
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2, "reemplazo:reservada": 1 })

    // NC parcial: nunca toma el total del reclamo ni la unidad reemplazada.
    await assert.rejects(creditNote(db, id, "external_refund", [[1, 2]]), /INVALID_CREDIT_NOTE_CLAIM_ITEM/)
    await assert.rejects(creditNote(db, id, "customer_balance", [[1, 1]]), /INVALID_CREDIT_NOTE_CLAIM_ITEM/, "sin unidades de saldo")
    await assert.rejects(creditNote(db, id, "external_refund", []), /INVALID_CREDIT_NOTE_CLAIM_ITEM/, "nunca una NC sin productos")
    const refundNote = await creditNote(db, id, "external_refund", [[1, 1]])
    assert.equal(Number((await one(db, "select total_amount from order_credit_notes where id=$1", [refundNote])).total_amount), 30000)
    await settle(db, refundNote)
    await assert.rejects(creditNote(db, id, "external_refund", [[1, 1]]), /INVALID_CREDIT_NOTE_CLAIM_ITEM/, "M: el reintegro no se repite")

    await assert.rejects(close(db, id), /CLAIM_LOGISTICS_OPEN/, "reintegro listo, reemplazo todavía reservado")
    await generate(db, legId, "360000000901")
    await deliver(db, legId)
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2, "reemplazo:entregada_cliente": 1 })
    await close(db, id)
    const closed = await one<{ status: string; label: string; amount: string }>(db,
      "select status, resolution_summary->>'label' label, resolution_summary->>'amount' amount from order_claims where id=$1", [id])
    assert.deepEqual(closed, { status: "cerrado", label: "Solución por producto", amount: "30000" })
  } finally {
    await db.close()
  }
})

test("E/K/N/P: dos productos (A reemplazo, B saldo); el saldo va primero y no crea pedido", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 1 }, { order_item_id: 2, quantity: 1 }])
    await setLines(db, id, [{ order_item_id: 1, solution: "replacement", quantity: 1 }, { order_item_id: 2, solution: "credit", quantity: 1 }])
    const orders = await count(db, "select count(*)::int n from ordenes")
    // Logística primero (el cliente conserva ambos originales); el dinero queda liberado.
    const legId = await resendWithoutReturn(db, id)

    await assert.rejects(creditNote(db, id, "customer_balance", [[1, 1]]), /INVALID_CREDIT_NOTE_CLAIM_ITEM/, "A no es saldo")
    // Dinero externo antes que el saldo dejaría el pedido "reintegrado" y bloquearía la NC del saldo.
    await assert.rejects(db.query("insert into order_refund_proofs(order_id,amount) values(1,9000)"), /CLAIM_MIXED_CREDIT_FIRST/)
    const creditNoteId = await creditNote(db, id, "customer_balance", [[2, 1]])
    assert.equal(Number((await one(db, "select total_amount from order_credit_notes where id=$1", [creditNoteId])).total_amount), 9000,
      "K: el saldo es exactamente el valor del producto")
    await assert.rejects(creditNote(db, id, "customer_balance", [[2, 1]]), /INVALID_CREDIT_NOTE_CLAIM_ITEM|order_credit_notes_single_processing/,
      "N: el saldo no se acredita dos veces")
    await settle(db, creditNoteId)
    assert.equal(await count(db, "select count(*)::int n from ordenes"), orders, "K: no se genera un pedido nuevo")

    await assert.rejects(close(db, id), /CLAIM_MIXED_REPLACEMENT_PENDING/, "P: falta la rama de reemplazo")
    await reserve(db, id, 1, 1, 1)
    await generate(db, legId, "360000000902")
    await deliver(db, legId)
    await close(db, id)
    assert.equal((await one(db, "select status from order_claims where id=$1", [id])).status, "cerrado")
  } finally {
    await db.close()
  }
})

test("F: resolución parcial -> no cierra; agregar la unidad pendiente nunca reduce lo ya asignado", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await setLines(db, id, [{ order_item_id: 1, solution: "refund", quantity: 1 }])
    await assert.rejects(close(db, id), /CLAIM_MIXED_UNRESOLVED_UNITS/)
    await assert.rejects(setLines(db, id, [{ order_item_id: 1, solution: "credit", quantity: 1 }]), /CLAIM_RESOLUTION_LOCKED/,
      "no se mueve una unidad ya asignada")
    await setLines(db, id, [{ order_item_id: 1, solution: "refund", quantity: 1 }, { order_item_id: 1, solution: "credit", quantity: 1 }])
    assert.deepEqual(await lines(db, id), [
      { order_item_id: 1, solution: "credit", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 },
    ])
    const credit = await creditNote(db, id, "customer_balance", [[1, 1]])
    await settle(db, credit)
    await assert.rejects(close(db, id), /CLAIM_MIXED_REFUND_PENDING/)
    const refund = await creditNote(db, id, "external_refund", [[1, 1]])
    await assert.rejects(close(db, id), /CLAIM_CREDIT_PENDING/, "NC del reintegro todavía en proceso")
    await settle(db, refund)
    await close(db, id)
  } finally {
    await db.close()
  }
})

test("H: reemplazo sin stock antes de reservar -> pasa a reintegro, auditado", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await mutate(db, id, { status: "cambio_pendiente", resolution: "cambio_producto" })
    const stale = await version(db, id)
    await switchToFinancial(db, id, "refund")
    const claim = await one<{ status: string; resolution: string }>(db, "select status, resolution from order_claims where id=$1", [id])
    assert.deepEqual(claim, { status: "aprobado", resolution: "reintegro_total" })
    const audit = await one<{ label: string; reason: string }>(db,
      "select metadata->>'label' label, metadata->>'reason' reason from order_audit_events where action='claim_resolution_switched'")
    assert.deepEqual(audit, { label: "Resolución cambiada de Reemplazo a Reintegro por falta de stock", reason: "sin_stock" })
    assert.equal(await count(db, "select count(*)::int n from order_claim_messages where claim_id=$1 and system_key like 'resolution_switched_refund%'", [id]), 1)
    await assert.rejects(switchToFinancial(db, id, "refund", null, stale), /CLAIM_CONFLICT/, "un doble click no repite el cambio")
    await assert.rejects(switchToFinancial(db, id, "credit"), /CLAIM_INVALID/, "ya no es un reemplazo")
    // Desde ahora es un reintegro normal: admite su NC.
    await creditNote(db, id, "external_refund", [[1, 2]])
  } finally {
    await db.close()
  }
})

test("I: reemplazo reservado y reversible -> libera la reserva (stock vuelve) y pasa a saldo", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    const legId = await resendWithoutReturn(db, id)
    await reserve(db, id, 1, 1, 2)
    assert.equal(await stock(db, 1), 3)
    await switchToFinancial(db, id, "credit")
    assert.equal(await stock(db, 1), 5, "la reserva vuelve al stock")
    assert.deepEqual(await units(db, id), { "original:conservada_cliente": 2, "reemplazo:reincorporada_stock": 2 })
    assert.equal((await one(db, "select status from order_claim_shipments where id=$1", [legId])).status, "cancelada")
    assert.equal((await one(db, "select resolution from order_claims where id=$1", [id])).resolution, "saldo_a_favor")
    assert.equal(Number((await one(db, "select sum(quantity - reverted_quantity) n from order_replacements where claim_id=$1", [id])).n), 0)
  } finally {
    await db.close()
  }
})

test("I (mixto): sólo la unidad de reemplazo pasa a reintegro; lo demás queda igual", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db, [{ order_item_id: 1, quantity: 2 }, { order_item_id: 2, quantity: 1 }])
    await setLines(db, id, [
      { order_item_id: 1, solution: "replacement", quantity: 1 }, { order_item_id: 1, solution: "refund", quantity: 1 },
      { order_item_id: 2, solution: "replacement", quantity: 1 },
    ])
    await resendWithoutReturn(db, id)
    await reserve(db, id, 1, 1, 1)
    await reserve(db, id, 2, 3, 1)
    assert.deepEqual([await stock(db, 1), await stock(db, 3)], [4, 1])
    await assert.rejects(switchToFinancial(db, id, "refund"), /CLAIM_RESOLUTION_INVALID_ITEM/, "en un mixto se indica el producto")
    await switchToFinancial(db, id, "refund", 1)
    assert.deepEqual(await lines(db, id), [
      { order_item_id: 1, solution: "refund", quantity: 2 }, { order_item_id: 2, solution: "replacement", quantity: 1 },
    ])
    assert.deepEqual([await stock(db, 1), await stock(db, 3)], [5, 1], "sólo se libera la reserva del ítem cambiado")
    assert.equal((await one(db, "select resolution from order_claims where id=$1", [id])).resolution, "mixta")
  } finally {
    await db.close()
  }
})

test("J: reemplazo ya despachado -> NO puede pasar a reintegro", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    const legId = await resendWithoutReturn(db, id)
    await reserve(db, id, 1, 1, 2)
    await generate(db, legId, "360000000903")
    await assert.rejects(switchToFinancial(db, id, "refund"), /CLAIM_REPLACEMENT_ALREADY_SHIPPED/)
    assert.equal((await one(db, "select resolution from order_claims where id=$1", [id])).resolution, "cambio_producto")
    assert.equal(await stock(db, 1), 3, "nada se liberó")
  } finally {
    await db.close()
  }
})

test("compatibilidad: un reemplazo con la devolución iniciada sigue sin cambiar de resolución por la vía genérica", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await resendWithoutReturn(db, id)
    await reserve(db, id, 1, 1, 2)
    await assert.rejects(mutate(db, id, { status: "aprobado", resolution: "reintegro_total" }), /CLAIM_LOGISTICS_LOCKED/)
  } finally {
    await db.close()
  }
})
