import {
  BULK_PRICE_ACTION_LABELS,
  BULK_PRICE_PERCENT_ACTIONS,
  BULK_PRICE_AMOUNT_ACTIONS,
  isBulkPriceActionKind,
  validateBulkPriceAction,
  type BulkPriceActionKind,
} from "../pricing/bulk-price-engine.ts"
import {
  FINANCED_PRICE_POLICY_LABELS,
  type FinancedPricePolicy,
} from "../pricing/financed-price-policy.ts"
import { argentinaLocalToUtcIso } from "./argentina-time.ts"

/**
 * Eventos programados de Admin → Eventos (módulo puro: validación, ventanas
 * de tiempo, conflictos y qué toca ejecutar). La ejecución vive en
 * `runner.ts` y las escrituras son transacciones SQL idempotentes
 * (supabase/migrations/20261002100000_scheduled_commercial_events.sql).
 *
 * Tipos:
 * - `price_change`: la misma acción que el Editor masivo a una fecha/hora;
 *   con fin se revierte al terminar, sin fin es un cambio permanente.
 * - `financing_policy`: política global de precio financiado temporal; al
 *   terminar vuelve a la que había al empezar.
 */

export type CommercialEventType = "price_change" | "financing_policy"
export type CommercialEventStatus = "draft" | "active" | "scheduled" | "finished" | "cancelled" | "error"
export type CommercialEventScope = "store" | "category" | "product"

export interface CommercialEventTarget {
  type: "category" | "product"
  label: string
  url: string
}

/** Fila de `product_bulk_events` (eventos manuales previos y programados). */
export interface CommercialEventRow {
  id: string
  internal_name: string
  event_type: CommercialEventType
  status: CommercialEventStatus
  starts_on: string | null
  duration_days: number | null
  starts_at: string | null
  ends_at: string | null
  scope: CommercialEventScope
  target_items: CommercialEventTarget[]
  action_kind: string | null
  value: number | null
  financing_policy: FinancedPricePolicy | null
  previous_financing_policy: FinancedPricePolicy | null
  executed_at: string | null
  restored_at: string | null
  cancelled_at: string | null
  failed_phase: "apply" | "restore" | null
  last_error: string | null
  result: Record<string, unknown> | null
  activated_at: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export const COMMERCIAL_EVENT_COLUMNS =
  "id, internal_name, event_type, status, starts_on, duration_days, starts_at, ends_at, scope, target_items, action_kind, value, financing_policy, previous_financing_policy, executed_at, restored_at, cancelled_at, failed_phase, last_error, result, activated_at, created_by, updated_by, created_at, updated_at"

export const COMMERCIAL_EVENT_STATUS_LABELS: Record<CommercialEventStatus, string> = {
  draft: "Guardado",
  scheduled: "Programado",
  active: "Activo",
  finished: "Finalizado",
  cancelled: "Cancelado",
  error: "Error",
}

/** Evento manual anterior a la programación (se activa/pausa a mano). */
export function isLegacyEvent(event: Pick<CommercialEventRow, "starts_at">) {
  return event.starts_at === null
}

/** Duración máxima de un evento temporal. */
export const MAX_EVENT_DURATION_MS = 365 * 24 * 60 * 60 * 1000
/** Un cambio permanente ocupa un minuto: dos cambios en el mismo minuto sobre un producto chocan. */
export const PERMANENT_EVENT_WINDOW_MS = 60 * 1000

export interface ScheduledEventInput {
  internalName: string
  eventType: CommercialEventType
  startsAt: string
  endsAt: string | null
  scope: CommercialEventScope
  targetItems: CommercialEventTarget[]
  actionKind: BulkPriceActionKind | null
  value: number | null
  financingPolicy: FinancedPricePolicy | null
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

function normalizeTargets(value: unknown): CommercialEventTarget[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {}
    const type = text(source.type)
    const label = text(source.label)
    const url = text(source.url)
    return (type === "category" || type === "product") && label && url.startsWith("/")
      ? [{ type, label, url } as CommercialEventTarget]
      : []
  })
}

/**
 * Valida lo que carga el Admin (fecha y hora LOCALES de Argentina) y lo
 * convierte a instantes UTC. Nunca acepta: fecha inválida, inicio en el
 * pasado, fin anterior al inicio, financiación sin fin, porcentajes fuera de
 * 1–99 ni alcance vacío.
 */
