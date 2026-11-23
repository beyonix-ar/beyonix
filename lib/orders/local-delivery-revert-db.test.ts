import assert from "node:assert/strict"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  ANDREANI_ORDER,
  LOCAL_ORDER,
  LOCAL_SINGLE,
  localDeliveryOutcomeSetupSql,
  OUTCOME_ACTOR as operator,
  OUTCOME_CUSTOMER,
  OUTCOME_PICK_CODES,
  OUTCOME_SEED_SQL,
  outcomeToken,
  readRepoFile,
} from "./fixtures/local-delivery-outcome-db.ts"

// Corrección de "Entregado al cadete" (20261123120000) contra las migraciones
// reales del circuito local: sólo Admin/Super Admin, con motivo, sin tocar
// stock, bultos, etiquetas ni el QR, y rechazada si el cadete ya informó algo.

const REVERT_MIGRATION = "supabase/migrations/20261123120000_local_delivery_revert_in_transit.sql"
const ADMIN = "40000000-0000-4000-8000-000000000004"
const SUPER_ADMIN = "50000000-0000-4000-8000-000000000005"
const REASON = "Se marcó por error: el pedido sigue en el depósito."

let requestNumber = 0
const key = () => `94000000-0000-4000-8000-${String(++requestNumber).padStart(12, "0")}`

async function setup() {
  const db = new PGlite()
  for (const sql of localDeliveryOutcomeSetupSql()) await db.exec(sql)
  // Columnas reales de order_audit_events que el fixture parcial no tiene.
  await db.exec("alter table order_audit_events add column if not exists previous_status text; alter table order_audit_events add column if not exists new_status text;")
  await db.exec(readRepoFile(REVERT_MIGRATION))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  await db.exec(OUTCOME_SEED_SQL)
  await db.exec(`insert into profiles(id,rol) values ('${ADMIN}','admin'),('${SUPER_ADMIN}','super_admin');`)
  return db
}

