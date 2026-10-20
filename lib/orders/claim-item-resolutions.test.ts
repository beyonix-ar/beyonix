import assert from "node:assert/strict"
import test from "node:test"

import {
  CLAIM_SOLUTION_OPTIONS,
  claimAllowsCreditNote,
  getClaimCloseReadiness,
  getClaimCommercialStatus,
  getClaimCreditableQuantities,
  getClaimLinesSummary,
  getClaimOperationalResolution,
  getClaimRequirements,
  getClaimResolutionLines,
  getClaimResolutionLinesError,
  getMixedClaimView,
  getReplacementSwitchState,
  type ClaimCreditNoteFact,
  type ClaimItemResolutionRow,
} from "./claim-policy.ts"
import { getCreditNoteClaimPolicyError } from "./credit-note-claim-policy.ts"
import { getClaimReplacedUnitsByItem } from "./claim-replacement-flow.ts"
import { getCustomerClaimHeadline } from "./claim-shipment-view.ts"

// Resolución por producto/unidad (reclamo mixto) sobre la política central.
// Pedido: ítem 1 = Auricular x2 reclamados; ítem 2 = Encendedor x1.
// La base exige lo mismo (lib/orders/claim-item-resolutions-sql.test.ts).

const AURICULAR = 1
const ENCENDEDOR = 2
const line = (order_item_id: number, solution: ClaimItemResolutionRow["solution"], quantity: number): ClaimItemResolutionRow =>
  ({ order_item_id, solution, quantity })
const note = (destination: string, items: Array<[number, number]>, overrides: Partial<ClaimCreditNoteFact> = {}): ClaimCreditNoteFact => ({
  claim_id: 7, status: "authorized", destination, settlement_status: "completado", total_amount: 1,
  order_credit_note_items: items.map(([order_item_id, quantity]) => ({ order_item_id, quantity })), ...overrides,
})
const view = (input: {
  affected: Array<{ order_item_id: number; quantity: number }>
  lines: ClaimItemResolutionRow[]
  replaced?: Array<[number, number]> | null
  delivered?: Array<[number, number]> | null
  notes?: ClaimCreditNoteFact[]
}) => getMixedClaimView({
  claimId: 7,
  affectedItems: input.affected,
  lines: input.lines,
  replacedByItem: input.replaced === null ? null : new Map(input.replaced ?? []),
  deliveredByItem: input.delivered ? new Map(input.delivered) : null,
  creditNotes: input.notes ?? [],
})
const closeOf = (mixed: ReturnType<typeof view>, logisticsResolved: boolean | null = true) =>
  getClaimCloseReadiness({ status: "aprobado", resolution: "mixta", replacedUnits: null, replacementVerified: true, logisticsResolved, financial: null, mixed })

test("A/B/C: un reclamo simple sigue siendo su resolución global sobre todas las unidades (compatibilidad)", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 1 }]
  assert.deepEqual(getClaimResolutionLines({ resolution: "cambio_producto", affected_items: affected }), [line(AURICULAR, "replacement", 1)])
  assert.deepEqual(getClaimResolutionLines({ resolution: "reintegro_total", affected_items: affected }), [line(AURICULAR, "refund", 1)])
  assert.deepEqual(getClaimResolutionLines({ resolution: "saldo_a_favor", affected_items: affected }), [line(AURICULAR, "credit", 1)])
  assert.deepEqual(getClaimResolutionLines({ resolution: "otro", affected_items: affected }), [], "otra solución no mueve unidades")
  assert.deepEqual(getClaimResolutionLines({ resolution: null, affected_items: affected }), [])
  // Las reglas de siempre no cambian: un simple nunca usa el cierre mixto.
  assert.equal(getClaimCloseReadiness({ status: "aprobado", resolution: "cambio_producto", replacedUnits: 1, replacementVerified: true, logisticsResolved: true, financial: null })?.action, "confirm_delivery")
  assert.equal(getClaimOperationalResolution("reintegro_total", []), "reintegro_total")
  assert.deepEqual([...getClaimCreditableQuantities({ resolution: "reintegro_total", affected_items: affected }, "external_refund")], [[AURICULAR, 1]])
})

