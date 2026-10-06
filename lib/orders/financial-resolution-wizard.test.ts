import test from "node:test"
import assert from "node:assert/strict"
import { deriveFinancialReturnContext, getFinancialResolutionMode, resolveOrderFinancialOptions, type FinancialOption, type FinancialResolutionFacts } from "./financial-resolution.ts"
import {
  buildFinancialResolvePayload, canContinueFinancialWizard, FINANCIAL_CHOICE_COPY, getFinancialHumanState,
  getFinancialMoneyOptions, getFinancialReceptionLabel, getFinancialWizardSteps, initialFinancialWizardState,
  reduceFinancialWizard, type FinancialResolutionView, type FinancialWizardAction, type FinancialWizardState,
} from "./financial-resolution-wizard.ts"

const option = (type: FinancialOption["type"]): FinancialOption => ({ type, label: FINANCIAL_CHOICE_COPY[type].label, requiresConfirmation: true })
const baseView: FinancialResolutionView = {
  mode: "wizard", amount: 25_000, status: "Pendiente", product: "no_return", reception: "not_applicable",
  financialOptions: [option("beyonix_credit"), option("mercadopago_refund")], receptionOptions: [], notice: null, resolution: null,
}
const run = (view: FinancialResolutionView, ...actions: FinancialWizardAction[]) =>
  actions.reduce<FinancialWizardState>((state, action) => reduceFinancialWizard(state, action, view), initialFinancialWizardState(view))
const returnPendingView: FinancialResolutionView = {
  ...baseView, product: "return", reception: "pending", financialOptions: [], receptionOptions: [option("beyonix_credit"), option("manual_refund")],
}

const facts: FinancialResolutionFacts = {
  paymentMethod: "mercadopago", paymentApproved: true, paymentIdValid: true, amount: 25_000, mpAmount: 25_000,
  financialStatus: "refund_pending", preparedAt: null, handedOverAt: null, trackingInCircuit: false, shipmentCreated: false,
  priorRefund: false, refundInProgress: false, fiscalConflict: false, receptionPending: false, inspectionPending: false,
  claimIncidentOpen: false, remotePaymentVerified: true, partial: false, installments: false, hasCustomerAccount: true, fiscalDestination: null,
}

test("A. producto no vuelve: Producto → Dinero → Revisar", () => {
  assert.deepEqual(getFinancialWizardSteps(baseView, { product: "no_return" }), ["product", "money", "review"])
  const state = run(baseView, { type: "next" }, { type: "choice", value: "beyonix_credit" }, { type: "next" })
  assert.equal(state.step, "review")
  assert.equal(getFinancialReceptionLabel(baseView, state), "No aplica")
})

test("B. producto vuelve y recepción registrada: no se vuelve a preguntar", () => {
  for (const reception of ["received", "exception"] as const) {
    const view = { ...baseView, product: "return" as const, reception }
    assert.deepEqual(getFinancialWizardSteps(view, { product: "return" }), ["product", "money", "review"])
    const state = run(view, { type: "next" }, { type: "choice", value: "beyonix_credit" }, { type: "next" })
    assert.equal(state.step, "review")
  }
  const context = deriveFinancialReturnContext({ handedOverAt: null, claimBlock: null, exceptionClaimIds: [],
    units: [{ claimId: 7, role: "original", location: "reincorporada_stock" }] })
  assert.deepEqual(context, { product: "return", reception: "received", claimId: 7 })
})

