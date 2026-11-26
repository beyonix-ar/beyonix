import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración 20261125130000 sobre PostgreSQL (PGlite) con roles y RLS reales:
// lo que el navegador lee DIRECTO de la base (avisos con la sesión del
// cliente, valoraciones públicas con la clave anónima) excluye compras de
// prueba, nada se borra y no se pueden crear reseñas nuevas sobre ellas.

const MIGRATION = readFileSync(new URL("../../supabase/migrations/20261125130000_hide_test_orders_from_customers.sql", import.meta.url), "utf8")
// Definiciones VIGENTES (producción) de la señal Realtime y la RPC de la campana.
const PRIVACY = readFileSync(new URL("../../supabase/migrations/20261009130000_customer_order_privacy.sql", import.meta.url), "utf8").replace(/\r\n/g, "\n")
function extract(name: string) {
  const start = PRIVACY.indexOf(`create or replace function public.${name}(`)
  if (start < 0) throw new Error(`No se encontró ${name}`)
  // El cuerpo termina en la primera línea que cierra el dólar-quote ("$$;").
  const close = PRIVACY.indexOf("$$;", PRIVACY.indexOf("$$", start) + 2)
  return PRIVACY.slice(start, close + 3)
}
const OWNER = "6ebd099d-2fd4-418b-b3b2-2ff212afad53"
const OTHER = "10000000-0000-4000-8000-000000000002"

