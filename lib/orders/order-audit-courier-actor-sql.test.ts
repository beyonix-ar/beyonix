import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

// BX-1019 (producción, 2026-11-06): el cadete marcó Entregado desde el QR; el
// estado y la garantía se guardaron, pero historial, garantía y email quedaron
// "pendientes" porque order_audit_events rechazaba actor_type = 'courier'.
test("order_audit_events admite al cadete (courier) y sigue rechazando actores desconocidos", async () => {
  const db = new PGlite()
  try {
    // Tabla con el CHECK vigente antes de la migración (baseline de producción).
    await db.exec(`create table public.order_audit_events (
      id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid,
      action text not null, previous_status text, new_status text, metadata jsonb, created_at timestamptz default now(),
      constraint order_audit_events_actor_type_check check (actor_type = any (array['customer'::text, 'admin'::text, 'system'::text])));`)
    const insert = (actor: string) => db.query("insert into public.order_audit_events(order_id, actor_type, action) values (19, $1, 'order_status_changed')", [actor])
    await assert.rejects(insert("courier"), /order_audit_events_actor_type_check/, "antes: el cadete no podía registrar nada")

    await db.exec(readFileSync("supabase/migrations/20261106100000_order_audit_events_courier_actor.sql", "utf8"))
    for (const actor of ["customer", "admin", "system", "courier"]) await insert(actor)
    await assert.rejects(insert("cadete"), /order_audit_events_actor_type_check/)
    await assert.rejects(insert(""), /order_audit_events_actor_type_check/)
    const { rows } = await db.query<{ actor_type: string }>("select actor_type from public.order_audit_events order by id")
    assert.deepEqual(rows.map((row) => row.actor_type), ["customer", "admin", "system", "courier"])
    // Idempotente: aplicarla de nuevo no falla ni duplica el CHECK.
    await db.exec(readFileSync("supabase/migrations/20261106100000_order_audit_events_courier_actor.sql", "utf8"))
    const checks = await db.query<{ conname: string }>("select conname from pg_constraint where conrelid = 'public.order_audit_events'::regclass and contype = 'c'")
    assert.deepEqual(checks.rows.map((row) => row.conname), ["order_audit_events_actor_type_check"])
  } finally {
    await db.close()
  }
})
