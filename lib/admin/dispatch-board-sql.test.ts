import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C = "33333333-3333-4333-8333-333333333333"

test("tablero SQL: fecha, búsqueda, operador, estado, cantidad, combinación y paginación", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.ordenes (id bigint primary key, financial_status text, cancelled_at timestamptz,
        andreani_handed_over_at timestamptz, estado text, shipping_provider text, envio_proveedor text,
        andreani_creation_status text, andreani_tracking text, andreani_envio_id text,
        created_at timestamptz, andreani_created_at timestamptz, invoice_status text);
      create table public.order_packages (id bigint primary key, order_id bigint, status text, prepared_at timestamptz,
        prepared_by uuid, parcel_count integer);
      create table public.dispatch_batches (id bigint primary key, code text, display_number integer, status text,
        created_at timestamptz, closed_at timestamptz, handed_over_at timestamptz,
        created_by uuid, closed_by uuid, handed_over_by uuid);
      create table public.dispatch_batch_items (id bigint primary key, batch_id bigint, order_id bigint, package_id bigint,
        removed_at timestamptz, added_by uuid, verified_by uuid, removed_by uuid);
      create table public.order_preparation_lines (package_id bigint, expected_sku text, expected_barcode text);
      create table public.orden_items (orden_id bigint, producto_id bigint, cantidad integer);
      create table public.productos (id bigint primary key, nombre text, sku text);
      create table public.order_preparation_scans (package_id bigint, scanned_by uuid);
      create table public.order_audit_events (order_id bigint, actor_id uuid, action text);
      create table public.dispatch_batch_events (batch_id bigint, actor_id uuid);
      insert into public.ordenes values
        (1,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-15 12:00-03',null,null),
        (2,'payment_confirmed',null,null,'pagado','andreani',null,'created','360002','ENV2','2026-10-15 12:00-03','2026-10-18 11:00-03','authorized'),
        (3,'payment_confirmed',null,null,'pagado','andreani',null,'created','360003','ENV3','2026-10-15 12:00-03','2026-10-17 11:00-03',null),
        (4,'payment_confirmed',null,null,'pagado','andreani',null,'created','360004','ENV4','2026-10-18 10:00-03','2026-10-18 11:00-03',null),
        (5,'payment_confirmed',null,null,'pagado','andreani',null,'created','360005','ENV5','2026-10-18 10:00-03','2026-10-18 11:00-03',null),
        (6,'payment_confirmed',null,'2026-10-18 16:00-03','pagado','andreani',null,'created','360006','ENV6','2026-10-18 10:00-03','2026-10-18 11:00-03','authorized'),
        (7,'payment_confirmed',null,'2026-10-17 16:00-03','pagado','andreani',null,'created','360007','ENV7','2026-10-17 10:00-03','2026-10-17 11:00-03',null),
        (8,'payment_confirmed','2026-10-18 12:00-03',null,'cancelado','andreani',null,'created','360008','ENV8','2026-10-18 10:00-03','2026-10-18 11:00-03',null);
      insert into public.ordenes select n,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-14 12:00-03',null,null from generate_series(100,120) n;
      insert into public.order_packages values
        (2,2,'prepared','2026-10-18 10:00-03','${A}',2),
        (3,3,'prepared','2026-10-17 10:00-03',null,1),
        (4,4,'prepared','2026-10-18 10:00-03',null,2),
        (5,5,'prepared','2026-10-18 10:00-03',null,5),
        (6,6,'prepared','2026-10-18 10:00-03',null,3),
        (7,7,'prepared','2026-10-17 10:00-03',null,1),
        (8,8,'prepared','2026-10-18 10:00-03',null,1);
      insert into public.dispatch_batches values
        (1,'DSP-20261018-001',1,'open','2026-10-18 09:00-03',null,null,'${B}',null,null),
        (2,'DSP-20261018-002',2,'closed','2026-10-18 09:00-03','2026-10-18 12:00-03',null,'${B}','${B}',null),
        (3,'DSP-20261018-007',7,'handed_over','2026-10-18 09:00-03','2026-10-18 12:00-03','2026-10-18 16:00-03','${B}','${B}','${C}'),
        (4,'DSP-20261017-004',4,'handed_over','2026-10-17 09:00-03','2026-10-17 12:00-03','2026-10-17 16:00-03','${B}','${B}','${C}'),
        (5,'DSP-20261018-005',5,'open','2026-10-18 09:00-03',null,null,'${B}',null,null);
      insert into public.dispatch_batch_items values
        (1,1,4,4,null,'${B}',null,null), (2,2,5,5,null,'${B}',null,null),
        (3,3,6,6,null,'${B}','${B}',null), (4,4,7,7,null,'${B}',null,null),
        (5,1,8,8,'2026-10-18 13:00-03','${B}',null,'${C}');
      insert into public.productos values (1,'Mate Ñandú','MT-01');
      insert into public.orden_items values (2,1,2),(3,1,1),(4,1,2),(5,1,5),(6,1,3),(7,1,1),(8,1,1);
      insert into public.order_preparation_lines values (2,'MT-01','BAR-02'),(6,'MT-01','BAR-06');
      insert into public.order_preparation_scans values (2,'${A}');
      insert into public.order_audit_events values (2,'${C}','dispatch_andreani_shipment_generated'),(1,'${C}','unrelated_admin_action');`)
    await db.exec(readFileSync("supabase/migrations/20261018133000_dispatch_board_filter_accuracy.sql", "utf8"))
    const find = async (tab: string, filters = "") => {
      const { rows } = await db.query<{ result: { ids: number[]; total: number } }>(`select public.search_dispatch_board(p_tab => '${tab}'${filters ? `, ${filters}` : ""}) result`)
      return rows[0].result
    }
    assert.equal((await find("armado")).total, 22)
    assert.deepEqual((await find("armado", "p_date_from => '2026-10-15', p_date_to => '2026-10-15'")).ids, [1])
    assert.deepEqual((await find("ready", "p_date_from => '2026-10-18', p_date_to => '2026-10-18'")).ids, [2])
    assert.deepEqual((await find("ready", "p_date_from => '2026-10-17', p_date_to => '2026-10-18'")).ids, [3,2])
    assert.deepEqual((await find("open")).ids, [2,1])
    assert.deepEqual((await find("delivered", "p_date_from => '2026-10-18', p_date_to => '2026-10-18'")).ids, [3])
    assert.deepEqual((await find("delivered", "p_date_from => '2026-10-17', p_date_to => '2026-10-17'")).ids, [4])
    assert.deepEqual((await find("ready", "p_search => 'BX-1002'")).ids, [2])
    assert.deepEqual((await find("delivered", "p_search => 'Bulto - 0007'")).ids, [3])
    assert.deepEqual((await find("delivered", "p_search => '360006'")).ids, [3])
    assert.deepEqual((await find("delivered", "p_batch => '0007'")).ids, [3])
    assert.deepEqual((await find("ready", `p_operator_ids => array['${A}']::uuid[]`)).ids, [2])
    assert.deepEqual((await find("open", `p_operator_ids => array['${B}']::uuid[]`)).ids, [2,1])
    assert.deepEqual((await find("delivered", `p_operator_ids => array['${C}']::uuid[]`)).ids, [3,4])
    assert.deepEqual((await find("open", "p_state => 'Listo para entregar'")).ids, [2])
    assert.deepEqual((await find("open", "p_state => 'Retirado'")).ids, [1])
    assert.deepEqual((await find("delivered", "p_state => 'Entregado'")).ids, [3,4])
    assert.deepEqual((await find("open", "p_quantity_kind => 'orders', p_quantity_min => 1, p_quantity_max => 1")).ids, [2,1])
    assert.deepEqual((await find("open", "p_quantity_kind => 'parcels', p_quantity_min => 5, p_quantity_max => 5")).ids, [2])
    assert.deepEqual((await find("ready", "p_quantity_kind => 'units', p_quantity_min => 2, p_quantity_max => 2")).ids, [2])
    assert.deepEqual((await find("delivered", `p_date_from => '2026-10-18', p_date_to => '2026-10-18', p_operator_ids => array['${C}']::uuid[], p_quantity_kind => 'parcels', p_quantity_min => 3, p_quantity_max => 3, p_state => 'Entregado'`)).ids, [3])
    assert.deepEqual((await find("open", "p_has_removed => true")).ids, [1])
    assert.deepEqual((await find("open", "p_has_cancelled => true")).ids, [1])
    assert.deepEqual((await find("ready", "p_search => 'BAR-02'")).ids, [2])
    assert.deepEqual((await find("ready", "p_search => 'Ñandú'")).ids, [3,2])
    assert.deepEqual((await find("armado", "p_page => 2")).ids, [100,1])
    await db.exec("set role anon")
    await assert.rejects(find("armado"), /permission denied/i)
  } finally { await db.close() }
})
