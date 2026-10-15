import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { PGlite } from "@electric-sql/pglite"

import {
  buildOrderAlertNotifications,
  buildPaymentIncidentNotifications,
  dedupeNotifications,
  isAdminActionNotification,
} from "../admin/admin-notification-rules.ts"
import { getCancellationProgress } from "../admin/order-operational-progress.ts"
import { getAdminPendingOrderActions } from "./admin-pending-actions.ts"
import { isAdminOrderVisible } from "./admin-order-visibility.ts"
import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"
import { getCreditNoteObligation } from "./credit-note-obligation.ts"
import { getLastLegacyCreditNoteRejection, getLegacyCreditNoteState } from "./legacy-credit-note.ts"
import { isAbandonedCheckoutAttempt, isCustomerOrderVisible, parseAdminArchiveFilter } from "./order-visibility.ts"

// Réplica (sin datos personales) de los 5 pedidos reales de prueba al 2026-10-15.
const abandonedAttempt = {
  id: 1, estado: "cancelado", payment_method_id: "mercadopago", payment_status: "checkout_superseded",
  financial_status: "cancelled", admin_visible_at: null, total: 1000, order_claims: [],
}
const bx1002 = {
  id: 2, created_at: "2026-10-13T22:29:00Z", estado: "cancelado", payment_method_id: "mercadopago",
  payment_status: "refunded", financial_status: "refunded", admin_visible_at: "2026-10-13T22:30:30Z",
  paid_at: "2026-10-13T22:30:30Z", payment_confirmed_amount: 1000, total: 1000,
  invoice_status: "authorized", invoice_cae: "86417596112941", invoice_point: 1, invoice_number: 8,
  credit_note_required: true, refunded_at: "2026-10-13T22:42:31Z", cancelled_at: "2026-10-13T22:40:00Z",
  order_credit_notes: [] as Array<{ status: string; total_amount: number; destination?: string; settlement_status?: string }>,
  mercadopago_order_refunds: [{ status: "confirmed" }],
  order_audit_events: [
    { id: 11, action: "mp_external_refund_detected", created_at: "2026-10-13T22:42:32Z", metadata: { paymentId: 182996233611 } },
  ] as Array<{ id: number; action: string; created_at: string; metadata: Record<string, unknown>; audit_resolution?: { resolution: string } | null }>,
  order_claims: [],
}
const bx1004 = {
  ...bx1002, id: 4, invoice_cae: "86417601175734", invoice_number: 9, credit_note_required: false,
  order_credit_notes: [{ status: "authorized", total_amount: 1000, destination: "external_refund", settlement_status: "pendiente" }],
  order_audit_events: [
    { id: 21, action: "mp_external_refund_detected", created_at: "2026-10-14T03:40:00Z", metadata: { paymentId: 183036116203 } },
  ],
}
const paidActive = {
  id: 5, estado: "pagado", payment_method_id: "mercadopago", payment_status: "approved", financial_status: "payment_confirmed",
  admin_visible_at: "2026-10-14T23:05:23Z", paid_at: "2026-10-14T23:05:23Z", total: 1000,
  invoice_status: "authorized", invoice_cae: "86417747630716", order_claims: [],
}

test("1 · un pago real cancelado y reintegrado sigue visible en Admin y para el cliente", () => {
  for (const order of [bx1002, bx1004]) {
    assert.equal(isAdminOrderVisible(order), true, `BX-${1000 + order.id} en Admin`)
    assert.equal(isCustomerOrderVisible(order), true, `BX-${1000 + order.id} en Cliente`)
    assert.equal(isAbandonedCheckoutAttempt(order), false)
  }
})

test("2 · un pedido histórico correcto (pagado, en curso o entregado) siempre es visible para el cliente", () => {
  assert.equal(isCustomerOrderVisible(paidActive), true)
  assert.equal(isCustomerOrderVisible({ ...paidActive, estado: "entregado" }), true)
  // Transferencia pendiente o vencida: el cliente la sigue viendo (puede haber transferido).
  assert.equal(isCustomerOrderVisible({ id: 9, estado: "pendiente", payment_method_id: "transferencia", payment_status: "pendiente_comprobante" }), true)
  assert.equal(isCustomerOrderVisible({ id: 9, estado: "cancelado", payment_method_id: "transferencia", payment_status: "vencido_falta_comprobante" }), true)
})

