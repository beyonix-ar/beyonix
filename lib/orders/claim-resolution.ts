// Resolución de un reclamo finalizado, tal como se comunica al cliente.
//
// Fuente de verdad: order_claims.resolution_summary, congelado en la base al
// cerrar/rechazar (supabase/migrations/20260924160000_claim_resolution_summary_notifications.sql)
// a partir de la resolución, el motivo y las notas de crédito liquidadas.
// Acá sólo se lee y se valida su forma: nunca se recalcula ni se inventa.
// Reclamos históricos (sin resumen) muestran "Reclamo finalizado".

export type ClaimResolutionKind =
  | "cambio_producto"
  | "envio_unidad_faltante"
  | "saldo_a_favor"
  | "cupon_descuento"
  | "reintegro_total"
  | "reintegro_parcial"
  | "otro"
  | "rechazado"
  | "cancelacion"
  | "cancelacion_rechazada"
  | "consulta"

export interface ClaimResolutionSummary {
  kind: ClaimResolutionKind
  label: string
  detail: string | null
  amount: number | null
  notice: string | null
}

export interface ClaimResolutionView {
  label: string
  detail: string | null
  amount: number | null
  amountLabel: string | null
  rejected: boolean
  /** false en reclamos históricos cerrados sin resumen persistido. */
  structured: boolean
}

type ClaimResolutionSource = {
  status: string
  failure_type?: string | null
  resolution_summary?: unknown
}

const KINDS: readonly ClaimResolutionKind[] = [
  "cambio_producto",
  "envio_unidad_faltante",
  "saldo_a_favor",
  "cupon_descuento",
  "reintegro_total",
  "reintegro_parcial",
  "otro",
  "rechazado",
  "cancelacion",
  "cancelacion_rechazada",
  "consulta",
]

const AMOUNT_LABELS: Partial<Record<ClaimResolutionKind, string>> = {
  saldo_a_favor: "Saldo acreditado",
  cupon_descuento: "Saldo acreditado",
  reintegro_total: "Monto reintegrado",
  reintegro_parcial: "Monto reintegrado",
}

const isKind = (value: unknown): value is ClaimResolutionKind =>
  typeof value === "string" && (KINDS as readonly string[]).includes(value)

const optionalText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null)

export function parseClaimResolutionSummary(value: unknown): ClaimResolutionSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const label = optionalText(record.label)
  if (!isKind(record.kind) || !label) return null
  const amount = typeof record.amount === "number" ? record.amount : Number(record.amount)
  return {
    kind: record.kind,
    label,
    detail: optionalText(record.detail),
    amount: record.amount != null && Number.isFinite(amount) && amount > 0 ? amount : null,
    notice: optionalText(record.notice),
  }
}

export function isClaimTerminal(status: string) {
  return status === "cerrado" || status === "rechazado"
}

export function getClaimResolutionView(claim: ClaimResolutionSource): ClaimResolutionView | null {
  if (!isClaimTerminal(claim.status)) return null
  const summary = parseClaimResolutionSummary(claim.resolution_summary)
  if (!summary) {
    const cancellation = claim.failure_type === "cancelar_compra"
    return {
      label: claim.status === "rechazado"
        ? cancellation ? "Cancelación no aprobada" : "Reclamo no aprobado"
        : cancellation ? "Cancelación finalizada" : "Reclamo finalizado",
      detail: null,
      amount: null,
      amountLabel: null,
      rejected: claim.status === "rechazado",
      structured: false,
    }
  }
  return {
    label: summary.label,
    detail: summary.detail,
    amount: summary.amount,
    amountLabel: summary.amount != null ? AMOUNT_LABELS[summary.kind] ?? "Monto" : null,
    rejected: summary.kind === "rechazado" || summary.kind === "cancelacion_rechazada",
    structured: true,
  }
}

/** Título del historial: "Reclamo finalizado — Resolución: Cambio de producto". */
export function getClaimResolutionHistoryTitle(baseTitle: string, claim: ClaimResolutionSource) {
  const view = getClaimResolutionView(claim)
  return view?.structured ? `${baseTitle} — Resolución: ${view.label}` : baseTitle
}

/**
 * Texto de resolución de un reclamo FORMAL terminado (mismo contenido que el
 * mensaje automático del chat), para el email de cierre. null en reclamos
 * abiertos, consultas, cancelaciones o históricos sin resumen.
 */
export function getClaimResolutionText(
  claim: ClaimResolutionSource & { admin_response?: string | null; rejection_reason?: string | null },
) {
  if (claim.failure_type === "consulta_pedido" || claim.failure_type === "cancelar_compra") return null
  const view = getClaimResolutionView(claim)
  if (!view?.structured) return null
  const adminText = claim.admin_response?.trim()
  const extra = adminText && adminText !== claim.rejection_reason?.trim() && adminText !== view.detail ? adminText : null
  return ["BEYONIX resolvió tu reclamo.", `Resolución: ${view.label}.`, view.detail, extra].filter(Boolean).join("\n")
}

export function formatClaimResolutionAmount(amount: number) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount)
}
