import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  CLAIM_RESOLUTION_REQUIREMENTS,
  CLAIM_SOLUTION_OPTIONS,
  FINANCIAL_CLAIM_RESOLUTIONS,
  claimAllowsCreditNote,
  getClaimCloseReadiness,
  getClaimCommercialStatus,
  getClaimFinancialView,
  getClaimRequirements,
  getClaimReturnSummary,
} from "./claim-policy.ts"
import { getCreditNoteClaimPolicyError, isClaimEligibleForCreditNote } from "./credit-note-claim-policy.ts"
import { getCustomerClaimHeadline } from "./claim-shipment-view.ts"

// Matriz de resoluciones: única fuente de verdad de qué activa cada solución.
// Si alguien cambia la UI o agrega una resolución, estos casos fijan el contrato.

test("REEMPLAZO: envío, devolución a criterio, inspección si vuelve; nunca dinero ni NC", () => {
  const replacement = getClaimRequirements("cambio_producto")
  assert.deepEqual(replacement, {
    solution: "replacement",
    label: "Reemplazo del producto",
    returnPolicy: "optional",
    inspectionWhenReturned: true,
    outboundShipment: true,
    financialAction: "none",
    requiresCreditNote: false,
    requiresAmountOnApproval: false,
  })
})

test("UNIDAD FALTANTE: envío sin devolución ni inspección, sin dinero", () => {
  const missing = getClaimRequirements("envio_unidad_faltante")
  assert.equal(missing?.returnPolicy, "none")
  assert.equal(missing?.inspectionWhenReturned, false)
  assert.equal(missing?.outboundShipment, true)
  assert.equal(missing?.requiresCreditNote, false)
})

test("REINTEGRO (total y parcial): devolución económica con NC, sin envío", () => {
  for (const resolution of ["reintegro_total", "reintegro_parcial"]) {
    const refund = getClaimRequirements(resolution)
    assert.equal(refund?.solution, "refund", resolution)
    assert.equal(refund?.financialAction, "refund", resolution)
    assert.equal(refund?.requiresCreditNote, true, resolution)
    assert.equal(refund?.outboundShipment, false, resolution)
    assert.equal(refund?.returnPolicy, "optional", resolution)
  }
})

test("SALDO A FAVOR: crédito al cliente con NC; el saldo por diferencia pide monto", () => {
  for (const resolution of ["saldo_a_favor", "cupon_descuento"]) {
    const credit = getClaimRequirements(resolution)
    assert.equal(credit?.financialAction, "customer_credit", resolution)
    assert.equal(credit?.requiresCreditNote, true, resolution)
    assert.equal(credit?.outboundShipment, false, resolution)
    assert.equal(credit?.label, "Saldo a favor", resolution)
  }
  assert.equal(getClaimRequirements("cupon_descuento")?.requiresAmountOnApproval, true)
  assert.equal(getClaimRequirements("saldo_a_favor")?.requiresAmountOnApproval, false)
})

test("OTRA SOLUCIÓN y sin decidir: nada se activa", () => {
  const other = getClaimRequirements("otro")
  assert.equal(other?.financialAction, "none")
  assert.equal(other?.outboundShipment, false)
  assert.equal(getClaimRequirements(null), null)
  assert.equal(getClaimRequirements("rechazado"), null)
  assert.equal(getClaimRequirements("inventada"), null)
})

test("las opciones comerciales del Admin son soluciones, no logística ni fiscalidad", () => {
  assert.deepEqual(CLAIM_SOLUTION_OPTIONS.map((option) => option.label),
    ["Reemplazar producto", "Enviar unidad faltante", "Reintegrar dinero", "Dar saldo a favor"])
  assert.ok(CLAIM_SOLUTION_OPTIONS.every((option) => !/nota de crédito|devoluci/i.test(option.label)))
})

test("NOTA DE CRÉDITO: sólo con dinero de por medio (o una cancelación)", () => {
  assert.equal(claimAllowsCreditNote({ resolution: "cambio_producto" }), false)
  assert.equal(claimAllowsCreditNote({ resolution: "envio_unidad_faltante" }), false)
  assert.equal(claimAllowsCreditNote({ resolution: "otro" }), false)
  assert.equal(claimAllowsCreditNote({ resolution: "reintegro_parcial" }), true)
  assert.equal(claimAllowsCreditNote({ resolution: "saldo_a_favor" }), true)
  assert.equal(claimAllowsCreditNote({ resolution: null, failure_type: "cancelar_compra" }), true)

  // Reemplazo aprobado: el asistente de Facturación no lo toma como reclamo vinculado.
  assert.equal(isClaimEligibleForCreditNote({ status: "aprobado", resolution: "cambio_producto", failure_type: "falla" }), false)
  assert.equal(isClaimEligibleForCreditNote({ status: "reemplazo_enviado", resolution: "cambio_producto", failure_type: "falla" }), false)
  assert.equal(isClaimEligibleForCreditNote({ status: "reintegro_pendiente", resolution: "reintegro_total", failure_type: "falla" }), true)

  const error = getCreditNoteClaimPolicyError({
    operationType: "devolucion_parcial",
    actorRole: "admin",
    orderId: 1,
    orderUserId: "u",
    claim: { id: 9, order_id: 1, user_id: "u", status: "aprobado", failure_type: "falla", resolution: "cambio_producto", affected_items: [] },
    selectedItems: [],
  })
  assert.match(error ?? "", /no corresponde nota de crédito/)
})