test("3 · un intento de checkout sin actividad (cancelado, sin pago ni rastro) no aparece en ningún lado", () => {
  assert.equal(isAbandonedCheckoutAttempt(abandonedAttempt), true)
  assert.equal(isCustomerOrderVisible(abandonedAttempt), false)
  assert.equal(isAdminOrderVisible(abandonedAttempt), false)
  // Nunca se infiere "prueba" por monto: un intento con cualquier rastro sigue visible.
  for (const trace of [
    { paid_at: "2026-10-13T22:30:00Z" }, { payment_status: "approved_after_cancellation" }, { invoice_cae: "1" },
    { refunded_at: "2026-10-13T22:30:00Z" }, { credit_balance_used: 50 }, { order_claims: [{ id: 1 }] },
    { payment_proof_uploaded_at: "2026-10-13T22:30:00Z" },
  ]) {
    assert.equal(isCustomerOrderVisible({ ...abandonedAttempt, total: 1, ...trace }), true, JSON.stringify(trace))
  }
  // Un MP pendiente (todavía se puede pagar) tampoco se oculta.
  assert.equal(isCustomerOrderVisible({ ...abandonedAttempt, estado: "pendiente", payment_status: "pending" }), true)
  // Oculto explícitamente por un super_admin al archivar una prueba interna.
  assert.equal(isCustomerOrderVisible({ ...paidActive, customer_hidden_at: "2026-10-15T12:00:00Z" }), false)
})

test("4 · con NC autorizada por el total no se vuelve a ofrecer la emisión (BX-1004 y BX-1002 ya emitida)", () => {
  assert.equal(getCreditNoteObligation(bx1004).status, "covered")
  assert.equal(getLegacyCreditNoteState(bx1004), "none")
  const issued = { ...bx1002, order_credit_notes: [{ status: "authorized", total_amount: 1000 }] }
  assert.equal(getLegacyCreditNoteState(issued), "none")
  assert.ok(!getAdminPendingOrderActions(issued).some((action) => action.kind === "legacy_credit_note"))
  assert.ok(getCancellationProgress(issued).every((step) => step.complete))
  // Lectura parcial sin importes: una NC autorizada nunca habilita otra emisión.
  assert.equal(getLegacyCreditNoteState({ ...bx1002, order_credit_notes: [{ status: "authorized" }] }), "none")
})

test("5 · NC faltante o insuficiente sigue pendiente; la insuficiente nunca ofrece otra emisión automática", () => {
  assert.equal(getCreditNoteObligation(bx1002).status, "missing")
  assert.equal(getLegacyCreditNoteState(bx1002), "pending")
  const partial = { ...bx1002, order_credit_notes: [{ status: "authorized", total_amount: 400 }] }
  const obligation = getCreditNoteObligation(partial)
  assert.deepEqual([obligation.status, obligation.missingAmount], ["insufficient", 600])
  assert.equal(getLegacyCreditNoteState(partial), "manual_review")
  const action = getAdminPendingOrderActions(partial).find((item) => item.kind === "legacy_credit_note")
  assert.equal(action?.label, "Revisar nota de crédito")
  // Una NC en proceso no se duplica.
  assert.equal(getLegacyCreditNoteState({ ...bx1002, order_credit_notes: [{ status: "processing", total_amount: 1000 }] }), "processing")
})

