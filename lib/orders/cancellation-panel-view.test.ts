import assert from "node:assert/strict"
import test from "node:test"

import { getCancellationPanelViewModel } from "./cancellation-panel-view.ts"
import type { CancellationNextActionOrder } from "./cancellation-next-action.ts"

// Fase 3 (UX admin ultra intuitiva). Estos tests cubren la lógica pura del
// panel (pasos, importes, método de pago, acción principal) sin React ni
// fetch -- la UI sólo debe traducir este modelo a JSX, nunca re-derivar
// reglas financieras (sección 16 de la auditoría).

function order(
  overrides: Partial<CancellationNextActionOrder> & {
    total?: number | null
    external_amount_due?: number | null
  } = {},
) {
  return {
    estado: "cancelado",
    financial_status: "refund_pending",
    payment_method_id: "transferencia",
    payment_status: "confirmado",
    paid_at: "2026-09-01T12:00:00.000Z",
    payment_confirmed_amount: 30000,
    total: 50000,
    invoice_status: "authorized",
    invoice_cae: "CAE-TEST",
    credit_note_required: true,
    order_credit_notes: [],
    mercadopago_order_refunds: [],
    ...overrides,
  }
}

// 1. transferencia + NC pendiente -> Paso 1: Emitir NC
test("1. transferencia + NC pendiente -- Paso 1 de 2: Emitir nota de crédito", () => {
  const model = getCancellationPanelViewModel(order())
  assert.equal(model.state, "emit_credit_note")
  assert.equal(model.steps.length, 2)
  assert.equal(model.currentStepIndex, 1)
  assert.equal(model.steps[0].key, "credit_note")
  assert.equal(model.steps[0].status, "pending")
  assert.equal(model.steps[1].status, "pending")
  assert.equal(model.primaryAction?.kind, "go_to_billing")
  assert.equal(model.primaryAction?.label, "Emitir nota de crédito")
})

// 2. transferencia + NC autorizada -> Paso 2: Registrar reintegro
test("2. transferencia + NC autorizada -- Paso 2 de 2: Registrar reintegro, importe final", () => {
  const model = getCancellationPanelViewModel(
    order({
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
  assert.equal(model.state, "register_external_refund")
  assert.equal(model.currentStepIndex, 2)
  assert.equal(model.steps[0].status, "done")
  assert.equal(model.steps[1].status, "pending")
  assert.equal(model.primaryAction?.kind, "register_external_refund")
  assert.equal(model.amounts.amountToRefund, 30000)
  assert.equal(model.amounts.amountIsFinal, true)
})

// 3. transferencia sin factura -- Fase 4 punto 1: commit_order_refund_proof
// ahora calcula el monto reintegrable sin exigir una NC autorizada, así que
// esto ya no es un callejón sin salida ("blocked"): hay una acción real
// ("Registrar reintegro") que el backend puede completar.
test("3. transferencia sin factura -- un solo paso, con camino real para registrar el reintegro", () => {
  const model = getCancellationPanelViewModel(
    order({ credit_note_required: false, invoice_status: null, invoice_cae: null }),
  )
  assert.equal(model.state, "register_external_refund")
  assert.equal(model.steps.length, 1, "sin NC requerida, el flujo es de un solo paso")
  assert.equal(model.steps[0].key, "refund")
  assert.equal(model.steps[0].status, "pending")
  assert.equal(model.primaryAction?.kind, "register_external_refund")
  assert.equal(model.amounts.amountToRefund, 30000)
  assert.equal(model.amounts.amountIsFinal, true, "payment_confirmed_amount ya es server-side y final")
})

// 4. MP listo -> botón refund
test("4. Mercado Pago listo -- botón para reintegrar", () => {
  const model = getCancellationPanelViewModel(
    order({ payment_method_id: "mercadopago", credit_note_required: false, invoice_status: null, invoice_cae: null }),
  )
  assert.equal(model.state, "execute_mp_refund")
  assert.equal(model.primaryAction?.kind, "execute_mp_refund")
  assert.equal(model.amounts.amountIsFinal, true)
})

// 5. MP processing -> procesando, sin botón activo (state=none, statusNote informativo)
test("5. Mercado Pago 'processing' -- muestra procesando, sin segundo botón", () => {
  const model = getCancellationPanelViewModel(
    order({
      payment_method_id: "mercadopago",
      credit_note_required: false,
      invoice_status: null,
      invoice_cae: null,
      mercadopago_order_refunds: [{ status: "processing", created_at: "2026-09-02T00:00:00.000Z" }],
    }),
  )
  assert.equal(model.state, "none")
  assert.equal(model.primaryAction, null)
  assert.equal(model.statusNote, "Procesando el reintegro con Mercado Pago...")
})

// 6. MP needs_reconciliation -> revisión
test("6. Mercado Pago needs_reconciliation -- muestra revisión, paso en 'attention'", () => {
  const model = getCancellationPanelViewModel(
    order({
      payment_method_id: "mercadopago",
      mercadopago_order_refunds: [{ status: "needs_reconciliation", created_at: "2026-09-02T00:00:00.000Z" }],
    }),
  )
  assert.equal(model.state, "reconcile_mp_refund")
  assert.equal(model.primaryAction?.kind, "reconcile_mp_refund")
  assert.equal(model.badgeTone, "danger")
  const refundStep = model.steps.find((step) => step.key === "refund")
  assert.equal(refundStep?.status, "attention")
})

// 7. refunded -> proceso finalizado
test("7. refunded -- proceso finalizado, sin acción, todos los pasos en done", () => {
  const model = getCancellationPanelViewModel(order({ financial_status: "refunded" }))
  assert.equal(model.state, "completed")
  assert.equal(model.isFinished, true)
  assert.equal(model.primaryAction, null)
  assert.ok(model.steps.every((step) => step.status === "done"))
  assert.equal(model.badgeTone, "success")
})

// 8. 100% saldo -> no muestra reintegro externo
test("8. 100% saldo -- externalPaid=0, sin reintegro externo pendiente", () => {
  const model = getCancellationPanelViewModel(
    order({
      payment_method_id: "customer_credit",
      financial_status: "cancelled",
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: 0,
      credit_note_required: false,
    }),
  )
  assert.equal(model.state, "none")
  assert.equal(model.amounts.externalPaid, 0)
  assert.equal(model.paymentMethod, "saldo")
  assert.equal(model.primaryAction, null)
})

// 9. saldo + transferencia -> saldo restaurado + importe externo correcto
test("9. saldo $20k + transferencia $30k -- desglose correcto de importes", () => {
  const model = getCancellationPanelViewModel(
    order({ total: 50000, payment_confirmed_amount: 30000, payment_method_id: "transferencia" }),
  )
  assert.equal(model.amounts.orderTotal, 50000)
  assert.equal(model.amounts.externalPaid, 30000)
  assert.equal(model.amounts.balanceRestored, 20000)
  assert.equal(model.paymentMethod, "saldo_transferencia")
})

// 10. saldo + MP -- mismo principio
test("10. saldo $20k + Mercado Pago $30k -- mismo desglose, método combinado", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 50000,
      payment_confirmed_amount: 30000,
      payment_method_id: "mercadopago",
      credit_note_required: false,
      invoice_status: null,
      invoice_cae: null,
    }),
  )
  assert.equal(model.amounts.balanceRestored, 20000)
  assert.equal(model.paymentMethod, "saldo_mercadopago")
  assert.equal(model.state, "execute_mp_refund")
})

