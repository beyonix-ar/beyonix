import assert from "node:assert/strict"
import test from "node:test"

import {
  ADMIN_ORDER_CANCELLATION_OTHER_REASON,
  ADMIN_ORDER_CANCELLATION_REASONS,
  canCancelOrder,
  canRejectOrder,
  isAndreaniCreationBlockingCancellation,
  isOrderAlreadyCancelled,
  isOrderDispatchedForCancellation,
  isOrderInvoicedForCancellation,
} from "./admin-order-cancellation-reasons.ts"

// 1. Rechazar pedido pendiente (nunca tuvo pago confirmado).
test("1. rechazar: pedido pendiente sin ninguna evidencia de pago -- Rechazar disponible, Cancelar no", () => {
  const pedido = { estado: "pendiente", payment_status: "pendiente_comprobante" }
  assert.equal(canRejectOrder(pedido), true)
  assert.equal(canCancelOrder(pedido), false)
})

test("rechazar: transferencia con comprobante rechazado o en revisión -- Rechazar disponible", () => {
  assert.equal(canRejectOrder({ estado: "pendiente", payment_status: "rechazado" }), true)
  assert.equal(canRejectOrder({ estado: "pendiente", payment_status: "en_revision" }), true)
})

// 2. "Cancelar" un pedido pendiente (sin pago confirmado) debe quedar
// excluido -- es exactamente el caso que Rechazar cubre, mutuamente
// excluyentes según el estado real de pago.
test("2. cancelar pedido pendiente (sin pago confirmado): NO disponible -- ese caso lo cubre Rechazar", () => {
  const pedido = { estado: "pendiente", payment_status: "pendiente_comprobante" }
  assert.equal(canCancelOrder(pedido), false)
})

test("cancelar: pedido con pago confirmado (transferencia validada) -- Cancelar disponible, Rechazar no", () => {
  const pedido = { estado: "pagado", payment_status: "confirmado" }
  assert.equal(canCancelOrder(pedido), true)
  assert.equal(canRejectOrder(pedido), false)
})

test("cancelar: pago confirmado por Mercado Pago aprobado", () => {
  assert.equal(canCancelOrder({ payment_status: "approved" }), true)
})

test("cancelar: pago confirmado por paid_at/payment_confirmed_amount (crédito BEYONIX u otro medio)", () => {
  assert.equal(canCancelOrder({ paid_at: "2026-09-15T00:00:00.000Z" }), true)
  assert.equal(canCancelOrder({ payment_confirmed_amount: 1000 }), true)
})

// 12. Pedido ya cancelado/rechazado no vuelve a procesarse.
test("12. pedido ya cancelado: ni Rechazar ni Cancelar quedan disponibles, sin importar el pago", () => {
  const cancelado = { estado: "cancelado", payment_status: "confirmado" }
  assert.equal(canRejectOrder(cancelado), false)
  assert.equal(canCancelOrder(cancelado), false)
  assert.equal(isOrderAlreadyCancelled(cancelado), true)
})

// 8. Pedido facturado conserva factura -- ninguna acción se ofrece.
test("8. pedido ya facturado: ni Rechazar ni Cancelar quedan disponibles (nunca se toca la factura)", () => {
  const facturadoPorEstado = { payment_status: "confirmado", invoice_status: "authorized" }
  const facturadoPorCae = { payment_status: "confirmado", invoice_cae: "12345678901234" }
  const facturadoPorNumero = {
    payment_status: "confirmado",
    invoice_number: 1,
    invoice_point: 4,
  }

  for (const pedido of [facturadoPorEstado, facturadoPorCae, facturadoPorNumero]) {
    assert.equal(canCancelOrder(pedido), false)
    assert.equal(canRejectOrder({ ...pedido, payment_status: "pendiente_comprobante" }), false)
    assert.equal(isOrderInvoicedForCancellation(pedido), true)
  }
})

// 9. Pedido ya despachado (Andreani) no se cancela como compra estándar.
test("9. pedido despachado: ni Rechazar ni Cancelar quedan disponibles", () => {
  const porEstado = { estado: "en_camino", payment_status: "confirmado" }
  const porTracking = { estado: "pagado", payment_status: "confirmado", tracking_number: "ABC123" }
  const porAndreaniEnvioId = { estado: "pagado", payment_status: "confirmado", andreani_envio_id: "999" }
  const porAndreaniEstadoTexto = {
    estado: "pagado",
    payment_status: "confirmado",
    andreani_estado: "En tránsito hacia destino",
  }

  for (const pedido of [porEstado, porTracking, porAndreaniEnvioId, porAndreaniEstadoTexto]) {
    assert.equal(canCancelOrder(pedido), false)
    assert.equal(isOrderDispatchedForCancellation(pedido), true)
  }

  // Entregado también queda cubierto por la misma lista de estados despachados.
  assert.equal(isOrderDispatchedForCancellation({ estado: "entregado" }), true)
})

test("pedido sin ningún indicio de despacho no queda bloqueado por error", () => {
  assert.equal(isOrderDispatchedForCancellation({ estado: "pendiente" }), false)
  assert.equal(isOrderDispatchedForCancellation({ estado: "pagado", andreani_estado: "Retirado" }), false)
})

// BLOQUEANTE 1 (auditoría Andreani Parte 3/4): las mismas guardas que ahora
// bloquean admin_cancel_order/approve_order_claim_cancellation
// (Parte 1) también ocultan el botón "Cancelar pedido"/"Rechazar pedido"
// -- para que el admin nunca vea un botón habilitado que el RPC va a
// rechazar de todos modos.
test("BLOQUEANTE 1 (Parte 3): claim Andreani en curso o ambiguo oculta Cancelar/Rechazar", () => {
  const pagadoConClaim = {
    estado: "pagado",
    payment_status: "confirmado",
    andreani_creation_status: "claimed",
  }
  const pendienteConReconciliacion = {
    estado: "pendiente",
    payment_status: "pendiente_comprobante",
    andreani_creation_status: "reconciliation_required",
  }

  assert.equal(canCancelOrder(pagadoConClaim), false)
  assert.equal(isAndreaniCreationBlockingCancellation(pagadoConClaim), true)
  assert.equal(canRejectOrder(pendienteConReconciliacion), false)
  assert.equal(isAndreaniCreationBlockingCancellation(pendienteConReconciliacion), true)
})

test("un envío 'created' (ya resuelto) no bloquea por este guard -- lo cubre isOrderDispatchedForCancellation vía andreani_envio_id", () => {
  assert.equal(
    isAndreaniCreationBlockingCancellation({ andreani_creation_status: "created" }),
    false,
  )
  assert.equal(isAndreaniCreationBlockingCancellation({ andreani_creation_status: "failed" }), false)
  assert.equal(isAndreaniCreationBlockingCancellation({}), false)
})

test("los motivos frecuentes incluyen los ejemplos pedidos y 'Otro' habilita texto libre", () => {
  const values = ADMIN_ORDER_CANCELLATION_REASONS.map((r) => r.value)
  assert.deepEqual(values, [
    "solicitud_cliente",
    "pago_no_recibido",
    "pago_invalido",
    "falta_stock",
    "error_administrativo",
    "otro",
  ])
  assert.equal(ADMIN_ORDER_CANCELLATION_OTHER_REASON, "otro")
})
