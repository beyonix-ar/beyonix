import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// 20261125150000: las compras de prueba (ordenes.test_order_at) salen de
// Pedidos y Bultos (search_dispatch_records) y de las colas de Entregas
// locales (local_delivery_queue_order_ids) con cualquier filtro, fecha o
// página; los pedidos legítimos conservan exactamente sus filas.

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C = "33333333-3333-4333-8333-333333333333"
const TEST_ORDERS = [2, 3, 12, 13, 60, 61, 71, 73]
type Row = { kind: "order" | "batch"; id: number; state: string; carrier: string; actorId: string | null; units: number; total: number; orderCount: number; selectable: boolean }

async function setup() {
  const db = new PGlite()
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table public.ordenes (id bigint primary key, financial_status text, cancelled_at timestamptz,
      andreani_handed_over_at timestamptz, andreani_handed_over_by uuid, estado text, shipping_provider text, envio_proveedor text,
      andreani_creation_status text, andreani_tracking text, andreani_envio_id text,
      created_at timestamptz, andreani_created_at timestamptz, delivered_at timestamptz, total numeric,
      paid_at timestamptz, payment_confirmed_amount numeric, payment_status text, test_order_at timestamptz);
    create table public.order_packages (id bigint primary key, order_id bigint, status text, attempt_number integer,
      prepared_at timestamptz, prepared_by uuid, identified_by uuid, identification_method text);
    create table public.dispatch_batches (id bigint primary key, code text, display_number integer, status text,
      created_at timestamptz, closed_at timestamptz, handed_over_at timestamptz, created_by uuid, closed_by uuid, handed_over_by uuid);
    create table public.dispatch_batch_items (id bigint primary key, batch_id bigint, order_id bigint, removed_at timestamptz, removed_by uuid);
    create table public.orden_items (orden_id bigint, cantidad integer, warranty_started_at timestamptz);
    create table public.order_preparation_scans (id bigint primary key, package_id bigint, attempt_number integer, scanned_by uuid, scanned_at timestamptz);
    create table public.order_cancellation_holds (order_id bigint, detected_at timestamptz, resolved_at timestamptz, resolved_by uuid);
    create table public.dispatch_blocks (order_id bigint, resolved_at timestamptz);
    create table public.order_audit_events (id bigserial primary key, order_id bigint, actor_type text, actor_id uuid, action text,
      previous_status text, new_status text, metadata jsonb, created_at timestamptz);
    create table public.ready_parcels (order_id bigint primary key);
    create function public.local_delivery_parcels_ready(p_order_id bigint) returns boolean language sql stable
      as $$ select exists (select 1 from public.ready_parcels where order_id = p_order_id) $$;
    create table public.local_delivery_shipments (id bigint primary key, order_id bigint, shipment_number integer, outcome_status text, returned_at timestamptz);
    create table public.local_delivery_return_reservations (id bigint primary key, shipment_id bigint, status text);
    insert into public.ordenes (id, financial_status, cancelled_at, andreani_handed_over_at, andreani_handed_over_by, estado, shipping_provider,
      andreani_creation_status, andreani_tracking, andreani_envio_id, created_at, andreani_created_at, delivered_at, total, test_order_at) values
      -- Andreani: 1 pendiente real; 2 pendiente de prueba; 3 de prueba entregado al transporte sin Bulto (respaldo E).
      (1,'payment_confirmed',null,null,null,'pagado','andreani',null,null,null,'2026-10-22 09:00-03',null,null,1000,null),
      (2,'payment_confirmed',null,null,null,'pagado','andreani',null,null,null,'2026-10-22 09:10-03',null,null,1000,'2026-11-24 10:00-03'),
      (3,'payment_confirmed',null,'2026-10-22 11:00-03','${C}','pagado','andreani','created','t3','e3','2026-10-22 07:00-03',null,null,3000,'2026-11-24 10:00-03'),
      -- Bulto 2: real 11 + prueba 12. Bulto 3: sólo la prueba 13.
      (11,'payment_confirmed',null,null,null,'pagado','andreani','created','t11','e11','2026-10-22 07:00-03',null,null,3000,null),
      (12,'payment_confirmed',null,null,null,'pagado','andreani','created','t12','e12','2026-10-22 07:00-03',null,null,4000,'2026-11-24 10:00-03'),
      (13,'payment_confirmed',null,null,null,'pagado','andreani','created','t13','e13','2026-10-22 07:00-03',null,null,5000,'2026-11-24 10:00-03'),
      -- Envío BEYONIX: 50 entregado real; 51 pendiente real; 60 entregado de prueba (como BX-1019/1020); 61 pendiente de prueba.
      (50,'payment_confirmed',null,null,null,'entregado','beyonix',null,null,null,'2026-10-21 17:00-03',null,'2026-10-22 12:00-03',5000,null),
      (51,'payment_confirmed',null,null,null,'pagado','beyonix',null,null,null,'2026-10-22 08:30-03',null,null,5100,null),
      (60,'payment_confirmed',null,null,null,'entregado','beyonix',null,null,null,'2026-10-21 17:30-03',null,'2026-10-22 12:30-03',100,'2026-11-24 10:00-03'),
      (61,'payment_confirmed',null,null,null,'pagado','beyonix',null,null,null,'2026-10-22 08:40-03',null,null,20,'2026-11-24 10:00-03');
    insert into public.order_packages values (60,60,'prepared',1,'2026-10-22 10:00-03','${A}','${B}','local_delivery');
    insert into public.order_audit_events(order_id, actor_type, actor_id, action, previous_status, new_status, created_at) values
      (50,'admin','${C}','order_status_changed','preparado','en_camino','2026-10-22 11:00-03'),
      (60,'admin','${C}','order_status_changed','preparado','en_camino','2026-10-22 11:10-03');
    insert into public.orden_items values (1,1),(2,1),(3,1),(11,2),(12,3),(13,1),(50,1),(51,1),(60,1),(61,1);
    insert into public.dispatch_batches values
      (2,'DSP-20261022-002',2,'open','2026-10-22 11:00-03',null,null,'${B}',null,null),
      (3,'DSP-20261022-003',3,'open','2026-10-22 11:30-03',null,null,'${B}',null,null);
    insert into public.dispatch_batch_items values (11,2,11,null,null),(12,2,12,null,null),(13,3,13,null,null);`)
  for (const migration of ["20261022100000_dispatch_unified_records", "20261022110000_dispatch_records_open_work_no_annulled",
    "20261023130000_dispatch_records_handed_over_fallback", "20261024100000_dispatch_records_kind_filter",
    "20261106110000_dispatch_records_carrier_filter"])
    await db.exec(readFileSync(`supabase/migrations/${migration}.sql`, "utf8"))
  return db
}

const MIGRATION = readFileSync("supabase/migrations/20261125150000_exclude_test_orders_from_dispatch.sql", "utf8")
const find = async (db: PGlite, filters: string) =>
  (await db.query<{ result: { rows: Row[]; total: number } }>(`select public.search_dispatch_records(${filters}) result`)).rows[0].result
const keys = (rows: Row[]) => rows.map((row) => `${row.kind}:${row.id}`).sort()
const isTestOrderRow = (key: string) => key.startsWith("order:") && TEST_ORDERS.includes(Number(key.slice(6)))

// Todas las combinaciones que la pantalla puede pedir: vista por defecto
// (hoy + abiertos de cualquier fecha), "Limpiar filtros", fecha elegida y cada filtro.
const DAY = "p_date => '2026-10-22'"
const VIEWS = [
  `p_date => '2026-11-25', p_open_all_dates => true`,
  "",
  DAY,
  `${DAY}, p_open_all_dates => true`,
  ...["P", "C", "E", "X"].map((state) => `${DAY}, p_state => '${state}'`),
  ...["andreani", "beyonix"].map((carrier) => `${DAY}, p_carrier => '${carrier}'`),
  ...["order", "batch"].map((kind) => `${DAY}, p_kind => '${kind}'`),
  `${DAY}, p_actor_id => '${C}'`,
  `${DAY}, p_carrier => 'beyonix', p_state => 'E'`,
  `p_date => '2026-10-21', p_carrier => 'beyonix'`,
]

test("Pedidos y Bultos: ninguna compra de prueba con ningún filtro; los pedidos reales conservan exactamente sus filas", async () => {
  const db = await setup()
  try {
    const before = new Map<string, { rows: Row[]; total: number }>()
    for (const view of VIEWS) before.set(view, await find(db, view))
    // Sin la migración, las pruebas aparecen (reproduce lo visto en producción con BX-1019/1020).
    assert.ok(keys(before.get(DAY)!.rows).filter(isTestOrderRow).length > 0, "el fixture reproduce el problema")

    await db.exec(MIGRATION)
    for (const view of VIEWS) {
      const after = await find(db, view)
      const previous = before.get(view)!
      assert.deepEqual(keys(after.rows).filter(isTestOrderRow), [], `sin pruebas: ${view || "(sin filtros)"}`)
      // Exactamente las filas reales de antes, con sus mismos datos (estado, actor, sumas, selección).
      const expected = previous.rows.filter((row) => !isTestOrderRow(`${row.kind}:${row.id}`))
      assert.deepEqual(after.rows.slice().sort((x, y) => x.id - y.id || x.kind.localeCompare(y.kind)),
        expected.slice().sort((x, y) => x.id - y.id || x.kind.localeCompare(y.kind)), `filas reales intactas: ${view || "(sin filtros)"}`)
      assert.equal(after.total, expected.length, `contador sin pruebas: ${view || "(sin filtros)"}`)
    }
    assert.deepEqual(keys((await find(db, DAY)).rows), ["batch:2", "batch:3", "order:1", "order:50", "order:51"])

    // Búsqueda por N°: la prueba no aparece ni lleva a su Bulto; los reales sí.
    for (const id of [2, 3, 12, 13, 60, 61]) {
      assert.deepEqual(keys((await find(db, `${DAY}, p_order => 'BX-${1000 + id}'`)).rows), [], `BX-${1000 + id}`)
      assert.deepEqual(keys((await find(db, `p_order => '${1000 + id}'`)).rows), [], `${1000 + id} sin fecha`)
    }
    assert.deepEqual(keys((await find(db, `${DAY}, p_order => 'BX-1011'`)).rows), ["batch:2"])
    assert.deepEqual(keys((await find(db, `${DAY}, p_order => 'BX-1050'`)).rows), ["order:50"])

    // El Bulto conserva su contenido físico (no se edita la historia logística).
    const batches = new Map((await find(db, `${DAY}, p_kind => 'batch'`)).rows.map((row) => [row.id, row]))
    assert.deepEqual([batches.get(2)!.orderCount, batches.get(2)!.units, Number(batches.get(2)!.total)], [2, 5, 7000])

    // Paginación: 25 pedidos de prueba nuevos no ocupan lugares ni páginas.
    const realTotal = (await find(db, DAY)).total
    await db.exec(`insert into public.ordenes (id, financial_status, estado, shipping_provider, created_at, total, test_order_at)
      select n, 'payment_confirmed', 'pagado', 'beyonix', '2026-10-22 23:00-03', 1, now() from generate_series(200, 224) n`)
    const first = await find(db, DAY)
    assert.equal(first.total, realTotal)
    assert.deepEqual(keys(first.rows), ["batch:2", "batch:3", "order:1", "order:50", "order:51"])
    assert.deepEqual((await find(db, `${DAY}, p_page => 2`)).rows, [])

    // Nada se escribió: las pruebas siguen intactas en la base.
    const { rows } = await db.query<{ n: number }>("select count(*)::int n from public.ordenes where test_order_at is not null")
    assert.equal(rows[0].n, 6 + 25)
    const { rows: overloads } = await db.query("select 1 from pg_proc where proname = 'search_dispatch_records'")
    assert.equal(overloads.length, 1, "una sola firma para PostgREST")
    await db.exec("set role anon")
    await assert.rejects(find(db, DAY), /permission denied/i)
  } finally { await db.close() }
})

test("Entregas locales: las colas operativa y de devueltos nunca incluyen compras de prueba ni pierden cupo por ellas", async () => {
  const db = await setup()
  try {
    await db.exec(`update public.ordenes set paid_at = created_at, payment_confirmed_amount = total, payment_status = 'approved';
      insert into public.ordenes (id, financial_status, estado, shipping_provider, created_at, total, paid_at, payment_confirmed_amount, payment_status, test_order_at) values
        (5, 'payment_confirmed', 'pagado', 'beyonix', '2026-10-22 08:00-03', 10, now(), 10, 'approved', now()),
        (70, 'payment_confirmed', 'preparado', 'beyonix', '2026-10-22 08:00-03', 10, now(), 10, 'approved', null),
        (71, 'payment_confirmed', 'preparado', 'beyonix', '2026-10-22 08:00-03', 10, now(), 10, 'approved', now()),
        (72, 'payment_confirmed', 'en_camino', 'beyonix', '2026-10-22 08:00-03', 10, now(), 10, 'approved', null),
        (73, 'payment_confirmed', 'en_camino', 'beyonix', '2026-10-22 08:00-03', 10, now(), 10, 'approved', now());
      insert into public.local_delivery_shipments values (1, 72, 1, 'returned', now()), (2, 73, 1, 'returned', now());
      insert into public.local_delivery_return_reservations values (1, 1, 'active'), (2, 2, 'active');`)
    await db.exec(MIGRATION)
    const queue = async (name: string, limit = 200) =>
      (await db.query<{ id: number }>(`select id::int from public.local_delivery_queue_order_ids('${name}', ${limit}) id`)).rows.map((row) => row.id)
    assert.deepEqual(await queue("operational"), [51, 70], "5, 61 y 71 (prueba) fuera; 50 y 60 entregados nunca están en la cola")
    assert.deepEqual(await queue("returned"), [72], "73 (prueba devuelta con reserva activa) fuera")
    // Cupo: la cola ordena por id; con límite 1 el lugar es del pedido real 51, no de la prueba 5.
    assert.deepEqual(await queue("operational", 1), [51])
    await db.exec("set role authenticated")
    await assert.rejects(queue("operational"), /permission denied/i)
  } finally { await db.close() }
})