test("12 · BX-1002: nunca 'NC completada' y 'NC pendiente' a la vez (progreso, panel, NC heredada y tareas)", () => {
  const progress = getCancellationProgress(bx1002)
  const creditStep = progress.find((step) => step.label.startsWith("Nota de crédito"))
  assert.deepEqual(creditStep, { label: "Nota de crédito pendiente", complete: false })
  const panel = getCancellationPanelViewModel(bx1002)
  assert.equal(panel.isFinished, true, "el reintegro sí terminó")
  assert.equal(panel.creditNotePendingAfterRefund, true)
  assert.equal(panel.badgeTone, "warning", "no puede mostrarse en verde como completado")
  assert.equal(panel.steps.find((step) => step.key === "credit_note")?.status, "attention")
  assert.match(panel.helperText, /falta la nota de crédito/)
  assert.equal(getLegacyCreditNoteState(bx1002), "pending")
  assert.ok(getAdminPendingOrderActions(bx1002).some((action) => action.kind === "legacy_credit_note"))

  // BX-1004 (NC autorizada): todo coincide en "cubierta".
  const panel4 = getCancellationPanelViewModel(bx1004)
  assert.equal(panel4.creditNotePendingAfterRefund, false)
  assert.notEqual(panel4.steps.find((step) => step.key === "credit_note")?.status, "attention")
  assert.equal(getCancellationProgress(bx1004).find((step) => step.label.startsWith("Nota de crédito"))?.complete, true)

  // Cliente y Admin ven el mismo universo: nada visible en Admin queda oculto
  // al cliente (salvo ocultamiento explícito) y nada oculto al cliente queda
  // operativo en Admin.
  for (const order of [abandonedAttempt, bx1002, bx1004, paidActive]) {
    if (isAdminOrderVisible(order)) assert.equal(isCustomerOrderVisible(order), true, `BX-${1000 + order.id}`)
    if (!isCustomerOrderVisible(order)) assert.equal(isAdminOrderVisible(order), false, `BX-${1000 + order.id}`)
  }
})

test("rechazos de la NC heredada: se muestra el último, y un intento reservado posterior lo deja atrás", () => {
  const rejected = { action: "legacy_credit_note_rejected", created_at: "2026-10-15T10:00:00Z", metadata: { message: "Otro ambiente de ARCA." } }
  assert.deepEqual(getLastLegacyCreditNoteRejection([rejected]), { at: rejected.created_at, message: "Otro ambiente de ARCA." })
  assert.equal(getLastLegacyCreditNoteRejection([rejected, { action: "legacy_credit_note_requested" }]), null)
  assert.equal(getLastLegacyCreditNoteRejection([]), null)
})

test("contratos: la NC heredada audita cada rechazo y el listado del cliente aplica la regla de visibilidad", () => {
  const legacyRoute = readFileSync("app/api/admin/orders/[id]/legacy-credit-note/route.ts", "utf8")
  for (const code of ["ARCA_CONFIGURATION", "ARCA_ENVIRONMENT_MISMATCH", "AMOUNT_UNAVAILABLE", "RESERVATION_FAILED"]) {
    assert.match(legacyRoute, new RegExp(`"${code}"`), code)
  }
  assert.match(legacyRoute, /action: LEGACY_CREDIT_NOTE_REJECTED_ACTION/)
  assert.match(legacyRoute, /state === "manual_review"/)
  const customerList = readFileSync("app/api/orders/route.ts", "utf8")
  assert.match(customerList, /if \(isCustomerOrderVisible\(order\)\) merged\.set\(order\.id, order\)/)
  const customerDetail = readFileSync("app/api/orders/[id]/route.ts", "utf8")
  assert.match(customerDetail, /!order \|\| order\.customer_hidden_at/)
})

