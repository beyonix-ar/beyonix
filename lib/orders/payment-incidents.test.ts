import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { getOpenPaymentIncidents } from "./payment-incidents.ts"

const refunded = {
  id: 2,
  estado: "cancelado",
  financial_status: "refunded",
  payment_method_id: "mercadopago",
  credit_note_required: false,
  invoice_status: "authorized",
  invoice_cae: "CAE",
  order_credit_notes: [],
  mercadopago_order_refunds: [{ status: "confirmed" }],
}

test("un incidente sin resolver es alerta; resuelto o falso positivo sigue en el historial pero no es tarea", () => {
  const open = { id: 9, action: "mp_external_refund_detected", created_at: "2026-10-13T22:42:32Z" }
  const resolved = { ...open, audit_resolution: { resolution: "false_positive", note: "Reintegro propio", resolved_at: "2026-10-15T12:00:00Z" } }
  const other = { id: 10, action: "payment_refunded_by_provider" }

  assert.equal(getOpenPaymentIncidents([open, other]).length, 1)
  assert.equal(getOpenPaymentIncidents([resolved, other]).length, 0)
  assert.ok(getAdminPendingOrderActions({ ...refunded, order_audit_events: [open] }).some((action) => action.kind === "payment_incident"))
  assert.ok(!getAdminPendingOrderActions({ ...refunded, order_audit_events: [resolved] }).some((action) => action.kind === "payment_incident"))
  assert.ok(!getAdminPendingOrderActions({ ...refunded, order_audit_events: [other] }).some((action) => action.kind === "payment_incident"))
})

test("la NC heredada aparece como tarea del Admin hasta que se emite", () => {
  const legacy = { ...refunded, credit_note_required: true, refunded_at: "2026-10-13T22:42:31Z", invoice_number: 8, invoice_point: 1 }
  const actions = getAdminPendingOrderActions(legacy)
  const action = actions.find((item) => item.kind === "legacy_credit_note")
  assert.equal(action?.label, "Emitir nota de crédito")
  assert.equal(action?.href, "/admin/pedidos/2?tab=cancelacion")
  assert.ok(!getAdminPendingOrderActions({ ...legacy, order_credit_notes: [{ status: "authorized" }] as never }).some((item) => item.kind === "legacy_credit_note"))
})

test("SQL real: resolver un incidente no toca el evento, es idempotente y sólo aplica a incidentes", async () => {
  const db = new PGlite()
  const admin = "10000000-0000-4000-8000-000000000003"
  const operator = "10000000-0000-4000-8000-000000000004"
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth;
      create function auth.role() returns text language sql as $$ select current_setting('test.role', true) $$;
      create table profiles (id uuid primary key, rol text);
      create table order_audit_events (
        id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid,
        action text not null, previous_status text, new_status text, metadata jsonb, created_at timestamptz not null default now()
      );
      select set_config('test.role', 'service_role', false);
    `)
    await db.query("insert into profiles values ($1,'admin'),($2,'operador')", [admin, operator])
    await db.exec(`insert into order_audit_events (order_id, actor_type, action, new_status, metadata) values
      (2,'system','mp_external_refund_detected','refunded','{"paymentId":182996233611,"reason":"refund_not_initiated_by_beyonix"}'),
      (4,'system','mp_external_refund_detected','refunded','{"paymentId":183036116203,"reason":"refund_not_initiated_by_beyonix"}'),
      (2,'system','payment_refunded_by_provider','refunded','{}')`)
    await db.exec(readFileSync("supabase/migrations/20261015110000_order_audit_incident_resolutions.sql", "utf8"))

    const resolve = (eventId: number, resolution: string, note: string, actor = admin) =>
      db.query<{ result: Record<string, unknown> }>("select resolve_order_audit_incident($1,$2,$3,$4) as result", [eventId, resolution, note, actor])
    const before = (await db.query("select * from order_audit_events where id=1")).rows[0]

    const first = (await resolve(1, "false_positive", "Reintegro hecho por BEYONIX; el aviso de MP llegó después")).rows[0].result
    assert.equal(first.resolution, "false_positive")
    assert.equal(first.already_resolved, false)
    // Doble click / reintento: devuelve la resolución existente, nunca la pisa.
    const second = (await resolve(1, "resolved", "Otro motivo")).rows[0].result
    assert.equal(second.resolution, "false_positive")
    assert.equal(second.already_resolved, true)

    // El evento original queda exactamente igual y el otro incidente sigue abierto.
    assert.deepEqual((await db.query("select * from order_audit_events where id=1")).rows[0], before)
    const resolutions = await db.query<{ audit_event_id: string }>("select audit_event_id from order_audit_incident_resolutions")
    assert.deepEqual(resolutions.rows.map((row) => Number(row.audit_event_id)), [1])
    const trail = await db.query<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from order_audit_events where action='audit_incident_resolved'")
    assert.equal(trail.rows.length, 1, "una sola constancia aunque se haya confirmado dos veces")
    assert.equal(trail.rows[0].metadata.auditEventId, 1)

    // Sólo incidentes, sólo Admin, con motivo.
    await assert.rejects(resolve(3, "false_positive", "No corresponde"), /NOT_A_PAYMENT_INCIDENT/)
    await assert.rejects(resolve(2, "false_positive", "Motivo", operator), /INCIDENT_RESOLUTION_FORBIDDEN/)
    await assert.rejects(resolve(2, "false_positive", "  "), /INCIDENT_RESOLUTION_NOTE_REQUIRED/)
    await assert.rejects(resolve(2, "borrar", "Motivo"), /INVALID_INCIDENT_RESOLUTION/)
    await assert.rejects(resolve(999, "resolved", "Motivo"), /INCIDENT_NOT_FOUND/)

    const privileges = (await db.query(`select
      has_function_privilege('authenticated','resolve_order_audit_incident(bigint,text,text,uuid)','EXECUTE') as rpc,
      has_table_privilege('authenticated','order_audit_incident_resolutions','SELECT') as tbl`)).rows[0]
    assert.deepEqual(privileges, { rpc: false, tbl: false })
  } finally {
    await db.close()
  }
})
