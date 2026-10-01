// "Cancelar reclamo": qué lo impide, en lenguaje simple, y CÓMO llegar a
// resolverlo (cada bloqueo trae su acceso directo al paso del wizard y al
// control exacto). La base es la autoridad (order_claim_cancellation_blockers /
// cancel_order_claim); esto sólo anticipa en la interfaz lo que va a exigir.

export type ClaimCancellationBlocker =
  | "andreani_uncertain"
  | "andreani_open"
  | "reservation"
  | "replacement_in_transit"
  | "replacement_delivered"
  | "return_in_transit"
  | "inspection_pending"
  | "incident"
  | "credit_note_pending"
  | "credit_note_issued"
  | "credit_applied"
  | "refund_pending"

const CODES: readonly ClaimCancellationBlocker[] = [
  "andreani_uncertain", "andreani_open", "reservation", "replacement_in_transit", "replacement_delivered",
  "return_in_transit", "inspection_pending", "incident", "credit_note_pending", "credit_note_issued",
  "credit_applied", "refund_pending",
]

/** Estado en lenguaje simple (qué pasa), sin instrucciones técnicas. */
export const CLAIM_CANCELLATION_BLOCKER_LABELS: Record<ClaimCancellationBlocker, string> = {
  andreani_uncertain: "La operación Andreani quedó sin confirmar.",
  andreani_open: "Hay una operación Andreani en curso.",
  reservation: "Hay un reemplazo reservado.",
  replacement_in_transit: "El producto nuevo está volviendo a BEYONIX.",
  replacement_delivered: "El reemplazo ya fue entregado: corresponde finalizar el reclamo.",
  return_in_transit: "El producto original está en camino a BEYONIX.",
  inspection_pending: "Hay un producto recibido sin inspeccionar.",
  incident: "Hay un problema abierto.",
  credit_note_pending: "Hay una nota de crédito en curso.",
  credit_note_issued: "Ya se emitió la nota de crédito: corresponde finalizar el reclamo.",
  credit_applied: "Ya se acreditó saldo a favor: corresponde finalizar el reclamo.",
  refund_pending: "Hay un reintegro en curso.",
}

export function isClaimCancellationBlocker(code: string): code is ClaimCancellationBlocker {
  return (CODES as readonly string[]).includes(code)
}

/** Códigos que devuelve la base en el detalle de CLAIM_CANCEL_BLOCKED (desconocidos se descartan). */
export function parseClaimCancellationBlockerCodes(details: string | null | undefined): ClaimCancellationBlocker[] {
  return (details ?? "").split(",").map((code) => code.trim()).filter(isClaimCancellationBlocker)
}

/** Traduce los códigos que devuelve la base (detalle de CLAIM_CANCEL_BLOCKED). */
export function describeClaimCancellationBlockers(codes: string | null | undefined): string[] {
  const known = parseClaimCancellationBlockerCodes(codes)
  const unknown = (codes ?? "").split(",").map((code) => code.trim()).filter((code) => code && !isClaimCancellationBlocker(code))
  return [...known.map((code) => CLAIM_CANCELLATION_BLOCKER_LABELS[code]), ...(unknown.length ? ["Hay una operación pendiente de resolver."] : [])]
}

export function isClaimCancelled(claim: { cancelled_at?: string | null }) {
  return Boolean(claim.cancelled_at)
}

/** Paso del wizard donde se resuelve cada bloqueo. */
export type ClaimCancellationStep = "logistics" | "replacement" | "reception" | "execution" | "finish"

export interface ClaimCancellationBlockerView {
  code: ClaimCancellationBlocker
  text: string
  /** Botón de acceso directo ("Ir a …"). */
  actionLabel: string
  step: ClaimCancellationStep
  /** data-claim-focus del control que resuelve el bloqueo (se resalta al llegar). */
  focus: string
}

/**
 * Para cada bloqueo: a qué paso ir y qué control resaltar. Depende del método
 * (la reserva vive en "Cambio en sucursal" o en "Reenvío") y de dónde está la
 * operación o la incidencia; lo financiero va a su paso (Reintegro/Aplicación)
 * o a Finalización cuando el flujo no lo tiene.
 */
