import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  getAdminNewOrderEventAt,
  getAdminNewOrderEventKey,
  isAdminOrderVisible,
} from "./admin-order-visibility.ts"
import { processApprovedMercadoPagoOrderPayment } from "../mercadopago/order-payment.ts"

const pendingMercadoPagoOrder = {
  id: 31,
  created_at: "2026-08-15T12:00:00.000Z",
  admin_visible_at: null,
}

const approvedMercadoPagoOrder = {
  ...pendingMercadoPagoOrder,
  admin_visible_at: "2026-08-15T12:08:00.000Z",
}

test("un intento pendiente de Mercado Pago no entra al flujo de pedido nuevo", () => {
  assert.equal(isAdminOrderVisible(pendingMercadoPagoOrder), false)
  assert.equal(getAdminNewOrderEventAt(pendingMercadoPagoOrder), null)
})

test("un pago aprobado entra al flujo con la fecha real de confirmación", () => {
  assert.equal(isAdminOrderVisible(approvedMercadoPagoOrder), true)
  assert.equal(
    getAdminNewOrderEventAt(approvedMercadoPagoOrder),
    "2026-08-15T12:08:00.000Z",
  )
})

test("un webhook repetido conserva una única identidad de notificación", () => {
  const firstEvent = {
    key: getAdminNewOrderEventKey(approvedMercadoPagoOrder.id),
    at: getAdminNewOrderEventAt(approvedMercadoPagoOrder),
  }
  const repeatedEvent = {
    key: getAdminNewOrderEventKey(approvedMercadoPagoOrder.id),
    at: getAdminNewOrderEventAt(approvedMercadoPagoOrder),
  }

  assert.deepEqual(repeatedEvent, firstEvent)
  assert.equal(new Set([firstEvent.key, repeatedEvent.key]).size, 1)
})

test("un pago aprobado tardío vuelve visible una orden auto-expirada una única vez", async () => {
  const expiredOrder = {
    estado: "cancelado",
    financial_status: "cancelled",
    total: 15_000,
    external_amount_due: 15_000,
    admin_visible_at: null as string | null,
  }
  const confirmedAt = "2026-08-15T13:30:00.000Z"
  let persistedUpdates = 0

  const confirmPayment = async (confirmedAmount: number) => {
    persistedUpdates += 1
    expiredOrder.estado = "pagado"
    expiredOrder.financial_status = "payment_confirmed"
    expiredOrder.admin_visible_at = confirmedAt
    return confirmedAmount > 0
  }

  const firstResult = await processApprovedMercadoPagoOrderPayment(
    expiredOrder,
    { status: "approved", currency_id: "ARS", transaction_amount: 15_000 },
    confirmPayment,
  )
  const repeatedResult = await processApprovedMercadoPagoOrderPayment(
    expiredOrder,
    { status: "approved", currency_id: "ARS", transaction_amount: 15_000 },
    confirmPayment,
  )

  assert.equal(firstResult.kind, "confirmed")
  assert.equal(repeatedResult.kind, "duplicate")
  assert.equal(persistedUpdates, 1)
  assert.equal(
    isAdminOrderVisible({ id: 99, admin_visible_at: expiredOrder.admin_visible_at }),
    true,
  )
  assert.equal(getAdminNewOrderEventAt({ id: 99, admin_visible_at: expiredOrder.admin_visible_at }), confirmedAt)
})

test("rutas, webhook y base comparten la misma transición administrativa", () => {
  const createPreferenceSource = readFileSync(
    new URL(
      "../../app/api/mercadopago/create-preference/route.ts",
      import.meta.url,
    ),
    "utf8",
  )
  const webhookSource = readFileSync(
    new URL("../../app/api/mercadopago/webhook/route.ts", import.meta.url),
    "utf8",
  )
  const adminOrdersSource = readFileSync(
    new URL("../../app/api/admin/pedidos/route.ts", import.meta.url),
    "utf8",
  )
  const adminDashboardSource = readFileSync(
    new URL("../../app/api/admin/dashboard/route.ts", import.meta.url),
    "utf8",
  )
  const migrationSql = readFileSync(
    new URL(
      "../../supabase/migrations/20260815140000_mercadopago_admin_order_visibility.sql",
      import.meta.url,
    ),
    "utf8",
  )
  const transitionSql = readFileSync(
    new URL(
      "../../supabase/migrations/20260815150000_enforce_admin_order_visibility_transition.sql",
      import.meta.url,
    ),
    "utf8",
  )

  assert.match(createPreferenceSource, /admin_visible_at:\s*null/)
  assert.match(webhookSource, /admin_visible_at:\s*confirmedAt/)
  const duplicateGuardIndex = webhookSource.indexOf(
    "if (isMercadoPagoOrderAlreadyConfirmed(orderRow))",
  )
  const visibilityTransitionIndex = webhookSource.indexOf(
    "admin_visible_at: confirmedAt",
  )
  assert.notEqual(duplicateGuardIndex, -1)
  assert.notEqual(visibilityTransitionIndex, -1)
  assert.ok(
    duplicateGuardIndex < visibilityTransitionIndex,
    "El webhook duplicado debe salir antes de volver a publicar el pedido.",
  )
  assert.match(
    adminOrdersSource,
    /\.not\("admin_visible_at",\s*"is",\s*null\)/,
  )
  assert.match(
    adminDashboardSource,
    /"ordenes_total_count"[\s\S]*?\.not\("admin_visible_at",\s*"is",\s*null\)/,
  )
  assert.match(
    migrationSql,
    /add column if not exists admin_visible_at timestamptz/,
  )
  assert.match(
    migrationSql,
    /constraint ordenes_admin_visibility_payment_check/,
  )
  assert.match(
    migrationSql,
    /create index if not exists ordenes_admin_visible_at_idx/,
  )
  assert.match(
    transitionSql,
    /create or replace function public\.set_order_admin_visibility\(\)/,
  )
  assert.match(
    transitionSql,
    /create trigger set_order_admin_visibility[\s\S]*?before insert or update/,
  )
  assert.match(
    transitionSql,
    /else\s+new\.admin_visible_at := null;/,
  )
})
