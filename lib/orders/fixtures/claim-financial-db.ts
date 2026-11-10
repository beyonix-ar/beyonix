import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import {
  MERCADOPAGO_REFUNDS_TABLE_SQL,
  authorizedClaimNote,
  creditNoteToBalance,
  refundWithMercadoPago,
  refundWithProof,
  type NoteDestination,
} from "./claim-compensation-evidence.ts"

// Base aislada (PGlite) con la cadena REAL de migraciones de reclamos hasta el
// retiro por cadete, para las suites de evidencia financiera de reclamos.

export const customer = "21000000-0000-4000-8000-000000000001"
export const otherCustomer = "21000000-0000-4000-8000-000000000002"
export const admin = "21000000-0000-4000-8000-000000000003"

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")
const migration = (name: string) => source(`../../../supabase/migrations/${name}.sql`)

export const CLAIM_FINANCIAL_CHAIN = [
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
  "20261106110000_dispatch_records_carrier_filter",
  "20261106120000_claim_local_pickups",
]

/** Migraciones fiscales reales (ARCA, liquidación MP, guardas fiscales) que conviven con la cadena de reclamos. */
export const FISCAL_MIGRATIONS = [
  "20260927110000_arca_credit_note_hardening",
  "20260927120000_arca_environment_isolation",
  "20261015120000_settle_credit_notes_after_mp_refund",
  "20261015170000_mercadopago_refund_closure",
  "20261015180000_fiscal_obligation_guards",
]

/** Reclamos + fiscal en el orden cronológico real de aplicación. */
export const CLAIM_FISCAL_CHAIN = [...CLAIM_FINANCIAL_CHAIN, ...FISCAL_MIGRATIONS].sort()

export type Db = PGlite
export type Row = Record<string, unknown>
export type Item = { order_item_id: number; quantity: number }

/**
 * Pedido 1 (cliente, pago pay-1): ítem 1 = producto 1 / variante 1 x3; ítem 2 = producto 2 x1; ítem 3 = producto 1 / variante 2 x2.
 * Pedido 2 (mismo cliente, pay-2): ítem 4 = producto 1 / variante 1 x2. Pedido 3 (otro cliente, pay-3): ítem 5 x1.
 */
export async function setup({ provider = "beyonix", fiscal = false, migrations = (fiscal ? CLAIM_FISCAL_CHAIN : CLAIM_FINANCIAL_CHAIN).map(migration) }: {
  provider?: string
  /** Agrega el complemento fiscal (claim-fiscal-schema.sql) y usa CLAIM_FISCAL_CHAIN. */
  fiscal?: boolean
  migrations?: string[]
} = {}) {
  const db = new PGlite()
  await db.exec(source("./claim-logistics-schema.sql"))
  await db.exec("alter table ordenes add column shipping_provider text, add column envio_proveedor text")
  if (fiscal) await db.exec(source("./claim-fiscal-schema.sql"))
  // Antes de la cadena: la migración engancha su guarda sólo si la tabla existe (como en producción).
  await db.exec(MERCADOPAGO_REFUNDS_TABLE_SQL)
  for (const sql of migrations) await db.exec(sql)
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  for (const [id, role] of [[customer, "cliente"], [otherCustomer, "cliente"], [admin, "admin"]]) {
    await db.query("insert into auth.users values($1,$2,now())", [id, `${id}@example.test`])
    await db.query("insert into profiles(id,email,rol) values($1,$2,$3)", [id, `${id}@example.test`, role])
  }
  await db.exec("insert into productos(id) values(1),(2); insert into producto_variantes(id,producto_id) values(1,1),(2,1),(3,2)")
  for (const [variant, stock] of [[1, 8], [2, 6], [3, 4]]) {
    await db.query("select adjust_variant_stock_idempotent($1,$2,'seed de test',$3,$4)", [variant, stock, admin, `seed-variant-${variant}`])
  }
  for (const [orderId, user] of [[1, customer], [2, customer], [3, otherCustomer]] as const) {
    await db.query(
      "insert into ordenes(id,usuario_id,estado,delivered_at,financial_status,total,shipping_type,shipping_provider,payment_id) values($1,$2,'entregado',now()-interval '1 day','payment_confirmed',90000,'domicilio',$3,$4)",
      [orderId, user, provider, `pay-${orderId}`])
  }
  await db.exec(`insert into orden_items(id,orden_id,producto_id,variante_id,cantidad,precio) values
    (1,1,1,1,3,30000),(2,1,2,3,1,9000),(3,1,1,2,2,30000),(4,2,1,1,2,30000),(5,3,1,1,1,30000)`)
  // Factura C autorizada (homologación) de cada pedido: la NC se asocia a ella.
  if (fiscal) {
    await db.exec(`update ordenes set invoice_status='authorized', invoice_point=3, invoice_number=100+id, invoice_cae='CAE-F'||id,
      invoice_arca_environment='homologation', invoice_queued_at=now()`)
  }
  return db
}

/** La cadena con una versión alternativa de 20261106120000 (p. ej. la de HEAD, para probar que los tests fallan antes del arreglo). */
export const chainWith120000 = (sql: string) =>
  CLAIM_FINANCIAL_CHAIN.map((name) => name === "20261106120000_claim_local_pickups" ? sql : migration(name))