export function getClaimCancellationBlockerViews(codes: readonly ClaimCancellationBlocker[], context: {
  plan: "cambio_directo" | "retiro" | "retiro_y_reenvio" | null
  /** Dirección de la operación Andreani vigente. */
  legDirection?: "cambio" | "devolucion" | "reemplazo" | null
  /** La incidencia está en unidades (Recepción); si no, es un evento de Andreani a revisar. */
  incidentOnUnits: boolean
  hasExecutionStep: boolean
}): ClaimCancellationBlockerView[] {
  const legStep: ClaimCancellationStep = context.legDirection === "reemplazo" ? "replacement" : "logistics"
  const financeStep: ClaimCancellationStep = context.hasExecutionStep ? "execution" : "finish"
  const view = (code: ClaimCancellationBlocker, actionLabel: string, step: ClaimCancellationStep, focus: string): ClaimCancellationBlockerView =>
    ({ code, text: CLAIM_CANCELLATION_BLOCKER_LABELS[code], actionLabel, step, focus })
  return codes.map((code) => {
    switch (code) {
      case "reservation":
        return view(code, "Ir a liberar reserva", context.plan === "retiro_y_reenvio" ? "replacement" : "logistics", "release_reservation")
      case "andreani_uncertain":
        return view(code, "Ir a operación", legStep, "reconcile")
      case "andreani_open":
        return view(code, "Ir a operación", legStep, "cancel_leg")
      case "incident":
        return context.incidentOnUnits
          ? view(code, "Ir al problema", "reception", "incident_resolve")
          : view(code, "Ir al problema", legStep, "review_resolve")
      case "replacement_in_transit":
        return view(code, "Ir a recepción", "reception", "arrival_replacement")
      case "return_in_transit":
        return view(code, "Ir a recepción", "reception", "arrival_original")
      case "inspection_pending":
        return view(code, "Ir a recepción", "reception", "inspection")
      case "replacement_delivered":
        return view(code, "Ir a finalización", "finish", "step")
      case "credit_note_pending":
      case "credit_note_issued":
      case "credit_applied":
      case "refund_pending":
        return view(code, "Ir a resolución financiera", financeStep, "step")
    }
  })
}

interface CancellationUnit { role: string; location: string; incident_open?: boolean | null }
interface CancellationShipment { creation_status?: string | null; closed_at?: string | null; review_required?: boolean | null }
interface CancellationCreditNote { claim_id?: number | null; status?: string | null }

export interface ClaimCancellationPreview {
  /** Se puede ofrecer "Cancelar reclamo" (Admin, formal, no terminal). */
  available: boolean
  /** Lo que falta resolver antes (vacío = se puede cancelar). */
  codes: ClaimCancellationBlocker[]
  blockers: string[]
}

export function getClaimCancellationPreview(input: {
  claimId: number
  status: string
  failureType?: string | null
  isAdmin: boolean
  units?: CancellationUnit[] | null
  shipments?: CancellationShipment[] | null
  creditNotes?: CancellationCreditNote[] | null
  /** Unidades de reemplazo registradas sin logística por unidades (legacy). */
  legacyReplacementUnits?: number
}): ClaimCancellationPreview {
  const available = input.isAdmin && !["cerrado", "rechazado"].includes(input.status) &&
    !["consulta_pedido", "cancelar_compra"].includes(input.failureType ?? "")
  if (!available) return { available, codes: [], blockers: [] }
  const units = input.units ?? []
  const shipments = input.shipments ?? []
  const notes = (input.creditNotes ?? []).filter((note) => note.claim_id === input.claimId)
  const has = (role: string, locations: string[]) => units.some((unit) => unit.role === role && locations.includes(unit.location))
  const codes: ClaimCancellationBlocker[] = []
  if (shipments.some((row) => ["processing", "manual_review"].includes(row.creation_status ?? ""))) codes.push("andreani_uncertain")
  if (shipments.some((row) => !row.closed_at && row.creation_status === "created")) codes.push("andreani_open")
  if (has("reemplazo", ["reservada"])) codes.push("reservation")
  if (has("reemplazo", ["en_andreani", "recibida_beyonix"])) codes.push("replacement_in_transit")
  if (has("reemplazo", ["entregada_cliente"]) || (!units.some((unit) => unit.role === "reemplazo") && (input.legacyReplacementUnits ?? 0) > 0)) {
    codes.push("replacement_delivered")
  }
  if (has("original", ["en_andreani"])) codes.push("return_in_transit")
  if (has("original", ["recibida_beyonix"])) codes.push("inspection_pending")
  if (units.some((unit) => unit.incident_open) || shipments.some((row) => row.review_required)) codes.push("incident")
  if (notes.some((note) => note.status === "processing")) codes.push("credit_note_pending")
  if (notes.some((note) => note.status === "authorized")) codes.push("credit_note_issued")
  return { available, codes, blockers: codes.map((code) => CLAIM_CANCELLATION_BLOCKER_LABELS[code]) }
}
