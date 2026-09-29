// "Cancelar reclamo": qué lo impide, en lenguaje simple. La base es la
// autoridad (order_claim_cancellation_blockers / cancel_order_claim); esto
// sólo anticipa en la interfaz lo mismo que la base va a exigir.

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

export const CLAIM_CANCELLATION_BLOCKER_LABELS: Record<ClaimCancellationBlocker, string> = {
  andreani_uncertain: "Conciliá la operación Andreani.",
  andreani_open: "Cancelá o completá la operación Andreani.",
  reservation: "Liberá la reserva del reemplazo.",
  replacement_in_transit: "Registrá el regreso del producto nuevo.",
  replacement_delivered: "El reemplazo ya fue entregado: finalizá el reclamo.",
  return_in_transit: "Registrá la llegada del producto original.",
  inspection_pending: "Inspeccioná el producto recibido.",
  incident: "Resolvé la incidencia.",
  credit_note_pending: "Resolvé la nota de crédito en curso.",
  credit_note_issued: "Ya se emitió la nota de crédito: finalizá el reclamo.",
  credit_applied: "Ya se acreditó saldo: finalizá el reclamo.",
  refund_pending: "Resolvé el reintegro en curso.",
}

/** Traduce los códigos que devuelve la base (detalle de CLAIM_CANCEL_BLOCKED). */
export function describeClaimCancellationBlockers(codes: string | null | undefined): string[] {
  return (codes ?? "").split(",").map((code) => code.trim()).filter(Boolean)
    .map((code) => CLAIM_CANCELLATION_BLOCKER_LABELS[code as ClaimCancellationBlocker] ?? "Hay una operación pendiente de resolver.")
}

export function isClaimCancelled(claim: { cancelled_at?: string | null }) {
  return Boolean(claim.cancelled_at)
}

interface CancellationUnit { role: string; location: string; incident_open?: boolean | null }
interface CancellationShipment { creation_status?: string | null; closed_at?: string | null; review_required?: boolean | null }
interface CancellationCreditNote { claim_id?: number | null; status?: string | null }

export interface ClaimCancellationPreview {
  /** Se puede ofrecer "Cancelar reclamo" (Admin, formal, no terminal). */
  available: boolean
  /** Lo que falta resolver antes (vacío = se puede cancelar). */
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
  if (!available) return { available, blockers: [] }
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
  return { available, blockers: codes.map((code) => CLAIM_CANCELLATION_BLOCKER_LABELS[code]) }
}