async function setup() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;

    create table public.ordenes (id bigint primary key, usuario_id uuid, test_order_at timestamptz, estado text default 'entregado',
      payment_method_id text default 'mercadopago', payment_status text default 'approved', financial_status text default 'payment_confirmed',
      payment_proof_url text, payment_proof_uploaded_at timestamptz, created_at timestamptz default now());
    alter table public.ordenes enable row level security; -- el cliente no lee ordenes
    create table public.customer_notifications (
      id bigserial primary key, user_id uuid not null, order_id bigint references public.ordenes(id) on delete cascade,
      type text not null, is_read boolean not null default false);
    alter table public.customer_notifications enable row level security;
    create policy "Customers can read own notifications" on public.customer_notifications for select to authenticated using (user_id = auth.uid());
    create policy "Customers can mark own notifications as read" on public.customer_notifications for update to authenticated using (user_id = auth.uid());
    grant select, update on public.customer_notifications to authenticated;
    grant all on public.customer_notifications, public.ordenes to service_role;

    create table public.reviews (
      id bigserial primary key, user_id uuid not null, order_id bigint not null references public.ordenes(id) on delete cascade,
      product_id bigint, rating int not null, approved boolean not null default true);
    alter table public.reviews enable row level security;
    create policy "Public can read approved reviews" on public.reviews for select to public using (approved = true);
    grant select (id, product_id, rating, approved) on public.reviews to anon, authenticated;
    grant all on public.reviews to service_role;
    grant usage on all sequences in schema public to service_role;

    -- Señal Realtime y RPC tal como están hoy (20261009130000).
    create table public.customer_order_signals (
      order_id bigint primary key references public.ordenes(id) on delete cascade, user_id uuid not null, changed_at timestamptz not null default now());
    alter table public.customer_order_signals enable row level security;
    grant select on public.customer_order_signals to authenticated;
    grant select, insert, update, delete on public.customer_order_signals to service_role;
    create policy customer_order_signals_select_own on public.customer_order_signals for select to authenticated using (user_id = auth.uid());
    ${extract("signal_customer_order_change")}
    create trigger signal_customer_order_change after insert or update on public.ordenes for each row execute function public.signal_customer_order_change();
    ${extract("customer_order_payment_progress")}
    revoke all on function public.customer_order_payment_progress(bigint[]) from public, anon;
    grant execute on function public.customer_order_payment_progress(bigint[]) to authenticated, service_role;

    insert into public.ordenes (id, usuario_id, test_order_at) values (18, '${OWNER}', null), (19, '${OWNER}', now()), (20, '${OWNER}', now()), (21, '${OTHER}', null), (30, '${OWNER}', null);
    insert into public.customer_notifications (user_id, order_id, type) values
      ('${OWNER}', 19, 'order_shipped'), ('${OWNER}', 19, 'order_delivered'), ('${OWNER}', 19, 'claim_started'),
      ('${OWNER}', 19, 'claim_update'), ('${OWNER}', 19, 'claim_resolved'), ('${OWNER}', 20, 'order_shipped'),
      ('${OWNER}', 20, 'order_delivered'), ('${OWNER}', 18, 'order_delivered'), ('${OWNER}', null, 'campaign'),
      ('${OTHER}', 21, 'order_delivered');
    -- Reseña previa de una compra que luego se clasifica como prueba (30) y reseñas reales.
    insert into public.reviews (user_id, order_id, product_id, rating) values
      ('${OWNER}', 18, 22, 5), ('${OWNER}', 30, 22, 1), ('${OTHER}', 21, 22, 4), ('${OWNER}', 18, null, 5), ('${OWNER}', 30, null, 1);

    -- Lo que Realtime lee del WAL: cada INSERT/UPDATE/DELETE sobre la señal.
    create table public.signal_wal (seq bigserial primary key, op text not null, order_id bigint not null);
    create function public.log_signal_wal() returns trigger language plpgsql as $$
    begin
      insert into public.signal_wal (op, order_id) values (tg_op, case when tg_op = 'DELETE' then old.order_id else new.order_id end);
      return null;
    end $$;
    create trigger log_signal_wal after insert or update or delete on public.customer_order_signals
      for each row execute function public.log_signal_wal();
  `)
  await db.exec(MIGRATION)
  // Clasificación posterior a la reseña: las reglas son dinámicas.
  await db.exec("update public.ordenes set test_order_at = now() where id = 30")
  return db
}

async function as<T>(db: PGlite, role: string, sub: string | null, run: () => Promise<T>) {
  await db.exec(`set role ${role}`)
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [sub ?? ""])
  try {
    return await run()
  } finally {
    await db.exec("reset role")
  }
}

test("avisos del cliente: sin los de compras de prueba; avisos reales, generales y de otros usuarios intactos", async () => {
  const db = await setup()
  try {
    const own = await as(db, "authenticated", OWNER, async () =>
      (await db.query<{ order_id: number | null; type: string }>("select order_id::int, type from public.customer_notifications order by id")).rows)
    assert.deepEqual(own, [{ order_id: 18, type: "order_delivered" }, { order_id: null, type: "campaign" }])

    const unread = await as(db, "authenticated", OWNER, async () =>
      Number((await db.query<{ n: number }>("select count(*)::int n from public.customer_notifications where not is_read")).rows[0].n))
    assert.equal(unread, 2, "el contador de no leídos no incluye las pruebas")

    const other = await as(db, "authenticated", OTHER, async () =>
      (await db.query<{ order_id: number }>("select order_id::int from public.customer_notifications")).rows)
    assert.deepEqual(other, [{ order_id: 21 }], "aislamiento entre usuarios")

    const anon = await as(db, "anon", null, async () => db.query("select 1 from public.customer_notifications").then(() => "ok", (error: Error) => error.message))
    assert.match(String(anon), /permission denied/)

    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from public.customer_notifications")).rows[0].n), 10, "ningún aviso se borró")
  } finally {
    await db.close()
  }
})

test("valoraciones públicas: listados y promedios sin reseñas de compras de prueba; ninguna reseña se borra", async () => {
  const db = await setup()
  try {
    const visible = await as(db, "anon", null, async () =>
      (await db.query<{ product_id: number | null; rating: number }>("select product_id::int, rating from public.reviews order by id")).rows)
    assert.deepEqual(visible, [{ product_id: 22, rating: 5 }, { product_id: 22, rating: 4 }, { product_id: null, rating: 5 }])

    const average = await as(db, "anon", null, async () =>
      Number((await db.query<{ avg: string }>("select avg(rating)::numeric(3,2)::text avg from public.reviews where product_id = 22")).rows[0].avg))
    assert.equal(average, 4.5, "el 1★ de la compra de prueba no baja el promedio")

    const ownerSees = await as(db, "authenticated", OWNER, async () =>
      Number((await db.query<{ n: number }>("select count(*)::int n from public.reviews")).rows[0].n))
    assert.equal(ownerSees, 3, "tampoco el comprador ve sus reseñas de la prueba por la API pública")

    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from public.reviews")).rows[0].n), 5, "las 5 reseñas siguen en la base")
  } finally {
    await db.close()
  }
})

test("reseñas nuevas o re-vinculadas a una compra de prueba se rechazan en la base; las reales se crean", async () => {
  const db = await setup()
  try {
    await as(db, "service_role", null, async () => {
      await assert.rejects(db.query(`insert into public.reviews (user_id, order_id, product_id, rating) values ('${OWNER}', 19, 22, 5)`), /REVIEW_TEST_ORDER/)
      await assert.rejects(db.query(`insert into public.reviews (user_id, order_id, rating) values ('${OWNER}', 20, 5)`), /REVIEW_TEST_ORDER/)
      await assert.rejects(db.query("update public.reviews set order_id = 19 where order_id = 18 and product_id = 22"), /REVIEW_TEST_ORDER/)
      await db.query(`insert into public.reviews (user_id, order_id, product_id, rating) values ('${OTHER}', 21, 23, 5)`)
      await db.query("update public.reviews set rating = 4 where order_id = 18 and product_id = 22")
    })
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from public.reviews where order_id in (19, 20)")).rows[0].n), 0)
  } finally {
    await db.close()
  }
})

test("la función auxiliar no es una RPC pública: vive fuera del schema expuesto y la migración es repetible", async () => {
  const db = await setup()
  try {
    const rows = (await db.query<{ schema: string }>("select n.nspname schema from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.proname = 'is_test_order'")).rows
    assert.deepEqual(rows, [{ schema: "private" }])
    const privileges = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon', 'private.is_test_order(bigint)', 'EXECUTE') anon_policy_eval,
      has_function_privilege('authenticated', 'public.block_test_order_reviews()', 'EXECUTE') trigger_fn`)).rows[0]
    assert.deepEqual(privileges, { anon_policy_eval: true, trigger_fn: false })
    await db.exec(MIGRATION)
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from pg_policies where tablename in ('reviews', 'customer_notifications')")).rows[0].n), 3)
  } finally {
    await db.close()
  }
})

