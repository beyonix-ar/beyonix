import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getAdminNewOrderEventAt,
  getAdminNewOrderEventKey,
  getTransferPaymentConfirmedAt,
  isAdminOrderVisible,
  type AdminOrderVisibilityRow,
} from "./admin-order-visibility.ts"

// "Pedido nuevo" = el pedido ya está confirmado y entra al circuito
// operativo. Antes, una transferencia recién creada ya lo disparaba: el
// trigger set_order_admin_visibility le fija admin_visible_at = created_at a
// todo medio que no sea Mercado Pago, y el evento se derivaba sólo de
// admin_visible_at.

function readSource(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n")
}

const CREATED_AT = "2026-09-23T10:00:00.000Z"
const CONFIRMED_AT = "2026-09-23T11:30:00.000Z"

/** Transferencia tal como la deja el INSERT + trigger (visible desde que se crea). */
function transferOrder(overrides: Partial<AdminOrderVisibilityRow> = {}): AdminOrderVisibilityRow {
  return {
    id: 501,
    created_at: CREATED_AT,
    admin_visible_at: CREATED_AT,
    payment_method_id: "transferencia",
    payment_status: "pendiente_comprobante",
    payment_confirmed_at: null,
    ...overrides,
  }
}

/** Mismo criterio que isOrderNewerThanLastSeen (lib/admin/order-notifications.ts). */
function isNewerThanLastSeen(eventAt: string | null, lastSeenAt: string | null) {
  if (!eventAt) return false
  if (!lastSeenAt) return true
  return new Date(eventAt).getTime() > new Date(lastSeenAt).getTime()
}

test("1. transferencia recién creada: visible en el Admin (para revisarla) pero NO es 'Pedido nuevo'", () => {
  const order = transferOrder()
  assert.equal(isAdminOrderVisible(order), true)
  assert.equal(getAdminNewOrderEventAt(order), null)
})

test("2. comprobante cargado y pendiente de validación: todavía no notifica", () => {
  const order = transferOrder({ payment_status: "en_revision" })
  assert.equal(getAdminNewOrderEventAt(order), null)
})

test("3. validación automática aprobada: notifica con la fecha real de confirmación", () => {
  // confirm_transfer_auto_verification: payment_status='confirmado',
  // financial_status='payment_confirmed', payment_confirmed_at=now().
  const order = transferOrder({ payment_status: "confirmado", payment_confirmed_at: CONFIRMED_AT })
  assert.equal(getAdminNewOrderEventAt(order), CONFIRMED_AT)
  assert.equal(getAdminNewOrderEventKey(order.id), "order:501")
})

test("4. validación manual aprobada: mismo criterio, misma única notificación", () => {
  // review_manual_transfer_payment con p_next_status='confirmado'.
  const order = transferOrder({ payment_status: "confirmado", payment_confirmed_at: CONFIRMED_AT })
  assert.equal(getAdminNewOrderEventAt(order), CONFIRMED_AT)
})

test("5-6. rechazada, conflicto de stock o pago sin confirmar: no notifica", () => {
  for (const overrides of [
    { payment_status: "rechazado", payment_confirmed_at: null },
    { payment_status: "rechazado", payment_confirmed_at: CONFIRMED_AT },
    { payment_status: "auto_verified_stock_conflict", payment_confirmed_at: null },
    { payment_status: "pending", payment_confirmed_at: null },
    { payment_status: "vencido_falta_comprobante", payment_confirmed_at: null },
  ] satisfies Array<Partial<AdminOrderVisibilityRow>>) {
    assert.equal(getAdminNewOrderEventAt(transferOrder(overrides)), null, JSON.stringify(overrides))
  }
})

