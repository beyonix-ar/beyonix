import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  formatAdminPendingActionCount,
  getAdminOrderWork,
  getAdminPendingOrderActionCount,
  getAdminPendingOrderActions,
  summarizeAdminPendingActions,
  type AdminPendingActionsOrder,
} from "./admin-pending-actions.ts"
import {
  getAdminNewOrderEventAt,
  getAdminNewOrderEventKey,
} from "./admin-order-visibility.ts"

function kinds(order: AdminPendingActionsOrder) {
  return getAdminPendingOrderActions(order).map((action) => action.kind)
}

// Pedido pagado, facturado y entregado: el flujo normal ya terminó.
const deliveredOrder: AdminPendingActionsOrder = {
  estado: "entregado",
  financial_status: "payment_confirmed",
  payment_method_id: "mercadopago",
  payment_status: "approved",
  paid_at: "2026-09-10T10:00:00.000Z",
  payment_confirmed_amount: 50_000,
  total: 50_000,
  invoice_status: "authorized",
  invoice_cae: "12345678901234",
  credit_note_required: false,
  order_claims: [],
  order_credit_notes: [],
  mercadopago_order_refunds: [],
}

// Cancelado con dinero cobrado por transferencia (facturado: requiere NC).
const cancelledPaidTransfer: AdminPendingActionsOrder = {
  ...deliveredOrder,
  estado: "cancelado",
  financial_status: "refund_pending",
  payment_method_id: "transferencia",
  payment_status: "confirmado",
  credit_note_required: true,
}

test("1. cancelado sin pago: 0 (no se muestra el badge)", () => {
  const order: AdminPendingActionsOrder = {
    estado: "cancelado",
    financial_status: "cancelled",
    payment_method_id: "transferencia",
    payment_status: "rechazado",
    paid_at: null,
    payment_confirmed_amount: null,
    total: 30_000,
  }
  assert.equal(getAdminPendingOrderActionCount(order), 0)

  // Mercado Pago que nunca se cobró y se venció.
  assert.equal(
    getAdminPendingOrderActionCount({
      estado: "cancelado",
      financial_status: "cancelled",
      payment_method_id: "mercadopago",
      payment_status: "checkout_expired",
      total: 30_000,
    }),
    0,
  )
})

test("2. cancelado + reintegro pendiente (sin NC requerida): 1", () => {
  assert.deepEqual(kinds({ ...cancelledPaidTransfer, credit_note_required: false }), ["refund"])
})

test("3. cancelado + reintegro con NC requerida: 1 (la NC es automática, no otra acción)", () => {
  assert.deepEqual(kinds(cancelledPaidTransfer), ["refund"])
  assert.equal(formatAdminPendingActionCount(2), "2 acciones pendientes")
})

test("4 y 7. reintegro completado y NC emitida: 0", () => {
  assert.equal(
    getAdminPendingOrderActionCount({
      ...cancelledPaidTransfer,
      financial_status: "refunded",
      order_credit_notes: [
        { status: "authorized", destination: "external_refund", settlement_status: "completado", total_amount: 50_000 },
      ],
    }),
    0,
  )
})

test("5. entregado sin incidencias: 0", () => {
  assert.equal(getAdminPendingOrderActionCount(deliveredOrder), 0)
})

const reviewed = { status: "aprobado", first_reviewed_at: "2026-09-10T10:00:00.000Z" }

test("6. entregado + reclamo abierto: 1; 7. reclamo cerrado: 0", () => {
  assert.deepEqual(kinds({ ...deliveredOrder, order_claims: [{ id: 1, admin_needs_action: true }] }), ["claim"])
  assert.equal(
    getAdminPendingOrderActionCount({ ...deliveredOrder, order_claims: [{ id: 1, admin_needs_action: false, ...reviewed }] }),
    0,
  )
  // Dos reclamos que requieren acción = 2 acciones.
  assert.equal(
    getAdminPendingOrderActionCount({
      ...deliveredOrder,
      order_claims: [
        { id: 1, admin_needs_action: true },
        { id: 2, admin_needs_action: true },
      ],
    }),
    2,
  )
})

test("8-9. devolución pendiente cuenta; finalizada no", () => {
  for (const status of ["solicitada", "en_revision", "aprobada"]) {
    assert.deepEqual(kinds({ ...deliveredOrder, return_status: status }), ["return"], status)
  }
  for (const status of ["resuelta", "rechazada"]) {
    assert.equal(getAdminPendingOrderActionCount({ ...deliveredOrder, return_status: status }), 0, status)
  }
  assert.equal(
    getAdminPendingOrderActionCount({ ...deliveredOrder, return_status: "aprobada", return_resolved_at: "2026-09-20T10:00:00.000Z" }),
    0,
  )
})

