import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { countUnreadBeyonixMessages } from "./customer-claim-unread.ts"
import { getClaimResolutionHistoryTitle, getClaimResolutionText, getClaimResolutionView, parseClaimResolutionSummary } from "./claim-resolution.ts"

// Cierre de reclamos con la cadena REAL de migraciones (PGlite): resolución
// congelada, mensaje automático, notificación de campana, unread e historial.

const customer = "10000000-0000-4000-8000-000000000001"
const other = "10000000-0000-4000-8000-000000000002"
const admin = "10000000-0000-4000-8000-000000000003"
const INTERNAL_NOTE = "Nota interna: cliente conflictivo, no mencionar"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const migration = (name: string) => source(`../../supabase/migrations/${name}.sql`)
const RESOLUTION_MIGRATION = "20260924160000_claim_resolution_summary_notifications"

async function setup({ withResolutionMigration = true, beforeResolutionMigration }: {
  withResolutionMigration?: boolean
  beforeResolutionMigration?: (db: PGlite) => Promise<void>
} = {}) {
  const db = new PGlite()
  await db.exec(source("./fixtures/claim-schema.sql"))
  // customer_notifications con las columnas reales que usan los triggers.
  await db.exec(`alter table customer_notifications
    add column id uuid primary key default gen_random_uuid(), add column is_read boolean not null default false,
    add column created_at timestamptz not null default now(), add column dismissed_at timestamptz`)
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
  await db.exec(migration("20260924150000_claim_product_change_requires_replacement"))
  await db.exec(migration("20260924140000_order_claim_customer_reads"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [other, "cliente"], [admin, "admin"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.query("insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total) values(1,$1,'entregado',now()-interval '1 day','payment_confirmed',90000)", [customer])
  await db.exec("insert into orden_items(id,orden_id,cantidad) values(1,1,2)")
  await beforeResolutionMigration?.(db)
  if (withResolutionMigration) await db.exec(migration(RESOLUTION_MIGRATION))
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
const notifications = async (db: PGlite) =>
  (await db.query<{ type: string; title: string; body: string; action_url: string; source_key: string; is_read: boolean }>(
    "select type,title,body,action_url,source_key,is_read from customer_notifications where type in ('claim_response','claim_resolved') order by created_at, type")).rows
const adminMessages = async (db: PGlite, id: number) =>
  (await db.query<{ id: number; message: string; created_at: string }>(
    "select id::int, message, created_at::text from order_claim_messages where claim_id=$1 and author_role<>'cliente' order by id", [id])).rows
const summaryOf = async (db: PGlite, id: number) =>
  (await db.query<{ s: Record<string, unknown> | null }>("select resolution_summary s from order_claims where id=$1", [id])).rows[0].s

test("1. respuesta normal del admin -> 'BEYONIX respondió tu reclamo' con link al reclamo", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "en_revision", admin_response: "Estamos revisando tu caso.", append_message: true })
    assert.deepEqual((await notifications(db)).map(({ type, title, body, action_url }) => ({ type, title, body, action_url })), [{
      type: "claim_response",
      title: "BEYONIX respondió tu reclamo",
      body: "Tenés un nuevo mensaje sobre el pedido #BX-1001.",
      action_url: "/cuenta/compras/1/ayuda",
    }])
  } finally { await db.close() }
})