test("la guarda SQL de NC usa exactamente las mismas resoluciones económicas", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261019120000_claim_policy_consolidation.sql", import.meta.url), "utf8")
  const body = sql.slice(sql.indexOf("function public.claim_resolution_allows_credit_note"), sql.indexOf("create or replace function public.guard_claim_credit_note_resolution"))
  const listed = [...body.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).filter((value) => value !== "cancelar_compra")
  assert.deepEqual([...listed].sort(), [...FINANCIAL_CLAIM_RESOLUTIONS].sort())
})

test("el resumen congelado para el cliente usa los nombres de la matriz (sin conceptos fiscales)", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/20261019120000_claim_policy_consolidation.sql", import.meta.url), "utf8")
  const summary = sql.slice(sql.indexOf("function public.build_order_claim_resolution_summary"))
  for (const resolution of ["cambio_producto", "envio_unidad_faltante", "reintegro_total", "reintegro_parcial", "saldo_a_favor", "otro"] as const) {
    assert.ok(summary.includes(`'${CLAIM_RESOLUTION_REQUIREMENTS[resolution].label}'`), resolution)
  }
  assert.ok(!summary.includes("'Nota de crédito'"), "el cliente nunca ve 'Nota de crédito' como resolución")
})

test("producto que vuelve o no: lo decide la logística, no la solución", () => {
  assert.equal(getClaimReturnSummary("cambio_producto", null), "A definir")
  assert.equal(getClaimReturnSummary("cambio_producto", "retiro_y_reenvio"), "Vuelve a BEYONIX")
  assert.equal(getClaimReturnSummary("cambio_producto", "cambio_directo"), "Vuelve a BEYONIX")
  assert.equal(getClaimReturnSummary("cambio_producto", "reenvio_sin_devolucion"), "No vuelve")
  assert.equal(getClaimReturnSummary("reintegro_total", null), "Sin devolución")
  assert.equal(getClaimReturnSummary("reintegro_total", "retiro"), "Vuelve a BEYONIX")
  assert.equal(getClaimReturnSummary("envio_unidad_faltante", null), "No vuelve")
})

const note = (overrides: Record<string, unknown>) => ({
  claim_id: 7, status: "authorized", destination: "external_refund", settlement_status: "pendiente", total_amount: 1000, ...overrides,
})

test("bloque financiero: sólo si la solución mueve dinero; estado y monto de las NC del reclamo", () => {
  assert.equal(getClaimFinancialView({ claimId: 7, resolution: "cambio_producto", creditNotes: [note({})] }), null)
  const pending = getClaimFinancialView({ claimId: 7, resolution: "reintegro_total", paymentMethodId: "transferencia", creditNotes: [] })
  assert.deepEqual({ stage: pending?.stage, label: pending?.stageLabel, amount: pending?.amount, method: pending?.methodLabel },
    { stage: "pending", label: "Pendiente", amount: null, method: "Transferencia" })
  const processing = getClaimFinancialView({ claimId: 7, resolution: "reintegro_parcial", creditNotes: [note({ total_amount: "1500.5" }), note({ claim_id: 8 })] })
  assert.equal(processing?.stage, "processing")
  assert.equal(processing?.amount, 1500.5, "sólo las NC de este reclamo")
  const done = getClaimFinancialView({ claimId: 7, resolution: "saldo_a_favor", creditNotes: [note({ destination: "customer_balance", settlement_status: "completado" })] })
  assert.deepEqual({ stage: done?.stage, label: done?.stageLabel, title: done?.title }, { stage: "done", label: "Acreditado", title: "Saldo a favor" })
})

const closeFacts = {
  status: "aprobado",
  replacedUnits: 1,
  replacementVerified: true,
  logisticsResolved: true,
  financial: null,
}

