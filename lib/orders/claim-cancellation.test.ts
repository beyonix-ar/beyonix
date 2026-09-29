import assert from "node:assert/strict"
import test from "node:test"

import {
  describeClaimCancellationBlockers,
  getClaimCancellationBlockerViews,
  getClaimCancellationPreview,
  parseClaimCancellationBlockerCodes,
} from "./claim-cancellation.ts"

// "Cancelar reclamo": cada bloqueo dice qué pasa y lleva al paso y al control
// exactos donde se resuelve. Nunca sólo "tenés que resolver X".

const base = { plan: "cambio_directo" as const, legDirection: "cambio" as const, incidentOnUnits: false, hasExecutionStep: false }

test("reserva activa: 'Hay un reemplazo reservado.' + 'Ir a liberar reserva' al paso del método", () => {
  const [exchange] = getClaimCancellationBlockerViews(["reservation"], base)
  assert.deepEqual(exchange, { code: "reservation", text: "Hay un reemplazo reservado.", actionLabel: "Ir a liberar reserva", step: "logistics", focus: "release_reservation" })
  const [resend] = getClaimCancellationBlockerViews(["reservation"], { ...base, plan: "retiro_y_reenvio", legDirection: "reemplazo" })
  assert.equal(resend.step, "replacement", "en retiro + reenvío la reserva está en Reenvío")
})

test("Andreani, incidencia, recepción y finanzas: cada uno con su acceso", () => {
  const views = getClaimCancellationBlockerViews(
    ["andreani_uncertain", "andreani_open", "incident", "return_in_transit", "replacement_in_transit", "inspection_pending", "credit_note_pending", "replacement_delivered"],
    { ...base, incidentOnUnits: true, hasExecutionStep: true })
  assert.deepEqual(views.map((view) => [view.code, view.actionLabel, view.step, view.focus]), [
    ["andreani_uncertain", "Ir a operación", "logistics", "reconcile"],
    ["andreani_open", "Ir a operación", "logistics", "cancel_leg"],
    ["incident", "Ir a incidencia", "reception", "incident_resolve"],
    ["return_in_transit", "Ir a recepción", "reception", "arrival_original"],
    ["replacement_in_transit", "Ir a recepción", "reception", "arrival_replacement"],
    ["inspection_pending", "Ir a recepción", "reception", "inspection"],
    ["credit_note_pending", "Ir a resolución financiera", "execution", "step"],
    ["replacement_delivered", "Ir a finalización", "finish", "step"],
  ])
  // Evento de Andreani a revisar (no incidencia de unidades): va a la operación.
  const [review] = getClaimCancellationBlockerViews(["incident"], { ...base, legDirection: "reemplazo" })
  assert.deepEqual([review.step, review.focus], ["replacement", "review_resolve"])
  // Sin paso de reintegro: lo financiero se revisa en Finalización.
  assert.equal(getClaimCancellationBlockerViews(["refund_pending"], base)[0].step, "finish")
})

test("códigos de la base: se traducen; los desconocidos no rompen y no inventan accesos", () => {
  assert.deepEqual(parseClaimCancellationBlockerCodes("reservation,andreani_open,otro_codigo"), ["reservation", "andreani_open"])
  assert.deepEqual(describeClaimCancellationBlockers("reservation,otro_codigo"), ["Hay un reemplazo reservado.", "Hay una operación pendiente de resolver."])
  assert.deepEqual(parseClaimCancellationBlockerCodes(null), [])
})

test("vista previa: mismos códigos que exige la base", () => {
  const preview = getClaimCancellationPreview({
    claimId: 9, status: "aprobado", failureType: "falla", isAdmin: true,
    units: [{ role: "original", location: "con_cliente" }, { role: "reemplazo", location: "reservada" }],
    shipments: [{ creation_status: "created", closed_at: null }],
    creditNotes: [{ claim_id: 9, status: "processing" }, { claim_id: 10, status: "authorized" }],
  })
  assert.deepEqual(preview.codes, ["andreani_open", "reservation", "credit_note_pending"])
  assert.equal(getClaimCancellationPreview({ claimId: 9, status: "rechazado", isAdmin: true }).available, false)
  assert.equal(getClaimCancellationPreview({ claimId: 9, status: "aprobado", isAdmin: false }).available, false)
})