test("2-4, 10, 14. cambio de producto: un mensaje, una notificación de resolución, historial y sin notas internas", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "en_revision", admin_response: "Estamos revisando tu caso.", append_message: true })
    await mutate(db, id, { status: "aprobado", resolution: "cambio_producto" })
    await db.query("insert into order_replacements values(1,1,$1,1,$2)", [id, INTERNAL_NOTE])
    const before = await notifications(db)
    await mutate(db, id, { status: "cerrado" })

    const messages = await adminMessages(db, id)
    assert.equal(messages.at(-1)?.message,
      "BEYONIX resolvió el reclamo.\nResolución: Cambio de producto.\nSe registró el reemplazo correspondiente.")
    assert.equal(messages.filter((row) => row.message.startsWith("BEYONIX resolvió")).length, 1, "un solo mensaje de cierre")

    const after = await notifications(db)
    assert.equal(after.length, before.length + 1, "sólo se suma la notificación de resolución")
    const resolved = after.filter((row) => row.type === "claim_resolved")
    assert.deepEqual(resolved.map(({ title, body, action_url, source_key }) => ({ title, body, action_url, source_key })), [{
      title: "Tu reclamo fue resuelto",
      body: "BEYONIX resolvió tu reclamo del pedido #BX-1001. Se aprobó un cambio de producto.",
      action_url: "/cuenta/compras/1/ayuda",
      source_key: `claim-resolved:${id}`,
    }])
    assert.deepEqual(after.filter((row) => row.type === "claim_response"), before, "el cierre no toca ni suma 'respondió'")

    // 10. Historial: auditoría con la resolución.
    const audit = await db.query<{ label: string }>(
      "select metadata->>'resolutionLabel' as label from order_audit_events where action='claim_update' and new_status='cerrado'")
    assert.deepEqual(audit.rows, [{ label: "Cambio de producto" }])

    // 14. Sólo información comunicable: claves fijas, sin notas internas.
    const summary = await summaryOf(db, id)
    assert.deepEqual(Object.keys(summary ?? {}).sort(), ["amount", "detail", "kind", "label", "notice"])
    const everything = JSON.stringify({ summary, messages, after })
    assert.ok(!everything.includes(INTERNAL_NOTE))
  } finally { await db.close() }
})

test("5. saldo a favor: resolución y monto de la nota de crédito liquidada", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "saldo_a_favor" })
    await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,cae,settlement_status) values(1,$1,'authorized','customer_balance',27900,'cae','completado')", [id])
    await db.query("insert into customer_credit_movements(order_id,claim_id,source_type,movement_type) values(1,$1,'credit_note','credit')", [id])
    await mutate(db, id, { action: "mark_credit_note_issued" })
    assert.equal((await adminMessages(db, id)).at(-1)?.message,
      "BEYONIX resolvió el reclamo.\nResolución: Saldo a favor.\nSe acreditaron $27.900 en tu cuenta BEYONIX.")
    assert.deepEqual(await summaryOf(db, id), {
      kind: "saldo_a_favor", label: "Saldo a favor", detail: "Se acreditaron $27.900 en tu cuenta BEYONIX.",
      amount: 27900, notice: "Se acreditó saldo a favor en tu cuenta.",
    })
    const resolved = (await notifications(db)).filter((row) => row.type === "claim_resolved")
    assert.equal(resolved[0]?.body, "BEYONIX resolvió tu reclamo del pedido #BX-1001. Se acreditó saldo a favor en tu cuenta.")
    assert.equal((await notifications(db)).filter((row) => row.type === "claim_response").length, 0)
  } finally { await db.close() }
})

test("6. reintegro: resolución y monto (con centavos) de la nota de reintegro", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await db.query("update order_claims set status='reintegro_pendiente', resolution='reintegro_parcial' where id=$1", [id])
    await db.query("insert into order_credit_notes(order_id,claim_id,status,destination,total_amount,cae,settlement_status) values(1,$1,'authorized','external_refund',12500.5,'cae','completado'),(1,$1,'rejected','external_refund',999,'cae','completado')", [id])
    // Congelado por el trigger, sea cual sea la ruta que cierra.
    await db.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [id])
    assert.deepEqual(await summaryOf(db, id), {
      kind: "reintegro_parcial", label: "Reintegro parcial", detail: "Se gestionó un reintegro por $12.500,50.",
      amount: 12500.5, notice: "Se gestionó un reintegro.",
    })
  } finally { await db.close() }
})