test("CIERRE reemplazo: con reemplazo registrado y logística resuelta; nunca antes", () => {
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "cambio_producto" }),
    { action: "confirm_delivery", canClose: true, blockers: [] })
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "cambio_producto", replacedUnits: 0 })?.blockers, ["Falta registrar el reemplazo"])
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "cambio_producto", logisticsResolved: false })?.blockers, ["Logística pendiente"])
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "cambio_producto", replacementVerified: false })?.canClose, false)
  // Unidad faltante histórica sin dato de reemplazo: se puede confirmar.
  assert.equal(getClaimCloseReadiness({ ...closeFacts, resolution: "envio_unidad_faltante", replacedUnits: null, logisticsResolved: null })?.canClose, true)
})

test("CIERRE reintegro: sólo con la NC liquidada y el pedido reintegrado", () => {
  const pending = getClaimFinancialView({ claimId: 7, resolution: "reintegro_total", creditNotes: [note({})] })
  const settled = getClaimFinancialView({ claimId: 7, resolution: "reintegro_total", creditNotes: [note({ settlement_status: "completado" })] })
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "reintegro_total", financial: pending, orderRefunded: false }),
    { action: "mark_refund_done", canClose: false, blockers: ["Reintegro pendiente", "Falta registrar el reintegro"] })
  assert.equal(getClaimCloseReadiness({ ...closeFacts, resolution: "reintegro_total", financial: settled, orderRefunded: true })?.canClose, true)
})

test("CIERRE saldo: sólo acreditado; otra solución cierra simple", () => {
  const credited = getClaimFinancialView({ claimId: 7, resolution: "cupon_descuento", creditNotes: [note({ destination: "customer_balance", settlement_status: "completado" })] })
  assert.deepEqual(getClaimCloseReadiness({ ...closeFacts, resolution: "cupon_descuento", financial: credited }),
    { action: "mark_credit_issued", canClose: true, blockers: [] })
  assert.equal(getClaimCloseReadiness({ ...closeFacts, resolution: "saldo_a_favor", financial: null })?.canClose, false)
  assert.equal(getClaimCloseReadiness({ ...closeFacts, resolution: "otro", logisticsResolved: null })?.action, "close")
  assert.equal(getClaimCloseReadiness({ ...closeFacts, status: "cerrado", resolution: "otro" }), null)
})

test("estado comercial: separado del estado logístico de Andreani", () => {
  const status = (input: Partial<Parameters<typeof getClaimCommercialStatus>[0]>) =>
    getClaimCommercialStatus({ status: "aprobado", resolution: "cambio_producto", ...input })
  assert.equal(status({ status: "en_revision" }), "En revisión")
  assert.equal(status({ logisticsPending: true }), "Definir logística")
  assert.equal(status({ logisticsStep: "logistics" }), "Reemplazo en proceso")
  assert.equal(status({ resolution: "reintegro_total", logisticsStep: "logistics" }), "Esperando devolución")
  assert.equal(status({ logisticsStep: "reception" }), "Inspección pendiente")
  assert.equal(status({ close: { action: "confirm_delivery", canClose: true, blockers: [] } }), "Listo para finalizar")
  assert.equal(status({ resolution: "saldo_a_favor" }), "Saldo pendiente")
  assert.equal(status({ status: "cerrado", cancelled: true }), "Cancelado")
  assert.equal(status({ status: "cerrado" }), "Resuelto")
})

test("cliente: una frase por momento, sin datos internos", () => {
  const leg = (direction: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id: 1, direction, status, ...extra }) as never
  const headline = (claim: Partial<Parameters<typeof getCustomerClaimHeadline>[0]>) =>
    getCustomerClaimHeadline({ status: "aprobado", resolution: "cambio_producto", ...claim })
  assert.equal(headline({ status: "en_revision" }), "Recibimos tu reclamo")
  assert.equal(headline({ order_claim_shipments: [leg("devolucion", "generada")] }), "Esperamos que lleves el producto a Andreani")
  assert.equal(headline({ order_claim_shipments: [leg("devolucion", "en_transito")] }), "Tu producto está en camino a BEYONIX")
  assert.equal(headline({ order_claim_shipments: [leg("devolucion", "entregada", { closed_at: "x" })] }), "Recibimos tu producto: preparando tu reemplazo")
  assert.equal(headline({ order_claim_shipments: [leg("reemplazo", "en_transito")] }), "Tu reemplazo está en camino")
  assert.equal(headline({ status: "cerrado", order_claim_shipments: [leg("reemplazo", "entregada", { closed_at: "x" })] }), "Tu reemplazo fue entregado")
  assert.equal(headline({ resolution: "reintegro_total" }), "Estamos procesando tu reintegro")
  assert.equal(headline({ status: "cerrado", resolution: "reintegro_total" }), "Tu reintegro fue procesado")
  assert.equal(headline({ status: "cerrado", resolution: "saldo_a_favor" }), "Tu saldo a favor fue acreditado")
})