const signalsAs = (db: PGlite, role: string, sub: string | null) =>
  as(db, role, sub, async () => (await db.query<{ order_id: number }>("select order_id::int from public.customer_order_signals order by order_id")).rows.map((row) => row.order_id))

test("señales Realtime: lectura directa sin compras de prueba, aislada por cliente; anon sin acceso; service_role ve todo", async () => {
  const db = await setup()
  try {
    // Estado real de producción: existen señales de 19/20 creadas antes de clasificar.
    assert.deepEqual(await signalsAs(db, "service_role", null), [18, 19, 20, 21, 30], "las señales existentes no se borran")
    assert.deepEqual(await signalsAs(db, "authenticated", OWNER), [18], "el comprador sólo ve la compra real")
    assert.deepEqual(await signalsAs(db, "authenticated", OTHER), [21], "aislamiento entre clientes")
    const anon = await as(db, "anon", null, () => db.query("select 1 from public.customer_order_signals").then(() => "ok", (error: Error) => error.message))
    assert.match(String(anon), /permission denied/)
    // Consulta dirigida por id (como haría un cliente malicioso): igual vacía.
    const direct = await as(db, "authenticated", OWNER, async () => (await db.query("select * from public.customer_order_signals where order_id in (19, 20, 30)")).rows.length)
    assert.equal(direct, 0)
  } finally {
    await db.close()
  }
})

