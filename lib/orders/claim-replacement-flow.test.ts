import assert from "node:assert/strict"
import test from "node:test"

import {
  getClaimProgressSteps,
  getReplacementFlow,
  sumReplacedUnits,
  sumClaimReplacedUnits,
  type ReplacementFlowInput,
} from "./claim-replacement-flow.ts"

const base: ReplacementFlowInput = {
  status: "aprobado",
  resolution: "cambio_producto",
  claimedUnits: 1,
  receivedUnits: 0,
  replacedUnits: 0,
}

const states = (input: Partial<ReplacementFlowInput>) => {
  const flow = getReplacementFlow({ ...base, ...input })
  return [flow.reception, flow.replacement, flow.delivery]
}

test("cambio de producto, una unidad: recepción primero, lo demás bloqueado", () => {
  const flow = getReplacementFlow(base)
  assert.deepEqual([flow.reception, flow.replacement, flow.delivery], ["current", "pending", "pending"])
  assert.equal(flow.requiresReception, true)
  assert.equal(flow.canRegisterReplacement, false)
  assert.equal(flow.canConfirmDelivery, false)
})

test("recepción completa habilita el reemplazo; la entrega espera la salida de stock", () => {
  const flow = getReplacementFlow({ ...base, receivedUnits: 1 })
  assert.deepEqual([flow.reception, flow.replacement, flow.delivery], ["done", "current", "pending"])
  assert.equal(flow.canRegisterReplacement, true)
  assert.equal(flow.canConfirmDelivery, false)
})

test("reemplazo registrado: la entrega pasa a ser la acción actual", () => {
  const flow = getReplacementFlow({ ...base, receivedUnits: 1, replacedUnits: 1 })
  assert.deepEqual([flow.reception, flow.replacement, flow.delivery], ["done", "done", "current"])
  assert.equal(flow.canConfirmDelivery, true)
})

test("múltiples unidades con recepción y reemplazo parciales", () => {
  assert.deepEqual(states({ claimedUnits: 3, receivedUnits: 1 }), ["current", "current", "pending"])
  const flow = getReplacementFlow({ ...base, claimedUnits: 3, receivedUnits: 1, replacedUnits: 1 })
  assert.deepEqual([flow.reception, flow.replacement, flow.delivery], ["current", "current", "current"])
  assert.equal(flow.canRegisterReplacement, true)
  assert.equal(flow.canConfirmDelivery, true)
  assert.deepEqual(states({ claimedUnits: 3, receivedUnits: 3, replacedUnits: 3 }), ["done", "done", "current"])
})

test("cambio sin dato de reemplazos bloquea la confirmación de entrega", () => {
  const flow = getReplacementFlow({ ...base, receivedUnits: 1, replacedUnits: null })
  assert.equal(flow.replacement, "current")
  assert.equal(flow.canConfirmDelivery, false)
})

test("cambio: loading y error bloquean incluso si quedaron datos anteriores", () => {
  for (const replacementLoadState of ["loading", "error"] as const) {
    for (const replacedUnits of [null, 1]) {
      assert.equal(getReplacementFlow({ ...base, replacedUnits, replacementLoadState }).canConfirmDelivery, false)
    }
  }
  assert.equal(getReplacementFlow({ ...base, replacedUnits: 0, replacementLoadState: "ready" }).canConfirmDelivery, false)
  assert.equal(getReplacementFlow({ ...base, replacedUnits: 1, replacementLoadState: "ready" }).canConfirmDelivery, true)
  assert.equal(getReplacementFlow({ ...base, resolution: "envio_unidad_faltante", replacedUnits: null }).canConfirmDelivery, true)
})

