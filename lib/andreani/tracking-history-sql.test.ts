import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// Migración real (PGlite) del cierre Andreani: historial idempotente y una
// notificación por hito logístico del pedido, sin duplicados.

const MIGRATION = "20261021110000_andreani_tracking_history_and_milestones"
const customer = "40000000-0000-4000-8000-000000000001"

const migration = readFileSync(new URL(`../../supabase/migrations/${MIGRATION}.sql`, import.meta.url), "utf8")

// Esquema mínimo: sólo las columnas que usan la migración y el trigger.
const SCHEMA = `
  create role anon; create role authenticated; create role service_role;
  create table public.ordenes (
    id bigint primary key,
    usuario_id uuid,
    estado text not null,
    payment_method_id text,
    payment_status text,
    payment_proof_url text,
    payment_proof_uploaded_at timestamptz,
    andreani_envio_id text
  );
  create table public.order_claim_shipments (id bigint primary key);
  create table public.customer_notifications (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null,
    type text not null,
    title text not null,
    body text not null,
    action_url text,
    order_id bigint,
    source_key text unique,
    is_read boolean not null default false,
    created_at timestamptz not null default now()
  );
`

async function setup() {
  const db = new PGlite()
  await db.exec(SCHEMA)
  await db.exec(migration)
  // El trigger existe en producción desde el baseline; la migración sólo reemplaza la función.
  await db.exec(`
    create trigger notify_customer_order_changes_trigger
    after insert or update of payment_status, estado, payment_proof_url, payment_proof_uploaded_at
    on public.ordenes for each row execute function public.notify_customer_order_changes();
  `)
  await db.query(
    "insert into ordenes(id, usuario_id, estado, payment_method_id, payment_status, andreani_envio_id) values (5, $1, 'pagado', 'mercadopago', 'approved', 'API-5')",
    [customer],
  )
  return db
}

async function notifications(db: PGlite) {
  const { rows } = await db.query<{ type: string; title: string; body: string; source_key: string }>(
    "select type, title, body, source_key from customer_notifications order by created_at, source_key",
  )
  return rows
}

test("un aviso por hito (admitido, en camino, en sucursal, entregado), sin duplicar si el hito se repite", async () => {
  const db = await setup()
  for (const estado of ["enviado", "en_camino", "en_sucursal", "entregado"]) {
    await db.query("update ordenes set estado = $1 where id = 5", [estado])
    // Mismo hito informado otra vez (cron, Admin o un vaivén manual): sin aviso nuevo.
    await db.query("update ordenes set estado = $1 where id = 5", [estado])
  }
  await db.query("update ordenes set estado = 'en_camino' where id = 5")
  await db.query("update ordenes set estado = 'entregado' where id = 5")

  const rows = await notifications(db)
  assert.deepEqual(rows.map((row) => row.source_key).sort(), [
    "order:5:at-branch", "order:5:delivered", "order:5:in-transit", "order:5:shipped",
  ])
  const byKey = new Map(rows.map((row) => [row.source_key, row]))
  assert.equal(byKey.get("order:5:shipped")?.title, "Andreani recibió tu paquete")
  assert.equal(byKey.get("order:5:in-transit")?.title, "Tu pedido está en camino")
  assert.equal(byKey.get("order:5:at-branch")?.title, "Tu pedido llegó a la sucursal")
  assert.equal(byKey.get("order:5:delivered")?.title, "Tu pedido fue entregado")
  for (const row of rows) {
    assert.match(row.body, /BX-1005/)
    assert.doesNotMatch(`${row.title} ${row.body}`, /Admision|EnvioDespachado|andreani_|en_sucursal/, "sin códigos técnicos")
  }
  await db.close()
})

test("saltear hitos (pagado -> en_camino) sólo avisa el alcanzado; despacho manual sin Andreani usa texto genérico", async () => {
  const db = await setup()
  await db.query("update ordenes set estado = 'en_camino' where id = 5")
  assert.deepEqual((await notifications(db)).map((row) => row.source_key), ["order:5:in-transit"])

  await db.query("insert into ordenes(id, usuario_id, estado) values (6, $1, 'pagado')", [customer])
  await db.query("update ordenes set estado = 'enviado' where id = 6")
  const manual = (await notifications(db)).find((row) => row.source_key === "order:6:shipped")
  assert.equal(manual?.title, "Pedido despachado")
  await db.close()
})

test("historial: dedupe_key único (ON CONFLICT DO NOTHING), transición coherente y lo no reconocido exige revisión", async () => {
  const db = await setup()
  const insert = (key: string) => db.query(
    `insert into andreani_tracking_events(order_id, tracking, event_code, event_at, recognized, review_required, dedupe_key, previous_status, new_status)
     values (5, '3600', 'Admision', now(), true, false, $1, 'pagado', 'enviado')
     on conflict (dedupe_key) do nothing returning id`,
    [key],
  )
  assert.equal((await insert("order:5:3600:Admision:2026-10-20T12:00:00")).rows.length, 1)
  assert.equal((await insert("order:5:3600:Admision:2026-10-20T12:00:00")).rows.length, 0, "el cron no duplica")

  await assert.rejects(db.query(
    "insert into andreani_tracking_events(order_id, tracking, event_code, recognized, review_required, dedupe_key, previous_status) values (5, '3600', 'X', true, false, 'k1', 'pagado')",
  ), /andreani_tracking_events_transition_check/)
  await assert.rejects(db.query(
    "insert into andreani_tracking_events(order_id, tracking, event_code, recognized, review_required, dedupe_key) values (5, '3600', 'EventoNuevo', false, false, 'k2')",
  ), /andreani_tracking_events_review_check/)
  await assert.rejects(db.query(
    "insert into andreani_tracking_events(order_id, source, tracking, event_code, recognized, dedupe_key) values (5, 'manual', '3600', 'X', true, 'k3')",
  ), /andreani_tracking_events_source_check/)

  const { rows } = await db.query<{ anon: boolean; authenticated: boolean; service: boolean }>(`
    select has_table_privilege('anon', 'andreani_tracking_events', 'select') as anon,
           has_table_privilege('authenticated', 'andreani_tracking_events', 'select') as authenticated,
           has_table_privilege('service_role', 'andreani_tracking_events', 'insert') as service`)
  assert.deepEqual(rows[0], { anon: false, authenticated: false, service: true }, "sólo el servidor lee/escribe el historial")
  await db.close()
})
