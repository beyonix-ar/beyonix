import assert from "node:assert/strict"
import test from "node:test"

import {
  buildCancellationNotification,
  buildClaimNotification,
  dedupeNotifications,
  getOperationalPriority,
  keepLatestNotificationByOrder,
  type AdminNotification,
  type CancellationNotificationOrder,
  type ClaimAttentionInput,
} from "./admin-notification-rules.ts"

// Fase 2 (auditoría de cancelaciones/reintegros/NC). Bug real: un claim de
// cancelar_compra generaba también una notificación tipo "claim" (hacia
// ?tab=reclamos, "Atención al cliente"), que competía por prioridad con la
// notificación de cancelación real (creada en la MISMA transacción, mismo
// timestamp) y la tapaba -- el admin terminaba siempre en "Atención al
// cliente" en vez de en la gestión concreta. Estos tests cubren la
// generación de notificaciones y su dedupe/prioridad de forma dinámica
// (sin mocks de Supabase: buildCancellationNotification/buildClaimNotification
// son funciones puras extraídas de getAdminNotifications para esto).

function cancellationOrder(
  overrides: Partial<CancellationNotificationOrder> = {},
): CancellationNotificationOrder {
  return {
    id: 123,
    estado: "cancelado",
    financial_status: "refund_pending",
    payment_method_id: "transferencia",
    payment_status: "confirmado",
    paid_at: "2026-09-01T12:00:00.000Z",
    payment_confirmed_amount: 30000,
    invoice_status: "authorized",
    invoice_cae: "CAE-TEST",
    credit_note_required: true,
    order_credit_notes: [],
    mercadopago_order_refunds: [],
    refund_pending_at: "2026-09-01T12:05:00.000Z",
    ...overrides,
  }
}

function claim(overrides: Partial<ClaimAttentionInput> = {}): ClaimAttentionInput {
  return {
    id: 1,
    order_id: 123,
    failure_type: "producto_defectuoso",
    admin_needs_action: true,
    status: "recibido",
    created_at: "2026-09-01T12:05:00.000Z",
    ...overrides,
  }
}

// --- 1. cancelar_compra NO genera notificación tipo "claim" ---

test("1. un claim de cancelar_compra no genera notificación tipo claim", () => {
  const notification = buildClaimNotification(
    claim({ failure_type: "cancelar_compra", status: "reintegro_pendiente" }),
  )
  assert.equal(notification, null)
})

// --- 12. no romper claims reales que sí pertenecen a Atención al cliente ---

test("12. un reclamo formal real sigue generando la notificación hacia Atención al cliente", () => {
  const notification = buildClaimNotification(claim())
  assert.ok(notification)
  assert.equal(notification!.type, "claim")
  assert.match(notification!.actionUrl, /\?tab=reclamos$/)
})

test("12b. un mensaje de ayuda real también sigue funcionando", () => {
  const notification = buildClaimNotification(
    claim({ failure_type: "consulta_pedido" }),
  )
  assert.ok(notification)
  assert.equal(notification!.title, "Mensaje de ayuda por responder")
})

test("un claim ya resuelto no genera notificación (independiente de cancelar_compra)", () => {
  const notification = buildClaimNotification(
    claim({ status: "cerrado", admin_needs_action: false }),
  )
  assert.equal(notification, null)
})

// --- 2/3/4. contenido correcto por próxima acción ---

test("2. pago confirmado + NC pendiente -- 'Emitir nota de crédito' hacia Facturación", () => {
  const notification = buildCancellationNotification(cancellationOrder())
  assert.ok(notification)
  assert.equal(notification!.title, "Emitir nota de crédito")
  assert.match(notification!.actionUrl, /\?tab=facturacion$/)
  assert.equal(notification!.priority, "attention")
})

test("3. NC autorizada + transferencia pendiente -- 'Registrar reintegro' hacia Cancelación", () => {
  const notification = buildCancellationNotification(
    cancellationOrder({
      order_credit_notes: [
        {
          status: "authorized",
          destination: "external_refund",
          settlement_status: "pendiente",
          total_amount: 30000,
        },
      ],
    }),
  )
  assert.ok(notification)
  assert.equal(notification!.title, "Registrar reintegro")
  assert.match(notification!.actionUrl, /\?tab=cancelacion$/)
})

test("4. Mercado Pago needs_reconciliation -- 'Revisar reintegro de Mercado Pago'", () => {
  const notification = buildCancellationNotification(
    cancellationOrder({
      payment_method_id: "mercadopago",
      mercadopago_order_refunds: [
        { status: "needs_reconciliation", created_at: "2026-09-02T00:00:00.000Z" },
      ],
    }),
  )
  assert.ok(notification)
  assert.equal(notification!.title, "Revisar reintegro de Mercado Pago")
  assert.equal(notification!.priority, "attention")
})

