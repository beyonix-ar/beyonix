import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C = "33333333-3333-4333-8333-333333333333"

type Row = { kind: "order" | "batch"; id: number; code: string | null; displayNumber: number | null; state: string; at: string; actorId: string | null; units: number; total: number; orderCount: number; selectable: boolean }

test("tabla única de Despachos: pedido o Bulto (nunca ambos), estados, sumas, filtros y paginación", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.ordenes (id bigint primary key, financial_status text, cancelled_at timestamptz,
        andreani_handed_over_at timestamptz, estado text, shipping_provider text, envio_proveedor text,
        andreani_creation_status text, andreani_tracking text, andreani_envio_id text,
        created_at timestamptz, andreani_created_at timestamptz, total numeric);
      create table public.order_packages (id bigint primary key, order_id bigint, status text, attempt_number integer,
        prepared_at timestamptz, prepared_by uuid, identified_by uuid, identification_method text);
      create table public.dispatch_batches (id bigint primary key, code text, display_number integer, status text,
        created_at timestamptz, closed_at timestamptz, handed_over_at timestamptz,
        created_by uuid, closed_by uuid, handed_over_by uuid);
      create table public.dispatch_batch_items (id bigint primary key, batch_id bigint, order_id bigint,
        removed_at timestamptz, removed_by uuid);
      create table public.orden_items (orden_id bigint, cantidad integer);
      create table public.order_preparation_scans (id bigint primary key, package_id bigint, attempt_number integer, scanned_by uuid, scanned_at timestamptz);
      create table public.order_cancellation_holds (order_id bigint, detected_at timestamptz, resolved_at timestamptz, resolved_by uuid);
      create table public.dispatch_blocks (order_id bigint, resolved_at timestamptz);
      insert into public.ordenes values
        -- 1 pendiente con pickeo; 2 confirmado; 3 confirmado bloqueado; 9 de otro día
        (1,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-22 09:00-03',null,10000),
        (2,'payment_confirmed',null,null,'pagado','andreani',null,'created','3602','ENV2','2026-10-21 18:00-03','2026-10-22 10:00-03',12500.50),
        (3,'payment_confirmed',null,null,'pagado','andreani',null,'created','3603','ENV3','2026-10-22 08:00-03','2026-10-22 10:30-03',8000),
        (9,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-21 09:00-03',null,5000),
        -- 10 pedidos del Bulto 0002 abierto (10 x $10.000); 21-22 Bulto 0003 entregado
        (11,'payment_confirmed',null,null,'pagado','andreani',null,'created','t11','e11','2026-10-22 07:00-03',null,10000),
        (12,'payment_confirmed',null,null,'pagado','andreani',null,'created','t12','e12','2026-10-22 07:00-03',null,10000),
        (13,'payment_confirmed',null,null,'pagado','andreani',null,'created','t13','e13','2026-10-22 07:00-03',null,10000),
        (14,'payment_confirmed',null,null,'pagado','andreani',null,'created','t14','e14','2026-10-22 07:00-03',null,10000),
        (15,'payment_confirmed',null,null,'pagado','andreani',null,'created','t15','e15','2026-10-22 07:00-03',null,10000),
        (16,'payment_confirmed',null,null,'pagado','andreani',null,'created','t16','e16','2026-10-22 07:00-03',null,10000),
        (17,'payment_confirmed',null,null,'pagado','andreani',null,'created','t17','e17','2026-10-22 07:00-03',null,10000),
        (18,'payment_confirmed',null,null,'pagado','andreani',null,'created','t18','e18','2026-10-22 07:00-03',null,10000),
        (19,'payment_confirmed',null,null,'pagado','andreani',null,'created','t19','e19','2026-10-22 07:00-03',null,10000),
        (20,'payment_confirmed',null,null,'pagado','andreani',null,'created','t20','e20','2026-10-22 07:00-03',null,10000),
        (21,'payment_confirmed',null,'2026-10-22 13:54-03','pagado','andreani',null,'created','t21','e21','2026-10-22 07:00-03',null,7000),
        (22,'payment_confirmed',null,'2026-10-22 13:54-03','pagado','andreani',null,'created','t22','e22','2026-10-22 07:00-03',null,3000),
        -- 30 cancelado con armado; 31 cancelado sin entrar a Despachos; 32 retirado de un Bulto que quedó sin pedidos; 40 no Andreani
        (30,'refund_pending','2026-10-22 12:00-03',null,'cancelado','andreani',null,null,null,null,'2026-10-22 07:00-03',null,4000),
        (31,'refund_pending','2026-10-22 12:00-03',null,'cancelado','andreani',null,null,null,null,'2026-10-22 07:00-03',null,4000),
        (32,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-20 07:00-03',null,2000),
        (40,'payment_confirmed',null,null,'pagado','retiro',null,null,null,null,'2026-10-22 07:00-03',null,1000),
        -- Días anteriores: 8 confirmado y Bulto 0006 finalizado (abiertos); Bulto 0007 entregado y 33 cancelado (resueltos)
        (8,'payment_confirmed',null,null,'pagado','andreani',null,'created','3608','ENV8','2026-10-19 10:00-03','2026-10-20 10:00-03',8000),
        (25,'payment_confirmed',null,null,'pagado','andreani',null,'created','t25','e25','2026-10-19 10:00-03',null,6000),
        (26,'payment_confirmed',null,'2026-10-21 15:00-03','pagado','andreani',null,'created','t26','e26','2026-10-19 10:00-03',null,5000),
        (33,'refund_pending','2026-10-21 12:00-03',null,'cancelado','andreani',null,null,null,null,'2026-10-19 07:00-03',null,4000);
      insert into public.order_packages values
        (1,1,'preparing',1,null,null,null,null),
        (2,2,'prepared',1,'2026-10-22 10:00-03','${A}','${B}','andreani'),
        (3,3,'prepared',1,'2026-10-22 10:30-03','${A}',null,'andreani'),
        (30,30,'prepared',1,'2026-10-22 10:00-03','${A}',null,'andreani'),
        (8,8,'prepared',1,'2026-10-20 10:00-03','${A}','${A}','andreani'),
        (33,33,'preparing',1,null,null,null,null);
      insert into public.order_preparation_scans values (1,1,1,'${A}','2026-10-22 09:10-03'),(2,1,1,'${C}','2026-10-22 09:20-03');
      insert into public.dispatch_blocks values (3,null);
      insert into public.order_cancellation_holds values (30,'2026-10-22 12:00-03','2026-10-22 12:30-03','${C}');
      insert into public.orden_items values (1,2),(1,1),(2,4),(3,1),(9,1),(21,2),(22,5),(30,1),(32,1),(8,1),(25,2),(26,1),(33,1);
      insert into public.orden_items select n, 3 from generate_series(11,20) n;
      insert into public.dispatch_batches values
        (2,'DSP-20261022-002',2,'open','2026-10-22 11:00-03',null,null,'${B}',null,null),
        (3,'DSP-20261022-003',3,'handed_over','2026-10-22 08:00-03','2026-10-22 12:00-03','2026-10-22 13:54-03','${B}','${B}','${C}'),
        (4,'DSP-20261022-004',4,'open','2026-10-22 08:00-03',null,null,'${B}',null,null),
        (5,'DSP-20261022-005',5,'open','2026-10-22 08:00-03',null,null,'${B}',null,null),
        (6,'DSP-20261020-006',6,'closed','2026-10-20 09:00-03','2026-10-20 12:00-03',null,'${B}','${B}',null),
        (7,'DSP-20261021-007',7,'handed_over','2026-10-21 09:00-03','2026-10-21 12:00-03','2026-10-21 15:00-03','${B}','${B}','${C}');
      insert into public.dispatch_batch_items select n, 2, n, null, null from generate_series(11,20) n;
      insert into public.dispatch_batch_items values (21,3,21,null,null),(22,3,22,null,null),
        (23,2,3,'2026-10-22 09:00-03','${A}'),
        (32,4,32,'2026-10-22 11:30-03','${A}'),
        (25,6,25,null,null),(26,7,26,null,null);`)
    for (const migration of ["20261022100000_dispatch_unified_records", "20261022110000_dispatch_records_open_work_no_annulled"])
      await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"))
    const find = async (filters = "") => {
      const { rows } = await db.query<{ result: { rows: Row[]; total: number } }>(`select public.search_dispatch_records(${filters}) result`)
      return rows[0].result
    }
    const keys = (rows: Row[]) => rows.map((row) => `${row.kind}:${row.id}`)
    const today = "p_date => '2026-10-22'"

    // Fecha elegida a mano: filtra todo por ese día.
    const day = await find(today)
    assert.deepEqual(keys(day.rows), ["batch:3", "order:30", "batch:2", "order:3", "order:2", "order:1"])
    assert.equal(day.total, 6)
    assert.ok(!day.rows.some((row) => row.kind === "order" && row.id >= 11 && row.id <= 26), "un pedido dentro de un Bulto sólo cuenta en su Bulto")
    assert.ok(!keys(day.rows).includes("order:31"), "cancelado que nunca entró a Despachos")
    assert.ok(!keys(day.rows).includes("order:40"), "sin envío Andreani")
    assert.ok(!keys(day.rows).includes("batch:4") && !keys(day.rows).includes("batch:5"), "sin estado Anulado: un Bulto sin pedidos activos no se muestra")
    assert.ok(!day.rows.some((row) => !["P", "C", "E", "X"].includes(row.state)))
    assert.deepEqual(keys((await find("p_date => '2026-10-21'")).rows), ["batch:7", "order:33", "order:9"])

    // Fecha por defecto (hoy): lo resuelto de hoy y todo lo abierto, sea del día que sea.
    const openWork = await find(`${today}, p_open_all_dates => true`)
    assert.deepEqual(keys(openWork.rows), ["batch:3", "order:30", "batch:2", "order:3", "order:2", "order:1", "order:9", "batch:6", "order:8", "order:32"])
    assert.ok(!keys(openWork.rows).includes("batch:7") && !keys(openWork.rows).includes("order:33"), "entregado y cancelado de otro día: sólo con su fecha")
    assert.deepEqual(keys((await find(`${today}, p_open_all_dates => true, p_state => 'P'`)).rows), ["batch:2", "order:1", "order:9", "order:32"])
    assert.deepEqual(keys((await find(`${today}, p_open_all_dates => true, p_state => 'E'`)).rows), ["batch:3"])
    assert.deepEqual(keys((await find(`${today}, p_open_all_dates => true, p_order => '1008'`)).rows), ["order:8"])
    assert.deepEqual(keys((await find(`${today}, p_open_all_dates => true, p_batch => '0006'`)).rows), ["batch:6"])

    const byKey = new Map(day.rows.map((row) => [`${row.kind}:${row.id}`, row]))
    const open = byKey.get("batch:2")!
    assert.deepEqual([open.state, open.orderCount, open.units, Number(open.total), open.actorId, open.code], ["P", 10, 30, 100000, B, "DSP-20261022-002"], "Bulto: suma de sus 10 pedidos, sin el retirado")
    const delivered = byKey.get("batch:3")!
    assert.deepEqual([delivered.state, delivered.units, Number(delivered.total), delivered.actorId], ["E", 7, 10000, C])
    assert.equal(new Date(delivered.at).toISOString(), "2026-10-22T16:54:00.000Z")
    assert.deepEqual([byKey.get("order:1")!.state, byKey.get("order:1")!.units, byKey.get("order:1")!.actorId], ["P", 3, C], "pendiente: último que pickeó")
    assert.deepEqual([byKey.get("order:2")!.state, Number(byKey.get("order:2")!.total), byKey.get("order:2")!.actorId, byKey.get("order:2")!.selectable], ["C", 12500.5, B, true], "confirmado: quien confirmó la etiqueta")
    assert.deepEqual([byKey.get("order:3")!.state, byKey.get("order:3")!.actorId, byKey.get("order:3")!.selectable], ["C", A, false], "bloqueado: no se puede agregar a un Bulto")
    assert.deepEqual([byKey.get("order:30")!.state, byKey.get("order:30")!.actorId], ["X", C])

    assert.deepEqual(keys((await find(`${today}, p_order => 'BX-1002'`)).rows), ["order:2"])
    assert.deepEqual(keys((await find(`${today}, p_order => '1015'`)).rows), ["batch:2"], "el pedido dentro de un Bulto lleva a su Bulto")
    assert.deepEqual(keys((await find(`${today}, p_batch => 'Bulto-0002'`)).rows), ["batch:2"])
    assert.deepEqual(keys((await find(`${today}, p_batch => '3'`)).rows), ["batch:3"])
    assert.deepEqual(keys((await find(`${today}, p_actor_id => '${C}'`)).rows), ["batch:3", "order:30", "order:1"])
    for (const [state, expected] of [["P", ["batch:2", "order:1"]], ["C", ["order:3", "order:2"]], ["E", ["batch:3"]], ["X", ["order:30"]]] as const)
      assert.deepEqual(keys((await find(`${today}, p_state => '${state}'`)).rows), expected, state)
    assert.deepEqual(keys((await find(`${today}, p_state => 'P', p_actor_id => '${B}', p_batch => '0002'`)).rows), ["batch:2"], "combinación")
    assert.deepEqual(keys((await find(`${today}, p_state => 'E', p_order => 'BX-1002'`)).rows), [])

    await db.exec("insert into public.ordenes select n,'payment_confirmed',null,null,'pagado','andreani',null,null,null,null,'2026-10-22 06:00-03',null,100 from generate_series(100,120) n")
    const second = await find(`${today}, p_page => 2`)
    assert.equal(second.total, 27)
    assert.equal(second.rows.length, 7)
    for (const state of ["Z", "A"]) await assert.rejects(find(`p_state => '${state}'`), /DISPATCH_FILTER_INVALID/, state)

    // Filtro TIPO (20261024100000) sobre el mismo fixture, con las migraciones posteriores aplicadas.
    await db.exec("alter table public.ordenes add column andreani_handed_over_by uuid")
    for (const migration of ["20261023130000_dispatch_records_handed_over_fallback", "20261024100000_dispatch_records_kind_filter"])
      await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"))
    const { rows: overloads } = await db.query<{ args: string }>("select pg_get_function_identity_arguments(oid) args from pg_proc where proname = 'search_dispatch_records'")
    assert.equal(overloads.length, 1, "una sola firma: sin sobrecargas ambiguas para PostgREST")
    const all = await find(today)
    assert.equal(all.total, 27, "Todos: pedidos + Bultos, igual que sin filtro")
    assert.deepEqual(keys((await find(`${today}, p_kind => null`)).rows), keys(all.rows))
    const ordersOnly = await find(`${today}, p_kind => 'order'`)
    assert.equal(ordersOnly.total, 25)
    assert.ok(ordersOnly.rows.every((row) => row.kind === "order"), "Pedidos: sólo pedidos individuales")
    assert.ok(!ordersOnly.rows.some((row) => row.id >= 11 && row.id <= 22), "Pedidos: no expande los pedidos agrupados en un Bulto")
    assert.equal((await find(`${today}, p_kind => 'order', p_page => 2`)).rows.length, 5, "paginación sobre lo filtrado")
    const batchesOnly = await find(`${today}, p_kind => 'batch'`)
    assert.deepEqual([keys(batchesOnly.rows), batchesOnly.total], [["batch:3", "batch:2"], 2], "Bultos: sólo Bultos, total correcto")
    assert.deepEqual([batchesOnly.rows[1].orderCount, batchesOnly.rows[1].units], [10, 30], "el Bulto conserva sus pedidos")
    // Combinado con Estado y con Fecha.
    assert.deepEqual(keys((await find(`${today}, p_state => 'P', p_kind => 'batch'`)).rows), ["batch:2"])
    assert.deepEqual(keys((await find(`${today}, p_state => 'X', p_kind => 'order'`)).rows), ["order:30"])
    assert.deepEqual(keys((await find(`${today}, p_state => 'E', p_kind => 'order'`)).rows), [])
    assert.deepEqual(keys((await find(`p_date => '2026-10-21', p_kind => 'order'`)).rows), ["order:33", "order:9"])
    assert.deepEqual(keys((await find(`p_date => '2026-10-21', p_kind => 'batch'`)).rows), ["batch:7"])
    assert.deepEqual(keys((await find(`${today}, p_open_all_dates => true, p_state => 'C', p_kind => 'batch'`)).rows), ["batch:6"], "fecha por defecto: Bulto finalizado de otro día")
    assert.deepEqual(keys((await find(`${today}, p_order => '1015', p_kind => 'order'`)).rows), [], "el pedido de un Bulto no reaparece como pedido")
    assert.deepEqual(keys((await find(`${today}, p_order => '1015', p_kind => 'batch'`)).rows), ["batch:2"])
    for (const kind of ["bulto", "pedido", "ORDER", ""]) await assert.rejects(find(`p_kind => '${kind}'`), /DISPATCH_FILTER_INVALID/, kind)
    await db.exec("set role anon")
    await assert.rejects(find(today), /permission denied/i)
  } finally { await db.close() }
})

type CarrierRow = Row & { carrier: "andreani" | "beyonix" }

test("TRANSPORTISTA: Todos/Andreani/BEYONIX, proveedor explícito sobre residuos, legacy, filtros combinados y paginación", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.ordenes (id bigint primary key, financial_status text, cancelled_at timestamptz,
        andreani_handed_over_at timestamptz, andreani_handed_over_by uuid, estado text, shipping_provider text, envio_proveedor text,
        andreani_creation_status text, andreani_tracking text, andreani_envio_id text,
        created_at timestamptz, andreani_created_at timestamptz, delivered_at timestamptz, total numeric);
      create table public.order_packages (id bigint primary key, order_id bigint, status text, attempt_number integer,
        prepared_at timestamptz, prepared_by uuid, identified_by uuid, identification_method text);
      create table public.dispatch_batches (id bigint primary key, code text, display_number integer, status text,
        created_at timestamptz, closed_at timestamptz, handed_over_at timestamptz,
        created_by uuid, closed_by uuid, handed_over_by uuid);
      create table public.dispatch_batch_items (id bigint primary key, batch_id bigint, order_id bigint, removed_at timestamptz, removed_by uuid);
      create table public.orden_items (orden_id bigint, cantidad integer);
      create table public.order_preparation_scans (id bigint primary key, package_id bigint, attempt_number integer, scanned_by uuid, scanned_at timestamptz);
      create table public.order_cancellation_holds (order_id bigint, detected_at timestamptz, resolved_at timestamptz, resolved_by uuid);
      create table public.dispatch_blocks (order_id bigint, resolved_at timestamptz);
      create table public.order_audit_events (id bigserial primary key, order_id bigint, actor_type text, actor_id uuid, action text,
        previous_status text, new_status text, metadata jsonb, created_at timestamptz);
      -- Bultos BEYONIX con todas sus etiquetas confirmadas (la real vive en 20261103120000).
      create table public.ready_parcels (order_id bigint primary key);
      create function public.local_delivery_parcels_ready(p_order_id bigint) returns boolean language sql stable
        as $$ select exists (select 1 from public.ready_parcels where order_id = p_order_id) $$;
      insert into public.ordenes values
        -- Andreani: 1 pendiente, 2 confirmado (seleccionable) y Bulto 0002 con 11.
        (1,'payment_confirmed',null,null,null,'pagado','andreani',null,null,null,null,'2026-10-22 09:00-03',null,null,1000),
        (2,'payment_confirmed',null,null,null,'pagado','andreani',null,'created','t2','e2','2026-10-22 08:00-03','2026-10-22 10:00-03',null,2000),
        (11,'payment_confirmed',null,null,null,'pagado','andreani',null,'created','t11','e11','2026-10-22 07:00-03',null,null,3000),
        -- Envío BEYONIX: 50 pendiente, 51 armado y etiquetado, 52 en camino, 53 entregado sin auditoría, 54 cancelado con armado.
        (50,'payment_confirmed',null,null,null,'pagado','beyonix',null,null,null,null,'2026-10-22 09:30-03',null,null,5000),
        (51,'payment_confirmed',null,null,null,'pagado','beyonix','beyonix',null,null,null,'2026-10-22 08:30-03',null,null,5100),
        (52,'payment_confirmed',null,null,null,'en_camino','beyonix',null,null,null,null,'2026-10-21 18:00-03',null,null,5200),
        (53,'payment_confirmed',null,null,null,'entregado','beyonix',null,null,null,null,'2026-10-21 17:00-03',null,'2026-10-22 12:00-03',5300),
        (54,'refund_pending','2026-10-22 13:00-03',null,null,'cancelado','beyonix',null,null,null,null,'2026-10-22 07:30-03',null,null,5400),
        -- 55: BEYONIX explícito con residuos de Andreani (guía, envío, hasta entregado al transporte): nunca es Andreani.
        (55,'payment_confirmed',null,'2026-10-22 11:30-03','${C}','pagado','beyonix','andreani','created','t55','e55','2026-10-22 06:00-03','2026-10-22 06:30-03',null,5500),
        -- Legacy: 56 sin shipping_provider (envio_proveedor andreani); 57 shipping_provider en blanco (envio_proveedor BEYONIX);
        -- 58 explícito andreani con envio_proveedor beyonix contradictorio; 59 retiro (fuera de Despachos).
        (56,'payment_confirmed',null,null,null,'pagado',null,'andreani',null,null,null,'2026-10-22 05:00-03',null,null,5600),
        (57,'payment_confirmed',null,null,null,'pagado','   ',' BEYONIX ',null,null,null,'2026-10-22 05:30-03',null,null,5700),
        (58,'payment_confirmed',null,null,null,'pagado','andreani','beyonix',null,null,null,'2026-10-22 04:00-03',null,null,5800),
        (59,'payment_confirmed',null,null,null,'pagado','retiro',null,null,null,null,'2026-10-22 04:30-03',null,null,5900);
      insert into public.order_packages values
        (2,2,'prepared',1,'2026-10-22 10:00-03','${A}','${B}','andreani'),
        (51,51,'prepared',1,'2026-10-22 10:15-03','${A}','${B}','local_delivery'),
        (52,52,'prepared',1,'2026-10-21 19:00-03','${A}','${B}','local_delivery'),
        (54,54,'prepared',1,'2026-10-22 10:00-03','${A}',null,'local_delivery');
      insert into public.ready_parcels values (51),(52);
      insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, created_at) values
        (52,'admin','${C}','order_status_changed','pagado','en_camino','2026-10-22 11:00-03'),
        (52,'admin','${A}','order_status_changed','pagado','en_camino','2026-10-22 11:05-03');
      insert into public.order_cancellation_holds values (54,'2026-10-22 13:00-03','2026-10-22 13:30-03','${C}');
      insert into public.orden_items values (1,1),(2,1),(11,2),(50,1),(51,2),(52,1),(53,1),(54,1),(55,1),(56,1),(57,1),(58,1);
      insert into public.dispatch_batches values (2,'DSP-20261022-002',2,'open','2026-10-22 11:00-03',null,null,'${B}',null,null);
      insert into public.dispatch_batch_items values (11,2,11,null,null);`)
    for (const migration of ["20261022100000_dispatch_unified_records", "20261022110000_dispatch_records_open_work_no_annulled",
      "20261023130000_dispatch_records_handed_over_fallback", "20261024100000_dispatch_records_kind_filter"])
      await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"))
    const find = async (filters: string) => {
      const { rows } = await db.query<{ result: { rows: CarrierRow[]; total: number } }>(`select public.search_dispatch_records(${filters}) result`)
      return rows[0].result
    }
    const keys = (rows: Row[]) => rows.map((row) => `${row.kind}:${row.id}`).sort()
    const day = "p_date => '2026-10-22'"
    // Antes: sólo Andreani por coalesce(shipping_provider, envio_proveedor). El legacy 57 ('   ') quedaba afuera
    // y el 55 (beyonix explícito) también, igual que ahora.
    const before = await find(day)
    assert.deepEqual(keys(before.rows), ["batch:2", "order:1", "order:2", "order:56", "order:58"])

    await db.exec(readFileSync("supabase/migrations/20261106110000_dispatch_records_carrier_filter.sql", "utf8"))
    const { rows: overloads } = await db.query("select 1 from pg_proc where proname = 'search_dispatch_records'")
    assert.equal(overloads.length, 1, "una sola firma para PostgREST")

    // Andreani: exactamente las mismas filas que antes de la migración (estados, actores y selección intactos).
    const andreani = await find(`${day}, p_carrier => 'andreani'`)
    assert.deepEqual(keys(andreani.rows), keys(before.rows))
    const withoutCarrier = (row: CarrierRow): Row => {
      const copy: Partial<CarrierRow> = { ...row }
      delete copy.carrier
      return copy as Row
    }
    assert.deepEqual(andreani.rows.map(withoutCarrier).sort((a, b) => a.id - b.id || a.kind.localeCompare(b.kind)),
      before.rows.slice().sort((a, b) => a.id - b.id || a.kind.localeCompare(b.kind)))
    assert.ok(andreani.rows.every((row) => row.carrier === "andreani"))

    // BEYONIX: sólo pedidos locales (nunca Bultos), con sus estados propios.
    const beyonix = await find(`${day}, p_carrier => 'beyonix'`)
    assert.deepEqual(keys(beyonix.rows), ["order:50", "order:51", "order:52", "order:53", "order:54", "order:55", "order:57"])
    const local = new Map(beyonix.rows.map((row) => [row.id, row]))
    assert.deepEqual([local.get(50)!.state, local.get(51)!.state, local.get(52)!.state, local.get(53)!.state, local.get(54)!.state], ["P", "C", "E", "E", "X"])
    assert.equal(local.get(55)!.state, "P", "residuos de Andreani no lo vuelven Confirmado ni Entregado al transporte")
    assert.equal(local.get(57)!.carrier, "beyonix", "legacy: shipping_provider en blanco usa envio_proveedor")
    assert.ok(beyonix.rows.every((row) => row.carrier === "beyonix" && row.selectable === false), "un pedido local nunca entra a un Bulto Andreani")
    // En camino: fecha y usuario del primer cambio a En camino; entregado sin auditoría: fecha de entrega.
    assert.deepEqual([new Date(local.get(52)!.at).toISOString(), local.get(52)!.actorId], ["2026-10-22T14:00:00.000Z", C])
    assert.equal(new Date(local.get(53)!.at).toISOString(), "2026-10-22T15:00:00.000Z")
    assert.deepEqual([local.get(51)!.actorId, local.get(54)!.actorId], [B, C])

    // Todos = Andreani + BEYONIX, sin duplicados ni pérdidas; 59 (retiro) nunca.
    const all = await find(day)
    assert.deepEqual(keys(all.rows), [...keys(andreani.rows), ...keys(beyonix.rows)].sort())
    assert.equal(all.total, andreani.total + beyonix.total)
    assert.ok(!keys(all.rows).includes("order:59"))

    // Combinados con Estado, Tipo, N° pedido, N° bulto, Usuario y fecha por defecto.
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'beyonix', p_state => 'E'`)).rows), ["order:52", "order:53"])
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'beyonix', p_kind => 'batch'`)).rows), [])
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'andreani', p_kind => 'batch'`)).rows), ["batch:2"])
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'beyonix', p_order => '1051'`)).rows), ["order:51"])
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'andreani', p_order => '1051'`)).rows), [])
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'beyonix', p_batch => '0002'`)).rows), [], "un N° de Bulto nunca trae pedidos locales")
    assert.deepEqual(keys((await find(`${day}, p_carrier => 'beyonix', p_actor_id => '${C}'`)).rows), ["order:52", "order:54"])
    assert.deepEqual(keys((await find(`p_date => '2026-10-25', p_open_all_dates => true, p_carrier => 'beyonix'`)).rows), ["order:50", "order:51", "order:55", "order:57"],
      "fecha por defecto: lo abierto local sigue visible; despachado y cancelado sólo con su fecha")
    for (const carrier of ["Andreani", "local", ""]) await assert.rejects(find(`p_carrier => '${carrier}'`), /DISPATCH_FILTER_INVALID/, carrier)

    // La normalización es una sola: order_is_local_delivery usa la misma fuente.
    const { rows: flags } = await db.query<{ id: number; local: boolean; carrier: string }>(
      "select id, public.order_is_local_delivery(o) local, public.order_shipping_carrier(o) carrier from public.ordenes o where id in (55,56,57,58,59) order by id")
    assert.deepEqual(flags.map((row) => [row.id, row.local, row.carrier]), [[55, true, "beyonix"], [56, false, "andreani"], [57, true, "beyonix"], [58, false, "andreani"], [59, false, "retiro"]])

    // Paginación: el filtro se aplica antes del LIMIT (25 locales nuevos => 2 páginas sólo de BEYONIX).
    await db.exec("insert into public.ordenes (id, financial_status, estado, shipping_provider, created_at, total) select n, 'payment_confirmed', 'pagado', 'beyonix', '2026-10-22 03:00-03', 100 from generate_series(100,124) n")
    const first = await find(`${day}, p_carrier => 'beyonix'`)
    const second = await find(`${day}, p_carrier => 'beyonix', p_page => 2`)
    assert.equal(first.total, 32)
    assert.deepEqual([first.rows.length, second.rows.length], [20, 12])
    assert.ok([...first.rows, ...second.rows].every((row) => row.carrier === "beyonix"))
    assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 32, "sin repetidos entre páginas")
    assert.equal((await find(`${day}, p_carrier => 'andreani'`)).total, andreani.total, "los locales nunca ocupan lugar en Andreani")
    await db.exec("set role anon")
    await assert.rejects(find(day), /permission denied/i)
  } finally { await db.close() }
})