test("D: Auricular x2 = 1 reemplazo + 1 reintegro; cada línea muestra qué falta", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 2 }]
  const lines = [line(AURICULAR, "replacement", 1), line(AURICULAR, "refund", 1)]
  assert.equal(getClaimResolutionLinesError(affected, lines, { initial: true }), null)
  assert.equal(getClaimLinesSummary(lines), "1 reemplazo · 1 reintegro")
  assert.equal(getClaimOperationalResolution("mixta", lines), "cambio_producto", "lo físico sigue el circuito del reemplazo")

  const pending = view({ affected, lines, replaced: [], delivered: [] })
  assert.deepEqual(pending.items[0].lines.map((row) => [row.label, row.quantity, row.stage, row.missing]), [
    ["Reemplazo", 1, "pending", "Registrar reemplazo"],
    ["Reintegro", 1, "pending", "Calcular reintegro"],
  ])
  assert.deepEqual(pending.creditNotePending, { refund: 1, credit: 0 })
  assert.equal(closeOf(pending)?.canClose, false)

  // 7. Stock mixto: una sola unidad nueva; la otra nunca se reemplaza.
  assert.deepEqual([...getClaimCreditableQuantities({ resolution: "mixta", affected_items: affected, order_claim_item_resolutions: lines }, "external_refund")], [[AURICULAR, 1]])
  assert.deepEqual([...getClaimCreditableQuantities({ resolution: "mixta", affected_items: affected, order_claim_item_resolutions: lines }, "customer_balance")], [])
})

test("E/P: dos productos (A reemplazo, B saldo); el reclamo cierra sólo cuando ambas ramas terminan", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 1 }, { order_item_id: ENCENDEDOR, quantity: 1 }]
  const lines = [line(AURICULAR, "replacement", 1), line(ENCENDEDOR, "credit", 1)]
  const replacementDone = view({ affected, lines, replaced: [[AURICULAR, 1]], delivered: [[AURICULAR, 1]] })
  assert.deepEqual(replacementDone.items.map((item) => item.complete), [true, false])
  assert.deepEqual(closeOf(replacementDone)?.blockers, ["Saldo pendiente de acreditar"])
  assert.equal(getClaimCommercialStatus({ status: "aprobado", resolution: "mixta", close: closeOf(replacementDone) }), "Solución por producto en proceso")

  const allDone = view({ affected, lines, replaced: [[AURICULAR, 1]], delivered: [[AURICULAR, 1]], notes: [note("customer_balance", [[ENCENDEDOR, 1]])] })
  assert.deepEqual(closeOf(allDone), { action: "close", canClose: true, blockers: [] })
  assert.equal(getClaimCommercialStatus({ status: "aprobado", resolution: "mixta", close: closeOf(allDone) }), "Listo para finalizar")
  assert.deepEqual(closeOf(allDone, false)?.blockers, ["Logística pendiente"], "la logística sigue siendo una condición del cierre")
})

test("5: reemplazo entregado completo + reintegro pendiente -> abierto; reintegro terminado -> listo", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 1 }, { order_item_id: ENCENDEDOR, quantity: 1 }]
  const lines = [line(AURICULAR, "replacement", 1), line(ENCENDEDOR, "refund", 1)]
  const base = { affected, lines, replaced: [[AURICULAR, 1]] as Array<[number, number]>, delivered: [[AURICULAR, 1]] as Array<[number, number]> }
  const processing = view({ ...base, notes: [note("external_refund", [[ENCENDEDOR, 1]], { settlement_status: "pendiente" })] })
  assert.deepEqual(processing.items[1].lines[0], { solution: "refund", label: "Reintegro", quantity: 1, stage: "processing", stageLabel: "En proceso", missing: "Registrar el reintegro" })
  assert.equal(closeOf(processing)?.canClose, false)
  assert.equal(closeOf(view({ ...base, notes: [note("external_refund", [[ENCENDEDOR, 1]])] }))?.canClose, true)
})

test("F: resolución parcial -> queda una unidad sin solución y el reclamo no puede cerrar", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 2 }]
  const lines = [line(AURICULAR, "refund", 1)]
  assert.equal(getClaimResolutionLinesError(affected, lines, { initial: true }), null, "una unidad puede quedar para definir después")
  const partial = view({ affected, lines, notes: [note("external_refund", [[AURICULAR, 1]])] })
  assert.equal(partial.items[0].unresolved, 1)
  assert.deepEqual(closeOf(partial)?.blockers, ["Unidades sin solución"])
})

