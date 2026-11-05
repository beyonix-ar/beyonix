/**
 * Envío BEYONIX: resultado de la entrega informado por el cadete desde el QR
 * de la etiqueta, retorno logístico local y reserva de los productos.
 *
 * Reglas puras (sin base ni red) compartidas por la página del cadete, Admin,
 * Mis compras y las rutas. La fuente de verdad de cada transición es la base
 * (supabase/migrations/20261105120000_local_delivery_outcomes_and_returns.sql):
 * acá sólo se describe qué se puede pedir y cómo se muestra.
 *
 * El retorno por ausencia es un RETORNO LOGÍSTICO de entrega local: no es una
 * devolución comercial, arrepentimiento, reclamo, cambio ni garantía, y nunca
 * usa estados ni logística inversa de Andreani.
 */

export type LocalDeliveryOutcomeStatus =
  | "pending"
  | "first_attempt_failed"
  | "incident"
  | "returning"
  | "returned"
  | "delivered"

export type LocalDeliveryIncidentReason = "wrong_address" | "no_access" | "rejected" | "other"
export type LocalDeliveryReservationStatus = "active" | "consumed" | "expired" | "cancelled"
export type LocalDeliveryCourierAction = "delivered" | "absent" | "incident"

const OUTCOME_STATUSES = new Set<string>(["pending", "first_attempt_failed", "incident", "returning", "returned", "delivered"])
const RESERVATION_STATUSES = new Set<string>(["active", "consumed", "expired", "cancelled"])

export const LOCAL_DELIVERY_INCIDENT_REASONS: readonly LocalDeliveryIncidentReason[] = ["wrong_address", "no_access", "rejected", "other"]
export const LOCAL_DELIVERY_INCIDENT_REASON_LABELS: Record<LocalDeliveryIncidentReason, string> = {
  wrong_address: "Dirección incorrecta",
  no_access: "No se pudo acceder al domicilio",
  rejected: "Cliente rechazó el pedido",
  other: "Otro",
}
export const LOCAL_DELIVERY_INCIDENT_COMMENT_MAX = 280

/** Etiquetas operativas (Admin). */
export const LOCAL_DELIVERY_OUTCOME_LABELS: Record<LocalDeliveryOutcomeStatus, string> = {
  pending: "En camino",
  first_attempt_failed: "Primer intento fallido",
  incident: "Incidencia de entrega",
  returning: "Regresando a BEYONIX",
  returned: "Devuelto a BEYONIX",
  delivered: "Entregado",
}

export const LOCAL_DELIVERY_RESERVATION_DAYS_DEFAULT = 3
export const LOCAL_DELIVERY_RESERVATION_DAYS_MIN = 1
export const LOCAL_DELIVERY_RESERVATION_DAYS_MAX = 30

/** `null` si no es un entero de 1 a 30. */
export function normalizeLocalDeliveryReservationDays(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= LOCAL_DELIVERY_RESERVATION_DAYS_MIN && value <= LOCAL_DELIVERY_RESERVATION_DAYS_MAX
    ? value
    : null
}

/**
 * El aviso "Tu pedido está en camino" ya no corresponde: el pedido regresa,
 * regresó a BEYONIX o fue entregado (ordenes.estado puede seguir en_camino).
 */
export function isInTransitEmailObsolete(status: LocalDeliveryOutcomeStatus | null | undefined) {
  return status === "returning" || status === "returned" || status === "delivered"
}

export const isLocalDeliveryOutcomeStatus = (value: unknown): value is LocalDeliveryOutcomeStatus =>
  typeof value === "string" && OUTCOME_STATUSES.has(value)
export const isLocalDeliveryReservationStatus = (value: unknown): value is LocalDeliveryReservationStatus =>
  typeof value === "string" && RESERVATION_STATUSES.has(value)
export const isLocalDeliveryIncidentReason = (value: unknown): value is LocalDeliveryIncidentReason =>
  typeof value === "string" && (LOCAL_DELIVERY_INCIDENT_REASONS as readonly string[]).includes(value)

