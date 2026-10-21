/**
 * Lo que ve el cliente dentro de un reclamo formal, separado en tres partes:
 *   * resumen: UNA frase con qué está pasando, qué tiene que hacer y qué esperar;
 *   * historial: hitos ya cumplidos, plegado y sin datos técnicos;
 *   * conversación: sólo mensajes escritos por personas.
 *
 * Los mensajes automáticos (order_claim_messages.system_key) nunca se muestran
 * como burbujas: cada uno es un hito. El catálogo de hitos es el mismo que usa
 * la base para la campana (order_claim_customer_milestone, migración
 * 20261020130000_claim_customer_milestone_notifications.sql); un test verifica
 * que ambos coincidan. Nunca expone estados crudos de Andreani, IDs internos,
 * simulaciones ni estados forzados.
 */

import {
  formatClaimResolutionAmount,
  getClaimResolutionView,
  parseClaimResolutionSummary,
} from "./claim-resolution.ts"
import {
  getClaimOperationalResolution,
  getClaimRequirements,
  getClaimResolutionLines,
  isMixedClaimResolution,
  type ClaimResolutionLinesSource,
} from "./claim-policy.ts"
import {
  CLAIM_RETURN_DROPOFF_INSTRUCTIONS,
  CLAIM_RETURN_PACKING_INSTRUCTIONS,
  claimBranchLabel,
  formatClaimDate,
  pickCurrentClaimShipment,
  type ClaimShipmentCustomerSource,
} from "./claim-shipment-view.ts"

export type CustomerClaimMilestone =
  | "received"
  | "approved"
  | "return_ready"
  | "product_received"
  | "preparing_replacement"
  | "replacement_sent"
  | "replacement_at_branch"
  | "replacement_delivered"
  | "refund_done"
  | "resolved"
  | "rejected"

/**
 * system_key (sin el sufijo ":<tramo>") -> hito. null: el mensaje acompaña a
 * otro hito de la misma operación y no es un hito propio. Espejo exacto de
 * order_claim_customer_milestone en la base.
 */
export const CUSTOMER_CLAIM_SYSTEM_KEY_MILESTONES: Readonly<Record<string, CustomerClaimMilestone | null>> = {
  change_accepted: "approved",
  mixed_resolution_approved: "approved",
  change_packing_instructions: null,
  return_generated: "return_ready",
  return_delivered: "product_received",
  original_received: "product_received",
  resend_without_return: "preparing_replacement",
  exchange_generated: "replacement_sent",
  replacement_dispatched: "replacement_sent",
  replacement_dispatch_details: null,
  exchange_at_branch: "replacement_at_branch",
  exchange_completed: "replacement_delivered",
  replacement_delivered: "replacement_delivered",
}

const HISTORY_LABELS: Record<CustomerClaimMilestone, string> = {
  received: "Reclamo recibido",
  approved: "Reclamo aprobado",
  return_ready: "Devolución lista para llevar a Andreani",
  product_received: "Producto recibido",
  preparing_replacement: "Reemplazo en preparación",
  replacement_sent: "Reemplazo enviado",
  replacement_at_branch: "Reemplazo en la sucursal",
  replacement_delivered: "Reemplazo entregado",
  refund_done: "Reintegro realizado",
  resolved: "Reclamo resuelto",
  rejected: "Reclamo revisado",
}

export function getCustomerClaimMilestone(systemKey: string | null | undefined): CustomerClaimMilestone | null {
  if (!systemKey) return null
  return CUSTOMER_CLAIM_SYSTEM_KEY_MILESTONES[systemKey.split(":")[0]] ?? null
}

interface CustomerClaimMessageSource {
  id: number
  author_role: string
  message: string
  created_at: string
  system_key?: string | null
}

export interface CustomerClaimSource {
  status: string
  failure_type?: string | null
  resolution?: string | null
  customer_selected_resolution?: string | null
  cancelled_at?: string | null
  created_at: string
  closed_at?: string | null
  refund_completed_at?: string | null
  refund_details_submitted_at?: string | null
  rejection_reason?: string | null
  resolution_summary?: unknown
  order_claim_shipments?: ClaimShipmentCustomerSource[] | ClaimShipmentCustomerSource | null
  affected_items?: ClaimResolutionLinesSource["affected_items"]
  order_claim_item_resolutions?: ClaimResolutionLinesSource["order_claim_item_resolutions"]
  order_claim_messages?: CustomerClaimMessageSource[] | null
}

