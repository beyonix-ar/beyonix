/**
 * Incidentes de pago auditados (reintegro hecho fuera de BEYONIX o
 * contracargo). El evento original nunca se modifica ni se borra: su
 * resolución vive aparte (order_audit_incident_resolutions). Un incidente
 * resuelto sigue en el historial pero deja de ser una alerta activa.
 */

export const PAYMENT_INCIDENT_ACTIONS = ["mp_external_refund_detected", "mp_chargeback_detected"] as const
export type PaymentIncidentAction = (typeof PAYMENT_INCIDENT_ACTIONS)[number]

export const PAYMENT_INCIDENT_RESOLUTIONS = ["false_positive", "resolved"] as const
export type PaymentIncidentResolution = (typeof PAYMENT_INCIDENT_RESOLUTIONS)[number]

export interface PaymentIncidentAuditEvent {
  id?: number | string | null
  action: string
  created_at?: string | null
  metadata?: Record<string, unknown> | null
  audit_resolution?: {
    resolution: string
    note?: string | null
    resolved_at?: string | null
    resolved_by_email?: string | null
  } | null
}

export const PAYMENT_INCIDENT_LABELS: Record<PaymentIncidentAction, string> = {
  mp_external_refund_detected: "Reintegro externo detectado en Mercado Pago",
  mp_chargeback_detected: "Contracargo detectado en Mercado Pago",
}

export const PAYMENT_INCIDENT_RESOLUTION_LABELS: Record<PaymentIncidentResolution, string> = {
  false_positive: "Falso positivo",
  resolved: "Resuelto",
}

export function isPaymentIncidentAction(action: string): action is PaymentIncidentAction {
  return (PAYMENT_INCIDENT_ACTIONS as readonly string[]).includes(action)
}

export function getPaymentIncidents<T extends PaymentIncidentAuditEvent>(events: T[] | null | undefined) {
  return (events ?? []).filter((event) => isPaymentIncidentAction(event.action) && event.id != null)
}

/** Incidentes que siguen siendo alerta: sin resolución registrada. */
export function getOpenPaymentIncidents<T extends PaymentIncidentAuditEvent>(events: T[] | null | undefined) {
  return getPaymentIncidents(events).filter((event) => !event.audit_resolution)
}
