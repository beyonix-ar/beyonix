import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

function source(path: string) {
  return readFileSync(path, "utf8")
}

const MIGRATION = source(
  "supabase/migrations/20260915120000_admin_direct_order_cancellation.sql",
)
const ROUTE = source("app/api/admin/pedidos/[id]/cancel/route.ts")

test("3/4/13. la RPC lockea la fila (for update) antes de decidir -- dos requests simultáneos serializan, el segundo ve el estado ya cancelado", () => {
  assert.match(
    MIGRATION,
    /from public\.ordenes\s*where id = p_order_id\s*for update;/,
  )
  assert.match(MIGRATION, /if lower\(coalesce\(v_order\.estado, ''\)\) = 'cancelado' then\s*raise exception 'ORDER_ALREADY_CANCELLED';/)
})

test("3/12. doble cancelación / pedido ya cancelado o rechazado: la RPC rechaza explícitamente, nunca reprocesa", () => {
  const guardIndex = MIGRATION.indexOf("for update;")
  const afterLock = MIGRATION.slice(guardIndex)
  const cancelledGuardIndex = afterLock.indexOf("ORDER_ALREADY_CANCELLED")
  const updateIndex = afterLock.indexOf("update public.ordenes")

  assert.ok(cancelledGuardIndex > 0, "falta el guard de ya cancelado")
  assert.ok(updateIndex > cancelledGuardIndex, "el guard debe evaluarse antes del UPDATE")
})

test("5. nunca actualiza stock/productos directamente -- el stock se libera solo, vía estado='cancelado' (mismo mecanismo ya probado en approve_order_claim_cancellation)", () => {
  assert.doesNotMatch(MIGRATION, /update public\.(productos|producto_variantes|stock_reservations)/)
  assert.match(MIGRATION, /estado = 'cancelado'/)
})

test("6. pedido pagado NO genera un refund automático de Mercado Pago -- sólo deja financial_status en 'refund_pending', que sigue exigiendo el botón explícito de reembolso", () => {
  assert.doesNotMatch(MIGRATION, /mercadopago/i)
  assert.doesNotMatch(MIGRATION, /begin_mercadopago_order_refund/)
  assert.match(MIGRATION, /v_next_financial_status := case\s*when v_action = 'cancel' then 'refund_pending'/)
  assert.doesNotMatch(ROUTE, /mercadopago/i)
})

test("7. nunca toca transfer_matched_payment_id -- una transferencia ya claimeada no queda liberada para otra compra", () => {
  // Se acota al cuerpo de la función (desde la firma real), no al comentario
  // explicativo del encabezado del archivo, que sí menciona la columna a
  // propósito para documentar por qué nunca se toca.
  const functionBody = MIGRATION.slice(
    MIGRATION.indexOf("create or replace function public.admin_cancel_order"),
  )
  assert.doesNotMatch(functionBody, /transfer_matched_payment_id/)
  assert.doesNotMatch(functionBody, /transfer_verification_lease_id/)
})

test("8. pedido facturado: la RPC bloquea ANTES de cualquier UPDATE -- nunca se toca invoice_status/invoice_cae/invoice_number, la factura nunca se borra ni se reemite", () => {
  const invoiceGuardIndex = MIGRATION.indexOf("ORDER_ALREADY_INVOICED")
  const updateIndex = MIGRATION.indexOf("update public.ordenes")

  assert.ok(invoiceGuardIndex > 0)
  assert.ok(updateIndex > invoiceGuardIndex)
  // El único UPDATE de la función nunca escribe columnas de factura.
  const updateBlock = MIGRATION.slice(updateIndex, MIGRATION.indexOf("where id = v_order.id"))
  assert.doesNotMatch(updateBlock, /invoice_/)
  // credit_note_required siempre queda en false -- nunca dispara una NC automática.
  assert.match(updateBlock, /credit_note_required = false/)
})

test("9. pedido despachado (Andreani) no se cancela como compra estándar -- mismo guard de tracking/estado que ya usa approve_order_claim_cancellation", () => {
  assert.match(MIGRATION, /ORDER_ALREADY_DISPATCHED/)
  assert.match(MIGRATION, /nullif\(trim\(v_order\.tracking_number\), ''\) is not null/)
  assert.match(MIGRATION, /nullif\(trim\(v_order\.andreani_tracking\), ''\) is not null/)
  assert.match(MIGRATION, /nullif\(trim\(v_order\.andreani_envio_id\), ''\) is not null/)
})