test("G: más unidades que las reclamadas -> rechazado (mismas reglas que la base)", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 2 }]
  assert.match(getClaimResolutionLinesError(affected, [line(AURICULAR, "replacement", 2), line(AURICULAR, "refund", 1)], { initial: true }) ?? "", /más unidades/)
  assert.match(getClaimResolutionLinesError(affected, [line(ENCENDEDOR, "refund", 1), line(AURICULAR, "refund", 1)], { initial: true }) ?? "", /no forma parte/)
  assert.match(getClaimResolutionLinesError(affected, [line(AURICULAR, "refund", 1), line(AURICULAR, "refund", 1)], { initial: true }) ?? "", /una sola vez/)
  assert.match(getClaimResolutionLinesError(affected, [line(AURICULAR, "refund", 0)], { initial: true }) ?? "", /cantidades/)
  assert.match(getClaimResolutionLinesError(affected, [line(AURICULAR, "replacement", 2)], { initial: true }) ?? "", /una sola solución/)
  assert.equal(getClaimResolutionLinesError(affected, [line(AURICULAR, "replacement", 2)], { initial: false }), null, "completar un mixto existente sí")
})

const switchState = (input: Partial<Parameters<typeof getReplacementSwitchState>[0]>) => getReplacementSwitchState({
  status: "aprobado",
  resolution: "cambio_producto",
  lines: [line(AURICULAR, "replacement", 2)],
  orderItemId: null,
  shipments: [],
  units: [],
  replacedByItem: new Map(),
  ...input,
})
const unit = (location: string, extra: Record<string, unknown> = {}) => ({ role: "reemplazo", location, order_item_id: AURICULAR, ...extra })

test("H: reemplazo sin stock antes de reservar -> puede pasar a reintegro o saldo", () => {
  assert.deepEqual(switchState({}), { available: true, blocker: null })
  assert.equal(switchState({ resolution: "reintegro_total" }).available, false, "sólo un reemplazo")
  assert.equal(switchState({ status: "cerrado" }).available, false)
})

test("I: reemplazo reservado y reversible -> disponible (la base libera la reserva)", () => {
  assert.equal(switchState({ units: [unit("reservada"), unit("reservada")], replacedByItem: new Map([[AURICULAR, 2]]) }).available, true)
  assert.match(switchState({ replacedByItem: new Map([[AURICULAR, 1]]) }).blocker ?? "", /sin una reserva/,
    "un reemplazo sin unidades liberables (histórico) no se revierte solo")
})

test("J: reemplazo ya despachado -> NO puede pasar a reintegro", () => {
  assert.match(switchState({ units: [unit("en_andreani")], replacedByItem: new Map([[AURICULAR, 1]]) }).blocker ?? "", /ya salió/)
  assert.match(switchState({ units: [unit("reservada", { shipment_id: 4 })], replacedByItem: new Map([[AURICULAR, 1]]) }).blocker ?? "", /ya salió/)
  assert.match(switchState({ shipments: [{ direction: "reemplazo", status: "generada", creation_status: "created" }] }).blocker ?? "", /ya salió/)
  assert.equal(switchState({ shipments: [{ direction: "reemplazo", status: "pendiente", creation_status: "not_started" }] }).available, true,
    "un envío pendiente que nunca llegó a Andreani todavía se puede cancelar")
  // Mixto: se cambia la línea de un producto.
  const mixed = { resolution: "mixta", lines: [line(AURICULAR, "replacement", 1), line(AURICULAR, "refund", 1)] }
  assert.equal(switchState({ ...mixed, orderItemId: AURICULAR }).available, true)
  assert.equal(switchState({ ...mixed, orderItemId: null }).available, false)
})

test("K: Cambiar por otro producto = saldo a favor por el valor de los productos; nunca un pedido oculto", () => {
  const option = CLAIM_SOLUTION_OPTIONS.find((candidate) => candidate.label === "Cambiar por otro producto")
  assert.equal(option?.value, "saldo_a_favor")
  assert.match(option?.hint ?? "", /saldo a favor para realizar una nueva compra/)
  const requirements = getClaimRequirements(option?.value)
  assert.equal(requirements?.financialAction, "customer_credit", "infraestructura de customer_credit, sin un segundo circuito")
  assert.equal(requirements?.outboundShipment, false, "no envía otro producto desde postventa")
  assert.equal(requirements?.requiresAmountOnApproval, false, "el monto sale de los productos, no de un precio cargado a mano")
  assert.deepEqual([...getClaimCreditableQuantities({ resolution: "saldo_a_favor", affected_items: [{ order_item_id: AURICULAR, quantity: 2 }] }, "customer_balance")],
    [[AURICULAR, 2]])
})