test("Realtime: una compra de prueba no emite eventos nuevos y ninguno es entregable al cliente; las legítimas siguen sincronizando", async () => {
  const db = await setup()
  try {
    const changedAt = async (id: number) => String((await db.query<{ t: string }>("select changed_at::text t from public.customer_order_signals where order_id = $1", [id])).rows[0]?.t)
    const before19 = await changedAt(19)
    const before18 = await changedAt(18)
    await db.exec("select pg_sleep(0.01)")
    // Cambios posteriores sobre pedidos: prueba (19) y real (18).
    await db.exec("update public.ordenes set estado = 'entregado', financial_status = 'payment_confirmed' where id in (18, 19)")
    assert.equal(await changedAt(19), before19, "la prueba no emite una señal nueva (sin evento Realtime)")
    assert.notEqual(await changedAt(18), before18, "la compra real sí emite su señal")
    // Pedido nuevo ya clasificado (p. ej. restaurado de un respaldo): sin señal.
    await db.exec(`insert into public.ordenes (id, usuario_id, test_order_at) values (40, '${OWNER}', now())`)
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from public.customer_order_signals where order_id = 40")).rows[0].n), 0)
    // Realtime (postgres_changes) entrega un evento sólo si la fila es legible
    // con la sesión del suscriptor (misma política SELECT): para el comprador,
    // ninguna fila de prueba lo es; la real sí.
    const deliverable = await as(db, "authenticated", OWNER, async () =>
      (await db.query<{ order_id: number }>("select order_id::int from public.customer_order_signals where order_id in (18, 19, 20, 30, 40) order by 1")).rows.map((row) => row.order_id))
    assert.deepEqual(deliverable, [18])
  } finally {
    await db.close()
  }
})

// Regla de entrega de realtime.apply_rls (verificada en producción, 2026-11-25):
//  * INSERT/UPDATE: sólo si `exists(select 1 from tabla where pk = …)` es
//    verdadero con el rol y la sesión del suscriptor (RLS sobre la fila actual).
//  * DELETE: SIN RLS. old_record = PK (order_id) para todo suscriptor cuyo
//    filtro la admita: sin filtro o con filtro por order_id. Un cliente
//    autenticado puede suscribirse así, aunque la campana filtre por user_id.
async function deliveredTo(db: PGlite, sub: string, fromSeq = 0) {
  const events = (await db.query<{ op: string; order_id: number }>(
    "select op, order_id::int from public.signal_wal where seq > $1 order by seq", [fromSeq])).rows
  const delivered: string[] = []
  for (const event of events) {
    const visible = event.op === "DELETE" || await as(db, "authenticated", sub, async () =>
      (await db.query("select 1 from public.customer_order_signals where order_id = $1", [event.order_id])).rows.length > 0)
    if (visible) delivered.push(`${event.op}:${event.order_id}`)
  }
  return delivered
}
const lastSeq = async (db: PGlite) => Number((await db.query<{ s: number }>("select coalesce(max(seq), 0)::int s from public.signal_wal")).rows[0].s)
const signalRows = async (db: PGlite) => (await db.query<{ order_id: number; user_id: string | null }>(
  "select order_id::int, user_id::text from public.customer_order_signals order by order_id")).rows
const TEST_ORDERS = [19, 20, 30]

test("señales de prueba existentes: la migración las desvincula sin borrarlas ni emitir DELETE", async () => {
  const db = await setup()
  try {
    const ops = (await db.query<{ op: string; order_id: number }>(
      "select op, order_id::int from public.signal_wal where order_id = any($1::bigint[]) order by seq", [TEST_ORDERS])).rows
    assert.ok(ops.length > 0, "la desvinculación sí quedó registrada")
    assert.ok(ops.every((row) => row.op === "UPDATE"), `ningún DELETE de pruebas: ${JSON.stringify(ops)}`)
    assert.deepEqual(await signalRows(db), [
      { order_id: 18, user_id: OWNER }, { order_id: 19, user_id: null }, { order_id: 20, user_id: null },
      { order_id: 21, user_id: OTHER }, { order_id: 30, user_id: null },
    ], "las señales de prueba quedan sin cliente; las reales intactas")
    for (const sub of [OWNER, OTHER]) {
      const leaked = (await deliveredTo(db, sub)).filter((event) => TEST_ORDERS.includes(Number(event.split(":")[1])))
      assert.deepEqual(leaked, [], `ningún evento de prueba entregable a ${sub}`)
    }
  } finally {
    await db.close()
  }
})