// Token del QR: 16 bytes aleatorios en base64url (22 caracteres). Nunca
// contiene el id del pedido ni datos del cliente. Mismo formato que valida la base.
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/

export function isLocalDeliveryAccessToken(value: unknown): value is string {
  return typeof value === "string" && ACCESS_TOKEN_PATTERN.test(value)
}

export function createLocalDeliveryAccessToken(random: (bytes: Uint8Array) => Uint8Array = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(16))
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** URL del QR: sólo el token, en la ruta pública mínima del cadete. */
export function localDeliveryCourierUrl(siteOrigin: string, token: string) {
  return `${siteOrigin.replace(/\/+$/, "")}/delivery/${token}`
}

// ── Pedido del cadete ────────────────────────────────────────────────────────

export interface LocalDeliveryShipmentState {
  outcomeStatus: LocalDeliveryOutcomeStatus
  failedAttempts: number
}

export interface CourierOrderState extends LocalDeliveryShipmentState {
  estado: string | null
  cancelled: boolean
}

export type CourierScreen =
  | { kind: "actions"; failedAttempts: number }
  | { kind: "preparing" }
  | { kind: "delivered" }
  | { kind: "incident" }
  | { kind: "returning" }
  | { kind: "returned" }
  | { kind: "cancelled" }

/**
 * Qué ve el cadete al escanear. Sólo hay botones mientras el pedido está En
 * camino y el cadete puede informar un resultado (sin resultado o tras el
 * primer intento fallido). Cualquier otro estado es informativo.
 */
export function getCourierScreen(state: CourierOrderState): CourierScreen {
  if (state.cancelled) return { kind: "cancelled" }
  if (state.estado === "entregado" || state.outcomeStatus === "delivered") return { kind: "delivered" }
  if (state.outcomeStatus === "returned") return { kind: "returned" }
  if (state.outcomeStatus === "returning") return { kind: "returning" }
  if (state.estado !== "en_camino") return { kind: "preparing" }
  if (state.outcomeStatus === "incident") return { kind: "incident" }
  return { kind: "actions", failedAttempts: state.failedAttempts }
}

export interface CourierActionRequest {
  action: LocalDeliveryCourierAction
  /** Intentos fallidos que el cadete vio en pantalla (evita contar dos veces un doble toque). */
  expectedAttempts: number
  reason: LocalDeliveryIncidentReason | null
  comment: string | null
}

export class CourierActionRequestError extends Error {}

/** Cuerpo del POST del cadete, estricto: cualquier campo extra o inválido se rechaza. */
export function parseCourierActionRequest(body: unknown): CourierActionRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new CourierActionRequestError("Acción inválida.")
  const source = body as Record<string, unknown>
  if (Object.keys(source).some((key) => !["action", "expectedAttempts", "reason", "comment"].includes(key))) {
    throw new CourierActionRequestError("Acción inválida.")
  }
  const { action, expectedAttempts } = source
  if (action !== "delivered" && action !== "absent" && action !== "incident") throw new CourierActionRequestError("Acción inválida.")
  if (typeof expectedAttempts !== "number" || !Number.isInteger(expectedAttempts) || expectedAttempts < 0 || expectedAttempts > 2) {
    throw new CourierActionRequestError("Acción inválida.")
  }
  if (action !== "incident") {
    if (source.reason != null || source.comment != null) throw new CourierActionRequestError("Acción inválida.")
    return { action, expectedAttempts, reason: null, comment: null }
  }
  if (!isLocalDeliveryIncidentReason(source.reason)) throw new CourierActionRequestError("Elegí qué pasó con la entrega.")
  if (source.comment != null && typeof source.comment !== "string") throw new CourierActionRequestError("Acción inválida.")
  const comment = typeof source.comment === "string" ? source.comment.trim().replace(/\s+/g, " ") : ""
  if (comment.length > LOCAL_DELIVERY_INCIDENT_COMMENT_MAX) {
    throw new CourierActionRequestError(`El comentario puede tener hasta ${LOCAL_DELIVERY_INCIDENT_COMMENT_MAX} caracteres.`)
  }
  if (source.reason === "other" && !comment) throw new CourierActionRequestError("Contanos brevemente qué pasó.")
  return { action, expectedAttempts, reason: source.reason, comment: comment || null }
}

