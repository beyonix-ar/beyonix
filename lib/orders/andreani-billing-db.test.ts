import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const admin = "30000000-0000-4000-8000-000000000001"
const operator = "30000000-0000-4000-8000-000000000002"

// Pedido 24 (BX-1024): checkout 8.000, recotizado con bultos reales 8.400.
// Pedido 25: sólo checkout 10.000. Pedido 26: legacy sin cotización guardada.
// Pedido 27 y 28 comparten tracking (dato inconsistente → ambiguo).
async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create table profiles (id uuid primary key, rol text not null);
    create table ordenes (
      id bigint primary key, created_at timestamptz not null default '2026-10-05T12:00:00Z',
      estado text default 'pagado', payment_status text, shipping_provider text default 'andreani', envio_proveedor text,
      andreani_envio_id text, andreani_tracking text, tracking_number text, andreani_handed_over_at timestamptz,
      delivered_at timestamptz, shipping_cost_charged numeric, shipping_cost_real numeric,
      shipping_provider_quote_amount numeric(12,2), shipping_markup_amount numeric, shipping_rounding_amount numeric,
      shipping_benefit_amount numeric, shipping_parcel_quote_status text, shipping_parcel_quote_amount numeric(12,2),
      andreani_billed_amount numeric(12,2));
    create table order_claims (id bigint primary key, order_id bigint, cancelled_at timestamptz);
    create table order_claim_shipments (id bigint primary key, claim_id bigint, order_id bigint references ordenes(id),
      direction text, andreani_tracking text, andreani_envio_id text);
    create table order_packages (id bigint primary key, order_id bigint, attempt_number int, parcel_count int);
    create table order_package_parcels (id bigint primary key, package_id bigint, attempt_number int, parcel_count int);
    create table audit_logs (id bigint generated always as identity, table_name text, action text, before_data jsonb, after_data jsonb);
    create function audit_log_change() returns trigger language plpgsql as $$
    begin
      insert into audit_logs(table_name, action, before_data, after_data) values (tg_table_name, tg_op,
        case when tg_op <> 'INSERT' then to_jsonb(old) end, case when tg_op <> 'DELETE' then to_jsonb(new) end);
      return coalesce(new, old);
    end $$;
    insert into profiles values ('${admin}', 'admin'), ('${operator}', 'operador');
    insert into ordenes (id, andreani_tracking, shipping_provider_quote_amount, shipping_parcel_quote_status, shipping_parcel_quote_amount) values
      (24, '360000000000024', 8000, 'quoted', 8400),
      (25, '360000000000025', 10000, null, null),
      (26, '360000000000026', null, null, null),
      (27, 'DUPLICADO01', 5000, null, null),
      (28, 'DUPLICADO01', 5000, null, null);
    insert into order_claims values (1, 24, null);
    insert into order_claim_shipments values
      (1, 1, 24, 'devolucion', '360000000000124', null),
      (2, 1, 24, 'reemplazo', '360000000000224', null);
  `)
  await db.exec(readFileSync(join(process.cwd(), "supabase/migrations/20261009120000_andreani_billing_reconciliation.sql"), "utf8"))
  await db.query("select set_config('request.jwt.claim.role','service_role',false)")
  return db
}

type Result = { index: number; status: string; entryId?: number; orderId?: number | null; matchStatus?: string; unmatchedReason?: string | null; movementType?: string; error?: string }
const record = async (db: PGlite, entries: unknown[], source = "csv", dryRun = false, actor = admin) =>
  (await db.query<{ r: Result[] }>("select record_andreani_billing_entries($1::jsonb, $2, $3, $4) r",
    [JSON.stringify(entries), source, actor, dryRun])).rows[0].r
const entry = (tracking: string | null, amount: string, reference = "A-0001-00001234", extra: Record<string, unknown> = {}) =>
  ({ tracking, amount, billedOn: "2026-10-08", reference, ...extra })
const reconciliation = async (db: PGlite, ids: number[]) => (await db.query<{
  order_id: number; billed_outbound: string | null; billed_total: string | null; difference_checkout: string | null
  difference_parcel: string | null; status: string; entries: number
}>("select * from andreani_order_reconciliation($1::bigint[])", [ids])).rows
const count = async (db: PGlite, sql: string) => Number((await db.query<{ n: number }>(sql)).rows[0].n)

test("reglas centralizadas: conciliado, diferencia menor, importante, sin referencia y pendiente", async () => {
  const db = await setup()
  try {
    const status = async (billed: number | null, reference: number | null) =>
      (await db.query<{ s: string }>("select andreani_reconciliation_status($1, $2) s", [billed, reference])).rows[0].s
    assert.equal(await status(null, 8000), "pending")
    assert.equal(await status(8000, null), "no_reference")
    assert.equal(await status(8099.99, 8000), "reconciled")
    assert.equal(await status(7900.01, 8000), "reconciled")
    assert.equal(await status(8100, 8000), "minor_difference")
    assert.equal(await status(8399, 8000), "minor_difference", "4,99 % y menos de $500")
    assert.equal(await status(8400, 8000), "major_difference", "5 %")
    assert.equal(await status(20500, 20000), "major_difference", "$500 aunque sea 2,5 %")
    assert.equal(await status(1300, 1200), "major_difference", "$100 pero 8 %: el porcentaje también marca diferencia importante")
    assert.equal(await status(1299.99, 1200), "reconciled", "menos de $100 siempre concilia (redondeos)")
    assert.deepEqual((await db.query<{ t: unknown }>("select andreani_reconciliation_thresholds() t")).rows[0].t,
      { reconciledAmount: 100, majorAmount: 500, majorPercent: 5 })
  } finally { await db.close() }
})

test("alta manual por pedido: snapshot de cotizaciones, idempotencia y conflicto sin pisar", async () => {
  const db = await setup()
  try {
    const [created] = await record(db, [{ ...entry("360000000000024", "8450.00"), orderId: "24" }], "manual")
    assert.deepEqual([created.status, created.orderId, created.matchStatus, created.movementType], ["created", 24, "matched", "outbound"])
    const [duplicate] = await record(db, [{ ...entry("360000000000024", "8450.00"), orderId: "24" }], "manual")
    assert.equal(duplicate.status, "duplicate")
    // La misma línea de factura importada luego por CSV tampoco se duplica.
    assert.equal((await record(db, [entry("360000000000024", "8450.00")]))[0].status, "duplicate")
    const [conflict] = await record(db, [entry("360000000000024", "9999.00")])
    assert.equal(conflict.status, "conflict")
    assert.equal(await count(db, "select count(*) n from andreani_billing_entries"), 1)
    const [row] = await reconciliation(db, [24])
    assert.deepEqual([row.billed_outbound, row.difference_checkout, row.difference_parcel, row.status], ["8450.00", "450.00", "50.00", "reconciled"])
    // Snapshot: una recotización posterior (rearmado) no cambia la conciliación histórica.
    await db.exec("update ordenes set shipping_parcel_quote_amount = 7000 where id = 24")
    assert.equal((await reconciliation(db, [24]))[0].status, "reconciled")
    // Un tracking de otro pedido no se puede cargar sobre este.
    const [wrong] = await record(db, [{ ...entry("360000000000025", "100"), orderId: "24" }], "manual")
    assert.deepEqual([wrong.status, wrong.error], ["invalid", "BILLING_TRACKING_OTHER_ORDER"])
  } finally { await db.close() }
})

test("importación: matching sólo por tracking inequívoco; sin pedido, ambiguo y sin tracking quedan visibles", async () => {
  const db = await setup()
  try {
    const rows = [
      entry("360000000000025", "11000", "F-77"),
      entry("360000000000124", "7900", "F-77"),
      entry("360000000000224", "8200", "F-77"),
      entry("NOEXISTE0001", "5000", "F-77"),
      entry("DUPLICADO01", "5000", "F-77"),
      entry(null, "3000", "F-77"),
      entry("360000000000026", "12000", "F-77"),
      entry("360000000000025", "abc", "F-77"),
      entry("360000000000025", "100", ""),
    ]
    const preview = await record(db, rows, "csv", true)
    assert.equal(await count(db, "select count(*) n from andreani_billing_entries"), 0, "la vista previa no escribe")
    assert.deepEqual(preview.map((result) => result.status), ["ready", "ready", "ready", "ready", "ready", "ready", "ready", "invalid", "invalid"])
    const results = await record(db, rows)
    assert.deepEqual(results.map((result) => [result.status, result.orderId ?? null, result.movementType ?? null, result.unmatchedReason ?? null]), [
      ["created", 25, "outbound", null],
      ["created", 24, "exchange_return", null],
      ["created", 24, "exchange_resend", null],
      ["created", null, "other", "not_found"],
      ["created", null, "other", "ambiguous"],
      ["created", null, "other", "no_tracking"],
      ["created", 26, "outbound", null],
      ["invalid", null, null, null],
      ["invalid", null, null, null],
    ])
    assert.equal(results[7].error, "BILLING_AMOUNT_INVALID")
    assert.equal(results[8].error, "BILLING_REFERENCE_INVALID")
    const byOrder = Object.fromEntries((await reconciliation(db, [24, 25, 26, 27])).map((row) => [row.order_id, row]))
    assert.equal(byOrder[25].status, "major_difference", "11.000 vs 10.000 = 10 %")
    assert.equal(byOrder[26].status, "no_reference", "legacy sin cotización guardada")
    assert.equal(byOrder[27].status, "pending", "tracking ambiguo: no se asoció")
  } finally { await db.close() }
})

test("BX-1024: envío, devolución y reenvío se distinguen; el estado compara sólo el envío original", async () => {
  const db = await setup()
  try {
    await record(db, [
      entry("360000000000024", "8500", "F-1"),
      entry("360000000000124", "7900", "F-2", { movementType: "outbound" }),
      entry("360000000000224", "8200", "F-3"),
    ])
    const [row] = await reconciliation(db, [24])
    assert.deepEqual([row.billed_outbound, row.billed_total, row.entries, row.status], ["8500.00", "24600.00", 3, "minor_difference"])
    const types = (await db.query<{ movement_type: string }>("select movement_type from andreani_billing_entries order by id")).rows.map((r) => r.movement_type)
    assert.deepEqual(types, ["outbound", "exchange_return", "exchange_resend"], "el tipo del envío encontrado manda sobre el del archivo")
  } finally { await db.close() }
})

test("corrección auditada, asociación manual de un cargo sin pedido y duplicados por edición", async () => {
  const db = await setup()
  try {
    const [first] = await record(db, [entry("360000000000025", "10050", "F-9")])
    const [orphan] = await record(db, [entry("NOEXISTE0002", "7000", "F-9")])
    const update = (id: number, patch: unknown, reason: string | null = "Factura rectificada") =>
      db.query("select update_andreani_billing_entry($1, $2::jsonb, $3, $4)", [id, JSON.stringify(patch), reason, admin])
    await assert.rejects(update(first.entryId!, { amount: "10900" }, "no"), /BILLING_REASON_REQUIRED/)
    await update(first.entryId!, { amount: "10900" })
    assert.equal((await reconciliation(db, [25]))[0].status, "major_difference", "10.900 vs 10.000 = 9 %")
    const audit = (await db.query<{ before_data: { billed_amount: number }; after_data: { billed_amount: number; correction_reason: string } }>(
      "select before_data, after_data from audit_logs where action = 'UPDATE'")).rows[0]
    assert.deepEqual([Number(audit.before_data.billed_amount), Number(audit.after_data.billed_amount), audit.after_data.correction_reason], [10050, 10900, "Factura rectificada"])
    // Asociar a mano: toma el snapshot en ese momento; no se puede re-asociar.
    await update(orphan.entryId!, { orderId: "24" })
    const linked = (await db.query<{ order_id: number; match_status: string; parcel_quote_snapshot: string }>(
      "select order_id, match_status, parcel_quote_snapshot from andreani_billing_entries where id = $1", [orphan.entryId])).rows[0]
    assert.deepEqual([Number(linked.order_id), linked.match_status, linked.parcel_quote_snapshot], [24, "matched", "8400.00"])
    await assert.rejects(update(orphan.entryId!, { orderId: "25" }), /BILLING_ALREADY_MATCHED/)
    // Una edición que choca con otro cargo existente se rechaza.
    const [other] = await record(db, [entry("360000000000025", "500", "F-10")])
    await assert.rejects(update(other.entryId!, { reference: "F-9" }), /BILLING_DUPLICATE/)
  } finally { await db.close() }
})

test("resumen del dashboard: facturado, diferencias, estados y cargos sin pedido", async () => {
  const db = await setup()
  try {
    await record(db, [
      entry("360000000000024", "8450", "F-1"),
      entry("360000000000124", "7900", "F-1"),
      entry("360000000000025", "11000", "F-1"),
      entry("360000000000026", "9000", "F-1"),
      entry("NOEXISTE0003", "1234", "F-1"),
    ])
    const summary = (await db.query<{ s: Record<string, unknown> }>(
      "select admin_logistics_summary('2026-10-01T03:00:00Z', '2026-11-01T03:00:00Z') s")).rows[0].s
    const pick = (keys: string[]) => keys.map((key) => Number(summary[key]))
    assert.deepEqual(pick(["billedByAndreani", "billedOutbound", "billedReturnsAndExchanges", "billedOrders"]), [36350, 28450, 7900, 3])
    assert.deepEqual(pick(["billedDifferenceVsCheckout", "billedDifferenceVsCheckoutOrders", "billedDifferenceVsParcel", "billedDifferenceVsParcelOrders"]), [1450, 2, 50, 1])
    assert.deepEqual(pick(["reconciledOrders", "minorDifferenceOrders", "majorDifferenceOrders", "noReferenceOrders", "pendingReconciliationOrders"]), [1, 0, 1, 1, 2])
    assert.deepEqual(pick(["unmatchedEntries", "unmatchedAmount"]), [1, 1234])
  } finally { await db.close() }
})

test("permisos: sólo service_role con actor Admin; anon/authenticated sin acceso a tabla ni RPC", async () => {
  const db = await setup()
  try {
    await assert.rejects(record(db, [entry("360000000000025", "1")], "csv", false, operator), /LOGISTICS_FORBIDDEN/)
    await assert.rejects(record(db, [entry("360000000000025", "1")], "api"), /BILLING_SOURCE_INVALID/)
    await assert.rejects(record(db, []), /BILLING_ENTRIES_INVALID/)
    await db.query("select set_config('request.jwt.claim.role','authenticated',false)")
    await assert.rejects(record(db, [entry("360000000000025", "1")]), /LOGISTICS_FORBIDDEN/)
    const privileges = (await db.query<Record<string, boolean>>(`select
      has_table_privilege('anon', 'public.andreani_billing_entries', 'SELECT') anon_read,
      has_table_privilege('authenticated', 'public.andreani_billing_entries', 'SELECT,INSERT,UPDATE') auth_access,
      has_function_privilege('anon', 'public.record_andreani_billing_entries(jsonb,text,uuid,boolean)', 'EXECUTE') anon_rpc,
      has_function_privilege('authenticated', 'public.update_andreani_billing_entry(bigint,jsonb,text,uuid)', 'EXECUTE') auth_rpc,
      has_function_privilege('authenticated', 'public.admin_logistics_summary(timestamptz,timestamptz)', 'EXECUTE') auth_summary,
      (select relrowsecurity from pg_class where oid = 'public.andreani_billing_entries'::regclass) rls`)).rows[0]
    assert.deepEqual(privileges, { anon_read: false, auth_access: false, anon_rpc: false, auth_rpc: false, auth_summary: false, rls: true })
  } finally { await db.close() }
})