// ── Campana ─────────────────────────────────────────────────────────────────

/** Avisos de la campana que llevan al reclamo (action_url .../ayuda). */
const CLAIM_NOTIFICATION_CTAS: Readonly<Record<string, string>> = {
  claim_update: "Ver reclamo",
  claim_resolved: "Ver reclamo",
  claim_response: "Ver mensaje",
  admin_message: "Ver mensaje",
  help_message_started: "Ver mensaje",
}

export function getCustomerClaimNotificationCta(type: string) {
  return CLAIM_NOTIFICATION_CTAS[type] ?? null
}

// ── Resumen ─────────────────────────────────────────────────────────────────

export type CustomerClaimSummaryTone = "progress" | "action" | "done" | "rejected"

export interface CustomerClaimSummary {
  tone: CustomerClaimSummaryTone
  title: string
  lines: string[]
  /** Sucursal Andreani donde el cliente tiene que ir (nunca la de una devolución). */
  branch: string | null
  /** Número de seguimiento: dato secundario y copiable. */
  tracking: string | null
  /** Ofrecer la etiqueta de devolución. */
  returnLabel: boolean
}

function text(value: string | null | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

function legsOf(claim: CustomerClaimSource) {
  const value = claim.order_claim_shipments
  const rows = Array.isArray(value) ? value : value ? [value] : []
  return rows.filter((row) => row.status !== "cancelada")
}

const summary = (
  tone: CustomerClaimSummaryTone,
  title: string,
  lines: string[] = [],
  extra: Partial<Pick<CustomerClaimSummary, "branch" | "tracking" | "returnLabel">> = {},
): CustomerClaimSummary => ({ tone, title, lines, branch: null, tracking: null, returnLabel: false, ...extra })

function closedSummary(claim: CustomerClaimSource): CustomerClaimSummary {
  const view = getClaimResolutionView(claim)
  const kind = parseClaimResolutionSummary(claim.resolution_summary)?.kind ?? claim.resolution ?? null
  const mixed = isMixedClaimResolution(kind)
  const requirements = getClaimRequirements(getClaimOperationalResolution(kind, getClaimResolutionLines(claim)))
  const amount = view?.amount != null ? formatClaimResolutionAmount(view.amount) : null
  const delivered = legsOf(claim).some((row) => (row.direction === "reemplazo" || row.direction === "cambio") && row.status === "entregada")

  if (mixed) return summary("done", "Reclamo resuelto", view?.detail ? [view.detail] : [])

  if (kind === "envio_unidad_faltante") return summary("done", "Reclamo resuelto", ["Te enviamos la unidad que faltaba."])
  if (requirements?.solution === "replacement") {
    return summary("done", "Reclamo resuelto", ["Te enviamos un producto nuevo.", ...(delivered ? ["El reemplazo fue entregado."] : [])])
  }
  if (requirements?.financialAction === "refund") {
    return summary("done", "Reclamo resuelto", ["Tu reintegro fue realizado.", ...(amount ? [`Monto: ${amount}`] : [])])
  }
  if (requirements?.financialAction === "customer_credit") {
    return summary("done", "Reclamo resuelto", ["Tu saldo a favor ya está disponible.", ...(amount ? [`Monto: ${amount}`] : [])])
  }
  return summary("done", "Reclamo resuelto", view?.detail ? [view.detail] : [])
}

/** Estado actual del reclamo formal para el cliente. */
export function getCustomerClaimSummary(claim: CustomerClaimSource): CustomerClaimSummary {
  if (claim.status === "rechazado") {
    const detail = getClaimResolutionView(claim)?.detail ?? (text(claim.rejection_reason) || null)
    return summary("rejected", "Tu reclamo no fue aprobado", detail ? [detail] : [])
  }
  if (claim.status === "cerrado") {
    return claim.cancelled_at ? summary("done", "Reclamo cancelado") : closedSummary(claim)
  }
  if (claim.status === "falta_informacion") {
    return summary("action", "Necesitamos tu respuesta", ["Escribinos abajo para que podamos seguir."])
  }

  const requirements = getClaimRequirements(getClaimOperationalResolution(claim.resolution, getClaimResolutionLines(claim)))
  if (!requirements || claim.status === "recibido" || claim.status === "en_revision") {
    return summary("progress", "Estamos revisando tu reclamo", ["Te avisamos cuando tengamos novedades."])
  }

  const replacement = requirements.solution === "replacement"
  const current = pickCurrentClaimShipment(legsOf(claim))
  const tracking = current ? text(current.andreani_tracking) || null : null
  const branch = current ? claimBranchLabel(current) : null
  const delay = current?.incident_open && current.status !== "entregada"
    ? ["Hubo una demora con el envío. Si necesitás ayuda, escribinos abajo."]
    : []

  if (current?.direction === "devolucion") {
    if (current.status === "pendiente") {
      return summary("progress", "Estamos preparando tu devolución", ["Te avisamos cuando puedas llevar el producto a Andreani."])
    }
    if (current.status === "generada") {
      return summary("action", "Llevá el producto a Andreani", [
        CLAIM_RETURN_PACKING_INSTRUCTIONS,
        "Descargá e imprimí la etiqueta de devolución y pegala en el paquete cerrado.",
        CLAIM_RETURN_DROPOFF_INSTRUCTIONS,
        ...delay,
      ], { tracking, returnLabel: true })
    }
    if (current.status !== "entregada") {
      return summary("progress", "Tu producto está en camino a BEYONIX", ["Cuando llegue lo revisamos.", ...delay], { tracking })
    }
    return summary("progress", "Recibimos tu producto", [
      replacement
        ? "Estamos preparando el reemplazo."
        : requirements.financialAction === "refund"
          ? "Estamos preparando tu reintegro."
          : requirements.financialAction === "customer_credit"
            ? "Estamos preparando tu saldo a favor."
            : "Lo estamos revisando.",
    ])
  }

  if (current?.direction === "cambio") {
    if (current.exchange_outcome === "no_completado") {
      return summary("progress", "El cambio no se completó", ["El producto nuevo vuelve a BEYONIX. Te vamos a escribir para ver cómo seguimos."])
    }
    if (current.status === "pendiente") {
      return summary("progress", "Estamos preparando tu cambio", ["Te avisamos cuando el producto nuevo esté en camino."])
    }
    if (current.status === "en_sucursal") {
      return summary("action", "Andá a la sucursal a hacer el cambio", [
        CLAIM_RETURN_PACKING_INSTRUCTIONS,
        "Llevá el producto original completo y embalado y tu DNI.",
        "Andreani te da el producto nuevo cuando recibe el original.",
        "Si no entregás el original, Andreani no entrega el nuevo: queda en la sucursal por un tiempo limitado y después vuelve a BEYONIX.",
        ...delay,
      ], { branch, tracking })
    }
    if (current.status === "entregada") {
      return summary("done", "Tu reemplazo fue entregado", ["Cuando el producto original llegue a BEYONIX lo revisamos."])
    }
    return summary("progress", "Tu producto nuevo está en camino", [
      "Va a una sucursal Andreani. Te avisamos cuando llegue.",
      "Ese día vas a tener que llevar el producto original.",
      ...delay,
    ], { branch, tracking })
  }

  if (current?.direction === "reemplazo") {
    if (current.status === "pendiente") {
      return summary("progress", "Estamos preparando tu reemplazo", ["Te avisamos cuando lo enviemos."])
    }
    if (current.status === "en_sucursal") {
      return summary("action", "Retirá tu reemplazo en Andreani", ["Llevá tu DNI.", ...delay], { branch, tracking })
    }
    if (current.status === "entregada") {
      return summary("done", "Tu reemplazo fue entregado", ["Te enviamos un producto nuevo."])
    }
    return summary("progress", "Tu reemplazo está en camino", [
      "Lo vas a retirar en una sucursal Andreani. Te avisamos cuando llegue.",
      ...delay,
    ], { branch, tracking })
  }

  if (requirements.financialAction === "refund") {
    return claim.status === "reintegro_pendiente" && !claim.refund_details_submitted_at
      ? summary("action", "Necesitamos tus datos para el reintegro", ["Completalos abajo para que podamos devolverte el dinero."])
      : summary("progress", "Estamos preparando tu reintegro", ["Te avisamos cuando esté hecho."])
  }
  if (requirements.financialAction === "customer_credit") {
    return summary("progress", "Estamos preparando tu saldo a favor", ["Te avisamos cuando esté disponible."])
  }
  if (replacement) return summary("progress", "Estamos preparando tu reemplazo", ["Te avisamos cuando lo enviemos."])
  return summary("progress", "Estamos resolviendo tu reclamo", ["Te avisamos cuando tengamos novedades."])
}

// ── Historial ───────────────────────────────────────────────────────────────

export interface CustomerClaimHistoryStep {
  milestone: CustomerClaimMilestone
  label: string
  /** Fecha corta (dd/mm/aaaa) o null si no hay una confiable. */
  date: string | null
}

/** Hitos cumplidos, en orden y sin repetir. */
export function getCustomerClaimHistory(claim: CustomerClaimSource): CustomerClaimHistoryStep[] {
  const events: Array<{ milestone: CustomerClaimMilestone; at: string }> = [{ milestone: "received", at: claim.created_at }]
  for (const message of claim.order_claim_messages ?? []) {
    const milestone = getCustomerClaimMilestone(message.system_key)
    if (milestone) events.push({ milestone, at: message.created_at })
  }
  for (const leg of legsOf(claim)) {
    // Entregas sin mensaje propio (reclamos anteriores a los mensajes de tramo).
    if ((leg.direction === "reemplazo" || leg.direction === "cambio") && leg.status === "entregada" && leg.delivered_at) {
      events.push({ milestone: "replacement_delivered", at: leg.delivered_at })
    }
  }
  if (claim.refund_completed_at) events.push({ milestone: "refund_done", at: claim.refund_completed_at })
  if (claim.status === "cerrado" && !claim.cancelled_at && claim.closed_at) events.push({ milestone: "resolved", at: claim.closed_at })
  if (claim.status === "rechazado" && claim.closed_at) events.push({ milestone: "rejected", at: claim.closed_at })

  const firstByMilestone = new Map<CustomerClaimMilestone, string>()
  for (const { milestone, at } of events.sort((left, right) => Date.parse(left.at) - Date.parse(right.at))) {
    if (!firstByMilestone.has(milestone)) firstByMilestone.set(milestone, at)
  }
  return [...firstByMilestone].map(([milestone, at]) => ({ milestone, label: HISTORY_LABELS[milestone], date: formatClaimDate(at) }))
}

// ── Conversación ────────────────────────────────────────────────────────────

/**
 * Texto automático que la base agrega al cerrar un reclamo formal
 * (order_claim_resolution_message en 20260924160000). El resumen ya lo muestra.
 */
function getAutomaticClosingText(claim: CustomerClaimSource) {
  const parsed = parseClaimResolutionSummary(claim.resolution_summary)
  if (!parsed) return "BEYONIX finalizó el reclamo."
  return ["BEYONIX resolvió el reclamo.", `Resolución: ${parsed.label}.`, parsed.detail].filter(Boolean).join("\n")
}

export interface CustomerClaimConversationMessage {
  id: number
  fromCustomer: boolean
  message: string
  created_at: string
}

/**
 * Sólo lo que escribió una persona. Del mensaje de cierre queda únicamente el
 * texto que agregó BEYONIX a mano (si lo hay).
 */
export function getCustomerClaimConversation(claim: CustomerClaimSource): CustomerClaimConversationMessage[] {
  const terminal = claim.status === "cerrado" || claim.status === "rechazado"
  const closingText = terminal ? getAutomaticClosingText(claim) : null
  const conversation: CustomerClaimConversationMessage[] = []
  for (const message of claim.order_claim_messages ?? []) {
    const fromCustomer = message.author_role === "cliente"
    if (!fromCustomer && message.system_key) continue
    let body = message.message
    if (!fromCustomer && terminal) {
      const trimmed = body.trim()
      if (closingText && trimmed.startsWith(closingText)) body = trimmed.slice(closingText.length).trim()
      else if (/^BEYONIX (finalizó|rechazó) el reclamo/.test(trimmed)) body = ""
      if (!body) continue
    }
    conversation.push({ id: message.id, fromCustomer, message: body, created_at: message.created_at })
  }
  return conversation
}