test("C. producto vuelve sin recibir: bloquea la resolución normal", () => {
  assert.deepEqual(getFinancialWizardSteps(returnPendingView, { product: "return" }), ["product", "money", "reception", "review"])
  const atReception = run(returnPendingView, { type: "next" }, { type: "choice", value: "manual_refund" }, { type: "next" })
  assert.equal(atReception.step, "reception")
  for (const actions of [[], [{ type: "reception", value: "yes" }], [{ type: "reception", value: "no" }]] as FinancialWizardAction[][]) {
    const state = actions.reduce((current, action) => reduceFinancialWizard(current, action, returnPendingView), atReception)
    assert.equal(canContinueFinancialWizard(returnPendingView, state), false)
    assert.equal(reduceFinancialWizard(state, { type: "next" }, returnPendingView).step, "reception")
  }
  // La API no ofrece ninguna opción ejecutable mientras falta la recepción.
  assert.deepEqual(resolveOrderFinancialOptions({ ...facts, receptionPending: true, inspectionPending: true }), [])
  const context = deriveFinancialReturnContext({ handedOverAt: null, claimBlock: "CLAIM_MONEY_RETURN_PENDING", exceptionClaimIds: [],
    units: [{ claimId: 7, role: "original", location: "en_andreani" }] })
  assert.equal(context.reception, "pending")
})

test("D. excepción sin recepción exige motivo y viaja para auditoría", () => {
  const atReception = run(returnPendingView, { type: "next" }, { type: "choice", value: "manual_refund" }, { type: "next" },
    { type: "reception", value: "no" }, { type: "exception" })
  assert.equal(canContinueFinancialWizard(returnPendingView, reduceFinancialWizard(atReception, { type: "reason", value: "corto" }, returnPendingView)), false)
  const ready = run(returnPendingView, { type: "next" }, { type: "choice", value: "manual_refund" }, { type: "next" },
    { type: "reception", value: "no" }, { type: "exception" }, { type: "reason", value: "  Cliente sin acceso a sucursal, autorizado  " }, { type: "next" })
  assert.equal(ready.step, "review")
  assert.equal(getFinancialReceptionLabel(returnPendingView, ready), "Pendiente (excepción)")
  assert.deepEqual(buildFinancialResolvePayload(returnPendingView, ready), {
    action: "resolve", choice: "manual_refund", confirmed: true, receptionExceptionReason: "Cliente sin acceso a sucursal, autorizado",
  })
  // Una excepción ya registrada en el reclamo libera el bloqueo igual que la base.
  assert.equal(deriveFinancialReturnContext({ handedOverAt: null, claimBlock: "CLAIM_MONEY_RETURN_PENDING", exceptionClaimIds: [7],
    units: [{ claimId: 7, role: "original", location: "con_cliente" }] }).reception, "exception")
})

test("E/F. Mercado Pago visible sólo cuando la API lo ofrece", () => {
  assert.deepEqual(getFinancialMoneyOptions(baseView, "no_return").map((item) => item.type), ["beyonix_credit", "mercadopago_refund"])
  const ineligible = { ...baseView, financialOptions: resolveOrderFinancialOptions({ ...facts, remotePaymentVerified: false }) }
  assert.equal(getFinancialMoneyOptions(ineligible, "no_return").some((item) => item.type === "mercadopago_refund"), false)
  assert.equal(run(ineligible, { type: "next" }, { type: "choice", value: "mercadopago_refund" }).choice, null)
  assert.equal(resolveOrderFinancialOptions({ ...facts, preparedAt: "2026-10-05T12:00:00Z" }).some((item) => item.type === "mercadopago_refund"), false)
})

test("G. transferencia: reintegro manual", () => {
  const types = resolveOrderFinancialOptions({ ...facts, paymentMethod: "transferencia" }).map((item) => item.type)
  assert.ok(types.includes("manual_refund"))
  const view = { ...baseView, financialOptions: [option("manual_refund")] }
  const state = run(view, { type: "next" }, { type: "choice", value: "manual_refund" }, { type: "next" })
  assert.deepEqual(buildFinancialResolvePayload(view, state), { action: "resolve", choice: "manual_refund", confirmed: true })
})

test("I. la NC no es una decisión del Admin", () => {
  const state = run(baseView, { type: "next" })
  const decisions = getFinancialMoneyOptions(baseView, state.product).map((item) => item.label).join(" ")
  assert.doesNotMatch(decisions, /nota de cr[eé]dito|ARCA|emitir/i)
  assert.deepEqual(getFinancialWizardSteps(baseView, state), ["product", "money", "review"])
})