test("eliminación de cuenta: señales legítimas y de prueba se desvinculan sin DELETE ni acceso del antiguo comprador", async () => {
  const db = await setup()
  try {
    // Pedido de prueba de la cuenta, creado y clasificado después de la migración (señal recién emitida).
    await db.exec(`insert into public.ordenes (id, usuario_id) values (41, '${OWNER}')`)
    await db.exec("update public.ordenes set test_order_at = now() where id = 41")
    const from = await lastSeq(db)
    // Mismo UPDATE que app/api/account/delete/route.ts (service_role).
    await as(db, "service_role", null, () => db.exec(`update public.ordenes set usuario_id = null where usuario_id = '${OWNER}'`))

    const ops = (await db.query<{ op: string; order_id: number }>("select op, order_id::int from public.signal_wal where seq > $1 order by seq", [from])).rows
    assert.deepEqual(ops, [{ op: "UPDATE", order_id: 18 }], "la señal legítima se desvincula; las pruebas ya estaban desvinculadas")

    // Suscriptores sin filtro: ni el comprador anterior ni otro cliente reciben el UPDATE.
    assert.deepEqual(await deliveredTo(db, OWNER, from), [])
    assert.deepEqual(await deliveredTo(db, OTHER, from), [])

    const rows = await signalRows(db)
    assert.deepEqual(rows.find((row) => row.order_id === 18), { order_id: 18, user_id: null }, "la señal real queda sin comprador")
    assert.deepEqual(rows.filter((row) => [...TEST_ORDERS, 41].includes(row.order_id)),
      [19, 20, 30, 41].map((order_id) => ({ order_id, user_id: null })), "sin vínculo a la cuenta eliminada (no huérfanas de usuario)")
    assert.ok(!rows.some((row) => row.user_id === OWNER), "ninguna señal conserva el id de la cuenta eliminada")
    assert.deepEqual(rows.find((row) => row.order_id === 21), { order_id: 21, user_id: OTHER }, "otros clientes intactos")
    assert.deepEqual(await signalsAs(db, "authenticated", OWNER), [])

    // Cambios posteriores del Admin sobre pedidos anonimizados: nada nuevo.
    const afterDelete = await lastSeq(db)
    await db.exec("update public.ordenes set estado = 'archivado' where id in (18, 19, 41)")
    assert.equal(await lastSeq(db), afterDelete, "la señal ya desvinculada no vuelve a escribirse")
    assert.deepEqual(await signalsAs(db, "authenticated", OWNER), [])
  } finally {
    await db.close()
  }
})