type Row = Record<string, unknown>
const one = async <T extends Row>(db: PGlite, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
const count = async (db: PGlite, sql: string, params: unknown[] = []) => (await one<{ count: number }>(db, `select count(*)::int count from (${sql}) rows`, params)).count
const estado = async (db: PGlite, orderId = LOCAL_ORDER) => (await one<{ estado: string }>(db, "select estado from ordenes where id=$1", [orderId])).estado

async function prepare(db: PGlite, orderId: number, parcelCount: number) {
  await db.query("select begin_order_preparation($1,$2)", [orderId, operator])
  for (const code of OUTCOME_PICK_CODES[orderId]) await db.query("select scan_order_preparation_code($1,$2,$3,$4)", [orderId, code, operator, key()])
  await db.query("select set_order_package_parcels($1,$2,$3,$4)", [orderId, parcelCount, operator, key()])
  const codes = (await db.query<{ barcode: string }>("select barcode from order_package_parcels where order_id=$1 order by parcel_index", [orderId])).rows.map((row) => row.barcode)
  for (const code of codes) await db.query("select confirm_local_delivery_parcel($1,$2,$3)", [orderId, code, operator])
  return codes
}

/** Pedido local preparado, QR emitido y entregado al cadete con la RPC real (+ registro de En camino del servicio). */
async function handedOver(db: PGlite, orderId = LOCAL_ORDER, parcels = 2, fromEstado = "pagado") {
  if (fromEstado !== "pagado") await db.query("update ordenes set estado=$2 where id=$1", [orderId, fromEstado])
  const codes = await prepare(db, orderId, parcels)
  const token = (await one<{ token: string }>(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [orderId, operator, outcomeToken(orderId)])).token
  const moved = await db.query("select id from mark_local_delivery_in_transit($1,$2,$3)", [orderId, fromEstado, operator])
  assert.equal(moved.rows.length, 1, "sale con el cadete")
  await db.query(`insert into order_audit_events(order_id,actor_type,actor_id,action,previous_status,new_status,metadata)
    values ($1,'admin',$2,'order_status_changed',$3,'en_camino',jsonb_build_object('localDeliveryEffect','in_transit_status','localDeliveryEffectState','completed','previousEstado',$3::text,'newEstado','en_camino'))`, [orderId, operator, fromEstado])
  return { codes, token }
}

const revert = (db: PGlite, actor: string, requestKey = key(), reason = REASON, orderId = LOCAL_ORDER) =>
  one<{ result: { orderId: number; estado: string; replayed: boolean } }>(db, "select revert_local_delivery_in_transit($1,$2,$3,$4) result", [orderId, actor, reason, requestKey]).then((row) => row.result)

/** Foto de todo lo que la corrección NO debe tocar. */
async function snapshot(db: PGlite, orderId = LOCAL_ORDER) {
  return {
    stock: await one(db, "select (select stock from productos where id=1)::int a, (select stock from productos where id=2)::int b, (select stock from producto_variantes where id=11)::int red"),
    packages: (await db.query("select id,status,attempt_number,parcel_count from order_packages where order_id=$1 order by id", [orderId])).rows,
    parcels: (await db.query("select id,barcode,parcel_index,label_confirmed_at from order_package_parcels where order_id=$1 order by id", [orderId])).rows,
    shipments: (await db.query("select id,access_token,token_revoked_at,outcome_status,failed_attempts from local_delivery_shipments where order_id=$1 order by id", [orderId])).rows,
    payment: await one(db, "select payment_status,paid_at,payment_confirmed_amount,financial_status,invoice_status,invoice_cae from ordenes where id=$1", [orderId]),
  }
}

test("corrección válida (Admin): vuelve a preparación sin tocar stock, bultos, etiquetas, QR, pago ni factura; deja auditoría completa", async () => {
  const db = await setup()
  const { token } = await handedOver(db)
  const before = await snapshot(db)
  assert.equal(await count(db, "select 1 from dispatch_blocks where order_id=$1 and reason='tracking_in_circuit' and resolved_at is null", [LOCAL_ORDER]), 1, "En camino bloquea la preparación")

  const result = await revert(db, ADMIN)
  assert.deepEqual([result.estado, result.replayed], ["pagado", false])
  assert.equal(await estado(db), "pagado")
  assert.deepEqual(await snapshot(db), before, "sin duplicar ni modificar bultos, movimientos, reservas ni el token")
  assert.equal(await count(db, "select 1 from dispatch_blocks where order_id=$1 and reason='tracking_in_circuit' and resolved_at is null", [LOCAL_ORDER]), 0, "se libera el bloqueo 'Envío ya en curso'")

  const audit = await one<{ actor_type: string; actor_id: string; previous_status: string; new_status: string; metadata: Record<string, unknown> }>(db,
    "select actor_type,actor_id,previous_status,new_status,metadata from order_audit_events where order_id=$1 and action='local_delivery_in_transit_reverted'", [LOCAL_ORDER])
  assert.deepEqual([audit.actor_type, audit.actor_id, audit.previous_status, audit.new_status], ["admin", ADMIN, "en_camino", "pagado"])
  assert.equal(audit.metadata.reason, REASON)
  assert.equal(audit.metadata.actorRole, "admin")
  assert.equal(await count(db, "select 1 from order_audit_events where order_id=$1 and action='order_status_changed'", [LOCAL_ORDER]), 1, "el historial anterior se conserva")

  // El QR sigue siendo el mismo, pero no registra nada mientras no vuelva a salir.
  const courier = await one<{ result: { result: string; changed: boolean } }>(db, "select record_local_delivery_courier_outcome($1,'absent',0) result", [token])
  assert.deepEqual([courier.result.result, courier.result.changed], ["not_in_transit", false])
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [token])).rows.length, 0, "el cadete no puede entregar un pedido en preparación")

  // Flujo normal: vuelve a salir con los mismos bultos y el mismo QR.
  assert.equal((await db.query("select id from mark_local_delivery_in_transit($1,'pagado',$2)", [LOCAL_ORDER, operator])).rows.length, 1)
  assert.equal(await estado(db), "en_camino")
  assert.deepEqual((await snapshot(db)).parcels, before.parcels)
  assert.deepEqual((await snapshot(db)).shipments, before.shipments)
})

