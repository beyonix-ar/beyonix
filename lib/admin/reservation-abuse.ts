/**
 * Antiabuso de reservas de stock: tipos compartidos entre la API de Admin y
 * su panel, y el estado efectivo de una cuenta. La autoridad es la base
 * (20261029130000_reservation_abuse_protection.sql): esto sólo resume lo que
 * Admin ve, con la misma regla de vencimiento que aplica `reserve_cart_stock`.
 */

export type ReservationAbuseEventType =
  | "RESERVATION_ABUSE_STRIKE"
  | "AUTO_BLOCK_STARTED"
  | "AUTO_BLOCK_EXPIRED"
  | "MANUAL_BLOCK"
  | "MANUAL_BLOCK_EXPIRED"
  | "PERMANENT_BLOCK"
  | "MANUAL_UNBLOCK"
  | "STRIKES_RESET_AFTER_PURCHASE"
  | "IP_BLOCKED"
  | "IP_UNBLOCKED"

export type ReservationAbuseStatus = "permanent" | "manual" | "auto" | "active"

export type ReservationBlockAction = "block_7_days" | "block_permanent" | "unblock"

export interface ReservationAbuseStateRow {
  user_id: string
  strike_count: number
  last_strike_at: string | null
  auto_blocked_at: string | null
  auto_blocked_until: string | null
  manual_block: "temporary" | "permanent" | null
  manual_blocked_at: string | null
  manual_blocked_until: string | null
  manual_reason: string | null
  updated_at: string
}

export interface ReservationAbuseAccount {
  userId: string
  name: string | null
  username: string | null
  email: string | null
  strikes: number
  status: ReservationAbuseStatus
  blockedUntil: string | null
  reason: string | null
  lastEvent: { type: ReservationAbuseEventType; createdAt: string } | null
  ips: string[]
}

export interface ReservationAbuseItem {
  productId: number
  variantId: number | null
  conditionedStockId: string | null
  quantity: number
  productName: string | null
  variantName: string | null
}

export interface ReservationAbuseReservation {
  sessionId: string
  createdAt: string
  reservedUnits: number
  items: ReservationAbuseItem[]
  emptiedItems: ReservationAbuseItem[]
  clientIp: string | null
  outcome: "strike" | "purchased" | "forgiven_by_purchase" | null
  orderId: number | null
}

export interface ReservationAbuseEvent {
  id: number
  type: ReservationAbuseEventType
  createdAt: string
  clientIp: string | null
  orderId: number | null
  details: Record<string, unknown>
}

export interface ReservationAbuseDetail {
  events: ReservationAbuseEvent[]
  reservations: ReservationAbuseReservation[]
}

export interface ReservationIpBlock {
  ip: string
  reason: string | null
  blockedAt: string
}

export const RESERVATION_ABUSE_EVENT_LABELS: Record<ReservationAbuseEventType, string> = {
  RESERVATION_ABUSE_STRIKE: "Falta por reserva abandonada",
  AUTO_BLOCK_STARTED: "Bloqueo automático (7 días)",
  AUTO_BLOCK_EXPIRED: "Fin del bloqueo automático",
  MANUAL_BLOCK: "Bloqueo manual (7 días)",
  MANUAL_BLOCK_EXPIRED: "Fin del bloqueo manual",
  PERMANENT_BLOCK: "Bloqueo permanente",
  MANUAL_UNBLOCK: "Desbloqueo manual",
  STRIKES_RESET_AFTER_PURCHASE: "Faltas en 0 por compra",
  IP_BLOCKED: "IP bloqueada",
  IP_UNBLOCKED: "IP desbloqueada",
}

export const RESERVATION_ABUSE_STATUS_LABELS: Record<ReservationAbuseStatus, string> = {
  permanent: "Bloqueo permanente",
  manual: "Bloqueo manual",
  auto: "Bloqueo automático",
  active: "Puede reservar",
}

/**
 * Estado efectivo a `now`: un bloqueo vencido ya no cuenta, y al vencer el
 * automático las faltas vuelven a 0 (mismo criterio que la base, que además
 * lo persiste en la próxima evaluación).
 */
export function getReservationAbuseStatus(
  state: Pick<ReservationAbuseStateRow,
    "strike_count" | "auto_blocked_until" | "manual_block" | "manual_blocked_until" | "manual_reason">,
  now = Date.now(),
): { status: ReservationAbuseStatus; strikes: number; blockedUntil: string | null; reason: string | null } {
  const autoActive = state.auto_blocked_until !== null && Date.parse(state.auto_blocked_until) > now
  const autoExpired = state.auto_blocked_until !== null && !autoActive
  const strikes = autoExpired ? 0 : state.strike_count
  if (state.manual_block === "permanent") {
    return { status: "permanent", strikes, blockedUntil: null, reason: state.manual_reason }
  }
  if (
    state.manual_block === "temporary" &&
    state.manual_blocked_until !== null &&
    Date.parse(state.manual_blocked_until) > now
  ) {
    return { status: "manual", strikes, blockedUntil: state.manual_blocked_until, reason: state.manual_reason }
  }
  if (autoActive) {
    return { status: "auto", strikes, blockedUntil: state.auto_blocked_until, reason: "2 faltas por reservas abandonadas" }
  }
  return { status: "active", strikes, blockedUntil: null, reason: null }
}

export function isReservationBlockAction(value: unknown): value is ReservationBlockAction {
  return value === "block_7_days" || value === "block_permanent" || value === "unblock"
}