test("10-11. reemplazo pendiente cuenta (vía su reclamo); completado no", () => {
  // Un reemplazo se crea en un solo paso atómico (create_order_replacement):
  // lo pendiente vive en el reclamo que lo pidió (admin_needs_action).
  assert.deepEqual(kinds({ ...deliveredOrder, order_claims: [{ id: 9, admin_needs_action: true }] }), ["claim"])
  assert.equal(getAdminPendingOrderActionCount({ ...deliveredOrder, order_claims: [{ id: 9, admin_needs_action: false, ...reviewed }] }), 0)
})

test("12. transferencia pendiente de revisión: cuenta; 13. rechazada y cerrada: 0", () => {
  const pendingReview: AdminPendingActionsOrder = {
    estado: "pendiente",
    financial_status: "pending_payment",
    payment_method_id: "transferencia",
    payment_status: "en_revision",
    payment_proof_url: "proofs/12.pdf",
    total: 30_000,
  }
  assert.deepEqual(kinds(pendingReview), ["payment_review"])
  assert.deepEqual(
    kinds({ ...pendingReview, payment_status: "pendiente_comprobante", payment_proof_url: null, transfer_verification_status: "manual_review" }),
    ["payment_review"],
  )
  // Transferencia verificada en MP pero sin stock para confirmar.
  assert.deepEqual(kinds({ ...pendingReview, payment_status: "auto_verified_stock_conflict" }), ["payment_conflict"])
  // Esperando que el cliente transfiera: no hay nada que hacer todavía.
  assert.equal(getAdminPendingOrderActionCount({ ...pendingReview, payment_status: "pendiente_comprobante", payment_proof_url: null }), 0)

  assert.equal(
    getAdminPendingOrderActionCount({
      ...pendingReview,
      estado: "cancelado",
      financial_status: "cancelled",
      payment_status: "rechazado",
    }),
    0,
  )
})

test("14. Mercado Pago aprobado: sólo el flujo normal real (factura y envío), sin inventar pendientes", () => {
  const approved: AdminPendingActionsOrder = {
    ...deliveredOrder,
    estado: "pagado",
    invoice_status: null,
    invoice_cae: null,
  }
  assert.deepEqual(kinds(approved), ["invoice"])
  // Facturado: falta preparar el envío.
  assert.deepEqual(kinds({ ...approved, invoice_status: "authorized", invoice_cae: "1" }), ["shipping"])
  // Preparado / despachado: ya no requiere acción.
  for (const estado of ["preparado", "enviado", "en_camino", "entregado"]) {
    assert.equal(getAdminPendingOrderActionCount({ ...approved, estado, invoice_status: "authorized", invoice_cae: "1" }), 0, estado)
  }
  // Intento de Mercado Pago sin pagar: nada.
  assert.equal(
    getAdminPendingOrderActionCount({ estado: "pendiente", financial_status: "pending_payment", payment_method_id: "mercadopago", payment_status: "preference_created", total: 30_000 }),
    0,
  )
  // Pago cobrado que no se pudo confirmar: requiere resolución.
  // (El webhook no fija monto confirmado en este caso; igual, un pago en
  // conflicto nunca suma "facturar" hasta resolverse.)
  assert.deepEqual(
    kinds({ ...approved, payment_status: "approved_amount_mismatch", financial_status: "pending_payment", paid_at: null, payment_confirmed_amount: null }),
    ["payment_conflict"],
  )
  assert.deepEqual(kinds({ ...approved, payment_status: "approved_amount_mismatch" }), ["payment_conflict"])
})

test("15. el contador baja a 0 al resolver la última acción (derivado del estado, sin drift)", () => {
  const steps: AdminPendingActionsOrder[] = [
    cancelledPaidTransfer,
    {
      ...cancelledPaidTransfer,
      order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 50_000 }],
    },
    {
      ...cancelledPaidTransfer,
      financial_status: "refunded",
      order_credit_notes: [{ status: "authorized", destination: "external_refund", settlement_status: "completado", total_amount: 50_000 }],
    },
  ]
  assert.deepEqual(steps.map(getAdminPendingOrderActionCount), [1, 1, 0])
  // Mismo estado => mismo contador.
  assert.equal(getAdminPendingOrderActionCount({ ...steps[1] }), 1)
})

