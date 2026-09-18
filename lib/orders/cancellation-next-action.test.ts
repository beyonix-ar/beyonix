import assert from "node:assert/strict"
import test from "node:test"

import {
  getCancellationNextAction,
  getCancellationNextActionCopy,
  type CancellationNextActionOrder,
} from "./cancellation-next-action.ts"

// Fase 2 (auditoría de cancelaciones/reintegros/NC): antes de esto, cada
// consumidor (notificaciones del admin, getOrderRecommendedAction,
// RefundManagementPanel) interpretaba financial_status/credit_note_required/
// order_credit_notes/mercadopago_order_refunds por su cuenta -- con
// criterios ligeramente distintos. Esta es la única fuente de verdad; estos
// tests cubren la máquina de estados completa, sin tocar Supabase/React.

function order(overrides: Partial<CancellationNextActionOrder> = {}): CancellationNextActionOrder {
  return {
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
    ...overrides,
  }
}

test("orden no cancelada -- none", () => {
  const result = getCancellationNextAction(
    order({ estado: "pagado", financial_status: "payment_confirmed" }),
  )
  assert.deepEqual(result, { state: "none", urgent: false })
})

test("cancelación sin pago confirmado -- none (el saldo, si hubo, ya se restauró aparte)", () => {
  const result = getCancellationNextAction(
    order({
      financial_status: "cancelled",
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: null,
      credit_note_required: false,
    }),
  )
  assert.deepEqual(result, { state: "none", urgent: false })
})

test("cancelación sin pago pero con comprobante todavía en revisión -- blocked (decisión ajena a esta máquina)", () => {
  const result = getCancellationNextAction(
    order({
      financial_status: "cancelled",
      payment_status: "en_revision",
      payment_proof_url: "https://example.test/comprobante.jpg",
      paid_at: null,
      payment_confirmed_amount: null,
      credit_note_required: false,
    }),
  )
  assert.equal(result.state, "blocked")
})

test("financial_status='refunded' -- completed, sin importar el resto", () => {
  const result = getCancellationNextAction(
    order({ financial_status: "refunded", order_credit_notes: [{ status: "processing" }] }),
  )
  assert.deepEqual(result, { state: "completed", urgent: false })
})

test("pago confirmado + facturado + sin NC -- emit_credit_note", () => {
  const result = getCancellationNextAction(order())
  assert.deepEqual(result, { state: "emit_credit_note", urgent: true })
})

test("credit_note_required pero todavía no facturado -- blocked (el bloqueo real es Facturación)", () => {
  const result = getCancellationNextAction(
    order({ invoice_status: "pending", invoice_cae: null }),
  )
  assert.equal(result.state, "blocked")
})

test("NC processing -- wait_credit_note (nada que hacer todavía)", () => {
  const result = getCancellationNextAction(
    order({ order_credit_notes: [{ status: "processing", destination: "external_refund" }] }),
  )
  assert.deepEqual(result, { state: "wait_credit_note", urgent: false })
})

test("NC authorized + external_refund sin liquidar -- register_external_refund", () => {
  const result = getCancellationNextAction(
    order({
      order_credit_notes: [
        { status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 30000 },
      ],
    }),
  )
  assert.deepEqual(result, { state: "register_external_refund", urgent: true })
})

test("NC authorized + external_refund YA liquidada -- ya no hay register_external_refund pendiente", () => {
  const result = getCancellationNextAction(
    order({
      payment_method_id: "transferencia",
      order_credit_notes: [
        { status: "authorized", destination: "external_refund", settlement_status: "completado", total_amount: 30000 },
      ],
    }),
  )
  // Liquidada + no es Mercado Pago + no queda ninguna otra acción conocida.
  assert.equal(result.state, "blocked")
})

test("Mercado Pago, sin NC requerida (nunca se facturó) -- execute_mp_refund directo", () => {
  const result = getCancellationNextAction(
    order({ payment_method_id: "mercadopago", credit_note_required: false, invoice_status: null, invoice_cae: null }),
  )
  assert.deepEqual(result, { state: "execute_mp_refund", urgent: true })
})

test("Mercado Pago, NC ya autorizada con destino 'none' (fiscal-only) -- execute_mp_refund", () => {
  const result = getCancellationNextAction(
    order({
      payment_method_id: "mercadopago",
      credit_note_required: false, // el route ya lo resetea a false tras autorizar cualquier NC
      order_credit_notes: [{ status: "authorized", destination: "none", total_amount: 50000 }],
    }),
  )
  assert.deepEqual(result, { state: "execute_mp_refund", urgent: true })
})