test("6/7 · campana: un incidente abierto suma +1 con 'Revisar'; resuelto o falso positivo baja", () => {
  const open = buildPaymentIncidentNotifications(bx1002)
  assert.equal(open.length, 1)
  assert.equal(open[0].kind, "action")
  assert.ok(isAdminActionNotification(open[0]))
  assert.equal(open[0].actionLabel, "Revisar")
  assert.equal(open[0].actionUrl, "/admin/pedidos/2?tab=pago")
  assert.match(open[0].body, /#BX-1002/)
  assert.equal(open[0].eventKey, "payment_incident:11")

  const resolved = {
    ...bx1002,
    order_audit_events: bx1002.order_audit_events.map((event) => ({ ...event, audit_resolution: { resolution: "false_positive" } })),
  }
  assert.equal(buildPaymentIncidentNotifications(resolved).length, 0)

  // La NC faltante también es una alerta accionable que lleva a Cancelación.
  const alerts = buildOrderAlertNotifications(bx1002)
  assert.deepEqual(alerts.map((alert: ReturnType<typeof buildOrderAlertNotifications>[number]) => [alert.eventKey, alert.actionUrl, alert.kind]), [
    ["legacy_credit_note:2", "/admin/pedidos/2?tab=cancelacion", "action"],
  ])
  assert.equal(buildOrderAlertNotifications({ ...bx1002, order_credit_notes: [{ status: "authorized", total_amount: 1000 }] }).length, 0)
  // Un pedido pagado sin problemas no genera alertas de este tipo.
  assert.equal(buildPaymentIncidentNotifications(paidActive).length + buildOrderAlertNotifications(paidActive).length, 0)
})

test("8 · webhook repetido / refresh: no duplica la alerta", () => {
  const duplicated = {
    ...bx1002,
    order_audit_events: [
      ...bx1002.order_audit_events,
      { id: 12, action: "mp_external_refund_detected", created_at: "2026-10-13T22:43:00Z", metadata: { paymentId: 182996233611 } },
    ],
  }
  assert.equal(buildPaymentIncidentNotifications(duplicated).length, 1, "mismo tipo y mismo pago = una alerta")
  const twice = [...buildPaymentIncidentNotifications(bx1002), ...buildPaymentIncidentNotifications(bx1002)]
  assert.equal(dedupeNotifications(twice).length, 1, "releer el mismo pedido no duplica")

  // El webhook sólo registra la reversa una vez: el UPDATE condicional
  // (payment_status distinto) es el que habilita a auditar el incidente.
  const webhook = readFileSync("app/api/mercadopago/webhook/route.ts", "utf8")
  assert.match(webhook, /\.neq\("payment_status", payment\.status\)[\s\S]{0,400}else if \(reversalUpdated\)/)
})

test("11 · filtro de archivados del listado Admin", () => {
  assert.equal(parseAdminArchiveFilter(null), "active")
  assert.equal(parseAdminArchiveFilter("archived"), "archived")
  assert.equal(parseAdminArchiveFilter("all"), "all")
  assert.equal(parseAdminArchiveFilter("borrados"), null)
  const route = readFileSync("app/api/admin/pedidos/route.ts", "utf8")
  assert.match(route, /archiveFilter === "active"\) ordersQuery = ordersQuery\.is\("archived_at", null\)/)
  assert.match(route, /archiveFilter === "archived"\) ordersQuery = ordersQuery\.not\("archived_at", "is", null\)/)
})

const MIGRATION = readFileSync("supabase/migrations/20261015150000_order_test_archive.sql", "utf8")
const SUPER = "10000000-0000-4000-8000-000000000001"
const ADMIN = "10000000-0000-4000-8000-000000000002"