test("cancelación solicitada: primero se decide la solicitud (1), sin adelantar reintegro/NC", () => {
  assert.deepEqual(
    kinds({ ...deliveredOrder, estado: "pagado", financial_status: "cancellation_requested" }),
    ["cancellation_request"],
  )
})

test("16. campana y contador pueden diferir correctamente", () => {
  // Pedido de transferencia confirmado y sin facturar: la campana avisa
  // "Pedido nuevo" (evento) y el ojo cuenta 1 (falta facturar). Al leer la
  // campana, el evento no cambia; el ojo sigue en 1 hasta facturar.
  const confirmed = {
    id: 77,
    admin_visible_at: "2026-09-23T10:00:00.000Z",
    payment_method_id: "transferencia",
    payment_status: "confirmado",
    payment_confirmed_at: "2026-09-23T11:00:00.000Z",
  }
  assert.equal(getAdminNewOrderEventAt(confirmed), "2026-09-23T11:00:00.000Z")
  assert.equal(getAdminNewOrderEventKey(77), "order:77")
  const order: AdminPendingActionsOrder = {
    estado: "pagado",
    financial_status: "payment_confirmed",
    payment_method_id: "transferencia",
    payment_status: "confirmado",
    paid_at: "2026-09-23T11:00:00.000Z",
    total: 30_000,
    invoice_status: null,
  }
  assert.equal(getAdminPendingOrderActionCount(order), 1)

  // Y al revés: pedido cancelado sin pendientes -> 0 en el ojo, aunque la
  // campana alguna vez haya notificado algo sobre él.
  assert.equal(
    getAdminPendingOrderActionCount({ ...order, estado: "cancelado", financial_status: "cancelled", payment_status: "rechazado", paid_at: null }),
    0,
  )
})