// 11. el importe financiero nunca es editable -- el modelo no expone ningún campo de edición
test("11. el view model no tiene ningún campo editable para el importe (sólo lectura)", () => {
  const model = getCancellationPanelViewModel(order())
  const amountKeys = Object.keys(model.amounts)
  assert.deepEqual(
    amountKeys.sort(),
    ["amountFromCreditNote", "amountIsFinal", "amountToRefund", "balanceRestored", "externalPaid", "orderTotal"].sort(),
  )
  // Ninguna clave sugiere edición (amountInput, editableAmount,
  // amountOverride, etc.) -- se compara por PALABRA completa dentro del
  // camelCase, no por substring: "amountFromCreditNote" no debe fallar sólo
  // porque "Credit" contiene las letras "edit" en el medio.
  const suspiciousWords = new Set(["edit", "editable", "input", "override"])
  const camelCaseWords = (key: string) =>
    key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
  assert.ok(!amountKeys.some((key) => camelCaseWords(key).some((word) => suspiciousWords.has(word))))
})

// 12. la acción visible coincide con getCancellationNextAction
test("12. primaryAction.kind siempre corresponde al estado de getCancellationNextAction", () => {
  const scenarios: Array<[Partial<CancellationNextActionOrder>, string]> = [
    [{}, "go_to_billing"],
    [
      {
        order_credit_notes: [
          { status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 30000 },
        ],
      },
      "register_external_refund",
    ],
    [{ payment_method_id: "mercadopago", credit_note_required: false, invoice_status: null, invoice_cae: null }, "execute_mp_refund"],
    [
      {
        payment_method_id: "mercadopago",
        mercadopago_order_refunds: [{ status: "needs_reconciliation", created_at: "2026-09-02T00:00:00.000Z" }],
      },
      "reconcile_mp_refund",
    ],
  ]

  for (const [overrides, expectedKind] of scenarios) {
    const model = getCancellationPanelViewModel(order(overrides))
    assert.equal(model.primaryAction?.kind, expectedKind)
  }
})

test("una cancelación sin pago confirmado no muestra pasos (nada pendiente)", () => {
  const model = getCancellationPanelViewModel(
    order({
      financial_status: "cancelled",
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: 0,
      credit_note_required: false,
    }),
  )
  assert.equal(model.steps.length, 0)
  assert.equal(model.currentStepIndex, null)
})