export function parseScheduledEventInput(
  body: Record<string, unknown>,
  now: Date,
): { value: ScheduledEventInput } | { error: string } {
  const internalName = text(body.internal_name).slice(0, 120)
  if (!internalName) return { error: "Escribí un nombre interno para el evento." }

  const eventType = text(body.event_type)
  if (eventType !== "price_change" && eventType !== "financing_policy") {
    return { error: "Elegí el tipo de evento." }
  }

  const startsAt = argentinaLocalToUtcIso(text(body.starts_date), text(body.starts_time))
  if (!startsAt) return { error: "Elegí una fecha y hora de inicio válidas." }
  if (Date.parse(startsAt) <= now.getTime()) return { error: "El inicio tiene que ser posterior a este momento." }

  const wantsEnd = eventType === "financing_policy" || body.revert === true
  let endsAt: string | null = null
  if (wantsEnd) {
    endsAt = argentinaLocalToUtcIso(text(body.ends_date), text(body.ends_time))
    if (!endsAt) {
      return {
        error:
          eventType === "financing_policy"
            ? "La financiación promocional necesita fecha y hora de finalización."
            : "Elegí la fecha y hora en que se revierten los precios.",
      }
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) return { error: "La finalización tiene que ser posterior al inicio." }
    if (Date.parse(endsAt) - Date.parse(startsAt) > MAX_EVENT_DURATION_MS) {
      return { error: "Un evento puede durar como máximo 365 días." }
    }
  }

  if (eventType === "financing_policy") {
    // Hoy sólo se programa la promoción: volver a "cubrir costos" es el fin del evento.
    if (text(body.financing_policy) !== "same_as_cash") return { error: "Elegí la política de financiación del evento." }
    return {
      value: {
        internalName,
        eventType,
        startsAt,
        endsAt,
        scope: "store",
        targetItems: [],
        actionKind: null,
        value: null,
        financingPolicy: "same_as_cash",
      },
    }
  }

  const actionKind = text(body.action_kind)
  const value = body.value === null || body.value === undefined || body.value === "" ? null : Number(body.value)
  const actionError = validateBulkPriceAction(actionKind, value)
  if (actionError) return { error: actionError }
  if (!isBulkPriceActionKind(actionKind)) return { error: "Elegí una acción de precios válida." }

  const scope = text(body.scope)
  if (scope !== "store" && scope !== "category" && scope !== "product") return { error: "Elegí el alcance del evento." }
  const targetItems = scope === "store" ? [] : normalizeTargets(body.target_items)
  if (scope !== "store" && !targetItems.length) {
    return { error: scope === "product" ? "Marcá al menos un producto para el evento." : "Agregá al menos una categoría para el evento." }
  }

  return {
    value: {
      internalName,
      eventType,
      startsAt,
      endsAt,
      scope,
      targetItems,
      actionKind,
      value: BULK_PRICE_PERCENT_ACTIONS.includes(actionKind) || BULK_PRICE_AMOUNT_ACTIONS.includes(actionKind) ? value : null,
      financingPolicy: null,
    },
  }
}

/** Estados que ocupan su ventana: un evento en error puede tener cambios aplicados sin restaurar. */
export function occupiesSchedule(status: CommercialEventStatus) {
  return status === "scheduled" || status === "active" || status === "error"
}

export function eventWindow(event: { startsAt: string; endsAt: string | null }) {
  const start = Date.parse(event.startsAt)
  return { start, end: event.endsAt ? Date.parse(event.endsAt) : start + PERMANENT_EVENT_WINDOW_MS }
}

/** Ventanas semiabiertas [inicio, fin): uno que termina 23:59 y otro que empieza 23:59 no chocan. */
export function windowsOverlap(
  a: { startsAt: string; endsAt: string | null },
  b: { startsAt: string; endsAt: string | null },
) {
  const left = eventWindow(a)
  const right = eventWindow(b)
  return left.start < right.end && right.start < left.end
}

const rowWindow = (row: CommercialEventRow) =>
  row.starts_at ? { startsAt: row.starts_at, endsAt: row.ends_at } : null

/** Otro evento de financiación que ocupa la misma franja (o `null`). */
export function findFinancingConflict(
  candidate: { id?: string; startsAt: string; endsAt: string | null },
  events: readonly CommercialEventRow[],
): CommercialEventRow | null {
  return (
    events.find((event) => {
      const window = rowWindow(event)
      return (
        event.id !== candidate.id &&
        event.event_type === "financing_policy" &&
        occupiesSchedule(event.status) &&
        window !== null &&
        windowsOverlap(candidate, window)
      )
    }) ?? null
  )
}

/**
 * Otro evento de precios que toca ALGUNO de los mismos productos en la misma
 * franja (o `null`). No bloquea eventos sobre productos distintos.
 */