async function setupDb() {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('test.role', true) $$;
    create table profiles (id uuid primary key, rol text);
    create table ordenes (
      id bigint primary key, estado text, payment_method_id text, payment_status text, financial_status text,
      admin_visible_at timestamptz, paid_at timestamptz, payment_confirmed_at timestamptz, payment_confirmed_amount numeric,
      payment_proof_uploaded_at timestamptz, total numeric, invoice_status text, invoice_cae text,
      credit_note_required boolean default false, refund_pending_at timestamptz, refunded_at timestamptz,
      credit_balance_used numeric default 0, andreani_envio_id text, tracking_number text
    );
    create table orden_items (id bigserial primary key, orden_id bigint references ordenes(id) on delete cascade);
    create table order_credit_notes (id bigserial primary key, order_id bigint, status text, total_amount numeric);
    create table mercadopago_order_refunds (id bigserial primary key, order_id bigint, status text);
    create table customer_credit_movements (id bigserial primary key, order_id bigint);
    create table order_claims (id bigserial primary key, order_id bigint, status text);
    create table order_audit_events (
      id bigserial primary key, order_id bigint not null, actor_type text not null, actor_id uuid,
      action text not null, previous_status text, new_status text, metadata jsonb, created_at timestamptz not null default now()
    );
    create table order_audit_incident_resolutions (audit_event_id bigint primary key, resolution text, note text, resolved_by uuid);
    select set_config('test.role', 'service_role', false);
  `)
  await db.query("insert into profiles values ($1,'super_admin'),($2,'admin')", [SUPER, ADMIN])
  await db.exec(`
    insert into ordenes (id, estado, payment_method_id, payment_status, financial_status, admin_visible_at, paid_at, payment_confirmed_amount, total, invoice_status, invoice_cae, credit_note_required, refunded_at) values
      (1, 'cancelado', 'mercadopago', 'checkout_superseded', 'cancelled', null, null, null, 1000, null, null, false, null),
      (2, 'cancelado', 'mercadopago', 'refunded', 'refunded', now(), now(), 1000, 1000, 'authorized', 'CAE2', true, now()),
      (4, 'cancelado', 'mercadopago', 'refunded', 'refunded', now(), now(), 1000, 1000, 'authorized', 'CAE4', false, now()),
      (5, 'pagado', 'mercadopago', 'approved', 'payment_confirmed', now(), now(), 1000, 1000, 'authorized', 'CAE5', false, null),
      (7, 'cancelado', 'mercadopago', 'refunded', 'refunded', now(), now(), 1000, 1000, 'authorized', 'CAE7', false, now());
    insert into orden_items (orden_id) values (1), (2), (4), (5), (7);
    insert into order_credit_notes (order_id, status, total_amount) values (4, 'authorized', 1000), (7, 'authorized', 1000);
    insert into mercadopago_order_refunds (order_id, status) values (2, 'confirmed'), (4, 'confirmed'), (7, 'confirmed');
    insert into order_audit_events (order_id, actor_type, action, metadata) values
      (2, 'system', 'mp_external_refund_detected', '{"paymentId":2}'),
      (4, 'system', 'mp_external_refund_detected', '{"paymentId":4}'),
      (7, 'system', 'mp_external_refund_detected', '{"paymentId":7}');
    insert into order_audit_incident_resolutions values (3, 'false_positive', 'Reintegro propio', '${SUPER}');
  `)
  await db.exec(MIGRATION)
  return db
}

const blockersOf = async (db: PGlite, id: number) =>
  (await db.query<{ b: string[] }>("select order_archive_blockers($1) b", [id])).rows[0].b
const archive = (db: PGlite, id: number, actor = SUPER, reason = "Pedido de prueba interna", hide = false) =>
  db.query("select archive_order_admin($1,$2,$3,$4)", [id, actor, reason, hide])
const operationalIds = async (db: PGlite, filter: "active" | "archived" | "cancelled") => {
  const where = filter === "archived"
    ? "archived_at is not null"
    : filter === "cancelled" ? "archived_at is null and estado = 'cancelado'" : "archived_at is null"
  return (await db.query<{ id: string }>(`select id from ordenes where admin_visible_at is not null and ${where} order by id`)).rows.map((row) => Number(row.id))
}

test("9 · archivar saca el pedido de la operación, conserva todo y deja auditoría; sólo super_admin y con motivo", async () => {
  const db = await setupDb()
  try {
    // Bloqueos reales: BX-1002 (NC faltante + incidente), BX-1004 (incidente), BX-1005 (activo).
    assert.deepEqual(await blockersOf(db, 2), ["credit_note_pending", "open_payment_incident"])
    assert.deepEqual(await blockersOf(db, 4), ["open_payment_incident"])
    assert.deepEqual(await blockersOf(db, 5), ["active_order"])
    assert.deepEqual(await blockersOf(db, 7), [])
    await assert.rejects(archive(db, 2), /ORDER_ARCHIVE_BLOCKED:credit_note_pending,open_payment_incident/)
    await assert.rejects(archive(db, 5), /ORDER_ARCHIVE_BLOCKED:active_order/)
    await assert.rejects(archive(db, 7, ADMIN), /ORDER_ARCHIVE_FORBIDDEN/)
    await assert.rejects(archive(db, 7, SUPER, "  "), /ORDER_ARCHIVE_REASON_REQUIRED/)

    const before = (await db.query("select total, invoice_cae, refunded_at, paid_at from ordenes where id=7")).rows[0]
    await archive(db, 7, SUPER, "Pedido de prueba interna", true)
    const after = (await db.query<Record<string, unknown>>("select total, invoice_cae, refunded_at, paid_at, archived_at, archive_reason, customer_hidden_at from ordenes where id=7")).rows[0]
    assert.deepEqual({ total: after.total, invoice_cae: after.invoice_cae, refunded_at: after.refunded_at, paid_at: after.paid_at }, before)
    assert.ok(after.archived_at && after.customer_hidden_at)
    assert.equal(after.archive_reason, "Pedido de prueba interna")
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from order_credit_notes where order_id=7")).rows[0].n), 1)
    const trail = (await db.query<{ action: string; actor_id: string; metadata: Record<string, unknown> }>("select action, actor_id, metadata from order_audit_events where order_id=7 and action='order_archived'")).rows
    assert.deepEqual(trail, [{ action: "order_archived", actor_id: SUPER, metadata: { reason: "Pedido de prueba interna", hideFromCustomer: true } }])
    await assert.rejects(archive(db, 7), /already_archived/)

    // Las columnas no se tocan por fuera de la RPC (ni siquiera un UPDATE de admin).
    await assert.rejects(db.exec("update ordenes set archived_at = null, archived_by = null, archive_reason = null, customer_hidden_at = null where id = 7"), /ORDER_ARCHIVE_COLUMNS_PROTECTED/)
    await assert.rejects(db.exec(`update ordenes set archived_at = now(), archived_by = '${SUPER}', archive_reason = 'atajo directo' where id = 5`), /ORDER_ARCHIVE_COLUMNS_PROTECTED/)
    // Otros cambios del pedido siguen funcionando.
    await db.exec("update ordenes set estado = estado where id = 7")

    // Restaurar exige super_admin y motivo, y también queda auditado.
    await assert.rejects(db.query("select unarchive_order_admin(7,$1,'Restaurar')", [ADMIN]), /ORDER_ARCHIVE_FORBIDDEN/)
    await db.query("select unarchive_order_admin(7,$1,'Se archivó por error')", [SUPER])
    assert.equal((await db.query<{ a: string | null }>("select archived_at a from ordenes where id=7")).rows[0].a, null)
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from order_audit_events where order_id=7 and action='order_unarchived'")).rows[0].n), 1)

    const privileges = (await db.query<Record<string, boolean>>(`select
      has_function_privilege('authenticated','archive_order_admin(bigint,uuid,text,boolean)','EXECUTE') a,
      has_function_privilege('anon','unarchive_order_admin(bigint,uuid,text)','EXECUTE') b,
      has_function_privilege('authenticated','order_archive_blockers(bigint)','EXECUTE') c`)).rows[0]
    assert.deepEqual(privileges, { a: false, b: false, c: false })
    await db.exec("select set_config('test.role', 'authenticated', false)")
    await assert.rejects(archive(db, 7), /FORBIDDEN/)
  } finally {
    await db.close()
  }
})

test("10 · un pedido con rastro fiscal o de dinero no puede eliminarse; un intento sin rastro sí", async () => {
  const db = await setupDb()
  try {
    for (const id of [2, 4, 5, 7]) {
      await assert.rejects(db.exec(`delete from ordenes where id = ${id}`), /ORDER_DELETE_BLOCKED/, `BX-${1000 + id}`)
    }
    assert.deepEqual((await db.query<{ b: string[] }>("select order_delete_blockers(4) b")).rows[0].b, ["payment", "invoice", "credit_note", "refund"])
    assert.deepEqual((await db.query<{ b: string[] }>("select order_delete_blockers(1) b")).rows[0].b, [])
    // Clasificación A: el intento abandonado (nunca pagado) se puede limpiar.
    await db.exec("delete from ordenes where id = 1")
    assert.equal(Number((await db.query<{ n: number }>("select count(*)::int n from ordenes")).rows[0].n), 4)
    // Un pendiente con saldo usado tampoco se borra (lo cancela el flujo existente).
    await db.exec("insert into ordenes (id, estado, payment_method_id, total, credit_balance_used) values (8, 'pendiente', 'mercadopago', 1000, 200)")
    await assert.rejects(db.exec("delete from ordenes where id = 8"), /ORDER_DELETE_BLOCKED:customer_credit/)
  } finally {
    await db.close()
  }
})

test("1/11 · filtros Todos / Cancelados / Archivados del listado coinciden con la base", async () => {
  const db = await setupDb()
  try {
    assert.deepEqual(await operationalIds(db, "active"), [2, 4, 5, 7], "el reintegrado con pago real sigue en Todos")
    assert.deepEqual(await operationalIds(db, "cancelled"), [2, 4, 7])
    assert.deepEqual(await operationalIds(db, "archived"), [])
    await archive(db, 7)
    assert.deepEqual(await operationalIds(db, "active"), [2, 4, 5])
    assert.deepEqual(await operationalIds(db, "cancelled"), [2, 4], "un archivado no aparece en Cancelados")
    assert.deepEqual(await operationalIds(db, "archived"), [7], "sólo en Archivados")
  } finally {
    await db.close()
  }
})