test("7. rechazo: resolución y motivo informado por BEYONIX", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "rechazado", resolution: "rechazado", rejection_reason: "El producto presenta daño por mal uso." })
    const messages = await adminMessages(db, id)
    assert.deepEqual(messages.map((row) => row.message), [
      "BEYONIX resolvió el reclamo.\nResolución: Reclamo no aprobado.\nMotivo: El producto presenta daño por mal uso.",
    ])
    const [resolved] = await notifications(db)
    assert.equal(resolved.type, "claim_resolved")
    assert.equal(resolved.body, "BEYONIX resolvió tu reclamo del pedido #BX-1001. El reclamo no fue aprobado.")
  } finally { await db.close() }
})

test("cierre con texto del admin: un solo mensaje (resolución + texto), sin repetir el motivo", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "aprobado", resolution: "envio_unidad_faltante" })
    await mutate(db, id, { status: "cerrado", admin_response: "Te lo enviamos por Andreani.", append_message: true })
    const messages = await adminMessages(db, id)
    assert.equal(messages.at(-1)?.message,
      "BEYONIX resolvió el reclamo.\nResolución: Envío de unidad faltante.\nSe registró el envío de la unidad faltante.\n\nTe lo enviamos por Andreani.")
    assert.equal((await notifications(db)).filter((row) => row.type === "claim_resolved").length, 1)
  } finally { await db.close() }
})

test("cancelación aprobada: notificación de resolución propia, sin 'respondió'", async () => {
  const db = await setup()
  try {
    await db.exec("update ordenes set estado='pendiente',delivered_at=null,financial_status='pending_payment' where id=1")
    await db.query("insert into order_claims(order_id,user_id,claim_type,failure_type,description) values(1,$1,'transporte_48hs','cancelar_compra','Cancelar mi compra')", [customer])
    await mutate(db, 1, { action: "approve_cancellation", admin_response: "Cancelación aprobada." })
    assert.deepEqual((await notifications(db)).map(({ type, title, body }) => ({ type, title, body })), [{
      type: "claim_resolved",
      title: "Tu solicitud de cancelación fue resuelta",
      body: "BEYONIX resolvió la cancelación del pedido #BX-1001. La cancelación fue aprobada.",
    }])
  } finally { await db.close() }
})

test("11. unread: el mensaje de cierre suma 1; abrir el reclamo lo lee junto con la notificación", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "rechazado", resolution: "rechazado", rejection_reason: "Fuera del plazo de garantía." })
    const messages = await adminMessages(db, id)
    const unread = () => countUnreadBeyonixMessages({ customer_last_read_at: null, order_claim_messages: messages.map((row) => ({ ...row, author_role: "admin" })) })
    assert.equal(unread(), 1, "el cierre aparece como un evento nuevo, una sola vez")
    await db.query("select mark_order_claim_customer_read($1,$2,$3)", [id, customer, messages.at(-1)!.created_at])
    assert.deepEqual((await notifications(db)).map((row) => [row.type, row.is_read]), [["claim_resolved", true]])
  } finally { await db.close() }
})

test("12. otro usuario no puede leer/marcar el reclamo ajeno; la API filtra por titular", async () => {
  const db = await setup()
  try {
    const id = await createClaim(db)
    await mutate(db, id, { status: "rechazado", resolution: "rechazado", rejection_reason: "Fuera del plazo de garantía." })
    await assert.rejects(db.query("select mark_order_claim_customer_read($1,$2,now())", [id, other]), /CLAIM_FORBIDDEN/)
    assert.equal((await db.query("select * from customer_notifications where user_id=$1", [other])).rows.length, 0)
  } finally { await db.close() }
  const route = source("../../app/api/orders/[id]/claims/route.ts")
  assert.match(route, /authorizeCustomerClaimOrder/)
  assert.match(route, /\.eq\("order_id", auth\.order\.id\)/)
  const access = source("./customer-claim-access.ts")
  assert.match(access, /isCustomerOrderOwner\(order, user\)/)
  assert.match(migration(RESOLUTION_MIGRATION), /revoke all on function public\.build_order_claim_resolution_summary\(public\.order_claims\) from public, anon, authenticated;/)
})