export const one = async <T extends Row = Row>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
export const version = async (db: Db, id: number) => (await one<{ v: string }>(db, "select updated_at::text v from order_claims where id=$1", [id])).v
export const mutate = async (db: Db, id: number, patch: Row) =>
  db.query("select mutate_admin_order_claim($1,$2,$3,$4)", [id, admin, await version(db, id), JSON.stringify(patch)])
/** UPDATE directo (saltea la RPC): las guardas viven en triggers. */
export const close = (db: Db, id: number) => db.query("update order_claims set status='cerrado', closed_at=now() where id=$1", [id])
export const claimStatus = async (db: Db, id: number) => (await one<{ status: string }>(db, "select status from order_claims where id=$1", [id])).status
export const orderOf = async (db: Db, claimId: number) => Number((await one<{ order_id: number }>(db, "select order_id from order_claims where id=$1", [claimId])).order_id)
export const setLines = async (db: Db, id: number, lines: Row[]) =>
  db.query("select * from set_order_claim_item_resolutions($1,$2,$3,$4,null)", [id, admin, await version(db, id), JSON.stringify(lines)])

export async function createClaim(db: Db, orderId: number, items: Item[], user = customer) {
  const op = randomUUID()
  await db.query("select begin_order_claim_operation($1,$2,$3,$4,'{}','order-claim-evidence')", [op, user, orderId, randomUUID().replaceAll("-", "").repeat(2)])
  const result = await db.query<{ id: number }>("select commit_customer_order_claim($1,$2,$3,'[]') as id",
    [op, user, JSON.stringify({ problemType: "falla", message: "El producto dejó de funcionar.", items })])
  return Number(result.rows[0].id)
}

export const RESOLUTION: Record<NoteDestination | "replacement", { resolution: string; status: string }> = {
  external_refund: { resolution: "reintegro_total", status: "reintegro_pendiente" },
  customer_balance: { resolution: "saldo_a_favor", status: "aprobado" },
  replacement: { resolution: "cambio_producto", status: "aprobado" },
}

/** Retiro por cadete retirado; `received` vuelve e inspecciona (reincorpora a stock); `lost` se pierde en el traslado. */
export async function lossClaim(db: Db, {
  kind,
  items = [{ order_item_id: 1, quantity: 2 }],
  received = [] as Item[],
  lost = [{ order_item_id: 1, quantity: 2 }],
  orderId = 1,
  lines = null as Row[] | null,
}: { kind: NoteDestination | "replacement" | "mixta"; items?: Item[]; received?: Item[]; lost?: Item[]; orderId?: number; lines?: Row[] | null }) {
  const id = await createClaim(db, orderId, items)
  if (kind === "mixta") await setLines(db, id, lines ?? [])
  else await mutate(db, id, { status: RESOLUTION[kind].status, resolution: RESOLUTION[kind].resolution })
  await db.query("select * from request_order_claim_local_pickup($1,$2,'Coordinar por WhatsApp')", [id, admin])
  await db.query("select * from mark_order_claim_local_pickup_collected($1,$2,'Retiró el cadete')", [id, admin])
  if (received.length) {
    await db.query("select * from confirm_order_claim_local_pickup_reception($1,$2,$3,'',$4)", [id, admin, JSON.stringify(received), randomUUID()])
    for (const item of received) {
      await db.query("select process_claim_return_inventory($1,$2,$3,$4,0,'Revisado en depósito',$5,$6)",
        [id, orderId, item.order_item_id, item.quantity, admin, randomUUID()])
    }
  }
  if (lost.length) {
    await db.query("select * from confirm_order_claim_local_pickup_loss($1,$2,$3,'El cadete perdió el paquete en el traslado',$4)",
      [id, admin, JSON.stringify(lost), randomUUID()])
  }
  return id
}

/** NC de reclamo con dinero realmente devuelto/acreditado por el circuito de su destino. */
export async function compensate(db: Db, claimId: number, destination: NoteDestination, orderItemId: number, quantity: number, via: "proof" | "mp" = "proof") {
  const note = await authorizedClaimNote(db, { claimId, orderId: await orderOf(db, claimId), destination, lines: [{ orderItemId, quantity }], amount: 1000 * quantity })
  if (destination === "customer_balance") await creditNoteToBalance(db, note.id)
  else if (via === "mp") await refundWithMercadoPago(db, note.id)
  else await refundWithProof(db, [note.id])
  return note.id
}

export const replace = (db: Db, claimId: number, itemId: number, variant: number, quantity: number, orderId = 1) =>
  db.query("select * from create_order_replacement($1,$2,$3,$4,'mismo_producto',$5,$6,null,null,$7)", [orderId, itemId, variant, quantity, admin, randomUUID(), claimId])
export const deliverManually = (db: Db, claimId: number, itemId: number, quantity: number) =>
  db.query("select confirm_order_claim_replacement_delivered_manually($1,$2,$3,$4,'Entregado por el cadete',$5)", [claimId, admin, itemId, quantity, randomUUID()])

export const UNRESOLVED = /CLAIM_TRANSIT_LOSS_UNRESOLVED/
export const LOCKED = /CLAIM_COMPENSATION_EVIDENCE_LOCKED/
export const EXHAUSTED = /CREDIT_NOTE_REFUND_EVIDENCE_EXHAUSTED/
export const ALLOCATION_INVALID = /CREDIT_NOTE_REFUND_ALLOCATION_INVALID/
export const ALLOCATED = /REFUND_EVIDENCE_ALLOCATED/