test("Mercado Pago con refund needs_reconciliation -- reconcile_mp_refund, máxima prioridad", () => {
  const result = getCancellationNextAction(
    order({
      payment_method_id: "mercadopago",
      mercadopago_order_refunds: [{ status: "needs_reconciliation", created_at: "2026-09-05T00:00:00.000Z" }],
    }),
  )
  assert.deepEqual(result, { state: "reconcile_mp_refund", urgent: true })
})

test("Mercado Pago con el intento más reciente 'failed' -- execute_mp_refund (reintentable)", () => {
  const result = getCancellationNextAction(
    order({
      payment_method_id: "mercadopago",
      credit_note_required: false,
      mercadopago_order_refunds: [
        { status: "requested", created_at: "2026-09-01T00:00:00.000Z" },
        { status: "failed", created_at: "2026-09-03T00:00:00.000Z" },
      ],
    }),
  )
  assert.deepEqual(result, { state: "execute_mp_refund", urgent: true })
})

test("Mercado Pago con refund 'processing' -- none (en curso, no hay nada que hacer ahora)", () => {
  const result = getCancellationNextAction(
    order({
      payment_method_id: "mercadopago",
      credit_note_required: false,
      mercadopago_order_refunds: [{ status: "processing", created_at: "2026-09-01T00:00:00.000Z" }],
    }),
  )
  assert.deepEqual(result, { state: "none", urgent: false })
})

test("transferencia sin factura (credit_note_required=false, sin ninguna NC) -- register_external_refund, no blocked", () => {
  // Fase 4, punto 1: antes de la migración
  // 20260917130000_external_refund_without_credit_note_and_mp_nc_policy,
  // commit_order_refund_proof exigía una NC authorized con CAE
  // incondicionalmente, así que este caso no tenía camino automático
  // (quedaba 'blocked'). Ahora sí puede completarse -- la máquina de
  // estados debe reflejarlo, no seguir señalando un callejón sin salida.
  const result = getCancellationNextAction(
    order({ credit_note_required: false, invoice_status: null, invoice_cae: null }),
  )
  assert.deepEqual(result, { state: "register_external_refund", urgent: true })
})

test("transferencia con NC de destino 'customer_credit' liquidada (no external_refund) y sin más NC pendientes -- blocked (no cambia)", () => {
  // Caso distinto del anterior: SÍ hubo una NC que movió dinero (destino
  // != 'none'), sólo que no fue 'external_refund'. La migración de Fase 4
  // no toca esta rama -- commit_order_refund_proof sigue exigiendo una NC
  // external_refund pendiente de liquidar, que acá no existe.
  const result = getCancellationNextAction(
    order({
      credit_note_required: false,
      order_credit_notes: [
        { status: "authorized", destination: "customer_credit", settlement_status: "completado", total_amount: 30000 },
      ],
    }),
  )
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "no_automatic_refund_path")
})

test("saldo 100% (nunca se confirma pago externo) no llega a esta máquina como refund_pending", () => {
  // El propio request_customer_order_cancellation_with_claim ya distingue
  // esto: sin pago confirmado, financial_status queda 'cancelled', no
  // 'refund_pending' -- getCancellationNextAction sólo refleja esa realidad.
  const result = getCancellationNextAction(
    order({
      financial_status: "cancelled",
      payment_method_id: null,
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: 0,
      credit_note_required: false,
    }),
  )
  assert.deepEqual(result, { state: "none", urgent: false })
})

test("getCancellationNextActionCopy: none/completed no generan copy (no debe haber alerta)", () => {
  assert.equal(getCancellationNextActionCopy("none"), null)
  assert.equal(getCancellationNextActionCopy("completed"), null)
})

test("getCancellationNextActionCopy: cada estado accionable apunta a la pestaña correcta", () => {
  assert.equal(getCancellationNextActionCopy("emit_credit_note")?.tab, "facturacion")
  assert.equal(getCancellationNextActionCopy("wait_credit_note")?.tab, "facturacion")
  assert.equal(getCancellationNextActionCopy("register_external_refund")?.tab, "cancelacion")
  assert.equal(getCancellationNextActionCopy("execute_mp_refund")?.tab, "cancelacion")
  assert.equal(getCancellationNextActionCopy("reconcile_mp_refund")?.tab, "cancelacion")
  assert.equal(getCancellationNextActionCopy("blocked")?.tab, "cancelacion")
})

test("resolver un paso hace que aparezca el siguiente: emit_credit_note -> register_external_refund -> completed", () => {
  const base = order()
  const step1 = getCancellationNextAction(base)
  assert.equal(step1.state, "emit_credit_note")

  const step2 = getCancellationNextAction(
    order({
      order_credit_notes: [
        { status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 30000 },
      ],
    }),
  )
  assert.equal(step2.state, "register_external_refund")

  const step3 = getCancellationNextAction(order({ financial_status: "refunded" }))
  assert.equal(step3.state, "completed")
})