test("cambio: evidencia por claim_id, pedido e ítem; fallback histórico sin ambigüedad", () => {
  const claim = { id: 3, order_id: 1, failure_type: "falla", affected_items: [{ order_item_id: 7, quantity: 1 }] }
  const row = { original_order_id: 1, original_order_item_id: 7, claim_id: 3, quantity: 1 }
  assert.equal(sumClaimReplacedUnits(null, claim, [claim]), null)
  assert.equal(sumClaimReplacedUnits([row], claim, [claim]), 1)
  for (const invalid of [{ ...row, claim_id: 9 }, { ...row, original_order_id: 2 }, { ...row, original_order_item_id: 8 }]) {
    assert.equal(sumClaimReplacedUnits([invalid], claim, [claim]), 0)
  }
  const historical = { ...row, claim_id: null }
  assert.equal(sumClaimReplacedUnits([historical], claim, [claim]), 1)
  assert.equal(sumClaimReplacedUnits([historical], claim, [claim, { ...claim, id: 9 }]), 0)
  assert.equal(sumClaimReplacedUnits([historical], { ...claim, affected_items: [] }, [claim]), 0)
  assert.equal(sumClaimReplacedUnits([{ ...row, claim_id: undefined }], claim, [claim]), 0)
  assert.equal(sumClaimReplacedUnits([row], claim, [claim, { ...claim, id: 9 }]), 1)
})

test("garantía registrada sin recepción: el reemplazo cuenta aunque falte recibir", () => {
  const flow = getReplacementFlow({ ...base, replacedUnits: 1 })
  assert.deepEqual([flow.reception, flow.replacement, flow.delivery], ["current", "done", "current"])
  assert.equal(flow.canConfirmDelivery, true)
})

test("unidad faltante: no exige recepción del original", () => {
  const flow = getReplacementFlow({ ...base, resolution: "envio_unidad_faltante" })
  assert.equal(flow.requiresReception, false)
  assert.equal(flow.reception, "done")
  assert.equal(flow.canRegisterReplacement, true)
})

test("reclamo cerrado o reemplazo enviado: entrega completa y sin acciones", () => {
  for (const status of ["cerrado", "reemplazo_enviado"]) {
    const flow = getReplacementFlow({ ...base, status, receivedUnits: 1, replacedUnits: 1 })
    assert.equal(flow.delivery, "done")
    assert.equal(flow.canRegisterReplacement, false)
    assert.equal(flow.canConfirmDelivery, false)
  }
})

test("sumReplacedUnits sólo cuenta los ítems del reclamo", () => {
  const rows = [
    { original_order_item_id: 7, quantity: 1 },
    { original_order_item_id: 7, quantity: 2 },
    { original_order_item_id: 9, quantity: 5 },
  ]
  assert.equal(sumReplacedUnits(rows, [7]), 3)
  assert.equal(sumReplacedUnits(rows, []), 0)
  assert.equal(sumReplacedUnits(null, [7]), null)
})

test("stepper: pasos según la solución y un único paso actual", () => {
  const labels = (input: Partial<Parameters<typeof getClaimProgressSteps>[0]>) =>
    getClaimProgressSteps({ ...base, creditNoteAuthorized: false, refundCompleted: false, ...input }).map(
      (step) => `${step.label}:${step.state}`,
    )

  assert.deepEqual(labels({}), ["Decisión:done", "Recepción:current", "Reemplazo:pending", "Entrega:pending"])
  assert.deepEqual(labels({ receivedUnits: 1, replacedUnits: 1 }), [
    "Decisión:done",
    "Recepción:done",
    "Reemplazo:done",
    "Entrega:current",
  ])
  assert.deepEqual(labels({ status: "cerrado", receivedUnits: 1, replacedUnits: 1 }), [
    "Decisión:done",
    "Recepción:done",
    "Reemplazo:done",
    "Entrega:done",
  ])
  assert.deepEqual(labels({ resolution: "envio_unidad_faltante" }), [
    "Decisión:done",
    "Reemplazo:current",
    "Entrega:pending",
  ])
  assert.deepEqual(labels({ resolution: "reintegro_total", receivedUnits: 1, creditNoteAuthorized: true }), [
    "Decisión:done",
    "Recepción:done",
    "Nota de crédito:done",
    "Reintegro:current",
  ])
  assert.deepEqual(labels({ resolution: null, status: "en_revision" }), ["Decisión:current", "Recepción:pending"])
})