test("idempotencia y concurrencia: la misma solicitud no corrige dos veces; una segunda corrección distinta encuentra el pedido ya en preparación", async () => {
  const db = await setup()
  await handedOver(db)
  const requestKey = key()
  await revert(db, SUPER_ADMIN, requestKey)
  const replay = await revert(db, SUPER_ADMIN, requestKey)
  assert.equal(replay.replayed, true)
  assert.equal(await count(db, "select 1 from order_audit_events where order_id=$1 and action='local_delivery_in_transit_reverted'", [LOCAL_ORDER]), 1)
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_NOT_IN_TRANSIT/)
})

test("restaura el estado de preparación real del que salió (preparado)", async () => {
  const db = await setup()
  await handedOver(db, LOCAL_SINGLE, 1, "preparado")
  const result = await revert(db, ADMIN, key(), REASON, LOCAL_SINGLE)
  assert.equal(result.estado, "preparado")
  assert.equal(await estado(db, LOCAL_SINGLE), "preparado")
})

test("permisos: operador, cliente o sin service_role => rechazo sin cambios", async () => {
  const db = await setup()
  await handedOver(db)
  for (const actor of [operator, OUTCOME_CUSTOMER, "90000000-0000-4000-8000-000000000009"]) {
    await assert.rejects(revert(db, actor), /LOCAL_DELIVERY_REVERT_FORBIDDEN/, actor)
  }
  await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_FORBIDDEN/)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  assert.equal(await estado(db), "en_camino")
  assert.equal(await count(db, "select 1 from order_audit_events where action='local_delivery_in_transit_reverted'"), 0)
})

test("motivo obligatorio (10 a 500 caracteres) y clave de solicitud", async () => {
  const db = await setup()
  await handedOver(db)
  for (const reason of ["", "   ", "corto", "x".repeat(501)]) {
    await assert.rejects(revert(db, ADMIN, key(), reason), /LOCAL_DELIVERY_REVERT_REASON_REQUIRED/)
  }
  await assert.rejects(db.query("select revert_local_delivery_in_transit($1,$2,$3,null)", [LOCAL_ORDER, ADMIN, REASON]), /LOCAL_DELIVERY_REVERT_INVALID/)
  assert.equal(await estado(db), "en_camino")
})

test("rechazo con operaciones posteriores incompatibles: resultado del cadete, entregado, cancelado, en preparación, Andreani", async () => {
  // 1.er intento fallido (cliente ausente).
  let db = await setup()
  let ctx = await handedOver(db)
  await db.query("select record_local_delivery_courier_outcome($1,'absent',0)", [ctx.token])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED/)
  assert.equal(await estado(db), "en_camino")

  // Problema con la entrega (incidencia), aunque después se reintente.
  db = await setup()
  ctx = await handedOver(db)
  await db.query("select record_local_delivery_courier_outcome($1,'incident',0,'no_access',null)", [ctx.token])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED/)
  await db.query("select resolve_local_delivery_incident($1,$2,'retry')", [LOCAL_ORDER, operator])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED/, "una incidencia registrada sigue siendo una operación posterior")

  // Entregado por el cadete.
  db = await setup()
  ctx = await handedOver(db)
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [ctx.token])).rows.length, 1)
  await assert.rejects(revert(db, SUPER_ADMIN), /LOCAL_DELIVERY_REVERT_ALREADY_DELIVERED/)
  assert.equal(await estado(db), "entregado")

  // Cancelado / con reintegro.
  db = await setup()
  await handedOver(db)
  await db.query("update ordenes set financial_status='refund_pending' where id=$1", [LOCAL_ORDER])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_ORDER_CANCELLED/)

  // Todavía en preparación: nada que corregir.
  db = await setup()
  await prepare(db, LOCAL_ORDER, 2)
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_NOT_IN_TRANSIT/)

  // Andreani nunca usa esta corrección.
  await db.query("update ordenes set estado='en_camino' where id=$1", [ANDREANI_ORDER])
  await assert.rejects(revert(db, ADMIN, key(), REASON, ANDREANI_ORDER), /DISPATCH_LOCAL_DELIVERY_ONLY/)
  assert.equal(await estado(db, ANDREANI_ORDER), "en_camino")
})

// ── Estado de origen: sólo el registro atómico de la salida ─────────────────

const markers = (db: PGlite, orderId = LOCAL_ORDER) =>
  db.query<{ previous_status: string; new_status: string; actor_id: string }>("select previous_status,new_status,actor_id from order_audit_events where order_id=$1 and action='local_delivery_in_transit_marked' order by id", [orderId]).then((result) => result.rows)