/** Mensaje para el cadete después de una acción (o de un estado que ya cambió). */
export const COURIER_RESULT_MESSAGES = {
  delivered: "Entrega registrada. ¡Gracias!",
  first_attempt_failed: "Registramos el primer intento. El pedido queda para un segundo intento.",
  returning: "Registramos el segundo intento. El pedido debe regresar a BEYONIX.",
  incident: "Registramos el problema. BEYONIX lo va a revisar.",
  unchanged: "Este resultado ya estaba registrado. Actualizamos la pantalla.",
  already_delivered: "El pedido ya figura como entregado.",
  cancelled: "Este pedido fue cancelado. No lo entregues y devolvelo a BEYONIX.",
  not_in_transit: "El pedido todavía no salió a reparto.",
  max_attempts: "El pedido ya alcanzó el máximo de intentos de entrega.",
  conflict: "El pedido cambió mientras lo actualizabas. Revisá la pantalla.",
} as const

// ── Mis compras ──────────────────────────────────────────────────────────────

/** Resumen del resultado local que puede ver el cliente (sin comentarios, motivos ni datos internos). */
export interface CustomerLocalDeliveryOutcome {
  status: LocalDeliveryOutcomeStatus
  failedAttempts: number
  reservation: { status: LocalDeliveryReservationStatus; expiresAt: string } | null
}

export interface CustomerLocalDeliveryNotice {
  /** Etiqueta corta del estado (badge). */
  label: string
  title: string
  paragraphs: string[]
  tone: "warning" | "info" | "neutral"
  /** Botón "Contactar a BEYONIX" (chat de ayuda del pedido). */
  showContact: boolean
}

// Partes numéricas en hora de BEYONIX con relleno explícito: algunos ICU de
// es-AR ignoran "2-digit" en el día ("9/11").
function businessDateParts(value: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Argentina/Buenos_Aires", day: "numeric", month: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23",
  }).formatToParts(new Date(value))
  const part = (type: Intl.DateTimeFormatPartTypes) => (parts.find((entry) => entry.type === type)?.value ?? "").padStart(2, "0")
  return { day: part("day"), month: part("month"), hour: part("hour"), minute: part("minute") }
}

/** "09/11" en hora de BEYONIX. */
export function formatLocalDeliveryDay(value: string) {
  const { day, month } = businessDateParts(value)
  return `${day}/${month}`
}

/** "09/11 00:00" en hora de BEYONIX. */
export function formatLocalDeliveryDeadline(value: string) {
  const { day, month, hour, minute } = businessDateParts(value)
  return `${day}/${month} ${hour}:${minute}`
}

const NEW_SHIPMENT_COST = "Para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente."

/**
 * Aviso de Mis compras para un pedido Envío BEYONIX con resultado del cadete.
 * `null` mientras no haya nada que informar (sin resultado o entregado).
 */