// --- 5/6/11. sin alerta cuando no corresponde ---

test("5. financial_status='refunded' -- sin notificación pendiente", () => {
  const notification = buildCancellationNotification(
    cancellationOrder({ financial_status: "refunded" }),
  )
  assert.equal(notification, null)
})

test("6. cancelación sin pago confirmado -- sin alerta de reintegro", () => {
  const notification = buildCancellationNotification(
    cancellationOrder({
      financial_status: "cancelled",
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: null,
      credit_note_required: false,
    }),
  )
  assert.equal(notification, null)
})

test("11. proceso terminado (refunded) elimina la acción pendiente para el mismo pedido", () => {
  const pending = buildCancellationNotification(cancellationOrder())
  assert.ok(pending)
  const resolved = buildCancellationNotification(
    cancellationOrder({ financial_status: "refunded" }),
  )
  assert.equal(resolved, null)
})

// --- 9. actionUrl abre pedido + pestaña correctos ---

test("9. actionUrl siempre incluye el pedido correcto y la pestaña del estado", () => {
  const notification = buildCancellationNotification(cancellationOrder({ id: 456 }))
  assert.ok(notification)
  assert.equal(notification!.orderId, 456)
  assert.match(notification!.actionUrl, /\/pedidos\/456\?tab=facturacion$/)
})

// --- 7. dedupe deja una sola notificación operativa por pedido ---

test("7. keepLatestNotificationByOrder deja una sola notificación por pedido", () => {
  const notifications: AdminNotification[] = [
    {
      id: "cancellation:emit_credit_note:123",
      type: "cancellation",
      eventKey: "cancellation:emit_credit_note:123",
      eventAt: "2026-09-01T12:05:00.000Z",
      title: "Emitir nota de crédito",
      body: "",
      actionUrl: "/admin/pedidos/123?tab=facturacion",
      orderId: 123,
      isRead: false,
      priority: "attention",
    },
    {
      id: "claim:1",
      type: "claim",
      eventKey: "claim:1",
      eventAt: "2026-09-01T12:05:00.000Z",
      title: "Reclamo por responder",
      body: "",
      actionUrl: "/admin/pedidos/123?tab=reclamos",
      orderId: 123,
      isRead: false,
    },
  ]

  const result = keepLatestNotificationByOrder(notifications)
  assert.equal(result.length, 1)
})

test("dedupeNotifications no elimina notificaciones legítimas de pedidos distintos", () => {
  const notifications: AdminNotification[] = [
    {
      id: "cancellation:emit_credit_note:1",
      type: "cancellation",
      eventKey: "cancellation:emit_credit_note:1",
      eventAt: "2026-09-01T12:05:00.000Z",
      title: "Emitir nota de crédito",
      body: "",
      actionUrl: "/admin/pedidos/1?tab=facturacion",
      orderId: 1,
      isRead: false,
    },
    {
      id: "cancellation:emit_credit_note:2",
      type: "cancellation",
      eventKey: "cancellation:emit_credit_note:2",
      eventAt: "2026-09-01T12:05:00.000Z",
      title: "Emitir nota de crédito",
      body: "",
      actionUrl: "/admin/pedidos/2?tab=facturacion",
      orderId: 2,
      isRead: false,
    },
  ]

  assert.equal(dedupeNotifications(notifications).length, 2)
})

// --- 8. prioridad: acción financiera concreta > Atención al cliente ---

test("8. mismo eventAt (misma transacción): la notificación de cancelación urgente gana sobre el claim genérico", () => {
  const sameInstant = "2026-09-01T12:05:00.000Z"
  const cancellation: AdminNotification = {
    id: "cancellation:emit_credit_note:123",
    type: "cancellation",
    eventKey: "cancellation:emit_credit_note:123",
    eventAt: sameInstant,
    title: "Emitir nota de crédito",
    body: "",
    actionUrl: "/admin/pedidos/123?tab=facturacion",
    orderId: 123,
    isRead: false,
    priority: "attention",
  }
  const genericClaim: AdminNotification = {
    id: "claim:1",
    type: "claim",
    eventKey: "claim:1",
    eventAt: sameInstant,
    title: "Reclamo por responder",
    body: "",
    actionUrl: "/admin/pedidos/123?tab=reclamos",
    orderId: 123,
    isRead: false,
  }

  assert.ok(getOperationalPriority(cancellation) > getOperationalPriority(genericClaim))

  const winner = keepLatestNotificationByOrder([genericClaim, cancellation])
  assert.equal(winner.length, 1)
  assert.equal(winner[0].type, "cancellation")
  assert.match(winner[0].actionUrl, /\?tab=facturacion$/)
})