test("respaldo: entregado al transporte sin pertenencia activa sigue visible; con pertenencia, sólo en su Bulto", async () => {
  const db = new PGlite()
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role;
      create table public.ordenes (id bigint primary key, financial_status text, cancelled_at timestamptz,
        andreani_handed_over_at timestamptz, andreani_handed_over_by uuid, andreani_handed_over_batch_id bigint,
        estado text, shipping_provider text, envio_proveedor text,
        andreani_creation_status text, andreani_tracking text, andreani_envio_id text,
        created_at timestamptz, andreani_created_at timestamptz, total numeric);
      create table public.order_packages (id bigint primary key, order_id bigint, status text, attempt_number integer,
        prepared_at timestamptz, prepared_by uuid, identified_by uuid, identification_method text);
      create table public.dispatch_batches (id bigint primary key, code text, display_number integer, status text,
        created_at timestamptz, closed_at timestamptz, handed_over_at timestamptz,
        created_by uuid, closed_by uuid, handed_over_by uuid);
      create table public.dispatch_batch_items (id bigint primary key, batch_id bigint, order_id bigint,
        removed_at timestamptz, removed_by uuid);
      create table public.orden_items (orden_id bigint, cantidad integer);
      create table public.order_preparation_scans (id bigint primary key, package_id bigint, attempt_number integer, scanned_by uuid, scanned_at timestamptz);
      create table public.order_cancellation_holds (order_id bigint, detected_at timestamptz, resolved_at timestamptz, resolved_by uuid);
      create table public.dispatch_blocks (order_id bigint, resolved_at timestamptz);
      -- Bulto 0003 entregado al transporte con BX-1012 y BX-1013 (2 pedidos, 3 unidades); 14 perdió su pertenencia.
      insert into public.ordenes values
        (12,'payment_confirmed',null,'2026-10-22 13:54-03','${C}',3,'pagado','andreani',null,'created','t12','e12','2026-10-22 07:00-03',null,1599),
        (13,'payment_confirmed',null,'2026-10-22 13:54-03','${C}',3,'pagado','andreani',null,'created','t13','e13','2026-10-22 07:00-03',null,2000),
        (14,'payment_confirmed',null,'2026-10-22 13:54-03','${C}',3,'pagado','andreani',null,'created','t14','e14','2026-10-22 07:00-03',null,500);
      insert into public.orden_items values (12,1),(13,2),(14,1);
      insert into public.dispatch_batches values
        (3,'DSP-20261022-003',3,'handed_over','2026-10-22 08:00-03','2026-10-22 12:00-03','2026-10-22 13:54-03','${B}','${B}','${C}');
      insert into public.dispatch_batch_items values (12,3,12,null,null),(13,3,13,null,null),(14,3,14,'2026-10-22 14:00-03','${A}');`)
    for (const migration of ["20261022100000_dispatch_unified_records", "20261022110000_dispatch_records_open_work_no_annulled", "20261023130000_dispatch_records_handed_over_fallback", "20261024100000_dispatch_records_kind_filter"])
      await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"))
    const { rows } = await db.query<{ result: { rows: Row[]; total: number } }>("select public.search_dispatch_records(p_date => '2026-10-22') result")
    const byKey = new Map(rows[0].result.rows.map((row) => [`${row.kind}:${row.id}`, row]))
    assert.deepEqual([...byKey.keys()].sort(), ["batch:3", "order:14"], "A: 12 y 13 sólo dentro de su Bulto; F: 14 no desaparece")
    const batch = byKey.get("batch:3")!
    assert.deepEqual([batch.state, batch.orderCount, batch.units, Number(batch.total)], ["E", 2, 3, 3599], "2 pedidos (3 unidades), $3.599")
    const orphan = byKey.get("order:14")!
    assert.deepEqual([orphan.state, orphan.actorId, orphan.selectable, orphan.units], ["E", C, false, 1], "respaldo: entregado al transporte, nunca seleccionable")
    assert.equal(new Date(orphan.at).toISOString(), "2026-10-22T16:54:00.000Z")
  } finally { await db.close() }
})