test("6-7. reprocesar la validación o refrescar el Admin nunca duplica la notificación", () => {
  const confirmed = transferOrder({ payment_status: "confirmado", payment_confirmed_at: CONFIRMED_AT })
  const first = { key: getAdminNewOrderEventKey(confirmed.id), at: getAdminNewOrderEventAt(confirmed) }
  const refreshed = { key: getAdminNewOrderEventKey(confirmed.id), at: getAdminNewOrderEventAt({ ...confirmed }) }
  assert.deepEqual(refreshed, first)

  // Antes de confirmar el admin ya "vio" el pedido (lo abrió para revisar el
  // comprobante): igual recibe UNA notificación al confirmarse...
  const seenBeforeConfirmation = "2026-09-23T10:30:00.000Z"
  assert.equal(isNewerThanLastSeen(first.at, seenBeforeConfirmation), true)
  // ...y una vez marcada como vista, no vuelve a aparecer.
  assert.equal(isNewerThanLastSeen(first.at, "2026-09-23T11:31:00.000Z"), false)

  // La fecha es fija: la RPC automática no reconfirma un pago ya resuelto y
  // la manual bloquea las órdenes ya confirmadas.
  const autoRpc = readSource(
    "../../supabase/migrations/20260914090000_transfer_auto_verification_amount_lock_and_stock_claim.sql",
  )
  assert.match(
    autoRpc,
    /if coalesce\(v_order\.payment_status, ''\) not in \('pendiente_comprobante', 'en_revision'\) then\s*raise exception 'ALREADY_RESOLVED/,
  )
  const manualRpc = readSource("../../supabase/migrations/20260923120000_atomic_manual_transfer_review.sql")
  assert.match(manualRpc, /if v_order\.payment_status = 'confirmado' or v_order\.financial_status = 'payment_confirmed'/)
  assert.match(manualRpc, /payment_confirmed_at = case when p_next_status = 'confirmado' then now\(\) else null end/)
})

test("8-9. Mercado Pago no cambia: aprobado notifica con admin_visible_at, pendiente no notifica", () => {
  const approved: AdminOrderVisibilityRow = {
    id: 31,
    created_at: CREATED_AT,
    admin_visible_at: "2026-09-23T10:08:00.000Z",
    payment_method_id: "mercadopago",
    payment_status: "approved",
    payment_confirmed_at: "2026-09-23T10:08:00.000Z",
  }
  assert.equal(getAdminNewOrderEventAt(approved), "2026-09-23T10:08:00.000Z")
  assert.equal(
    getAdminNewOrderEventAt({ ...approved, admin_visible_at: null, payment_status: "preference_created" }),
    null,
  )
  // Saldo a favor u otros medios confirmados al crearse: siguen igual.
  assert.equal(
    getAdminNewOrderEventAt({ id: 7, admin_visible_at: CREATED_AT, payment_method_id: "customer_credit" }),
    CREATED_AT,
  )
})

test("10. visibilidad en el Admin y estado financiero siguen consistentes", () => {
  // La transferencia pendiente sigue visible (lista, comprobantes): sólo
  // cambia cuándo es "Pedido nuevo". admin_visible_at no se toca.
  for (const status of ["pendiente_comprobante", "en_revision", "confirmado", "rechazado"]) {
    assert.equal(isAdminOrderVisible(transferOrder({ payment_status: status })), true)
  }
  assert.equal(getTransferPaymentConfirmedAt(transferOrder({ payment_confirmed_at: CONFIRMED_AT, payment_status: "confirmado" })), CONFIRMED_AT)
  assert.equal(getTransferPaymentConfirmedAt({ ...transferOrder(), payment_method_id: "mercadopago", payment_confirmed_at: CONFIRMED_AT }), null)

  // Todas las superficies ("Pedido nuevo" de la campana, contador y badges
  // del listado/detalle) derivan del MISMO helper, y las consultas traen los
  // campos que necesita.
  const bell = readSource("../admin/admin-notifications.ts")
  const counter = readSource("../admin/order-notifications.ts")
  const adminOrders = readSource("../../app/admin/sections/pedidos/admin-pedidos.tsx")
  const adminApi = readSource("../../app/api/admin/pedidos/route.ts")
  for (const source of [bell, counter, adminOrders]) {
    assert.match(source, /getAdminNewOrderEventAt\(/)
  }
  assert.match(bell, /const eventKey = getAdminNewOrderEventKey\(orderId\)/)
  assert.match(counter, /payment_method_id[^"]*payment_confirmed_at|payment_confirmed_at[^"]*payment_method_id/)
  const notificationColumns = adminApi.slice(adminApi.indexOf("const notificationColumns = ["), adminApi.indexOf('].join(", ")'))
  assert.match(notificationColumns, /"payment_method_id"/)
  assert.match(notificationColumns, /"payment_confirmed_at"/)
  assert.match(notificationColumns, /"payment_status"/)
})