test("una notificación de cancelación no urgente (wait_credit_note nunca se genera, pero por si acaso) no le gana a un claim real", () => {
  const nonUrgentCancellation: AdminNotification = {
    id: "cancellation:x:1",
    type: "cancellation",
    eventKey: "cancellation:x:1",
    eventAt: "2026-09-01T12:05:00.000Z",
    title: "x",
    body: "",
    actionUrl: "/admin/pedidos/1?tab=cancelacion",
    orderId: 1,
    isRead: false,
    // sin priority: "attention" -- no debería superar a claim
  }
  const realClaim: AdminNotification = {
    id: "claim:2",
    type: "claim",
    eventKey: "claim:2",
    eventAt: "2026-09-01T12:05:00.000Z",
    title: "Reclamo por responder",
    body: "",
    actionUrl: "/admin/pedidos/1?tab=reclamos",
    orderId: 1,
    isRead: false,
  }

  assert.ok(getOperationalPriority(realClaim) > getOperationalPriority(nonUrgentCancellation))
})

// --- Fase 4, punto 8: alertas para reintegros/NC atascados (stale) ---
// Reusa la misma notificación de cancelación (sin scheduler nuevo, sin
// mover dinero): sólo agrega un flag `stale` cuando lleva más del umbral
// esperado pendiente, y ese flag cambia el ORDEN en que se muestra (nunca
// dispara nada por sí solo).

test("13. emit_credit_note reciente (1h) -- no está stale", () => {
  const now = new Date("2026-09-01T13:05:00.000Z").getTime()
  const notification = buildCancellationNotification(cancellationOrder(), now)
  assert.equal(notification?.stale, false)
})

test("14. emit_credit_note con más de 48h pendiente -- stale", () => {
  const now = new Date("2026-09-04T00:00:00.000Z").getTime() // +60h aprox
  const notification = buildCancellationNotification(cancellationOrder(), now)
  assert.equal(notification?.stale, true)
})

test("15. needs_reconciliation se marca stale mucho antes (6h) que el resto (48h)", () => {
  const sixHoursLater = new Date("2026-09-01T18:10:00.000Z").getTime()
  const notification = buildCancellationNotification(
    cancellationOrder({
      payment_method_id: "mercadopago",
      mercadopago_order_refunds: [{ status: "needs_reconciliation", created_at: "2026-09-01T12:10:00.000Z" }],
    }),
    sixHoursLater,
  )
  assert.equal(notification?.stale, true)

  // El mismo tiempo transcurrido NO alcanza para marcar stale un
  // emit_credit_note (su umbral es 48h, no 6h).
  const sameElapsedButDifferentState = buildCancellationNotification(cancellationOrder(), sixHoursLater)
  assert.equal(sameElapsedButDifferentState?.stale, false)
})

test("16. wait_credit_note nunca se marca stale (depende de ARCA, no del admin)", () => {
  const farInTheFuture = new Date("2026-09-10T00:00:00.000Z").getTime()
  const notification = buildCancellationNotification(
    cancellationOrder({ order_credit_notes: [{ status: "processing", destination: "external_refund" }] }),
    farInTheFuture,
  )
  assert.equal(notification?.title, "Nota de crédito en trámite")
  assert.equal(notification?.stale, false)
})

test("17. keepLatestNotificationByOrder empuja lo stale arriba, aunque sea más viejo que el resto", () => {
  const staleOld: AdminNotification = {
    id: "cancellation:emit_credit_note:1",
    type: "cancellation",
    eventKey: "cancellation:emit_credit_note:1",
    eventAt: "2026-08-01T00:00:00.000Z", // mucho más viejo
    title: "Emitir nota de crédito",
    body: "",
    actionUrl: "/admin/pedidos/1?tab=facturacion",
    orderId: 1,
    isRead: false,
    priority: "attention",
    stale: true,
  }
  const freshNotStale: AdminNotification = {
    id: "cancellation:emit_credit_note:2",
    type: "cancellation",
    eventKey: "cancellation:emit_credit_note:2",
    eventAt: "2026-09-01T00:00:00.000Z", // más reciente
    title: "Emitir nota de crédito",
    body: "",
    actionUrl: "/admin/pedidos/2?tab=facturacion",
    orderId: 2,
    isRead: false,
    priority: "attention",
    stale: false,
  }

  const ordered = keepLatestNotificationByOrder([freshNotStale, staleOld])
  assert.equal(ordered[0].orderId, 1, "lo vencido va primero aunque sea más viejo")
  assert.equal(ordered[1].orderId, 2)
})