test("la salida con el cadete deja, en la misma operación, el estado real del que salió (y nada si no sale)", async () => {
  const db = await setup()
  await prepare(db, LOCAL_ORDER, 2)
  await one(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [LOCAL_ORDER, operator, outcomeToken(LOCAL_ORDER)])
  assert.equal((await db.query("select id from mark_local_delivery_in_transit($1,'preparado',$2)", [LOCAL_ORDER, operator])).rows.length, 0, "estado de origen equivocado: no sale")
  assert.deepEqual(await markers(db), [], "sin salida no hay registro")
  assert.equal((await db.query("select id from mark_local_delivery_in_transit($1,'pagado',$2)", [LOCAL_ORDER, operator])).rows.length, 1)
  assert.deepEqual(await markers(db), [{ previous_status: "pagado", new_status: "en_camino", actor_id: operator }])
  assert.equal(await estado(db), "en_camino")
})

for (const fromEstado of ["pagado", "preparado"] as const) {
  test(`registro de salida ausente (${fromEstado}): se rechaza sin cambios, aunque el historial del servicio diga otra cosa`, async () => {
    const db = await setup()
    const orderId = fromEstado === "pagado" ? LOCAL_ORDER : LOCAL_SINGLE
    await handedOver(db, orderId, fromEstado === "pagado" ? 2 : 1, fromEstado)
    // Pedido que salió sin registro atómico (p. ej. antes de esta migración).
    await db.query("delete from order_audit_events where order_id=$1 and action='local_delivery_in_transit_marked'", [orderId])
    const before = await snapshot(db, orderId)
    const blockers = await db.query<{ blocker: string | null; previous_estado: string | null }>("select blocker,previous_estado from local_delivery_revert_blockers(array[$1]::bigint[])", [orderId])
    assert.deepEqual(blockers.rows, [{ blocker: "LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN", previous_estado: null }])
    await assert.rejects(revert(db, ADMIN, key(), REASON, orderId), /LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN/)
    assert.equal(await estado(db, orderId), "en_camino", "nunca se inventa el estado anterior")
    assert.deepEqual(await snapshot(db, orderId), before)
    assert.equal(await count(db, "select 1 from order_audit_events where order_id=$1 and action='local_delivery_in_transit_reverted'", [orderId]), 0)
  })
}

test("el registro del servicio con un estado por defecto equivocado no decide: vuelve al estado real (preparado)", async () => {
  const db = await setup()
  await db.query("update ordenes set estado='preparado' where id=$1", [LOCAL_SINGLE])
  await prepare(db, LOCAL_SINGLE, 1)
  await one(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [LOCAL_SINGLE, operator, outcomeToken(LOCAL_SINGLE)])
  assert.equal((await db.query("select id from mark_local_delivery_in_transit($1,'preparado',$2)", [LOCAL_SINGLE, operator])).rows.length, 1)
  // Reintento automático del efecto: escribe previousEstado 'pagado' por defecto.
  await db.query(`insert into order_audit_events(order_id,actor_type,action,previous_status,new_status,metadata)
    values ($1,'system','order_status_changed','pagado','en_camino',jsonb_build_object('localDeliveryEffect','in_transit_status','localDeliveryEffectState','completed','previousEstado','pagado','newEstado','en_camino'))`, [LOCAL_SINGLE])
  assert.equal((await revert(db, ADMIN, key(), REASON, LOCAL_SINGLE)).estado, "preparado")
  assert.equal(await estado(db, LOCAL_SINGLE), "preparado")
})

test("una salida anterior a la última corrección no sirve: sin registro nuevo, se rechaza; con salida nueva, vuelve a su estado", async () => {
  const db = await setup()
  await handedOver(db)
  await revert(db, ADMIN)
  // Vuelve a En camino sin pasar por la salida atómica: el registro vigente es anterior a la corrección.
  await db.query("update ordenes set estado='en_camino' where id=$1", [LOCAL_ORDER])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_PREVIOUS_UNKNOWN/)
  assert.equal(await estado(db), "en_camino")
  await db.query("update ordenes set estado='pagado' where id=$1", [LOCAL_ORDER])
  // Salida normal posterior: la corrección vuelve a estar disponible.
  assert.equal((await db.query("select id from mark_local_delivery_in_transit($1,'pagado',$2)", [LOCAL_ORDER, operator])).rows.length, 1)
  assert.equal((await revert(db, SUPER_ADMIN)).estado, "pagado")
  assert.equal(await count(db, "select 1 from order_audit_events where order_id=$1 and action='local_delivery_in_transit_reverted'", [LOCAL_ORDER]), 2)
})

