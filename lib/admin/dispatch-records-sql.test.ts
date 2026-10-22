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
    await db.exec("set role anon")
    await assert.rejects(find(today), /permission denied/i)
  } finally { await db.close() }
})