test("señales legítimas: INSERT/UPDATE entregables sólo a su dueño; aislamiento entre clientes", async () => {
  const db = await setup()
  try {
    const from = await lastSeq(db)
    await db.exec(`insert into public.ordenes (id, usuario_id) values (50, '${OTHER}')`)
    await db.exec("update public.ordenes set estado = 'enviado' where id in (18, 50)")
    assert.deepEqual(await deliveredTo(db, OWNER, from), ["UPDATE:18"])
    assert.deepEqual(await deliveredTo(db, OTHER, from), ["INSERT:50", "UPDATE:50"])
    // Una señal legítima desvinculada puede volver a asociarse si el pedido
    // recibe comprador: el UPSERT existente restaura la notificación al nuevo dueño.
    await db.exec("update public.ordenes set usuario_id = null where id = 50")
    assert.deepEqual(await signalsAs(db, "authenticated", OTHER), [21])
    const beforeReassign = await lastSeq(db)
    await db.exec(`update public.ordenes set usuario_id = '${OWNER}' where id = 50`)
    assert.deepEqual(await deliveredTo(db, OWNER, beforeReassign), ["UPDATE:50"])
    assert.deepEqual(await deliveredTo(db, OTHER, beforeReassign), [])
    // Clasificar una compra real como prueba: su señal deja de ser entregable sin DELETE.
    const beforeClassify = await lastSeq(db)
    await db.exec("update public.ordenes set test_order_at = now() where id = 50")
    assert.deepEqual(await deliveredTo(db, OWNER, beforeClassify), [])
    assert.deepEqual((await db.query<{ op: string }>("select op from public.signal_wal where seq > $1", [beforeClassify])).rows.map((row) => row.op), ["UPDATE"])
  } finally {
    await db.close()
  }
})

test("RPC customer_order_payment_progress: sin estado de pago de compras de prueba; aislada por cliente; anon sin EXECUTE", async () => {
  const db = await setup()
  try {
    const progress = (role: string, sub: string | null) => as(db, role, sub, async () =>
      (await db.query<{ id: number; payment_status: string }>("select id::int, payment_status from public.customer_order_payment_progress(array[18, 19, 20, 21, 30]::bigint[]) order by id")).rows)
    assert.deepEqual(await progress("authenticated", OWNER), [{ id: 18, payment_status: "approved" }], "sin 19, 20 ni 30")
    assert.deepEqual(await progress("authenticated", OTHER), [{ id: 21, payment_status: "approved" }], "aislamiento entre clientes")
    assert.deepEqual(await progress("service_role", null), [], "sin sesión de cliente no devuelve nada (igual que antes)")
    const anon = await as(db, "anon", null, () => db.query("select * from public.customer_order_payment_progress(array[18]::bigint[])").then(() => "ok", (error: Error) => error.message))
    assert.match(String(anon), /permission denied/)
    const privileges = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('anon', 'public.customer_order_payment_progress(bigint[])', 'EXECUTE') anon,
      has_function_privilege('authenticated', 'public.customer_order_payment_progress(bigint[])', 'EXECUTE') authenticated,
      has_function_privilege('service_role', 'public.customer_order_payment_progress(bigint[])', 'EXECUTE') service_role,
      has_function_privilege('authenticated', 'public.signal_customer_order_change()', 'EXECUTE') trigger_fn`)).rows[0]
    assert.deepEqual(privileges, { anon: false, authenticated: true, service_role: true, trigger_fn: false })
  } finally {
    await db.close()
  }
})

test("políticas: una sola SELECT permisiva por tabla (sin OR que reabra el acceso); las demás políticas existentes intactas", async () => {
  const db = await setup()
  try {
    const policies = (await db.query<{ t: string; name: string; cmd: string; permissive: string; roles: string }>(
      "select tablename t, policyname name, cmd, permissive, roles::text roles from pg_policies where tablename in ('reviews', 'customer_notifications', 'customer_order_signals') order by 1, 2")).rows
    assert.deepEqual(policies.map((row) => [row.t, row.name, row.cmd]), [
      ["customer_notifications", "Customers can mark own notifications as read", "UPDATE"],
      ["customer_notifications", "Customers can read own notifications", "SELECT"],
      ["customer_order_signals", "customer_order_signals_select_own", "SELECT"],
      ["reviews", "Public can read approved reviews", "SELECT"],
    ])
    assert.ok(policies.every((row) => row.permissive === "PERMISSIVE"))
    // Marcar como leído sigue funcionando para avisos reales.
    const updated = await as(db, "authenticated", OWNER, async () =>
      (await db.query("update public.customer_notifications set is_read = true where order_id = 18 returning id")).rows.length)
    assert.equal(updated, 1)
  } finally {
    await db.close()
  }
})