test("regla única (local_delivery_revert_blockers): misma respuesta que la corrección, por lote y sin modificar nada", async () => {
  const db = await setup()
  const ctx = await handedOver(db)
  await handedOver(db, LOCAL_SINGLE, 1, "preparado")
  const rule = async () => Object.fromEntries((await db.query<{ order_id: number; blocker: string | null; previous_estado: string | null }>(
    "select order_id::int order_id,blocker,previous_estado from local_delivery_revert_blockers(array[$1,$2,$3,999999]::bigint[])", [LOCAL_ORDER, LOCAL_SINGLE, ANDREANI_ORDER])).rows
    .map((row) => [row.order_id, [row.blocker, row.previous_estado]]))
  assert.deepEqual(await rule(), {
    [LOCAL_ORDER]: [null, "pagado"], [LOCAL_SINGLE]: [null, "preparado"],
    [ANDREANI_ORDER]: ["DISPATCH_LOCAL_DELIVERY_ONLY", null], 999999: ["DISPATCH_ORDER_NOT_FOUND", null],
  })
  // Problema con la entrega + "Reintentar entrega": el resultado vuelve a pendiente, pero la corrección ya no corresponde.
  await db.query("select record_local_delivery_courier_outcome($1,'incident',0,'no_access',null)", [ctx.token])
  await db.query("select resolve_local_delivery_incident($1,$2,'retry')", [LOCAL_ORDER, operator])
  assert.equal((await one<{ outcome_status: string }>(db, "select outcome_status from local_delivery_shipments where order_id=$1", [LOCAL_ORDER])).outcome_status, "pending")
  assert.deepEqual((await rule())[LOCAL_ORDER], ["LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED", null])
  await assert.rejects(revert(db, ADMIN), /LOCAL_DELIVERY_REVERT_OUTCOME_RECORDED/)
  assert.equal(await estado(db), "en_camino")
})

test("QR revocado: reimprimir emite uno nuevo sobre la misma entrega y el anterior deja de funcionar", async () => {
  const db = await setup()
  const { token: oldToken } = await handedOver(db)
  await db.query("update local_delivery_shipments set token_revoked_at=now() where order_id=$1", [LOCAL_ORDER])
  const newToken = "NuevoTokenDePruebaRevocado01"
  const issued = (await one<{ token: string }>(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [LOCAL_ORDER, ADMIN, newToken])).token
  assert.equal(issued, newToken)
  assert.notEqual(issued, oldToken)
  const shipments = (await db.query("select access_token,token_revoked_at,outcome_status from local_delivery_shipments where order_id=$1", [LOCAL_ORDER])).rows
  assert.deepEqual(shipments, [{ access_token: newToken, token_revoked_at: null, outcome_status: "pending" }], "misma entrega, sin duplicar")
  assert.equal(await count(db, "select 1 from local_delivery_shipments where access_token=$1", [oldToken]), 0, "el token anterior ya no existe")
  // El QR anterior no registra nada.
  assert.equal((await db.query("select * from mark_local_delivery_delivered_by_courier($1)", [oldToken])).rows.length, 0)
  await db.query("select record_local_delivery_courier_outcome($1,'absent',0)", [oldToken]).catch(() => undefined)
  assert.equal(await estado(db), "en_camino")
  assert.equal((await one<{ failed_attempts: number }>(db, "select failed_attempts from local_delivery_shipments where order_id=$1", [LOCAL_ORDER])).failed_attempts, 0)
  // Reimprimir otra vez (sin revocar) devuelve el mismo token nuevo.
  assert.equal((await one<{ token: string }>(db, "select ensure_local_delivery_shipment($1,$2,$3) token", [LOCAL_ORDER, ADMIN, "OtroTokenQueNoSeUsa0000001"])).token, newToken)
})