test("el listado del Admin usa el helper y muestra el número real (nunca un '1' fijo)", () => {
  const source = readFileSync(new URL("../../app/admin/sections/pedidos/admin-pedidos.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n")
  const badgeStart = source.indexOf("function OrderEyeAttentionBadge(")
  const badge = source.slice(badgeStart, source.indexOf("\n}\n", badgeStart))
  assert.match(badge, /if \(count === 0\) return null/)
  assert.match(badge, /\{count\}/)
  assert.doesNotMatch(badge, />\s*1\s*</)
  assert.match(badge, /formatAdminPendingActionCount\(count\)/)
  assert.match(source, /const pendingActions = getAdminPendingOrderActions\(pedido\)/)
  assert.equal((source.match(/<OrderEyeAttentionBadge actions=\{pendingActions\} \/>/g) ?? []).length, 2)
  // Ya no depende de notificaciones leídas ni de "cancelado sin reembolso".
  assert.doesNotMatch(source, /pedido\.estado === "cancelado" && !isRefundedOrder\(pedido\)/)
  assert.doesNotMatch(source, /eyeAttentionSeverity/)
})

// ── Etapa 7: sólo intervención humana real ──

const paidAndreani: AdminPendingActionsOrder = {
  ...deliveredOrder,
  id: 31,
  estado: "pagado",
  shipping_provider: "andreani",
  invoice_status: "authorized",
  invoice_cae: "1",
}
const facts = (overrides: Partial<NonNullable<AdminPendingActionsOrder["admin_pending_facts"]>>) => ({
  financial: null,
  dispatch: null,
  ...overrides,
})

test("A. procesos automáticos: 0 acciones humanas, informados aparte", () => {
  const queued = { ...paidAndreani, invoice_status: "pending", invoice_cae: null, admin_pending_facts: facts({ invoiceAutomatic: true }) }
  assert.deepEqual(getAdminOrderWork(queued), { actions: [], automatic: ["Facturación automática programada"] })
  assert.deepEqual(getAdminOrderWork({ ...queued, invoice_status: "processing" }).actions, [])
  const refundRunning = {
    ...cancelledPaidTransfer,
    id: 31,
    admin_pending_facts: facts({ financial: { mode: "resolution", resolutionStatus: "processing", hasOptions: false } }),
  }
  assert.deepEqual(getAdminOrderWork(refundRunning), { actions: [], automatic: ["Reintegro en proceso"] })
  const ncAtArca = { ...cancelledPaidTransfer, order_credit_notes: [{ status: "processing", destination: "external_refund" }] }
  assert.deepEqual(getAdminOrderWork(ncAtArca), { actions: [], automatic: ["Nota de crédito en proceso"] })
})

test("B. reclamo: 1 'Resolver reclamo' hacia Atención al cliente", () => {
  const actions = getAdminPendingOrderActions({ ...deliveredOrder, id: 31, order_claims: [{ id: 1, admin_needs_action: true }] })
  assert.deepEqual(actions.map((action) => [action.label, action.href, action.priority]), [["Resolver reclamo", "/admin/pedidos/31?tab=atencion", 1]])
  // La solicitud de cancelación no se cuenta además como reclamo.
  assert.deepEqual(kinds({ ...deliveredOrder, financial_status: "cancellation_requested",
    order_claims: [{ id: 2, failure_type: "cancelar_compra", status: "recibido" }] }), ["cancellation_request"])
})

test("C. reclamo + reintegro manual pendiente: 2", () => {
  const order = {
    ...cancelledPaidTransfer,
    id: 31,
    order_claims: [{ id: 1, admin_needs_action: true }],
    admin_pending_facts: facts({ financial: { mode: "resolution", resolutionStatus: "manual_pending", hasOptions: false } }),
  }
  const actions = getAdminPendingOrderActions(order)
  assert.deepEqual(actions.map((action) => action.label), ["Registrar reintegro", "Resolver reclamo"])
  assert.equal(getAdminPendingOrderActionCount(order), 2)
  assert.equal(actions[0].href, "/admin/pedidos/31?tab=cancelacion")
})

test("D. pedido bloqueado en tanda: 'Retirar del despacho' primero, prioridad alta", () => {
  const order = {
    ...paidAndreani,
    payment_status: "en_revision",
    payment_method_id: "transferencia",
    payment_proof_url: "proofs/1.pdf",
    admin_pending_facts: facts({ dispatch: { batchId: 7, batchStatus: "closed", packageStatus: "prepared", blocked: true } }),
  }
  const actions = getAdminPendingOrderActions(order)
  assert.equal(actions[0].label, "Retirar del despacho")
  assert.equal(actions[0].priority, 1)
  assert.equal(actions[0].href, "/admin/despachos?batch=7")
  assert.ok(!actions.some((action) => action.kind === "dispatch_prepare"))
  assert.ok(!getAdminOrderWork(order).automatic.includes("En tanda lista para entregar al transporte"), "con bloqueo no se ofrece la entrega")
  // Entregado al transporte: el bloqueo ya no es accionable desde la tanda.
  assert.ok(!kinds({ ...order, andreani_handed_over_at: "2026-10-05T12:00:00Z" }).includes("dispatch_blocked"))
})

test("despacho Andreani: preparar cuenta por pedido; la entrega de la tanda no suma en cada pedido", () => {
  assert.deepEqual(getAdminPendingOrderActions(paidAndreani).map((action) => [action.label, action.href]),
    [["Preparar despacho", "/admin/despachos?order=31"]])
  // 30 pedidos en una tanda cerrada: ninguno suma; cada uno sólo informa su estado.
  const inClosedBatch = Array.from({ length: 30 }, (_, index) => getAdminOrderWork({ ...paidAndreani, id: 100 + index,
    admin_pending_facts: facts({ dispatch: { batchId: 4, batchStatus: "closed", packageStatus: "prepared", blocked: false } }) }))
  assert.equal(inClosedBatch.reduce((sum, work) => sum + work.actions.length, 0), 0)
  assert.ok(inClosedBatch.every((work) => work.automatic.includes("En tanda lista para entregar al transporte")))
  assert.deepEqual(kinds({ ...paidAndreani, andreani_handed_over_at: "2026-10-05T12:00:00Z" }), [])
  assert.deepEqual(getAdminOrderWork({ ...paidAndreani,
    admin_pending_facts: facts({ dispatch: { batchId: 4, batchStatus: "handed_over", packageStatus: "prepared", blocked: false } }) }),
  { actions: [], automatic: [] })
})

test("F. señales repetidas no duplican acciones; la fila resume el resto", () => {
  const order = { ...paidAndreani, admin_pending_facts: facts({ dispatch: { batchId: 7, batchStatus: "open", packageStatus: "prepared", blocked: true } }) }
  assert.equal(kinds(order).filter((kind) => kind === "dispatch_blocked").length, 1)
  const claims = getAdminPendingOrderActions({ ...deliveredOrder, id: 31, order_claims: [
    { id: 1, admin_needs_action: true }, { id: 2, admin_needs_action: true }, { id: 3, admin_needs_action: true }] })
  assert.equal(claims.length, 3)
  assert.deepEqual(summarizeAdminPendingActions(claims, 2), { shown: [claims[0]], hidden: 0 })
  const mixed = [...getAdminPendingOrderActions(order), ...claims]
  const summary = summarizeAdminPendingActions(mixed, 1)
  assert.deepEqual(summary.shown.map((action) => action.label), ["Retirar del despacho"])
  assert.equal(summary.hidden, 3)
})

test("G. caso avanzado de Etapa 6: cuenta 1 'Revisar caso avanzado'", () => {
  const actions = getAdminPendingOrderActions({ ...cancelledPaidTransfer, id: 31,
    admin_pending_facts: facts({ financial: { mode: "advanced", resolutionStatus: null, hasOptions: false } }) })
  assert.deepEqual(actions.map((action) => [action.label, action.href, action.priority]),
    [["Revisar caso avanzado", "/admin/pedidos/31?tab=cancelacion", 1]])
})

test("H. facturación: sólo no cuenta si el worker automático realmente la va a emitir", () => {
  const unpaidInvoice = { ...paidAndreani, invoice_status: null, invoice_cae: null }
  const automaticOn = facts({ invoiceAutomatic: true })
  const automaticOff = facts({ invoiceAutomatic: false })
  // Automático activo y factura en su cola: informativo.
  assert.deepEqual(kinds({ ...unpaidInvoice, invoice_status: "pending", admin_pending_facts: automaticOn }), [])
  assert.deepEqual(kinds({ ...unpaidInvoice, invoice_status: "error", invoice_next_attempt_at: "2026-10-05T13:00:00Z", admin_pending_facts: automaticOn }), [])
  // Pago confirmado, sin CAE, en cola y automático desactivado: nadie la emite.
  const label = (order: AdminPendingActionsOrder) => getAdminPendingOrderActions(order).map((action) => action.label)
  assert.deepEqual(label({ ...unpaidInvoice, invoice_status: "pending", admin_pending_facts: automaticOff }), ["Emitir factura"])
  assert.deepEqual(label({ ...unpaidInvoice, invoice_status: "error", invoice_next_attempt_at: "2026-10-05T13:00:00Z", admin_pending_facts: automaticOff }), ["Revisar factura"])
  // Sin dato del control no se asume automático.
  assert.deepEqual(label({ ...unpaidInvoice, invoice_status: "pending" }), ["Emitir factura"])
  assert.deepEqual(label({ ...unpaidInvoice, invoice_status: "error" }), ["Revisar factura"])
  assert.deepEqual(label(unpaidInvoice), ["Emitir factura"])
})

test("I. 'Reintentar actualización' cuenta sólo si requiere intervención", () => {
  const withStatus = (resolutionStatus: string) => getAdminPendingOrderActions({ ...cancelledPaidTransfer, id: 31,
    admin_pending_facts: facts({ financial: { mode: "resolution", resolutionStatus, hasOptions: false } }) })
  assert.deepEqual(withStatus("requires_action").map((action) => action.label), ["Reintentar actualización"])
  assert.deepEqual(withStatus("processing"), [])
  assert.deepEqual(withStatus("reserved"), [])
  assert.deepEqual(withStatus("completed"), [])
  // Wizard con opción ejecutable: decisión humana. Esperando la recepción: no.
  const wizard = (hasOptions: boolean) => getAdminOrderWork({ ...cancelledPaidTransfer, id: 31,
    admin_pending_facts: facts({ financial: { mode: "wizard", resolutionStatus: null, hasOptions } }) })
  assert.deepEqual(wizard(true).actions.map((action) => action.label), ["Resolver reintegro"])
  assert.deepEqual(wizard(false), { actions: [], automatic: ["Esperando la recepción del producto"] })
})

test("devolución recibida sin destino de stock: 'Revisar devolución'", () => {
  const arrived = { ...deliveredOrder, id: 31, estado: "devuelto_beyonix", orden_items: [{ return_inventory_processed_at: null }] }
  assert.deepEqual(getAdminPendingOrderActions(arrived).map((action) => [action.label, action.priority]), [["Revisar devolución", 2]])
  assert.deepEqual(kinds({ ...arrived, orden_items: [{ return_inventory_processed_at: "2026-10-05T12:00:00Z" }] }), [])
})