test("10. la auditoría guarda motivo, admin, estado anterior/nuevo -- misma tabla order_audit_events ya usada en el resto del sistema", () => {
  assert.match(MIGRATION, /insert into public\.order_audit_events/)
  assert.match(MIGRATION, /'admin',\s*p_admin_id,/)
  assert.match(MIGRATION, /v_previous_financial_status,\s*v_next_financial_status,/)
  assert.match(MIGRATION, /'reasonCode', v_reason_code,/)
  assert.match(MIGRATION, /'reasonText', coalesce\(v_reason_text, v_reason_code\)/)
})

test("Rechazar y Cancelar son mutuamente excluyentes server-side, no sólo en la UI: la RPC re-valida el estado de pago aunque la request no venga del botón correcto", () => {
  assert.match(MIGRATION, /if v_action = 'reject' and v_payment_confirmed then\s*raise exception 'ORDER_ALREADY_PAID_USE_CANCEL';/)
  assert.match(MIGRATION, /if v_action = 'cancel' and not v_payment_confirmed then\s*raise exception 'ORDER_NOT_PAID_USE_REJECT';/)
})

test("el cálculo de pago confirmado usa EXACTAMENTE la misma fórmula que lib/orders/order-payment-status.ts isOrderPaymentConfirmed (fuente única de verdad, coherente con la elegibilidad que ve el admin en la UI)", () => {
  const formula = source("lib/orders/order-payment-status.ts")
  assert.match(formula, /Boolean\(order\.paid_at\)/)
  assert.match(formula, /Number\(order\.payment_confirmed_amount \?\? 0\) > 0/)

  assert.match(MIGRATION, /v_order\.paid_at is not null/)
  assert.match(MIGRATION, /coalesce\(v_order\.payment_confirmed_amount, 0\) > 0/)
  assert.match(
    MIGRATION,
    /coalesce\(v_order\.payment_status, ''\) in \('confirmado', 'approved', 'confirmed'\)/,
  )
  assert.match(
    MIGRATION,
    /coalesce\(v_order\.financial_status, ''\) in \('payment_confirmed', 'refund_pending', 'refunded'\)/,
  )
  // A diferencia de approve_order_claim_cancellation, esta RPC nueva NO debe
  // dar por confirmado el pago sólo por estado='pagado'/despachado.
  const formulaBlock = MIGRATION.slice(
    MIGRATION.indexOf("v_payment_confirmed :="),
    MIGRATION.indexOf("if v_action = 'reject' and v_payment_confirmed"),
  )
  assert.doesNotMatch(formulaBlock, /v_order\.estado, ''\) in \(/)
})

test("11. sólo operador/admin/super_admin pueden ejecutar la acción -- misma guardia de autenticación ya usada por el resto de las rutas admin", () => {
  assert.match(ROUTE, /import \{ requireOperator \} from "@\/app\/api\/admin\/clientes\/_auth"/)
  assert.match(ROUTE, /const auth = await requireOperator\(request\)/)
  assert.match(ROUTE, /if \("error" in auth\) return auth\.error/)

  // Doble candado: la propia RPC vuelve a validar el rol server-side, no
  // confía únicamente en que la API route haya filtrado bien.
  assert.match(
    MIGRATION,
    /coalesce\(p_admin_role, ''\) not in \('operador', 'admin', 'super_admin'\)/,
  )
  assert.match(MIGRATION, /auth\.role\(\) <> 'service_role'/)
})

test("la ruta delega toda la transición a la RPC -- nunca hace su propio .from(\"ordenes\").update(", () => {
  assert.match(ROUTE, /\.rpc\(\s*"admin_cancel_order",/)
  assert.doesNotMatch(ROUTE, /\.from\("ordenes"\)\s*\.update\(/)
})

test("cada código de error de la RPC tiene un mensaje humano distinto en la ruta -- nunca se filtra el error técnico crudo al admin", () => {
  const errorCodes = [
    "ORDER_NOT_FOUND",
    "ORDER_ALREADY_CANCELLED",
    "ORDER_ALREADY_INVOICED",
    "ORDER_ALREADY_DISPATCHED",
    "ORDER_ALREADY_PAID_USE_CANCEL",
    "ORDER_NOT_PAID_USE_REJECT",
    "INVALID_REASON",
  ]

  for (const code of errorCodes) {
    assert.match(ROUTE, new RegExp(`message\\.includes\\("${code}"\\)`), `falta mapear ${code}`)
  }
})

test("permisos revocados de public/anon/authenticated -- sólo service_role puede invocar la RPC", () => {
  assert.match(
    MIGRATION,
    /revoke all on function public\.admin_cancel_order\([^)]*\)\s*from public, anon, authenticated;/,
  )
  assert.match(
    MIGRATION,
    /grant execute on function public\.admin_cancel_order\([^)]*\)\s*to service_role;/,
  )
})