export function findPriceConflict(
  candidate: { id?: string; startsAt: string; endsAt: string | null; productIds: readonly number[] },
  events: ReadonlyArray<{ event: CommercialEventRow; productIds: readonly number[] }>,
): { event: CommercialEventRow; productIds: number[] } | null {
  const mine = new Set(candidate.productIds)
  for (const { event, productIds } of events) {
    const window = rowWindow(event)
    if (event.id === candidate.id || event.event_type !== "price_change" || !occupiesSchedule(event.status) || !window) continue
    if (!windowsOverlap(candidate, window)) continue
    const shared = productIds.filter((id) => mine.has(id))
    if (shared.length) return { event, productIds: shared }
  }
  return null
}

export interface DueEventAction {
  event: CommercialEventRow
  phase: "apply" | "restore"
}

/**
 * Qué toca ejecutar ahora: primero las restauraciones (un evento que termina
 * a las 23:59 vuelve atrás antes de que empiece el siguiente a las 23:59),
 * después las aplicaciones, cada grupo en orden cronológico. Nunca reintenta
 * un evento en error: eso es una acción explícita del Admin.
 */
export function getDueEventActions(events: readonly CommercialEventRow[], now: Date): DueEventAction[] {
  const time = now.getTime()
  const restores = events
    .filter((event) => event.status === "active" && event.starts_at && event.ends_at && Date.parse(event.ends_at) <= time)
    .sort((a, b) => Date.parse(a.ends_at as string) - Date.parse(b.ends_at as string) || a.id.localeCompare(b.id))
    .map((event) => ({ event, phase: "restore" as const }))
  const applies = events
    .filter((event) => event.status === "scheduled" && event.starts_at && Date.parse(event.starts_at) <= time)
    .sort((a, b) => Date.parse(a.starts_at as string) - Date.parse(b.starts_at as string) || a.id.localeCompare(b.id))
    .map((event) => ({ event, phase: "apply" as const }))
  return [...restores, ...applies]
}

/** Evento de financiación que hoy controla la política (activo o trabado al restaurar). */
export function getControllingFinancingEvent(events: readonly CommercialEventRow[]) {
  return (
    events.find(
      (event) =>
        event.event_type === "financing_policy" &&
        (event.status === "active" || (event.status === "error" && event.failed_phase === "restore")),
    ) ?? null
  )
}

/** Descripción corta para tarjetas y Admin → Financiación. */
export function describeCommercialEvent(event: Pick<CommercialEventRow, "event_type" | "action_kind" | "value" | "financing_policy">) {
  if (event.event_type === "financing_policy") {
    return FINANCED_PRICE_POLICY_LABELS[event.financing_policy ?? "same_as_cash"]
  }
  if (!isBulkPriceActionKind(event.action_kind)) return "Cambio de precios"
  const label = BULK_PRICE_ACTION_LABELS[event.action_kind]
  if (event.value == null) return label
  if (BULK_PRICE_PERCENT_ACTIONS.includes(event.action_kind)) return `${label} ${event.value}%`
  if (BULK_PRICE_AMOUNT_ACTIONS.includes(event.action_kind)) return `${label} $${event.value}`
  return label
}

/** Mensajes resumidos (sin datos técnicos) de los errores de ejecución. */
const EXECUTION_ERROR_MESSAGES: Record<string, string> = {
  PRICE_EVENT_STALE: "Los precios cambiaron mientras se aplicaba el evento. No se modificó ningún producto.",
  PRODUCT_LOCKED_BY_EVENT: "Un producto está tomado por otro evento activo. No se modificó ningún producto.",
  PRODUCT_NOT_FOUND: "Un producto del evento ya no existe. No se modificó ningún producto.",
  INVALID_PRICE: "El cálculo daba un precio inválido. No se modificó ningún producto.",
  EVENT_WITHOUT_PRODUCTS: "El evento no alcanza ningún producto.",
  FINANCING_EVENT_ACTIVE: "Ya hay otro evento de financiación activo.",
  FINANCING_POLICY_STALE: "La política cambió mientras el evento estaba activo. Revisá el evento antes de restaurarla.",
  EVENT_NOT_DUE: "El evento todavía no empezó.",
}

export function describeExecutionError(raw: string | null | undefined) {
  const code = Object.keys(EXECUTION_ERROR_MESSAGES).find((key) => raw?.includes(key))
  return code ? EXECUTION_ERROR_MESSAGES[code] : "No se pudo ejecutar el evento. No quedó ningún cambio a medias."
}