export function getCustomerLocalDeliveryNotice(
  outcome: CustomerLocalDeliveryOutcome | null | undefined,
  nowMs: number = Date.now(),
): CustomerLocalDeliveryNotice | null {
  if (!outcome) return null
  switch (outcome.status) {
    case "first_attempt_failed":
      return {
        label: "Intento de entrega fallido",
        title: "No pudimos concretar la entrega",
        paragraphs: [
          "El cadete visitó tu domicilio, pero no pudo concretar la entrega porque no había nadie presente.",
          "Realizaremos un segundo intento de entrega.",
          "Si en el segundo intento tampoco podemos completar la entrega, el pedido regresará a BEYONIX y, para coordinar un nuevo envío, deberás abonar nuevamente el costo de entrega correspondiente.",
        ],
        tone: "warning",
        showContact: false,
      }
    case "incident":
      return {
        label: "En camino",
        title: "Estamos revisando la entrega",
        paragraphs: ["Hubo un inconveniente con la entrega de tu pedido. BEYONIX lo está revisando y se va a comunicar con vos si hace falta."],
        tone: "info",
        showContact: false,
      }
    case "returning":
      return {
        label: "Regresando a BEYONIX",
        title: "Regresando a BEYONIX",
        paragraphs: outcome.failedAttempts >= 2
          ? [
              "Realizamos un segundo intento de entrega y nuevamente no pudimos encontrar a nadie en el domicilio.",
              "El pedido regresará a BEYONIX.",
              NEW_SHIPMENT_COST,
            ]
          : ["No pudimos completar la entrega y el pedido regresará a BEYONIX.", NEW_SHIPMENT_COST],
        tone: "warning",
        showContact: false,
      }
    case "returned": {
      const reservation = outcome.reservation
      const expired = reservation?.status === "expired" ||
        (reservation?.status === "active" && Date.parse(reservation.expiresAt) <= nowMs)
      if (reservation && !expired && reservation.status === "active") {
        return {
          label: "Devuelto a BEYONIX",
          title: "Tu pedido regresó a BEYONIX.",
          paragraphs: [
            `Mantendremos tus productos reservados hasta el ${formatLocalDeliveryDay(reservation.expiresAt)}.`,
            "Para solicitar un nuevo envío, contactanos antes de esa fecha.",
            "El nuevo envío tendrá costo.",
          ],
          tone: "warning",
          showContact: true,
        }
      }
      return {
        label: "Devuelto a BEYONIX",
        title: "Tu pedido regresó a BEYONIX.",
        paragraphs: expired
          ? ["La reserva de los productos venció y la disponibilidad deberá confirmarse nuevamente.", "Contactanos para coordinar los próximos pasos. El nuevo envío tendrá costo."]
          : ["Contactanos para coordinar los próximos pasos. El nuevo envío tendrá costo."],
        tone: "neutral",
        showContact: true,
      }
    }
    default:
      return null
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** Bulto del intento que salió y si ya volvió a BEYONIX (picking inverso). */
export interface LocalDeliveryReturnParcel {
  barcode: string
  index: number
  received: boolean
}

export interface AdminLocalDeliveryReservation {
  status: LocalDeliveryReservationStatus
  reservationDays: number
  expiresAt: string
}

export interface AdminLocalDeliveryOutcome {
  status: LocalDeliveryOutcomeStatus
  failedAttempts: number
  firstAttemptFailedAt: string | null
  secondAttemptFailedAt: string | null
  incident: { reason: LocalDeliveryIncidentReason; comment: string | null; at: string | null } | null
  returningAt: string | null
  returnedAt: string | null
  reservation: AdminLocalDeliveryReservation | null
  /** Bultos del intento que salió, con su recepción (sólo Regresando/Devuelto). */
  returnParcels: LocalDeliveryReturnParcel[] | null
}

/** Línea de estado de la reserva para Admin. */
export function describeAdminLocalDeliveryReservation(reservation: AdminLocalDeliveryReservation | null, nowMs: number = Date.now()) {
  if (!reservation) return null
  const days = `${reservation.reservationDays} ${reservation.reservationDays === 1 ? "día configurado" : "días configurados"}`
  if (reservation.status === "expired") return { label: "Reserva vencida — stock liberado", detail: days, tone: "neutral" as const }
  // Venció pero el job todavía no corrió: el stock sigue apartado hasta entonces.
  if (reservation.status === "active" && Date.parse(reservation.expiresAt) <= nowMs) {
    return { label: "Reserva vencida — liberando stock", detail: `${days} · Se libera en la próxima ejecución automática`, tone: "neutral" as const }
  }
  if (reservation.status === "consumed") return { label: "Reserva usada para un nuevo envío", detail: days, tone: "info" as const }
  if (reservation.status === "cancelled") return { label: "Reserva cancelada", detail: "Pedido cancelado", tone: "neutral" as const }
  return {
    label: `Reserva activa hasta ${formatLocalDeliveryDeadline(reservation.expiresAt)}`,
    detail: `${days} · Esperando coordinación del cliente`,
    tone: "warning" as const,
  }
}