test("13. históricos: sin backfill -- resumen NULL y fallback 'Reclamo finalizado'", async () => {
  const db = await setup({
    beforeResolutionMigration: async (db) => {
      await db.query("insert into order_claims(order_id,user_id,claim_type,failure_type,description,status,resolution,closed_at) values(1,$1,'garantia_beyonix','falla','Caso viejo','cerrado','cambio_producto',now())", [customer])
    },
  })
  try {
    const historic = (await db.query<{ status: string; failure_type: string; resolution_summary: unknown }>(
      "select status, failure_type, resolution_summary from order_claims where description='Caso viejo'")).rows[0]
    assert.equal(historic.resolution_summary, null)
    assert.deepEqual(getClaimResolutionView(historic), {
      label: "Reclamo finalizado", detail: null, amount: null, amountLabel: null, rejected: false, structured: false,
    })
    assert.equal(getClaimResolutionHistoryTitle("Reclamo finalizado", historic), "Reclamo finalizado")
  } finally { await db.close() }
})

test("vista: valida la forma del jsonb y arma etiquetas de monto", () => {
  assert.equal(parseClaimResolutionSummary({ kind: "inventado", label: "X" }), null)
  assert.equal(parseClaimResolutionSummary("texto"), null)
  assert.equal(getClaimResolutionView({ status: "aprobado", resolution_summary: null }), null, "abierto: sin bloque")
  const saldo = getClaimResolutionView({ status: "cerrado", resolution_summary: { kind: "saldo_a_favor", label: "Saldo a favor", detail: "Se acreditaron $27.900 en tu cuenta BEYONIX.", amount: 27900, notice: "x" } })
  assert.deepEqual(saldo, { label: "Saldo a favor", detail: "Se acreditaron $27.900 en tu cuenta BEYONIX.", amount: 27900, amountLabel: "Saldo acreditado", rejected: false, structured: true })
  assert.equal(getClaimResolutionHistoryTitle("Reclamo finalizado", { status: "cerrado", resolution_summary: { kind: "cambio_producto", label: "Cambio de producto" } }),
    "Reclamo finalizado — Resolución: Cambio de producto")
})

test("email de cierre: mismo texto que el chat, sin repetir el motivo; consultas e históricos sin cambios", () => {
  const rejected = { kind: "rechazado", label: "Reclamo no aprobado", detail: "Motivo: Fuera de garantía.", amount: null, notice: "x" }
  assert.equal(getClaimResolutionText({ status: "rechazado", failure_type: "falla", resolution_summary: rejected, admin_response: "Fuera de garantía.", rejection_reason: "Fuera de garantía." }),
    "BEYONIX resolvió tu reclamo.\nResolución: Reclamo no aprobado.\nMotivo: Fuera de garantía.")
  const change = { kind: "cambio_producto", label: "Cambio de producto", detail: "Se registró el reemplazo correspondiente.", amount: null, notice: "x" }
  assert.equal(getClaimResolutionText({ status: "cerrado", failure_type: "falla", resolution_summary: change, admin_response: "Sale mañana." }),
    "BEYONIX resolvió tu reclamo.\nResolución: Cambio de producto.\nSe registró el reemplazo correspondiente.\nSale mañana.")
  assert.equal(getClaimResolutionText({ status: "cerrado", failure_type: "consulta_pedido", resolution_summary: { kind: "consulta", label: "Consulta resuelta" } }), null)
  assert.equal(getClaimResolutionText({ status: "cerrado", failure_type: "falla", resolution_summary: null }), null)
  assert.equal(getClaimResolutionText({ status: "aprobado", failure_type: "falla", resolution_summary: change }), null)
  const route = source("../../app/api/admin/order-claims/[claimId]/route.ts")
  assert.match(route, /const resolutionText = getClaimResolutionText\(claim\)/)
})