test("J. resolución incompleta queda como Requiere acción", () => {
  const view: FinancialResolutionView = { ...baseView, mode: "resolution",
    resolution: { id: "r1", type: "beyonix_credit", status: "requires_action", amount: 25_000, detail: "fiscal" } }
  assert.equal(getFinancialHumanState(view), "Requiere acción")
  assert.equal(getFinancialHumanState({ ...view, resolution: { ...view.resolution!, status: "completed" } }), "Completado")
  assert.equal(getFinancialHumanState({ ...view, resolution: { ...view.resolution!, status: "processing" } }), "En proceso")
  assert.equal(getFinancialHumanState({ ...baseView, mode: "advanced", financialOptions: [] }), "Requiere acción")
  assert.equal(getFinancialHumanState(returnPendingView), "Pendiente")
})

test("K. volver entre pasos conserva las decisiones", () => {
  const review = run(returnPendingView, { type: "next" }, { type: "choice", value: "beyonix_credit" }, { type: "next" },
    { type: "reception", value: "no" }, { type: "exception" }, { type: "reason", value: "Motivo suficientemente largo" }, { type: "next" })
  const back = run(returnPendingView, { type: "next" }, { type: "choice", value: "beyonix_credit" }, { type: "next" },
    { type: "reception", value: "no" }, { type: "exception" }, { type: "reason", value: "Motivo suficientemente largo" }, { type: "next" },
    { type: "back" }, { type: "back" })
  assert.equal(back.step, "money")
  assert.deepEqual({ ...back, step: review.step }, review)
})

test("L. cambiar una decisión anterior limpia lo incompatible", () => {
  const withException = run(returnPendingView, { type: "next" }, { type: "choice", value: "manual_refund" }, { type: "next" },
    { type: "reception", value: "no" }, { type: "exception" }, { type: "reason", value: "Motivo suficientemente largo" })
  const changed = reduceFinancialWizard(withException, { type: "reception", value: "yes" }, returnPendingView)
  assert.equal(changed.exception, false)
  assert.equal(changed.exceptionReason, "")
  assert.equal(canContinueFinancialWizard(returnPendingView, changed), false)
  // Un producto que contradice lo registrado nunca se acepta (sin estados imposibles).
  assert.deepEqual(reduceFinancialWizard(withException, { type: "product", value: "no_return" }, returnPendingView), withException)
  assert.deepEqual(buildFinancialResolvePayload(returnPendingView, changed), { action: "resolve", choice: "manual_refund", confirmed: true })
})

test("salida sin devolución registrada y modo avanzado", () => {
  assert.deepEqual(deriveFinancialReturnContext({ handedOverAt: "2026-10-05T12:00:00Z", claimBlock: null, exceptionClaimIds: [], units: [] }),
    { product: "return", reception: "unavailable", claimId: null })
  assert.deepEqual(deriveFinancialReturnContext({ handedOverAt: null, claimBlock: null, exceptionClaimIds: [],
    units: [{ claimId: 3, role: "original", location: "conservada_cliente" }] }), { product: "no_return", reception: "not_applicable", claimId: 3 })
  assert.equal(getFinancialResolutionMode({ financialStatus: "refund_pending", hasResolution: false, options: [], receptionOptions: [] }), "advanced")
  assert.equal(getFinancialResolutionMode({ financialStatus: "refunded", hasResolution: false, options: [], receptionOptions: [] }), "none")
  assert.equal(getFinancialResolutionMode({ financialStatus: "refunded", hasResolution: true, options: [], receptionOptions: [] }), "resolution")
  assert.equal(getFinancialResolutionMode({ financialStatus: "refund_pending", hasResolution: false, options: [], receptionOptions: [option("beyonix_credit")] }), "wizard")
})