test("L: la NC de un mixto toma sólo los ítems/cantidades de su solución", () => {
  const claim = {
    id: 7, order_id: 1, user_id: "u", status: "aprobado", failure_type: "falla", resolution: "mixta",
    affected_items: [{ order_item_id: AURICULAR, quantity: 2 }, { order_item_id: ENCENDEDOR, quantity: 1 }],
    order_claim_item_resolutions: [line(AURICULAR, "replacement", 1), line(AURICULAR, "refund", 1), line(ENCENDEDOR, "credit", 1)],
  }
  const error = (destination: string, selectedItems: Array<{ order_item_id: number; quantity: number }>) =>
    getCreditNoteClaimPolicyError({ operationType: "devolucion_parcial", actorRole: "admin", orderId: 1, orderUserId: "u", claim, selectedItems, destination })
  assert.equal(claimAllowsCreditNote(claim), true)
  assert.equal(error("external_refund", [{ order_item_id: AURICULAR, quantity: 1 }]), null)
  assert.match(error("external_refund", [{ order_item_id: AURICULAR, quantity: 2 }]) ?? "", /no forma parte/, "nunca la unidad reemplazada")
  assert.match(error("external_refund", [{ order_item_id: ENCENDEDOR, quantity: 1 }]) ?? "", /no forma parte/, "el saldo no se reintegra")
  assert.equal(error("customer_balance", [{ order_item_id: ENCENDEDOR, quantity: 1 }]), null)
  assert.match(error("customer_balance", []) ?? "", /Indicá los productos/, "nunca un importe suelto por todo el reclamo")
})

test("M/N: reintegro y saldo no se cuentan dos veces; el saldo va antes que el dinero externo", () => {
  const affected = [{ order_item_id: AURICULAR, quantity: 2 }]
  const lines = [line(AURICULAR, "refund", 1), line(AURICULAR, "credit", 1)]
  const waiting = view({ affected, lines })
  assert.equal(waiting.refundWaitsForCredit, true)
  const issued = view({ affected, lines, notes: [note("customer_balance", [[AURICULAR, 1]], { status: "processing", settlement_status: "pendiente" })] })
  assert.deepEqual(issued.creditNotePending, { refund: 1, credit: 0 }, "una NC en proceso ya cubre su unidad: no se ofrece otra")
  assert.equal(issued.refundWaitsForCredit, false)
  // Otro reclamo u otra solución no cubren estas unidades.
  const foreign = view({ affected, lines, notes: [note("customer_balance", [[AURICULAR, 1]], { claim_id: 99 }), note("external_refund", [[ENCENDEDOR, 1]])] })
  assert.deepEqual(foreign.creditNotePending, { refund: 1, credit: 1 })
})

test("O: reemplazos del reclamo por ítem (netos de reversiones, sólo de ESTE reclamo)", () => {
  const replaced = getClaimReplacedUnitsByItem([
    { original_order_item_id: AURICULAR, quantity: 2, reverted_quantity: 1, claim_id: 7 },
    { original_order_item_id: AURICULAR, quantity: 1, claim_id: 8 },
    { original_order_item_id: ENCENDEDOR, quantity: 1, claim_id: null },
  ], 7)
  assert.deepEqual([...(replaced ?? [])], [[AURICULAR, 1]])
  assert.equal(getClaimReplacedUnitsByItem(null, 7), null, "sin verificar no se asume nada")
  assert.deepEqual(view({ affected: [{ order_item_id: AURICULAR, quantity: 1 }], lines: [line(AURICULAR, "replacement", 1)], replaced: null }).blockers,
    ["Verificando el reemplazo"])
})

test("cliente: el reparto en una frase y el estado sin conceptos internos", () => {
  const claim = {
    status: "aprobado", resolution: "mixta",
    affected_items: [{ order_item_id: AURICULAR, quantity: 2 }],
    order_claim_item_resolutions: [line(AURICULAR, "replacement", 1), line(AURICULAR, "refund", 1)],
  }
  assert.equal(getClaimLinesSummary(getClaimResolutionLines(claim)), "1 reemplazo · 1 reintegro")
  assert.equal(getCustomerClaimHeadline(claim), "Estamos resolviendo cada producto de tu reclamo")
  assert.equal(getCustomerClaimHeadline({ ...claim, order_claim_shipments: [{ id: 1, direction: "reemplazo", status: "en_transito" } as never] }),
    "Tu reemplazo está en camino", "el tramo físico vigente manda")
  assert.equal(getCustomerClaimHeadline({ ...claim, status: "cerrado" }), "Reclamo resuelto")
})