test("Mercado Pago con NC autorizada destino 'none' (fiscal-only) sigue mostrando 2 pasos, paso 1 done", () => {
  const model = getCancellationPanelViewModel(
    order({
      payment_method_id: "mercadopago",
      credit_note_required: false,
      order_credit_notes: [{ status: "authorized", destination: "none", total_amount: 50000 }],
    }),
  )
  assert.equal(model.steps.length, 2)
  assert.equal(model.steps[0].status, "done")
  assert.equal(model.state, "execute_mp_refund")
})

// Fase 4, punto 3: "saldo restaurado" debe venir del movimiento 'reversal'
// real (customer_credit_movements), calculado en
// app/api/admin/pedidos/route.ts -- nunca de la estimación
// total-externoPagado, que se desvía apenas hay descuentos/envío/ajustes
// manuales de la NC.

test("13. saldo restaurado usa el movimiento real persistido, no la estimación, cuando hubo descuento", () => {
  // Pedido de $50000 con $10000 de descuento (total ya neto de descuento) y
  // saldo usado real de $15000 -- la estimación total-externoPagado daría
  // $20000 (50000-30000), pero el movimiento reversal real es $15000.
  const model = getCancellationPanelViewModel(
    order({
      total: 50000,
      payment_confirmed_amount: 30000,
      customer_credit_restored_amount: 15000,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 15000, "usa el valor real, no 50000-30000=20000")
})

test("14. saldo restaurado usa el movimiento real cuando hubo costo de envío incluido en el total", () => {
  // Total $52000 (incluye $2000 de envío), pagó $30000 externo, el saldo
  // realmente reversado fue $22000 -- coincide con total-externo en este
  // caso, pero viene del dato real, no de la resta.
  const model = getCancellationPanelViewModel(
    order({
      total: 52000,
      payment_confirmed_amount: 30000,
      customer_credit_restored_amount: 22000,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 22000)
})

test("15. saldo parcial (no cubre todo el pedido) -- balanceRestored es el movimiento real", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 50000,
      payment_confirmed_amount: 40000,
      customer_credit_restored_amount: 10000,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 10000)
  assert.equal(model.paymentMethod, "saldo_transferencia")
})

test("16. saldo 100% -- balanceRestored es el movimiento real, sin dinero externo", () => {
  const model = getCancellationPanelViewModel(
    order({
      payment_method_id: "customer_credit",
      financial_status: "cancelled",
      payment_status: null,
      paid_at: null,
      payment_confirmed_amount: 0,
      credit_note_required: false,
      total: 50000,
      customer_credit_restored_amount: 50000,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 50000)
  assert.equal(model.amounts.externalPaid, 0)
  assert.equal(model.paymentMethod, "saldo")
})

test("17. saldo + transferencia -- balanceRestored real, aunque difiera de total-externoPagado", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 50000,
      payment_confirmed_amount: 30000,
      payment_method_id: "transferencia",
      customer_credit_restored_amount: 19500,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 19500)
  assert.equal(model.paymentMethod, "saldo_transferencia")
})

test("18. saldo + Mercado Pago -- balanceRestored real, aunque difiera de total-externoPagado", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 50000,
      payment_confirmed_amount: 30000,
      payment_method_id: "mercadopago",
      credit_note_required: false,
      invoice_status: null,
      invoice_cae: null,
      customer_credit_restored_amount: 19500,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 19500)
  assert.equal(model.paymentMethod, "saldo_mercadopago")
})

test("19. sin saldo usado (customer_credit_restored_amount=null) -- cae a la estimación total-externo", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 30000,
      payment_confirmed_amount: 30000,
      customer_credit_restored_amount: null,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number | null }),
  )
  assert.equal(model.amounts.balanceRestored, 0)
  assert.equal(model.paymentMethod, "transferencia")
})

test("21. amountFromCreditNote distingue el origen del importe en register_external_refund", () => {
  const withNote = getCancellationPanelViewModel(
    order({
      order_credit_notes: [
        { status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 30000 },
      ],
    }),
  )
  assert.equal(withNote.amounts.amountFromCreditNote, true)

  const withoutNote = getCancellationPanelViewModel(
    order({ credit_note_required: false, invoice_status: null, invoice_cae: null }),
  )
  assert.equal(withoutNote.amounts.amountFromCreditNote, false)

  const notApplicable = getCancellationPanelViewModel(order())
  assert.equal(notApplicable.amounts.amountFromCreditNote, false)
})

test("20. customer_credit_restored_amount=0 se respeta como valor real (no se confunde con 'sin dato')", () => {
  const model = getCancellationPanelViewModel(
    order({
      total: 30000,
      payment_confirmed_amount: 30000,
      customer_credit_restored_amount: 0,
    } as Partial<CancellationNextActionOrder> & { customer_credit_restored_amount: number }),
  )
  assert.equal(model.amounts.balanceRestored, 0)
})
